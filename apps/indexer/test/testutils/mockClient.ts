/**
 * Test-only Postgres client mock.
 *
 * Handlers only call `.query()` on the PoolClient they receive. Some
 * wrap a statement whose failure they tolerate in its own savepoint
 * (SAVEPOINT / RELEASE / ROLLBACK TO — see indexer/savepoint.ts); that
 * is transaction plumbing, not the handler's SQL, so a savepoint
 * statement the next expectation does not ask for is acknowledged and
 * not recorded. A test that cares lists it as an expectation.
 */

import type pg from 'pg';

export interface RecordedQuery {
	readonly text: string;
	readonly params: readonly unknown[];
}

export interface QueryExpectation {
	/** Substring that must appear in the query text, or a regex. */
	readonly match: string | RegExp;
	/** Rows to return. */
	readonly rows?: readonly unknown[];
	/** Row-count override. Defaults to rows.length. */
	readonly rowCount?: number;
	/** If set, the `query()` call throws this instead of returning. */
	readonly throwError?: unknown;
}

export interface MockClient {
	readonly client: pg.PoolClient;
	readonly queries: readonly RecordedQuery[];
}

const SAVEPOINT_STATEMENT = /^\s*(?:SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/i;

export function makeMockClient(expectations: readonly QueryExpectation[] = []): MockClient {
	const queries: RecordedQuery[] = [];
	let expectationIdx = 0;

	const client = {
		query: async (
			text: string,
			params?: readonly unknown[]
		): Promise<{ rows: readonly unknown[]; rowCount: number }> => {
			const exp0 = expectations[expectationIdx];
			const wanted =
				exp0 !== undefined &&
				(typeof exp0.match === 'string' ? text.includes(exp0.match) : exp0.match.test(text));
			if (!wanted && SAVEPOINT_STATEMENT.test(text)) return { rows: [], rowCount: 0 };
			queries.push({ text, params: params ?? [] });

			// Find the next matching expectation. Expectations are
			// consumed in order — this catches unintended query
			// reordering immediately.
			if (expectationIdx >= expectations.length) {
				return { rows: [], rowCount: 0 };
			}
			const exp = expectations[expectationIdx]!;
			const matches =
				typeof exp.match === 'string' ? text.includes(exp.match) : exp.match.test(text);
			if (!matches) {
				throw new Error(
					`Unexpected query at position ${expectationIdx}: ` +
						`${text.slice(0, 120)} — expected match ${exp.match}`
				);
			}
			expectationIdx++;
			if (exp.throwError) throw exp.throwError;
			const rows = exp.rows ?? [];
			const rowCount = exp.rowCount ?? rows.length;
			return { rows, rowCount };
		}
	} as unknown as pg.PoolClient;

	return {
		client,
		get queries() {
			return queries;
		}
	};
}
