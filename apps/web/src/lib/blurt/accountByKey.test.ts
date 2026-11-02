// @vitest-environment jsdom
/**
 * The reverse key → account lookup must tell "no account has this key" (a
 * 200 with an empty list) from "could not find out" (anything else). Before
 * v1.21.21 both came back as [], and the sign-in page told a person whose
 * indexer had a slow moment that it could not detect their account.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lookupAccountsByPublicKeys, resolveAccountsByPublicKeys } from './accountByKey';

const KEY = 'BLT51aKTvkWm1C8y23z451TEA7VGoEXaFNxXhsJs4oZ95kMeJmrsN';

function answer(status: number, body: unknown): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(typeof body === 'string' ? body : JSON.stringify(body), {
					status,
					headers: { 'content-type': 'application/json' }
				})
		)
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('lookupAccountsByPublicKeys', () => {
	it('the accounts found, de-duplicated', async () => {
		answer(200, { accounts: ['classx', 'classx', '', 7] });
		expect(await lookupAccountsByPublicKeys([KEY])).toEqual({
			kind: 'found',
			accounts: ['classx']
		});
	});

	it('an empty list is an answer: no account has this key', async () => {
		answer(200, { accounts: [] });
		expect(await lookupAccountsByPublicKeys([KEY])).toEqual({ kind: 'found', accounts: [] });
	});

	it.each([502, 503, 429, 500, 404])(
		'a %i is "could not find out", never "none"',
		async (status) => {
			answer(status, { error: { code: 'internal', message: 'could not reach the Blurt network' } });
			expect(await lookupAccountsByPublicKeys([KEY])).toEqual({ kind: 'unavailable' });
		}
	);

	it.each([
		['no accounts field', {}],
		['accounts not a list', { accounts: 'classx' }],
		['not JSON', '<html>gateway</html>']
	])('a bad answer (%s) is "could not find out"', async (_why, body) => {
		answer(200, body);
		expect(await lookupAccountsByPublicKeys([KEY])).toEqual({ kind: 'unavailable' });
	});

	it('the indexer out of reach is "could not find out"', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			})
		);
		expect(await lookupAccountsByPublicKeys([KEY])).toEqual({ kind: 'unavailable' });
	});

	it('no keys: nothing to ask, no account', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		expect(await lookupAccountsByPublicKeys(['', ''])).toEqual({ kind: 'found', accounts: [] });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('resolveAccountsByPublicKeys keeps its old contract (a hint only)', () => {
	it('empty on any failure, the accounts otherwise', async () => {
		answer(502, {});
		expect(await resolveAccountsByPublicKeys([KEY])).toEqual([]);
		answer(200, { accounts: ['classx'] });
		expect(await resolveAccountsByPublicKeys([KEY])).toEqual(['classx']);
	});
});
