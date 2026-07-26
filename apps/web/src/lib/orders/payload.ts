/**
 * Morphit — order permlink + payload construction.
 *
 * A permlink is the account-scoped identifier for an order.
 * Morphit permlinks follow the Blurt permlink charset:
 * lowercase alphanumeric with dashes, 1-32 chars, no consecutive
 * dashes.
 *
 * We generate them client-side as an OPAQUE token (`order-<random>`).
 * cp175 F-012: an earlier version embedded `<side>-<asset>-<fiat>` so a
 * user browsing their own order list saw meaningful strings — but that
 * leaked the asset (e.g. "xmr") into the permanent on-chain permlink, order
 * URLs, RSS GUIDs, and block explorers, with no functional benefit (nothing
 * parses the permlink — side/asset/fiat come from the structured payload).
 * Privacy wins over the cosmetic readability; the order list derives its
 * labels from the structured fields, not the permlink.
 *
 * Security note: every free-text field in the payload is run
 * through `redactPrivateKeys()` before it leaves this builder.
 * This is the last line of defense — no matter which screen
 * composes an order (/post, /post/edit, future entry points),
 * nothing that looks like a private key gets broadcast.
 */

import { redactPrivateKeys } from '$lib/security/privateKeyDetector';
import type { AssetTicker } from '@morphit/asset-registry';
import type { OrderRecord } from '@morphit/indexer-client';

const PERMLINK_CHARSET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i/l/o/1 → ambiguity
const PERMLINK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Generate a random suffix of the given length. Uses the
 *  browser's crypto.getRandomValues — NOT Math.random, which
 *  isn't cryptographically uniform. */
function randomSuffix(len: number): string {
	const bytes = new Uint8Array(len);
	crypto.getRandomValues(bytes);
	let out = '';
	for (const b of bytes) {
		out += PERMLINK_CHARSET[b % PERMLINK_CHARSET.length];
	}
	return out;
}

/** Build an opaque permlink like "order-kx2mq7p4n8za". The random
 *  suffix has 12 chars drawn from a 30-char alphabet, giving
 *  ~59 bits of entropy — enough that two concurrent users
 *  don't collide on the same side/asset/fiat combo. */
/**
 * Order permlink — an OPAQUE random identifier.
 *
 * cp175 F-012 (Monero/privacy hardening): the permlink used to embed
 * `<side>-<asset>-<fiat>` (e.g. `sell-xmr-usd-ab12cd`). That string is
 * permanently public on the Blurt chain AND is spread into order URLs
 * (`/[account]/[permlink]`), RSS feed GUIDs + links, and block-explorer
 * displays — so the asset name (e.g. "xmr") leaked into many human-readable,
 * widely-syndicated, permanent surfaces. But NOTHING parses meaning out of the
 * permlink: the indexer reads side/asset/fiat from the structured op payload
 * (`payload.asset`, `payload.side`, ...), the orderbook UI renders from those
 * structured fields, and every other reference treats the permlink as an
 * opaque token (keyed as `account/permlink`). So embedding the asset was pure
 * redundant leakage.
 *
 * The asset/side/fiat still travel in the structured payload (the orderbook
 * needs them to match buyers and sellers — that's inherent and unavoidable for
 * a public orderbook). This change stops DUPLICATING them into the permlink
 * string, shrinking the gratuitous footprint: an on-chain observer / RSS
 * consumer / explorer no longer sees "xmr" in the permlink, URL, or feed.
 *
 * `side`/`asset`/`fiat` are still accepted as params for call-site
 * compatibility but are no longer encoded into the returned string. 12 random
 * base36 chars (~62 bits) keeps collisions negligible now that the
 * distinguishing prefix is gone; uniqueness is still enforced by the indexer's
 * (account, permlink) primary key regardless.
 */
export function makeOrderPermlink(_side: 'buy' | 'sell', _asset: AssetTicker, _fiat: string): string {
	const suffix = randomSuffix(12);
	const permlink = `order-${suffix}`;
	// Sanity: the result must match the indexer's PERMLINK_RE.
	if (!PERMLINK_RE.test(permlink)) {
		throw new Error(`Generated invalid permlink: ${permlink}`);
	}
	if (permlink.length > 32) {
		// Shouldn't happen with our bounded inputs, but guard anyway.
		throw new Error(`Generated permlink too long: ${permlink}`);
	}
	return permlink;
}

/**
 * The payload for morphit_order_v1 / morphit_order_replace_v1.
 *
 * Mirrors the indexer's handler validator — any change here must
 * also land in apps/indexer/src/indexer/handlers/order.ts. Both
 * sides deliberately duplicate the shape rather than import it
 * from the shared types package, because (a) the indexer handler
 * validates structurally from `unknown`, not from a TS type, and
 * (b) having it written twice is a small cost for the benefit of
 * each side failing independently when a drift happens.
 */
export interface OrderPayload {
	readonly permlink: string;
	readonly side: 'buy' | 'sell';
	readonly asset: AssetTicker;
	readonly fiat_currency: string;
	readonly amount_min: number | null;
	readonly amount_max: number | null;
	readonly price_model: Record<string, unknown>;
	readonly location_region: string | null;
	readonly payment_methods: readonly string[];
	readonly terms: string | null;
	readonly expires_at: string | null; // ISO-8601 UTC
	/** ADR-0011 — how the listing fee is paid. Omitted payloads
	 *  default to 'blurt' on the indexer for ADR-0009 back-compat.
	 *  'btc' and 'xmr' arrived in sub-phase 4b. */
	readonly fee_method?: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr';
	/** External transaction id for btc/xmr fee methods. Required
	 *  when fee_method is 'btc' or 'xmr'; omitted otherwise. 64-char
	 *  lowercase hex. */
	readonly external_tx_id?: string;
	/** Per-payment Monero proof string (Part 108++).  Required
	 *  when fee_method='xmr'; omitted otherwise.  This is the
	 *  user's `get_tx_proof` output from their own Monero wallet.
	 *  Lets any indexer verify the payment without holding the
	 *  treasury's private view key.  Reveals only "this txid
	 *  paid this address this amount" — nothing else about the
	 *  user's wallet or other payments to the treasury. */
	readonly tx_proof?: string;
	/** Part 121 / cp30 / cp31 — sub-network identifier for multi-
	 *  network assets.  REQUIRED when asset === 'USDT' (one of
	 *  'erc20', 'trc20', 'spl', 'bep20'), when asset === 'USDC'
	 *  (one of 'erc20', 'spl', 'base', 'polygon'), or when
	 *  asset === 'DAI' (one of 'erc20', 'polygon', 'base',
	 *  'arbitrum').  Omitted for single-network assets (BTC,
	 *  XMR, BLURT, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP).  Pins the network on
	 *  the order row so buyers know which chain to settle on;
	 *  cross-network sends lose funds permanently and must be
	 *  surfaced as a hint on the order row. */
	readonly asset_network?: string;
	/** REVISIT-LIST item 5 — operator earnings.  When present,
	 *  the indexer credits the operator who registered this tag
	 *  with 90% of the BLURT-paid listing fee.  Omitted (not
	 *  null/empty) when the instance has no operator_tag
	 *  configured — keeps the on-chain payload as small as
	 *  possible for unbranded instances. */
	readonly operator_tag?: string;
	/** cp425 — for a BARTER (goods/services) listing, the non-empty set of
	 *  crypto tickers the seller accepts as settlement (e.g. ['BTC','DOGE',
	 *  'XMR']). REQUIRED when asset === 'BARTER'; omitted for every crypto
	 *  asset (they settle in themselves). Each must be a real crypto ticker,
	 *  never 'BARTER' or any goods asset. The indexer dedupes + sorts to a
	 *  canonical set; the builder ships whatever the form provides. */
	readonly accepted_assets?: readonly AssetTicker[];
	/** v1.9.0 (Ken) — for a BARTER listing, the user's own short label for WHAT
	 *  they're offering (e.g. "bananas"), typed inline where the summary would
	 *  otherwise read "goods/services". Letters-only, ≤24 chars. OPTIONAL and
	 *  backward-compatible: omitted when blank or non-barter, and an older indexer
	 *  simply ignores it. It flows into the order title ("…of bananas") and the
	 *  Blurt announcement in place of the generic "goods/services" label. */
	readonly specific_barter_title?: string;
}

/** Input to buildOrderPayload — the fields a user fills in, in
 *  their friendly UI form. The builder normalizes them. */
export interface OrderFormInput {
	readonly side: 'buy' | 'sell';
	readonly asset: AssetTicker;
	readonly fiatCurrency: string;
	readonly amountMin: number | null;
	readonly amountMax: number | null;
	readonly priceModel: Record<string, unknown>;
	readonly locationRegion: string | null;
	readonly paymentMethods: readonly string[];
	readonly terms: string | null;
	readonly expiresAt: Date | null;
	/** Fee method. Defaults to 'blurt' when omitted. */
	readonly feeMethod?: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr';
	/** External transaction id for btc/xmr. Required when
	 *  feeMethod is 'btc' or 'xmr'. Will be lowercased in the
	 *  payload for canonicalization. */
	readonly externalTxId?: string;
	/** Per-payment Monero proof string (Part 108++).  Required
	 *  when feeMethod='xmr'.  Generated by the user's own
	 *  Monero wallet via `get_tx_proof` (CLI), "Prove
	 *  transaction" dialog (GUI), or the equivalent in
	 *  Cake/Feather/etc.  Eliminates the need for any indexer
	 *  to hold the treasury's view key.  Privacy invariant:
	 *  the proof reveals only "this txid paid this address
	 *  this amount" — nothing else about the user's wallet,
	 *  other treasury payments, or future inflows. */
	readonly txProof?: string;
	/** Part 121 / cp30 / cp31 — sub-network identifier for multi-
	 *  network assets.  REQUIRED when asset === 'USDT', asset ===
	 *  'USDC', or asset === 'DAI'.  Omitted for single-network
	 *  assets.  Form layer validates this is one of the asset-
	 *  appropriate values (USDT: 'erc20'|'trc20'|'spl'|'bep20';
	 *  USDC: 'erc20'|'spl'|'base'|'polygon'; DAI: 'erc20'|
	 *  'polygon'|'base'|'arbitrum') before invoking
	 *  buildOrderPayload. */
	readonly assetNetwork?: string;
	/** REVISIT-LIST item 5 — operator earnings.  When non-empty,
	 *  the post-order form passes this in.  Form layer reads it
	 *  from the instance store ($instance.operator_tag).  Empty
	 *  string treated same as undefined: omitted from payload. */
	readonly operatorTag?: string;
	/** cp425 — for a BARTER listing, the crypto tickers the seller accepts
	 *  as settlement. REQUIRED (non-empty) when asset === 'BARTER'; omitted
	 *  for crypto assets. The form layer validates each is a real crypto
	 *  ticker (never BARTER/goods) before calling buildOrderPayload. */
	readonly acceptedAssets?: readonly AssetTicker[];
	/** v1.9.0 (Ken) — the BARTER "what am I offering" label typed inline in the
	 *  summary sentence. Letters-only, ≤24 chars (the form enforces this; the
	 *  builder re-sanitizes as a backstop). Omitted/blank for crypto listings. */
	readonly specificBarterTitle?: string;
}

/** v1.9.0 (Ken) — the inline BARTER "what am I offering" label is capped and
 *  letters-only (no digits, punctuation, or whitespace). Shared by the form
 *  input handler, the payload builder backstop, and the smoke so all three agree
 *  on the exact rule. `\p{L}` keeps accented + non-Latin letters (bananas,
 *  plátanos, бананы, 香蕉) while dropping everything else. */
export const SPECIFIC_BARTER_TITLE_MAX = 24;
export function sanitizeBarterTitle(raw: string | null | undefined): string {
	if (!raw) return '';
	return Array.from(raw.replace(/[^\p{L}]/gu, '')).slice(0, SPECIFIC_BARTER_TITLE_MAX).join('');
}

/**
 * Build an OrderPayload from user input, doing the
 * normalization the indexer will verify:
 * - fiat_currency uppercased
 * - location_region trimmed, empty → null
 * - terms trimmed, empty → null
 * - expires_at in UTC ISO-8601
 *
 * Validation (ranges, charsets) is the responsibility of the
 * form layer BEFORE this function is called — we assume
 * well-formed input here and throw only on programmer error.
 */
export function buildOrderPayload(permlink: string, input: OrderFormInput): OrderPayload {
	const fiatNorm = input.fiatCurrency.trim().toUpperCase();
	// Free-text normalization + private-key redaction. The redaction
	// runs AFTER trim so we don't allow padded whitespace to evade
	// word-boundary detection. Empty strings collapse to null as
	// before. This is the security backstop: even if a field's form
	// screen lacks a ProtectedTextarea (e.g. a legacy screen added
	// later, or an input that's too short to justify the overlay UI),
	// nothing sensitive reaches the broadcast.
	const regionTrimmed = input.locationRegion?.trim();
	const regionNorm = regionTrimmed ? redactPrivateKeys(regionTrimmed) : null;
	const termsTrimmed = input.terms?.trim();
	const termsNorm = termsTrimmed ? redactPrivateKeys(termsTrimmed) : null;
	// Each payment method is a short chip label, but the same
	// backstop applies — no field escapes unredacted.
	const paymentMethodsNorm = input.paymentMethods.map((pm) => redactPrivateKeys(pm));
	const expiresIso = input.expiresAt ? input.expiresAt.toISOString() : null;

	return {
		permlink,
		side: input.side,
		asset: input.asset,
		fiat_currency: fiatNorm,
		amount_min: input.amountMin,
		amount_max: input.amountMax,
		price_model: input.priceModel,
		location_region: regionNorm,
		payment_methods: paymentMethodsNorm,
		terms: termsNorm,
		expires_at: expiresIso,
		...(input.feeMethod !== undefined ? { fee_method: input.feeMethod } : {}),
		...(input.externalTxId !== undefined && input.externalTxId.length > 0
			? { external_tx_id: input.externalTxId.toLowerCase() }
			: {}),
		// Part 108++ — XMR per-payment proof.  The proof is
		// trimmed of surrounding whitespace (wallets sometimes
		// emit trailing newlines) but otherwise passed through
		// verbatim — its internal structure is interpreted only
		// by the verifier endpoint, so any normalization beyond
		// trim could break verification.
		...(input.txProof !== undefined && input.txProof.trim().length > 0
			? { tx_proof: input.txProof.trim() }
			: {}),
		// Part 121 / cp30 / cp31 — sub-network for multi-network
		// assets.  Set when the form provides one (USDT, USDC, or
		// DAI); omitted for single-network assets.  Lowercased on
		// the way out for canonicalization with the asset-registry's
		// supportedNetworks values.
		...(input.assetNetwork !== undefined && input.assetNetwork.length > 0
			? { asset_network: input.assetNetwork.toLowerCase() }
			: {}),
		// REVISIT-LIST item 5 — pass through when set.  We
		// normalize empty strings out so an instance with the
		// env var defined but empty doesn't ship an empty
		// operator_tag (which would always lookup-fail as
		// malformed at the indexer side).
		...(input.operatorTag !== undefined && input.operatorTag.length > 0
			? { operator_tag: input.operatorTag }
			: {}),
		// cp425 — accepted-crypto set for a BARTER listing.  Deduped + sorted
		// to the same canonical form the indexer stores, so the broadcast
		// payload is deterministic (the same accepted-set always serializes
		// identically).  Included only when the form provides a non-empty set
		// (BARTER); omitted for crypto assets, which settle in themselves.
		...(input.acceptedAssets !== undefined && input.acceptedAssets.length > 0
			? { accepted_assets: [...new Set(input.acceptedAssets)].sort() as AssetTicker[] }
			: {}),
		// v1.9.0 (Ken) — the inline BARTER title, re-sanitized here (letters-only,
		// ≤24) as the security/consistency backstop and included only when it
		// survives non-empty. Omitted for crypto listings and blank barter titles,
		// keeping the on-chain payload minimal and backward-compatible.
		...((): { specific_barter_title?: string } => {
			const t = sanitizeBarterTitle(input.specificBarterTitle);
			return t.length > 0 ? { specific_barter_title: t } : {};
		})()
	};
}

/**
 * Compute an order-expiry Date `expiresDays` whole days from now, FLOORED to
 * the start of that UTC day (00:00:00.000Z).
 *
 * cp175 F-015 (metadata-leak reduction): the previous call sites used
 * `new Date(Date.now() + expiresDays * 86_400_000)`, whose `.toISOString()`
 * carries the submit moment to MILLISECOND precision (e.g. `…T14:23:47.831Z`).
 * That value is broadcast on the public Blurt chain in `expires_at`. Because
 * the interval is a round number of days, an observer can subtract it to
 * recover the client's exact wall-clock reading at submit time — a secondary
 * timing/clock-skew fingerprint independent of (and finer than) the block
 * time. Flooring to UTC midnight strips all sub-day precision; expiry is only
 * ever used in `>` liveness comparisons and shown as "expires in N days," so
 * nothing functional is lost. We floor (never round up) so the result can't
 * cross the indexer's MAX_EXPIRES_AT_DAYS ceiling.
 */
export function makeExpiryFlooredUtcDay(expiresDays: number): Date {
	const target = Date.now() + expiresDays * 86_400_000;
	const floored = Math.floor(target / 86_400_000) * 86_400_000;
	return new Date(floored);
}

/**
 * The order payload we just broadcast, shaped as the OrderRecord the rest of the
 * UI renders (v1.7.0, "fastpostorder", ADR-0051).
 *
 * WHY FROM THE PAYLOAD, NOT THE FORM. The payload is what actually went on
 * chain — `buildOrderPayload` trims, upper-cases the fiat code, and redacts
 * private keys out of free text. Building the optimistic record from the raw
 * form instead would let the card show something subtly different from what the
 * chain will eventually serve, and the difference would only surface ~60s later
 * when the durable row replaced it. Deriving from the payload makes disagreement
 * impossible rather than unlikely.
 *
 * WHAT IS DELIBERATELY ABSENT. Every field OrderRecord marks optional is
 * DERIVED by the indexer — `fee_status`, `trade_count`, `reputation_score`,
 * `is_new_trader`, `engagement_24h`, `feedback_count`, `weighted_rating`. None
 * are set here, and that is the point, not a shortcut: ADR-0051 keeps money and
 * reputation durable-only, so a provisional card must not invent a trade count
 * or a rating. It is a happy accident that OrderRecord's required/optional split
 * already draws almost exactly that line — the type will not let a caller forget
 * a real field, and will not tempt them into fabricating a derived one.
 *
 * PURE.
 */
export function orderPayloadToRecord(
	account: string,
	payload: OrderPayload,
	nowIso: string
): OrderRecord {
	return {
		account,
		permlink: payload.permlink,
		side: payload.side,
		asset: payload.asset,
		fiat_currency: payload.fiat_currency,
		amount_min: payload.amount_min,
		amount_max: payload.amount_max,
		price_model: payload.price_model,
		location_region: payload.location_region,
		payment_methods: payload.payment_methods,
		terms: payload.terms,
		created_at: nowIso,
		updated_at: nowIso,
		expires_at: payload.expires_at,
		// A freshly-broadcast order is live by definition — nothing has had the
		// chance to cancel, fill or expire it yet.
		status: 'live',
		...(payload.fee_method !== undefined ? { fee_method: payload.fee_method } : {})
	};
}
