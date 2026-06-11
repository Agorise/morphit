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
import { itemSuffix, itemEmphasis, rootTag, MENU_GROUPS } from '../src/commands/mainMenu.ts';
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
	const s = strip(itemSuffix('upgrade', { currentVersion: 'v1.0.0-beta.4', latestVersion: 'v1.0.0-beta.5', unresolvedFlags: null, relayBalanceStatus: null }));
	truthy('upgrade: shows now + latest', s.includes('now: v1.0.0-beta.4') && s.includes('latest: v1.0.0-beta.5'), s);
	truthy('upgrade: flags update available when they differ', s.includes('update available'), s);
}
{
	const s = strip(itemSuffix('upgrade', { currentVersion: 'v1.0.0-beta.5', latestVersion: 'v1.0.0-beta.5', unresolvedFlags: null, relayBalanceStatus: null }));
	truthy('upgrade: same version → no "update available"', s.includes('now: v1.0.0-beta.5') && !s.includes('update available'), s);
}
{
	const s = strip(itemSuffix('upgrade', { currentVersion: 'v1.0.0-beta.5', latestVersion: null, unresolvedFlags: null, relayBalanceStatus: null }));
	truthy('upgrade: latest unknown → "now:" only, graceful', s.includes('now: v1.0.0-beta.5') && !s.includes('latest:'), s);
}
truthy('upgrade: both unknown → empty suffix', itemSuffix('upgrade', { currentVersion: null, latestVersion: null, unresolvedFlags: null, relayBalanceStatus: null }) === '');

// ── itemSuffix: Moderation item ──
{
	const s = strip(itemSuffix('moderation', { currentVersion: null, latestVersion: null, unresolvedFlags: 3, relayBalanceStatus: null }));
	truthy('moderation: ⚠ marker + count when unresolved > 0', s.includes('\u26a0') && s.includes('3 to review'), s);
}
truthy('moderation: 0 unresolved → no marker', itemSuffix('moderation', { currentVersion: null, latestVersion: null, unresolvedFlags: 0, relayBalanceStatus: null }) === '');
truthy('moderation: null count → no marker', itemSuffix('moderation', { currentVersion: null, latestVersion: null, unresolvedFlags: null, relayBalanceStatus: null }) === '');

// ── itemSuffix: unrelated items + missing annotations ──
truthy('status item → no suffix', itemSuffix('status', { currentVersion: 'v1', latestVersion: 'v2', unresolvedFlags: 5, relayBalanceStatus: null }) === '');
truthy('no annotations → no suffix', itemSuffix('upgrade', undefined) === '');

// ── itemSuffix: Status relay-balance (beta6) ──
{
	const err = strip(itemSuffix('status', { currentVersion: null, latestVersion: null, unresolvedFlags: null, relayBalanceStatus: 'error' }));
	truthy('status: error → red-flag + "relay balance very low"', err.includes('\u{1F6A9}') && /very low/i.test(err), err);
	const warn = strip(itemSuffix('status', { currentVersion: null, latestVersion: null, unresolvedFlags: null, relayBalanceStatus: 'warn' }));
	truthy('status: warn → ⚠ + "relay balance low"', warn.includes('\u26a0') && /relay balance low/i.test(warn), warn);
	truthy('status: ok → no suffix', itemSuffix('status', { currentVersion: null, latestVersion: null, unresolvedFlags: null, relayBalanceStatus: 'ok' }) === '');
	truthy('status: null balance → no suffix', itemSuffix('status', { currentVersion: null, latestVersion: null, unresolvedFlags: null, relayBalanceStatus: null }) === '');
}

// ── itemEmphasis: whole-label coloring signal (beta6) ──
{
	const A = (o: Partial<{ currentVersion: string | null; latestVersion: string | null; unresolvedFlags: number | null; relayBalanceStatus: 'ok' | 'warn' | 'error' | null }>) =>
		({ currentVersion: null, latestVersion: null, unresolvedFlags: null, relayBalanceStatus: null, ...o });
	truthy('emphasis: upgrade w/ newer latest → "update"', itemEmphasis('upgrade', A({ currentVersion: 'v1.0.0-beta.5', latestVersion: 'v1.0.0-beta.6' })) === 'update');
	truthy('emphasis: upgrade same version → null', itemEmphasis('upgrade', A({ currentVersion: 'v1.0.0-beta.6', latestVersion: 'v1.0.0-beta.6' })) === null);
	truthy('emphasis: status balance error → "balance-error"', itemEmphasis('status', A({ relayBalanceStatus: 'error' })) === 'balance-error');
	truthy('emphasis: status balance warn → "balance-warn"', itemEmphasis('status', A({ relayBalanceStatus: 'warn' })) === 'balance-warn');
	truthy('emphasis: status balance ok → null', itemEmphasis('status', A({ relayBalanceStatus: 'ok' })) === null);
	truthy('emphasis: moderation flags → null (suffix-only, no label color)', itemEmphasis('moderation', A({ unresolvedFlags: 5 })) === null);
	truthy('emphasis: no annotations → null', itemEmphasis('upgrade', undefined) === null);
}

// ── rootTag: "(needs sudo)" on the first line of privileged items ──
{
	// `health` is the only unprivileged menu subcommand (HTTP /v1/health, no
	// config or DB); every other item touches config / DB / privileged ops, so
	// it must carry the tag. Asserted against the LIVE menu so a newly added
	// command can't silently skip (or wrongly gain) the annotation.
	const allSubcommands = MENU_GROUPS.flatMap((g) => g.items.map((i) => i.subcommand));
	let tagOk = true;
	let detail = '';
	for (const sc of allSubcommands) {
		const tagged = strip(rootTag(sc)).includes('needs sudo');
		const shouldTag = sc !== 'health';
		if (tagged !== shouldTag) {
			tagOk = false;
			detail = `${sc}: tagged=${tagged} expected=${shouldTag}`;
			break;
		}
	}
	truthy('rootTag: every privileged menu item tagged, health not', tagOk, detail);
}
truthy('rootTag: status tagged', strip(rootTag('status')).includes('needs sudo'));
truthy('rootTag: install tagged', strip(rootTag('install')).includes('needs sudo'));
truthy('rootTag: doctor tagged', strip(rootTag('doctor')).includes('needs sudo'));
truthy('rootTag: signups (DB view) tagged', strip(rootTag('signups')).includes('needs sudo'));
truthy('rootTag: health NOT tagged', rootTag('health') === '');
truthy('rootTag: unknown subcommand NOT tagged', rootTag('definitely-not-a-command') === '');

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
