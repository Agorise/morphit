/**
 * A NAME that starts like a private address is still a public name
 * (v1.18.0 deep-deep, C1).
 *
 * THE BUG. The router decided "is this origin local?" by matching the TEXT of
 * the host against `10.`, `127.`, `192.168.`, `172.16-31.` and `169.254.`. So
 * `https://10.attacker.example` counted as "local" and went to the plain agent
 * even on a hidden-only node in `refuse` mode: a system-resolver query for the
 * attacker's name, then a TCP connection from the node's own address to
 * whatever the attacker's DNS answered. Registration only rejected those ranges
 * as whole IP literals, so anyone could register such an origin, and the chat
 * fan-out then dialled it on every message.
 *
 * WHAT IS ASSERTED is behaviour: DNS lookups and TCP connections are counted at
 * the real `dns.lookup` and a real listener, through the real registration
 * validator, the real router, the real directory read and peer sender, and
 * main.ts's own `postClearnet` shape. A control proves the counters work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import dns from 'node:dns';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';
import { validate } from '$indexer/handlers/operatorRegister';
import {
	installHiddenServiceDispatcher,
	clearnetRefused,
	isClearnetOrigin,
	type HiddenDispatcherHandle
} from '$indexer/hiddenServiceDispatcher';
import {
	fastPeerFromRow,
	fastPeersFromDirectory,
	addressesOf,
	PeerSender
} from '$indexer/chatFastFederation';
import { readCappedText } from '$indexer/hiddenServicePool';
import { needsPublicLookup } from '$api/operationalHealth';

/** Nothing listens on port 1: both proxies are "down". */
const PROXIES: HiddenServiceProxyConfig = {
	torSocks: '127.0.0.1:1',
	i2pHttpProxy: '127.0.0.1:1',
	lokinet: false
};
const ONION = `${'a'.repeat(56)}.onion`;

// ── counters at the real resolver and a real listener ──────────────────────
let listener: net.Server;
let port = 0;
let tcp = 0;
let lookups: string[] = [];
const realLookup = dns.lookup;

beforeEach(async () => {
	tcp = 0;
	listener = net.createServer((s) => {
		tcp++;
		s.destroy();
	});
	await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
	port = (listener.address() as net.AddressInfo).port;
	lookups = [];
	// Every name resolves to the listener — exactly what an attacker's DNS does.
	(dns as unknown as { lookup: unknown }).lookup = (
		host: string,
		opts: unknown,
		cb?: (...a: unknown[]) => void
	): void => {
		lookups.push(host);
		const done = (typeof opts === 'function' ? opts : cb) as (...a: unknown[]) => void;
		const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
		if (all) done(null, [{ address: '127.0.0.1', family: 4 }]);
		else done(null, '127.0.0.1', 4);
	};
});

let handle: HiddenDispatcherHandle | null = null;
afterEach(async () => {
	(dns as unknown as { lookup: unknown }).lookup = realLookup;
	await handle?.uninstall();
	handle = null;
	await new Promise<void>((r) => listener.close(() => r()));
});

/** main.ts's `postClearnet`, verbatim in shape. */
async function postClearnet(url: string, body: unknown, timeoutMs: number) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body),
			redirect: 'manual',
			signal: ctrl.signal
		});
		return { status: res.status, body: await readCappedText(res) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Push one chat transaction to a directory holding one peer, through the real
 * directory read (`fastPeersFromDirectory` → `fastPeerFromRow`) and the real
 * sender (`PeerSender` → `sendBatchToAddress` → `postClearnet`). Below the
 * dispatcher's signature gate, which is not what this is about.
 */
async function pushOneChatTo(origin: string): Promise<void> {
	const db = {
		query: async () => ({
			rows: [
				{
					origin,
					reg_alt_networks: null,
					last_probe_status: 'never',
					last_probed_at: null,
					registered_at_time: null,
					last_probe_error: null
				}
			]
		})
	};
	const peers = await fastPeersFromDirectory(db as never, `http://${ONION}`, PROXIES);
	expect(peers.length).toBe(1);
	const sender = new PeerSender({ proxies: PROXIES, timeoutMs: 4_000, postClearnet });
	sender.enqueue({ operations: [] }, peers);
	// Wait on the outcome, not on the clock.
	for (let i = 0; i < 2000; i++) {
		const s = sender.stats();
		if (s.delivered + s.failed > 0) break;
		await new Promise((r) => setTimeout(r, 5));
	}
	await sender.drain(5_000);
}

const attackerOrigin = (): string => `https://10.attacker.example:${port}`;

describe('C1 — the router classifies by address, not by the spelling of a name', () => {
	it.each([
		'http://10.attacker.example',
		'http://127.attacker.example',
		'http://192.168.0.1.nip.io',
		'http://172.16.9.attacker.example',
		'http://169.254.attacker.example',
		'http://fd00.attacker.example',
		'http://sub.localhost',
		'http://[::ffff:8.8.8.8]'
	])('%s is clearnet', (o) => {
		expect(isClearnetOrigin(o)).toBe(true);
	});

	it.each([
		'http://10.0.0.5',
		'http://127.0.0.1:5001',
		'http://192.168.1.10',
		'http://172.18.0.1:8081',
		'http://169.254.1.1',
		'http://[::1]:80',
		'http://[fd00::1]:80',
		'http://[fe80::1]',
		'http://[::ffff:127.0.0.1]',
		'http://[::ffff:10.1.2.3]',
		'http://localhost:8081',
		`http://${ONION}`,
		'http://peer.loki'
	])('%s is not clearnet', (o) => {
		expect(isClearnetOrigin(o)).toBe(false);
	});

	it('needsPublicLookup: a name that starts with a private prefix still needs a lookup', () => {
		expect(needsPublicLookup('http://10.relay.example:8080/v1/health')).toBe(true);
		expect(needsPublicLookup('http://10.0.0.7:8080/v1/health')).toBe(false);
	});
});

describe('C1 — registration refuses a name dressed as a private address', () => {
	const reason = (origin: string): string | null => {
		const v = validate({ v: 1, tag: 'evilnode', display_name: 'x', origin }) as {
			reason?: string;
		};
		return v.reason ?? null;
	};
	it.each([
		'https://10.attacker.example',
		'https://127.0.attacker.example',
		'https://192.168.attacker.example',
		'https://172.20.1.attacker.example',
		'https://169.254.169.254.nip.io',
		'https://10.0.0.1.nip.io',
		'https://0.attacker.example',
		'https://[::ffff:127.0.0.1]',
		'https://[::ffff:10.0.0.1]',
		'https://100.64.0.1',
		'https://0.0.0.0'
	])('%s is rejected', (o) => {
		expect(reason(o)).not.toBeNull();
	});
	it.each([
		'https://morphit.io',
		'https://163.com',
		'https://10.tv',
		'https://1password.example',
		'https://node10.example',
		'https://192.example.org',
		'https://8.8.8.8',
		'https://[2001:db8::1]'
	])('%s is accepted', (o) => {
		expect(reason(o)).toBeNull();
	});
});

describe('C1 — end to end: a registered 10.<name> origin on a hidden-only node', () => {
	it('control: on a clearnet node the same push does resolve and connect', async () => {
		await pushOneChatTo(attackerOrigin());
		expect(lookups).toContain('10.attacker.example');
		expect(tcp).toBeGreaterThan(0);
	});

	it('hidden-only: no DNS lookup of the name and no connection to it', async () => {
		handle = installHiddenServiceDispatcher(PROXIES, 'refuse');
		expect(clearnetRefused()).toBe(true);
		await pushOneChatTo(attackerOrigin());
		expect(lookups, 'the name reached the system resolver').not.toContain('10.attacker.example');
		expect(tcp, 'a hidden-only node connected to a clearnet peer').toBe(0);
	});

	it('hidden-only: a direct fetch of the name is refused before any lookup', async () => {
		handle = installHiddenServiceDispatcher(PROXIES, 'refuse');
		await expect(postClearnet(`${attackerOrigin()}/x`, {}, 2_000)).rejects.toThrow();
		expect(lookups).toEqual([]);
		expect(tcp).toBe(0);
	});

	it('defence in depth: on a hidden-only node a peer never gets a non-hidden address', () => {
		handle = installHiddenServiceDispatcher(PROXIES, 'refuse');
		const clearOnly = fastPeerFromRow(
			{ origin: attackerOrigin(), reg_alt_networks: null },
			PROXIES
		);
		expect(addressesOf(clearOnly).filter((a) => !a.hidden)).toEqual([]);
		const withOnion = fastPeerFromRow(
			{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } },
			PROXIES
		);
		expect(addressesOf(withOnion).map((a) => a.origin)).toEqual([`http://${ONION}`]);
		expect(addressesOf(withOnion).every((a) => a.hidden)).toBe(true);
	});

	it('a clearnet node keeps the registered origin as a clearnet address', () => {
		const p = fastPeerFromRow(
			{ origin: 'https://peer.example', reg_alt_networks: { tor: ONION } },
			PROXIES
		);
		expect(addressesOf(p).map((a) => [a.origin, a.hidden])).toEqual([
			[`http://${ONION}`, true],
			['https://peer.example', false]
		]);
	});
});
