/**
 * A request the relay rejects without doing any work must not use up the
 * per-client signup burst.
 *
 * Every Tor/I2P visitor reaches the relay from the same address (the local
 * nginx), so they all share ONE burst bucket (5/hour by default). The burst
 * slot was taken before the body was even parsed: five junk requests from one
 * hidden visitor locked every other hidden visitor out of signups for an
 * hour. Now only a well-formed request with a valid name and keys — one that
 * can lead to chain reads and spending — takes a slot.
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { CreateEndpoint } from '../src/api/create.ts';
import { Limiter } from '../src/middleware/ratelimit.ts';
import { GlobalDailyCeiling } from '../src/policy/globalDailyCeiling.ts';
import { InviteTokenService } from '../src/policy/inviteToken.ts';
import { canonicalBucketKey } from '../src/middleware/ip.ts';
import type { BlurtClient } from '../src/blurt/client.ts';
import type { HealthService } from '../src/api/health.ts';
import type { UnlockedConfig } from '../src/config/index.ts';

const PK_OWNER = 'BLT6tQ3TvXC7QEmhn6N5B8uypLvSq87hRTqo6dXLPQa1VF6rL2rWj';
const PK_ACTIVE = 'BLT5BfHvSM53aV8QgMCsS44orWkw22FYLw5f7NuyGgAL5Pn4iJWRx';
const PK_POSTING = 'BLT8BbEtQPBhJqpYcRwSgxaSemixJrW39jqNCM1r1kbiqX121447F';
const PK_MEMO = 'BLT5z8xHvq83VJyxgzu6ADEyP8yJCHbmSrCD2JBYNuKwyumcv7f1f';
const auth = (k: string) => ({ weight_threshold: 1, account_auths: [], key_auths: [[k, 1]] });
const op = (name: string, owner = PK_OWNER) => ({
	op: {
		new_account_name: name,
		owner: auth(owner),
		active: auth(PK_ACTIVE),
		posting: auth(PK_POSTING),
		memo_key: PK_MEMO,
		json_metadata: ''
	}
});

// Every hidden visitor arrives from the local nginx: one shared address.
const SHARED = '127.0.0.1';

function endpoint(): { app: Hono; invites: InviteTokenService } {
	const blurt = {
		getAccount: vi.fn(async () => null),
		getChainProperties: vi.fn(async () => ({
			account_creation_fee: '100.000 BLURT',
			maximum_block_size: 65536
		})),
		broadcastAccountCreate: vi.fn(async () => ({
			id: 'abc',
			block_num: 1,
			trx_num: 0,
			expired: false
		})),
		broadcastTransfer: vi.fn(async () => ({ id: 'dust', block_num: 2, trx_num: 0, expired: false }))
	} as unknown as BlurtClient;
	const health = {
		canAcceptCreation: () => true,
		creationsRemaining: () => 100
	} as unknown as HealthService;
	const config = {
		relayAccount: 'morphit-relay',
		relayActiveKeyWif: '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe',
		accountCreationFeeBlurt: 100
	} as unknown as UnlockedConfig;
	const invites = new InviteTokenService({ ttlMs: 600_000 });
	const app = new Hono();
	new CreateEndpoint(
		config,
		blurt,
		new Limiter(5, 3_600_000), // the default 5/hour burst
		new Limiter(10_000, 86_400_000),
		0,
		health,
		true,
		new GlobalDailyCeiling(10_000),
		invites,
		null,
		'off',
		4,
		null
	).register(app);
	return { app, invites };
}

async function post(app: Hono, body: string): Promise<{ status: number; code?: string }> {
	const res = await app.request(
		'/v1/account/create',
		{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
		{ incoming: { socket: { remoteAddress: SHARED } } }
	);
	return {
		status: res.status,
		code: ((await res.json().catch(() => ({}))) as { code?: string }).code
	};
}

describe('the signup burst is not burned by requests the relay rejects outright', () => {
	it('after 6 junk requests from one hidden visitor, another hidden visitor can still sign up', async () => {
		const { app, invites } = endpoint();
		const token = () => invites.issue(canonicalBucketKey(SHARED)).token;
		const junk = [
			'not json',
			'{}',
			JSON.stringify({ invite_token: token(), op: { new_account_name: 'x' } }),
			JSON.stringify({ invite_token: token(), ...op('UPPER-case!') }),
			JSON.stringify({ invite_token: token(), ...op('ab') }),
			JSON.stringify({ invite_token: token(), ...op('goodname-one', 'BLTnotakey') })
		];
		for (const b of junk) {
			const r = await post(app, b);
			expect(r.status, `junk ${b.slice(0, 40)}`).toBe(400);
		}
		const real = await post(app, JSON.stringify({ invite_token: token(), ...op('realvisitor1') }));
		expect(real.code).not.toBe('rate_limited');
		expect(real.status).toBe(200);
	});

	it('well-formed requests still use the burst (5 per hour per client)', async () => {
		const { app, invites } = endpoint();
		const token = () => invites.issue(canonicalBucketKey(SHARED)).token;
		const codes: Array<string | undefined> = [];
		for (let i = 0; i < 6; i++)
			codes.push(
				(await post(app, JSON.stringify({ invite_token: token(), ...op(`burstname${i}x`) }))).code
			);
		expect(codes[5]).toBe('rate_limited');
	});
});
