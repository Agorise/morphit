#!/usr/bin/env tsx
/**
 * scripts/canary-socks-connector-smoke.ts
 *
 * v1.18.0 deep-deep, L1 — the canary's Tor SOCKS connector is the SHARED one.
 *
 * `scripts/canary/torSocksDispatcher.ts` carried its own copy of the SOCKS5
 * connector, without the fixes the shared one in @morphit/hidden-transport got
 * (S8, S10, X5): no settled guard (a later error on a pooled tunnel called
 * undici's callback a second time), a fixed 10-byte reply length (a domain or
 * IPv6 BND.ADDR left its tail in front of the HTTP bytes), dropped bytes that
 * arrived with the reply, and no early-close handling (a proxy that hung up
 * mid-handshake waited out the full 20 s).
 *
 * Driven over real sockets against the connector the canary actually installs.
 */
import net from 'node:net';
import { makeSocks5Connector } from './canary/torSocksDispatcher.js';

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}`);
	}
}

const servers: net.Server[] = [];
async function listen(handler: (s: net.Socket) => void): Promise<number> {
	const srv = net.createServer(handler);
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
	servers.push(srv);
	return (srv.address() as net.AddressInfo).port;
}

async function until(cond: () => boolean, maxMs: number): Promise<void> {
	const deadline = performance.now() + maxMs;
	while (!cond() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

type Settle = { err: Error | null; socket: net.Socket | null };
function connect(port: number, onSocket?: (s: net.Socket) => void): Settle[] {
	const calls: Settle[] = [];
	makeSocks5Connector('127.0.0.1', port)({ hostname: 'example.com', port: 443 }, (err, socket) => {
		calls.push({ err, socket });
		if (socket !== null) {
			socket.on('error', () => undefined);
			onSocket?.(socket);
		}
	});
	return calls;
}

const GREETED = Buffer.from([0x05, 0x00]);

async function main(): Promise<void> {
	console.log('\n── canary SOCKS connector smoke (v1.18.0 deep-deep, L1) ──\n');

	// 1. Settles exactly once, even when a pooled tunnel errors later.
	{
		let server: net.Socket | undefined;
		const port = await listen((s) => {
			server = s;
			s.on('error', () => undefined);
			s.once('data', () => {
				s.write(GREETED);
				s.once('data', () => s.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])));
			});
		});
		const calls = connect(port);
		await until(() => calls.length > 0, 3_000);
		server?.resetAndDestroy();
		await until(() => calls.length > 1, 300);
		check(
			'the connect callback fires exactly once (a dead pooled tunnel does not fire it again)',
			calls.length === 1 && calls[0]!.err === null
		);
	}

	// 2. A proxy that closes mid-handshake is known at once.
	{
		const port = await listen((s) => {
			s.once('data', () => s.destroy());
		});
		const started = performance.now();
		const calls = connect(port);
		await until(() => calls.length > 0, 3_000);
		check(
			'a proxy that hangs up during the greeting fails the connect at once (not after 20 s)',
			calls.length === 1 && calls[0]!.err !== null && performance.now() - started < 2_000
		);
	}

	// 3. A domain-typed CONNECT reply, split, with HTTP bytes glued on.
	{
		const domain = Buffer.from('relay.example');
		const port = await listen((s) => {
			s.once('data', () => {
				s.write(GREETED);
				s.once('data', () => {
					const reply = Buffer.concat([
						Buffer.from([0x05, 0x00, 0x00, 0x03, domain.length]),
						domain,
						Buffer.from([0x01, 0xbb])
					]);
					s.write(reply.subarray(0, 8));
					setImmediate(() => s.write(Buffer.concat([reply.subarray(8), Buffer.from('HTTP/1.1')])));
				});
			});
		});
		let got = '';
		const calls = connect(port, (sock) => sock.once('data', (d: Buffer) => (got = d.toString())));
		await until(() => got !== '' || (calls.length > 0 && calls[0]!.err !== null), 3_000);
		check(
			'a domain-address reply leaves nothing in front of the tunnelled bytes',
			got === 'HTTP/1.1'
		);
	}

	// 4. Bytes that arrive in the same segment as an IPv4 reply are kept.
	{
		const port = await listen((s) => {
			s.once('data', () => {
				s.write(GREETED);
				s.once('data', () =>
					s.write(
						Buffer.concat([
							Buffer.from([0x05, 0x00, 0x00, 0x01, 1, 2, 3, 4, 0x01, 0xbb]),
							Buffer.from('HTTP/1.1')
						])
					)
				);
			});
		});
		let got = '';
		connect(port, (sock) => sock.once('data', (d: Buffer) => (got = d.toString())));
		await until(() => got !== '', 3_000);
		check('bytes that arrive with the reply reach the consumer', got === 'HTTP/1.1');
	}

	for (const s of servers) s.close();
	console.log('');
	if (fails.length > 0) {
		console.error(`✗ ${fails.length} canary SOCKS connector check(s) failed`);
		process.exit(1);
	}
	console.log(`✓ all ${pass} canary SOCKS connector checks passed`);
	process.exit(0);
}

void main();
