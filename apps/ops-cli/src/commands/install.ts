/**
 * morphit-ops install (cp192) — guided first-time install
 * orchestrator.
 *
 * STATUS: scaffold. The pieces this command sequences already
 * exist and are individually tested (the Ansible role under
 * ops/ansible/ does the clone/build/Node/Postgres/units, the
 * `init` wizard configures, `harden` secures). What this adds is a
 * single front door that (1) checks the prerequisites are present,
 * (2) explains the whole arc up front so a new operator isn't
 * guessing, (3) offers to put `morphit-ops` on PATH so they never
 * fight `npx`, and (4) hands off to `init` (and offers `harden`).
 *
 * What it deliberately does NOT do yet: install Node/Postgres or
 * lay down systemd units FOR the operator. Those steps need to run
 * as root, mutate the host, and — critically — be validated on a
 * real fresh Ubuntu box before we tell anyone they're "smooth."
 * Until that VM validation happens (tracked in REVISIT-LIST), this
 * command DETECTS what's missing and points at the exact existing,
 * tested path (the Ansible playbook, or the documented manual
 * steps) rather than running unvetted host mutation. That honesty
 * is the point: a half-tested installer that bricks a box is worse
 * than a guided checklist.
 */

import { existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRepoRoot, safeCwd } from '../lib/repoRoot.ts';

import { ask, askYesNo, askChoice } from '../init/prompt.ts';
import { runInit } from './init.ts';
import { runHarden } from './harden.ts';
import { runAnsibleInstall } from '../init/runAnsibleInstall.ts';

export interface InstallCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

interface Prereq {
	readonly name: string;
	readonly probe: string; // command to run; exit 0 = present
	readonly minHint: string;
	readonly fixHint: string;
}

const PREREQS: readonly Prereq[] = [
	{
		name: 'Node.js (>= 22)',
		probe: 'node --version',
		minHint: 'Node.js 22 LTS',
		fixHint: 'Install Node 22 LTS (see docs/RUN-A-MORPHIT-NODE.md "Install Node.js and PostgreSQL").'
	},
	{
		name: 'npm',
		probe: 'npm --version',
		minHint: 'npm (ships with Node)',
		fixHint: 'npm ships with Node.js; if missing, reinstall Node 22 LTS.'
	},
	{
		name: 'PostgreSQL client (psql)',
		probe: 'psql --version',
		minHint: 'PostgreSQL 14+',
		fixHint: 'Install PostgreSQL (see docs/RUN-A-MORPHIT-NODE.md "Install Node.js and PostgreSQL").'
	},
	{
		name: 'git',
		probe: 'git --version',
		minHint: 'git',
		fixHint: 'sudo apt-get install -y git'
	}
];

/** Run a probe command, return true if it exits 0. Uses the
 *  child_process import lazily to keep the module's top-level
 *  import surface small. */
async function probePresent(cmd: string): Promise<boolean> {
	const { spawnSync } = await import('node:child_process');
	const parts = cmd.split(' ');
	const bin = parts[0]!;
	const args = parts.slice(1);
	try {
		const r = spawnSync(bin, args, { stdio: 'ignore' });
		return r.status === 0;
	} catch {
		return false;
	}
}

export async function runInstall(ctx: InstallCtx): Promise<number> {
	console.log('');
	console.log('━'.repeat(60));
	console.log('  Morphit — guided install');
	console.log('━'.repeat(60));
	console.log('');

	// ─── Mode: full guided install (Ansible) vs configure-only ──
	// The full path installs EVERYTHING on this box (the same hardened stack a
	// VPS gets); configure-only is the older path for operators who already
	// installed Node/PostgreSQL/nginx themselves. Default to full for grandma.
	const modeIdx = await askChoice('How would you like to install Morphit?', [
		'Full guided install \u2014 set EVERYTHING up on this computer for me (recommended)',
		'Configure only \u2014 I already installed Node, PostgreSQL, and nginx myself'
	]);
	if (modeIdx === 0) {
		const repoRoot = safeCwd() ?? defaultRepoRoot();
		return runAnsibleInstall({ repoRoot });
	}

	console.log('');
	console.log('  This walks you through standing up a Morphit node. Here is');
	console.log('  the whole arc, so nothing is a surprise:');
	console.log('');
	console.log('    1. Check prerequisites (Node, PostgreSQL, git).');
	console.log('    2. Configure your instance (the setup wizard).');
	console.log('    3. (Optional) harden the server.');
	console.log('    4. (Optional) make `morphit-ops` runnable without `npx`.');
	console.log('');
	console.log('  For the fully-automated path on a fresh Ubuntu server, the');
	console.log('  Ansible playbook in ops/ansible/ does the OS-level install');
	console.log('  (Node, PostgreSQL, build, systemd units) for you — see');
	console.log('  docs/start-here/README.md. This command is the interactive,');
	console.log('  learn-as-you-go path.');
	console.log('');

	// ─── 1. Prerequisites ──────────────────────────────────────
	console.log('Step 1 — checking prerequisites...');
	console.log('');
	let allPresent = true;
	for (const p of PREREQS) {
		const ok = await probePresent(p.probe);
		console.log(`  ${ok ? '✓' : '✗'} ${p.name}`);
		if (!ok) {
			console.log(`      → ${p.fixHint}`);
			allPresent = false;
		}
	}
	console.log('');

	if (!allPresent) {
		console.log('Some prerequisites are missing. Install them (the lines above');
		console.log('point at the exact docs), then run `npx morphit-ops install`');
		console.log('again. Nothing has been changed on your system.');
		console.log('');
		console.log('Tip: the Ansible playbook in ops/ansible/ installs all of these');
		console.log('for you on a fresh Ubuntu box — see docs/start-here/README.md.');
		return 1;
	}

	console.log('All prerequisites present.');
	console.log('');
	const proceed = await askYesNo('Continue to the setup wizard now?', true);
	if (!proceed) {
		console.log('\nStopped. Run `npx morphit-ops install` (or `npx morphit-ops init`) when ready.');
		return 0;
	}

	// ─── 2. Configure (hand off to the existing init wizard) ────
	console.log('');
	console.log('Step 2 — configuring your instance...');
	const initCode = await runInit({
		flags: ctx.flags,
		positional: ctx.positional,
		colorEnabled: ctx.colorEnabled
	});
	if (initCode !== 0) {
		console.log('');
		console.log('Setup wizard did not complete. Fix the issue above and re-run');
		console.log('`npx morphit-ops install`. (You can also run the wizard alone');
		console.log('with `npx morphit-ops init`.)');
		return initCode;
	}

	// ─── 3. Offer hardening ─────────────────────────────────────
	console.log('');
	console.log('Step 3 — server hardening (recommended before going public).');
	const wantHarden = await askYesNo('Walk through server hardening now?', true);
	if (wantHarden) {
		await runHarden({
			flags: ctx.flags,
			positional: ctx.positional,
			colorEnabled: ctx.colorEnabled
		});
	} else {
		console.log('  Skipped. Run `npx morphit-ops harden` any time.');
	}

	// ─── 4. Offer the PATH symlink (kill the npx friction) ──────
	console.log('');
	console.log('Step 4 — convenience.');
	await offerPathSymlink();

	console.log('');
	console.log('━'.repeat(60));
	console.log('  Install steps complete.');
	console.log('━'.repeat(60));
	console.log('');
	console.log('  Next:');
	console.log('   • Start/enable your services (see docs/RUN-A-MORPHIT-NODE.md).');
	console.log('   • Register on-chain:  npx morphit-ops register');
	console.log('   • Check status:       npx morphit-ops status');
	console.log('   • Update later:       npx morphit-ops upgrade');
	console.log('');
	return 0;
}

/**
 * Offer to symlink the project-local morphit-ops bin onto PATH so
 * the operator can type `morphit-ops` instead of `npx morphit-ops`.
 * This is the fix for the recurring "morphit-ops: command not
 * found" confusion: the tool is a project-local bin, so without a
 * symlink it's only reachable via npx from the install dir.
 *
 * We target /usr/local/bin (conventional, on PATH, not managed by
 * the package manager). We never overwrite an existing file there
 * without asking, and we point the link at the install's own bin
 * launcher so it always tracks this install.
 */
async function offerPathSymlink(): Promise<void> {
	const binTarget = join(safeCwd() ?? defaultRepoRoot(), 'apps', 'ops-cli', 'bin', 'morphit-ops.mjs');
	if (!existsSync(binTarget)) {
		// Not in an install tree (or unusual layout) — skip silently
		// rather than guess.
		console.log('  (Skipping the PATH shortcut — run this from your install directory');
		console.log('   if you want it. For now, use `npx morphit-ops <command>`.)');
		return;
	}

	console.log('  Right now you run the tool as `npx morphit-ops <command>` from');
	console.log('  this directory. I can add a system-wide shortcut so you can just');
	console.log('  type `morphit-ops <command>` from anywhere.');
	console.log('');
	const want = await askYesNo('Add the `morphit-ops` shortcut to /usr/local/bin?', true);
	if (!want) {
		console.log('  Skipped. You can always run `npx morphit-ops <command>`.');
		return;
	}

	const linkPath = '/usr/local/bin/morphit-ops';
	console.log('');
	console.log('  This needs root. If it fails with a permission error, re-run the');
	console.log('  single command it prints below with sudo.');
	console.log('');
	try {
		if (existsSync(linkPath)) {
			const overwrite = await askYesNo(`  ${linkPath} already exists. Replace it?`, false);
			if (!overwrite) {
				console.log('  Left the existing file in place.');
				return;
			}
			unlinkSync(linkPath);
		}
		symlinkSync(binTarget, linkPath);
		console.log(`  ✓ Created ${linkPath} → ${binTarget}`);
		console.log('    You can now run `morphit-ops <command>` from anywhere.');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  Could not create the shortcut (${msg}).`);
		console.log('  Run this once, with sudo, to add it yourself:');
		console.log('');
		console.log(`    sudo ln -sf "${binTarget}" "${linkPath}"`);
		console.log('');
		console.log('  (Until then, `npx morphit-ops <command>` works fine.)');
	}
}
