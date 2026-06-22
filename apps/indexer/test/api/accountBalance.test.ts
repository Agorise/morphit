/**
 * Unit test — GET /v1/account/:account/balance (cp295).
 *
 * Exercises the HTTP layer with a stubbed BlurtClient (the live RPC
 * round-trip is covered by the same proven blurt.getAccount path the
 * poller/scanners use and can't run in CI without a chain node). We
 * verify: the happy-path body shape + cache header, 404 for a missing
 * account, 400 for a malformed name, and 502 for both an RPC throw and
 * an incomplete upstream response.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { accountBalanceRoute } from '$api/accountBalance';
import type { BlurtClient, ChainAccount, DynamicGlobalProperties } from '$blurt/client';

const AUTH = { weight_threshold: 1, account_auths: [], key_auths: [] };

const FULL_ACCOUNT: ChainAccount = {
	name: 'alice',
	posting: AUTH,
	active: AUTH,
	owner: AUTH,
	memo_key: 'BLT1111111111111111111111111111111114T1Anm',
	balance: '42.500 BLURT',
	vesting_shares: '1000000.000000 VESTS',
	received_vesting_shares: '50000.000000 VESTS',
	delegated_vesting_shares: '20000.000000 VESTS',
	voting_manabar: { current_mana: '900000', last_update_time: 1_700_000_000 }
};

const FULL_DGP: DynamicGlobalProperties = {
	head_block_number: 12_345,
	last_irreversible_block_num: 12_300,
	time: '2026-06-19T00:00:00',
	total_vesting_fund_blurt: '1000000.000 BLURT',
	total_vesting_shares: '2000000.000000 VESTS',
	current_supply: '5000000.000 BLURT'
};

/** Mount the route with a partial BlurtClient stub. */
function mount(stub: Partial<BlurtClient>): Hono {
	const app = new Hono();
	app.route('/v1/account', accountBalanceRoute(stub as unknown as BlurtClient));
	return app;
}

type BalanceBody = {
	account: {
		name: string;
		balance: string;
		vesting_shares: string;
		received_vesting_shares: string;
		delegated_vesting_shares: string;
		voting_manabar: { current_mana: string; last_update_time: number } | null;
	};
	dgp: {
		head_block_number: number;
		current_supply: string;
		total_vesting_fund_blurt: string;
		total_vesting_shares: string;
	};
};

describe('GET /v1/account/:account/balance', () => {
	it('returns account + dgp for an existing account, with a public cache header', async () => {
		const app = mount({
			getAccount: async () => FULL_ACCOUNT,
			getDynamicGlobalProperties: async () => FULL_DGP
		});
		const res = await app.request('/v1/account/alice/balance');
		expect(res.status).toBe(200);
		const body = (await res.json()) as BalanceBody;
		expect(body.account.name).toBe('alice');
		expect(body.account.balance).toBe('42.500 BLURT');
		expect(body.account.vesting_shares).toBe('1000000.000000 VESTS');
		expect(body.account.received_vesting_shares).toBe('50000.000000 VESTS');
		expect(body.account.delegated_vesting_shares).toBe('20000.000000 VESTS');
		expect(body.account.voting_manabar?.current_mana).toBe('900000');
		expect(body.dgp.total_vesting_fund_blurt).toBe('1000000.000 BLURT');
		expect(body.dgp.total_vesting_shares).toBe('2000000.000000 VESTS');
		expect(body.dgp.current_supply).toBe('5000000.000 BLURT');
		expect(res.headers.get('cache-control')).toContain('public');
		expect(res.headers.get('cache-control')).toContain('max-age');
	});

	it('passes through a null voting_manabar without erroring', async () => {
		const app = mount({
			getAccount: async () => ({ ...FULL_ACCOUNT, voting_manabar: undefined }),
			getDynamicGlobalProperties: async () => FULL_DGP
		});
		const res = await app.request('/v1/account/alice/balance');
		expect(res.status).toBe(200);
		const body = (await res.json()) as BalanceBody;
		expect(body.account.voting_manabar).toBeNull();
	});

	it('defaults received/delegated vesting to zero when the node omits them', async () => {
		const app = mount({
			getAccount: async () => ({
				...FULL_ACCOUNT,
				received_vesting_shares: undefined,
				delegated_vesting_shares: undefined
			}),
			getDynamicGlobalProperties: async () => FULL_DGP
		});
		const res = await app.request('/v1/account/alice/balance');
		expect(res.status).toBe(200);
		const body = (await res.json()) as BalanceBody;
		expect(body.account.received_vesting_shares).toBe('0.000000 VESTS');
		expect(body.account.delegated_vesting_shares).toBe('0.000000 VESTS');
	});

	it('404s when the account does not exist on chain', async () => {
		const app = mount({
			getAccount: async () => null,
			getDynamicGlobalProperties: async () => FULL_DGP
		});
		const res = await app.request('/v1/account/ghost/balance');
		expect(res.status).toBe(404);
		expect(((await res.json()) as { code: string }).code).toBe('not_found');
	});

	it('400s on a malformed account name', async () => {
		const app = mount({
			getAccount: async () => null,
			getDynamicGlobalProperties: async () => FULL_DGP
		});
		const res = await app.request('/v1/account/Invalid_Name!/balance');
		expect(res.status).toBe(400);
		expect(((await res.json()) as { code: string }).code).toBe('bad_request');
	});

	it('502s (internal) when the RPC pool throws', async () => {
		const app = mount({
			getAccount: async () => {
				throw new Error('all endpoints failed');
			},
			getDynamicGlobalProperties: async () => FULL_DGP
		});
		const res = await app.request('/v1/account/alice/balance');
		expect(res.status).toBe(502);
		expect(((await res.json()) as { code: string }).code).toBe('internal');
	});

	it('502s when a node returns an account missing balance fields', async () => {
		const app = mount({
			// Account present but stripped of balance/vesting — a
			// misbehaving node. Must NOT emit a malformed 200 body.
			getAccount: async () =>
				({ name: 'alice', posting: AUTH, active: AUTH, owner: AUTH, memo_key: 'x' } as ChainAccount),
			getDynamicGlobalProperties: async () => FULL_DGP
		});
		const res = await app.request('/v1/account/alice/balance');
		expect(res.status).toBe(502);
	});

	it('502s when DGP is missing the vesting totals', async () => {
		const app = mount({
			getAccount: async () => FULL_ACCOUNT,
			getDynamicGlobalProperties: async () =>
				({
					head_block_number: 1,
					last_irreversible_block_num: 1,
					time: 't'
				} as DynamicGlobalProperties)
		});
		const res = await app.request('/v1/account/alice/balance');
		expect(res.status).toBe(502);
	});
});
