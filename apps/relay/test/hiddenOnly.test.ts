/**
 * The relay on a hidden-only node reaches the chain over hidden services only.
 *
 * F32. The relay is the process that BROADCASTS — signups, relayed transfers —
 * and it had no hidden-service router, no hidden endpoint list and no proxy
 * settings. The ansible template never set its RPC list, so a tor-only install
 * left it on the built-in clearnet default: the indexer read the chain over Tor
 * and I2P while the relay beside it talked to clearnet RPC operators from the
 * box's own address. And the instance claimed "Zero use of clearnet internet",
 * because that claim was computed from the indexer's configuration alone.
 *
 * These drive the relay's REAL config loader, its REAL health route, and the
 * shared router it now installs — against real sockets where a connection is
 * the thing being asserted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Hono } from 'hono';
import {
	loadConfig,
	relayIsHiddenOnly,
	hiddenRouterPolicy,
	type Config
} from '../src/config/index.ts';
import { HealthService } from '../src/api/health.ts';
import type { BlurtClient } from '../src/blurt/client.ts';
import {
	installHiddenServiceDispatcher,
	clearnetRefused,
	type HiddenDispatcherHandle
} from '@morphit/hidden-transport/router';

const ONION = `http://${'a'.repeat(56)}.onion:8091`;
const B32 = `http://${'b'.repeat(52)}.b32.i2p:8091`;

// ── a minimal valid relay environment ────────────────────────────────────────
let dir = '';
const saved: Record<string, string | undefined> = {};
const KEYS = [
	'MORPHIT_RELAY_ACCOUNT',
	'MORPHIT_RELAY_ACTIVE_KEY_FILE',
	'MORPHIT_RELAY_DATABASE_URL',
	'MORPHIT_RELAY_INVITE_HMAC_SECRET',
	'MORPHIT_RELAY_ALTCHA_HMAC_SECRET',
	'MORPHIT_RELAY_BLURT_RPC',
	'MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS',
	'MORPHIT_RELAY_VAPID_PUBLIC_KEY',
	'MORPHIT_RELAY_VAPID_PRIVATE_KEY',
	'MORPHIT_RELAY_VAPID_SUBJECT'
];
/** A well-formed VAPID public key: an uncompressed P-256 point, 0x04 + 64. */
const VAPID_PUB = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');

beforeEach(async () => {
	for (const k of KEYS) saved[k] = process.env[k];
	dir = mkdtempSync(join(tmpdir(), 'relay-hidden-only-'));
	const keyFile = join(dir, 'active.key');
	const { PrivateKey } = await import('@beblurt/dblurt');
	writeFileSync(keyFile, PrivateKey.fromSeed('relay-hidden-only-test').toString());
	chmodSync(keyFile, 0o400);
	process.env.MORPHIT_RELAY_ACCOUNT = 'morphit-relay';
	process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE = keyFile;
	process.env.MORPHIT_RELAY_DATABASE_URL =
		'postgres://relay:a-real-password-here@localhost:5432/morphit';
	process.env.MORPHIT_RELAY_INVITE_HMAC_SECRET = 'i'.repeat(64);
	process.env.MORPHIT_RELAY_ALTCHA_HMAC_SECRET = 'a'.repeat(64);
	// Push fully and validly configured, so that "push is off" can only come
	// from the hidden-only rule under test.
	process.env.MORPHIT_RELAY_VAPID_PUBLIC_KEY = VAPID_PUB;
	process.env.MORPHIT_RELAY_VAPID_PRIVATE_KEY = 'p'.repeat(43);
	process.env.MORPHIT_RELAY_VAPID_SUBJECT = 'mailto:ops@example.com';
	delete process.env.MORPHIT_RELAY_BLURT_RPC;
	delete process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS;
});

let handle: HiddenDispatcherHandle | null = null;
afterEach(async () => {
	await handle?.uninstall();
	handle = null;
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the relay config knows when it is hidden-only', () => {
	it('control: the default relay keeps clearnet, and push is on', () => {
		const cfg = loadConfig();
		expect(cfg.hiddenOnly).toBe(false);
		expect(cfg.blurtRpcEndpoints.length).toBeGreaterThan(0);
		expect(
			cfg.pushEnabled,
			'setup: push must be valid, or the push case below proves nothing'
		).toBe(true);
	});

	it('the default relay carries the public hidden nodes too, as the indexer does', () => {
		expect(loadConfig().hiddenRpcEndpoints.length).toBeGreaterThan(0);
	});

	it('empty clearnet list + hidden endpoints = hidden-only (it used to refuse to start)', () => {
		process.env.MORPHIT_RELAY_BLURT_RPC = '';
		process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS = `${ONION},${B32}`;
		const cfg = loadConfig();
		expect(cfg.hiddenOnly).toBe(true);
		expect(cfg.blurtRpcEndpoints).toEqual([]);
		expect(cfg.hiddenRpcEndpoints).toEqual([ONION, B32]);
	});

	it('a hidden-only relay sends no Web Push, however valid its keys', () => {
		process.env.MORPHIT_RELAY_BLURT_RPC = '';
		process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS = ONION;
		expect(
			loadConfig().pushEnabled,
			'a browser push service is a public clearnet host, reached over node:https'
		).toBe(false);
	});

	it('onions listed in the CLEARNET knob alone still make it hidden-only', () => {
		// That knob has always accepted http:// hidden entries; an operator who put
		// only onions there must not be treated as a clearnet relay.
		process.env.MORPHIT_RELAY_BLURT_RPC = ONION;
		process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS = '';
		expect(loadConfig().hiddenOnly).toBe(true);
	});

	it('no endpoints at all is still refused at boot', () => {
		process.env.MORPHIT_RELAY_BLURT_RPC = '';
		process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS = '';
		expect(() => loadConfig()).toThrow(/at least one endpoint/);
	});

	it('the hidden knob cannot smuggle a clearnet URL past the https rule', () => {
		process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS = 'http://rpc.example.com';
		expect(() => loadConfig()).toThrow(/\.onion or \.i2p/);
	});

	it.each([
		[['https://rpc.example.com'], [ONION], false],
		[[], [ONION], true],
		[[ONION], [], true],
		[[], [], false]
	])('relayIsHiddenOnly(%j, %j) = %s', (clear, hidden, want) => {
		expect(relayIsHiddenOnly(clear, hidden)).toBe(want);
	});
});

describe('which router the relay installs', () => {
	const cfg = (b: string[], h: string[]) => ({
		blurtRpcEndpoints: b,
		hiddenRpcEndpoints: h,
		hiddenOnly: relayIsHiddenOnly(b, h)
	});
	it('hidden-only → the fail-closed router', () => {
		expect(hiddenRouterPolicy(cfg([], [ONION]))).toBe('refuse');
	});
	it('hidden alongside clearnet → the router, clearnet untouched', () => {
		expect(hiddenRouterPolicy(cfg(['https://rpc.example.com'], [ONION]))).toBe('allow');
	});
	it('clearnet only → nothing installed, behaviour exactly as before', () => {
		expect(hiddenRouterPolicy(cfg(['https://rpc.example.com'], []))).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('with the router a hidden-only relay installs, a clearnet endpoint is never contacted', () => {
	let listener: net.Server;
	let port = 0;
	let connections = 0;
	beforeEach(async () => {
		connections = 0;
		listener = net.createServer((s) => {
			connections++;
			s.destroy();
		});
		await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
		port = (listener.address() as net.AddressInfo).port;
	});
	afterEach(async () => {
		await new Promise<void>((r) => listener.close(() => r()));
	});

	/** A public address that is really this box: an address literal skips DNS,
	 *  so the only thing between the request and the listener is the router. */
	const publicLookingUrl = (): string => `http://127.0.0.1:${port}/`;

	it('control: with no router, the same request connects', async () => {
		await fetch(publicLookingUrl()).catch(() => undefined);
		expect(connections).toBeGreaterThan(0);
	});

	it('the hidden-only router refuses a public host before any connection', async () => {
		process.env.MORPHIT_RELAY_BLURT_RPC = '';
		process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS = ONION;
		const c = loadConfig();
		const policy = hiddenRouterPolicy(c);
		expect(policy).toBe('refuse');
		handle = installHiddenServiceDispatcher(c.hiddenServiceProxies, policy!);
		expect(clearnetRefused()).toBe(true);
		// A PUBLIC name the router refuses by origin, before resolving it.
		const err = await fetch('https://rpc.example.com/').then(
			() => null,
			(e: unknown) => e
		);
		expect(String((err as { cause?: Error })?.cause?.message ?? err)).toMatch(/clearnet blocked/);
		// And the loopback control address is not public, so it is not refused —
		// the rule is about the open internet, not about sockets.
		await fetch(publicLookingUrl()).catch(() => undefined);
		expect(connections).toBeGreaterThan(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the relay tells the indexer what it is', () => {
	const blurt = { endpointSnapshot: () => [] } as unknown as BlurtClient;
	const health = async (c: Config): Promise<Record<string, unknown>> => {
		const app = new Hono();
		new HealthService(c, blurt, process.hrtime.bigint()).register(app);
		const res = await app.request('/v1/health');
		return (await res.json()) as Record<string, unknown>;
	};

	it('a hidden-only relay says hidden_only: true on /v1/health', async () => {
		process.env.MORPHIT_RELAY_BLURT_RPC = '';
		process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS = ONION;
		expect((await health(loadConfig())).hidden_only).toBe(true);
	});

	it('a clearnet relay says false — and says it, rather than omitting it', async () => {
		expect((await health(loadConfig())).hidden_only).toBe(false);
	});
});
