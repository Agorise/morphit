/**
 * `morphit-ops upgrade` must refresh the helper scripts Ansible copied ONCE into
 * /usr/local/lib/morphit/ (wave 2, C3/C17): otherwise a fix to
 * morphit-first-online.sh or morphit-ipfs-pin.sh reaches only new installs.
 * Rule (same as refreshUnits): only files that are INSTALLED and DIFFER; back up
 * to .bak; replace atomically 0755 root:root without following a symlink; verify
 * the installed bytes equal the release copy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	chmodSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshHelperScripts, HELPER_SCRIPTS } from '../src/lib/refreshHelperScripts.ts';

let root = '';
let release = '';
let helperDir = '';
const NEW = '#!/bin/sh\necho new\n';
const OLD = '#!/bin/sh\necho old\n';

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-helpers-'));
	release = join(root, 'release');
	helperDir = join(root, 'usr-local-lib-morphit');
	mkdirSync(helperDir, { recursive: true });
	for (const h of HELPER_SCRIPTS) {
		mkdirSync(join(release, h.release, '..'), { recursive: true });
		writeFileSync(join(release, h.release), NEW);
	}
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const installed = (name: string): string => join(helperDir, name);

describe('refreshHelperScripts', () => {
	it('covers first-online, ipfs-pin, ipns-rebroadcast, ipfs-privacy, backup, and (v1.20.0) the IPFS clean-up + tor-only OS scripts', () => {
		const names = HELPER_SCRIPTS.map((h) => h.name).sort();
		expect(names).toEqual(
			[
				'morphit-backup.sh',
				'morphit-first-online.sh',
				'morphit-ipfs-pin.sh',
				'morphit-ipfs-privacy.sh',
				'morphit-ipns-rebroadcast.sh',
				'morphit-ipfs-gc.sh',
				'morphit-tor-only-os.sh',
				'morphit-tor-timesync.sh'
			].sort()
		);
		// Each one exists in the release tree at the path the refresh reads.
		for (const h of HELPER_SCRIPTS)
			expect(existsSync(join(import.meta.dirname, '..', '..', '..', h.release))).toBe(true);
	});

	it('replaces an installed, differing script: .bak keeps the old, new bytes 0755, verified', () => {
		writeFileSync(installed('morphit-ipfs-pin.sh'), OLD);
		chmodSync(installed('morphit-ipfs-pin.sh'), 0o700);
		const r = refreshHelperScripts({ releaseRoot: release, helperDir, log: () => {} });
		const pin = r.find((x) => x.name === 'morphit-ipfs-pin.sh')!;
		expect(pin.action).toBe('refreshed');
		expect(readFileSync(installed('morphit-ipfs-pin.sh'), 'utf8')).toBe(NEW);
		expect(readFileSync(`${installed('morphit-ipfs-pin.sh')}.bak`, 'utf8')).toBe(OLD);
		const st = lstatSync(installed('morphit-ipfs-pin.sh'));
		expect(st.isFile()).toBe(true);
		expect(st.mode & 0o777).toBe(0o755);
		if ((process.getuid?.() ?? 1) === 0) expect(st.uid).toBe(0);
		expect(pin.backupPath).toBe(`${installed('morphit-ipfs-pin.sh')}.bak`);
	});

	it('leaves an identical script alone (no .bak churn)', () => {
		writeFileSync(installed('morphit-backup.sh'), NEW);
		chmodSync(installed('morphit-backup.sh'), 0o755); // as Ansible installs it
		const r = refreshHelperScripts({ releaseRoot: release, helperDir, log: () => {} });
		expect(r.find((x) => x.name === 'morphit-backup.sh')!.action).toBe('unchanged');
		expect(existsSync(`${installed('morphit-backup.sh')}.bak`)).toBe(false);
	});

	it('never installs a script the box does not already have', () => {
		const r = refreshHelperScripts({ releaseRoot: release, helperDir, log: () => {} });
		expect(r.every((x) => x.action === 'not-installed')).toBe(true);
		expect(existsSync(installed('morphit-first-online.sh'))).toBe(false);
	});

	it('does not write through a symlink planted at the installed path', () => {
		const victim = join(root, 'victim');
		writeFileSync(victim, 'do not touch\n');
		symlinkSync(victim, installed('morphit-first-online.sh'));
		const r = refreshHelperScripts({ releaseRoot: release, helperDir, log: () => {} });
		expect(r.find((x) => x.name === 'morphit-first-online.sh')!.action).toBe('skipped-not-regular');
		expect(readFileSync(victim, 'utf8')).toBe('do not touch\n');
	});

	it('refuses to work inside a helper dir that is itself a symlink', () => {
		const real = join(root, 'real-dir');
		mkdirSync(real);
		writeFileSync(join(real, 'morphit-ipfs-pin.sh'), OLD);
		const linkDir = join(root, 'linked-helper-dir');
		symlinkSync(real, linkDir);
		const r = refreshHelperScripts({ releaseRoot: release, helperDir: linkDir, log: () => {} });
		expect(r.every((x) => x.action !== 'refreshed')).toBe(true);
		expect(readFileSync(join(real, 'morphit-ipfs-pin.sh'), 'utf8')).toBe(OLD);
	});
});
