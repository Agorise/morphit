/**
 * Chat fan-out privacy (decision a).
 *
 * A push used to go to every registered origin — a registration nobody had
 * ever probed included — directly over clearnet from this instance's own IP,
 * or over ONE long-lived pooled connection per hidden peer. Either way a
 * hostile peer learned which instance each chatting account uses, which the
 * chain does not record. Now:
 *   - only peers a probe verified receive pushes;
 *   - every push goes through Tor, on its own circuit (fresh random SOCKS
 *     credentials — Tor's IsolateSOCKSAuth), never pooled, never direct;
 *   - one push carries one sender's messages only;
 *   - no Tor configured → no fan-out at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';
import {
	fastPeerDirectory,
	PeerSender,
	type FastFederationDb,
	type FastPeer
} from '$indexer/chatFastFederation';
import { postJsonViaTorIsolated } from '$indexer/hiddenServicePool';

const ONION_A = `${'a'.repeat(56)}.onion`;
const ONION_B = `${'b'.repeat(56)}.onion`;
const ONION_N = `${'n'.repeat(56)}.onion`;
const I2P = `${'c'.repeat(52)}.b32.i2p`;
const TOR: HiddenServiceProxyConfig = {
	torSocks: '127.0.0.1:9050',
	i2pHttpProxy: '127.0.0.1:4444',
	lokinet: true
};
const NO_TOR: HiddenServiceProxyConfig = {
	torSocks: '',
	i2pHttpProxy: '127.0.0.1:4444',
	lokinet: true
};

type Row = {
	origin: string;
	reg_alt_networks: Record<string, string | null> | null;
	last_probe_status: string | null;
	last_probed_at: string | null;
	registered_at_time: string | null;
	last_probe_error?: string | null;
};
const row = (
	origin: string,
	status: string | null,
	alt: Row['reg_alt_networks'] = null,
	error: string | null = null
): Row => ({
	origin,
	reg_alt_networks: alt,
	last_probe_status: status,
	last_probed_at: '2026-10-01T00:00:00Z',
	registered_at_time: '2026-01-01T00:00:00Z',
	last_probe_error: error
});
const dbWith = (rows: Row[]): FastFederationDb => ({
	query: (async () => ({ rows, rowCount: rows.length })) as unknown as FastFederationDb['query']
});

function chatTrx(signer: string, n: number): unknown {
	return {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: '2026-10-02T00:00:00',
		operations: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: [signer],
					id: 'morphit_chat_v1',
					json: JSON.stringify({
						recipient: 'bob',
						ciphertext: 'x',
						header: { client_tag: `t${n}` }
					})
				}
			]
		],
		extensions: [],
		signatures: []
	};
}

describe('who receives a push', () => {
	const DIRECTORY = [
		row('https://good.example', 'good', { tor: ONION_A }),
		row('https://quiet.example', 'quiet'),
		row(`http://${ONION_B}`, 'syncing'),
		row('https://never.example', 'never', { tor: ONION_N }),
		row('https://blocked.example', 'clearnet_blocked', { tor: ONION_N }),
		row('https://listed.example', 'good', { tor: ONION_N }, 'hidden_service_not_network_probed'),
		row('https://stale.example', 'stale'),
		row('https://i2p-only.example', 'good', { i2p_b32: I2P }),
		row('http://plain.example', 'good')
	];

	it('only probe-verified peers, each reached over Tor', async () => {
		const dir = await fastPeerDirectory(dbWith(DIRECTORY), 'https://self.example', TOR);
		expect(
			dir.peers.map((p) => [p.key, p.origin, (p.alternates ?? []).map((a) => a.origin)])
		).toEqual([
			['https://good.example', `http://${ONION_A}`, ['https://good.example']],
			['https://i2p-only.example', 'https://i2p-only.example', []],
			['https://quiet.example', 'https://quiet.example', []],
			[`http://${ONION_B}`, `http://${ONION_B}`, []]
		]);
		// No I2P address, no plain-http clearnet origin, nothing never-probed.
		const all = dir.peers.flatMap((p) => [p.origin, ...(p.alternates ?? []).map((a) => a.origin)]);
		expect(
			all.some((o) => o.includes('.i2p') || o.includes(ONION_N) || o.startsWith('http://plain'))
		).toBe(false);
	});

	it('no Tor configured: nobody', async () => {
		const dir = await fastPeerDirectory(dbWith(DIRECTORY), 'https://self.example', NO_TOR);
		expect(dir.peers).toEqual([]);
	});
});

describe('how a push travels', () => {
	it('one push carries one sender: messages queued together are split by signer', async () => {
		const pushes: { url: string; signers: string[] }[] = [];
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => (release = r));
		const sender = new PeerSender({
			proxies: TOR,
			timeoutMs: 1000,
			postIsolated: async (url, body) => {
				const trxs = (body as { trx?: unknown; trxs?: unknown[] }).trxs ?? [
					(body as { trx: unknown }).trx
				];
				pushes.push({
					url,
					signers: trxs.map(
						(t) =>
							(t as { operations: [string, { required_posting_auths: string[] }][] })
								.operations[0]![1].required_posting_auths[0]!
					)
				});
				if (pushes.length === 1) await gate;
				return { status: 200, body: '{}' };
			}
		});
		const peer: FastPeer = { origin: `http://${ONION_A}`, hidden: true, key: 'p' };
		sender.enqueue(chatTrx('alice', 0), [peer]); // in flight
		sender.enqueue(chatTrx('alice', 1), [peer]);
		sender.enqueue(chatTrx('carol', 2), [peer]);
		sender.enqueue(chatTrx('alice', 3), [peer]);
		release();
		await sender.drain(2000);
		expect(pushes.map((p) => p.signers)).toEqual([['alice'], ['alice'], ['carol'], ['alice']]);
	});
});

/** A SOCKS5 server that requires username/password, records each stream's
 *  credentials and target, and connects onion names to a local HTTP peer. */
describe('postJsonViaTorIsolated through a real SOCKS5 exchange', () => {
	let peer: http.Server;
	let socks: net.Server;
	const streams: { user: string; target: string }[] = [];
	const peerConnections = new Set<net.Socket>();
	let proxies: HiddenServiceProxyConfig;

	beforeAll(async () => {
		peer = http.createServer((req, res) => {
			req.resume();
			req.on('end', () => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end('{"ok":true}');
			});
		});
		peer.on('connection', (c) => peerConnections.add(c));
		await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r));
		const peerPort = (peer.address() as AddressInfo).port;

		socks = net.createServer((c) => {
			let buf = Buffer.alloc(0);
			let stage = 0;
			let user = '';
			c.on('data', (d) => {
				buf = Buffer.concat([buf, d]);
				if (stage === 0 && buf.length >= 3) {
					const methods = [...buf.subarray(2, 2 + buf[1]!)];
					buf = buf.subarray(2 + buf[1]!);
					c.write(Buffer.from([0x05, methods.includes(0x02) ? 0x02 : 0xff]));
					stage = 1;
				}
				if (stage === 1 && buf.length >= 2) {
					const ulen = buf[1]!;
					if (buf.length < 3 + ulen) return;
					const plen = buf[2 + ulen]!;
					if (buf.length < 3 + ulen + plen) return;
					user = buf.subarray(2, 2 + ulen).toString();
					buf = buf.subarray(3 + ulen + plen);
					c.write(Buffer.from([0x01, 0x00]));
					stage = 2;
				}
				if (stage === 2 && buf.length >= 5) {
					const hlen = buf[4]!;
					if (buf.length < 7 + hlen) return;
					const host = buf.subarray(5, 5 + hlen).toString();
					const port = buf.readUInt16BE(5 + hlen);
					streams.push({ user, target: `${host}:${port}` });
					stage = 3;
					c.removeAllListeners('data');
					if (!host.endsWith('.onion')) {
						c.end(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
						return;
					}
					const up = net.connect(peerPort, '127.0.0.1', () => {
						c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
						c.pipe(up).pipe(c);
					});
					up.on('error', () => c.destroy());
				}
			});
			c.on('error', () => undefined);
		});
		await new Promise<void>((r) => socks.listen(0, '127.0.0.1', r));
		proxies = {
			torSocks: `127.0.0.1:${(socks.address() as AddressInfo).port}`,
			i2pHttpProxy: '',
			lokinet: false
		};
	});

	afterAll(async () => {
		await new Promise<void>((r) => socks.close(() => r()));
		peer.closeAllConnections?.();
		await new Promise<void>((r) => peer.close(() => r()));
	});

	it('two pushes to one peer: two SOCKS streams, two different isolation credentials, never one connection', async () => {
		const url = `http://${ONION_A}/v1/federation/chat-fast`;
		const a = await postJsonViaTorIsolated(url, { trx: 1 }, proxies, 5000);
		const b = await postJsonViaTorIsolated(url, { trx: 2 }, proxies, 5000);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(streams.map((s) => s.target)).toEqual([`${ONION_A}:80`, `${ONION_A}:80`]);
		expect(streams[0]!.user).toMatch(/^[0-9a-f]{24}$/);
		expect(streams[1]!.user).not.toBe(streams[0]!.user);
		expect(peerConnections.size, 'each push arrived on its own connection').toBe(2);
	});

	it('a clearnet https origin is dialled by NAME through the proxy (the exit resolves it), never directly', async () => {
		streams.length = 0;
		// The test proxy refuses non-onion targets, so the push fails — after
		// asking the proxy for the NAME, which is all this case is about.
		const err = await postJsonViaTorIsolated(
			'https://peer.example/v1/federation/chat-fast',
			{},
			proxies,
			5000
		).catch((e: unknown) => e);
		expect(String((err as { cause?: unknown }).cause ?? err)).toMatch(/peer unreachable via Tor/);
		expect(streams.map((s) => s.target)).toEqual(['peer.example:443']);
	});

	it('no Tor configured is a local fault, before any connection', async () => {
		await expect(
			postJsonViaTorIsolated(`http://${ONION_A}/x`, {}, { torSocks: '', i2pHttpProxy: '' }, 1000)
		).rejects.toThrow(/not configured/);
	});
});
