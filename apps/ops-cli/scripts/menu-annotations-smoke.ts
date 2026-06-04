/**
 * menu-annotations-smoke (beta5).
 *
 * Tests the menu's best-effort annotation rendering (itemSuffix) and
 * the installed-version read (readCurrentVersion). The network fetch +
 * DB count are best-effort and exercised against real services during
 * development; here we lock the pure rendering + the version-file read,
 * including the graceful "nothing to show" cases.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { itemSuffix } from '../src/commands/mainMenu.ts';
import { readCurrentVersion } from '../src/lib/menuAnnotations.ts';

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

let pass = 0;
let fail = 0;
const truthy = (n: string, c: boolean, d = '') => {
	if (c) {
		pass++;
		console.log(`  \u2713 ${n}`);
	} else {
		fail++;
		console.log(`  \u2717 ${n}`);
		if (d) console.log(`      ${d}`);
	}
};

// ── itemSuffix: Upgrade item ──
{
	const s = strip(itemSuffix('upgrade', { currentVersion: 'v1.0.0-beta.4', latestVersion: 'v1.0.0-beta.5', unresolvedFlags: null }));
	truthy('upgrade: shows now + latest', s.includes('now: v1.0.0-beta.4') && s.includes('latest: v1.0.0-beta.5'), s);
	truthy('upgrade: flags update available when they differ', s.includes('update available'), s);
}
{
	const s = strip(itemSuffix('upgrade', { currentVersion: 'v1.0.0-beta.5', latestVersion: 'v1.0.0-beta.5', unresolvedFlags: null }));
	truthy('upgrade: same version → no "update available"', s.includes('now: v1.0.0-beta.5') && !s.includes('update available'), s);
}
{
	const s = strip(itemSuffix('upgrade', { currentVersion: 'v1.0.0-beta.5', latestVersion: null, unresolvedFlags: null }));
	truthy('upgrade: latest unknown → "now:" only, graceful', s.includes('now: v1.0.0-beta.5') && !s.includes('latest:'), s);
}
truthy('upgrade: both unknown → empty suffix', itemSuffix('upgrade', { currentVersion: null, latestVersion: null, unresolvedFlags: null }) === '');

// ── itemSuffix: Moderation item ──
{
	const s = strip(itemSuffix('moderation', { currentVersion: null, latestVersion: null, unresolvedFlags: 3 }));
	truthy('moderation: ⚠ marker + count when unresolved > 0', s.includes('\u26a0') && s.includes('3 to review'), s);
}
truthy('moderation: 0 unresolved → no marker', itemSuffix('moderation', { currentVersion: null, latestVersion: null, unresolvedFlags: 0 }) === '');
truthy('moderation: null count → no marker', itemSuffix('moderation', { currentVersion: null, latestVersion: null, unresolvedFlags: null }) === '');

// ── itemSuffix: unrelated items + missing annotations ──
truthy('status item → no suffix', itemSuffix('status', { currentVersion: 'v1', latestVersion: 'v2', unresolvedFlags: 5 }) === '');
truthy('no annotations → no suffix', itemSuffix('upgrade', undefined) === '');

// ── readCurrentVersion ──
{
	const dir = mkdtempSync(join(tmpdir(), 'morphit-relinfo-'));
	try {
		writeFileSync(join(dir, 'release-info.json'), JSON.stringify({ tag: 'v1.0.0-beta.5', built_at: 'x' }));
		const prev = process.env.MORPHIT_INSTALL_DIR;
		process.env.MORPHIT_INSTALL_DIR = dir;
		truthy('readCurrentVersion: reads tag from release-info.json', readCurrentVersion() === 'v1.0.0-beta.5');
		process.env.MORPHIT_INSTALL_DIR = join(dir, 'does-not-exist');
		truthy('readCurrentVersion: missing file → null', readCurrentVersion() === null);
		if (prev === undefined) delete process.env.MORPHIT_INSTALL_DIR;
		else process.env.MORPHIT_INSTALL_DIR = prev;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 menu-annotations smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} menu-annotations scenarios passed`);
