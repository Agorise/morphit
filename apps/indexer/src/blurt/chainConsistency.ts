/**
 * Morphit indexer — chain-consistency cross-check (the RPC trust layer).
 *
 * Tor/I2P hide WHERE we read from, not WHETHER what we read is true. A hidden
 * (or clearnet) RPC node we don't control can lie about the chain — serve a
 * forged block, a stale head, a fork. Racing endpoints for latency does nothing
 * about that on its own; the defence is to CROSS-CHECK: ask several independent
 * endpoints for the SAME block height and require a quorum to agree on that
 * block's canonical identity before we trust it.
 *
 * This module is the pure decision logic (keying + interpretation); the actual
 * fan-out is `EndpointPool.quorumCall` (which already existed, unused until now).
 * Kept pure + dependency-free so the security-critical comparison can be
 * exhaustively unit-tested without a pool or a network.
 */

import type { BlockHeader } from './client';
import type { QuorumCallResult } from '@morphit/rpc-pool';

/** The identity two honest nodes on the same chain MUST agree on for a given
 *  height. `block_id` is the canonical block hash — deterministic from the
 *  block's contents, so a forged/forked block at the same height yields a
 *  different id and simply won't join the quorum. We fall back to a composite of
 *  the other identity fields when a node omits `block_id` (older/oddball API),
 *  so a node that returns everything-but-the-id still cross-checks rather than
 *  being silently trusted. An empty key means "no usable identity" — treated as
 *  a non-answer by the pool (it never matches another key). */
export function blockConsistencyKey(block: BlockHeader): string {
	const id = (block.block_id ?? '').trim().toLowerCase();
	if (id.length > 0) return `id:${id}`;
	const prev = (block.previous ?? '').trim().toLowerCase();
	const merkle = (block.transaction_merkle_root ?? '').trim().toLowerCase();
	const witness = (block.witness ?? '').trim().toLowerCase();
	const ts = (block.timestamp ?? '').trim();
	// Require at least the previous-hash; witness+merkle+timestamp alone are too
	// weak to key on (a lying node could copy them without the real chain).
	if (prev.length === 0) return '';
	return `c:${prev}|${merkle}|${witness}|${ts}`;
}

export interface ChainConsistencyResult {
	/** true only when a quorum of endpoints returned the SAME block identity for
	 *  the checked height. false = disagreement (possible fork/lie) OR not enough
	 *  endpoints answered to reach the quorum. */
	readonly consistent: boolean;
	/** Why we got this verdict — for logs / the health surface. */
	readonly reason: 'quorum_agreed' | 'disagreement' | 'insufficient_responses' | 'no_endpoints';
	/** The agreed block identity key when consistent, else undefined. */
	readonly agreedKey: string | undefined;
	/** How many endpoints agreed on the winning key (the size of the largest
	 *  equivalence group the pool reported reaching, if any). */
	readonly agreeing: number;
	/** How many endpoints were contacted. */
	readonly contacted: number;
	/** How many endpoints were skipped because they were in cooldown. */
	readonly cooledDown: number;
	/** The quorum threshold that was required. */
	readonly required: number;
}

/** Turn a raw {@link QuorumCallResult} into a trust verdict. Pure + total.
 *
 *  - `quorum_met`        → consistent: the required number of endpoints agreed.
 *  - `all_responses_in`  → every contacted endpoint answered (or failed) but no
 *                          group reached the threshold. If ≥2 DISTINCT identity
 *                          keys came back, that's a genuine DISAGREEMENT (a node
 *                          served a different chain) — the loud case. If instead
 *                          simply too few endpoints answered (e.g. only one was
 *                          up), it's `insufficient_responses` — unproven, not
 *                          disproven; the caller shouldn't cry fork over it.
 *  - `no_endpoints`      → nothing to check (all in cooldown). */
export function interpretChainConsistency<T extends BlockHeader>(
	result: QuorumCallResult<T>,
	required: number,
	keyOf: (r: T) => string = blockConsistencyKey
): ChainConsistencyResult {
	const base = {
		agreedKey: result.agreedKey,
		contacted: result.contacted,
		cooledDown: result.cooledDown,
		required
	};
	if (result.kind === 'no_endpoints') {
		return { consistent: false, reason: 'no_endpoints', agreeing: 0, ...base };
	}
	if (result.kind === 'quorum_met') {
		const agreeing = result.responses.filter((r) => keyOf(r) === result.agreedKey).length;
		return { consistent: true, reason: 'quorum_agreed', agreeing, ...base };
	}
	// all_responses_in — decide disagreement vs. merely-too-few.
	const keys = result.responses.map(keyOf).filter((k) => k.length > 0);
	const distinct = new Set(keys);
	// Size of the largest agreeing group we did see (informational).
	const counts = new Map<string, number>();
	for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
	const largest = counts.size === 0 ? 0 : Math.max(...counts.values());
	if (distinct.size >= 2) {
		return { consistent: false, reason: 'disagreement', agreeing: largest, ...base };
	}
	return { consistent: false, reason: 'insufficient_responses', agreeing: largest, ...base };
}
