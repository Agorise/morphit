/**
 * Morphit — order permlink + payload construction.
 *
 * A permlink is the account-scoped identifier for an order.
 * Morphit permlinks follow the Blurt permlink charset:
 * lowercase alphanumeric with dashes, 1-32 chars, no consecutive
 * dashes.
 *
 * We generate them client-side with a human-readable prefix
 * (`sell-btc-usd-`) plus a random suffix, so a user browsing
 * their own order list sees meaningful strings rather than
 * opaque tokens.
 *
 * Security note: every free-text field in the payload is run
 * through `redactPrivateKeys()` before it leaves this builder.
 * This is the last line of defense — no matter which screen
 * composes an order (/post, /post/edit, future entry points),
 * nothing that looks like a private key gets broadcast.
 */

import { redactPrivateKeys } from '$lib/security/privateKeyDetector';
import type { AssetTicker } from '@morphit/asset-registry';

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

/** Build a permlink like "sell-btc-usd-kx2mq7". The random
 *  suffix has 6 chars drawn from a 30-char alphabet, giving
 *  ~30 bits of entropy — enough that two concurrent users
 *  don't collide on the same side/asset/fiat combo. */
export function makeOrderPermlink(side: 'buy' | 'sell', asset: AssetTicker, fiat: string): string {
	const safeFiat = fiat
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '')
		.slice(0, 8);
	const suffix = randomSuffix(6);
	const permlink = `${side}-${asset.toLowerCase()}-${safeFiat}-${suffix}`;
	// Sanity: the result must match the indexer's PERMLINK_RE.
	// If fiat was empty, the `--` gap would fail that check.
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
	/** Part 121 — sub-network identifier for multi-network
	 *  assets.  REQUIRED when asset === 'USDT' (one of 'erc20',
	 *  'trc20', 'spl', 'bep20').  Omitted for single-network
	 *  assets (BTC, XMR, BLURT).  Pins the network on the order
	 *  row so buyers know which USDT chain to settle on;
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
	/** Part 121 — sub-network identifier for multi-network
	 *  assets.  REQUIRED when asset === 'USDT'.  Omitted for
	 *  single-network assets.  Form layer validates this is one
	 *  of 'erc20'|'trc20'|'spl'|'bep20' before invoking
	 *  buildOrderPayload. */
	readonly assetNetwork?: string;
	/** REVISIT-LIST item 5 — operator earnings.  When non-empty,
	 *  the post-order form passes this in.  Form layer reads it
	 *  from the instance store ($instance.operator_tag).  Empty
	 *  string treated same as undefined: omitted from payload. */
	readonly operatorTag?: string;
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
		// Part 121 — sub-network for multi-network assets.  Only
		// set when the form provides one (USDT case); omitted for
		// single-network assets.  Lowercased on the way out for
		// canonicalization with the asset-registry's
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
			: {})
	};
}
