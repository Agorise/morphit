/**
 * Morphit frontend — account public-key fetcher.
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
import { chainCallTimeoutMs } from '$net/transportBudget';

/** Clearnet budget for the lookup. The indexer answers it with a chain read,
 *  so a hidden-transport instance gets the chain floor (chainCallTimeoutMs). */
export const ACCOUNT_KEYS_TIMEOUT_MS = 15_000;

/** Fetch `GET /v1/account/:name/keys` from the indexer.
 *  @returns the public authorities, or `null` if the account doesn't exist.
 *  @throws on network error, non-404 failure, or no complete answer within
 *  the budget (a stalled server must not hold a chat send or a login open). */
/** Overlapping lookups of the same account share one request (opening a
 *  conversation reads the peer's keys for its header and for sending at
 *  once; on Tor/I2P each is a slow round trip). Per fetch implementation. */
const inFlight = new WeakMap<typeof fetch, Map<string, Promise<AccountAuthorities | null>>>();

/** A found account's keys are reused for this long (v1.21.17). Posting an order
 *  read them twice within seconds — the active-key window checks the key typed
 *  against them, then the broadcast checks the session key — and each read is
 *  a trusted read across several RPC operators on the indexer. The second one
 *  timing out was the "…/keys timed out" error seen while posting. A key
 *  rotation is applied by the chain within blocks anyway; this is the same
 *  order of staleness. Only answers that found the account are kept. */
export const ACCOUNT_KEYS_REUSE_MS = 15_000;
const recent = new WeakMap<
	typeof fetch,
	Map<string, { readonly at: number; readonly value: AccountAuthorities }>
>();

export async function fetchAccountKeys(
	indexerOrigin: string,
	account: string,
	fetchImpl: typeof fetch = fetch
): Promise<AccountAuthorities | null> {
	const url = new URL(`/v1/account/${encodeURIComponent(account)}/keys`, indexerOrigin).href;
	const kept = recent.get(fetchImpl)?.get(url);
	if (kept !== undefined && Date.now() - kept.at < ACCOUNT_KEYS_REUSE_MS) return kept.value;
	const m = inFlight.get(fetchImpl) ?? new Map<string, Promise<AccountAuthorities | null>>();
	inFlight.set(fetchImpl, m);
	const pending = m.get(url);
	if (pending !== undefined) return pending;
	const p = fetchAccountKeysOnce(indexerOrigin, account, fetchImpl)
		.then((value) => {
			const r = recent.get(fetchImpl) ?? new Map();
			recent.set(fetchImpl, r);
			if (value !== null) r.set(url, { at: Date.now(), value });
			else r.delete(url);
			return value;
		})
		.finally(() => {
			m.delete(url);
		});
	m.set(url, p);
	return p;
}

/** For a step that moves money or signs (posting an order, unlocking the
 *  active key): one failed lookup — the indexer's 502 when its RPC operators
 *  could not agree in time, or the browser's own timeout — is asked again once
 *  before the person is shown an error. The indexer rests a node that failed,
 *  so the second read usually goes to others. "No such account" (null) is an
 *  answer and is not retried. */
export async function fetchAccountKeysForSigning(
	indexerOrigin: string,
	account: string,
	fetchImpl: typeof fetch = fetch
): Promise<AccountAuthorities | null> {
	try {
		return await fetchAccountKeys(indexerOrigin, account, fetchImpl);
	} catch {
		return fetchAccountKeys(indexerOrigin, account, fetchImpl);
	}
}

async function fetchAccountKeysOnce(
	indexerOrigin: string,
	account: string,
	fetchImpl: typeof fetch
): Promise<AccountAuthorities | null> {
	// Compose with `new URL` (NOT string concatenation) per $net/config:
	// a root-absolute path replaces any path/trailing slash on the base, so
	// the request can never double-slash regardless of how `indexerOrigin`
	// is shaped. (the old `${indexerOrigin}/v1/…` form produced
	// `//v1/…` when indexerOrigin carried a trailing slash, which a
	// merge_slashes-off proxy 404s, making a valid account read "invalid".)
	const url = new URL(`/v1/account/${encodeURIComponent(account)}/keys`, indexerOrigin);
	const ac = new AbortController();
	const timer = setTimeout(
		() => ac.abort(new Error('indexer /v1/account/:name/keys timed out')),
		chainCallTimeoutMs(ACCOUNT_KEYS_TIMEOUT_MS, url.href)
	);
	let body: Partial<AccountKeysResponse>;
	try {
		// The fetch AND the body read race the timer: a server that sends its
		// headers and then stalls is as stuck as one that never answers.
		const aborted = new Promise<never>((_, reject) => {
			ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true });
		});
		const res = await Promise.race([
			fetchImpl(url, {
				method: 'GET',
				headers: { accept: 'application/json' },
				signal: ac.signal
			}),
			aborted
		]);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`indexer /v1/account/:name/keys returned ${res.status}`);
		body = (await Promise.race([res.json(), aborted])) as Partial<AccountKeysResponse>;
	} finally {
		clearTimeout(timer);
	}
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
