/**
 * matchOwner must never chown a symlink's TARGET (review B3).
 *
 * It runs as root right after a file is renamed into a directory a non-root
 * account owns (the canary-upload build dir / the web root). That account can
 * swap the fresh file for a symlink; matchOwner used chownSync, which
 * dereferences, handing the link's target — any root-owned file — to the
 * account. lchownSync affects the link itself, so the target is untouched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	symlinkSync,
	mkdirSync,
	statSync,
	lstatSync,
	chownSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matchOwner } from '../src/lib/branding.ts';

const NONROOT = 4242;
let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('matchOwner does not follow a planted symlink', () => {
	it('leaves the link target root-owned', () => {
		if ((process.getuid?.() ?? 1) !== 0) return; // only meaningful as root
		root = mkdtempSync(join(tmpdir(), 'morphit-matchowner-'));
		const victim = join(root, 'victim-root-only');
		writeFileSync(victim, 'secret\n'); // root-owned
		const refDir = join(root, 'builddir');
		mkdirSync(refDir);
		chownSync(refDir, NONROOT, NONROOT); // the non-root-owned dir
		const link = join(refDir, 'site-logo.svg');
		symlinkSync(victim, link); // attacker's planted link
		matchOwner(link, refDir);
		expect(statSync(victim).uid).toBe(0); // target still root
		expect(lstatSync(link).uid).toBe(NONROOT); // only the link was chowned
	});
});
