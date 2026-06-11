#!/usr/bin/env tsx
/**
 * repo-root-bak-recovery-smoke — `defaultRepoRoot()` must recover the live
 * install when the process's working directory has been stranded inside a
 * post-upgrade backup directory.
 *
 * Why: `morphit-ops upgrade` does `renameSync(installDir, installDir.bak-<ts>)`
 * then extracts a fresh tree into installDir. A shell sitting inside the
 * install during the upgrade keeps a cwd that now resolves INTO the backup,
 * so a naive cwd-walk reports paths like
 *   No morphit.config.env found at /opt/morphit.bak-1781151799741/apps/relay/…
 * even though /opt/morphit is perfectly healthy. This broke `morphit-ops`
 * #3 (edit) and #4 (alt-address) for an operator who had upgraded with a
 * shell open in the install dir. defaultRepoRoot() now strips the `.bak-<ts>`
 * segment and re-resolves to the live install.
 *
 * Scenarios:
 *   1. cwd inside a *partial* backup (`.bak/apps/relay` exists, no root
 *      package.json in the backup) → recovers the live install root.
 *   2. cwd inside a *full* backup (backup also has a root package.json) →
 *      still recovers the live install root, not the backup.
 *   3. cwd in a normal install (no backup) → returns it unchanged.
 *   4. cwd in a backup whose live install no longer exists → falls back to
 *      the cwd-derived path (no throw, no crash).
 *
 * Usage:
 *   tsx apps/ops-cli/scripts/repo-root-bak-recovery-smoke.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRepoRoot, cwdStrandedInUpgradeBackup } from '../src/lib/repoRoot.ts';

interface ScenarioResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: ScenarioResult[] = [];

const PKG_ROOT = JSON.stringify({ name: 'morphit', private: true, workspaces: ['apps/*'] }) + '\n';
const PKG_LEAF = JSON.stringify({ name: '@morphit/relay', private: true }) + '\n';

/** Create a monorepo-root package.json (declares workspaces). */
function mkroot(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'package.json'), PKG_ROOT);
}
/** Create a workspace-member package.json (no workspaces field). */
function mkleaf(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'package.json'), PKG_LEAF);
}

/** Run `fn` with process.cwd() temporarily set to `dir`, always restoring. */
function inDir<T>(dir: string, fn: () => T): T {
	const prev = process.cwd();
	try {
		process.chdir(dir);
		return fn();
	} finally {
		process.chdir(prev);
	}
}

function check(name: string, got: string, want: string): void {
	results.push({ name, ok: got === want, detail: got === want ? got : `got ${got} — want ${want}` });
}

function main(): void {
	// Scenario 1: partial backup (no root package.json in the .bak).
	{
		const root = mkdtempSync(join(tmpdir(), 'rr-partial-'));
		const live = join(root, 'morphit');
		mkroot(live);
		mkleaf(join(live, 'apps', 'relay'));
		const bakRelay = join(root, 'morphit.bak-1781151799741', 'apps', 'relay');
		mkleaf(bakRelay); // only apps/relay in the backup, no root pkg
		check('partial_backup_recovers_live', inDir(bakRelay, defaultRepoRoot), live);
		results.push({
			name: 'partial_backup_flagged_stranded',
			ok: inDir(bakRelay, cwdStrandedInUpgradeBackup) === true
		});
		rmSync(root, { recursive: true, force: true });
	}

	// Scenario 2: full backup (backup ALSO has a root package.json).
	{
		const root = mkdtempSync(join(tmpdir(), 'rr-full-'));
		const live = join(root, 'morphit');
		mkroot(live);
		mkleaf(join(live, 'apps', 'relay'));
		const bak = join(root, 'morphit.bak-1781151799999');
		mkroot(bak); // root pkg in the backup too
		mkleaf(join(bak, 'apps', 'relay'));
		check('full_backup_recovers_live', inDir(join(bak, 'apps', 'relay'), defaultRepoRoot), live);
		rmSync(root, { recursive: true, force: true });
	}

	// Scenario 3: normal install, no backup → unchanged.
	{
		const root = mkdtempSync(join(tmpdir(), 'rr-normal-'));
		const live = join(root, 'morphit');
		mkroot(live);
		mkleaf(join(live, 'apps', 'relay'));
		check('normal_install_unchanged', inDir(join(live, 'apps', 'relay'), defaultRepoRoot), live);
		results.push({
			name: 'normal_install_not_flagged',
			ok: inDir(join(live, 'apps', 'relay'), cwdStrandedInUpgradeBackup) === false
		});
		rmSync(root, { recursive: true, force: true });
	}

	// Scenario 4: backup with NO live install → graceful fallback (no throw).
	{
		const root = mkdtempSync(join(tmpdir(), 'rr-orphan-'));
		const bakRelay = join(root, 'morphit.bak-1781152000000', 'apps', 'relay');
		mkleaf(bakRelay); // backup exists, but there is NO live `morphit/`
		let threw = false;
		let got = '';
		try {
			got = inDir(bakRelay, defaultRepoRoot);
		} catch {
			threw = true;
		}
		results.push({
			name: 'orphan_backup_no_throw',
			ok: !threw && got.length > 0,
			detail: threw ? 'threw' : `fell back to ${got}`
		});
		rmSync(root, { recursive: true, force: true });
	}

	let pass = 0;
	let fail = 0;
	for (const r of results) {
		if (r.ok) {
			pass += 1;
			console.log(`  PASS  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		} else {
			fail += 1;
			console.error(`  FAIL  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		}
	}
	if (fail > 0) {
		console.error(`\nrepo-root-bak-recovery-smoke: ${pass} pass / ${fail} fail`);
		process.exit(1);
	}
	console.log(`\n✓ all ${pass} repo-root-bak-recovery scenarios passed`);
}

main();
