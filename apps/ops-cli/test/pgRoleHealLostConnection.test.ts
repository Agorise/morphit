/**
 * The database-role check (pgRoleHeal) connects as the indexer's role with a
 * plain pg.Client. When its connection is reset or closed with no message from
 * Postgres (a backend killed, a network reset), the client emits 'error' before
 * the statement fails: with no listener, Node ended morphit-ops in the middle
 * of an upgrade. Now the check reports the failure (v1.22.1). Real Postgres
 * (TEST_DATABASE_URL) behind a proxy that drops the connection mid-statement;
 * skipped without.
 */
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { realRuntime } from '../src/lib/pgRoleHeal.ts';

const URL0 = process.env.TEST_DATABASE_URL ?? '';

/** A proxy that drops the client side as soon as it has passed on a pg_sleep
 *  statement, while the client waits for its answer: `end` closes it (FIN),
 *  `reset` resets it (RST). `closed`: the dropped connection has closed. */
async function droppingProxy(how: 'end' | 'reset'): Promise<{
	url: string;
	dropped: () => boolean;
	closed: Promise<void>;
	close: () => Promise<void>;
}> {
	const target = new URL(URL0);
	const sockets: net.Socket[] = [];
	let didDrop = false;
	let markClosed = (): void => {};
	const closed = new Promise<void>((r) => (markClosed = r));
	const proxy = net.createServer((c) => {
		const s = net.connect(Number(target.port), target.hostname);
		sockets.push(c, s);
		c.on('error', () => undefined);
		s.on('error', () => undefined);
		c.on('data', (d: Buffer) => {
			s.write(d);
			if (d.includes(Buffer.from('pg_sleep'))) {
				didDrop = true;
				c.on('close', () => markClosed());
				if (how === 'end') c.end();
				else c.resetAndDestroy();
			}
		});
		s.on('data', (d: Buffer) => {
			if (c.writable) c.write(d);
		});
	});
	await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
	const via = new URL(URL0);
	via.hostname = '127.0.0.1';
	via.port = String((proxy.address() as net.AddressInfo).port);
	return {
		url: via.toString(),
		dropped: () => didDrop,
		closed,
		close: async () => {
			for (const x of sockets) x.destroy();
			await new Promise<void>((r) => proxy.close(() => r()));
		}
	};
}

describe.skipIf(URL0 === '')('pgRoleHeal: a connection that drops mid-statement', () => {
	for (const how of ['end', 'reset'] as const) {
		it(`(${how}) is reported as a failed check, and morphit-ops carries on`, async () => {
			const px = await droppingProxy(how);
			try {
				const r = await realRuntime.asRole(px.url, ['SELECT pg_sleep(1)']);
				expect(r.ok).toBe(false);
				// It failed because the connection dropped mid-statement, not
				// because the proxy could not reach Postgres.
				expect(px.dropped(), 'the statement reached the proxy and was cut off').toBe(true);
				// Anything the closing socket reports arrives after the answer:
				// wait until it has closed.
				await px.closed;
				expect(await realRuntime.asRole(URL0, ['SELECT 1'])).toEqual({ ok: true, rows: [['1']] });
			} finally {
				await px.close();
			}
		});
	}
});
