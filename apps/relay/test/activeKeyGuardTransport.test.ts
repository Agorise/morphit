/**
 * The relay's key check (policy/activeKeyGuard → BlurtClient.activeAuthorityAgreed)
 * asks the chain through EXACTLY the relay's own RPC pool and transport — the
 * pool its broadcasts use, behind the hidden-service router main.ts installs:
 *
 *  - hidden-only (no clearnet RPC, hidden endpoints over Tor): the check works
 *    through the hidden endpoints, and not one connection goes to a clearnet
 *    host — not even to a clearnet node the on-chain RPC directory merged into
 *    the pool (it merges every listed node, clearnet ones too);
 *  - mixed: a node the relay's own traffic has put on cooldown is not asked,
 *    and the check's answers feed the same health record the broadcasts read.
 *
 * Built the way main.ts builds them (loadConfig → BlurtClient over the clearnet
 * + hidden lists → installHiddenServiceDispatcher(routerInstallPolicy(…))),
 * against stand-in nodes and a stand-in Tor (SOCKS5) on loopback. Every socket
 * the process opens is recorded; one to a non-loopback host is refused.
 */
import http from 'node:http';
import net from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	installHiddenServiceDispatcher,
	routerInstallPolicy,
	type HiddenDispatcherHandle
} from '@morphit/hidden-transport/router';
import { fakeSocks } from './notifyFakes.ts';
import { hiddenRouterPolicy, loadConfig } from '../src/config/index.ts';
import { BlurtClient } from '../src/blurt/client.ts';
import { ActiveKeyGuard } from '../src/policy/activeKeyGuard.ts';

const ACTIVE_WIF = PrivateKey.fromSeed('relay-transport-active').toString();
const ACTIVE = PrivateKey.fromString(ACTIVE_WIF).createPublic('BLT').toString();
const OWNER = PrivateKey.fromSeed('relay-transport-owner').createPublic('BLT').toString();

interface Node {
	url: string;
	port: number;
	methods: string[];
	down: boolean;
}
const servers: http.Server[] = [];
/** A Blurt node on `host`; `down` answers 503 to everything. */
async function node(host: string): Promise<Node> {
	const n: Node = { url: '', port: 0, methods: [], down: false };
	const srv = http.createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			const j = JSON.parse(body) as { id: number; method: string };
			n.methods.push(j.method);
			if (n.down) {
				res.statusCode = 503;
				return res.end('down');
			}
			const result = j.method.endsWith('get_accounts')
				? [
						{
							name: 'relayacct',
							owner: { weight_threshold: 1, account_auths: [], key_auths: [[OWNER, 1]] },
							active: { weight_threshold: 1, account_auths: [], key_auths: [[ACTIVE, 1]] },
							posting: { weight_threshold: 1, account_auths: [], key_auths: [] },
							memo_key: OWNER
						}
					]
				: j.method.endsWith('get_dynamic_global_properties')
					? { head_block_number: 1, head_block_id: '00'.repeat(20), time: '2026-10-29T00:00:00' }
					: null;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
		});
	});
	srv.keepAliveTimeout = 1;
	await new Promise<void>((r) => srv.listen(0, host, () => r()));
	servers.push(srv);
	n.port = (srv.address() as net.AddressInfo).port;
	n.url = `http://${host}:${n.port}`;
	return n;
}
const asked = (n: Node): number => n.methods.filter((m) => m.endsWith('get_accounts')).length;

/** Every outbound socket: its host. A non-loopback one is refused. */
const connects: string[] = [];
const realConnect = net.Socket.prototype.connect;
beforeAll(() => {
	net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
		const a0 = args[0] as { host?: string; path?: string } | number | string;
		const host =
			typeof a0 === 'object' && a0 !== null
				? (a0.host ?? (a0.path !== undefined ? 'unix' : 'localhost'))
				: typeof args[1] === 'string'
					? args[1]
					: 'localhost';
		connects.push(host);
		if (!/^(127\.|localhost$|unix$)/.test(host)) {
			process.nextTick(() => this.destroy(new Error(`test: refused a connection to ${host}`)));
			return this;
		}
		return (realConnect as (...x: unknown[]) => net.Socket).apply(this, args);
	} as typeof net.Socket.prototype.connect;
});
afterAll(() => {
	net.Socket.prototype.connect = realConnect;
	for (const s of servers) {
		s.closeAllConnections();
		s.close();
	}
});

const ENV_KEYS = [
	'MORPHIT_RELAY_ACCOUNT',
	'MORPHIT_RELAY_ACTIVE_KEY_FILE',
	'MORPHIT_RELAY_DATABASE_URL',
	'MORPHIT_RELAY_INVITE_HMAC_SECRET',
	'MORPHIT_RELAY_ALTCHA_HMAC_SECRET',
	'MORPHIT_RELAY_BLURT_RPC',
	'MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS',
	'MORPHIT_RELAY_TOR_SOCKS',
	'MORPHIT_RELAY_I2P_HTTP_PROXY',
	'MORPHIT_RPC_HEALTH_STATE'
];
const saved: Record<string, string | undefined> = {};
let dir = '';
let handle: HiddenDispatcherHandle | null = null;
let socks: Awaited<ReturnType<typeof fakeSocks>> | null = null;
beforeEach(async () => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	dir = mkdtempSync(join(tmpdir(), 'akg-transport-'));
	const keyFile = join(dir, 'active.key');
	writeFileSync(keyFile, ACTIVE_WIF);
	chmodSync(keyFile, 0o400);
	process.env.MORPHIT_RELAY_ACCOUNT = 'relayacct';
	process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE = keyFile;
	process.env.MORPHIT_RELAY_DATABASE_URL = 'postgres://relay:a-real-password-here@localhost:5432/x';
	process.env.MORPHIT_RELAY_INVITE_HMAC_SECRET = 'i'.repeat(64);
	process.env.MORPHIT_RELAY_ALTCHA_HMAC_SECRET = 'a'.repeat(64);
	process.env.MORPHIT_RPC_HEALTH_STATE = join(dir, 'rpc-health.json');
	socks = await fakeSocks();
	process.env.MORPHIT_RELAY_TOR_SOCKS = `127.0.0.1:${socks.port}`;
	process.env.MORPHIT_RELAY_I2P_HTTP_PROXY = '';
	connects.length = 0;
});
afterEach(async () => {
	await handle?.uninstall();
	handle = null;
	await socks?.close();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(dir, { recursive: true, force: true });
});

/** The relay's pool, router and key guard, as main.ts builds them. */
function relayAsMainBuildsIt() {
	const cfg = loadConfig();
	handle = installHiddenServiceDispatcher(
		cfg.hiddenServiceProxies,
		routerInstallPolicy(hiddenRouterPolicy(cfg))
	);
	const blurt = new BlurtClient(
		[...cfg.blurtRpcEndpoints, ...cfg.hiddenRpcEndpoints],
		cfg.accountCreationFeeBlurt
	);
	const quiet = { info: () => {}, warn: () => {}, error: () => {} };
	const guard = new ActiveKeyGuard({
		account: cfg.relayAccount,
		publicKey: ACTIVE,
		lookup: (name) => blurt.activeAuthorityAgreed(name),
		log: quiet
	});
	return { cfg, blurt, guard };
}

describe('hidden-only relay: the key check goes through the hidden endpoints only', () => {
	it('answers through two onion operators over Tor; no socket to any clearnet host', async () => {
		const a = await node('127.0.0.1');
		const b = await node('127.0.0.1');
		const onionA = `http://${'a'.repeat(56)}.onion:${a.port}`;
		const onionB = `http://${'b'.repeat(56)}.onion:${b.port}`;
		process.env.MORPHIT_RELAY_BLURT_RPC = '';
		process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS = `${onionA},${onionB}`;
		const { cfg, blurt, guard } = relayAsMainBuildsIt();
		expect(cfg.hiddenOnly).toBe(true);
		// The on-chain directory merges every listed node, clearnet ones too.
		blurt.mergeRpcEndpoints(['https://rpc.example.com', 'https://rpc2.example.net']);

		const state = await guard.check();
		expect(state.state).toBe('ok');
		expect(guard.signingRefused()).toBe(false);
		expect(asked(a)).toBeGreaterThan(0);
		expect(asked(b)).toBeGreaterThan(0);
		// Reached through the stand-in Tor, by onion name.
		expect(socks!.targets.some((t) => t.startsWith('a'.repeat(56)))).toBe(true);
		expect(socks!.targets.some((t) => t.startsWith('b'.repeat(56)))).toBe(true);
		// Not one socket to a clearnet host (the stand-in Tor's own onward
		// connections are to loopback).
		expect(connects.filter((h) => !/^(127\.|localhost$|unix$)/.test(h))).toEqual([]);
	}, 60_000);
});

describe('mixed relay: the key check uses the pool the broadcasts use', () => {
	it('a node the relay put on cooldown is not asked; the answers feed the shared health', async () => {
		const dead = await node('127.0.0.61');
		const b = await node('127.0.0.62');
		const c = await node('127.0.0.63');
		const h = await node('127.0.0.1');
		const onion = `http://${'c'.repeat(56)}.onion:${h.port}`;
		dead.down = true;
		// The config takes only https:// clearnet nodes; the stand-ins (plain
		// http on loopback) join the pool the way the RPC directory's nodes do.
		process.env.MORPHIT_RELAY_BLURT_RPC = 'https://rpc.example.com';
		process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS = onion;
		const { cfg, blurt, guard } = relayAsMainBuildsIt();
		expect(cfg.hiddenOnly).toBe(false);
		blurt.mergeRpcEndpoints([dead.url, b.url, c.url]);

		// The relay's own chain traffic meets the dead node and cools it down.
		for (let i = 0; i < 8; i++) {
			await blurt.getDynamicGlobalProperties().catch(() => undefined);
			const ep = blurt.endpointSnapshot().find((e) => e.url === dead.url);
			if (ep !== undefined && ep.cooldownUntil > Date.now()) break;
		}
		const deadEp = blurt.endpointSnapshot().find((e) => e.url === dead.url)!;
		expect(deadEp.cooldownUntil, 'setup: the dead node is on cooldown').toBeGreaterThan(Date.now());
		dead.methods.length = 0;
		const before = new Map(blurt.endpointSnapshot().map((e) => [e.url, e.lastSuccessAt]));

		const state = await guard.check();
		expect(state.state).toBe('ok');
		expect(asked(dead)).toBe(0);
		// What the check learned is in the relay's one health record.
		const after = blurt.endpointSnapshot();
		const fresher = after.filter((e) => e.lastSuccessAt > (before.get(e.url) ?? 0));
		expect(fresher.length).toBeGreaterThanOrEqual(2);
	}, 60_000);
});

describe('a check that cannot decide never stops signing', () => {
	it('every node down: unknown, signing goes on', async () => {
		const a = await node('127.0.0.71');
		const b = await node('127.0.0.72');
		a.down = true;
		b.down = true;
		process.env.MORPHIT_RELAY_BLURT_RPC = 'https://rpc.example.com';
		process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS = '';
		const { blurt, guard } = relayAsMainBuildsIt();
		blurt.mergeRpcEndpoints([a.url, b.url]);
		expect(guard.signingRefused()).toBe(false); // before the first check
		expect((await guard.check()).state).toBe('unknown');
		expect(guard.signingRefused()).toBe(false);
	}, 60_000);

	it('the lookup itself throwing: unknown, signing goes on', async () => {
		const guard = new ActiveKeyGuard({
			account: 'relayacct',
			publicKey: ACTIVE,
			lookup: async () => {
				throw new Error('boom');
			},
			log: { info: () => {}, warn: () => {}, error: () => {} }
		});
		expect((await guard.check()).state).toBe('unknown');
		expect(guard.signingRefused()).toBe(false);
	});
});
