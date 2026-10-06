/**
 * Handler: morphit_order_v1
 *
 * Payload shape:
 *   {
 *     "permlink": string (1..32, blurt permlink charset),
 *     "side": "buy" | "sell",
 *     "asset": "BTC" | "XMR" | "BLURT" | "USDT" | "USDC" | "DAI" | "BCH" | "LTC" | "DASH" | "DOGE" | "ZEC" | "ARRR" | "DCR" | "SOL" | "ETH" | "XRP",
 *     "fiat_currency": string (1..8, ISO-4217-ish),
 *     "amount_min"?: number | null,
 *     "amount_max"?: number | null,
 *     "price_model": object  // opaque to indexer; UI interprets
 *     "location_region"?: string | null,
 *     "payment_methods": string[] (1..12 items, each 1..32 chars),
 *     "terms"?: string | null,
 *     "expires_at"?: ISO timestamp | null
 *   }
 *
 * Effect: insert into `orders` with status='live'. Idempotent —
 * a duplicate (account, permlink) is a no-op, not an update. To
 * update an existing order, signer uses morphit_order_replace_v1.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { listingFeeStatus, sumFeeTransfers } from '$indexer/fee';
import { ownerRecipientsFor } from '$indexer/feeRecipients';
import { trackVerifiedBlurtFee } from '$indexer/loyalty';
import { attributeBlurtFeeToOperator } from '$indexer/operatorEarnings';
import { CANONICAL_TREASURY } from '../../config/canonicalTreasury';
import { checkJsonbSize } from '$indexer/payloadSize';
import { validateOrderPermlink } from '$indexer/permlink';
import { addressModePermlink, allocateBtcFeeAddress, btcPinAt } from '$indexer/fee/btcFeeAddressIndex';
import { xmrBindingFor, xmrPrimaryAt, type XmrBinding } from '$indexer/fee/xmrBinding';
import { xmrIntegratedAddress } from '@morphit/release-schema';
import { logger } from '$log';
import { ASSET_TICKERS_SET, isGoodsAsset, type AssetTicker } from '@morphit/asset-registry';
import { isOrderLang } from '@morphit/operator-config';
import { countForSybilTier } from '$api/sybilTier';

const log = logger('order-handler');

const SIDES = new Set(['buy', 'sell']);

/** Sanity caps for chain-direct payloads.  The frontend has its
 *  own (typically tighter) caps; these are the indexer's
 *  defense-in-depth — values that pass these checks are
 *  guaranteed not to break the orderbook UI's rendering or
 *  produce absurd far-future expiries.
 *
 *  - `MAX_AMOUNT`: 1e12 = 1 trillion of any fiat currency.
 *    Beyond hyperinflation worst cases (Zimbabwe 2008 hit ~
 *    10^9 ZWD/USD; Hungary 1946 was higher but historical).
 *    Anything past 1e12 is either a typo or an attack.
 *  - `MAX_EXPIRES_AT_DAYS`: 365 days.  The frontend's UI cap
 *    is 90 days; 365 is 4x that to leave room for new UI
 *    presets without re-bounding the indexer.  Without this,
 *    a chain-direct payload could set expires_at to year 9999
 *    and the orderbook would carry it forever. */
const MAX_AMOUNT = 1e12;
const MAX_EXPIRES_AT_DAYS = 365;

/** O3.4 — forbidden character class for user-text fields.
 *  Mirror of profile.ts / feedback.ts / operatorRegister.ts.
 *  Control chars (C0/C1), bidi-override marks, the zero-width
 *  space — none have legitimate display use, all are used
 *  by impersonation / RTL-flip attacks against rendered text.
 *  Applied to the single-line fields location_region and
 *  payment_methods items. The terms field is multi-line markdown and
 *  uses FORBIDDEN_MULTILINE_TEXT_CHARS below instead. */
const FORBIDDEN_TEXT_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
/** Multi-line variant for the terms field ONLY. Identical to
 *  FORBIDDEN_TEXT_CHARS except it PERMITS the three whitespace control
 *  chars TAB (U+0009), LF (U+000A), and CR (U+000D). The terms field
 *  is a multi-line markdown textarea — TermsText renders headings,
 *  lists, blockquotes, links, and line feeds — so the strict regex
 *  silently rejected on-chain EVERY order whose terms contained a
 *  newline (the frontend textarea has no such gate, so the op
 *  broadcasts and pays its fee, then the indexer drops the row). The
 *  genuinely dangerous C0/C1 controls, Unicode line/paragraph
 *  separators, bidi overrides, and zero-width characters stay
 *  blocked. */
const FORBIDDEN_MULTILINE_TEXT_CHARS =
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumOrNull(v: unknown): v is number | null | undefined {
	return v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));
}

interface ValidatedOrder {
	readonly permlink: string;
	readonly side: 'buy' | 'sell';
	readonly asset: AssetTicker;
	readonly fiat_currency: string;
	readonly amount_min: number | null;
	readonly amount_max: number | null;
	readonly price_model: Record<string, unknown>;
	/** price_model pre-serialized at validation time, size-capped
	 *  per Finding L. Handler passes this straight to
	 *  client.query() rather than re-stringifying — guarantees the
	 *  DB row contains exactly what passed the size check. */
	readonly price_model_serialized: string;
	readonly location_region: string | null;
	readonly payment_methods: readonly string[];
	readonly terms: string | null;
	readonly expires_at: Date | null;
	/** ADR-0011: how the listing fee was paid. Omitted on
	 *  legacy (ADR-0009) orders, in which case the handler
	 *  treats it as 'blurt' (the only option that existed then). */
	readonly fee_method: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr';
	/** ADR-0011 sub-phase 4b: for btc/xmr orders, the txid on
	 *  the external chain that carries the fee payment. Null
	 *  for blurt/waived_first_buy. */
	readonly external_tx_id: string | null;
	/** later+: per-payment Monero proof string.  Required
	 *  when fee_method='xmr', null otherwise.  Used by the XMR
	 *  fee verifier to confirm the payment without holding the
	 *  treasury's view key. */
	readonly tx_proof: string | null;
	/** v1.20.0 (M-X1): the XMR fee transaction's private key r, 64 lowercase
	 *  hex — what the explorers' txprove needs and what decrypts a bound
	 *  payment ID. Null for non-XMR orders and for legacy OutProof-only XMR
	 *  orders (stored `proof_unsupported`). */
	readonly tx_key: string | null;
	/** sub-network identifier for multi-
	 *  network assets.  Non-null when asset is multi-network: for
	 *  USDT one of 'erc20'|'trc20'|'spl'|'bep20'; for USDC one of
	 *  'erc20'|'spl'|'base'|'polygon'; for DAI one of 'erc20'|
	 *  'polygon'|'base'|'arbitrum'.  Null for single-network assets
	 *  (BTC, XMR, BLURT, BCH, LTC, DASH, DOGE).  Pinned at post
	 *  time so cross-network sends are impossible. */
	readonly asset_network: string | null;
	/** for a BARTER (goods/services) order, the non-empty set of
	 *  crypto tickers the seller accepts as settlement (canonical sorted,
	 *  deduped, e.g. ['BTC','DOGE','XMR']).  Each is a real crypto ticker in
	 *  ASSET_TICKERS, never BARTER or any goods asset.  Null for every crypto
	 *  asset — those settle in themselves and carry no accepted-set. */
	readonly accepted_assets: readonly string[] | null;
	/** v1.9.0 — a BARTER order's inline "what am I offering" label (e.g.
	 *  "bananas"). Letters-only, ≤24 chars. Null for crypto orders and blank
	 *  barter titles. Optional/backward-compatible: absent on older payloads. */
	readonly specific_barter_title: string | null;
	/** v1.15.0 — the language the order text is written in (one of the 10
	 *  SUPPORTED_LOCALES codes), used by the orderbook language filter. Optional:
	 *  null on legacy orders and payloads that omit it; untagged orders show only
	 *  when no language filter is set. */
	readonly lang: string | null;
}

function validate(payload: unknown, blockTime: Date): ValidatedOrder | { reason: string } {
	if (!isPlainObject(payload)) return { reason: 'payload_not_object' };

	// permlink — shared validator (apps/indexer/src/indexer/permlink.ts)
	const permlinkFail = validateOrderPermlink(payload.permlink);
	if (permlinkFail) return { reason: permlinkFail };
	const permlink = payload.permlink as string;

	// side
	const side = payload.side;
	if (typeof side !== 'string' || !SIDES.has(side)) {
		return { reason: 'side_invalid' };
	}

	// asset
	const asset = payload.asset;
	if (typeof asset !== 'string' || !ASSET_TICKERS_SET.has(asset)) {
		return { reason: 'asset_invalid' };
	}

	// fiat_currency — uppercase ASCII letters only. Length-bound
	// 1..8 covers ISO-4217 plus some wiggle for stablecoin tickers
	// (USDT, USDC). Character-class check is defense-in-depth: all
	// render sites escape, but rejecting at intake keeps the DB
	// clean and the orderbook-query filter (which also requires
	// /^[A-Z]+$/) returns consistent results.
	const fiat = payload.fiat_currency;
	if (typeof fiat !== 'string' || fiat.length < 1 || fiat.length > 8) {
		return { reason: 'fiat_currency_invalid' };
	}
	if (!/^[A-Z]+$/.test(fiat)) {
		return { reason: 'fiat_currency_invalid' };
	}

	// amount range
	if (!isFiniteNumOrNull(payload.amount_min)) {
		return { reason: 'amount_min_invalid' };
	}
	if (!isFiniteNumOrNull(payload.amount_max)) {
		return { reason: 'amount_max_invalid' };
	}
	const amount_min = (payload.amount_min as number | null | undefined) ?? null;
	const amount_max = (payload.amount_max as number | null | undefined) ?? null;
	if (amount_min !== null && amount_min < 0) {
		return { reason: 'amount_min_negative' };
	}
	if (amount_max !== null && amount_max < 0) {
		return { reason: 'amount_max_negative' };
	}
	// Sanity-cap: a quadrillion of any fiat currency is well past
	// any realistic order size, including hyperinflation cases.
	// Without this bound, a chain-direct attacker could post
	// `amount_min: 1e308` and the orderbook UI would render absurd
	// values.  Defense in depth — the frontend caps too.
	if (amount_min !== null && amount_min > MAX_AMOUNT) {
		return { reason: 'amount_min_too_large' };
	}
	if (amount_max !== null && amount_max > MAX_AMOUNT) {
		return { reason: 'amount_max_too_large' };
	}
	if (amount_min !== null && amount_max !== null && amount_min > amount_max) {
		return { reason: 'amount_min_exceeds_max' };
	}

	// price_model — opaque object, size-bounded.  We accept any
	// object shape because future clients may publish kinds
	// ('tiered', 'auction', etc.) the indexer doesn't recognize.
	// HOWEVER, for the two CURRENTLY-KNOWN kinds ('spread' and
	// 'fixed') we shape-validate to reject obvious chain-direct
	// abuse — negative prices, NaN, Infinity, absurdly large
	// numbers.  An unknown `kind` falls through and is stored as-is
	// (forward-compat).  Defense-in-depth: the frontend's
	// priceModelDisplay.ts also fails-soft on malformed shapes via
	// "Custom price" fallback.
	if (!isPlainObject(payload.price_model)) {
		return { reason: 'price_model_not_object' };
	}
	const priceModelSize = checkJsonbSize(payload.price_model);
	if (!priceModelSize.ok) {
		return { reason: 'price_model_too_large' };
	}
	const priceModelObj = payload.price_model;
	if (priceModelObj.kind === 'spread') {
		// Percent: finite number, plausible range.  ±500% is the
		// outer band — beyond that the order is non-economic
		// (someone offering 500% above market isn't a real seller;
		// could be price-fingerprinting or rendering abuse).
		if (typeof priceModelObj.percent !== 'number' || !Number.isFinite(priceModelObj.percent)) {
			return { reason: 'price_model_spread_percent_not_finite' };
		}
		if (priceModelObj.percent < -500 || priceModelObj.percent > 500) {
			return { reason: 'price_model_spread_percent_out_of_range' };
		}
	} else if (priceModelObj.kind === 'fixed') {
		// Fixed price: finite number, strictly positive, capped at
		// MAX_AMOUNT (same ceiling as amount_min/amount_max).
		// A negative fixed price would render as "-500 USD" and
		// confuse counterparties; reject at intake.
		if (typeof priceModelObj.price !== 'number' || !Number.isFinite(priceModelObj.price)) {
			return { reason: 'price_model_fixed_price_not_finite' };
		}
		if (priceModelObj.price <= 0) {
			return { reason: 'price_model_fixed_price_not_positive' };
		}
		if (priceModelObj.price > MAX_AMOUNT) {
			return { reason: 'price_model_fixed_price_too_large' };
		}
	}
	// Other kinds (or missing kind) pass through — forward-compat.

	// location_region — optional string
	let location_region: string | null = null;
	if (payload.location_region !== undefined && payload.location_region !== null) {
		if (typeof payload.location_region !== 'string') {
			return { reason: 'location_region_not_string' };
		}
		// O3.4 — NFC-normalize so visually-identical strings
		// collide consistently in DB queries / search facets, and
		// reject control / bidi / ZWJ chars that would let a
		// chain-direct attacker visually alter adjacent order
		// fields when this surfaces in the orderbook UI.
		const normalized = payload.location_region.normalize('NFC');
		if (normalized.length > 128) {
			return { reason: 'location_region_too_long' };
		}
		if (FORBIDDEN_TEXT_CHARS.test(normalized)) {
			return { reason: 'location_region_forbidden_char' };
		}
		location_region = normalized;
	}

	// payment_methods — array of short strings, 1..12 entries
	const pm = payload.payment_methods;
	if (!Array.isArray(pm)) return { reason: 'payment_methods_not_array' };
	if (pm.length < 1 || pm.length > 12) return { reason: 'payment_methods_bad_count' };
	const normalizedPm: string[] = [];
	const seenPm = new Set<string>();
	for (const item of pm) {
		if (typeof item !== 'string' || item.length < 1 || item.length > 32) {
			return { reason: 'payment_method_item_invalid' };
		}
		// O3.4 — same NFC + forbidden-char treatment.  Payment
		// method labels also surface in orderbook rows.
		const normItem = item.normalize('NFC');
		if (normItem.length > 32) {
			return { reason: 'payment_method_item_invalid' };
		}
		if (FORBIDDEN_TEXT_CHARS.test(normItem)) {
			return { reason: 'payment_method_item_forbidden_char' };
		}
		// Reject duplicate entries.  Without this, a user could
		// repeat the same method 12 times to inflate their payment-
		// method tag count or to game any dedup-aware filter.  The
		// orderbook UI also gets noisy displaying repeats.  Compare
		// after NFC so visually-identical entries collide.
		if (seenPm.has(normItem)) {
			return { reason: 'payment_method_item_duplicate' };
		}
		seenPm.add(normItem);
		normalizedPm.push(normItem);
	}

	// terms — optional string, capped
	let terms: string | null = null;
	if (payload.terms !== undefined && payload.terms !== null) {
		if (typeof payload.terms !== 'string') return { reason: 'terms_not_string' };
		// O3.4 — same NFC + forbidden-char treatment.  Terms
		// are surfaced in the order-detail card.
		const normalized = payload.terms.normalize('NFC');
		if (normalized.length > 2048) return { reason: 'terms_too_long' };
		if (FORBIDDEN_MULTILINE_TEXT_CHARS.test(normalized)) {
			return { reason: 'terms_forbidden_char' };
		}
		terms = normalized;
	}

	// expires_at — optional ISO-8601 timestamp.  We require a strict
	// shape (YYYY-MM-DDTHH:MM:SS(.fff)?Z|±HH:MM) before letting the
	// Date constructor parse it.  The native parser is too permissive
	// — it accepts informal strings like "December 31" (→ Dec 31 of
	// the current millennium-default year), which would silently
	// produce an order born in the past.  ISO-8601-strict matches
	// what the frontend's Date.toISOString() emits.
	const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
	let expires_at: Date | null = null;
	if (payload.expires_at !== undefined && payload.expires_at !== null) {
		if (typeof payload.expires_at !== 'string') {
			return { reason: 'expires_at_not_string' };
		}
		if (!ISO_8601_RE.test(payload.expires_at)) {
			return { reason: 'expires_at_unparseable' };
		}
		const d = new Date(payload.expires_at);
		if (Number.isNaN(d.getTime())) return { reason: 'expires_at_unparseable' };
		// Sanity-cap the future window.  Without this, a chain-
		// direct payload could set expires_at to year 9999 and
		// the orderbook would carry the row indefinitely.  Measured
		// from the op's BLOCK time: a wall-clock read made a node
		// applying the op live and a node replaying it later reach
		// different verdicts on the same op.
		const maxFutureMs = MAX_EXPIRES_AT_DAYS * 86_400_000;
		if (d.getTime() - blockTime.getTime() > maxFutureMs) {
			return { reason: 'expires_at_too_far_future' };
		}
		expires_at = d;
	}

	// fee_method — ADR-0011. 4a recognized 'blurt' and
	// 'waived_first_buy'; 4b adds 'btc' and 'xmr'. Omitted
	// → 'blurt' for back-compat with ADR-0009 orders.
	let fee_method: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr' = 'blurt';
	let external_tx_id: string | null = null;
	let tx_proof: string | null = null;
	let tx_key: string | null = null;
	if (payload.fee_method !== undefined && payload.fee_method !== null) {
		if (typeof payload.fee_method !== 'string') {
			return { reason: 'fee_method_not_string' };
		}
		if (payload.fee_method === 'blurt') {
			fee_method = 'blurt';
		} else if (payload.fee_method === 'waived_first_buy') {
			fee_method = 'waived_first_buy';
		} else if (payload.fee_method === 'btc' || payload.fee_method === 'xmr') {
			fee_method = payload.fee_method;
			// external_tx_id: the payer's pointer to "this is the payment
			// that pays for this listing". Required for xmr. For btc it is
			// OPTIONAL here (v1.20.0, MK-H2): once the treasury xpub is
			// pinned, a BTC order carries NO txid and pays to its own
			// address instead; before the pin the handler still requires
			// one. Which of the two applies depends on the pin in force at
			// the op's block, so the handler decides it, not this shape
			// check.
			const txid = payload.external_tx_id;
			if (txid === undefined || txid === null) {
				if (payload.fee_method === 'xmr') {
					return { reason: 'external_tx_id_required_for_btc_xmr' };
				}
			} else if (typeof txid !== 'string') {
				return { reason: 'external_tx_id_required_for_btc_xmr' };
			} else if (!/^[0-9a-f]{64}$/i.test(txid)) {
				return { reason: 'external_tx_id_malformed' };
			} else {
				external_tx_id = txid.toLowerCase();
			}

			// v1.20.0 (M-X1) — XMR: the payer's transaction key.
			// The explorer API every XMR verifier uses
			// (onion-monero-blockchain-explorer /api/outputs?txprove=1)
			// proves a payment with the 64-hex transaction PRIVATE key
			// ("viewkey" parsed by parse_str_secret_key) and nothing else.
			// Until v1.20.0 orders carried a wallet OutProof string here,
			// which that API rejects — every XMR order ended `missing`.
			// Now: `tx_key` (64 hex) is the proof. An order that still
			// carries only an OutProof (older frontends) is accepted and
			// stored `proof_unsupported` — deterministically, without asking
			// any explorer — so the lister sees exactly why it is not on the
			// book. An order with neither is refused.
			if (payload.fee_method === 'xmr') {
				const key = payload.tx_key;
				if (key !== undefined && key !== null) {
					if (typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key.trim())) {
						return { reason: 'tx_key_malformed' };
					}
					tx_key = key.trim().toLowerCase();
				} else {
					const proof = payload.tx_proof;
					if (typeof proof !== 'string') {
						return { reason: 'tx_key_required_for_xmr' };
					}
					const trimmed = proof.trim();
					// Legacy shape checks kept so a stored proof stays bounded
					// and printable (it is shown back to the lister, never sent
					// anywhere any more).
					if (
						!trimmed.startsWith('OutProofV1') &&
						!trimmed.startsWith('OutProofV2')
					) {
						return { reason: 'tx_proof_malformed_prefix' };
					}
					if (trimmed.length < 64 || trimmed.length > 4096) {
						return { reason: 'tx_proof_malformed_length' };
					}
					if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
						return { reason: 'tx_proof_malformed_charset' };
					}
					tx_proof = trimmed;
				}
			}
		} else {
			return { reason: 'fee_method_unknown' };
		}
	}

	// asset_network field for multi-network assets.
	// USDT (erc20/trc20/spl/bep20) and USDC (erc20/spl/base/polygon)
	// both REQUIRE asset_network.  Single-network assets must omit
	// (or pass null); a non-null asset_network on a single-network
	// asset is rejected as malformed.
	let asset_network: string | null = null;
	const networkRaw = payload.asset_network;
	const USDT_NETWORKS_VALID = new Set(['erc20', 'trc20', 'spl', 'bep20']);
	const USDC_NETWORKS_VALID = new Set(['erc20', 'spl', 'base', 'polygon']);
	// DAI's 4 EVM networks per ADR-0029 §1.
	// Note 'arbitrum' is unique to DAI; the other three overlap
	// names with USDC's set (erc20/base/polygon) but each asset's
	// allowlist is independently enforced.
	const DAI_NETWORKS_VALID = new Set(['erc20', 'polygon', 'base', 'arbitrum']);
	// (defense-in-depth) — bound the input before
	// allocating a lowercased copy.  Every valid network name is
	// ≤ 8 chars ('arbitrum').  Reject anything longer early — the
	// allowlist would reject it anyway, but skipping the
	// toLowerCase() allocation for clearly-malformed input is
	// cheap defense against memory waste on weird custom_json.
	const MAX_NETWORK_LEN = 16;
	if (asset === 'USDT') {
		if (typeof networkRaw !== 'string' || networkRaw.length > MAX_NETWORK_LEN) {
			return { reason: 'asset_network_required_for_usdt' };
		}
		const net = networkRaw.toLowerCase();
		if (!USDT_NETWORKS_VALID.has(net)) {
			return { reason: 'asset_network_unknown' };
		}
		asset_network = net;
	} else if (asset === 'USDC') {
		if (typeof networkRaw !== 'string' || networkRaw.length > MAX_NETWORK_LEN) {
			return { reason: 'asset_network_required_for_usdc' };
		}
		const net = networkRaw.toLowerCase();
		if (!USDC_NETWORKS_VALID.has(net)) {
			return { reason: 'asset_network_unknown' };
		}
		asset_network = net;
	} else if (asset === 'DAI') {
		if (typeof networkRaw !== 'string' || networkRaw.length > MAX_NETWORK_LEN) {
			return { reason: 'asset_network_required_for_dai' };
		}
		const net = networkRaw.toLowerCase();
		if (!DAI_NETWORKS_VALID.has(net)) {
			return { reason: 'asset_network_unknown' };
		}
		asset_network = net;
	} else {
		if (networkRaw !== undefined && networkRaw !== null) {
			// Single-network asset shipped with a network value —
			// either a malformed client OR an attempt to confuse
			// downstream readers.  Reject.
			return { reason: 'asset_network_not_permitted_for_asset' };
		}
		asset_network = null;
	}

	// accepted_assets: the set of cryptos a BARTER (goods/services)
	// listing accepts as settlement.  REQUIRED (non-empty) when the asset is
	// a goods asset (BARTER); must be OMITTED for every crypto asset (they
	// settle in themselves).  Each entry must be a real crypto ticker in the
	// registry — never BARTER, never any goods asset (no barter-for-barter).
	let accepted_assets: string[] | null = null;
	const acceptedRaw = (payload as Record<string, unknown>).accepted_assets;
	if (isGoodsAsset(asset as AssetTicker)) {
		if (!Array.isArray(acceptedRaw) || acceptedRaw.length === 0) {
			return { reason: 'accepted_assets_required_for_barter' };
		}
		// Bound the set — there are only a handful of crypto tickers, so a
		// list longer than the registry is malformed (or a padding attempt).
		if (acceptedRaw.length > ASSET_TICKERS_SET.size) {
			return { reason: 'accepted_assets_too_many' };
		}
		const seen = new Set<string>();
		for (const entry of acceptedRaw) {
			if (typeof entry !== 'string') {
				return { reason: 'accepted_assets_entry_not_string' };
			}
			// Must be a registered ticker...
			if (!ASSET_TICKERS_SET.has(entry)) {
				return { reason: 'accepted_assets_entry_unknown' };
			}
			// ...and a CRYPTO one — never a goods asset (barter can't accept
			// barter, and can't accept another goods asset either).
			if (isGoodsAsset(entry as AssetTicker)) {
				return { reason: 'accepted_assets_entry_not_crypto' };
			}
			seen.add(entry);
		}
		// Dedupe → canonical sorted order so the same accepted-set always
		// serializes identically on the row and renders as a stable list.
		accepted_assets = [...seen].sort();
	} else {
		// Crypto asset — accepted_assets must be absent/null.  A crypto order
		// settles in itself; a set here is malformed or an attempt to confuse
		// downstream readers.
		if (acceptedRaw !== undefined && acceptedRaw !== null) {
			return { reason: 'accepted_assets_not_permitted_for_asset' };
		}
		accepted_assets = null;
	}

	// v1.9.0 — specific_barter_title: a BARTER order's own short label for
	// what's on offer, typed inline where the summary reads "goods/services". It
	// flows into the order title + the on-chain announcement. Letters + single
	// internal spaces, ≤24 chars — validated STRICTLY here (reject,
	// don't silently truncate) so the on-chain value matches what the client's
	// sanitizer produced. Optional for barter; must be absent for a crypto asset.
	let specific_barter_title: string | null = null;
	const barterTitleRaw = (payload as Record<string, unknown>).specific_barter_title;
	if (barterTitleRaw !== undefined && barterTitleRaw !== null) {
		if (!isGoodsAsset(asset as AssetTicker)) {
			return { reason: 'specific_barter_title_not_permitted_for_asset' };
		}
		if (typeof barterTitleRaw !== 'string') {
			return { reason: 'specific_barter_title_not_string' };
		}
		const normalized = barterTitleRaw.normalize('NFC');
		// Count by code points (Array.from), not UTF-16 units, so an accented or
		// astral letter counts as one — same rule the client enforces.
		if (Array.from(normalized).length > 24) {
			return { reason: 'specific_barter_title_too_long' };
		}
		// letters PLUS single internal spaces (multi-word wares like
		// "banana trees"). \p{L} covers accented + non-Latin scripts; leading /
		// trailing / double spaces, digits, punctuation, control chars → rejected.
		// The client trims + collapses before broadcast, so a valid on-chain value
		// is one-or-more letter-words joined by single spaces.
		if (normalized.length > 0 && !/^\p{L}+(?: \p{L}+)*$/u.test(normalized)) {
			return { reason: 'specific_barter_title_forbidden_char' };
		}
		specific_barter_title = normalized.length > 0 ? normalized : null;
	}

	// lang — OPTIONAL language tag (one of the 10 supported locale codes). Absent
	// or null on legacy/omitting payloads → stored NULL (untagged; shown only with
	// no language filter). A present-but-unsupported value is rejected rather than
	// silently kept.
	let lang: string | null = null;
	if (payload.lang !== undefined && payload.lang !== null) {
		if (!isOrderLang(payload.lang)) return { reason: 'lang_unsupported' };
		lang = payload.lang;
	}

	return {
		permlink,
		side: side as 'buy' | 'sell',
		asset: asset as AssetTicker,
		fiat_currency: fiat,
		amount_min,
		amount_max,
		price_model: payload.price_model,
		price_model_serialized: priceModelSize.serialized,
		location_region,
		payment_methods: normalizedPm,
		terms,
		expires_at,
		fee_method,
		external_tx_id,
		tx_proof,
		tx_key,
		asset_network,
		accepted_assets,
		specific_barter_title,
		lang
	};
}

/** Find and sum the sibling transfer(s) that paid the fee for this order.
 *  moved to `$indexer/fee` as the shared `sumFeeTransfers` (used by the
 *  listing, feature-bid, and stranger-fee handlers), which honors the
 *  payment-time federation split. See there. */

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	const v = validate(ctx.payload, ctx.blockTime);
	if ('reason' in v) return { ok: false, reason: v.reason };

	// operator-level instance-wide asset disable gate
	// (the default-on rule for new assets).  If the operator has listed this asset in
	// MORPHIT_INDEXER_DISABLED_ASSETS, refuse the order even if
	// it would otherwise validate.  Other instances may still
	// accept this asset's orders — federation visibility is
	// preserved because all orders flow through the chain — but
	// THIS instance refuses to write the row to its own DB.
	//
	// We compare uppercase so 'usdt' / 'USDT' / 'Usdt' all match
	// the config value 'USDT'.  The config-loader normalizes to
	// uppercase at boot.
	if (ctx.config.disabledAssets.includes(v.asset)) {
		return { ok: false, reason: 'asset_disabled_on_instance' };
	}

	// Payment-method analogue of the asset gate.  If EVERY payment
	// method the order offers is disabled on this instance, the
	// order is meaningless here (nothing it accepts is offered), so
	// refuse to write the row — same posture as a disabled asset.
	// An order that still carries at least one enabled method is
	// kept as-is; the frontend separately hides disabled methods
	// from the picker + orderbook filter.  Compare lowercase; the
	// config-loader normalizes disabledPaymentMethods to lowercase.
	if (
		ctx.config.disabledPaymentMethods.length > 0 &&
		v.payment_methods.every((m) =>
			ctx.config.disabledPaymentMethods.includes(m.toLowerCase())
		)
	) {
		return { ok: false, reason: 'payment_methods_all_disabled' };
	}

	// operator-attribution tag for federation-scoped
	// payout queueing.  Same value the operator-earnings module
	// validates downstream.  We pull it once here and thread it
	// into every `INSERT INTO orders` so the low-balance scanner
	// (which lives in a separate process and can't replay the
	// payload) can JOIN against `orders.operator_tag` to decide
	// whether THIS operator's relay should refill the user.
	//
	// Lenient extraction: malformed tags result in NULL on the
	// orders row.  The validateOperatorTagField helper below is
	// the strict gate used for actual payout decisions; here we
	// only care about "did the user attribute to a recognizable
	// operator?" for refill-scope purposes.  NULL behaves
	// correctly — the scanner's JOIN filters it out.
	const operatorTagForRow = (() => {
		const raw = (ctx.payload as Record<string, unknown>).operator_tag;
		if (typeof raw !== 'string') return null;
		if (raw.length === 0 || raw.length > 64) return null;
		if (!/^[a-z0-9._-]+$/.test(raw)) return null;
		return raw;
	})();

	// ─── ADR-0011: waived_first_buy branch ─────────────────────────
	// Preconditions (all must hold):
	//   (1) order side is 'buy' — the onboarding benefit is for
	//       acquiring crypto, not selling it
	//   (2) account has no prior orders in our index
	//   (3) accounts.first_buy_waived_at IS NULL
	//
	// Condition (3) is checked atomically via the UPDATE ... WHERE
	// first_buy_waived_at IS NULL RETURNING idiom. If another op
	// in the same block racing through this path already claimed
	// the waiver, our UPDATE returns 0 rows and we reject. We don't
	// use a SELECT-then-UPDATE because that would leave a
	// time-of-check-to-time-of-use window, and per-op savepoints
	// already give us transactional isolation within a block.
	if (v.fee_method === 'waived_first_buy') {
		if (v.side !== 'buy') {
			return { ok: false, reason: 'waiver_requires_buy' };
		}
		// Phase 3: the waiver is only redeemable for a BLURT BUY so
		// the new user's first trade actually pulls BLURT into their
		// wallet. Without this, a first-BTC-buyer leaves the flow with
		// an empty BLURT balance — can't pay fees on future orders,
		// can't get loyalty BP on future trades, and the "become part
		// of the BLURT economy" onboarding promise goes unfulfilled.
		if (v.asset !== 'BLURT') {
			return { ok: false, reason: 'waiver_requires_blurt' };
		}
		// Phase 3: enforce a $1 USD-equivalent minimum on the
		// first-buy VALUE.  amount_min is a fiat value (the orderbook
		// renders it as "{min} – {max} {fiat_currency}"), so this is a
		// fiat-to-fiat check — no price feed in the critical path.  A
		// $1 first buy still leaves the user a meaningful BLURT balance
		// (~500 BLURT at ~$0.002) — enough to fund ~8 future listings
		// at the ~$0.125 BLURT listing fee.  A null amount_min would
		// let a user take the waiver on an upper-bound-only listing,
		// bypassing the floor.
		if (v.amount_min === null) {
			return { ok: false, reason: 'waiver_requires_min_usd' };
		}
		// The $1 USD-equivalent first-order minimum (FIRST_ORDER_MIN_USD) is
		// ADVISORY, enforced by the client before it signs. It is not
		// a consensus rule: judging it here needed each node's live FX rate,
		// so the same op was applied on one indexer and rejected on another
		// (EUR 0.93 passed at 1.08 USD/EUR and failed at 1.07), and a
		// zero-clearnet node, with only its static table, disagreed with
		// everyone. What is checked here is a pure function of the chain:
		// side, asset, a stated amount_min, first order, one claim.
		// Has this account posted before? Even a rejected prior
		// attempt counts — the waiver is a one-shot bonus, not a
		// retry token.
		const priorCount = await client.query<{ n: string }>(
			`SELECT COUNT(*)::text AS n FROM orders WHERE account = $1`,
			[ctx.signer]
		);
		if (parseInt(priorCount.rows[0]?.n ?? '0', 10) > 0) {
			return { ok: false, reason: 'waiver_not_first_order' };
		}
		// Atomic claim of the waiver. If the row doesn't exist in
		// accounts (account created before the accounts table
		// began tracking, or some edge case), insert+set.
		// Otherwise update if NULL. Returns the number of rows
		// affected so we can distinguish claimed-success from
		// already-claimed.
		const claim = await client.query(
			`INSERT INTO accounts (
				name, creator, created_block_num, created_block_time,
				created_trx_id, first_buy_waived_at
			) VALUES ($1, '', 0, $2, '', $2)
			ON CONFLICT (name) DO UPDATE
				SET first_buy_waived_at = EXCLUDED.first_buy_waived_at
				WHERE accounts.first_buy_waived_at IS NULL
			RETURNING first_buy_waived_at`,
			[ctx.signer, ctx.blockTime]
		);
		if (claim.rowCount === 0) {
			return { ok: false, reason: 'waiver_already_used' };
		}

		// Waiver granted. Insert the order with verified fee status.
		const waiverRes = await client.query(
			`INSERT INTO orders (
				account, permlink, side, asset, asset_network, fiat_currency,
				amount_min, amount_max, price_model, location_region,
				payment_methods, terms, status, created_at, updated_at,
				expires_at, fee_status, fee_method, operator_tag, accepted_assets,
				specific_barter_title, lang
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
			          'live', $13, $13, $14, 'verified', 'waived_first_buy', $15, $16, $17, $18)
			ON CONFLICT (account, permlink) DO NOTHING`,
			[
				ctx.signer,
				v.permlink,
				v.side,
				v.asset,
				v.asset_network,
				v.fiat_currency,
				v.amount_min,
				v.amount_max,
				v.price_model_serialized,
				v.location_region,
				v.payment_methods,
				v.terms,
				ctx.blockTime,
				v.expires_at,
				operatorTagForRow,
				v.accepted_assets,
				v.specific_barter_title,
				v.lang
			]
		);
		if ((waiverRes.rowCount ?? 0) > 0) {
			ctx.recordOrderbookChange(`${ctx.signer}/${v.permlink}`);
		}
		return { ok: true };
	}

	// ─── ADR-0011 sub-phase 4b: BTC/XMR paths ──────────────────────
	// For btc/xmr, fee payment happened off-Blurt. The payer's txid
	// is in v.external_tx_id. The order is stored `pending_external`
	// and the re-check job verifies it with the verifier for its method
	// (see below); that verifier must still be configured here, so an
	// order for a method this node cannot check is refused at once.
	if (v.fee_method === 'btc' || v.fee_method === 'xmr') {
		// ─── v1.20.0 (MK-H2): per-order BTC fee address ────────────────
		// Once the release pin in force at this block carries the
		// treasury's account xpub, a BTC fee is no longer "paste the txid
		// of a payment to the shared address" — a watcher could paste a
		// victim's txid first. Instead this order gets its OWN address
		// (receive index n of the xpub, numbered in chain order from the
		// event log — see fee/btcFeeAddressIndex.ts) and the re-check
		// loop watches it. Everything here is chain data (pin at this
		// block, event log), so every indexer lands on the same address,
		// whatever its local verifier / explorer configuration.
		if (v.fee_method === 'btc') {
			const pin = await btcPinAt(client, ctx.blockNum);
			if (pin !== null && pin.xpub !== undefined) {
				if (v.external_tx_id !== null) {
					// The shared-address txid path is closed for orders
					// posted after the pin (MK-H2).
					return { ok: false, reason: 'btc_fee_txid_after_xpub_pin' };
				}
				const permlink = addressModePermlink(ctx.payload);
				if (permlink === null) {
					// Unreachable after validate() (btc, no txid, valid
					// permlink); kept so a future validator change cannot
					// slip an unnumbered order through.
					return { ok: false, reason: 'btc_fee_not_bindable' };
				}
				const alloc = await allocateBtcFeeAddress(
					client,
					{ blockNum: ctx.blockNum, trxInBlock: ctx.trxInBlock, opInTrx: ctx.opInTrx },
					ctx.blockTime,
					ctx.signer,
					permlink,
					pin.xpub
				);
				if (alloc.kind === 'refused') return { ok: false, reason: alloc.reason };
				const addrRes = await client.query(
					`INSERT INTO orders (
						account, permlink, side, asset, asset_network, fiat_currency,
						amount_min, amount_max, price_model, location_region,
						payment_methods, terms, status, created_at, updated_at,
						expires_at, fee_status, fee_method, external_tx_id, tx_proof,
						operator_tag, accepted_assets, specific_barter_title, lang,
						btc_fee_xpub, btc_fee_index, btc_fee_address, btc_fee_sats
					) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
					          'live', $13, $13, $14, 'awaiting_payment', 'btc', NULL, NULL,
					          $15, $16, $17, $18, $19, $20, $21, $22)
					ON CONFLICT (account, permlink) DO NOTHING`,
					[
						ctx.signer,
						v.permlink,
						v.side,
						v.asset,
						v.asset_network,
						v.fiat_currency,
						v.amount_min,
						v.amount_max,
						v.price_model_serialized,
						v.location_region,
						v.payment_methods,
						v.terms,
						ctx.blockTime,
						v.expires_at,
						operatorTagForRow,
						v.accepted_assets,
						v.specific_barter_title,
						v.lang,
						alloc.xpub,
						alloc.index,
						alloc.address,
						pin.satoshis
					]
				);
				if ((addrRes.rowCount ?? 0) > 0) {
					ctx.recordOrderbookChange(`${ctx.signer}/${v.permlink}`);
				}
				return { ok: true };
			}
			if (v.external_tx_id === null) {
				// No xpub pinned yet: the pre-v1.20 txid path, which needs one.
				return { ok: false, reason: 'external_tx_id_required_for_btc_xmr' };
			}
		}

		// ─── v1.20.0 (M-X1 / MK-H2): XMR ───────────────────────────────
		// No tx key (a legacy OutProof-only order): no explorer can check
		// it, so it is stored `proof_unsupported` without asking one — the
		// same answer on every indexer. external_tx_id stays NULL so the
		// txid is not "taken" by a claim that can never verify.
		//
		// With a tx key: once a release pins treasury.xmr.primary_address
		// (in force from the next block), the fee must be paid to the
		// integrated address carrying THIS order's payment ID
		// (Keccak("morphit-fee-v1|account/permlink")[0..8]); the verifier
		// proves the amount with the key AND decrypts the payment ID. A
		// txid + key copied from someone else's op then pays for nothing,
		// so the first-claim-wins reuse rule is not needed (and not
		// applied: it would let a copier knock the payer out as `reused`).
		let xmrBinding: XmrBinding | null = null;
		if (v.fee_method === 'xmr') {
			if (v.tx_key === null) {
				const unsupportedRes = await client.query(
					`INSERT INTO orders (
						account, permlink, side, asset, asset_network, fiat_currency,
						amount_min, amount_max, price_model, location_region,
						payment_methods, terms, status, created_at, updated_at,
						expires_at, fee_status, fee_method, external_tx_id, tx_proof,
						operator_tag, accepted_assets, specific_barter_title, lang
					) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
					          'live', $13, $13, $14, 'proof_unsupported', 'xmr', NULL, $15, $16, $17, $18, $19)
					ON CONFLICT (account, permlink) DO NOTHING`,
					[
						ctx.signer,
						v.permlink,
						v.side,
						v.asset,
						v.asset_network,
						v.fiat_currency,
						v.amount_min,
						v.amount_max,
						v.price_model_serialized,
						v.location_region,
						v.payment_methods,
						v.terms,
						ctx.blockTime,
						v.expires_at,
						v.tx_proof,
						operatorTagForRow,
						v.accepted_assets,
						v.specific_barter_title,
						v.lang
					]
				);
				if ((unsupportedRes.rowCount ?? 0) > 0) {
					ctx.recordOrderbookChange(`${ctx.signer}/${v.permlink}`);
				}
				return { ok: true };
			}
			const primary = await xmrPrimaryAt(client, ctx.blockNum);
			if (primary !== null) {
				xmrBinding = xmrBindingFor(primary, ctx.signer, v.permlink);
				// Unreachable: xmrPrimaryAt only returns a parsed address.
				if (xmrBinding === null) return { ok: false, reason: 'xmr_fee_not_bindable' };
			}
		}

		const verifier = v.fee_method === 'btc' ? ctx.feeVerifiers.btc : ctx.feeVerifiers.xmr;
		if (verifier === undefined) {
			// Operator hasn't configured this fee method. Reject
			// cleanly so the frontend can surface a message telling
			// the user to pay in BLURT (or pick a different node).
			return { ok: false, reason: `fee_method_not_configured_${v.fee_method}` };
		}

		const expectedAmount: number | bigint | undefined =
			v.fee_method === 'btc' ? ctx.feeAmounts.btcSatoshis : ctx.feeAmounts.xmrPiconero;
		if (expectedAmount === undefined || expectedAmount === 0 || expectedAmount === 0n) {
			// A verifier exists but the fee amount is unset. Same
			// operator-misconfiguration case; reject clearly.
			// ctx.feeAmounts uses the same chain-pin >
			// env precedence as feeVerifiers, so this also catches
			// the case where the verifier was rebuilt for a
			// chain-pinned address but the env-only amount was 0.
			return { ok: false, reason: `fee_amount_not_configured_${v.fee_method}` };
		}

		// Finding O19 — fee-reuse check.  An external_tx_id can pay
		// for at most one order per fee_method.  Check for prior
		// claims; if reuse is detected the explorers are never asked
		// about it (the re-check skips rows without a txid).  The order row
		// is still inserted so the user can see why it failed
		// (visible via /v1/orders/:account, but not the public
		// orderbook because fee_status is not 'verified').
		//
		// Note: if the same (account, permlink) re-runs (chain
		// replay), this hits the prior row by THIS account.  That's
		// a legitimate replay, not reuse — we let it through to the
		// INSERT below where ON CONFLICT (account, permlink) DO
		// NOTHING handles it correctly.  So the reuse query also
		// excludes our own (account, permlink).
		// (v1.20.0) Bound XMR claims: a copied txid carries someone else's
		// payment ID and simply fails, so first-claim-wins must NOT apply to
		// them (a copier would knock the payer out). But one account can
		// birthday-search two permlinks whose 8-byte payment IDs collide
		// (~2^32 Keccak evaluations), and then ONE payment would carry the ID
		// of both. So among bound claims, the first claim of a (txid, payment
		// ID) pair wins, in chain order — orders_xmr_bound_payment_uniq. The
		// unbound probe ignores bound rows, matching orders_external_tx_id_uniq.
		const reuseProbe =
			xmrBinding !== null
				? await client.query<{ account: string }>(
						`SELECT account FROM orders
						 WHERE fee_method = 'xmr' AND external_tx_id = $1
						   AND xmr_payment_id = $2
						   AND NOT (account = $3 AND permlink = $4)
						 LIMIT 1`,
						[v.external_tx_id, xmrBinding.paymentId, ctx.signer, v.permlink]
					)
				: await client.query<{ account: string }>(
						`SELECT account FROM orders
						 WHERE fee_method = $1 AND external_tx_id = $2
						   AND xmr_payment_id IS NULL
						   AND NOT (account = $3 AND permlink = $4)
						 LIMIT 1`,
						[v.fee_method, v.external_tx_id, ctx.signer, v.permlink]
					);
		if ((reuseProbe.rowCount ?? 0) > 0) {
			log.info('fee_tx_reused', {
				signer: ctx.signer,
				permlink: v.permlink,
				fee_method: v.fee_method,
				external_tx_id: v.external_tx_id,
				prior_claimer: reuseProbe.rows[0]!.account
			});
			// What was wrong: this INSERT wrote
			// external_tx_id = the reused txid, which collides with the
			// partial UNIQUE index orders_external_tx_id_uniq
			// (fee_method, external_tx_id) WHERE external_tx_id IS NOT NULL
			// held by the FIRST claimant. The handler threw, the dispatcher
			// logged handler_threw, and the second claimant's order got no
			// row at all — the user never saw why. The documented 'reused'
			// row was dead code. The reused row is now written with
			// external_tx_id = NULL: the index cannot fire (the partial
			// index skips NULLs, so no ON CONFLICT arbiter on it is needed
			// and the (account, permlink) arbiter still makes replays
			// idempotent), fee_status='reused' tells the UI exactly why the
			// order is not on the book, and the claimed txid is kept in the
			// fee_tx_reused log line above. The real fix — binding a BTC
			// payment to the lister — landed in v1.20.0 (MK-H2): once the
			// treasury xpub is pinned, BTC orders pay their own address
			// (branch above) and this txid path only serves BTC orders
			// posted before the pin, and XMR.
			const reusedRes = await client.query(
				`INSERT INTO orders (
					account, permlink, side, asset, asset_network, fiat_currency,
					amount_min, amount_max, price_model, location_region,
					payment_methods, terms, status, created_at, updated_at,
					expires_at, fee_status, fee_method, external_tx_id, tx_proof,
					operator_tag, accepted_assets, specific_barter_title, lang, xmr_tx_key
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
				          'live', $13, $13, $14, 'reused', $15, NULL, $16, $17, $18, $19, $20, $21)
				ON CONFLICT (account, permlink) DO NOTHING`,
				[
					ctx.signer,
					v.permlink,
					v.side,
					v.asset,
					v.asset_network,
					v.fiat_currency,
					v.amount_min,
					v.amount_max,
					v.price_model_serialized,
					v.location_region,
					v.payment_methods,
					v.terms,
					ctx.blockTime,
					v.expires_at,
					v.fee_method,
					v.tx_proof,
					operatorTagForRow,
					v.accepted_assets,
					v.specific_barter_title,
					v.lang,
					v.tx_key
				]
			);
			// Reused-fee orders have fee_status='reused' so they
			// never satisfy the orderbook visibility predicate
			// (verified | verified_by_attestation).  But emit
			// anyway: defensive against future visibility-rule
			// changes, and the SSE handler correctly no-ops on
			// non-matching orderIds.  Gate on rowCount > 0 to
			// avoid wasted bandwidth on replays.  (F-10 audit fix.)
			if ((reusedRes.rowCount ?? 0) > 0) {
				ctx.recordOrderbookChange(`${ctx.signer}/${v.permlink}`);
			}
			return { ok: true };
		}

		// The fee is NOT verified here. Asking the explorers inside the block
		// transaction held the block open for every outbound round trip (25 junk
		// XMR orders kept one block open ~10 s with 50 requests, from every
		// indexer at once) and made the stored verdict depend on what each
		// node's explorers said at that moment. The row goes in as
		// `pending_external` on every node; ExternalFeeRechecker
		// (fee/externalFeeRecheck.ts) asks the explorers outside any block
		// transaction, rate-limited, and settles it — new rows first, within
		// FRESH_CHECK_INTERVAL_MS.
		const feeStatus = 'pending_external';

		const externalRes = await client.query(
			`INSERT INTO orders (
				account, permlink, side, asset, asset_network, fiat_currency,
				amount_min, amount_max, price_model, location_region,
				payment_methods, terms, status, created_at, updated_at,
				expires_at, fee_status, fee_method, external_tx_id, tx_proof,
				operator_tag, accepted_assets, specific_barter_title, lang,
				xmr_tx_key, xmr_payment_id, xmr_fee_address
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
			          'live', $13, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
			          $23, $24, $25)
			ON CONFLICT (account, permlink) DO NOTHING`,
			[
				ctx.signer,
				v.permlink,
				v.side,
				v.asset,
				v.asset_network,
				v.fiat_currency,
				v.amount_min,
				v.amount_max,
				v.price_model_serialized,
				v.location_region,
				v.payment_methods,
				v.terms,
				ctx.blockTime,
				v.expires_at,
				feeStatus,
				v.fee_method,
				v.external_tx_id,
				v.tx_proof,
				operatorTagForRow,
				v.accepted_assets,
				v.specific_barter_title,
				v.lang,
				v.tx_key,
				xmrBinding?.paymentId ?? null,
				xmrBinding !== null ? xmrIntegratedAddress(xmrBinding.primaryAddress, xmrBinding.paymentId) : null
			]
		);
		if ((externalRes.rowCount ?? 0) > 0) {
			ctx.recordOrderbookChange(`${ctx.signer}/${v.permlink}`);
		}
		return { ok: true };
	}

	// ─── Fee verification per ADR-0009 (BLURT path) ────────────────
	// Determine fee_status before the INSERT so the row goes in with
	// the correct value. An order with fee_status != 'verified' is
	// invisible in /v1/orderbook but visible via /v1/orders/:account
	// so the user can see their own fee-rejected posts.
	//
	// the fee is paid as a payment-time split: 90% to this instance's
	// fee recipient + 10% to the canonical treasury (or a single 100% transfer
	// when the recipient IS the canonical treasury). We sum both legs for the
	// underpaid check and separately confirm the canonical treasury received its
	// ~10% cut — that second check is what stops a federation instance from
	// keeping the canonical's share.
	//
	// v1.20.0 (G1) — "this instance's fee recipient" is not the only owner: an
	// order posted through ANOTHER instance paid ITS fee account. The owner leg
	// also counts when it went to the fee_recipient the operator owning the
	// order's `operator_tag` registered on chain before this block —
	// $indexer/feeRecipients has the rule. Before,
	// every such order was `underpaid`, i.e. hidden, on every other instance.
	const ownerRecipients = await ownerRecipientsFor(
		client,
		ctx.config.feeRecipient,
		ctx.payload,
		ctx.blockNum
	);
	const fee = sumFeeTransfers(
		ctx.siblingOps,
		ctx.signer,
		ownerRecipients,
		CANONICAL_TREASURY.blurt,
		`morphit-fee:${v.permlink}`
	);

	let feeStatus: 'verified' | 'missing' | 'underpaid' = 'missing';
	if (fee !== null) {
		// Count existing orders for Sybil tier, at block time (identical on
		// replay and across instances). This order is the (count + 1)-th.
		// The same function serves GET /v1/orders/:account/sybil_tier, so a
		// client's quote cannot drift from what is charged here.
		const existingCount = await countForSybilTier(client, ctx.signer, ctx.blockTime);
		const nth = existingCount + 1;
		// BLURT-native fee (Model A): the ENFORCED amount stays
		// a pure function of the pinned base × tier — NO price read
		// here, so no TOCTOU and the floor is deterministic across the
		// federation.  The base is now resolved through ctx.feeAmounts
		// (chain-pin > env), exactly like the BTC/XMR amounts, so every
		// indexer enforces the SAME BLURT floor; the maintainer's
		// release-broadcaster auto-re-pins it as BLURT/USD drifts, so
		// operators never hand-tune it.  ctx.config.feeBaseBlurt is the
		// Plan-B fallback when no value was resolved (e.g. a unit
		// context that doesn't populate feeAmounts).
		//
		// The displayed amount (served by /v1/listing-fee) tracks the
		// canonical USD target live, and can sit up to
		// FEE_PRICE_TOLERANCE below the pinned base between re-pins — so
		// the acceptance floor relaxes by FEE_PRICE_TOLERANCE.  Still a
		// floor (overpayment fine); an operator who set feeTolerance
		// wider than 15% keeps it.  Bounded + not fork-controllable.
		const feeBaseBlurt = ctx.feeAmounts.blurtBase ?? ctx.config.feeBaseBlurt;
		// Floor = base × tier × (1 − max(feeTolerance, FEE_PRICE_TOLERANCE)) in
		// exact milliBLURT (G8), then the canonical treasury's 10 % leg must be
		// there — the canonical cut is not optional. Shared with the G1
		// re-verification (blurtFeeReverify.ts) so both give one verdict.
		feeStatus = listingFeeStatus(fee, nth, feeBaseBlurt, ctx.config.feeTolerance);
	}

	// INSERT ... ON CONFLICT DO NOTHING — idempotent. If the row
	// already exists (replay, network retry), preserve it; explicit
	// updates go through the replace handler.
	const res = await client.query(
		`INSERT INTO orders (
			account, permlink, side, asset, asset_network, fiat_currency,
			amount_min, amount_max, price_model, location_region,
			payment_methods, terms, status, created_at, updated_at,
			expires_at, fee_status, fee_method, operator_tag, accepted_assets,
			specific_barter_title, lang
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
		          'live', $13, $13, $14, $15, 'blurt', $16, $17, $18, $19)
		ON CONFLICT (account, permlink) DO NOTHING`,
		[
			ctx.signer,
			v.permlink,
			v.side,
			v.asset,
			v.asset_network,
			v.fiat_currency,
			v.amount_min,
			v.amount_max,
			v.price_model_serialized,
			v.location_region,
			v.payment_methods,
			v.terms,
			ctx.blockTime,
			v.expires_at,
			feeStatus,
			operatorTagForRow,
			v.accepted_assets,
			v.specific_barter_title,
			v.lang
		]
	);

	// ADR-0011 §4c: loyalty milestone tracking. Only track when the
	// fee actually verified AND the INSERT was fresh (rowCount > 0);
	// replays land as rowCount == 0 and would otherwise double-count.
	// The loyalty module itself also guards via UNIQUE, but catching
	// it here first avoids churn on the account_loyalty table.
	if (feeStatus === 'verified' && fee !== null && (res.rowCount ?? 0) > 0) {
		await trackVerifiedBlurtFee(
			client,
			ctx.signer,
			fee.totalBlurt,
			ctx.blockNum,
			ctx.blockTime,
			operatorTagForRow,
			ctx.config.instanceOperatorTag,
			fee.toCanonicalBlurt
		);

		// operator-earnings attribution (audit only).
		// The operator's 90% is now paid DIRECTLY at payment time (the fee
		// split's owner leg), so this no longer queues a relay transfer — it
		// just records the attribution + cumulative earnings for the operator
		// dashboard. If this order op carries an `operator_tag` resolving to a
		// registered active operator, record their 90% of the BLURT fee.
		// No-op if the tag is missing/malformed/unknown. Idempotent on trx_id.
		// See operatorEarnings.ts for the deep black-hat audit and rationale.
		//
		// We pull the tag from the raw payload rather than from
		// `v` because operator_tag is an attribution side-channel,
		// not a structural order field — keeping ValidatedOrder
		// focused on order shape.  The attribution module does
		// its own validation and short-circuits cleanly when the
		// tag is missing or malformed.
		const operatorTagRaw = (ctx.payload as Record<string, unknown>).operator_tag;
		await attributeBlurtFeeToOperator({
			client,
			operatorTagRaw,
			orderAccount: ctx.signer,
			orderPermlink: v.permlink,
			feeBlurt: fee.totalBlurt,
			trxId: ctx.trxId,
			blockNum: ctx.blockNum,
			blockTime: ctx.blockTime,
			instanceOperatorTag: ctx.config.instanceOperatorTag
		});
	}

	// If rowCount is 0, the row already existed — that's not a
	// rejection (the create succeeded, just not in this op), so we
	// still return ok. The event-log entry reflects that this op
	// was seen, which is enough for audit.
	//
	// Skip the SSE emit on rowCount=0 replays: the existing row
	// hasn't changed, so subscribers don't need an update event.
	// (F-10 audit fix.)
	if ((res.rowCount ?? 0) > 0) {
		ctx.recordOrderbookChange(`${ctx.signer}/${v.permlink}`);
	}
	return { ok: true };
};

export default handle;
