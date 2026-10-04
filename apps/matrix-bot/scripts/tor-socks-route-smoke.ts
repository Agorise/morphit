#!/usr/bin/env tsx
/**
 * tor-socks-route-smoke — the Matrix alert bot on a tor-only node.
 *
 * The bot had no proxy support at all: on a tor-only install it connected to
 * its homeserver (matrix.org by default) from the box's own address, logged
 * in as the bot, and DMed the operator's personal MXID — the homeserver could
 * link that address to the operator, which is what tor-only exists to prevent.
 *
 * Now:
 *   1. MORPHIT_MATRIX_BOT_TOR_ONLY=1 refuses (at config time) any homeserver
 *      that is neither loopback nor a .onion reached through
 *      MORPHIT_MATRIX_BOT_SOCKS_PROXY.
 *   2. An http://….onion homeserver is accepted when a SOCKS proxy is set
 *      (Tor encrypts end to end), and every request the Matrix SDK makes goes
 *      through that proxy with the NAME handed to the proxy (no local DNS).
 *
 * A fake SOCKS5 proxy and a fake homeserver on loopback stand in for Tor.
 */

import http from 'node:http';
import net from 'node:net';
import { parseConfig } from '../src/config.ts';
import * as matrix from '../src/matrix.ts';

let failures = 0;
let n = 0;
function check(name: string, cond: boolean, detail = ''): void {
	n++;
	if (cond) console.log(`  \u2713 ${name}`);
	else {
		failures++;
		console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
	}
}

const ONION = `${'a'.repeat(56)}.onion`;
const base = {
	MORPHIT_MATRIX_BOT_ACCESS_TOKEN: 'syt_token',
	MORPHIT_MATRIX_BOT_ALERT_MXID: '@op:example.org'
};
const parses = (env: Record<string, string>): string => {
	try {
		parseConfig({ ...base, ...env } as NodeJS.ProcessEnv);
		return 'ok';
	} catch (err) {
		return (err as Error).message.slice(0, 160);
	}
};

console.log('tor-socks-route-smoke');

// ─── config rules ───
check(
	'tor-only + a clearnet homeserver is refused',
	parses({
		MORPHIT_MATRIX_BOT_TOR_ONLY: '1',
		MORPHIT_MATRIX_BOT_HOMESERVER: 'https://matrix.org'
	}) !== 'ok'
);
check(
	'tor-only + the default homeserver (matrix.org) is refused',
	parses({ MORPHIT_MATRIX_BOT_TOR_ONLY: '1' }) !== 'ok'
);
check(
	'tor-only + a .onion homeserver WITHOUT a SOCKS proxy is refused',
	parses({ MORPHIT_MATRIX_BOT_TOR_ONLY: '1', MORPHIT_MATRIX_BOT_HOMESERVER: `http://${ONION}` }) !==
		'ok'
);
const onionOk = parses({
	MORPHIT_MATRIX_BOT_TOR_ONLY: '1',
	MORPHIT_MATRIX_BOT_HOMESERVER: `http://${ONION}`,
	MORPHIT_MATRIX_BOT_SOCKS_PROXY: 'socks5h://127.0.0.1:9050'
});
check(
	'tor-only + a .onion homeserver through a SOCKS proxy is accepted',
	onionOk === 'ok',
	onionOk
);
const loopOk = parses({
	MORPHIT_MATRIX_BOT_TOR_ONLY: '1',
	MORPHIT_MATRIX_BOT_HOMESERVER: 'http://127.0.0.1:8008'
});
check('tor-only + a loopback homeserver is accepted', loopOk === 'ok', loopOk);
check(
	'a clearnet node keeps https://matrix.org',
	parses({ MORPHIT_MATRIX_BOT_HOMESERVER: 'https://matrix.org' }) === 'ok'
);

// ─── the SDK's requests go through the proxy, by name ───
const homeserver = http.createServer((req, res) => {
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ versions: ['v1.1'], path: req.url, host: req.headers.host }));
});
await new Promise<void>((r) => homeserver.listen(0, '127.0.0.1', r));
const hsPort = (homeserver.address() as net.AddressInfo).port;
const asked: string[] = [];
const socks = net.createServer((client) => {
	client.once('data', (greeting) => {
		if (greeting[0] !== 5) {
			client.destroy();
			return;
		}
		client.write(Buffer.from([5, 0]));
		client.once('data', (req) => {
			// VER CMD RSV ATYP=3 LEN NAME PORT
			const len = req[4]!;
			const host = req.subarray(5, 5 + len).toString();
			asked.push(`${req[3]}:${host}:${req.readUInt16BE(5 + len)}`);
			const up = net.connect(hsPort, '127.0.0.1', () => {
				client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
				client.pipe(up).pipe(client);
			});
			up.on('error', () => client.destroy());
		});
	});
});
await new Promise<void>((r) => socks.listen(0, '127.0.0.1', r));
const socksPort = (socks.address() as net.AddressInfo).port;

let body: unknown = null;
let error = '';
try {
	const install = (matrix as { installMatrixProxy?: (p: string | undefined) => void })
		.installMatrixProxy;
	install?.(`socks5h://127.0.0.1:${socksPort}`);
	const { doHttpRequest } = (await import('matrix-bot-sdk/lib/http.js')) as unknown as {
		doHttpRequest: (b: string, m: string, e: string) => Promise<unknown>;
	};
	body = await doHttpRequest(`http://${ONION}`, 'GET', '/_matrix/client/versions');
} catch (err) {
	error = err instanceof Error ? err.message : String(err);
}
check(
	'a request to the .onion homeserver went through the SOCKS proxy, by name (no local DNS)',
	asked.length > 0 &&
		asked[0] === `3:${ONION}:80` &&
		(body as { versions?: unknown })?.versions !== undefined,
	`asked=${asked.join(',')} error=${error.slice(0, 120)}`
);

homeserver.close();
socks.close();
console.log();
if (failures > 0) {
	console.error(`\u2717 ${failures} of ${n} tor-socks route checks failed`);
	process.exit(1);
}
console.log(`\u2713 all ${n} tor-socks route checks passed`);
process.exit(0);
