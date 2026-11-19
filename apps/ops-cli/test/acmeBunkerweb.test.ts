/**
 * Let's Encrypt's check through BunkerWeb's own folder (v1.24.6): the two
 * certbot hooks run for real (sh, with a stand-in `docker` that keeps
 * BunkerWeb's container as a folder), the files the Ansible tls role installs
 * are these very hooks, and the helpers the heals use.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	AUTH_HOOK_TEXT,
	CLEANUP_HOOK_TEXT,
	AUTH_HOOK,
	CLEANUP_HOOK,
	EDGE_ACME_DIR,
	edgeChallenge,
	edgeServes,
	ensureAcmeHooks,
	safeToken,
	type HookFs
} from '../src/lib/acmeBunkerweb.ts';

const repo = join(__dirname, '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'acme-bw-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A `docker` that knows one running container, `edge-1`, labelled as
 *  BunkerWeb's edge, whose filesystem is <tmp>/root. */
function fakeDocker(label = 'bunkerweb'): string {
	const bin = join(tmp, `bin-${label}`);
	spawnSync('mkdir', ['-p', bin, join(tmp, 'root')]);
	writeFileSync(
		join(bin, 'docker'),
		`#!/bin/sh
ROOT=${join(tmp, 'root')}
echo "$*" >> ${join(tmp, 'docker.log')}
case "$1" in
  ps) case "$*" in *"label=bunkerweb.type=${label}"*) echo edge-1 ;; esac ;;
  exec)
    shift; [ "$1" = -i ] && shift
    [ "$1" = edge-1 ] || exit 1
    shift
    if [ "$1" = sh ]; then dir=$ROOT$5; mkdir -p "$dir" && cat > "$dir/$6"
    elif [ "$1" = rm ]; then rm -f "$ROOT$3"
    else exit 1; fi ;;
  *) exit 1 ;;
esac
`
	);
	chmodSync(join(bin, 'docker'), 0o755);
	return bin;
}

function hook(text: string, env: Record<string, string>, bin: string) {
	const f = join(tmp, `hook-${Math.random().toString(16).slice(2)}.sh`);
	writeFileSync(f, text);
	return spawnSync('sh', [f], {
		encoding: 'utf8',
		env: { PATH: `${bin}:/usr/bin:/bin`, ...env }
	});
}

describe('the two certbot hooks, run for real', () => {
	it('the auth hook puts the validation into BunkerWeb’s folder, in the container its label names', () => {
		const bin = fakeDocker();
		const r = hook(
			AUTH_HOOK_TEXT,
			{ CERTBOT_TOKEN: 'tok_A-1', CERTBOT_VALIDATION: 'tok_A-1.key' },
			bin
		);
		expect(r.status).toBe(0);
		expect(readFileSync(join(tmp, 'root', EDGE_ACME_DIR, 'tok_A-1'), 'utf8')).toBe('tok_A-1.key');
	});

	it('the cleanup hook removes it again', () => {
		const bin = fakeDocker();
		hook(AUTH_HOOK_TEXT, { CERTBOT_TOKEN: 'tok_B', CERTBOT_VALIDATION: 'v' }, bin);
		const r = hook(CLEANUP_HOOK_TEXT, { CERTBOT_TOKEN: 'tok_B' }, bin);
		expect(r.status).toBe(0);
		expect(existsSync(join(tmp, 'root', EDGE_ACME_DIR, 'tok_B'))).toBe(false);
	});

	it('a token that is not base64url (a path) is refused; nothing is written or removed outside the folder', () => {
		const bin = fakeDocker();
		const outside = join(tmp, 'root', 'var', 'tmp', 'keep');
		spawnSync('mkdir', ['-p', join(tmp, 'root', 'var', 'tmp')]);
		writeFileSync(outside, 'x');
		const r = hook(AUTH_HOOK_TEXT, { CERTBOT_TOKEN: '../keep', CERTBOT_VALIDATION: 'evil' }, bin);
		expect(r.status).not.toBe(0);
		expect(readFileSync(outside, 'utf8')).toBe('x');
		const c = hook(CLEANUP_HOOK_TEXT, { CERTBOT_TOKEN: '../../keep' }, bin);
		expect(c.status).toBe(0);
		expect(existsSync(outside)).toBe(true);
		expect(hook(AUTH_HOOK_TEXT, { CERTBOT_VALIDATION: 'v' }, bin).status).not.toBe(0);
	});

	it('the auth hook fails when the file cannot be put there (certbot then stops, nothing is half-done)', () => {
		const bin = fakeDocker('nothing-matches'); // no labelled container → "bunkerweb", which does not exist
		const r = hook(AUTH_HOOK_TEXT, { CERTBOT_TOKEN: 'tok_C', CERTBOT_VALIDATION: 'v' }, bin);
		expect(r.status).not.toBe(0);
	});

	it('the Ansible tls role installs these very files', () => {
		const dir = join(repo, 'ops', 'ansible', 'roles', 'tls', 'files');
		expect(readFileSync(join(dir, 'certbot-bunkerweb-auth.sh'), 'utf8')).toBe(AUTH_HOOK_TEXT);
		expect(readFileSync(join(dir, 'certbot-bunkerweb-cleanup.sh'), 'utf8')).toBe(CLEANUP_HOOK_TEXT);
		expect(AUTH_HOOK).toBe('/usr/local/lib/morphit/certbot-bunkerweb-auth.sh');
		expect(CLEANUP_HOOK).toBe('/usr/local/lib/morphit/certbot-bunkerweb-cleanup.sh');
	});
});

describe('the hooks on disk', () => {
	const fsOf = (files: Map<string, string>, exec: Set<string>, writable = true): HookFs => ({
		read: (p) => files.get(p) ?? null,
		write: (p, t) => (writable ? (files.set(p, t), exec.add(p), true) : false),
		executable: (p) => exec.has(p)
	});

	it('written when missing, then left alone', () => {
		const files = new Map<string, string>();
		const exec = new Set<string>();
		expect(ensureAcmeHooks(fsOf(files, exec))).toBe('written');
		expect(files.get(AUTH_HOOK)).toBe(AUTH_HOOK_TEXT);
		expect(files.get(CLEANUP_HOOK)).toBe(CLEANUP_HOOK_TEXT);
		expect(ensureAcmeHooks(fsOf(files, exec))).toBe('unchanged');
	});

	it('a changed or non-executable hook is written again', () => {
		const files = new Map([
			[AUTH_HOOK, 'old'],
			[CLEANUP_HOOK, CLEANUP_HOOK_TEXT]
		]);
		const exec = new Set([AUTH_HOOK]);
		expect(ensureAcmeHooks(fsOf(files, exec))).toBe('written');
		expect(files.get(AUTH_HOOK)).toBe(AUTH_HOOK_TEXT);
		expect(exec.has(CLEANUP_HOOK)).toBe(true);
	});

	it('not writable: failed (the heals then do not use the folder)', () => {
		expect(ensureAcmeHooks(fsOf(new Map(), new Set(), false))).toBe('failed');
	});

	it('the real file system: written mode 0755 and read back', async () => {
		const { realHookFs } = await import('../src/lib/acmeBunkerweb.ts');
		const p = join(tmp, 'sub', 'h.sh');
		expect(realHookFs.write(p, 'x')).toBe(true);
		expect(realHookFs.read(p)).toBe('x');
		expect(realHookFs.executable(p)).toBe(true);
	});
});

describe('the probe', () => {
	it('true only when exactly the test file comes back; the file is taken out either way', () => {
		const folder = new Map<string, string>();
		const put = (t: string, b: string | null) => (
			b === null ? folder.delete(t) : folder.set(t, b),
			true
		);
		expect(edgeServes(put, (t) => folder.get(t) ?? null)).toBe(true);
		expect(folder.size).toBe(0);
		expect(edgeServes(put, () => '<!doctype html>404')).toBe(false);
		expect(folder.size).toBe(0);
		expect(() =>
			edgeServes(put, () => {
				throw new Error('boom');
			})
		).toThrow();
		expect(folder.size).toBe(0);
	});

	it('a file that cannot be put there: false, nothing asked', () => {
		let asked = false;
		expect(
			edgeServes(
				() => false,
				() => ((asked = true), null)
			)
		).toBe(false);
		expect(asked).toBe(false);
	});

	it('tokens: base64url only, and an unsafe one never reaches docker', () => {
		expect(safeToken('AbC_-09')).toBe(true);
		for (const t of ['', '../x', 'a/b', 'a b', 'a;b', '$(x)']) expect(safeToken(t)).toBe(false);
		expect(edgeChallenge('bunkerweb', '../etc', 'x')).toBe(false);
		expect(edgeChallenge('', 'tok', 'x')).toBe(false);
	});
});
