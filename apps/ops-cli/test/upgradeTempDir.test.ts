/**
 * The upgrade's download scratch dir must be a FRESH, private directory
 * (review B2).
 *
 * It holds the release tarball between the integrity check and `tar -x`, and
 * the upgrade runs as root. It used to be `/tmp/morphit-upgrade-<Date.now()>`
 * created with mkdirSync({recursive:true}), which silently ADOPTS a directory
 * (or a link to one) that already exists at that predictable name — so a local
 * account that planted it owned the directory root then wrote the release into.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkTempDir } from '../src/commands/upgrade.ts';

const made: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('mkTempDir (upgrade scratch dir)', () => {
	it('never reuses a directory planted at a predictable name', () => {
		const fixed = 1_700_000_000_000;
		vi.spyOn(Date, 'now').mockReturnValue(fixed);
		const planted = join(tmpdir(), `morphit-upgrade-${fixed}`);
		mkdirSync(planted, { recursive: true });
		made.push(planted);
		const dir = mkTempDir();
		made.push(dir);
		expect(dir).not.toBe(planted);
	});

	it('never follows a link planted at a predictable name', () => {
		const fixed = 1_700_000_000_001;
		vi.spyOn(Date, 'now').mockReturnValue(fixed);
		const target = mkdtempSync(join(tmpdir(), 'planted-target-'));
		made.push(target);
		const link = join(tmpdir(), `morphit-upgrade-${fixed}`);
		symlinkSync(target, link);
		made.push(link);
		const dir = mkTempDir();
		made.push(dir);
		expect(lstatSync(dir).isSymbolicLink()).toBe(false);
		expect(dir).not.toBe(link);
	});

	it('is a new directory only its creator can enter (0700)', () => {
		const dir = mkTempDir();
		made.push(dir);
		const st = lstatSync(dir);
		expect(st.isDirectory()).toBe(true);
		expect(st.mode & 0o777).toBe(0o700);
		expect(st.uid).toBe(process.getuid?.() ?? st.uid);
	});
});
