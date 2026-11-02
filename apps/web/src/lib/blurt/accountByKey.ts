/**
 * accountByKey — reverse public-key → account-name lookup.
 *
 * A Blurt seed phrase deterministically derives a user's owner / active /
 * posting / memo keypairs, but it does NOT encode the account NAME (the
 * name is chosen at account creation and lives only on-chain). To spare a
 * seed-importing user from typing their account name, we ask the operator's
 * indexer which account(s) reference their derived PUBLIC keys. Server-side
 * that endpoint unions TWO sources: the chain's
 * `condenser_api.get_key_references` AND the indexer's own
 * `accounts.posting_pubkey` index. The second catches PRE-FORK / genesis
 * accounts — Blurt's `account_by_key` plugin only indexes keys set by a
 * post-fork op, so a Steem-era account that never re-set its posting key
 * returns [] from the chain even though the key is a valid current authority.
 * Any such account that has touched Morphit still resolves from the DB, so
 * the user skips the manual-name fallback. Either way, login then forward-
 * verifies the key against the resolved account's on-chain authority.
 *
 * Privacy (priority #1): the lookup is relayed through the operator's OWN
 * indexer (same-origin `POST /v1/chain/key-references`), NOT a direct
 * browser→third-party-RPC call. A direct call would leak the importing
 * user's IP and the exact moment they restore their account — a high-value
 * deanonymization point (IP ↔ account at login). Routed same-origin, third
 * parties see only the indexer's request; the browser opens no cross-origin
 * RPC connection. This is the read sibling of the broadcast proxy and
 * the account-keys proxy. Public keys are already on-chain, so the
 * lookup reveals nothing new — it only moves WHO asks the chain.
 *
 * DELIBERATELY no direct-RPC fallback: when the same-origin proxy is
 * unreachable, the IP is never leaked to a third-party node instead.
 * lookupAccountsByPublicKeys says so — `unavailable` (unreachable proxy,
 * non-OK status such as the indexer's 502 when the chain could not be asked,
 * bad shape) is not "no account has this key" —, and the sign-in pages ask
 * again by themselves (postingKeyCheck.ts) instead of telling the person their
 * account could not be found. resolveAccountsByPublicKeys keeps the old
 * contract (empty on any failure) for callers that only use the answer as a
 * hint and check the key against the chain anyway (accountBinding).
 */
import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
import { fetchWithTimeout } from '$net/fetchWithTimeout';
import { chainCallTimeoutMs } from '$net/transportBudget';

/** Same-origin indexer proxy for the reverse key→account lookup. */
function indexerUrl(path: string): URL {
	return new URL(path, resolveOrigin(MORPHIT_INDEXER_ORIGIN));
}

/** The reverse lookup's answer: the accounts found (possibly none), or
 *  `unavailable` when the indexer could not ask the chain (or could not be
 *  reached) — which is NOT "no account has this key" and must never be shown
 *  to someone as if it were. */
export type AccountsByKeyLookup =
	| { readonly kind: 'found'; readonly accounts: string[] }
	| { readonly kind: 'unavailable' };

/**
 * Resolve the set of account names that reference ANY of the given
 * BLT-format public keys. Returns a de-duplicated list (empty on no match
 * or any error — callers treat empty as "couldn't auto-resolve").
 */
export async function resolveAccountsByPublicKeys(pubKeysBLT: string[]): Promise<string[]> {
	const r = await lookupAccountsByPublicKeys(pubKeysBLT);
	return r.kind === 'found' ? r.accounts : [];
}

/** Like resolveAccountsByPublicKeys, but says when it could not find out. */
export async function lookupAccountsByPublicKeys(
	pubKeysBLT: string[]
): Promise<AccountsByKeyLookup> {
	const keys = pubKeysBLT.filter((k): k is string => typeof k === 'string' && k.length > 0);
	if (keys.length === 0) return { kind: 'found', accounts: [] };
	try {
		const res = await fetchWithTimeout(
			indexerUrl('/v1/chain/key-references'),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ keys })
			},
			// Chain-backed through the indexer; see broadcastTransport.
			chainCallTimeoutMs(15_000)
		);
		if (!res.ok) {
			return { kind: 'unavailable' }; // proxy unreachable / chain not answering
		}
		const body = (await res.json()) as { accounts?: unknown };
		if (!Array.isArray(body.accounts)) return { kind: 'unavailable' };
		const accounts = new Set<string>();
		for (const name of body.accounts) {
			if (typeof name === 'string' && name.length > 0) accounts.add(name);
		}
		return { kind: 'found', accounts: [...accounts] };
	} catch {
		return { kind: 'unavailable' };
	}
}
