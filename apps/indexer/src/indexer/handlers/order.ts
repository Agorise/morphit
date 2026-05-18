/**
 * Handler: morphit_order_v1
 *
 * Payload shape:
 *   {
 *     "permlink": string (1..32, blurt permlink charset),
 *     "side": "buy" | "sell",
 *     "asset": "BTC" | "XMR" | "BLURT",
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
import { expectedFeeBlurt } from '$indexer/fee';
import { trackVerifiedBlurtFee } from '$indexer/loyalty';
import { attributeBlurtFeeToOperator } from '$indexer/operatorEarnings';
import { checkJsonbSize } from '$indexer/payloadSize';
import { validateOrderPermlink } from '$indexer/permlink';
import { logger } from '$log';
import { ASSET_TICKERS_SET, type AssetTicker } from '@morphit/asset-registry';

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
 *  Control chars (C0/C1), bidi-override marks, zero-width
 *  joiners — none have legitimate display use, all are used
 *  by impersonation / RTL-flip attacks against rendered text.
 *  Applied to location_region, terms, and payment_methods
 *  items, all of which are rendered in orderbook UI surfaces. */
const FORBIDDEN_TEXT_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/;

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
	/** Part 108++: per-payment Monero proof string.  Required
	 *  when fee_method='xmr', null otherwise.  Used by the XMR
	 *  fee verifier to confirm the payment without holding the
	 *  treasury's view key. */
	readonly tx_proof: string | null;
	/** Part 121 / cp30 — sub-network identifier for multi-network
	 *  assets.  Non-null when asset is multi-network: for USDT
	 *  one of 'erc20'|'trc20'|'spl'|'bep20'; for USDC one of
	 *  'erc20'|'spl'|'base'|'polygon'.  Null for single-network
	 *  assets (BTC, XMR, BLURT, BCH, LTC, DASH).  Pinned at post
	 *  time so cross-network sends are impossible. */
	readonly asset_network: string | null;
}

function validate(payload: unknown): ValidatedOrder | { reason: string } {
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
		if (FORBIDDEN_TEXT_CHARS.test(normalized)) {
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
		// the orderbook would carry the row indefinitely.
		const maxFutureMs = MAX_EXPIRES_AT_DAYS * 86_400_000;
		if (d.getTime() - Date.now() > maxFutureMs) {
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
			// external_tx_id is required for btc/xmr — it's the
			// payer's pointer to "this is the payment that pays
			// for this listing." Without it, there's no payment
			// to verify.
			const txid = payload.external_tx_id;
			if (typeof txid !== 'string') {
				return { reason: 'external_tx_id_required_for_btc_xmr' };
			}
			if (!/^[0-9a-f]{64}$/i.test(txid)) {
				return { reason: 'external_tx_id_malformed' };
			}
			external_tx_id = txid.toLowerCase();

			// Part 108++ — XMR-only: tx_proof is required for
			// per-payment verification without a view key.  BTC
			// has its own multi-explorer verification path that
			// doesn't need a proof; only XMR needs this.
			if (payload.fee_method === 'xmr') {
				const proof = payload.tx_proof;
				if (typeof proof !== 'string') {
					return { reason: 'tx_proof_required_for_xmr' };
				}
				const trimmed = proof.trim();
				// Monero tx_proof strings start with 'OutProofV1' or
				// 'OutProofV2' (out-bound proof) or 'InProofV1' /
				// 'InProofV2' (in-bound proof, used by the recipient).
				// For our use case the SENDER (user) is generating
				// the proof, so it's an OutProof.  We accept either
				// V1 or V2.  The full string is base58-encoded after
				// the prefix and ranges in length depending on the
				// number of outputs proven; we cap at a generous
				// 4 KiB to bound the JSONB write size while comfortably
				// fitting any realistic proof.
				if (
					!trimmed.startsWith('OutProofV1') &&
					!trimmed.startsWith('OutProofV2')
				) {
					return { reason: 'tx_proof_malformed_prefix' };
				}
				if (trimmed.length < 64 || trimmed.length > 4096) {
					return { reason: 'tx_proof_malformed_length' };
				}
				// Charset check — base58 + the literal "OutProofVN"
				// prefix.  Reject control characters and other
				// shenanigans early so they can't reach the
				// verifier endpoint as a query parameter.
				if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
					return { reason: 'tx_proof_malformed_charset' };
				}
				tx_proof = trimmed;
			}
		} else {
			return { reason: 'fee_method_unknown' };
		}
	}

	// Part 121 / cp30 — asset_network field for multi-network assets.
	// USDT (erc20/trc20/spl/bep20) and USDC (erc20/spl/base/polygon)
	// both REQUIRE asset_network.  Single-network assets must omit
	// (or pass null); a non-null asset_network on a single-network
	// asset is rejected as malformed.
	let asset_network: string | null = null;
	const networkRaw = payload.asset_network;
	const USDT_NETWORKS_VALID = new Set(['erc20', 'trc20', 'spl', 'bep20']);
	const USDC_NETWORKS_VALID = new Set(['erc20', 'spl', 'base', 'polygon']);
	// cp30-DD-DD I-1 (defense-in-depth) — bound the input before
	// allocating a lowercased copy.  Every valid network name is
	// ≤ 7 chars ('polygon').  Reject anything longer early — the
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
	} else {
		if (networkRaw !== undefined && networkRaw !== null) {
			// Single-network asset shipped with a network value —
			// either a malformed client OR an attempt to confuse
			// downstream readers.  Reject.
			return { reason: 'asset_network_not_permitted_for_asset' };
		}
		asset_network = null;
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
		asset_network
	};
}

/** Find the sibling transfer op that paid the fee for this order.
 *  Returns the parsed amount + observation, or null if no matching
 *  transfer exists in the same transaction. "Matching" means:
 *    - from the signer
 *    - to config.feeRecipient
 *    - memo equals `morphit-fee:<permlink>`
 *  Malformed sibling ops are skipped (not errors).
 */
function findFeeTransfer(
	siblingOps: readonly (readonly [string, Record<string, unknown>])[],
	signer: string,
	feeRecipient: string,
	permlink: string
): { amountBlurt: number } | null {
	const expectedMemo = `morphit-fee:${permlink}`;
	for (const op of siblingOps) {
		if (!op) continue;
		const [name, body] = op;
		if (name !== 'transfer') continue;
		const b = body as {
			from?: unknown;
			to?: unknown;
			amount?: unknown;
			memo?: unknown;
		};
		if (b.from !== signer) continue;
		if (b.to !== feeRecipient) continue;
		if (b.memo !== expectedMemo) continue;

		// Parse amount "N.NNN BLURT"
		if (typeof b.amount !== 'string') continue;
		const match = /^(\d+(?:\.\d+)?)\s+BLURT$/.exec(b.amount);
		if (!match) continue;
		const amount = Number(match[1]);
		if (!Number.isFinite(amount)) continue;

		return { amountBlurt: amount };
	}
	return null;
}

/** Count how many orders by this signer are in the "count toward
 *  Sybil tier" bucket per ADR-0009 §4: currently live OR created
 *  in the last 24h (even if cancelled). The count is of orders
 *  ALREADY in the DB; the order we're about to insert is the
 *  (n+1)-th. */
async function countForSybilTier(
	client: pg.PoolClient,
	signer: string,
	blockTime: Date
): Promise<number> {
	const cutoff = new Date(blockTime.getTime() - 24 * 3600 * 1000);
	const res = await client.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n
		 FROM orders
		 WHERE account = $1
		   AND (status = 'live' OR created_at >= $2)`,
		[signer, cutoff]
	);
	return parseInt(res.rows[0]?.n ?? '0', 10);
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	const v = validate(ctx.payload);
	if ('reason' in v) return { ok: false, reason: v.reason };

	// Part 121 — operator-level instance-wide asset disable gate
	// (Memory #25).  If the operator has listed this asset in
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

	// Part 111 — operator-attribution tag for federation-scoped
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
		// Phase 3: enforce a $1 USD minimum on the buy amount so the
		// user ends up with a meaningfully-sized BLURT balance (~500
		// BLURT at $0.002/BLURT) — enough to fund ~8 future listings.
		// A null amount_min would let a user take the waiver on a
		// listing with only an upper bound, bypassing the floor.
		if (v.amount_min === null) {
			return { ok: false, reason: 'waiver_requires_min_usd' };
		}
		// BLURT-native waiver floor.  After the §F.11 BLURT-
		// denomination refactor, the waiver minimum is 500 BLURT —
		// matches the frontend's WAIVER_MIN_BLURT constant in
		// $lib/orders/fee.  Originally pegged to "$1 USD-equivalent"
		// via the live price feed; under the BLURT-native model
		// there's no price feed in the critical path, so the floor
		// is a flat BLURT amount the user must hit.  500 BLURT is
		// roughly $1 at typical recent BLURT prices and lines up
		// nicely with the 60 BLURT listing fee (a 500-BLURT waiver-
		// buy covers ~8 future listing fees).  Without this floor,
		// a user could take the waiver on a tiny 1-BLURT buy and
		// leave the flow with effectively-zero starter balance.
		const WAIVER_MIN_BLURT = 500;
		if (v.amount_min < WAIVER_MIN_BLURT) {
			return { ok: false, reason: 'waiver_requires_min_usd' };
		}
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
				expires_at, fee_status, fee_method, operator_tag
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
			          'live', $13, $13, $14, 'verified', 'waived_first_buy', $15)
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
				operatorTagForRow
			]
		);
		if ((waiverRes.rowCount ?? 0) > 0) {
			ctx.recordOrderbookChange(`${ctx.signer}/${v.permlink}`);
		}
		return { ok: true };
	}

	// ─── ADR-0011 sub-phase 4b: BTC/XMR paths ──────────────────────
	// For btc/xmr, fee payment happened off-Blurt. The payer's txid
	// is in v.external_tx_id. We invoke the appropriate verifier
	// (injected via ctx.feeVerifiers), which either confirms the
	// payment, finds it underpaid/missing, or reports the explorer
	// is unreachable (pending_external).
	if (v.fee_method === 'btc' || v.fee_method === 'xmr') {
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
			// Part 106: ctx.feeAmounts uses the same chain-pin >
			// env precedence as feeVerifiers, so this also catches
			// the case where the verifier was rebuilt for a
			// chain-pinned address but the env-only amount was 0.
			return { ok: false, reason: `fee_amount_not_configured_${v.fee_method}` };
		}

		// Finding O19 — fee-reuse check.  An external_tx_id can pay
		// for at most one order per fee_method.  Check for prior
		// claims BEFORE running the verifier; if reuse is detected,
		// we don't even bother hitting the explorer.  The order row
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
		const reuseProbe = await client.query<{ account: string }>(
			`SELECT account FROM orders
			 WHERE fee_method = $1 AND external_tx_id = $2
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
			const reusedRes = await client.query(
				`INSERT INTO orders (
					account, permlink, side, asset, asset_network, fiat_currency,
					amount_min, amount_max, price_model, location_region,
					payment_methods, terms, status, created_at, updated_at,
					expires_at, fee_status, fee_method, external_tx_id, tx_proof,
					operator_tag
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
				          'live', $13, $13, $14, 'reused', $15, $16, $17, $18)
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
					v.external_tx_id,
					v.tx_proof,
					operatorTagForRow
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

		const result = await verifier.verify({
			feeMethod: v.fee_method,
			expectedAmount,
			externalTxId: v.external_tx_id,
			txProof: v.tx_proof,
			permlink: v.permlink,
			signer: ctx.signer
		});

		// Map the discriminated verifier result onto a row status.
		// The row is always inserted so the user can inspect what
		// happened. Orderbook visibility is gated on fee_status.
		let feeStatus: 'verified' | 'pending_external' | 'missing' | 'underpaid';
		if (result.kind === 'verified') {
			feeStatus = 'verified';
		} else if (result.kind === 'pending_external') {
			// Attestation fallback can promote this later.
			feeStatus = 'pending_external';
		} else {
			// rejected. Broad bucket — specific reason went to logs.
			// Using 'missing' as the default rejected status since
			// underpaid is only meaningful when the tx exists. The
			// verifier's reason code distinguishes them in the log.
			feeStatus = result.reason.startsWith('underpaid') ? 'underpaid' : 'missing';
			log.info('fee_rejected', {
				signer: ctx.signer,
				permlink: v.permlink,
				fee_method: v.fee_method,
				reason: result.reason
			});
		}

		const externalRes = await client.query(
			`INSERT INTO orders (
				account, permlink, side, asset, asset_network, fiat_currency,
				amount_min, amount_max, price_model, location_region,
				payment_methods, terms, status, created_at, updated_at,
				expires_at, fee_status, fee_method, external_tx_id, tx_proof,
				operator_tag
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
			          'live', $13, $13, $14, $15, $16, $17, $18, $19)
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
				operatorTagForRow
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
	const transfer = findFeeTransfer(ctx.siblingOps, ctx.signer, ctx.config.feeRecipient, v.permlink);

	let feeStatus: 'verified' | 'missing' | 'underpaid' = 'missing';
	if (transfer !== null) {
		// Count existing orders for Sybil tier. This order is the
		// (count + 1)-th.
		const existingCount = await countForSybilTier(client, ctx.signer, ctx.blockTime);
		const nth = existingCount + 1;
		// BLURT-native fee: pure function of the configured base
		// times the tier multiplier.  No price-feed dependency —
		// frontend computes the same value with the same constants,
		// so no TOCTOU window between quote and verification.  The
		// feeTolerance band (default 0.001 = 0.1%) only absorbs
		// floating-point rounding in the formatted BLURT amount.
		const expected = expectedFeeBlurt(nth, ctx.config.feeBaseBlurt);
		const minAcceptable = expected * (1 - ctx.config.feeTolerance);
		if (transfer.amountBlurt < minAcceptable) {
			feeStatus = 'underpaid';
		} else {
			feeStatus = 'verified';
		}
	}

	// INSERT ... ON CONFLICT DO NOTHING — idempotent. If the row
	// already exists (replay, network retry), preserve it; explicit
	// updates go through the replace handler.
	const res = await client.query(
		`INSERT INTO orders (
			account, permlink, side, asset, asset_network, fiat_currency,
			amount_min, amount_max, price_model, location_region,
			payment_methods, terms, status, created_at, updated_at,
			expires_at, fee_status, fee_method, operator_tag
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
		          'live', $13, $13, $14, $15, 'blurt', $16)
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
			operatorTagForRow
		]
	);

	// ADR-0011 §4c: loyalty milestone tracking. Only track when the
	// fee actually verified AND the INSERT was fresh (rowCount > 0);
	// replays land as rowCount == 0 and would otherwise double-count.
	// The loyalty module itself also guards via UNIQUE, but catching
	// it here first avoids churn on the account_loyalty table.
	if (feeStatus === 'verified' && transfer !== null && (res.rowCount ?? 0) > 0) {
		await trackVerifiedBlurtFee(
			client,
			ctx.signer,
			transfer.amountBlurt,
			ctx.blockNum,
			ctx.blockTime,
			operatorTagForRow,
			ctx.config.instanceOperatorTag
		);

		// REVISIT-LIST item 5 — operator-earnings attribution.
		// If this order op carries an `operator_tag` resolving to
		// a registered active operator, credit them 90% of the
		// BLURT fee.  No-op if tag is missing/malformed/unknown.
		// Idempotent on trx_id; replay-safe.  See operatorEarnings.ts
		// for the deep black-hat audit and policy rationale.
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
			feeBlurt: transfer.amountBlurt,
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
