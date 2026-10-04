/**
 * The relay must never write a signup client's network (IP prefix) — or the
 * accounts created from it — to its log.
 *
 * The sequential-pattern rejection used to log the client's /24 (/64) together
 * with the account names already created from that prefix. journald keeps
 * that on disk, so a seized box or a curious operator could link real
 * accounts to a residential address range.
 *
 * Drives the REAL CreateEndpoint and SequentialDetector with a capturing log
 * sink and a socket peer, exactly as a direct visitor arrives.
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { CreateEndpoint } from '../src/api/create.ts';
import { SequentialDetector } from '../src/policy/sequentialDetector.ts';
import { setLogSink } from '../src/log/index.ts';
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
const op = (name: string) => ({
	op: {
		new_account_name: name,
		owner: auth(PK_OWNER),
		active: auth(PK_ACTIVE),
		posting: auth(PK_POSTING),
		memo_key: PK_MEMO,
		json_metadata: ''
	}
});

const blurt = {
	getAccount: vi.fn(async () => null),
	getChainProperties: vi.fn(async () => ({
		account_creation_fee: '100.000 BLURT',
		maximum_block_size: 65536
	})),
	broadcastAccountCreate: vi.fn(async () => ({
		id: 'abc123',
		block_num: 1,
		trx_num: 0,
		expired: false
	})),
	broadcastTransfer: vi.fn(async () => ({
		id: 'dust123',
		block_num: 2,
		trx_num: 0,
		expired: false
	}))
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

function endpointWith(detector: SequentialDetector, inviteTokens: InviteTokenService): Hono {
	const app = new Hono();
	new CreateEndpoint(
		config,
		blurt,
		new Limiter(1000, 3_600_000),
		new Limiter(10_000, 86_400_000),
		0,
		health,
		true,
		new GlobalDailyCeiling(10_000),
		inviteTokens,
		null,
		'off',
		4,
		detector
	).register(app);
	return app;
}

async function signup(app: Hono, inviteTokens: InviteTokenService, peer: string, name: string) {
	const res = await app.request(
		'/v1/account/create',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				invite_token: inviteTokens.issue(canonicalBucketKey(peer)).token,
				...op(name)
			})
		},
		{ incoming: { socket: { remoteAddress: peer } } }
	);
	return { status: res.status, body: (await res.json()) as { code?: string } };
}

describe('signup logging carries no client network and no account names', () => {
	it('three sequential signups from one /24: the third is refused, and no log line holds the prefix or a name', async () => {
		const lines: string[] = [];
		const restore = setLogSink((r) => lines.push(JSON.stringify(r)));
		try {
			const detector = new SequentialDetector({
				windowMs: 3_600_000,
				thresholdCount: 2,
				minPrefixLen: 3
			});
			const invites = new InviteTokenService({ ttlMs: 600_000 });
			const app = endpointWith(detector, invites);
			const names = ['carolwallet1', 'carolwallet2', 'carolwallet3'];
			const results = [];
			for (const n of names) results.push(await signup(app, invites, '203.0.113.77', n));
			expect(results.map((r) => r.status)).toEqual([200, 200, 429]);
			expect(results[2]!.body.code).toBe('name_sequential_pattern');
			// The refusal itself was logged (so operators can count them) …
			expect(lines.some((l) => l.includes('sequential_pattern_rejected'))).toBe(true);
			// … but nothing anywhere names the client's network or the accounts.
			const all = lines.join('\n');
			expect(all).not.toContain('203.0.113');
			for (const n of names) expect(all).not.toContain(n);
			// Nor does the detector's memory hold the plain prefix.
			expect(JSON.stringify(detector)).not.toContain('203.0.113');
		} finally {
			restore();
		}
	});

	it('the keyed bucket still separates networks: the same names from another /24 are not refused', async () => {
		const detector = new SequentialDetector({
			windowMs: 3_600_000,
			thresholdCount: 2,
			minPrefixLen: 3
		});
		const invites = new InviteTokenService({ ttlMs: 600_000 });
		const app = endpointWith(detector, invites);
		expect((await signup(app, invites, '203.0.113.77', 'danawallet1')).status).toBe(200);
		expect((await signup(app, invites, '203.0.113.78', 'danawallet2')).status).toBe(200);
		expect((await signup(app, invites, '198.51.100.9', 'danawallet3')).status).toBe(200);
		expect((await signup(app, invites, '203.0.113.79', 'danawallet4')).status).toBe(429);
	});
});
