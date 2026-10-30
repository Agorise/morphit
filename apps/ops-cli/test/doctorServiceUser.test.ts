/**
 * `morphit-ops doctor`, review of v1.21.18 (2026-10-29):
 *  - typed without sudo on a systemd node it skipped every root-only settings
 *    file without a word, then gave advice built on that (M6);
 *  - it tried whether each file can be read AS ROOT, so a file the service's
 *    own user cannot read never showed (M6); the fix it named for
 *    relay-notify.env used the wrong group, and the key-file fix had no sudo;
 *  - an env file owned by another account passed at 0600, and only
 *    morphit.env / morphit.config.env were looked at (L6);
 *  - settings it could not read fell back to the clearnet defaults, and a
 *    hidden-only node was probed over clearnet (L7);
 *  - a schema check that ended well without its "[check-schema]" line read as
 *    "matches" (L8);
 *  - the example file was named relative to nowhere (L12).
 *
 * `npm` is a stand-in on PATH (as in doctorUnitEnv.test.ts); the services' own
 * user is `nobody`, which every Linux has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	chmodSync,
	chownSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	existsSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const probed: string[][] = [];
vi.mock('../src/init/chainCheck.ts', async (orig) => {
	const real = await orig<typeof import('../src/init/chainCheck.ts')>();
	return {
		...real,
		probeRpcEndpoints: async (urls: readonly string[]) => {
			probed.push([...urls]);
			return real.probeRpcEndpoints([]);
		}
	};
});

const { runDoctor, judgeSchemaCheck, envFilePermissionFinding } = await import(
	'../src/commands/doctor.ts'
);

const GID = 4711;
let dir = '';
let install = '';
const PATH = process.env.PATH;

function put(path: string, body: string, mode = 0o600): void {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, body, { mode });
	chmodSync(path, mode);
}
const etc = (f: string): string => join(dir, 'etc', 'morphit', f);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'doctor-user-'));
	// Reachable by any user, like / is (each test closes what it means to).
	chmodSync(dir, 0o755);
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
			'touch "$D/ran-$svc"',
			'if [ "$3" = --check-schema ]; then cat "$D/schema-out"; exit $(cat "$D/schema-rc"); fi',
			'echo "[check-config] $svc config OK"; exit 0',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${join(dir, 'bin')}:${PATH}`;
	probed.length = 0;
	// The node: settings readable by any user (0644), so only what a test
	// closes is closed; both units run as `nobody`.
	put(join(install, 'morphit.env'), 'MORPHIT_RELAY_ACTIVE_KEY_FILE=/nonexistent/key\n', 0o644);
	put(join(install, 'morphit.config.env'), '# settings\n', 0o644);
	put(
		etc('indexer.env'),
		'MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=http://' +
			'a'.repeat(56) +
			'.onion\nMORPHIT_INSTANCE_ORIGIN=http://127.0.0.1:1\n',
		0o644
	);
	put(etc('relay.env'), 'MORPHIT_RELAY_ACCOUNT=alice\n', 0o644);
	put(etc('relay-notify.env'), 'MORPHIT_RELAY_NOTIFY_SEEN=1\n', 0o644);
	for (const svc of ['indexer', 'relay'])
		put(
			join(dir, 'etc', 'systemd', 'system', `morphit-${svc}.service`),
			'[Service]\nUser=nobody\n',
			0o644
		);
});
afterEach(() => {
	process.env.PATH = PATH;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

async function doctor(
	flags: Record<string, string> = { 'no-db': 'true', 'no-rpc': 'true' },
	o: { isRoot?: () => boolean } = {}
): Promise<{ code: number; out: string }> {
	const lines: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		lines.push(a.map(String).join(' '));
	});
	try {
		const code = await runDoctor(
			{ flags, positional: [], colorEnabled: false },
			{ installDir: install, root: dir, ...o }
		);
		return { code, out: lines.join('\n') };
	} finally {
		vi.mocked(console.log).mockRestore();
	}
}

describe('who doctor checks as', () => {
	it('without root on a systemd node: says it needs sudo, checks nothing, exit 1', async () => {
		const { code, out } = await doctor(undefined, { isRoot: () => false });
		expect(code).toBe(1);
		expect(out).toContain(
			'This check needs administrator rights on this server: sudo morphit-ops doctor'
		);
		expect(out).not.toMatch(/will start|will NOT start/);
		expect(existsSync(join(dir, 'ran-indexer'))).toBe(false);
	});

	it('a file the relay’s own user cannot read: the relay will NOT start, with the relay’s group in the fix', async () => {
		chmodSync(etc('relay-notify.env'), 0o600);
		const { code, out } = await doctor();
		expect(code).toBe(1);
		expect(out).toContain('relay: will NOT start');
		expect(out).toContain(`cannot read ${etc('relay-notify.env')}`);
		expect(out).toContain(
			`sudo chown root:morphit-relay ${etc('relay-notify.env')} && sudo chmod 0640 ${etc('relay-notify.env')}`
		);
		expect(out).toContain('indexer: will start');
	}, 30_000);

	it('a folder closed to the service’s user: named, with the fix for the folder', async () => {
		chmodSync(join(dir, 'etc', 'morphit'), 0o700);
		const { out } = await doctor();
		expect(out).toContain('indexer: will NOT start');
		expect(out).toContain(`the folder ${join(dir, 'etc', 'morphit')} is closed to it`);
		expect(out).toContain(
			`sudo chown root:morphit ${join(dir, 'etc', 'morphit')} && sudo chmod 0750 ${join(dir, 'etc', 'morphit')}`
		);
	}, 30_000);

	it('a root-owned file the pre-start helper opens to the service at every start: not a failure', async () => {
		chmodSync(etc('relay-notify.env'), 0o600);
		put(
			join(dir, 'usr', 'local', 'lib', 'morphit', 'morphit-service-perms.sh'),
			'#!/bin/sh\n',
			0o755
		);
		const { out } = await doctor();
		expect(out).toContain('relay: will start');
	}, 30_000);
});

describe('the env files’ permissions', () => {
	it('every file the units read is looked at, each against its own group', async () => {
		chownSync(etc('relay-notify.env'), 0, GID);
		chmodSync(etc('relay-notify.env'), 0o640);
		chownSync(etc('relay.env'), 0, GID);
		chmodSync(etc('relay.env'), 0o640);
		const { out } = await doctor();
		const line = (name: string): string =>
			out.split('\n').find((l) => l.includes(`${name} permissions`)) ?? '';
		expect(line('indexer.env')).toContain('⚠'); // 0644
		expect(line('relay.env')).toContain('✓');
		// relay-notify.env is the relay's alone: root:morphit is too wide.
		expect(line('relay-notify.env')).toContain('⚠');
		expect(line('relay-notify.env')).toContain(
			`sudo chown root:morphit-relay ${etc('relay-notify.env')} && sudo chmod 0640 ${etc('relay-notify.env')}`
		);
	}, 30_000);

	it('0600 owned by another account is not "good"', () => {
		const f = envFilePermissionFinding(
			'indexer.env',
			'/etc/morphit/indexer.env',
			{ mode: 0o100600, uid: 1000, gid: 1000 },
			{ name: 'morphit', gid: GID }
		);
		expect(f.level).toBe('warn');
		expect(f.detail).toContain('owned by uid 1000, not root');
		expect(
			envFilePermissionFinding(
				'indexer.env',
				'/etc/morphit/indexer.env',
				{ mode: 0o100600, uid: 0, gid: 0 },
				{ name: 'morphit', gid: GID }
			).level
		).toBe('ok');
	});
});

describe('what doctor does not know, it does not guess', () => {
	it('settings it cannot read: no RPC endpoint is contacted, and it says why', async () => {
		// A file whose reading fails (it ends the shell that reads it).
		writeFileSync(etc('relay-vapid.env'), 'exit 3\n', { mode: 0o644 });
		const { out } = await doctor({ 'no-db': 'true' });
		expect(probed).toEqual([]);
		expect(out).toContain('not checked — the services’ settings could not be read');
	}, 30_000);

	it('a schema check that ended without its verdict line is not "matches"', async () => {
		expect(judgeSchemaCheck({ ok: true, detail: '' }).kind).toBe('not-run');
		expect(
			judgeSchemaCheck({
				ok: true,
				detail: '[check-schema] database schema matches this version'
			}).kind
		).toBe('matches');
		writeFileSync(join(dir, 'schema-out'), 'something else entirely\n');
		const { out } = await doctor({ 'no-rpc': 'true' });
		expect(out).not.toContain('(matches this version)');
		expect(out).toContain('the check could not run');
	}, 30_000);

	it('the example settings file is named by its full path', async () => {
		writeFileSync(
			join(dir, 'bin', 'npm'),
			[
				'#!/bin/sh',
				'echo "Error: config validation failed:"',
				'echo "  - MORPHIT_INDEXER_CHAIN_ID: Required"',
				'exit 1',
				''
			].join('\n'),
			{ mode: 0o755 }
		);
		const { out } = await doctor();
		expect(out).toContain(join(install, 'ops', 'env', 'indexer.env.example'));
	}, 30_000);
});
