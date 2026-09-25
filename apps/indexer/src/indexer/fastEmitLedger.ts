/**
 * fastEmitLedger — which transactions have ALREADY been emitted on the fast path.
 *
 * A chat message can now reach this instance's event bus by three routes, and
 * without a shared note of what has gone out it would be emitted more than once:
 *
 *   1. Locally, because one of OUR OWN users sent it and we relayed the
 *      broadcast. (Both parties on one instance is the common case, and it had
 *      no fast path at all before v1.18.0 — the peer list excludes self, so a
 *      local recipient waited for the head tailer to read the message back off
 *      the chain: a block interval, plus a poll interval, plus a hidden RPC
 *      read. Up to 6.8 seconds on a privacy-only instance, for two people on the
 *      same server.)
 *
 *   2. From a peer, pushed to the federation endpoint.
 *
 *   3. From the chain, when the head tailer reaches that block a few seconds
 *      later — which it will do for every message, including the ones already
 *      delivered by routes 1 and 2.
 *
 * The client does collapse duplicates by `client_tag`, so a second emit was
 * never going to be visible. But it is wasted work on every message, it doubles
 * the SSE traffic on the exact transport where bytes are dear, and "the client
 * cleans up after us" is a poor reason to send something twice.
 *
 * ONLY ACTUAL EMITS ARE RECORDED. A message the block check dropped, or one
 * whose gate could not be evaluated, is deliberately NOT marked — otherwise a
 * momentary database failure on the fast path would also suppress the head
 * tailer's later, independent attempt, and the message would be lost from the
 * fast path entirely rather than merely delayed. This ledger says "already
 * delivered", never "already considered".
 *
 * Deliberately separate from the federation module's replay memory, which
 * answers a different question ("has a PEER pushed me this before?") and is
 * recorded before delivery is attempted. Deliberately its own module so the head
 * tailer and the federation code can both use it without importing each other.
 */

/**
 * Long enough to cover the gap between a fast emit and the head tailer reaching
 * the block that carries the same transaction.
 *
 * DERIVED, NOT PICKED. The honest bound on that gap is the tailer's own
 * catch-up allowance: it skips ahead only when it is more than
 * `MAX_CATCHUP_BLOCKS` (120) behind head, so it will happily scan a block 119
 * blocks old — at Blurt's three-second interval, just under six minutes — plus
 * a poll interval on top. A flat five minutes was SHORTER than that, which meant
 * a tailer catching up after any stall would re-emit messages the fast path had
 * already delivered: the one thing this module exists to prevent, failing in
 * precisely the circumstance that produces it. Doubling the worst case leaves
 * room for the hole-retry path as well, and costs nothing — the table is bounded
 * independently by MAX_ENTRIES.
 *
 * These two numbers are RESTATED here rather than imported, because the head
 * tailer imports this module and a constant imported back the other way would be
 * a cycle. `fast-emit-ledger-smoke.ts` imports both sides and asserts they still
 * agree, so the restatement cannot drift unnoticed.
 */
/** Mirrors MAX_CATCHUP_BLOCKS in headTailer.ts. */
const HEAD_TAILER_MAX_CATCHUP_BLOCKS = 120;
/** Blurt's block interval. */
const BLOCK_INTERVAL_MS = 3_000;
export const TTL_MS = HEAD_TAILER_MAX_CATCHUP_BLOCKS * BLOCK_INTERVAL_MS * 2;

/** Bounded: this grows with message volume, and message volume is not ours to
 *  control. Eviction is oldest-first. */
const MAX_ENTRIES = 20_000;

const emitted = new Map<string, number>();

function prune(now: number): void {
	// Insertion order is chronological, so expired entries sit at the front and
	// the scan can stop at the first live one.
	for (const [k, t] of emitted) {
		if (now - t > TTL_MS) emitted.delete(k);
		else break;
	}
}

/** Record that this transaction has been emitted on the fast path. Call this
 *  only after an emit actually happened.
 *
 *  `now` is injectable so that EXPIRY can be tested. Without it the only way to
 *  exercise the TTL is to wait out a real one — so nothing did, and the bound
 *  that stops the head tailer re-emitting after a catch-up was never checked at
 *  all. Production never passes it. */
export function markFastEmitted(trxId: string, now: number = Date.now()): void {
	if (trxId.length === 0) return;
	prune(now);
	emitted.delete(trxId);
	emitted.set(trxId, now);
	while (emitted.size > MAX_ENTRIES) {
		const oldest = emitted.keys().next().value;
		if (oldest === undefined) break;
		emitted.delete(oldest);
	}
}

/** True when this transaction has already gone out on the fast path. */
export function wasFastEmitted(trxId: string, now: number = Date.now()): boolean {
	const t = emitted.get(trxId);
	if (t === undefined) return false;
	return now - t <= TTL_MS;
}

/** Test seam. */
export function _resetFastEmitLedgerForTest(): void {
	emitted.clear();
}

/** Entry count — for tests asserting the bound holds. */
export function fastEmitLedgerSize(): number {
	return emitted.size;
}
