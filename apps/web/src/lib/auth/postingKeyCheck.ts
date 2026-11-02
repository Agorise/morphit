/**
 * Signing in with a posting key: which account it belongs to, and whether it
 * really is that account's POSTING key — checked against the chain, patiently.
 *
 * Two reads reach the chain through the instance's own indexer: the reverse
 * lookup (which account references this public key) and the account's public
 * keys (to tell a posting key from an Active, Owner or Memo key). Either can
 * fail for a moment for reasons that have nothing to do with the person: the
 * indexer's RPC operators did not agree within its 11 s deadline (a 502), the
 * rate limit (429), a slow Tor circuit. That used to end sign-in with a red
 * "Something unexpected went wrong… it wasn't your key or password" (@classx on
 * vigilante, 2026-11-01; the next try worked) — or, for the reverse lookup, with
 * "we couldn't detect your account from this key" and a username box.
 *
 * Here a failure on the network side is never an answer. It is retried, quietly
 * and for as long as the page wants (the caller's AbortSignal), and only a real
 * answer comes back: the key is fine, it is the wrong kind of key, it is not on
 * the named account, or the name has to be typed. The page starts this as soon
 * as a key is pasted, so the check usually finishes while the person is still
 * typing their new password.
 *
 * Nobody is let in before the answer: it is what keeps an Active or Owner key
 * from being kept on the device as if it were the posting key.
 */

import type { AccountAuthorities } from '$crypto/postingVerify';
import { verifyPostingKey } from '$crypto/postingVerify';
import type { AccountsByKeyLookup } from '$blurt/accountByKey';

export type PostingKeyCheck =
	| { readonly kind: 'ok'; readonly account: string }
	| {
			readonly kind: 'wrong-role';
			readonly account: string;
			readonly foundIn: 'active' | 'owner' | 'memo';
	  }
	| { readonly kind: 'not-on-account'; readonly account: string }
	| { readonly kind: 'account-not-found'; readonly account: string }
	/** No account, or several, reference this key (a Steem-era account the
	 *  chain's index does not cover, typically): the name has to be typed. */
	| { readonly kind: 'needs-account-name' };

export interface PostingKeyCheckDeps {
	/** Reverse lookup: which accounts reference these public keys. */
	readonly lookup: (pubKeysBLT: string[]) => Promise<AccountsByKeyLookup>;
	/** The account's public keys; null = no such account (a definite 404);
	 *  throws when it could not find out. */
	readonly fetchKeys: (account: string) => Promise<AccountAuthorities | null>;
}

/** The chain could not be asked this time. Never shown as a verdict. */
export class KeyCheckUnavailable extends Error {
	constructor(readonly step: 'lookup' | 'keys') {
		super(`posting-key check: ${step} unavailable`);
		this.name = 'KeyCheckUnavailable';
	}
}

/** One attempt. Throws KeyCheckUnavailable when the network side did not answer. */
export async function checkPostingKeyOnce(
	pubKeyBLT: string,
	account: string | null,
	deps: PostingKeyCheckDeps
): Promise<PostingKeyCheck> {
	let name = account;
	if (name === null) {
		const found = await deps.lookup([pubKeyBLT]);
		if (found.kind === 'unavailable') throw new KeyCheckUnavailable('lookup');
		if (found.accounts.length !== 1) return { kind: 'needs-account-name' };
		name = found.accounts[0]!;
	}
	let keys: AccountAuthorities | null;
	try {
		keys = await deps.fetchKeys(name);
	} catch {
		throw new KeyCheckUnavailable('keys');
	}
	if (keys === null) return { kind: 'account-not-found', account: name };
	const v = verifyPostingKey(keys, pubKeyBLT);
	if (v.kind === 'ok') return { kind: 'ok', account: name };
	if (v.kind === 'wrong-role') return { kind: 'wrong-role', account: name, foundIn: v.foundIn };
	return { kind: 'not-on-account', account: name };
}

/**
 * The account to sign in as, or null: ONLY an 'ok' verdict for this exact key
 * (and the typed name, when one was typed) lets anyone in. The page asks this
 * right before it keeps the key, whatever messages it showed for the other
 * verdicts — so an Active, Owner or Memo key, or a key from another run, can
 * never be stored as the posting key because a branch was missed.
 */
export function accountToSignIn(
	verdict: PostingKeyCheck,
	checked: { readonly pub: string; readonly account: string | null },
	expected: { readonly pub: string; readonly account: string | null }
): string | null {
	if (verdict.kind !== 'ok') return null;
	if (checked.pub !== expected.pub || checked.account !== expected.account) return null;
	if (expected.account !== null && verdict.account !== expected.account) return null;
	return verdict.account;
}

/** Waits between attempts: quick at first (a 502 is usually gone on the next
 *  try, the indexer rests the node that failed), then every 30 s for as long as
 *  the page keeps asking. */
export const KEY_CHECK_RETRY_DELAYS_MS: readonly number[] = [1_500, 4_000, 8_000, 15_000, 30_000];

export function keyCheckRetryDelay(failures: number): number {
	const d = KEY_CHECK_RETRY_DELAYS_MS;
	return d[Math.min(Math.max(failures, 1), d.length) - 1]!;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
			return;
		}
		const t = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(t);
			reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('aborted', 'AbortError');
}

/** `p`, unless `signal` aborts first: then it rejects with the abort reason at
 *  once, and an answer that lands later is dropped. A request already on its
 *  way when the person presses Stop (or leaves) can take a while — 15 s on
 *  clearnet, longer over Tor — and its answer must not sign them in, or show
 *  a verdict, after they stopped. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	// The abort listener settles first whenever Stop came before the answer;
	// an answer that lands afterwards finds the promise already rejected.
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(abortReason(signal));
		signal.addEventListener('abort', onAbort, { once: true });
		p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}

/**
 * Check until there is an answer or `signal` aborts (then it rejects with the
 * abort reason, at once — also while a request is on its way). `onWaiting(failures,
 * step)` is told each time the network side did not answer, and which read did not
 * (the account lookup or the account's keys), before the next try — the page uses
 * it to show its calm "still checking" note instead of an error, and to offer the
 * Username field when it is the lookup that keeps failing.
 */
export async function checkPostingKeyPatiently(
	pubKeyBLT: string,
	account: string | null,
	opts: {
		readonly deps: PostingKeyCheckDeps;
		readonly signal: AbortSignal;
		readonly onWaiting?: (failures: number, step: KeyCheckUnavailable['step']) => void;
		readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
	}
): Promise<PostingKeyCheck> {
	const wait = opts.wait ?? sleep;
	for (let failures = 0; ; ) {
		if (opts.signal.aborted) throw abortReason(opts.signal);
		let step: KeyCheckUnavailable['step'];
		try {
			return await untilAborted(checkPostingKeyOnce(pubKeyBLT, account, opts.deps), opts.signal);
		} catch (e) {
			if (!(e instanceof KeyCheckUnavailable)) throw e;
			step = e.step;
		}
		failures++;
		opts.onWaiting?.(failures, step);
		await wait(keyCheckRetryDelay(failures), opts.signal);
	}
}

/**
 * The reverse lookup alone, asked until it answers or `signal` aborts: the
 * seed and keyfile imports use it to find the account name in the background
 * while the person is on the "remember me" screen. Before, one failure sent
 * them to type the name on the settings page.
 */
export async function lookupAccountsPatiently(
	pubKeysBLT: string[],
	opts: {
		readonly lookup: PostingKeyCheckDeps['lookup'];
		readonly signal: AbortSignal;
		readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
	}
): Promise<string[]> {
	const wait = opts.wait ?? sleep;
	for (let failures = 0; ; ) {
		if (opts.signal.aborted) throw abortReason(opts.signal);
		const r = await untilAborted(opts.lookup(pubKeysBLT), opts.signal);
		if (r.kind === 'found') return r.accounts;
		failures++;
		await wait(keyCheckRetryDelay(failures), opts.signal);
	}
}
