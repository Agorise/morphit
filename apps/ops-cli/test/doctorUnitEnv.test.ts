/**
 * `morphit-ops doctor` checks the node the way its systemd units start it.
 *
 * Review, 2026-10-29, on an Ansible node:
 *  - the launcher runs the CLI from /opt/morphit/apps/ops-cli, and doctor took
 *    that folder as the install: "This does not look like a Morphit install
 *    directory … run init";
 *  - it sourced only morphit.env, while the units also source
 *    /etc/morphit/indexer.env (indexer) and relay.env, relay-vapid.env,
 *    relay-notify.env (relay): a healthy node read "will NOT start … Required";
 *  - any failed schema run read "drift detected", even when the check never ran;
 *  - the RPC probe read neither those files nor the hidden lists;
 *  - root:morphit 0640 — what the services' pre-start helper sets — was a
 *    "group/other can read it" warning;
 *  - the closing advice was always `cd apps/indexer && npm start` or "morphit.env
 *    / init", whatever had happened.
 *
 * `npm` is a stand-in on PATH: run as `npm start -- --check-config` it records
 * the MORPHIT_* settings it was started with and fails like the real service
 * when a required one is missing; as `--check-schema` it answers from a file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	chmodSync,
	chownSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	existsSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctor } from '../src/commands/doctor.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const GID = 4711;

let dir = '';
let install = '';
const PATH = process.env.PATH;
let server: http.Server | null = null;
let rpcHits: string[] = [];
let rpcUrl = '';

function put(path: string, body: string, mode = 0o600): void {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, body, { mode });
	chmodSync(path, mode);
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'doctor-unit-'));
	install = join(dir, 'install');
	mkdirSync(join(install, 'apps', 'indexer'), { recursive: true });
	mkdirSync(join(install, 'apps', 'relay'), { recursive: true });
	mkdirSync(join(dir, 'bin'));
	put(join(dir, 'etc', 'group'), `morphit:x:${GID}:\nmorphit-relay:x:${GID + 1}:\n`, 0o644);
	put(join(dir, 'schema-out'), '[check-schema] database schema matches this version\n', 0o644);
	put(join(dir, 'schema-rc'), '0\n', 0o644);
	writeFileSync(
		join(dir, 'bin', 'npm'),
		[
			'#!/bin/sh',
			`D=${dir}`,
			'svc=$(basename "$PWD")',
			'if [ "$3" = --check-schema ]; then cat "$D/schema-out"; exit $(cat "$D/schema-rc"); fi',
			'env | grep "^MORPHIT_" | sort > "$D/seen-$svc"',
			'if [ "$svc" = indexer ]; then',
			'  [ -n "$MORPHIT_INDEXER_CHAIN_ID" ] || { echo "Error: config validation failed:"; echo "  - MORPHIT_INDEXER_CHAIN_ID: Required"; exit 1; }',
			'  echo "[check-config] indexer config OK"; exit 0',
			'fi',
			'[ -n "$MORPHIT_RELAY_ACCOUNT" ] || { echo "Error: Invalid relay configuration:"; echo "  MORPHIT_RELAY_ACCOUNT: Required"; exit 1; }',
			'echo "[check-config] relay config OK"; exit 0',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${join(dir, 'bin')}:${PATH}`;
	rpcHits = [];
	server = http.createServer((q, r) => {
		let body = '';
		q.on('data', (b) => (body += String(b)));
		q.on('end', () => {
			rpcHits.push(`${q.method} ${q.url}`);
			r.setHeader('content-type', 'application/json');
			if ((q.url ?? '').includes('federation')) {
				r.statusCode = 400;
				r.end('{}');
				return;
			}
			const id = (JSON.parse(body || '{}') as { id?: number }).id ?? 1;
			r.end(JSON.stringify({ jsonrpc: '2.0', id, result: { head_block_number: 123 } }));
		});
	});
	await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
	rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	process.env.PATH = PATH;
	vi.restoreAllMocks();
	delete process.env.MORPHIT_ONLY_IN_MY_SHELL;
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	server = null;
	rmSync(dir, { recursive: true, force: true });
});

/** A node laid out like an Ansible install: little in morphit.env, the rest in
 *  /etc/morphit (under the test's root). */
function ansibleNode(o: { indexerEnv?: string } = {}): void {
	put(join(install, 'morphit.env'), 'MORPHIT_RELAY_ACTIVE_KEY_FILE=/nonexistent/relay.keystore\n');
	put(join(install, 'morphit.config.env'), '# operator settings\n');
	put(
		join(dir, 'etc', 'morphit', 'indexer.env'),
		o.indexerEnv ??
			[
				'MORPHIT_INDEXER_CHAIN_ID=cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
				`MORPHIT_INDEXER_RPC_ENDPOINTS=${rpcUrl}`,
				'MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=',
				`MORPHIT_INSTANCE_ORIGIN=${rpcUrl}`,
				''
			].join('\n')
	);
	put(
		join(dir, 'etc', 'morphit', 'relay.env'),
		`MORPHIT_RELAY_ACCOUNT=alice\nMORPHIT_RELAY_BLURT_RPC=${rpcUrl}\nMORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS=\n`
	);
	put(join(dir, 'etc', 'morphit', 'relay-vapid.env'), 'MORPHIT_RELAY_VAPID_SEEN=1\n');
	put(join(dir, 'etc', 'morphit', 'relay-notify.env'), 'MORPHIT_RELAY_NOTIFY_SEEN=1\n');
	put(join(dir, 'etc', 'systemd', 'system', 'morphit-indexer.service'), '[Unit]\n', 0o644);
}

async function doctor(
	flags: Record<string, string> = { 'no-db': 'true' },
	deps: { installDir?: string } = { installDir: install }
): Promise<{ code: number; out: string }> {
	const lines: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		lines.push(a.map(String).join(' '));
	});
	try {
		const code = await runDoctor(
			{ flags, positional: [], colorEnabled: false },
			{ ...deps, root: dir }
		);
		return { code, out: lines.join('\n') };
	} finally {
		vi.mocked(console.log).mockRestore();
	}
}

const seen = (svc: string): string => readFileSync(join(dir, `seen-${svc}`), 'utf8');

describe('doctor checks the services as their units start them', () => {
	it('run from apps/ops-cli (as the installed launcher does), it checks the install root', async () => {
		// vitest runs from apps/ops-cli, exactly the launcher's working directory.
		expect(process.cwd()).toBe(join(REPO, 'apps', 'ops-cli'));
		const { code, out } = await doctor({ 'no-db': 'true', 'no-rpc': 'true' }, {});
		expect(out).toContain(`Install directory: ${REPO}`);
		expect(out).not.toMatch(/does not look like|program files were not found/);
		expect(code).not.toBe(2);
		// The checks ran in the install's own service folders.
		expect(existsSync(join(dir, 'seen-indexer'))).toBe(true);
		expect(existsSync(join(dir, 'seen-relay'))).toBe(true);
	}, 30_000);

	it('a healthy Ansible node: each service gets exactly the files its unit sources, and will start', async () => {
		ansibleNode();
		process.env.MORPHIT_ONLY_IN_MY_SHELL = 'yes';
		const { code, out } = await doctor({ 'no-db': 'true', 'no-rpc': 'true' });
		expect(out).toContain('indexer: will start');
		expect(out).toContain('relay: will start');
		expect(code).toBe(0);
		expect(seen('indexer')).toContain('MORPHIT_INDEXER_CHAIN_ID=');
		expect(seen('indexer')).not.toContain('MORPHIT_RELAY_ACCOUNT=');
		expect(seen('relay')).toContain('MORPHIT_RELAY_ACCOUNT=alice');
		expect(seen('relay')).toContain('MORPHIT_RELAY_VAPID_SEEN=1');
		expect(seen('relay')).toContain('MORPHIT_RELAY_NOTIFY_SEEN=1');
		// A setting only in the operator's shell is not one the service has.
		expect(seen('indexer')).not.toContain('MORPHIT_ONLY_IN_MY_SHELL');
	}, 30_000);

	it('on a systemd node the closing advice is the restart and the journal, on this server', async () => {
		ansibleNode();
		const { out } = await doctor({ 'no-db': 'true', 'no-rpc': 'true' });
		expect(out).toContain('sudo systemctl restart morphit-indexer morphit-relay');
		expect(out).toContain('sudo journalctl -u morphit-indexer -n 50');
		expect(out).toContain('sudo journalctl -u morphit-relay -n 50');
		expect(out).not.toContain('cd apps/indexer && npm start');
	}, 30_000);

	it('a missing setting: the advice names it and the file it belongs in, nothing about init', async () => {
		ansibleNode({ indexerEnv: 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n' });
		const { code, out } = await doctor({ 'no-db': 'true', 'no-rpc': 'true' });
		expect(code).toBe(1);
		expect(out).toContain('indexer: will NOT start');
		expect(out).toContain(`add this setting to ${join(dir, 'etc', 'morphit', 'indexer.env')}`);
		expect(out).toContain('MORPHIT_INDEXER_CHAIN_ID=…');
		expect(out).not.toMatch(/allowlist|morphit-ops init/);
	}, 30_000);

	it('the schema: a check that could not run is never "drift"; a real DRIFT line is', async () => {
		ansibleNode();
		writeFileSync(
			join(dir, 'schema-out'),
			'Error: config validation failed:\n  - MORPHIT_INDEXER_PUBLIC_ORIGIN: Required\n'
		);
		writeFileSync(join(dir, 'schema-rc'), '1\n');
		let r = await doctor({ 'no-rpc': 'true' });
		expect(r.out).toContain('Database schema (the check could not run — nothing is known yet)');
		expect(r.out).not.toContain('drift detected');

		writeFileSync(
			join(dir, 'schema-out'),
			'[check-schema] DRIFT — your database is missing structures this version expects: table x\n'
		);
		r = await doctor({ 'no-rpc': 'true' });
		expect(r.out).toContain('Database schema (drift detected)');
		expect(r.out).toContain('table x');
	}, 30_000);

	it('the RPC probe reads the endpoints from the units’ files', async () => {
		ansibleNode();
		const { out } = await doctor();
		expect(rpcHits.some((h) => h.startsWith('POST /') && !h.includes('federation'))).toBe(true);
		expect(out).toContain(rpcUrl);
		expect(out).not.toMatch(/none configured/);
	}, 30_000);

	it('a hidden-only node (from the hidden lists in its files): nothing is probed over clearnet', async () => {
		ansibleNode({
			indexerEnv: [
				'MORPHIT_INDEXER_CHAIN_ID=cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
				'MORPHIT_INDEXER_RPC_ENDPOINTS=',
				`MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://${'a'.repeat(56)}.onion`,
				`MORPHIT_INSTANCE_ORIGIN=${rpcUrl}`,
				''
			].join('\n')
		});
		const { out } = await doctor();
		expect(out).toContain('hidden-only node');
		expect(out).toMatch(/1 hidden \(Tor\/I2P\) RPC node not contacted from here/);
		expect(out).toContain('sudo morphit-ops health');
		expect(rpcHits.filter((h) => !h.includes('federation'))).toEqual([]);
	}, 30_000);

	it('root:morphit 0640 env files (what the pre-start helper sets) are fine; looser is named plainly', async () => {
		ansibleNode();
		const env = join(install, 'morphit.env');
		const cfg = join(install, 'morphit.config.env');
		chownSync(env, 0, GID);
		chmodSync(env, 0o640);
		chownSync(cfg, 0, GID + 1);
		chmodSync(cfg, 0o640);
		const { out } = await doctor({ 'no-db': 'true', 'no-rpc': 'true' });
		const line = (name: string): string =>
			out.split('\n').find((l) => l.includes(`${name} permissions`)) ?? '';
		expect(line('morphit.env')).toContain('✓');
		expect(line('morphit.env')).toContain('root:morphit');
		// Another group can read it: said as "group", never "group/other".
		expect(line('morphit.config.env')).toContain('⚠');
		expect(line('morphit.config.env')).toMatch(/its group \(gid \d+\) can read it/);
		expect(line('morphit.config.env')).not.toContain('group/other');
		expect(line('morphit.config.env')).toContain(
			`sudo chown root:morphit ${cfg} && sudo chmod 0640 ${cfg}`
		);
		chmodSync(env, 0o644);
		const again = await doctor({ 'no-db': 'true', 'no-rpc': 'true' });
		expect(again.out).toMatch(/morphit\.env is 0644: every user on this server can read it/);
	}, 30_000);
});
