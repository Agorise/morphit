/**
 * What the relay's /v1/health tells an anonymous caller.
 *
 * The verbose block — live signup counts and headroom, the full RPC topology
 * with each node's state (a hidden node's own .onion/.b32.i2p endpoints among
 * them), the exact Node.js version, the relay balance and payment queue — was
 * ON by default and served to anyone who reached /relay/v1/health. It is now
 * served only to a LOCAL caller: X-Morphit-Local-Health: 1 and none of the
 * forwarding headers every public edge (nginx, BunkerWeb) adds — so only the
 * indexer's signup-anomaly probe and `morphit-ops health` get it.
 * MORPHIT_RELAY_VERBOSE_HEALTH=true remains an explicit operator opt-in to
 * publish it.
 *
 * Drives the REAL config loader and the REAL health route.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadConfig, type Config } from '../src/config/index.ts';
import { HealthService } from '../src/api/health.ts';
import { GlobalDailyCeiling } from '../src/policy/globalDailyCeiling.ts';
import type { BlurtClient } from '../src/blurt/client.ts';

const KEYS = [
	'MORPHIT_RELAY_ACCOUNT',
	'MORPHIT_RELAY_ACTIVE_KEY_FILE',
	'MORPHIT_RELAY_DATABASE_URL',
	'MORPHIT_RELAY_INVITE_HMAC_SECRET',
	'MORPHIT_RELAY_ALTCHA_HMAC_SECRET',
	'MORPHIT_RELAY_VERBOSE_HEALTH'
];
const saved: Record<string, string | undefined> = {};
let dir = '';

beforeEach(async () => {
	for (const k of KEYS) saved[k] = process.env[k];
	dir = mkdtempSync(join(tmpdir(), 'relay-health-exposure-'));
	const keyFile = join(dir, 'active.key');
	const { PrivateKey } = await import('@beblurt/dblurt');
	writeFileSync(keyFile, PrivateKey.fromSeed('relay-health-exposure-test').toString());
	chmodSync(keyFile, 0o400);
	process.env.MORPHIT_RELAY_ACCOUNT = 'morphit-relay';
	process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE = keyFile;
	process.env.MORPHIT_RELAY_DATABASE_URL =
		'postgres://relay:a-real-password-here@localhost:5432/morphit';
	process.env.MORPHIT_RELAY_INVITE_HMAC_SECRET = 'i'.repeat(64);
	process.env.MORPHIT_RELAY_ALTCHA_HMAC_SECRET = 'a'.repeat(64);
	delete process.env.MORPHIT_RELAY_VERBOSE_HEALTH;
});
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(dir, { recursive: true, force: true });
});

const blurt = {
	endpointSnapshot: () => [
		{
			url: `http://${'a'.repeat(56)}.onion:8091`,
			ewmaLatencyMs: 120,
			consecutiveFailures: 0,
			cooldownUntil: 0,
			lastSuccessAt: Date.now(),
			nextAllowedAt: 0
		}
	]
} as unknown as BlurtClient;

async function health(
	c: Config,
	headers: Record<string, string> = {}
): Promise<Record<string, unknown>> {
	const app = new Hono();
	const svc = new HealthService(c, blurt, process.hrtime.bigint());
	svc.setSignupContext({ ceiling: new GlobalDailyCeiling(50), signupEnabled: true });
	svc.register(app);
	const res = await app.request('/v1/health', { headers });
	return (await res.json()) as Record<string, unknown>;
}

const PUBLIC_KEYS = ['status', 'rpc_ok', 'hidden_only'];

describe('relay /v1/health exposure', () => {
	it('an anonymous caller gets status and coarse booleans only', async () => {
		const body = await health(loadConfig());
		expect(Object.keys(body).sort()).toEqual([...PUBLIC_KEYS].sort());
		expect(body.rpc_ok).toBe(true);
		expect(JSON.stringify(body)).not.toContain('.onion');
	});

	it('a header value other than 1 changes nothing', async () => {
		const body = await health(loadConfig(), { 'x-morphit-local-health': 'yes' });
		expect(Object.keys(body).sort()).toEqual([...PUBLIC_KEYS].sort());
	});

	it('a local caller with X-Morphit-Local-Health: 1 gets the operator block', async () => {
		const body = await health(loadConfig(), { 'x-morphit-local-health': '1' });
		expect(body).toHaveProperty('signup_stats');
		expect(body).toHaveProperty('rpc_endpoints');
		expect(body).toHaveProperty('node_version');
		expect(body.rpc_endpoints_healthy).toBe(1);
		expect(body.rpc_endpoints_total).toBe(1);
	});

	it('the local header arriving through a public edge (forwarding headers present) is ignored', async () => {
		const edges: Array<Record<string, string>> = [
			{ 'x-forwarded-for': '203.0.113.7' },
			{ 'x-real-ip': '203.0.113.7' },
			{ 'x-forwarded-proto': 'https' }
		];
		for (const edge of edges) {
			const body = await health(loadConfig(), { 'x-morphit-local-health': '1', ...edge });
			expect(Object.keys(body).sort()).toEqual([...PUBLIC_KEYS].sort());
		}
	});

	it('MORPHIT_RELAY_VERBOSE_HEALTH=true is an explicit opt-in to publish it', async () => {
		process.env.MORPHIT_RELAY_VERBOSE_HEALTH = 'true';
		const body = await health(loadConfig());
		expect(body).toHaveProperty('signup_stats');
	});
});
