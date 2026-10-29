/**
 * Morphit indexer — no silent gap in the first-trade evidence (v1.21.17).
 *
 * From the consensus activation time a review may cite a first-buy waiver
 * order once the partner's BLURT transfer is recorded (waiverTradeTransfers.ts).
 * Only this version records those transfers, as it applies each block. A node
 * that applied blocks stamped at or after the activation time WITHOUT recording
 * them — it upgraded late, or was rolled back to an older version for a while,
 * or restored a snapshot older than schema v70 that already reaches past the
 * activation time — would then refuse, for good, reviews every other node
 * accepts. Nothing else would show it.
 *
 * So `indexer_state.waiver_evidence_through_block` follows
 * `last_applied_block` while this version applies blocks (poller markApplied),
 * and at start, before any block is applied:
 *   - in step: nothing to do;
 *   - NULL or behind: some blocks were applied without recording. If the last
 *     of them is older than the activation time, none of them could hold
 *     evidence: the marker is set and the node goes on. Otherwise the node
 *     stops, saying to fast-sync from a snapshot made by this version.
 * Judged by the chain's block time, never this machine's clock.
 */
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';

export class WaiverEvidenceGapError extends Error {
	constructor(fromBlock: number | null, lastApplied: number) {
		super(
			`blocks ${fromBlock === null ? 'up to' : `${fromBlock} to`} ${lastApplied} were applied by a Morphit ` +
				`version that did not record first-trade evidence, and some of them are stamped at or after ` +
				`${CONSENSUS_V2_ACTIVATION_TIME}. This node would refuse reviews every other node accepts. ` +
				`Run \`sudo morphit-ops fast-sync\` (it restores a snapshot made by v1.21.17 or later), then start again.`
		);
		this.name = 'WaiverEvidenceGapError';
	}
}

/** The one method used (pg Pool, Database, a test stub). */
interface Db {
	query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** 'ok' (in step), 'set' (the marker was filled in), or throws
 *  WaiverEvidenceGapError. `blockTime` reads a block's time from the chain
 *  (throws when it cannot: the caller tries again). */
export async function checkWaiverEvidence(
	db: Db,
	blockTime: (n: number) => Promise<Date>
): Promise<'ok' | 'set'> {
	const r = await db.query(
		`SELECT last_applied_block::text AS last, waiver_evidence_through_block::text AS through
		   FROM indexer_state WHERE id = 1`
	);
	const row = r.rows[0] as { last: string; through: string | null } | undefined;
	if (row === undefined) return 'ok';
	const last = Number(row.last);
	const through = row.through === null ? null : Number(row.through);
	if (through !== null && through >= last) return 'ok';
	if (last > 0) {
		const t = await blockTime(last);
		if (t.getTime() >= Date.parse(CONSENSUS_V2_ACTIVATION_TIME)) {
			throw new WaiverEvidenceGapError(through === null ? null : through + 1, last);
		}
	}
	await db.query(
		`UPDATE indexer_state SET waiver_evidence_through_block = last_applied_block WHERE id = 1`
	);
	return 'set';
}
