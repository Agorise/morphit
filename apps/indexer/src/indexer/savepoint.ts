/**
 * Morphit indexer — run a few statements inside their own SAVEPOINT.
 *
 * A handler runs inside the block's transaction. When one of its statements
 * fails, Postgres marks the WHOLE transaction aborted: catching the JavaScript
 * error does not undo that, and every later statement fails with "current
 * transaction is aborted, commands ignored until end of transaction block".
 * So a handler that expects a statement may fail (a unique violation on an
 * idempotent insert, a best-effort notification) must run it here: on any
 * error the savepoint is rolled back, the transaction is usable again, and the
 * error is re-thrown for the caller to classify.
 *
 * It also catches a callee that swallows a database error itself: the RELEASE
 * then fails on the aborted transaction, the savepoint is rolled back, and that
 * error is what the caller sees.
 *
 * Savepoint names are fixed identifiers chosen by the caller, never data.
 */
import type pg from 'pg';

const SAVEPOINT_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export async function inSavepoint<T>(
	client: pg.PoolClient,
	name: string,
	fn: () => Promise<T>
): Promise<T> {
	if (!SAVEPOINT_NAME.test(name)) throw new Error(`inSavepoint: bad savepoint name ${name}`);
	await client.query(`SAVEPOINT ${name}`);
	let result: T;
	try {
		result = await fn();
		await client.query(`RELEASE SAVEPOINT ${name}`);
	} catch (err) {
		await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
		await client.query(`RELEASE SAVEPOINT ${name}`);
		throw err;
	}
	return result;
}

/** SQLSTATE 23505 — unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: unknown }).code === '23505'
	);
}
