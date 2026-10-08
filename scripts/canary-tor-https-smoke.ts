#!/usr/bin/env tsx
/**
 * scripts/canary-tor-https-smoke.ts
 *
 * On a Tor-only box the canary's Bitcoin head comes from https:// explorers
 * reached THROUGH Tor (a Tor exit to clearnet). morphitlat, 2026-10-07: every
 * explorer "fetch failed" in the same second — the shared SOCKS connector the
 * canary installs refuses https: on purpose (it is built for .onion/.b32.i2p,
 * which carry plain HTTP), so no Bitcoin head could ever be fetched over Tor and
 * every Tor-only canary said "btc_head=(unavailable…)".
 *
 * Runs the REAL scripts/canary/fetch-btc-head.ts in a child process, Tor-only,
 * against a SOCKS5 stand-in that tunnels to a local HTTPS explorer whose
 * certificate names the explorer's host. Checks: the head arrives; the proxy
 * was asked for the HOST NAME (resolved proxy-side, no DNS from the box); the
 * certificate is still verified (a wrong name fails); a .onion https URL is
 * still refused.
 */
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCanaryTorConnector } from './canary/torSocksDispatcher.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
let pass = 0;
const fails: string[] = [];
const check = (d: string, ok: boolean, extra = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${d}`);
	} else {
		fails.push(d);
		console.log(`  ✗ ${d}${extra ? `\n      ${extra}` : ''}`);
	}
};

const HOST = 'btc-explorer.example';
const HEIGHT = '970394';
const HASH = '00000000000000000001'.padEnd(64, 'a');

async function main(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'canary-tor-https-'));
	const cert = join(dir, 'cert.pem');
	const key = join(dir, 'key.pem');
	const gen = spawnSync('openssl', [
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-days',
		'1',
		'-subj',
		`/CN=${HOST}`,
		'-addext',
		`subjectAltName=DNS:${HOST}`,
		'-keyout',
		key,
		'-out',
		cert
	]);
	check(
		'openssl made a test certificate for the explorer host',
		gen.status === 0,
		String(gen.stderr)
	);

	// The explorer (esplora shape).
	const explorer = https.createServer(
		{ cert: readFileSync(cert), key: readFileSync(key) },
		(req, res) => {
			if (req.url?.endsWith('/blocks/tip/height')) return void res.end(HEIGHT);
			if (req.url?.endsWith('/blocks/tip/hash')) return void res.end(HASH);
			res.statusCode = 404;
			res.end();
		}
	);
	await new Promise<void>((r) => explorer.listen(0, '127.0.0.1', () => r()));
	const explorerPort = (explorer.address() as net.AddressInfo).port;

	// A SOCKS5 stand-in for Tor: no auth, CONNECT by domain name only, then a
	// byte pipe to the explorer. It records what it was asked to reach.
	const asked: string[] = [];
	const socks = net.createServer((c) => {
		let stage = 0;
		let buf = Buffer.alloc(0);
		c.on('data', (d) => {
			if (stage === 2) return;
			buf = Buffer.concat([buf, d]);
			if (stage === 0 && buf.length >= 3) {
				buf = buf.subarray(2 + (buf[1] ?? 0));
				c.write(Buffer.from([0x05, 0x00]));
				stage = 1;
			}
			if (stage === 1 && buf.length >= 5) {
				if (buf[3] !== 0x03) {
					asked.push('NOT-A-DOMAIN');
					c.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					return;
				}
				const len = buf[4]!;
				if (buf.length < 5 + len + 2) return;
				const host = buf.subarray(5, 5 + len).toString();
				const port = buf.readUInt16BE(5 + len);
				asked.push(`${host}:${port}`);
				const rest = buf.subarray(5 + len + 2);
				stage = 2;
				c.removeAllListeners('data');
				const up = net.connect(explorerPort, '127.0.0.1', () => {
					c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
					if (rest.length) up.write(rest);
					c.pipe(up).pipe(c);
				});
				up.on('error', () => c.destroy());
				c.on('error', () => up.destroy());
			}
		});
	});
	await new Promise<void>((r) => socks.listen(0, '127.0.0.1', () => r()));
	const socksPort = (socks.address() as net.AddressInfo).port;

	const run = (explorerUrl: string): Promise<{ code: number | null; out: string; err: string }> =>
		new Promise((resolve) => {
			const child = spawn(TSX, [join(REPO, 'scripts', 'canary', 'fetch-btc-head.ts')], {
				cwd: REPO,
				env: {
					...process.env,
					MORPHIT_CANARY_TOR_ONLY: '1',
					MORPHIT_CANARY_TOR_SOCKS: `127.0.0.1:${socksPort}`,
					MORPHIT_CANARY_BTC_EXPLORER: explorerUrl,
					NODE_EXTRA_CA_CERTS: cert,
					// Nothing may go around the stand-in.
					HTTPS_PROXY: '',
					HTTP_PROXY: '',
					https_proxy: '',
					http_proxy: '',
					NO_PROXY: ''
				}
			});
			let out = '';
			let err = '';
			child.stdout.on('data', (d) => (out += d));
			child.stderr.on('data', (d) => (err += d));
			const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
			child.on('close', (code) => {
				clearTimeout(kill);
				resolve({ code, out, err });
			});
		});

	const ok = await run(`https://${HOST}:${explorerPort}/api`);
	check(
		'Tor-only: the Bitcoin head comes back from an https:// explorer through the SOCKS proxy',
		ok.code === 0 && ok.out.trim() === `${HEIGHT}\t${HASH}`,
		ok.err.trim().split('\n').slice(-4).join(' | ')
	);
	check(
		'the proxy was asked for the explorer by NAME (resolved by Tor, no DNS from the box)',
		asked.length > 0 && asked.every((a) => a === `${HOST}:${explorerPort}`),
		asked.join(', ')
	);

	const wrongName = await run(`https://wrong-${HOST}:${explorerPort}/api`);
	check(
		'the explorer certificate is still verified: a certificate for another name is refused',
		wrongName.code !== 0 &&
			wrongName.out.trim() === '' &&
			/altname|certificate|ERR_TLS_CERT/i.test(wrongName.err),
		wrongName.err.trim().split('\n').slice(-2).join(' | ')
	);

	// A Tor exit that takes the connection and never answers TLS: the
	// connector must give up within its handshake limit and close the tunnel
	// (undici gives a custom connector no timeout, and a fetch abort does not
	// stop a connect under way — the helper process stayed alive).
	{
		let closed = false;
		const silent = net.createServer((c) => {
			c.resume(); // read (and drop) what arrives, so the peer's close is seen
			c.on('close', () => (closed = true));
			c.on('error', () => undefined);
		});
		await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
		const silentPort = (silent.address() as net.AddressInfo).port;
		const relay = net.createServer((c) => {
			let stage = 0;
			let buf = Buffer.alloc(0);
			c.on('error', () => undefined);
			c.on('data', (d) => {
				if (stage === 2) return;
				buf = Buffer.concat([buf, d]);
				if (stage === 0 && buf.length >= 3) {
					buf = buf.subarray(2 + (buf[1] ?? 0));
					c.write(Buffer.from([0x05, 0x00]));
					stage = 1;
				}
				if (stage === 1 && buf.length >= 7) {
					stage = 2;
					c.removeAllListeners('data');
					const up = net.connect(silentPort, '127.0.0.1', () => {
						c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
						c.pipe(up).pipe(c);
					});
					up.on('error', () => c.destroy());
					c.on('close', () => up.destroy());
				}
			});
		});
		await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
		const relayPort = (relay.address() as net.AddressInfo).port;
		const t0 = Date.now();
		const res = await new Promise<{ err: Error | null; ms: number }>((resolveRes) => {
			makeCanaryTorConnector(
				'127.0.0.1',
				relayPort,
				1500
			)({ hostname: HOST, port: 443, protocol: 'https:' }, (err) =>
				resolveRes({ err, ms: Date.now() - t0 })
			);
			setTimeout(() => resolveRes({ err: null, ms: -1 }), 10_000);
		});
		for (let i = 0; i < 50 && !closed; i++) await new Promise((r) => setTimeout(r, 20));
		check(
			'a TLS handshake that never answers is given up within the limit, and the tunnel is closed',
			res.err !== null &&
				res.ms > 0 &&
				res.ms < 5_000 &&
				/no TLS answer/.test(res.err.message) &&
				closed,
			`err=${res.err?.message} ms=${res.ms} closed=${closed}`
		);
		silent.close();
		relay.close();
	}

	const onion = await run(`https://${'a'.repeat(56)}.onion/api`);
	check(
		'an https:// .onion explorer is still refused (Tor carries plain HTTP to onions)',
		onion.code !== 0 && /https:\/\/ for hidden-network host|refusing https/i.test(onion.err),
		onion.err.trim().split('\n').slice(-3).join(' | ')
	);

	explorer.close();
	socks.close();
	rmSync(dir, { recursive: true, force: true });
	console.log('');
	if (fails.length === 0) console.log(`✓ all ${pass} canary-tor-https scenarios passed`);
	else {
		console.error(`✗ ${fails.length} of ${pass + fails.length} canary-tor-https checks FAILED`);
		process.exit(1);
	}
}
void main();
