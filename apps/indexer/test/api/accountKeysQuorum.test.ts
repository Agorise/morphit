/**
 * The keys a first message is encrypted to come from two agreeing operators
 * (v1.21.14 full chat audit, S-M9).
 *
 * /v1/account/:account/keys is what a browser encrypts a first message to when
 * the peer's chat key is not pinned yet (the posting-key envelope). It was one
 * hedged answer, the fastest node's, so a single hostile pool node could name
 * its own key and read that message.
 */
import { describe, expect, it } from 'vitest';

import { accountKeysRoute } from '$api/accountKeys';
import type { ChainAccount } from '$blurt/client';

const auth = (key: string) => ({ weight_threshold: 1, account_auths: [], key_auths: [[key, 1]] });
const account = (posting: string, memo = 'BLTmemo'): ChainAccount =>
	({
		name: 'alice',
		owner: auth('BLTowner'),
		active: auth('BLTactive'),
		posting: auth(posting),
		memo_key: memo
	}) as unknown as ChainAccount;

/** A pool whose operators answer as given; the read is decided the way the
 *  real quorum read decides it: two or more agreeing, by the caller's key. */
function pool(answers: (ChainAccount | undefined)[]) {
	return {
		getAccount: async () => {
			throw new Error('a single answer must not be used');
		},
		getAccountsAgreed: async (
			names: readonly string[],
			agreeOn: (a: ChainAccount | undefined) => string
		) => {
			const groups = new Map<string, (ChainAccount | undefined)[]>();
			for (const a of answers) {
				const k = agreeOn(a);
				groups.set(k, [...(groups.get(k) ?? []), a]);
			}
			const best = [...groups.values()].sort((x, y) => y.length - x.length)[0] ?? [];
			if (best.length < 2) return null;
			const m = new Map<string, ChainAccount>();
			if (best[0] !== undefined) m.set(names[0]!, best[0]);
			return m;
		}
	};
}

const ask = async (answers: (ChainAccount | undefined)[]) => {
	const res = await accountKeysRoute(pool(answers) as never).request('/alice/keys');
	return {
		status: res.status,
		posting: ((await res.json()) as { account?: { posting: { key_auths: [string, number][] } } })
			.account?.posting.key_auths[0]?.[0]
	};
};

describe('account keys: two operators must agree (S-M9)', () => {
	it('one operator naming another posting key is outvoted', async () => {
		expect(await ask([account('BLTreal'), account('BLTevil'), account('BLTreal')])).toEqual({
			status: 200,
			posting: 'BLTreal'
		});
	});

	it('no two operators agreeing is not an answer', async () => {
		expect((await ask([account('BLTreal'), account('BLTevil')])).status).toBe(502);
	});

	it('operators that differ only in the memo key do not agree', async () => {
		expect((await ask([account('BLTreal', 'BLTm1'), account('BLTreal', 'BLTm2')])).status).toBe(
			502
		);
	});

	it('the order keys are listed in does not matter', async () => {
		const a = account('BLTreal');
		const b = {
			...a,
			posting: { weight_threshold: 1, account_auths: [], key_auths: [['BLTreal', 1]] }
		} as unknown as ChainAccount;
		expect((await ask([a, b])).status).toBe(200);
	});

	it('an account two operators agree does not exist is a 404', async () => {
		expect((await ask([undefined, undefined, account('BLTevil')])).status).toBe(404);
	});
});

describe('a key operators agreed on here also serves the fast path (review finding 1)', () => {
	it('the agreed signing posting key is handed on; nothing on a 502', async () => {
		const told: [string, string][] = [];
		const route = (answers: (ChainAccount | undefined)[]) =>
			accountKeysRoute(pool(answers) as never, {
				onAgreedPostingKey: (a, k) => told.push([a, k])
			});
		await route([account('BLTreal'), account('BLTreal')]).request('/alice/keys');
		expect(told).toEqual([['alice', 'BLTreal']]);
		await route([account('BLTreal'), account('BLTevil')]).request('/alice/keys');
		expect(told).toHaveLength(1);
	});

	it('…so an account with no row needs no chain read of its own for its ticket', async () => {
		const { notePostingKeyFromQuorum, postingKeyLookupFromDb, _resetKeyRefreshForTest } =
			await import('$indexer/chatFastFederation');
		_resetKeyRefreshForTest();
		let reads = 0;
		const lookup = postingKeyLookupFromDb(
			{ query: async () => ({ rows: [], rowCount: 0 }) } as never,
			async () => {
				reads++;
				return 'BLTfromchain';
			}
		);
		await accountKeysRoute(pool([account('BLTreal'), account('BLTreal')]) as never, {
			onAgreedPostingKey: notePostingKeyFromQuorum
		}).request('/alice/keys');
		expect(await lookup('alice', { budget: 'ticket' })).toBe('BLTreal');
		expect(reads).toBe(0);
	});
});
