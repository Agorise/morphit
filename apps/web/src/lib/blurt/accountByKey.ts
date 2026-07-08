/**
 * accountByKey — reverse public-key → account-name lookup.
 *
 * A Blurt seed phrase deterministically derives a user's owner / active /
 * posting / memo keypairs, but it does NOT encode the account NAME (the
 * name is chosen at account creation and lives only on-chain). To spare a
 * seed-importing user from typing their account name, we ask the operator's
 * indexer which account(s) reference their derived PUBLIC keys. Server-side
 * that endpoint unions TWO sources (cp440): the chain's
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
 * RPC connection. This is the read sibling of the cp344 broadcast proxy and
 * the cp298 account-keys proxy. Public keys are already on-chain, so the
 * lookup reveals nothing new — it only moves WHO asks the chain.
 *
 * DELIBERATELY no direct-RPC fallback. Unlike a broadcast (which must
 * succeed), this is pure convenience: if the same-origin proxy is
 * unreachable, the right answer is to fall back to MANUAL account-name
 * entry (what the caller already does on an empty result), never to leak
 * the IP to a third-party node. Any failure — unreachable proxy, non-OK
 * status, bad shape, or a single key mapping to multiple accounts — returns
 * empty / unresolved, and the caller asks the user.
 */
import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
import { fetchWithTimeout } from '$net/fetchWithTimeout';

/** Same-origin indexer proxy for the reverse key→account lookup. */
function indexerUrl(path: string): URL {
	return new URL(path, resolveOrigin(MORPHIT_INDEXER_ORIGIN));
}

/**
 * Resolve the set of account names that reference ANY of the given
 * BLT-format public keys. Returns a de-duplicated list (empty on no match
 * or any error — callers treat empty as "couldn't auto-resolve").
 */
export async function resolveAccountsByPublicKeys(pubKeysBLT: string[]): Promise<string[]> {
	const keys = pubKeysBLT.filter((k): k is string => typeof k === 'string' && k.length > 0);
	if (keys.length === 0) return [];
	try {
		const res = await fetchWithTimeout(
			indexerUrl('/v1/chain/key-references'),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ keys })
			},
			15_000
		);
		if (!res.ok) {
			return []; // proxy unreachable / error ⇒ manual entry
		}
		const body = (await res.json()) as { accounts?: unknown };
		if (!Array.isArray(body.accounts)) return [];
		const accounts = new Set<string>();
		for (const name of body.accounts) {
			if (typeof name === 'string' && name.length > 0) accounts.add(name);
		}
		return [...accounts];
	} catch {
		return [];
	}
}
