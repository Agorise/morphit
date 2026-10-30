/**
 * The relay does not wait for its first key check before it serves.
 *
 * main.ts used to await the check (up to 30 s) before it listened: while the
 * chain answered slowly, health, name checks and Web Push were all down — for
 * a check whose "not done yet" state refuses nothing anyway (review,
 * 2026-10-29). The real entry point is run, as the unit runs it, against a
 * stand-in Blurt node reached over a stand-in Tor that answers everything but
 * never answers the key check's get_accounts. No database is reachable: the
 * relay starts and serves health without one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { fakeSocks } from './notifyFakes.ts';

const RELAY = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'relay-boot-nowait-'));
const closers: Array<() => unknown> = [];
let child: ChildProcess | null = null;
afterAll(async () => {
	child?.kill('SIGKILL');
	for (const c of closers) await c();
	rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, '127.0.0.1', () => {
			const p = (s.address() as net.AddressInfo).port;
			s.close(() => resolve(p));
		});
	});
}

describe('relay start: the key check runs in the background', () => {
	it('serves /v1/health while the chain has not answered the key check', async () => {
		let keyChecks = 0;
		const node = http.createServer((req, res) => {
			let b = '';
			req.on('data', (d) => (b += d));
			req.on('end', () => {
				let j: { id?: number; method?: string } = {};
				try {
					j = JSON.parse(b) as typeof j;
				} catch {
					/* not JSON-RPC */
				}
				if (String(j.method).endsWith('get_accounts')) {
					keyChecks++;
					return; // never answered
				}
				res.setHeader('content-type', 'application/json');
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: j.id,
						result: String(j.method).endsWith('get_dynamic_global_properties')
							? {
									head_block_number: 1,
									head_block_id: '00'.repeat(20),
									time: new Date().toISOString().slice(0, 19),
									last_irreversible_block_num: 1
								}
							: null
					})
				);
			});
		});
		await new Promise<void>((r) => node.listen(0, '127.0.0.1', () => r()));
		closers.push(() => {
			node.closeAllConnections();
			node.close();
		});
		const nodePort = (node.address() as net.AddressInfo).port;
		const socks = await fakeSocks();
		closers.push(() => socks.close());
		const port = await freePort();
		const keyFile = join(dir, 'relay.keystore');
		writeFileSync(keyFile, PrivateKey.fromSeed('relay-boot-nowait').toString());
		chmodSync(keyFile, 0o600);
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? '',
			HOME: dir,
			MORPHIT_LOG_FORMAT: 'text',
			MORPHIT_RELAY_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none',
			MORPHIT_RELAY_ACCOUNT: 'relayacct',
			MORPHIT_RELAY_ACTIVE_KEY_FILE: keyFile,
			MORPHIT_RELAY_BLURT_RPC: '',
			MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS: `http://${'a'.repeat(56)}.onion:${nodePort}`,
			MORPHIT_RELAY_TOR_SOCKS: `127.0.0.1:${socks.port}`,
			MORPHIT_RELAY_I2P_HTTP_PROXY: '',
			MORPHIT_RELAY_INVITE_HMAC_SECRET: 'i'.repeat(64),
			MORPHIT_RELAY_ALTCHA_HMAC_SECRET: 'a'.repeat(64),
			MORPHIT_RELAY_LISTEN_HOST: '127.0.0.1',
			MORPHIT_RELAY_LISTEN_PORT: String(port),
			MORPHIT_RELAY_DATA_DIR: join(dir, 'data'),
			MORPHIT_RPC_HEALTH_STATE: join(dir, 'rpc-health.json')
		};
		let log = '';
		child = spawn(join(RELAY, '..', '..', 'node_modules', '.bin', 'tsx'), ['src/main.ts'], {
			cwd: RELAY,
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		child.stdout?.on('data', (d) => (log += String(d)));
		child.stderr?.on('data', (d) => (log += String(d)));

		const t0 = Date.now();
		// A real child process: poll (vi.waitFor) until it serves health.
		let body: Record<string, unknown> | null = null;
		try {
			body = await vi.waitFor(
				async () => {
					const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
						headers: { 'x-morphit-local-health': '1' },
						signal: AbortSignal.timeout(1_000)
					});
					return (await res.json()) as Record<string, unknown>;
				},
				{ timeout: 25_000, interval: 250 }
			);
		} catch {
			body = null;
		}
		const tookMs = Date.now() - t0;
		expect(body, log).not.toBeNull();
		// Served long before a 30 s wait could have ended, while the key check
		// was asked and is still unanswered.
		expect(tookMs, log).toBeLessThan(20_000);
		expect(keyChecks, log).toBeGreaterThan(0);
		expect((body!.active_key as { state?: unknown } | undefined)?.state).toBe('unchecked');
	}, 60_000);
});
