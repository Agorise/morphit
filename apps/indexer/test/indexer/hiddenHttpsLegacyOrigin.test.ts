/**
 * a legacy `https://` hidden-service origin.
 *
 * The hidden transports tunnel plain HTTP (the network authenticates the host
 * and encrypts end to end); they never spoke TLS. So `https://<onion>` was
 * dialled as plaintext — on port 80 when no port was written, and as plaintext
 * HTTP to port 443 when `:443` was written, which a TLS listener can only
 * refuse: every push and probe then failed as the PEER's fault until the row
 * was pruned. Registration now refuses https for hidden hosts; rows already
 * registered that way are dialled as what the transport really speaks — http,
 * on the http port — with a warning, instead of silently.
 *
 * A real SOCKS5 listener records where the connector is asked to go.
 */
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fastPeerFromRow } from '../../src/indexer/chatFastFederation';
import { postJsonViaHiddenService, closePool } from '../../src/indexer/hiddenServicePool';

const ONION = `${'b'.repeat(56)}.onion`;
let server: net.Server;
let port = 0;
const seen: Array<{ port: number; first: string }> = [];

beforeAll(async () => {
	server = net.createServer((s) => {
		let stage = 0;
		let target = 0;
		s.on('data', (d) => {
			if (stage === 0) {
				s.write(Buffer.from([5, 0]));
				stage = 1;
				return;
			}
			if (stage === 1) {
				const len = d[4]!;
				target = d.readUInt16BE(5 + len);
				s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
				stage = 2;
				return;
			}
			seen.push({ port: target, first: d.toString('latin1').split('\r\n')[0]! });
			s.end('HTTP/1.1 202 Accepted\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => {
	await closePool(1000);
	server.close();
});

describe('legacy https:// hidden origins (S9)', () => {
	it('are dialled as http on the http port — not plaintext to a TLS port', async () => {
		const proxies = { torSocks: `127.0.0.1:${port}`, i2pHttpProxy: '' } as never;
		const peer = fastPeerFromRow(
			{ origin: `https://${ONION}:443`, reg_alt_networks: null },
			proxies
		);
		expect(peer.origin, 'the dial address still says https').toBe(`http://${ONION}`);
		const r = await postJsonViaHiddenService(
			`${peer.origin}/v1/federation/chat-fast`,
			{ trx: {} },
			proxies,
			4000
		);
		expect(r.status).toBe(202);
		expect(seen.at(-1)?.port, 'plaintext HTTP was sent to the TLS port').toBe(80);
		// The peer's IDENTITY (queue key) is still its registered origin.
		expect(peer.key).toBe(`https://${ONION}:443`);
	});

	it('an http origin is untouched', () => {
		const peer = fastPeerFromRow({ origin: `http://${ONION}`, reg_alt_networks: null }, {
			torSocks: '127.0.0.1:9050',
			i2pHttpProxy: ''
		} as never);
		expect(peer.origin).toBe(`http://${ONION}`);
	});
});
