/**
 * Morphit indexer — no silent gap in the v1.23.5 repeat-trade rule.
 *
 * From CONSENSUS_V3_ACTIVATION_TIME the review and partner-name gate stops
 * treating a proven repeat trade as ring evidence (signalVerdicts.ts), so it
 * accepts reviews and partner names an older version refuses. A node that
 * applied blocks stamped at or after that time with an older version — it
 * upgraded late, or was rolled back for a while — refused some of them, and
 * nothing re-reads those ops: it would disagree with every other node from
 * then on, without saying so.
 *
 * So `indexer_state.repeat_trades_through_block` follows `last_applied_block`
 * while this version (or a later one) applies blocks (poller markApplied), and
 * at start, before any block is applied:
 *   - in step: nothing to do;
 *   - NULL or behind: some blocks were applied by an older version. If the
 *     last of them is older than the activation time, the old and the new rule
 *     agreed on all of them: the marker is set and the node goes on. Otherwise
 *     the node stops, saying how to get those blocks re-read by this version.
 * Judged by the chain's block time, never this machine's clock. The same shape
 * as waiverEvidenceGuard.ts (v1.21.17).
 */
import { CONSENSUS_V3_ACTIVATION_TIME } from '$indexer/consensusActivation';

export class RepeatTradesGapError extends Error {
	constructor(fromBlock: number | null, lastApplied: number) {
		super(
			`blocks ${fromBlock === null ? 'up to' : `${fromBlock} to`} ${lastApplied} were applied by a Morphit ` +
				`version older than v1.23.5, and some of them are stamped at or after ` +
				`${CONSENSUS_V3_ACTIVATION_TIME}. Those versions refuse reviews of repeat trades that every other ` +
				`node accepts, so this node does not start. Two ways on, on this server: ` +
				`(1) \`sudo morphit-ops fast-sync\` — this helps only if the newest snapshot was made by Morphit ` +
				`v1.23.5 or later; fast-sync shows which version made it before it changes anything. ` +
				`(2) Rebuild the indexer's database from the chain (OPERATIONS.md §46, "The reset"): ` +
				`slow, but it always works, because this version applies the rule as it replays.`
		);
		this.name = 'RepeatTradesGapError';
	}
}

/** The one method used (pg Pool, Database, a test stub). */
interface Db {
	query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** 'ok' (in step), 'set' (the marker was filled in), or throws
 *  RepeatTradesGapError. `blockTime` reads a block's time from the chain
 *  (throws when it cannot: the caller tries again). */
export async function checkRepeatTradesRule(
	db: Db,
	blockTime: (n: number) => Promise<Date>
): Promise<'ok' | 'set'> {
	const r = await db.query(
		`SELECT last_applied_block::text AS last, repeat_trades_through_block::text AS through
		   FROM indexer_state WHERE id = 1`
	);
	const row = r.rows[0] as { last: string; through: string | null } | undefined;
	if (row === undefined) return 'ok';
	const last = Number(row.last);
	const through = row.through === null ? null : Number(row.through);
	if (through !== null && through >= last) return 'ok';
	if (last > 0) {
		const t = await blockTime(last);
		if (t.getTime() >= Date.parse(CONSENSUS_V3_ACTIVATION_TIME)) {
			throw new RepeatTradesGapError(through === null ? null : through + 1, last);
		}
	}
	// Blocks before the activation time applied by an older version (or none
	// yet by this one): in step from here, and the review-ring flags those
	// blocks raised are looked at again at this start (reviewSignalsRedo.ts).
	await db.query(
		`UPDATE indexer_state
		    SET repeat_trades_through_block = last_applied_block, review_signals_redo_due = TRUE
		  WHERE id = 1`
	);
	return 'set';
}
