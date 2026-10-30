/**
 * treasury-repin-broadcast.ts runs on a SERVER too: ops/systemd/
 * morphit-treasury-repin.service (via ops/scripts/morphit-treasury-repin.sh,
 * from /opt/morphit/apps/indexer). A re-pin needs clearnet — prices from
 * CoinGecko / CoinPaprika / Kraken, the release op from clearnet Blurt nodes —
 * so on a hidden-only server it must stop before asking anything (v1.21.18
 * review: it asked the indexer, the price sources and the clearnet RPC nodes
 * whatever the server's settings said). The REAL script runs, the way the unit
 * runs it, against a stand-in "indexer" that records every request.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const ROOT = resolve(APP, '../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

const servers: Server[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

/** A stand-in indexer; `asked` lists every request it got. */
async function indexer(): Promise<{ url: string; asked: string[] }> {
	const asked: string[] = [];
	const srv = createServer((q, r) => {
		asked.push(q.url ?? '');
		r.statusCode = 503;
		r.end('{}');
	});
	servers.push(srv);
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
	return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, asked };
}

/** A server root with `indexerEnv` as /etc/morphit/indexer.env (null: a
 *  file this user cannot read), and an `ipfs` that knows nothing. */
function server(indexerEnv: string | null): NodeJS.ProcessEnv {
	const root = mkdtempSync(join(tmpdir(), 'morphit-repin-'));
	mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
	const f = join(root, 'etc', 'morphit', 'indexer.env');
	if (indexerEnv === null) mkdirSync(f);
	else writeFileSync(f, indexerEnv);
	const bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'ipfs'), '#!/bin/sh\nexit 1\n');
	chmodSync(join(bin, 'ipfs'), 0o755);
	return {
		...process.env,
		MORPHIT_ENV_ROOT: root,
		PATH: `${bin}:${process.env.PATH ?? ''}`,
		MORPHIT_REPIN_HIDDEN_ONLY: ''
	};
}

function run(
	args: string[],
	env: NodeJS.ProcessEnv,
	script = 'scripts/treasury-repin-broadcast.ts'
): Promise<{ status: number | null; stderr: string }> {
	return new Promise((done) => {
		const p = spawn(TSX, ['--tsconfig', '../../tsconfig.smoke.json', script, ...args], {
			cwd: APP,
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stderr = '';
		p.stderr.on('data', (d) => (stderr += String(d)));
		const t = setTimeout(() => p.kill('SIGKILL'), 60_000);
		p.on('close', (status) => {
			clearTimeout(t);
			done({ status, stderr });
		});
	});
}

describe('treasury-repin-broadcast on a server', () => {
	it('hidden-only (an empty clearnet RPC pool): stops before asking anything', async () => {
		const ix = await indexer();
		const r = await run(
			['--node', ix.url, '--dry-run'],
			server('MORPHIT_INDEXER_RPC_ENDPOINTS=   # tor-only\n')
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/This server is hidden-only/);
		expect(ix.asked).toEqual([]);
	}, 90_000);

	it('settings this user cannot read: stops, asks nothing, and says how to declare a clearnet server', async () => {
		const ix = await indexer();
		const r = await run(['--node', ix.url, '--dry-run'], server(null));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"echo 'MORPHIT_REPIN_HIDDEN_ONLY=no' | sudo tee -a /etc/morphit/treasury-repin.env"
		);
		expect(ix.asked).toEqual([]);
	}, 90_000);

	it('a clearnet server goes on to ask its indexer', async () => {
		const ix = await indexer();
		const r = await run(
			['--node', ix.url, '--dry-run'],
			server('MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org\n')
		);
		expect(ix.asked).toEqual(['/v1/release']);
		expect(r.status).toBe(1); // the stand-in answers 503: "could not fetch", nothing else
	}, 90_000);

	it('its usage names --no-hidden and --include-hidden', async () => {
		const r = await run([], server('MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org\n'));
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/--no-hidden \| --include-hidden/);
	}, 90_000);
});

/** The DEFAULT (detect-only) path of the unit: treasury-repin-check.ts. It
 *  asks clearnet too (CoinGecko / CoinPaprika / Kraken, and by default a
 *  clearnet indexer), so it stops the same way. */
describe('treasury-repin-check (the detect-only default) on a server', () => {
	const CHECK = 'scripts/treasury-repin-check.ts';
	it('hidden-only: stops before asking anything', async () => {
		const ix = await indexer();
		const r = await run(['--node', ix.url], server('MORPHIT_INDEXER_RPC_ENDPOINTS=\n'), CHECK);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/This server is hidden-only/);
		expect(r.stderr).toMatch(/prices from CoinGecko, CoinPaprika and Kraken/);
		expect(ix.asked).toEqual([]);
	}, 90_000);

	it('settings this user cannot read: stops, asks nothing, and names the exact line to add', async () => {
		const ix = await indexer();
		const r = await run(['--node', ix.url], server(null), CHECK);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"echo 'MORPHIT_REPIN_HIDDEN_ONLY=no' | sudo tee -a /etc/morphit/treasury-repin.env"
		);
		expect(ix.asked).toEqual([]);
	}, 90_000);

	it('a clearnet server goes on to ask its indexer', async () => {
		const ix = await indexer();
		const r = await run(
			['--node', ix.url],
			server('MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.org\n'),
			CHECK
		);
		expect(ix.asked).toEqual(['/v1/release']);
		expect(r.status).toBe(1); // the stand-in answers 503: "could not fetch", nothing else
	}, 90_000);

	it('the unit’s wrapper says the server is hidden-only, not "could not fetch (transient)"', async () => {
		const w = mkdtempSync(join(tmpdir(), 'morphit-repin-wrap-'));
		const bin = join(w, 'bin');
		mkdirSync(bin);
		mkdirSync(join(w, 'indexer'));
		// A stand-in npx that answers as the check does on a hidden-only server.
		writeFileSync(
			join(bin, 'npx'),
			"#!/bin/sh\necho '✗ This server is hidden-only (its indexer.env has no clearnet Blurt RPC nodes' >&2\nexit 1\n"
		);
		chmodSync(join(bin, 'npx'), 0o755);
		const r = await new Promise<{ status: number | null; stdout: string }>((done) => {
			const p = spawn('sh', [resolve(ROOT, 'ops/scripts/morphit-treasury-repin.sh')], {
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ''}`,
					MORPHIT_INDEXER_DIR: join(w, 'indexer'),
					JOURNAL_STREAM: 'test',
					MORPHIT_EMIT_DEDUP: '0'
				},
				stdio: ['ignore', 'pipe', 'pipe']
			});
			let stdout = '';
			p.stdout.on('data', (d) => (stdout += String(d)));
			p.on('close', (status) => done({ status, stdout }));
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/"event":"treasury_repin_check_failed"/);
		expect(r.stdout).toMatch(
			/this server is hidden-only: the re-pin check needs clearnet, so it asked nothing/
		);
		expect(r.stdout).not.toMatch(/transient/);
	}, 30_000);
});
