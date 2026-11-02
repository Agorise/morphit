/**
 * Signing in with a posting key: a network hiccup is retried, never answered.
 *
 * @classx could not sign in on vigilante (2026-11-01): the check of the pasted
 * key against the chain failed for a moment on the server side, and the page
 * showed a red "Something unexpected went wrong… it wasn't your key or
 * password". The next try worked. These cases drive the checker with lookups
 * that fail the way the indexer does (a 502 or 429 from /v1/account/:name/keys,
 * the reverse lookup unavailable) and require the real answer to come back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountAuthorities } from '$crypto/postingVerify';
import type { AccountsByKeyLookup } from '$blurt/accountByKey';
import {
	accountToSignIn,
	checkPostingKeyOnce,
	checkPostingKeyPatiently,
	KeyCheckUnavailable,
	keyCheckRetryDelay,
	lookupAccountsPatiently,
	type PostingKeyCheckDeps
} from './postingKeyCheck';

const POSTING = 'BLT51aKTvkWm1C8y23z451TEA7VGoEXaFNxXhsJs4oZ95kMeJmrsN';
const ACTIVE = 'BLT7TLDgManBDHqMnq3cMY8nEAJCJXaNqLfA7fGbwHcxHi6Ku9PL4';
const OWNER = 'BLT5ahj8GK7WZXcAF4G5JoSG3yz6z21xxbNyU4TbUXFpWzDG518bY';
const MEMO = 'BLT5yYoSayuF9fCN5MsrvXGeszxtdZze7WrYJLfcJyenZQ2eHkgT5';
const OTHER = 'BLT6LLegbAgLAy28EHrffBVuANFWcFgmqRMW13wBmTExqFE9SCkg4';

const auth = (k: string) => ({ weight_threshold: 1, account_auths: [], key_auths: [[k, 1]] });
const CLASSX: AccountAuthorities = {
	owner: auth(OWNER),
	active: auth(ACTIVE),
	posting: auth(POSTING),
	memo_key: MEMO
} as unknown as AccountAuthorities;

/** A lookup / keys read that fails `n` times the way the indexer does, then answers. */
function flaky<T>(n: number, answer: T, failure: () => Promise<T>): () => Promise<T> {
	let calls = 0;
	return () => (++calls <= n ? failure() : Promise.resolve(answer));
}
const unavailable = (): Promise<AccountsByKeyLookup> => Promise.resolve({ kind: 'unavailable' });
const keys502 = (): Promise<AccountAuthorities | null> =>
	Promise.reject(new Error('indexer /v1/account/:name/keys returned 502'));

function deps(over: Partial<PostingKeyCheckDeps> = {}): PostingKeyCheckDeps {
	return {
		lookup: async () => ({ kind: 'found', accounts: ['classx'] }),
		fetchKeys: async () => CLASSX,
		...over
	};
}

const noWait = async (): Promise<void> => {};

describe('one check: real answers', () => {
	it('the posting key of the account it resolves to is fine', async () => {
		expect(await checkPostingKeyOnce(POSTING, null, deps())).toEqual({
			kind: 'ok',
			account: 'classx'
		});
	});
	it.each([
		[ACTIVE, 'active'],
		[OWNER, 'owner'],
		[MEMO, 'memo']
	] as const)('another kind of key is named as such (%s → %s)', async (key, role) => {
		expect(await checkPostingKeyOnce(key, null, deps())).toEqual({
			kind: 'wrong-role',
			account: 'classx',
			foundIn: role
		});
	});
	it('a typed name that does not hold the key', async () => {
		expect(await checkPostingKeyOnce(OTHER, 'classx', deps())).toEqual({
			kind: 'not-on-account',
			account: 'classx'
		});
	});
	it('a typed name the chain does not have (a definite 404)', async () => {
		expect(
			await checkPostingKeyOnce(POSTING, 'nosuch', deps({ fetchKeys: async () => null }))
		).toEqual({
			kind: 'account-not-found',
			account: 'nosuch'
		});
	});
	it('no account (or several) found for the key: the name has to be typed', async () => {
		for (const accounts of [[], ['a', 'b']]) {
			expect(
				await checkPostingKeyOnce(
					POSTING,
					null,
					deps({ lookup: async () => ({ kind: 'found', accounts }) })
				)
			).toEqual({ kind: 'needs-account-name' });
		}
	});
	it('a typed name skips the reverse lookup', async () => {
		const lookup = vi.fn(unavailable);
		expect(await checkPostingKeyOnce(POSTING, 'classx', deps({ lookup }))).toEqual({
			kind: 'ok',
			account: 'classx'
		});
		expect(lookup).not.toHaveBeenCalled();
	});
});

describe('one check: the network side not answering is not an answer', () => {
	it('the reverse lookup unavailable', async () => {
		await expect(
			checkPostingKeyOnce(POSTING, null, deps({ lookup: unavailable }))
		).rejects.toBeInstanceOf(KeyCheckUnavailable);
	});
	it.each(['returned 502', 'returned 429', 'timed out', 'unexpected shape for account keys'])(
		'the keys read failing (%s)',
		async (why) => {
			await expect(
				checkPostingKeyOnce(
					POSTING,
					null,
					deps({ fetchKeys: () => Promise.reject(new Error(why)) })
				)
			).rejects.toBeInstanceOf(KeyCheckUnavailable);
		}
	);
});

describe('patient check: retried until there is an answer', () => {
	it('@classx on vigilante: the keys read fails twice with a 502, then signs in', async () => {
		const onWaiting = vi.fn();
		const r = await checkPostingKeyPatiently(POSTING, null, {
			deps: deps({ fetchKeys: flaky(2, CLASSX, keys502) }),
			signal: new AbortController().signal,
			onWaiting,
			wait: noWait
		});
		expect(r).toEqual({ kind: 'ok', account: 'classx' });
		expect(onWaiting.mock.calls).toEqual([
			[1, 'keys'],
			[2, 'keys']
		]);
	});
	it('the reverse lookup unavailable three times, then found', async () => {
		const r = await checkPostingKeyPatiently(POSTING, null, {
			deps: deps({
				lookup: flaky(
					3,
					{ kind: 'found', accounts: ['classx'] } as AccountsByKeyLookup,
					unavailable
				)
			}),
			signal: new AbortController().signal,
			wait: noWait
		});
		expect(r).toEqual({ kind: 'ok', account: 'classx' });
	});
	it('a real answer after hiccups is still that answer (an Active key stays refused)', async () => {
		const r = await checkPostingKeyPatiently(ACTIVE, null, {
			deps: deps({ fetchKeys: flaky(1, CLASSX, keys502) }),
			signal: new AbortController().signal,
			wait: noWait
		});
		expect(r).toEqual({ kind: 'wrong-role', account: 'classx', foundIn: 'active' });
	});
	it('it keeps going for as long as the page asks, and stops when it stops asking', async () => {
		const ctrl = new AbortController();
		let tries = 0;
		const p = checkPostingKeyPatiently(POSTING, null, {
			deps: deps({
				fetchKeys: () => {
					if (++tries === 40) ctrl.abort(new Error('page left'));
					return keys502();
				}
			}),
			signal: ctrl.signal,
			wait: noWait
		});
		await expect(p).rejects.toThrow('page left');
		expect(tries).toBe(40);
	});
	it('a bug is not retried forever: anything but "unavailable" comes straight out', async () => {
		const p = checkPostingKeyPatiently(POSTING, null, {
			deps: deps({ lookup: () => Promise.reject(new TypeError('boom')) }),
			signal: new AbortController().signal,
			wait: noWait
		});
		await expect(p).rejects.toThrow('boom');
	});
	it('waits grow, then settle at 30 s', () => {
		expect([1, 2, 3, 4, 5, 6, 50].map(keyCheckRetryDelay)).toEqual([
			1500, 4000, 8000, 15000, 30000, 30000, 30000
		]);
	});
	describe('the real wait (fake clock)', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('waits 1.5 s before the second try, then signs in', async () => {
			const fetchKeys = vi.fn(flaky(1, CLASSX, keys502));
			const p = checkPostingKeyPatiently(POSTING, null, {
				deps: deps({ fetchKeys }),
				signal: new AbortController().signal
			});
			await vi.advanceTimersByTimeAsync(1_499);
			expect(fetchKeys).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(await p).toEqual({ kind: 'ok', account: 'classx' });
			expect(fetchKeys).toHaveBeenCalledTimes(2);
		});

		it('is cut short by leaving the page, and leaves no timer behind', async () => {
			const ctrl = new AbortController();
			const p = checkPostingKeyPatiently(POSTING, null, {
				deps: deps({ fetchKeys: keys502 }),
				signal: ctrl.signal
			});
			const settled = expect(p).rejects.toThrow('left');
			await vi.advanceTimersByTimeAsync(50);
			expect(vi.getTimerCount()).toBe(1);
			ctrl.abort(new Error('left'));
			await settled;
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});

/** A promise the test settles by hand: a request still on its way. */
function pending<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
} {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('Stop (or leaving) while a request is on its way', () => {
	it('ends the check at once, and the answer that lands afterwards is dropped', async () => {
		const ctrl = new AbortController();
		const inFlight = pending<AccountAuthorities | null>();
		let settled: unknown = 'unsettled';
		const p = checkPostingKeyPatiently(POSTING, null, {
			deps: deps({ fetchKeys: () => inFlight.promise }),
			signal: ctrl.signal,
			wait: noWait
		}).then(
			(v) => (settled = v),
			(e: unknown) => (settled = e)
		);
		await Promise.resolve();
		ctrl.abort(new Error('stopped'));
		await Promise.resolve();
		await Promise.resolve();
		// Rejected before the request ended …
		expect(settled).toEqual(new Error('stopped'));
		// … and an 'ok' arriving later does not turn into a sign-in.
		inFlight.resolve(CLASSX);
		await p;
		expect(settled).toEqual(new Error('stopped'));
	});
	it('a failure that lands after Stop is not reported as a wait', async () => {
		const ctrl = new AbortController();
		const inFlight = pending<AccountAuthorities | null>();
		const onWaiting = vi.fn();
		const p = checkPostingKeyPatiently(POSTING, null, {
			deps: deps({ fetchKeys: () => inFlight.promise }),
			signal: ctrl.signal,
			onWaiting,
			wait: noWait
		});
		const settled = expect(p).rejects.toThrow('stopped');
		await Promise.resolve();
		ctrl.abort(new Error('stopped'));
		inFlight.reject(new Error('returned 502'));
		await settled;
		expect(onWaiting).not.toHaveBeenCalled();
	});
	it('the seed / keyfile name lookup too', async () => {
		const ctrl = new AbortController();
		const inFlight = pending<AccountsByKeyLookup>();
		const p = lookupAccountsPatiently([POSTING], {
			lookup: () => inFlight.promise,
			signal: ctrl.signal,
			wait: noWait
		});
		const settled = expect(p).rejects.toThrow('stopped');
		await Promise.resolve();
		ctrl.abort(new Error('stopped'));
		await settled;
		inFlight.resolve({ kind: 'found', accounts: ['classx'] });
	});
	it('the page is told WHICH read did not answer (the lookup → it offers the Username field)', async () => {
		const onWaiting = vi.fn();
		await checkPostingKeyPatiently(POSTING, null, {
			deps: deps({
				lookup: flaky(
					2,
					{ kind: 'found', accounts: ['classx'] } as AccountsByKeyLookup,
					unavailable
				)
			}),
			signal: new AbortController().signal,
			onWaiting,
			wait: noWait
		});
		expect(onWaiting.mock.calls).toEqual([
			[1, 'lookup'],
			[2, 'lookup']
		]);
	});
});

describe('accountToSignIn: the one gate before a key is kept', () => {
	const run = { pub: POSTING, account: null };
	it('an ok for this key signs in as the account it names', () => {
		expect(accountToSignIn({ kind: 'ok', account: 'classx' }, run, run)).toBe('classx');
	});
	it.each([
		{ kind: 'wrong-role', account: 'classx', foundIn: 'active' },
		{ kind: 'wrong-role', account: 'classx', foundIn: 'owner' },
		{ kind: 'wrong-role', account: 'classx', foundIn: 'memo' },
		{ kind: 'not-on-account', account: 'classx' },
		{ kind: 'account-not-found', account: 'classx' },
		{ kind: 'needs-account-name' }
	] as const)('never for any other verdict (%o)', (verdict) => {
		expect(accountToSignIn(verdict, run, run)).toBeNull();
	});
	it('never for a check of another key', () => {
		expect(
			accountToSignIn({ kind: 'ok', account: 'classx' }, { pub: OTHER, account: null }, run)
		).toBeNull();
	});
	it('never for a check of another typed name, or none', () => {
		const typed = { pub: POSTING, account: 'classx' };
		expect(
			accountToSignIn({ kind: 'ok', account: 'classx' }, { pub: POSTING, account: 'other' }, typed)
		).toBeNull();
		expect(accountToSignIn({ kind: 'ok', account: 'classx' }, run, typed)).toBeNull();
		expect(accountToSignIn({ kind: 'ok', account: 'other' }, typed, typed)).toBeNull();
		expect(accountToSignIn({ kind: 'ok', account: 'classx' }, typed, typed)).toBe('classx');
	});
});

describe('the account-name lookup of a seed or keyfile import, retried', () => {
	it('unavailable twice, then the account', async () => {
		const lookup = vi.fn(
			flaky(2, { kind: 'found', accounts: ['classx'] } as AccountsByKeyLookup, unavailable)
		);
		const r = await lookupAccountsPatiently([POSTING], {
			lookup,
			signal: new AbortController().signal,
			wait: noWait
		});
		expect(r).toEqual(['classx']);
		expect(lookup).toHaveBeenCalledTimes(3);
	});
	it('"none found" is an answer, returned at once', async () => {
		const lookup = vi.fn(
			async (): Promise<AccountsByKeyLookup> => ({ kind: 'found', accounts: [] })
		);
		expect(
			await lookupAccountsPatiently([POSTING], {
				lookup,
				signal: new AbortController().signal,
				wait: noWait
			})
		).toEqual([]);
		expect(lookup).toHaveBeenCalledTimes(1);
	});
	it('stops when the page stops asking', async () => {
		const ctrl = new AbortController();
		let n = 0;
		const p = lookupAccountsPatiently([POSTING], {
			lookup: () => {
				if (++n === 5) ctrl.abort(new Error('left'));
				return unavailable();
			},
			signal: ctrl.signal,
			wait: noWait
		});
		await expect(p).rejects.toThrow('left');
	});
});
