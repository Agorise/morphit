/**
 * The relay's keystore permission check against the shapes the installer
 * really ships.
 *
 * The relay runs as an unprivileged user (morphit-relay) and reads its
 * keystore through the group: the installer and
 * ops/scripts/morphit-service-perms.sh (run before every start) set it to
 * root:morphit-relay 0640. loadConfig refused any group bit, so the relay
 * refused to start on every box set up that way.
 *
 * The real-file cases run loadConfig in a child process as uid/gid 65534
 * (nobody:nogroup, standing in for morphit-relay) against files with real
 * owners and modes; they need root to chown and to drop privileges, and are
 * skipped otherwise. The pure cases cover supplementary groups.
 */

import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	chownSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keystorePermissionProblem } from '../src/config/keystorePerms.ts';

const RELAY_DIR = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = fileURLToPath(new URL('../src/config/index.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const SERVICE = 65534; // nobody:nogroup — the unprivileged service identity
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let dir = '';
let tmp = '';

beforeAll(async () => {
	if (!isRoot) return;
	// A root-owned directory every user can traverse (as /etc/morphit).
	dir = mkdtempSync('/tmp/relay-keystore-perms-');
	chmodSync(dir, 0o755);
	tmp = join(dir, 'tmp');
	mkdirSync(tmp);
	chownSync(tmp, SERVICE, SERVICE);
	writeFileSync(
		join(dir, 'run.ts'),
		`import { loadConfig } from ${JSON.stringify(CONFIG)};\n` +
			`try { loadConfig(); console.log('LOADED'); } catch (e) { console.log('REFUSED ' + (e as Error).message); }\n`
	);
	chmodSync(join(dir, 'run.ts'), 0o644);
	const { PrivateKey } = await import('@beblurt/dblurt');
	writeFileSync(
		join(dir, 'key.template'),
		PrivateKey.fromSeed('relay-keystore-perms-test').toString()
	);
});
afterAll(() => {
	if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

/** Write a keystore with this owner and mode, then run loadConfig as the
 *  unprivileged service identity. */
function loadAsService(owner: number, group: number, mode: number): string {
	const key = join(dir, `active-${owner}-${group}-${mode.toString(8)}.key`);
	writeFileSync(key, readFileSync(join(dir, 'key.template')));
	chownSync(key, owner, group);
	chmodSync(key, mode);
	const r = spawnSync(process.execPath, [TSX, '--tsconfig', 'tsconfig.json', join(dir, 'run.ts')], {
		cwd: RELAY_DIR,
		uid: SERVICE,
		gid: SERVICE,
		encoding: 'utf8',
		timeout: 25_000,
		env: {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			HOME: tmp,
			TMPDIR: tmp,
			MORPHIT_RELAY_ACCOUNT: 'morphit-relay',
			MORPHIT_RELAY_ACTIVE_KEY_FILE: key,
			MORPHIT_RELAY_DATABASE_URL: 'postgres://relay:a-real-password-here@localhost:5432/morphit',
			MORPHIT_RELAY_INVITE_HMAC_SECRET: 'i'.repeat(64),
			MORPHIT_RELAY_ALTCHA_HMAC_SECRET: 'a'.repeat(64)
		}
	});
	return `${r.stdout}${r.stderr}`.trim();
}

describe.skipIf(!isRoot)(
	'relay keystore permissions, real files, loadConfig as the service user',
	() => {
		it("root:<service group> 0640 — the installer's shape — loads", () => {
			expect(loadAsService(0, SERVICE, 0o640)).toBe('LOADED');
		});
		it('root:<service group> 0440 loads', () => {
			expect(loadAsService(0, SERVICE, 0o440)).toBe('LOADED');
		});
		it('owner-only 0400 / 0600 still loads', () => {
			expect(loadAsService(SERVICE, SERVICE, 0o400)).toBe('LOADED');
			expect(loadAsService(SERVICE, SERVICE, 0o600)).toBe('LOADED');
		});
		it('readable by others (0644) is refused', () => {
			expect(loadAsService(0, SERVICE, 0o644)).toMatch(/^REFUSED /);
		});
		it('group-writable (0660) is refused', () => {
			expect(loadAsService(0, SERVICE, 0o660)).toMatch(/^REFUSED /);
		});
		it('group-readable for a group the service is not in (root:root 0640) is refused', () => {
			expect(loadAsService(0, 0, 0o640)).toMatch(/^REFUSED /);
		});
		it('group-readable but not owned by root is refused', () => {
			expect(loadAsService(SERVICE, SERVICE, 0o640)).toMatch(/^REFUSED /);
		});
	}
);

describe('keystorePermissionProblem', () => {
	const svc = { uid: 998, gids: [998, 1001] };
	const ok = (mode: number, uid: number, gid: number) =>
		keystorePermissionProblem({ mode, uid, gid }, svc);
	it('accepts a supplementary group of the process', () => {
		expect(ok(0o100640, 0, 1001)).toBeNull();
	});
	it('accepts the owner-only shapes whoever owns the file', () => {
		expect(ok(0o100400, 998, 998)).toBeNull();
		expect(ok(0o100600, 0, 0)).toBeNull();
	});
	it('refuses every looser shape', () => {
		for (const mode of [0o604, 0o644, 0o660, 0o650, 0o670, 0o641, 0o440 | 0o002]) {
			expect(ok(mode, 0, 998), mode.toString(8)).not.toBeNull();
		}
		expect(ok(0o640, 0, 5)).not.toBeNull();
		expect(ok(0o640, 998, 998)).not.toBeNull();
	});
});
