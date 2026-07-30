/**
 * Morphit frontend — account-history fetcher (cp296).
 *
 * Fetches ONE page of an account's chain history FROM THE INDEXER,
 * same-origin, instead of paging Blurt `get_account_history` straight
 * from a public RPC node in the browser.
 *
 * Privacy (priority #1): a browser reading account history straight from
 * public RPC nodes leaks the user's IP and exactly whose history they're
 * viewing to third-party operators Morphit doesn't control. Routing the
 * read through the operator's own indexer means those third parties only
 * ever see the indexer's server-side request, and the only party who
 * sees the lookup is the operator the user already chose. It also
 * sidesteps browser CORS entirely (the request is same-origin).
 *
 * Thin by design — mirrors $lib/blurt/accountBalance.ts. The caller
 * keeps its own pagination / window / cap logic and just calls this once
 * per page. `indexerOrigin` and `fetchImpl` are arguments for testability.
 */

import type { AccountHistoryEntry, AccountHistoryResponse } from '@morphit/indexer-client';

/** Result of a one-page account-history fetch. */
export type AccountHistoryFetchResult =
	| { kind: 'ok'; entries: readonly AccountHistoryEntry[] }
	| { kind: 'error'; message: string };

/**
 * Fetch one page of `GET /v1/account/:account/history` from the indexer.
 *
 * @param from  -1 for the most recent page, else a sequence number ≥ 0
 *              to page backward from (oldest-seen − 1).
 * @param limit page size (1..10000); the indexer clamps near the start
 *              of history.
 */
export async function fetchAccountHistory(
	indexerOrigin: string,
	account: string,
	from: number,
	limit: number,
	fetchImpl: typeof fetch = fetch,
	noCache = false
): Promise<AccountHistoryFetchResult> {
	let res: Response;
	try {
		const cb = noCache ? `&_cb=${Date.now()}` : '';
		res = await fetchImpl(
			`${indexerOrigin}/v1/account/${encodeURIComponent(account)}/history?from=${from}&limit=${limit}${cb}`,
			{ method: 'GET', headers: { accept: 'application/json' }, cache: noCache ? 'no-store' : 'default' }
		);
	} catch (err) {
		return {
			kind: 'error',
			message: err instanceof Error ? err.message : String(err)
		};
	}

	if (!res.ok) {
		return {
			kind: 'error',
			message: `indexer /v1/account/${account}/history returned ${res.status}`
		};
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: 'error', message: 'indexer returned non-JSON' };
	}

	const b = body as Partial<AccountHistoryResponse>;
	if (!Array.isArray(b.entries)) {
		return { kind: 'error', message: 'indexer returned unexpected shape' };
	}

	return { kind: 'ok', entries: b.entries as readonly AccountHistoryEntry[] };
}
