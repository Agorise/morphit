/**
 * The indexer no longer runs as root, so it cannot read the matrix bot's env
 * file (it holds the bot's access token). It reads the secret-free posture
 * file the installer writes, /etc/morphit/matrix-bot.posture, first, and the
 * bot's env only when that does not exist.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { parseSocksProxy, socksConnect } from '../../../matrix-bot/src/socksAgent.ts';

import {
	currentMatrixBotPosture,
	matrixBotIsClean,
	matrixBotPostureFromEnvText,
	_setMatrixBotEnvPathForTesting,
	_setMatrixBotPosturePathForTesting
} from '$indexer/clearnetGate';

const dir = mkdtempSync(join(tmpdir(), 'mxposture-'));
/** A path that exists but cannot be read as a file — what an unreadable
 *  0640 file looks like to a process outside its group (EISDIR, not ENOENT). */
const UNREADABLE = dir;

function posture(text: string | null): void {
	const p = join(dir, `posture-${Math.random()}`);
	if (text !== null) writeFileSync(p, text);
	_setMatrixBotPosturePathForTesting(p);
}

afterEach(() => {
	_setMatrixBotPosturePathForTesting(null);
	_setMatrixBotEnvPathForTesting(null);
});

describe('matrix bot posture for the clearnet gate', () => {
	it('posture says no bot: clean, even though the bot env is unreadable to us', () => {
		_setMatrixBotEnvPathForTesting(UNREADABLE);
		posture('MORPHIT_MATRIX_BOT_ALERT_MXID=\nMORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n');
		const p = currentMatrixBotPosture(Date.now() + 10 * 60_000);
		expect(p).toEqual({ state: 'inert' });
		expect(matrixBotIsClean(p)).toBe(true);
	});

	it('posture says a bot on a clearnet homeserver: not clean', () => {
		_setMatrixBotEnvPathForTesting(UNREADABLE);
		posture(
			'MORPHIT_MATRIX_BOT_ALERT_MXID=configured\nMORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n'
		);
		const p = currentMatrixBotPosture(Date.now() + 20 * 60_000);
		expect(p).toEqual({ state: 'active', homeserver: 'https://matrix.org' });
		expect(matrixBotIsClean(p)).toBe(false);
	});

	it('no posture file and an unreadable bot env: unknown, never clean', () => {
		_setMatrixBotEnvPathForTesting(UNREADABLE);
		posture(null);
		const p = currentMatrixBotPosture(Date.now() + 30 * 60_000);
		expect(p).toEqual({ state: 'unknown' });
		expect(matrixBotIsClean(p)).toBe(false);
	});
	it('a .onion homeserver through Tor on this box (what a tor-only install writes): clean', () => {
		const onion = 'http://' + 'a'.repeat(56) + '.onion';
		const p = matrixBotPostureFromEnvText(
			`MORPHIT_MATRIX_BOT_ALERT_MXID=configured\nMORPHIT_MATRIX_BOT_HOMESERVER=${onion}\nMORPHIT_MATRIX_BOT_SOCKS_PROXY=socks5h://127.0.0.1:9050\n`
		);
		expect(matrixBotIsClean(p)).toBe(true);
	});

	it('socks5:// on this box is clean too: the bot hands Tor the NAME for both schemes', async () => {
		// What the bot really does with each scheme it accepts (its own code):
		// a stand-in proxy records the address type of the CONNECT request.
		const seen: number[] = [];
		const server = net.createServer((sock) => {
			let stage = 0;
			sock.on('data', (b) => {
				if (stage === 0) {
					stage = 1;
					sock.write(Buffer.from([5, 0]));
					return;
				}
				seen.push(b[3]!);
				sock.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
			});
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as net.AddressInfo).port;
		const onion = 'a'.repeat(56) + '.onion';
		try {
			for (const scheme of ['socks5', 'socks5h']) {
				const proxy = parseSocksProxy(`${scheme}://127.0.0.1:${port}`);
				expect(proxy, scheme).not.toBeNull();
				await socksConnect(proxy!, onion, 80).catch(() => undefined);
				const p = matrixBotPostureFromEnvText(
					`MORPHIT_MATRIX_BOT_ALERT_MXID=configured\nMORPHIT_MATRIX_BOT_HOMESERVER=http://${onion}\nMORPHIT_MATRIX_BOT_SOCKS_PROXY=${scheme}://127.0.0.1:9050\n`
				);
				expect(matrixBotIsClean(p), scheme).toBe(true);
			}
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
		// Address type 3 (a domain name) both times: resolved by Tor, not here.
		expect(seen).toEqual([3, 3]);
	});

	it('a .onion homeserver without that proxy, or a proxy that is not on this box: not clean', () => {
		const onion = 'http://' + 'a'.repeat(56) + '.onion';
		const env = (socks: string): string =>
			`MORPHIT_MATRIX_BOT_ALERT_MXID=configured\nMORPHIT_MATRIX_BOT_HOMESERVER=${onion}\n` +
			(socks === '' ? '' : `MORPHIT_MATRIX_BOT_SOCKS_PROXY=${socks}\n`);
		expect(matrixBotIsClean(matrixBotPostureFromEnvText(env('')))).toBe(false);
		expect(matrixBotIsClean(matrixBotPostureFromEnvText(env('socks5h://203.0.113.9:9050')))).toBe(
			false
		);
		expect(matrixBotIsClean(matrixBotPostureFromEnvText(env('socks5://203.0.113.9:9050')))).toBe(
			false
		);
		expect(matrixBotIsClean(matrixBotPostureFromEnvText(env('socks4://127.0.0.1:9050')))).toBe(
			false
		);
		// A clearnet homeserver is not made clean by the proxy.
		expect(
			matrixBotIsClean(
				matrixBotPostureFromEnvText(
					'MORPHIT_MATRIX_BOT_ALERT_MXID=configured\nMORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\nMORPHIT_MATRIX_BOT_SOCKS_PROXY=socks5h://127.0.0.1:9050\n'
				)
			)
		).toBe(false);
	});
});
