/**
 * morphit-ops install — guided first-time install
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
 * Until that VM validation happens (tracked in the backlog), this
 * command DETECTS what's missing and points at the exact existing,
 * tested path (the Ansible playbook, or the documented manual
 * steps) rather than running unvetted host mutation. That honesty
 * is the point: a half-tested installer that bricks a box is worse
 * than a guided checklist.
 */

import { existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultRepoRoot } from '../lib/repoRoot.ts';

import { ask, askYesNo, askChoice } from '../init/prompt.ts';
import { runInit } from './init.ts';
import { runHarden } from './harden.ts';
import { runEdit } from './edit.ts';
import { fastSyncFromChain, FAST_SYNC_REPLACED_UNUSABLE } from './fastSync.ts';
import { changedSoFar, noteInstallStage } from '../init/assembleInstall.ts';
import { resolveOutputPath } from '../init/render.ts';
import { loadInstallProgress } from '../init/installProgress.ts';
import { insideTmux, TMUX_EXIT_HINT } from '../lib/insideTmux.ts';
import { runAnsibleInstall } from '../init/runAnsibleInstall.ts';
import { healNpmUpdateNotice } from '../lib/npmNotice.ts';
import {
	applyBranding,
	brandingConfigured,
	buildDirOf,
	readBrandingSettings,
	syncTouchedToWebRoot
} from '../lib/branding.ts';
import { resolveWebRoot } from './upgrade.ts';
import { syncInstanceOrigin } from '../lib/instanceOrigin.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { startDotsSpinner, withSpinner } from '../init/spinner.ts';
import { runAsync } from '../lib/spinRun.ts';

export interface InstallCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** Where things are, and the steps this command hands off to. Every one
 *  defaults to the real one; tests replace them. */
export interface InstallDeps {
	/** The install (repo) root. Default: {@link defaultRepoRoot} — the
	 *  installed launcher runs the CLI from /opt/morphit/apps/ops-cli, so the
	 *  working directory is never the install root. */
	readonly repoRoot?: string;
	/** Where the guided install puts Morphit (the playbook's morphit_repo_path). */
	readonly installedRoot?: string;
	/** Prefix for system paths (/etc/systemd, /etc/morphit). */
	readonly root?: string;
	readonly runAnsibleInstall?: typeof runAnsibleInstall;
	readonly runInit?: typeof runInit;
	readonly runHarden?: typeof runHarden;
	readonly runEdit?: typeof runEdit;
	readonly fastSync?: (o: { repoRoot: string }) => number;
	readonly probePresent?: (cmd: string) => Promise<boolean>;
	readonly offerPathSymlink?: (repoRoot: string) => Promise<void>;
	readonly finishInstall?: (repoRoot: string) => void;
}

/** The Ansible playbook's morphit_repo_path (ops/ansible/group_vars/all.yml). */
const INSTALLED_ROOT = '/opt/morphit';

/**
 * This server already runs Morphit: its instance settings exist where the
 * guided install puts them — the same check `morphit-ops init` makes before it
 * would overwrite a configuration. An install that was interrupted (its
 * answers are saved for a resume) is not "already running". PURE given the
 * file system.
 */
export function alreadyInstalled(installedRoot: string, repoRoot: string): string | null {
	if (loadInstallProgress() !== null) return null;
	for (const dir of [installedRoot, repoRoot]) {
		const cfg = join(dir, 'morphit.config.env');
		if (existsSync(cfg)) return cfg;
	}
	return null;
}

/** True when the Morphit services are installed as systemd units here. */
function systemdUnitsInstalled(root: string): boolean {
	return ['/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'].some((d) =>
		existsSync(`${root}${d}/morphit-indexer.service`)
	);
}

/**
 * What to say after the configure-only install's fast-sync, from its exit code
 * (it used to be ignored: a failed or quarantined restore still ended with
 * "Start/enable your services"). PURE.
 */
export function afterFastSyncLines(rc: number): string[] {
	if (rc === 0) return [];
	if (rc === FAST_SYNC_REPLACED_UNUSABLE) {
		return [
			'  The restored database did not pass its checks (see above): do NOT start the',
			'  indexer on it. Follow the steps above first.'
		];
	}
	return [
		'  Fast-sync did not complete; the database is as it was. Your indexer replays the',
		'  chain itself when you start it, or run fast-sync again later, on this server:',
		'      sudo morphit-ops fast-sync'
	];
}

/**
 * How to start the services, exactly, on this server. Nothing when a fast-sync
 * left a database that must not be served (the steps above say what to do).
 * PURE.
 */
export function startServicesLines(o: {
	readonly systemd: boolean;
	readonly repoRoot: string;
	readonly fastSyncRc: number | null;
}): string[] {
	if (o.fastSyncRc === FAST_SYNC_REPLACED_UNUSABLE) {
		return ['   • Do not start the indexer yet: follow the fast-sync steps above first.'];
	}
	if (o.systemd) {
		return [
			'   • Start your services and have them start at boot, on this server:',
			'         sudo systemctl enable --now morphit-indexer',
			'     then, once `sudo morphit-ops health` shows the indexer answering:',
			'         sudo systemctl enable --now morphit-relay'
		];
	}
	return [
		'   • Start your services, on this server, each in its own terminal:',
		`         cd ${join(o.repoRoot, 'apps', 'indexer')} && npm start`,
		`         cd ${join(o.repoRoot, 'apps', 'relay')} && npm start`,
		`     (To run them as services that start at boot instead, the header of`,
		`     ${join(o.repoRoot, 'ops', 'systemd', 'morphit-indexer.service')} lists the exact commands.)`
	];
}

/**
 * "Configure only", stopped during its fast-sync (exit 130 Ctrl+C, 129 a closed
 * terminal, 143 a stop): the install stops there, says what it did and what is
 * left, each with its command. PURE apart from the install's stage.
 */
export function stoppedDuringFastSyncLines(
	rc: number,
	o: { readonly systemd: boolean; readonly repoRoot: string }
): string[] {
	const why =
		rc === 129
			? 'the terminal was closed'
			: rc === 143
				? 'it was told to stop'
				: 'you pressed Ctrl+C';
	return [
		'',
		`Stopped \u2014 ${why} during the fast-sync; the indexer\u2019s database is as it was.`,
		`  ${changedSoFar()}`,
		'  Still to do, any time, on this server:',
		'   \u2022 Fast-sync:  sudo morphit-ops fast-sync',
		'   \u2022 Hardening:  sudo morphit-ops harden',
		`   \u2022 Warrant canary, on your signing machine:  bash ${join(o.repoRoot, 'scripts', 'canary', 'setup.sh')}`,
		...startServicesLines({ systemd: o.systemd, repoRoot: o.repoRoot, fastSyncRc: null }),
		''
	];
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
		fixHint:
			'Install Node 22 LTS (see docs/RUN-A-MORPHIT-NODE.md "Install Node.js and PostgreSQL").'
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
async function realProbePresent(cmd: string): Promise<boolean> {
	const parts = cmd.split(' ');
	const bin = parts[0]!;
	const args = parts.slice(1);
	// Asynchronous, so the caller's spinner turns while it runs.
	const r = await runAsync(bin, args, { timeoutMs: 60_000 });
	return r.status === 0;
}

export async function runInstall(ctx: InstallCtx, deps: InstallDeps = {}): Promise<number> {
	// Nothing asked yet: a stop now has nothing to keep and changed nothing.
	noteInstallStage('none');
	const repoRoot = deps.repoRoot ?? defaultRepoRoot();
	const probePresent = deps.probePresent ?? realProbePresent;
	const finish = deps.finishInstall ?? finishInstall;
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
		const existing = alreadyInstalled(deps.installedRoot ?? INSTALLED_ROOT, repoRoot);
		if (existing !== null) {
			const go = await alreadyInstalledChoice(existing, ctx, deps);
			if (go !== 'install') return go;
		}
		try {
			const code = await (deps.runAnsibleInstall ?? runAnsibleInstall)({ repoRoot });
			if (code === 0) finish(repoRoot);
			return code;
		} finally {
			// The guide runs the install inside tmux; say how to leave it — also
			// when it stopped (Ctrl+C at a question throws; review, 2026-10-12).
			if (insideTmux()) console.log(`\n${TMUX_EXIT_HINT}\n`);
		}
	}

	console.log('');
	console.log('  This walks you through standing up a Morphit node. Here is');
	console.log('  the whole arc, so nothing is a surprise:');
	console.log('');
	console.log('    1. Check prerequisites (Node, PostgreSQL, git).');
	console.log('    2. Configure your instance (the setup wizard).');
	console.log('    3. (Optional) harden the server.');
	console.log('    4. (Optional) make `morphit-ops` runnable from anywhere.');
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
		const ok = await withSpinner(`Checking ${p.name}…`, () => probePresent(p.probe));
		console.log(`  ${ok ? '✓' : '✗'} ${p.name}`);
		if (!ok) {
			console.log(`      → ${p.fixHint}`);
			allPresent = false;
		}
	}
	console.log('');

	if (!allPresent) {
		console.log('Some prerequisites are missing. Install them (the lines above');
		console.log('point at the exact docs), then run this again from the install');
		console.log('directory:  sudo node apps/ops-cli/bin/morphit-ops.mjs install');
		console.log('Nothing has been changed on your system.');
		console.log('');
		console.log('Tip: the Ansible playbook in ops/ansible/ installs all of these');
		console.log('for you on a fresh Ubuntu box — see docs/start-here/README.md.');
		return 1;
	}

	console.log('All prerequisites present.');
	console.log('');
	const proceed = await askYesNo('Continue to the setup wizard now?', true);
	if (!proceed) {
		console.log(
			'\nStopped. When ready, run from the install directory:  sudo node apps/ops-cli/bin/morphit-ops.mjs install'
		);
		return 0;
	}

	// ─── 2. Configure (hand off to the existing init wizard) ────
	console.log('');
	console.log('Step 2 — configuring your instance...');
	noteInstallStage('questions');
	const initCode = await (deps.runInit ?? runInit)({
		flags: ctx.flags,
		positional: ctx.positional,
		colorEnabled: ctx.colorEnabled
	});
	if (initCode !== 0) {
		console.log('');
		console.log('Setup wizard did not complete. Fix the issue above and re-run');
		console.log(
			'`sudo node apps/ops-cli/bin/morphit-ops.mjs install` from the install directory. (You can also run'
		);
		console.log('the wizard alone with `sudo node apps/ops-cli/bin/morphit-ops.mjs init`.)');
		return initCode;
	}
	// The wizard wrote this node's settings: a stop from here says so (it said
	// "Nothing was installed or changed" — review, 2026-10-29).
	noteInstallStage('configured', {
		settingsDir: resolveOutputPath(ctx.flags.out, defaultRepoRoot())
	});

	// ─── 3. Fast-sync (recommended, default yes) ────────────────
	console.log('');
	console.log('Step 3 — get the orderbook live fast.');
	console.log('  A fresh node can restore the newest signed federation snapshot and be');
	console.log('  live in MINUTES, instead of replaying the whole chain for days. You trust');
	console.log('  the publisher (@morphit) for the settled state; the recent tail is');
	console.log('  re-verified from chain and a spot-check confirms it before serving.');
	console.log('  Prefer zero trust? Decline, and your indexer replays the chain itself.');
	console.log('');
	const wantFastSync = await askYesNo('Fast-sync this node from a federation snapshot now?', true);
	let fastSyncRc: number | null = null;
	if (wantFastSync) {
		// How to start the services is said once, at the end (it was said here
		// as "start", then again as "enable --now" — review, 2026-10-29).
		fastSyncRc = (deps.fastSync ?? ((o) => fastSyncFromChain({ ...o, callerSaysNext: true })))({
			repoRoot
		});
		if (fastSyncRc === 130 || fastSyncRc === 129 || fastSyncRc === 143) {
			// Stopped (Ctrl+C) during the fast-sync: the install stops there, not
			// on to the next question (review, 2026-10-29).
			for (const l of stoppedDuringFastSyncLines(fastSyncRc, {
				systemd: systemdUnitsInstalled(deps.root ?? ''),
				repoRoot
			}))
				console.log(l);
			return fastSyncRc;
		}
		for (const l of afterFastSyncLines(fastSyncRc)) console.log(l);
	} else {
		console.log('  Skipped — the indexer replays the chain itself when you start it.');
		console.log('  You can fast-sync any time, on this server: sudo morphit-ops fast-sync');
	}

	// ─── 4. Offer hardening ─────────────────────────────────────
	console.log('');
	console.log('Step 4 — server hardening (recommended before going public).');
	const wantHarden = await askYesNo('Walk through server hardening now?', true);
	if (wantHarden) {
		await (deps.runHarden ?? runHarden)({
			flags: ctx.flags,
			positional: ctx.positional,
			colorEnabled: ctx.colorEnabled
		});
	} else {
		console.log('  Skipped. Run `sudo morphit-ops harden` any time.');
	}

	// ─── 5. Warrant canary (transparency signal) ───────────────
	console.log('');
	console.log('Step 5 — warrant canary (a transparency signal for your users).');
	console.log('  A signed /canary.txt you refresh on a schedule; if it ever goes stale,');
	console.log('  users infer something changed (a gag order, a seizure). It is SIGNED with');
	console.log('  your key — ideally on a machine OFF this server — so the guided setup runs');
	console.log('  there, not here. This is a genuinely good thing to set up early.');
	const wantCanary = await askYesNo('Set up a warrant canary now?', true);
	if (wantCanary) {
		const canarySetup = join(repoRoot, 'scripts', 'canary', 'setup.sh');
		console.log('');
		console.log('  Run the guided setup on your SIGNING machine (home box / laptop — the');
		console.log('  one holding your signing key, not necessarily this server):');
		console.log('');
		console.log(`    bash ${canarySetup}`);
		console.log('');
		console.log('  It walks through key choice, the first signed canary, and the weekly');
		console.log('  refresh timer. `morphit-ops health` shows the canary status afterwards.');
	} else {
		console.log('  Skipped. Set one up any time — `morphit-ops harden` → warrant canary, or');
		console.log('  bash scripts/canary/setup.sh on your signing machine.');
	}

	// ─── 6. Offer the PATH symlink (kill the npx friction) ──────
	console.log('');
	console.log('Step 6 — convenience.');
	await (deps.offerPathSymlink ?? offerPathSymlink)(repoRoot);
	finish(repoRoot);

	console.log('');
	console.log('━'.repeat(60));
	console.log('  Install steps complete.');
	console.log('━'.repeat(60));
	console.log('');
	console.log('  Next:');
	for (const l of startServicesLines({
		systemd: systemdUnitsInstalled(deps.root ?? ''),
		repoRoot,
		fastSyncRc
	}))
		console.log(l);
	console.log('   • Register on-chain:  sudo morphit-ops register');
	console.log('   • Check status:       sudo morphit-ops status');
	console.log('   • Update later:       sudo morphit-ops upgrade');
	console.log('');
	return 0;
}

/**
 * The guided install on a server that already runs Morphit: say so, and offer
 * what is usually meant instead, defaulting to changing nothing. Returns
 * 'install' to go on, or the exit code to stop with.
 */
async function alreadyInstalledChoice(
	configPath: string,
	ctx: InstallCtx,
	deps: InstallDeps
): Promise<'install' | number> {
	console.log('');
	console.log('━'.repeat(58));
	console.log('  This server already runs Morphit');
	console.log('━'.repeat(58));
	console.log('');
	console.log(`  Its settings are at ${configPath}.`);
	console.log('  Installing again asks every setup question again, replaces those settings,');
	console.log('  and makes a new database password. To change a few settings, use "Edit".');
	console.log('  For a newer version: sudo morphit-ops upgrade');
	console.log('');
	const choice = await askChoice(
		'What would you like to do?',
		[
			'Edit a few settings — opens the edit menu now',
			'Install everything again from scratch',
			'Cancel — change nothing'
		],
		2
	);
	if (choice === 0) {
		// The installed node's settings — the folder they were found in — not
		// the folder this install was started from (an unpacked release has
		// none, and edit then said "run init" — review, 2026-10-29).
		return (deps.runEdit ?? runEdit)({
			flags: { ...ctx.flags, out: dirname(configPath) },
			positional: ctx.positional,
			colorEnabled: ctx.colorEnabled
		});
	}
	if (choice === 2) {
		console.log('\n  Cancelled. Nothing was changed.');
		return 0;
	}
	const sure = await askYesNo(
		'Are you sure? This replaces this node’s settings and its database password',
		false
	);
	if (!sure) {
		console.log('\n  Cancelled. Nothing was changed.');
		return 0;
	}
	return 'install';
}

/**
 * Last steps of any install:
 *  - npm's "New major version of npm available!" notice off box-wide, and the
 *    global npmrc root-owned 0644 (lib/npmNotice.ts) — the wizard itself runs
 *    under an npx whose notice would otherwise print right after this;
 *  - a re-install on a box that already has branding set up
 *    (/etc/morphit/branding, MORPHIT_INSTANCE_BRAND_NAME) serves it at once,
 *    instead of plain Morphit until the next upgrade.
 * Best-effort: neither may fail an install.
 */
function finishInstall(repoRoot: string): void {
	// Each wait below is synchronous: the spinner's label is on the line for it.
	const spun = <T>(label: string, fn: () => T): T => {
		const stop = startDotsSpinner(label);
		try {
			return fn();
		} finally {
			stop();
		}
	};
	spun('Turning off npm’s update notice…', () => healNpmUpdateNotice());
	// every install's pages name this instance's own origin (never
	// a clearnet one on a hidden-only node), branding or not.
	try {
		const webRoot = resolveWebRoot(process.env);
		const r = syncInstanceOrigin(
			{
				info: (m) => console.log(`  ${m}`),
				warn: (m) => console.log(`  ! ${m}`),
				spinner: (l) => startDotsSpinner(l)
			},
			{
				installDir: repoRoot,
				buildDir: buildDirOf(repoRoot),
				webRoot: existsSync(webRoot) ? webRoot : null
			}
		);
		if (r.detail !== '') console.log(`  ${r.verified ? '' : '! '}${sanitizeForTerm(r.detail)}`);
	} catch (err) {
		console.log(
			`  ! Your instance origin could not be applied (${sanitizeForTerm(err instanceof Error ? err.message : String(err))}). ` +
				'Run: sudo morphit-ops upgrade'
		);
	}
	try {
		const settings = readBrandingSettings(repoRoot);
		if (!brandingConfigured(settings)) return;
		const buildDir = buildDirOf(repoRoot);
		const r = spun('Applying your branding…', () => applyBranding({ buildDir, settings }));
		if (r.unsupported) return;
		const webRoot = resolveWebRoot(process.env);
		if (r.touched.length > 0 && existsSync(webRoot))
			spun('Copying the branded files to the web root…', () =>
				syncTouchedToWebRoot(buildDir, webRoot, r.touched)
			);
		if (r.active) console.log('  \u2713 Applied your existing branding (docs/BRANDING.md).');
		for (const w of r.warnings) console.log(`  ! ${sanitizeForTerm(w)}`);
	} catch (err) {
		console.log(
			`  ! Your branding was not applied (${sanitizeForTerm(err instanceof Error ? err.message : String(err))}). ` +
				'Run: sudo morphit-ops branding apply'
		);
	}
}

/**
 * Offer to symlink the project-local morphit-ops bin onto PATH so
 * the operator can type `morphit-ops` instead of the launcher's path.
 * This is the fix for the recurring "morphit-ops: command not
 * found" confusion: the tool is a project-local bin, so without a
 * symlink it's only reachable by its path in the install dir.
 *
 * We target /usr/local/bin (conventional, on PATH, not managed by
 * the package manager). We never overwrite an existing file there
 * without asking, and we point the link at the install's own bin
 * launcher so it always tracks this install.
 */
async function offerPathSymlink(repoRoot: string): Promise<void> {
	const binTarget = join(repoRoot, 'apps', 'ops-cli', 'bin', 'morphit-ops.mjs');
	if (!existsSync(binTarget)) {
		// Not in an install tree (or unusual layout) — skip silently
		// rather than guess.
		console.log('  (Skipping the PATH shortcut — run this from your install directory');
		console.log(
			'   if you want it. For now, use `sudo node apps/ops-cli/bin/morphit-ops.mjs <command>` there.)'
		);
		return;
	}

	console.log(
		'  Right now you run the tool as `sudo node apps/ops-cli/bin/morphit-ops.mjs <command>` from'
	);
	console.log('  this directory. I can add a system-wide shortcut so you can just');
	console.log('  type `morphit-ops <command>` from anywhere.');
	console.log('');
	const want = await askYesNo('Add the `morphit-ops` shortcut to /usr/local/bin?', true);
	if (!want) {
		console.log(
			'  Skipped. You can always run `sudo node apps/ops-cli/bin/morphit-ops.mjs <command>` from this directory.'
		);
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
		console.log(
			'  (Until then, `sudo node apps/ops-cli/bin/morphit-ops.mjs <command>` from this directory works fine.)'
		);
	}
}
