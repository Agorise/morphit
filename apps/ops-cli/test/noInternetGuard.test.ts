/**
 * The test network guard (test/setup/noInternet.ts) judges a connection by
 * the address it goes to (v1.21.4 CI, 2026-10-09: its first version judged by
 * name and refused CI's database, the service container `postgres`).
 */
import dns from 'node:dns';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { guardVerdict, isLocalAddress } from './setup/noInternet.ts';

describe('the test network guard', () => {
	it("allows a container name that resolves to a private address (CI's `postgres`)", () => {
		expect(guardVerdict('postgres', ['172.18.0.2'])).toBe('allow');
		expect(guardVerdict('postgres', ['127.0.0.1'])).toBe('allow');
		expect(guardVerdict('db', null)).toBe('allow');
	});

	it('refuses a name that resolves to a public address (the real Blurt nodes)', () => {
		expect(guardVerdict('rpc.blurt.blog', ['1.1.1.1'])).toBe('refuse');
		expect(guardVerdict('mixed.example', ['10.0.0.1', '8.8.8.8'])).toBe('refuse');
	});

	it('refuses an internet-style name even where it does not resolve (a sandbox without DNS)', () => {
		expect(guardVerdict('rpc.example.invalid', null)).toBe('refuse');
		expect(guardVerdict('box.internal', null)).toBe('allow');
	});

	it('addresses: loopback, private and link-local are local; public ones are not', () => {
		for (const a of [
			'127.0.0.1',
			'10.1.2.3',
			'172.16.0.1',
			'192.168.1.1',
			'169.254.1.1',
			'::1',
			'fd00::1',
			'::ffff:127.0.0.1'
		])
			expect(isLocalAddress(a), a).toBe(true);
		for (const a of ['8.8.8.8', '172.32.0.1', '2606:4700::1', '::ffff:8.8.8.8'])
			expect(isLocalAddress(a), a).toBe(false);
		expect(guardVerdict('8.8.8.8', null)).toBe('refuse');
	});

	it('a connection to a container name reaches it, in every form net offers (v1.22.1 CI)', async () => {
		// `db-sidecar` stands for CI's `postgres`: a name that resolves to a
		// local address.
		const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((
			_host: string,
			opts: unknown,
			cb?: unknown
		) => {
			const done = (typeof opts === 'function' ? opts : cb) as (...a: unknown[]) => void;
			if (typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all)
				done(null, [{ address: '127.0.0.1', family: 4 }]);
			else done(null, '127.0.0.1', 4);
		}) as never);
		const server = net.createServer((c) => c.end('hello'));
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as net.AddressInfo).port;
		const read = (s: net.Socket): Promise<string> =>
			new Promise((resolve) => {
				let got = '';
				s.on('data', (d) => (got += String(d)));
				s.on('error', (e: NodeJS.ErrnoException) => resolve(`error ${e.code ?? e.message}`));
				s.on('close', () => resolve(got));
			});
		try {
			expect(await read(net.connect(port, 'db-sidecar')), 'net.connect(port, host)').toBe('hello');
			expect(
				await read(net.connect({ port, host: 'db-sidecar' })),
				'net.connect({ port, host })'
			).toBe('hello');
			expect(
				await read(new net.Socket().connect(port, 'db-sidecar')),
				'socket.connect(port, host)'
			).toBe('hello');
			expect(lookup).toHaveBeenCalled();
		} finally {
			lookup.mockRestore();
			await new Promise<void>((r) => server.close(() => r()));
		}
	});
});
