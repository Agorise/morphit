/**
 * Morphit indexer — when the stricter consensus rules take effect.
 *
 * Every indexer must reach the same verdict on the same op. A fix that only
 * removes nondeterminism (a wall-clock read, a node-local price) applies to
 * every block, history included: before it, nodes already disagreed. A rule
 * that REJECTS something the old code accepted applies only to ops in blocks
 * whose TIMESTAMP is at or after CONSENSUS_V2_ACTIVATION_TIME, so history keeps
 * the verdicts every node already recorded.
 *
 * The block timestamp is chain data: the live poller, a backfill, a fast-sync
 * replay and every re-check job read the same value for the same block, so
 * they all apply the same rule. Never compare against the wall clock, and never
 * against a block number (the height at a given date cannot be known ahead).
 *
 * Every indexer must run a release that knows this time before the chain
 * reaches it; the release notes announce it.
 *
 * The one place this time is defined. Every rule gated on it calls
 * consensusV2Active with the block's own timestamp.
 */
export const CONSENSUS_V2_ACTIVATION_TIME = '2026-11-01T00:00:00Z';

const ACTIVATION_MS = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);

/** True when ops in a block with timestamp `blockTime` are judged by the
 *  stricter rules. An unreadable time is never taken as activated. */
export function consensusV2Active(blockTime: Date): boolean {
	const t = blockTime.getTime();
	return Number.isFinite(t) && t >= ACTIVATION_MS;
}
