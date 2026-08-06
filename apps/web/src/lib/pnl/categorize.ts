/**
 * Morphit — P&L row categorizer.
 *
 * Pure: takes a chain operation entry (as returned by
 * condenser_api.get_account_history) plus the account whose
 * statement we're building, returns a structured P&L row OR null
 * if the op isn't a financial event for the user.
 *
 * Categories produced (label keys mirror i18n prefix
 * `profile.pnl.category.*`):
 *
 *   - `blurt_received` — incoming `transfer` op.  Buyer paying us
 *     for crypto, or operator settling a Featured-bid win, or any
 *     other inbound transfer.  Memo (if any) is preserved.
 *   - `blurt_sent` — outgoing `transfer` op (excluding fee
 *     transfers — see below).  Could be us paying a counterparty,
 *     gifting, or a non-Morphit personal transfer.
 *   - `order_fee` — outgoing `transfer` to the operator's fees
 *     account (constant @morphit-fees) with a memo matching the
 *     order-fee shape.
 *   - `featured_bid` — outgoing `transfer` participating in a
 *     Featured-listing auction.
 *   - `featured_payout` — incoming `transfer` from the operator
 *     account distributing Featured-bid revenue (only for
 *     operators, but we surface it uniformly).
 *
 * What we DON'T categorize (returns null):
 *   - custom_json ops (these are Morphit business-logic ops, not
 *     P&L events on their own).
 *   - non-transfer ops (votes, comments, etc.).
 *   - vesting deposits/withdrawals (Phase 5 work — power-up/down
 *     can be relevant for tax in some jurisdictions but the math
 *     gets jurisdiction-specific).
 *
 * The exact mapping of "is this a Featured bid vs an order fee"
 * relies on memo conventions defined elsewhere in the codebase.
 * The categorizer accepts injected predicates so the smoke can
 * exercise it without hard-coding operator account names.
 */

import { parseAssetAmount } from '../blurt/balanceMath';

/** A chain history entry as returned by Blurt's condenser_api.
 *  Mirrors the shape consumed by getLatestCustomJson. */
export interface HistoryOp {
	readonly block: number;
	readonly trx_id: string;
	readonly timestamp: string; // ISO-ish (no Z suffix on Blurt)
	readonly op: readonly [string, Record<string, unknown>];
}

export type PnlCategory =
	| 'blurt_received'
	| 'blurt_sent'
	| 'order_fee'
	| 'featured_bid'
	| 'featured_payout';

export interface PnlRow {
	/** ISO timestamp (UTC).  Always normalized to a `Z` suffix
	 *  so spreadsheet parsers don't guess local timezone. */
	readonly timestamp: string;
	readonly trxId: string;
	readonly block: number;
	readonly category: PnlCategory;
	/** Counterparty account name.  For incoming, the sender; for
	 *  outgoing, the recipient. */
	readonly counterparty: string;
	/** Amount in BLURT, signed: positive for inbound, negative for
	 *  outbound (so summing the column gives net P&L). */
	readonly blurtSigned: number;
	/** Memo text, redacted of any private-key-shaped substring as
	 *  a final defense (no key should ever appear in a memo, but
	 *  paranoia is cheap).  Empty string when no memo. */
	readonly memo: string;
}

/** Predicate hooks, injected at call site so the categorizer
 *  doesn't bake operator-account names into pure logic.
 *
 *  - `isFeesAccount(name)`: true if `name` is the operator's fees
 *    sink (the constant `@morphit-fees` mainnet).
 *  - `isOperatorAccount(name)`: true if `name` is the operator's
 *    revenue/treasury account (`@morphit` on mainnet).
 *  - `isFeaturedBidMemo(memo)`: true if the memo matches the
 *    Featured-bid memo convention. */
export interface CategorizerPredicates {
	readonly isFeesAccount: (name: string) => boolean;
	readonly isOperatorAccount: (name: string) => boolean;
	readonly isFeaturedBidMemo: (memo: string) => boolean;
}

/** Defensive memo redaction.  WIFs start with 5/K/L and are
 *  51-52 chars; if we see a substring like that, replace it.
 *  Belt-and-braces — Morphit's UI never puts WIFs in memos, but
 *  nothing prevents a weird third-party tool from doing so. */
function redactKeyShapes(memo: string): string {
	return memo.replace(/[5KL][1-9A-HJ-NP-Za-km-z]{50,51}/g, '[REDACTED-WIF-SHAPE]');
}

/** Normalize Blurt's timestamp (e.g. "2024-08-15T14:32:18") to
 *  ISO-Z form for spreadsheet parsers. */
function normalizeTimestamp(ts: string): string {
	if (ts.endsWith('Z')) return ts;
	return ts + 'Z';
}

/** Categorize one history op for the given account.  Returns
 *  null if the op isn't a P&L event we surface. */
export function categorizeOp(
	op: HistoryOp,
	account: string,
	preds: CategorizerPredicates
): PnlRow | null {
	// Audit fix #7: defensive guard against malformed op.op.  The
	// HistoryOp type declares it as a tuple, but the data comes
	// from a possibly-hostile RPC node.  A non-array op.op would
	// crash the destructure below; an array of length < 2 would
	// produce undefined values.  Both → null (not categorizable).
	if (!Array.isArray(op.op) || op.op.length < 2) return null;
	const [opName, body] = op.op;
	if (typeof opName !== 'string') return null;
	if (typeof body !== 'object' || body === null) return null;
	if (opName !== 'transfer') return null;

	// Transfer body: { from, to, amount: "12.345 BLURT", memo: "..." }
	const from = typeof body.from === 'string' ? body.from : null;
	const to = typeof body.to === 'string' ? body.to : null;
	const amountStr = typeof body.amount === 'string' ? body.amount : null;
	const memoRaw = typeof body.memo === 'string' ? body.memo : '';
	if (!from || !to || !amountStr) return null;

	// Only count BLURT transfers.  Blurt's chain has just BLURT and
	// the rare BLURT_BACKED (deprecated); we reject anything else.
	if (!amountStr.endsWith(' BLURT')) return null;

	const amount = parseAssetAmount(amountStr);
	if (!Number.isFinite(amount) || amount <= 0) return null;

	const memo = redactKeyShapes(memoRaw);
	const timestamp = normalizeTimestamp(op.timestamp);

	const isOutbound = from === account;
	const isInbound = to === account;
	if (!isOutbound && !isInbound) return null;

	const counterparty = isOutbound ? to : from;
	const blurtSigned = isOutbound ? -amount : amount;

	let category: PnlCategory;
	if (isOutbound) {
		if (preds.isFeesAccount(to)) {
			category = 'order_fee';
		} else if (preds.isOperatorAccount(to) && preds.isFeaturedBidMemo(memo)) {
			category = 'featured_bid';
		} else {
			category = 'blurt_sent';
		}
	} else {
		// Inbound
		if (preds.isOperatorAccount(from)) {
			category = 'featured_payout';
		} else {
			category = 'blurt_received';
		}
	}

	return {
		timestamp,
		trxId: op.trx_id,
		block: op.block,
		category,
		counterparty,
		blurtSigned,
		memo
	};
}

/** Filter a list of history ops to those falling within the
 *  inclusive [startUnix, endUnix] window.  Pure helper; pulled
 *  out so the smoke can exercise it independently. */
export function filterByDateRange(
	rows: readonly PnlRow[],
	startUnix: number,
	endUnix: number
): PnlRow[] {
	return rows.filter((r) => {
		const t = Date.parse(r.timestamp) / 1000;
		return Number.isFinite(t) && t >= startUnix && t <= endUnix;
	});
}
