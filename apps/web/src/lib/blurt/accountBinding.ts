/**
 * Morphit — which account is this signature actually FOR?
 *
 * ─── The bug this exists to kill ──────────────────────────────────────
 *
 * The Blurt account name lived in ONE localStorage key, shared by every tab on
 * the origin, with a `storage` listener that rewrote it whenever any other tab
 * signed in. The keys, meanwhile, live per-session in memory.
 *
 * So: sign in as @kentest2 in tab A, then @kentest3 in tab B. Tab A still holds
 * kentest2's posting key — but now reads "kentest3" as its account. Every
 * broadcast it makes declares `required_posting_auths: ["kentest3"]` and signs
 * with kentest2's key. The chain answers:
 *
 *     Missing Posting Authority kentest3
 *
 * …and dumps kentest3's three authorities at the user. cp440 tried to fix this
 * by deleting the pre-flight check, on the theory that the check itself was the
 * difference between a working chat broadcast and a failing profile one. It
 * wasn't: chat messages travel over the relay, not the chain, so they never
 * exercised this path at all. Deleting the check only replaced a clear error
 * with a chain dump.
 *
 * ─── The rule ─────────────────────────────────────────────────────────
 *
 * A signature is made by a KEY. The account it may speak for is therefore a
 * property of that key, not of a browser-wide string that any other tab can
 * overwrite. So we resolve the account FROM the posting key, and treat storage
 * as nothing more than a hint used to disambiguate a key that controls several
 * accounts.
 *
 * If the key controls nothing we can see, we refuse to broadcast and say so in
 * words, rather than letting the chain reject it in a language nobody reads.
 */

import { formatPublicKeyBLT } from '$crypto/keygen';
import { resolveAccountsByPublicKeys } from './accountByKey';
import { fetchAccountKeys } from './accountKeys';
import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
import type { LiveIdentity } from '$crypto/identity-core';

export class AccountBindingError extends Error {
	readonly kind: 'no_account_for_key' | 'ambiguous' | 'lookup_failed' | 'key_not_in_authority';
	/** The accounts the key DOES control, when we know them. */
	readonly candidates: readonly string[];

	constructor(
		kind: 'no_account_for_key' | 'ambiguous' | 'lookup_failed' | 'key_not_in_authority',
		message: string,
		candidates: readonly string[] = []
	) {
		super(message);
		this.name = 'AccountBindingError';
		this.kind = kind;
		this.candidates = candidates;
	}
}

/** Memoized per posting pubkey — a broadcast already does network I/O, but we
 *  needn't repeat the lookup for every op in a session. */
const cache = new Map<string, string>();

/** Injectable for tests; the real one hits the indexer's same-origin proxy. */
export type AccountResolver = (pubKeysBLT: string[]) => Promise<string[]>;

/**
 * The account this live session is entitled to sign for.
 *
 * @param live  the unlocked session (its posting key is the authority).
 * @param hint  the account name from storage, used ONLY to disambiguate when
 *              one key controls several accounts. Never trusted on its own.
 */
export async function resolveBroadcastAccount(
	live: LiveIdentity,
	hint: string | null,
	resolver: AccountResolver = resolveAccountsByPublicKeys
): Promise<string> {
	const pub = await formatPublicKeyBLT(live.posting.publicKey);

	const cached = cache.get(pub);
	if (cached) return cached;

	let accounts: string[];
	try {
		accounts = await resolver([pub]);
	} catch (e) {
		throw new AccountBindingError(
			'lookup_failed',
			`Could not check which account this key controls: ${e instanceof Error ? e.message : 'unknown error'}`
		);
	}

	if (accounts.length === 0) {
		throw new AccountBindingError(
			'no_account_for_key',
			'The key in this session does not control any account on the blockchain.'
		);
	}

	if (accounts.length === 1) {
		const only = accounts[0]!;
		cache.set(pub, only);
		return only;
	}

	// Several accounts share this posting key. The hint decides — but only if it
	// is one of them.
	if (hint && accounts.includes(hint)) {
		cache.set(pub, hint);
		return hint;
	}
	throw new AccountBindingError(
		'ambiguous',
		'This key controls more than one account; sign out and back in to choose one.',
		accounts
	);
}

/**
 * The last line of defence, and the only one that does not trust a lookup.
 *
 * Before a posting-auth op leaves the browser, prove that the account we are
 * about to DECLARE really lists the key we are about to SIGN with. The chain
 * performs exactly this check and answers "Missing Posting Authority <account>"
 * with a dump of three authorities — which is not something a person setting
 * their display name should ever have to read.
 *
 * Cheap: one same-origin request, memoized per (account, key). Silent on
 * success. On failure it names the account, so the person knows which tab they
 * are actually signed in to.
 */
const authorityCache = new Set<string>();

export async function assertKeyControlsAccount(
	live: LiveIdentity,
	account: string,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	const pub = await formatPublicKeyBLT(live.posting.publicKey);
	const memo = `${account}\u0000${pub}`;
	if (authorityCache.has(memo)) return;

	const authorities = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), account, fetchImpl);
	if (!authorities) {
		// Can't check ⇒ don't guess, and don't silently broadcast either. The
		// resolver above already proved the key maps to this account, so a
		// transient indexer blip here is not grounds to refuse.
		return;
	}
	const listed = authorities.posting.key_auths.some(([k]) => k === pub);
	if (!listed) {
		throw new AccountBindingError(
			'key_not_in_authority',
			`The key in this session is not a posting key of @${account}.`,
			[account]
		);
	}
	authorityCache.add(memo);
}

/** Test seam / sign-out hook: forget every memoized binding. */
export function clearAccountBindingCache(): void {
	cache.clear();
	authorityCache.clear();
}
