/**
 * Morphit chat — BLURT transfer verification (Phase F.4).
 *
 * After a buyer marks "funds sent" with a txid and a claimed
 * memo, the seller's chat UI fetches the transaction from the
 * Blurt chain and verifies it matches what was actually
 * agreed to in the chat:
 *
 *   - Recipient ("to") matches the seller's account
 *   - Sender ("from") matches the buyer's chat identity
 *   - Amount matches the address payload's amount
 *   - Memo matches the address payload's memo
 *
 * Result is a discriminated tag the UI renders distinctly:
 * green check, yellow warning with field detail, gray
 * skeleton (loading), or red error.  The seller doesn't have
 * to manually correlate incoming transfers anymore —
 * Morphit shows them which trade was paid.
 *
 * Why this lives separately from payload.ts: payload.ts is
 * pure (no I/O); this module fetches from chain RPC.  Splitting
 * preserves payload.ts's testability under tsx without a
 * mock chain.
 *
 * Performance: one RPC call per `funds_sent` pill that lands
 * with a txid.  Cached in-memory by txid for the session;
 * users navigating away and back don't re-fetch.  Cache is
 * NOT persisted — verification is cheap and the chain truth is
 * always preferred over a stored answer.
 */

import { isValidMemo } from './payload';

/** Result of verifying a BLURT funds-sent claim against chain. */
export type VerifyResult =
	| { kind: 'verified' }
	| { kind: 'mismatch'; field: 'to' | 'from' | 'amount' | 'memo' }
	| { kind: 'not_found' }
	| { kind: 'wrong_op' /* tx exists but contains no transfer op matching */ }
	| { kind: 'rpc_error'; message: string };

/** Inputs to the verifier — what the seller expected. */
export interface VerifyExpect {
	/** "to" account on the on-chain transfer (the seller). */
	readonly recipient: string;
	/** "from" account — the buyer's known chat identity (peer). */
	readonly sender: string;
	/** Expected amount as a number (BLURT, not satoshis-equivalent).
	 *  Compared against the parsed amount from the on-chain
	 *  transfer's "N.NNN BLURT" string. */
	readonly amountBlurt: number;
	/** Expected memo — the random token the seller pinned in the
	 *  AddressPayload.memo field.  Empty string means "no memo
	 *  requested," in which case any memo on the actual transfer
	 *  is treated as a mismatch. */
	readonly memo: string;
}

/** Chain transfer operation shape — public so smoke tests and
 *  future callers can construct mock txes for verifyBlurtTransferAgainstTx. */
export interface ChainTransferOp {
	readonly from: string;
	readonly to: string;
	readonly amount: string; // "1700.000 BLURT"
	readonly memo: string;
}

/** Chain get_transaction response shape — only the bits we use. */
export interface ChainTxResponse {
	readonly operations: ReadonlyArray<[string, unknown]> | undefined;
}

const verifyCache = new Map<string, VerifyResult>();

/** Cache-aware verify.  Pass txid + what the seller expected. */
export async function verifyBlurtTransfer(
	txid: string,
	expect: VerifyExpect
): Promise<VerifyResult> {
	// Cache key includes the expected fields — if the seller's
	// understanding of the trade somehow differs across mounts
	// (shouldn't, but defense in depth), the cache doesn't lie.
	const cacheKey = `${txid}|${expect.recipient}|${expect.sender}|${expect.amountBlurt}|${expect.memo}`;
	const cached = verifyCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const result = await verifyBlurtTransferUncached(txid, expect);
	// Cache definitive results (verified, mismatch, not_found,
	// wrong_op) — those don't change without a chain reorg.  Don't
	// cache rpc_error — the next attempt may succeed.
	if (result.kind !== 'rpc_error') {
		verifyCache.set(cacheKey, result);
	}
	return result;
}

async function verifyBlurtTransferUncached(
	txid: string,
	expect: VerifyExpect
): Promise<VerifyResult> {
	if (expect.memo !== '' && !isValidMemo(expect.memo)) {
		// Sanity guard: if the seller's expected memo isn't even
		// shape-valid, the verification can't succeed.  Surface
		// distinctly so the UI can show "the memo on the original
		// address pill is malformed" rather than chain-side
		// failure.  Treat as mismatch on memo.
		return { kind: 'mismatch', field: 'memo' };
	}

	// cp410 — the browser no longer queries Blurt nodes directly (privacy #1).
	// The transaction is fetched ONCE through the operator's indexer relay
	// (POST /v1/chain/condenser), which reads from its own canonical node pool.
	// This collapses the old browser-side multi-node quorum onto the indexer: a
	// single hostile PUBLIC node can no longer fabricate a transaction body to
	// fool the seller, but the seller now trusts their instance operator for
	// this read. To keep the payment check trustless for the cautious, the chat
	// UI offers an independent "verify on a block explorer" link alongside the
	// confirmation (ChatMessage.svelte). See net/chainRelay.ts.
	const { chainRelay, ChainRelayError } = (await import(
		'$net/chainRelay'
	)) as typeof import('$net/chainRelay');

	let tx: ChainTxResponse | null;
	try {
		tx = await chainRelay<ChainTxResponse | null>('get_transaction', [txid]);
	} catch (e) {
		// Couldn't reach the indexer relay (transport / 5xx) — NOT the same as
		// "transaction definitely not on chain"; the next attempt may succeed.
		return {
			kind: 'rpc_error',
			message: e instanceof ChainRelayError ? e.message : 'could not reach the chain'
		};
	}
	if (!tx || typeof tx !== 'object') {
		// The relay returns a null result when the chain has no such transaction.
		return { kind: 'not_found' };
	}

	return verifyBlurtTransferAgainstTx(tx, expect);
}

/** Phase F.5 audit fix (F-10) — classify an RPC error message
 *  as either `not_found` (transaction definitely not on chain)
 *  or fall-through (treat as rpc_error: chain unreachable / RPC
 *  bug / etc.).
 *
 *  Pre-fix regex `/not\s*found|unknown.*trans|missing.*trans/i`
 *  matched generic network errors like "host not found" or
 *  "DNS not found", misleading the user that the transaction
 *  doesn't exist when actually we couldn't reach the chain.
 *
 *  Tighter test: message must mention BOTH a chain object
 *  (transaction/trx/tx/hash) AND a negation (not found /
 *  unknown / missing / no such).  Real Blurt-node responses for
 *  missing transactions all match this:
 *    - "Could not find transaction matching hash …"
 *    - "Transaction not found"
 *    - "Unknown transaction"
 *    - "trx_id not found"
 *
 *  Exported for smoke testability. */
export function classifyRpcError(message: string): 'not_found' | 'other' {
	const lower = message.toLowerCase();
	const mentionsChainObject =
		lower.includes('transaction') || lower.includes('trx') || lower.includes('hash');
	const mentionsAbsence = /not\s*(found|find|exist)|unknown|missing|no such/.test(lower);
	return mentionsChainObject && mentionsAbsence ? 'not_found' : 'other';
}

/** Pure dispatcher.  Given the chain's get_transaction response
 *  and the seller's expectations, return the discriminated
 *  VerifyResult.  Exported for testability — tsx smoke runners
 *  can exercise the dispatch logic without hitting the chain.
 *
 *  The network-fetching wrapper above handles RPC errors and
 *  delegates the actual comparison logic here.
 *
 *  ─── Multi-transfer handling (audit F-7) ──────────────────
 *
 *  A transaction can contain MULTIPLE transfers to the same
 *  recipient.  The chain allows bundling.  A malicious buyer
 *  could place a small "decoy" transfer ahead of the real
 *  payment to trick a naive verifier into reading the wrong
 *  one.
 *
 *  Strategy: scan ALL transfers with `to === expect.recipient`.
 *  If ANY matches every expected field, we return verified —
 *  the legitimate payment is in the bundle somewhere.  Only
 *  if no transfer matches everything do we return mismatch,
 *  using the candidate with the fewest discrepancies for the
 *  most diagnostic field-level error message.
 *
 *  If no transfer at all has `to === expect.recipient`, we
 *  return `wrong_op` (no transfer was destined for this seller).
 */
export function verifyBlurtTransferAgainstTx(
	tx: ChainTxResponse | null | undefined,
	expect: VerifyExpect
): VerifyResult {
	if (expect.memo !== '' && !isValidMemo(expect.memo)) {
		// Same sanity guard as the wrapper — keep the pure function
		// independently safe to call.
		return { kind: 'mismatch', field: 'memo' };
	}

	// Phase F.5 audit fix (F-13) — sanity-check the expected amount.
	// If an upstream bug passes NaN/Infinity/0/negative,
	// `Math.abs(actualAmount - NaN) === NaN` and the > 0.0005
	// epsilon comparison is `false`, which would falsely return
	// verified.  Surface as amount mismatch for defensive
	// correctness.
	if (!Number.isFinite(expect.amountBlurt) || expect.amountBlurt <= 0) {
		return { kind: 'mismatch', field: 'amount' };
	}

	if (!tx || !Array.isArray(tx.operations)) {
		return { kind: 'wrong_op' };
	}

	// Collect every transfer-op with `to === expect.recipient`.
	// We'll evaluate each against expect; the legitimate payment
	// (if any) wins regardless of position in the tx.
	const candidates: ChainTransferOp[] = [];
	for (const opEntry of tx.operations) {
		if (!Array.isArray(opEntry) || opEntry.length !== 2) continue;
		const opName = opEntry[0];
		const opBody = opEntry[1];
		if (opName !== 'transfer') continue;
		if (typeof opBody !== 'object' || opBody === null) continue;
		const candidate = opBody as ChainTransferOp;
		if (candidate.to === expect.recipient) {
			candidates.push(candidate);
		}
	}
	if (candidates.length === 0) return { kind: 'wrong_op' };

	// Evaluate each candidate.  First full-match wins → verified.
	// Otherwise track the candidate with the fewest mismatches
	// for diagnostic reporting.
	let bestMismatch: { field: 'to' | 'from' | 'amount' | 'memo'; count: number } | null = null;
	for (const candidate of candidates) {
		const failures = compareTransferToExpect(candidate, expect);
		if (failures.length === 0) {
			return { kind: 'verified' };
		}
		const firstField = failures[0] as 'to' | 'from' | 'amount' | 'memo';
		if (bestMismatch === null || failures.length < bestMismatch.count) {
			bestMismatch = { field: firstField, count: failures.length };
		}
	}

	// Fallthrough: no candidate matched all fields.  Report the
	// closest-match's first-failed field.  bestMismatch is non-null
	// because candidates.length > 0.
	return { kind: 'mismatch', field: bestMismatch!.field };
}

/** Compare a single transfer op against the seller's expectations.
 *  Returns the ordered list of fields that disagree; empty array
 *  means full match.
 *
 *  Order preserved: to, from, amount, memo.  This determines the
 *  field surfaced in the mismatch UI when the closest-match
 *  candidate has multiple disagreements. */
function compareTransferToExpect(
	matched: ChainTransferOp,
	expect: VerifyExpect
): Array<'to' | 'from' | 'amount' | 'memo'> {
	const failures: Array<'to' | 'from' | 'amount' | 'memo'> = [];

	// 'to' is filtered upstream so it always matches by
	// construction — but we keep the check for the rare case where
	// future restructuring loosens the filter.
	if (matched.to !== expect.recipient) failures.push('to');
	if (matched.from !== expect.sender) failures.push('from');

	// Amount comparison: chain string is "N.NNN BLURT".
	const amountMatch = /^(\d+\.\d{3})\s+BLURT$/.exec(matched.amount);
	if (amountMatch === null) {
		failures.push('amount');
	} else {
		const actualAmount = parseFloat(amountMatch[1] as string);
		if (!Number.isFinite(actualAmount)) {
			failures.push('amount');
		} else if (Math.abs(actualAmount - expect.amountBlurt) > 0.0005) {
			// 0.0005 epsilon — well below BLURT's 0.001 minimum unit.
			failures.push('amount');
		}
	}

	// Phase F.5 audit fix (F-9) — when seller's expected memo is
	// empty, accept any chain memo.  The seller didn't pin a memo;
	// the buyer's freeform memo (e.g. "thanks!") is fine.
	// Asymmetric: if seller PINNED a memo and buyer omitted, that's
	// still a mismatch — buyer didn't follow instructions.
	if (expect.memo !== '' && matched.memo !== expect.memo) failures.push('memo');

	return failures;
}

/** Test hook — clear the cache so per-test scenarios start fresh.
 *  Not used in production code paths. */
export function _clearVerifyCache(): void {
	verifyCache.clear();
}
