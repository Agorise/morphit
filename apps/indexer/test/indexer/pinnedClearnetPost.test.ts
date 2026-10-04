/**
 * the federation chat push to a clearnet peer is resolved
 * and pinned like the probe, so a registered NAME that resolves to a private
 * address is never dialled.
 *
 * Before: main.ts POSTed with the global fetch; a registered
 * `https://rebind.example:<port>` whose DNS said 127.0.0.1 had the indexer open
 * a connection and send a TLS ClientHello to its own loopback port for every
 * relayed chat message (1,611 bytes measured on the listener). A real local
 * listener counts connections here; DNS is the only thing stubbed.
 */
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postClearnetPinned, closePinnedClearnet } from '../../src/indexer/pinnedClearnetPost';

let server: net.Server;
let port = 0;
let connections = 0;
beforeAll(async () => {
	server = net.createServer((s) => {
		connections++;
		s.destroy();
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => {
	await closePinnedClearnet();
	server.close();
});

const answers =
	(addresses: string[]) => async (): Promise<Array<{ address: string; family: number }>> =>
		addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('clearnet chat push (S7)', () => {
	it.each([
		['loopback', ['127.0.0.1']],
		['a public AND a private answer', ['93.184.216.34', '127.0.0.1']],
		['IPv4-mapped loopback', ['::ffff:127.0.0.1']],
		['cloud metadata', ['169.254.169.254']],
		['RFC 1918', ['10.0.0.7']]
	])('a name resolving to %s is refused before any connection', async (_label, addrs) => {
		const before = connections;
		await expect(
			postClearnetPinned(
				`https://rebind-${_label.length}.example:${port}/v1/federation/chat-fast`,
				{ trx: {} },
				2000,
				{
					lookup: answers(addrs)
				}
			)
		).rejects.toThrow(/private|refusing/i);
		expect(connections - before, 'a connection reached an internal address').toBe(0);
	});

	it('refuses a non-https peer outright', async () => {
		await expect(postClearnetPinned(`http://peer.example/x`, {}, 1000)).rejects.toThrow(
			/non-https/
		);
	});
});
