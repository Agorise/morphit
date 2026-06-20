/**
 * Morphit frontend — account-balance fetcher (cp295).
 *
 * Fetches an account's balance + the dynamic global properties needed
 * to render BLURT POWER / mana / APR FROM THE INDEXER, same-origin,
 * instead of talking to a Blurt RPC node directly from the browser.
 *
 * Privacy (priority #1): a browser fetching balances straight from
 * public RPC nodes leaks the user's IP and which account they're
 * viewing to third-party operators Morphit doesn't control. Routing
 * the read through the operator's own indexer means those third
 * parties only ever see the indexer's server-side request, and the
 * only party who sees the lookup is the operator the user already
 * chose. It also sidesteps browser CORS entirely (the request is
 * same-origin), so a balance load no longer depends on whichever
 * subset of RPC nodes happens to have correct CORS headers today.
 *
 * Pure-ish + testable: `indexerOrigin` and `fetchImpl` are arguments,
 * mirroring $lib/orders/listingFee.ts.
 */

import type { AccountBalanceResponse } from '@morphit/indexer-client';

/** Result of an account-balance fetch. */
export type AccountBalanceFetchResult =
	| { kind: 'ok'; data: AccountBalanceResponse }
	| { kind: 'not_found' }
	| { kind: 'error'; message: string };

/** Fetch `GET /v1/account/:account/balance` from the indexer. */
export async function fetchAccountBalance(
	indexerOrigin: string,
	account: string,
	fetchImpl: typeof fetch = fetch,
	noCache = false
): Promise<AccountBalanceFetchResult> {
	let res: Response;
	try {
		const cb = noCache ? `?_cb=${Date.now()}` : '';
		res = await fetchImpl(
			`${indexerOrigin}/v1/account/${encodeURIComponent(account)}/balance${cb}`,
			{ method: 'GET', headers: { accept: 'application/json' }, cache: noCache ? 'no-store' : 'default' }
		);
	} catch (err) {
		return {
			kind: 'error',
			message: err instanceof Error ? err.message : String(err)
		};
	}

	if (res.status === 404) {
		return { kind: 'not_found' };
	}
	if (!res.ok) {
		return {
			kind: 'error',
			message: `indexer /v1/account/${account}/balance returned ${res.status}`
		};
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: 'error', message: 'indexer returned non-JSON' };
	}

	// Narrow defensively before handing the data to the balance math.
	const b = body as Partial<AccountBalanceResponse>;
	if (
		!b.account ||
		typeof b.account.balance !== 'string' ||
		typeof b.account.vesting_shares !== 'string' ||
		!b.dgp ||
		typeof b.dgp.total_vesting_fund_blurt !== 'string' ||
		typeof b.dgp.total_vesting_shares !== 'string' ||
		typeof b.dgp.current_supply !== 'string' ||
		typeof b.dgp.head_block_number !== 'number'
	) {
		return { kind: 'error', message: 'indexer returned unexpected shape' };
	}

	return { kind: 'ok', data: b as AccountBalanceResponse };
}
