/**
 * Morphit frontend — account public-key fetcher (cp298).
 *
 * Fetches an account's PUBLIC key authorities (owner / active / posting +
 * memo public key) FROM THE INDEXER, same-origin, instead of calling
 * Blurt `get_accounts` straight from a public RPC node in the browser.
 *
 * Privacy (priority #1): a direct RPC lookup at login / key-import leaks a
 * deanonymizing fact — "this IP is logging into / verifying account Y" —
 * to third-party operators Morphit doesn't control. Routing it through
 * the operator's own indexer means only the trusted operator sees which
 * account is being checked, and the browser opens no cross-origin RPC
 * connection.
 *
 * Non-custodial is untouched: the WIF the user enters never leaves the
 * browser. This returns only PUBLIC keys; the private→public derivation
 * and the `verifyPostingKey` comparison both run client-side.
 *
 * Semantics MATCH the old `BlurtClient.getAccount` so callers are a drop-
 * in swap: returns the authorities on success, `null` when the account
 * does not exist on chain (404), and THROWS on network/upstream failure
 * (so existing try/catch graceful-degradation paths behave identically —
 * a failed lookup must not falsely assert "invalid", and login can still
 * proceed since the actual auth is the user's client-side signing key).
 */

import type { AccountAuthorities } from '$crypto/postingVerify';
import type { AccountKeysResponse } from '@morphit/indexer-client';

/** Fetch `GET /v1/account/:name/keys` from the indexer.
 *  @returns the public authorities, or `null` if the account doesn't exist.
 *  @throws on network error or non-404 failure. */
export async function fetchAccountKeys(
	indexerOrigin: string,
	account: string,
	fetchImpl: typeof fetch = fetch
): Promise<AccountAuthorities | null> {
	const res = await fetchImpl(`${indexerOrigin}/v1/account/${encodeURIComponent(account)}/keys`, {
		method: 'GET',
		headers: { accept: 'application/json' }
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`indexer /v1/account/:name/keys returned ${res.status}`);

	const body = (await res.json()) as Partial<AccountKeysResponse>;
	const a = body.account;
	if (
		!a ||
		typeof a !== 'object' ||
		typeof a.memo_key !== 'string' ||
		!a.owner ||
		!a.active ||
		!a.posting
	) {
		throw new Error('indexer returned unexpected shape for account keys');
	}
	return {
		owner: a.owner,
		active: a.active,
		posting: a.posting,
		memo_key: a.memo_key
	};
}
