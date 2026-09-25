/**
 * What `morphit-ops upgrade` installs, and from what (v1.18.0 deep-deep:
 * ops-2, ops-3, ops-7, ops-8).
 *
 *   ops-2  A mirror could make a node "upgrade" to an OLDER signed release:
 *          "up to date" was string equality, a verified signature overrode a
 *          known mismatch against the primary's hash, and nothing checked the
 *          extracted tarball was the version chosen.
 *   ops-3  A present but INVALID .asc was silently ignored.
 *   ops-7  Mirror-supplied asset names reached join(tmpDir, name) unchecked.
 *   ops-8  The live-canary probe ran `sh -c` with the configured origin's host.
 *
 * The end-to-end cases drive the real runUpgrade on an offline tarball signed
 * by a throwaway key, with `npm` replaced by a stub that records it ran: any
 * install that gets as far as installing dependencies went too far.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	runUpgrade,
	integrityGate,
	isNewerRelease,
	selectReleaseAssets,
	probeLiveCanary
} from '../src/commands/upgrade.ts';

const scratch = mkdtempSync(join(tmpdir(), 'morphit-integrity-'));
const gnupg = join(scratch, 'gnupg');
const signerPub = join(scratch, 'signer.asc');

beforeAll(() => {
	mkdirSync(gnupg, { mode: 0o700 });
	const gpg = (args: string[]) =>
		spawnSync(
			'gpg',
			['--homedir', gnupg, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', ...args],
			{
				encoding: 'utf8'
			}
		);
	expect(
		gpg([
			'--quick-gen-key',
			'Morphit Test Signer <test@example.invalid>',
			'ed25519',
			'sign',
			'never'
		]).status
	).toBe(0);
	const pub = gpg(['--armor', '--export', 'test@example.invalid']);
	writeFileSync(signerPub, pub.stdout);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function sign(file: string): void {
	const r = spawnSync(
		'gpg',
		[
			'--homedir',
			gnupg,
			'--batch',
			'--pinentry-mode',
			'loopback',
			'--passphrase',
			'',
			'--armor',
			'--detach-sign',
			'--output',
			`${file}.asc`,
			file
		],
		{ encoding: 'utf8' }
	);
	expect(r.status, r.stderr).toBe(0);
}

/** A release tarball whose own release-info.json names `innerTag`. */
function releaseTarball(dir: string, fileTag: string, innerTag: string): string {
	const tree = mkdtempSync(join(scratch, 'tree-'));
	writeFileSync(
		join(tree, 'release-info.json'),
		JSON.stringify({ tag: innerTag, commit: 'c', build_time: 't', builder: 'b' })
	);
	writeFileSync(join(tree, 'package.json'), '{}');
	const out = join(dir, `morphit-${fileTag}-offline.tar.gz`);
	expect(spawnSync('tar', ['-czf', out, '-C', tree, '.']).status).toBe(0);
	sign(out);
	return out;
}

let work = '';
let installDir = '';
let npmRan = '';
const saved = { ...process.env };

beforeEach(() => {
	work = mkdtempSync(join(scratch, 'run-'));
	installDir = join(work, 'morphit');
	mkdirSync(join(installDir, '.forgejo', 'release-signers'), { recursive: true });
	writeFileSync(
		join(installDir, '.forgejo', 'release-signers', 'test.asc'),
		readFileSync(signerPub)
	);
	writeFileSync(
		join(installDir, 'release-info.json'),
		JSON.stringify({ tag: 'v1.17.15', commit: 'x', build_time: 'x', builder: 'x' })
	);
	writeFileSync(join(installDir, 'marker-of-the-old-install'), 'old');
	// `npm` that records it was reached, then fails (so the run rolls back).
	const bin = join(work, 'bin');
	mkdirSync(bin);
	npmRan = join(work, 'npm-ran');
	writeFileSync(join(bin, 'npm'), `#!/bin/sh\ntouch '${npmRan}'\nexit 1\n`);
	chmodSync(join(bin, 'npm'), 0o755);
	process.env.PATH = `${bin}:${saved.PATH ?? '/usr/bin:/bin'}`;
	process.env.MORPHIT_INSTALL_DIR = installDir;
	process.env.MORPHIT_ETC_DIR = join(work, 'etc');
	process.env.MORPHIT_OFFLINE_RELEASE_DIR = join(work, 'no-drops');
	process.env.MORPHIT_WEB_ROOT = join(work, 'www');
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

const upgrade = (tarball: string, extra: Record<string, string> = {}) =>
	runUpgrade({ flags: { 'from-file': tarball, yes: 'true', ...extra }, positional: [] });

const backups = (): string[] =>
	readdirSync(dirname(installDir)).filter((n) => n.startsWith(`${basename(installDir)}.bak-`));

describe('a signed OLDER release is not installed as an upgrade (ops-2)', () => {
	it('refuses it before touching the install', async () => {
		const tb = releaseTarball(work, 'v1.17.10', 'v1.17.10');
		const rc = await upgrade(tb);
		expect(existsSync(npmRan), 'the older release was being installed').toBe(false);
		expect(backups(), 'the install was moved aside for an older release').toEqual([]);
		expect(rc).toBe(0);
		expect(existsSync(join(installDir, 'marker-of-the-old-install'))).toBe(true);
	});

	it('--allow-downgrade is the explicit way to install it', async () => {
		const tb = releaseTarball(work, 'v1.17.10', 'v1.17.10');
		await upgrade(tb, { 'allow-downgrade': 'true' });
		expect(existsSync(npmRan), 'an explicit downgrade was refused').toBe(true);
	});

	it('a tarball that is a different release than its name is put back, not installed', async () => {
		// Signed, named v1.18.0, but its own release-info.json says v1.17.10.
		const tb = releaseTarball(work, 'v1.18.0', 'v1.17.10');
		const rc = await upgrade(tb);
		expect(existsSync(npmRan), 'the mislabelled tarball went on to be installed').toBe(false);
		expect(rc).toBe(3);
		expect(JSON.parse(readFileSync(join(installDir, 'release-info.json'), 'utf8')).tag).toBe(
			'v1.17.15'
		);
		expect(existsSync(join(installDir, 'marker-of-the-old-install'))).toBe(true);
	});

	it('the genuine newer release still goes ahead', async () => {
		const tb = releaseTarball(work, 'v1.18.0', 'v1.18.0');
		await upgrade(tb);
		expect(existsSync(npmRan)).toBe(true);
	});
});

describe('the integrity decision (ops-2, ops-3)', () => {
	const base = {
		actualHash: 'a'.repeat(64),
		expectedHashFromChain: false,
		bytesFromPrimary: false,
		hidden: null
	};
	it('a present but invalid signature refuses, even when the primary hash matches', () => {
		expect(
			integrityGate({ ...base, signature: 'invalid', expectedHash: 'a'.repeat(64) }).allowed
		).toBe(false);
	});
	it('a valid signature does not override a known primary-hash mismatch', () => {
		expect(
			integrityGate({ ...base, signature: 'valid', expectedHash: 'b'.repeat(64) }).allowed
		).toBe(false);
	});
	it('a valid signature with no primary hash (primary down) is still accepted', () => {
		expect(integrityGate({ ...base, signature: 'valid', expectedHash: null })).toMatchObject({
			allowed: true,
			proof: 'gpg-signature'
		});
	});
	it('no signature and a matching primary hash is still accepted', () => {
		expect(
			integrityGate({ ...base, signature: 'absent', expectedHash: 'a'.repeat(64) }).allowed
		).toBe(true);
	});
	it('a signature that cannot be checked here (no gpg) falls back to the hash, as before', () => {
		expect(
			integrityGate({ ...base, signature: 'unverifiable', expectedHash: 'a'.repeat(64) }).allowed
		).toBe(true);
		expect(integrityGate({ ...base, signature: 'unverifiable', expectedHash: null }).allowed).toBe(
			false
		);
	});
	it('only a strictly newer version is newer', () => {
		expect(isNewerRelease('v1.18.0', 'v1.17.15')).toBe(true);
		expect(isNewerRelease('v1.17.10', 'v1.17.15')).toBe(false);
		expect(isNewerRelease('v1.17.15', 'v1.17.15')).toBe(false);
		expect(isNewerRelease('1.17.15', 'v1.17.15')).toBe(false);
	});
});

describe('mirror-supplied names (ops-7)', () => {
	it('an asset name with a path in it is never chosen', () => {
		const a = (name: string) => ({ name, browser_download_url: `https://m/${name}`, size: 1 });
		const picked = selectReleaseAssets([
			a('../../../etc/cron.d/x.tar.gz'),
			a('../../../etc/cron.d/x.tar.gz.sha256')
		]);
		expect(picked).toBeNull();
		const ok = selectReleaseAssets([
			a('morphit-v1.18.0.tar.gz'),
			a('morphit-v1.18.0.tar.gz.sha256')
		]);
		expect(ok?.tarball.name).toBe('morphit-v1.18.0.tar.gz');
	});
});

describe('the live-canary probe runs no shell (ops-8)', () => {
	it('a configured origin cannot run a command', () => {
		const mark = join(work, 'pwned');
		process.env.MORPHIT_PWN_MARK = mark;
		probeLiveCanary('https://x;touch${IFS}$MORPHIT_PWN_MARK;true');
		expect(existsSync(mark), 'the origin value was run by a shell').toBe(false);
	});
});
