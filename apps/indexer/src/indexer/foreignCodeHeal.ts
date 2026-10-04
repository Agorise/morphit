/**
 * Morphit indexer — boot-time check for database code Morphit never creates.
 *
 * Morphit's schema defines no function, trigger, rule or event trigger. A
 * fast-sync restore used to write to the restored database (the posting-key
 * reset) BEFORE dropping the code a hostile snapshot could carry, so a
 * trigger it brought ran on those writes and its effects — a relay payout
 * row, say — outlived the cleanup. The restore now drops foreign code first
 * and refuses dumps that define any; this check heals a node that restored
 * before that, and catches code that reached the database any other way.
 *
 * At every start: anything found in the indexer's own schema is dropped and
 * reported. If anything was found, every payout the relay has not sent yet is
 * HELD for the operator — moved past the relay's retry limit with a reason,
 * where `morphit-ops` lists failed broadcasts and can re-queue them — because
 * code that ran on this database may have queued some of them. Never throws:
 * a failure is logged and the indexer carries on.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '$db/pool';
import { dropRoutinesNotInSchema } from '$db/snapshotLocalState';
import { logger } from '$log';

const log = logger('foreign-code');

/** Far past any relay retry limit: the relay leaves the row alone and the
 *  operator's failed-broadcast list shows it. */
export const HELD_ERROR_COUNT = 1_000_000;

export const HELD_REASON =
	'held for review: database code Morphit does not create was found and removed at indexer start; ' +
	'it may have queued this payout';

export async function healForeignDatabaseCode(
	db: Pick<Database, 'query'>,
	schemaSql: string = readFileSync(
		resolve(dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'),
		'utf8'
	)
): Promise<{ dropped: readonly string[]; held: number }> {
	try {
		const dropped = await dropRoutinesNotInSchema(db, schemaSql, { currentSchemaOnly: true });
		if (dropped.length === 0) return { dropped, held: 0 };
		const held = await db.query(
			`UPDATE relay_pending_transfers
			    SET error_count = GREATEST(error_count, $1), last_error = $2, last_error_at = NOW()
			  WHERE broadcast_at IS NULL`,
			[HELD_ERROR_COUNT, HELD_REASON]
		);
		log.error('foreign_database_code_removed', {
			dropped: dropped.slice(0, 20).join('; '),
			count: dropped.length,
			payouts_held: held.rowCount ?? 0,
			action:
				'review the held payouts with morphit-ops (failed broadcasts) and re-queue the genuine ones'
		});
		return { dropped, held: held.rowCount ?? 0 };
	} catch (err) {
		log.error('foreign_database_code_check_failed', {}, err instanceof Error ? err : undefined);
		return { dropped: [], held: 0 };
	}
}
