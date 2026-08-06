/**
 * Test-only Postgres client mock.
 *
 * Handlers only call `.query()` on the PoolClient they receive,
 * and they don't care about transaction state (the dispatcher
 * owns SAVEPOINT management). So a minimal mock that records
 * queries and returns canned results is sufficient for unit
 * tests.
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

export function makeMockClient(expectations: readonly QueryExpectation[] = []): MockClient {
	const queries: RecordedQuery[] = [];
	let expectationIdx = 0;

	const client = {
		query: async (
			text: string,
			params?: readonly unknown[]
		): Promise<{ rows: readonly unknown[]; rowCount: number }> => {
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
