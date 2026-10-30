/**
 * morphit-ops harden — a focused, re-runnable hardening
 * wizard.
 *
 * Hardening was previously reachable ONLY as the tail of the
 * `init` setup wizard (stepBunkerWeb + stepHardening), so an
 * operator who wanted to revisit "how do I set up BunkerWeb / the
 * firewall / backups / TLS" later had nowhere to go.  This command
 * surfaces all of it on demand, as its own menu, and is the menu
 * entry behind "Harden this server" in bare `morphit-ops`.
 *
 * Design (no duplication, no drift):
 *   - The actual hardening WORK lives in the shipped Ansible role
 *     (ops/ansible/roles/hardening + tls), the nginx/bunkerweb
 *     configs (ops/nginx, ops/bunkerweb), the backup units
 *     (ops/backup, ops/systemd), and the reference docs
 *     (OPERATIONS.md §32/§34/§35/§37).  This command does NOT
 *     re-implement any of it.
 *   - It REUSES the init wizard's step functions where they fit
 *     (stepHardening, stepBackup — shown standalone, without the wizard's
 *     "Step N of 23" headers) and the guided BunkerWeb installer
 *     (`morphit-ops bunkerweb`), which never overwrites an existing setup.
 *   - It writes a personalized morphit-hardening-checklist.md — the "do it
 *     FOR the admin" artifact — from the existing config and what is
 *     actually running here (BunkerWeb is detected from Docker, not guessed
 *     from a config line).
 *
 * Review 2026-10-29 (what this used to get wrong on a running node): the
 * on-screen walkthrough promised a checklist file and wrote none; the
 * BunkerWeb option claimed to set a config value it never wrote, then printed
 * relative `sudo cp` commands that would overwrite a live BunkerWeb and a
 * `certbot --standalone` that cannot work while BunkerWeb holds port 80; the
 * backup option ignored the backups the install had already set up and its
 * commands overwrote their settings; and without a terminal it asked the same
 * question forever.
 *
 * It never edits morphit.config.env itself (that is `edit`'s job and
 * `init`'s job).
 */

import { writeFileSync, readFileSync, chmodSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { readDeployedDatabaseUrl } from '../lib/dbContainer.ts';
import { loadInstanceEnv } from '../lib/instanceEnv.ts';
import { currentVersionFile, readCurrentVersion } from '../lib/menuAnnotations.ts';
import { isHiddenOnlyNode } from '../lib/hiddenOnly.ts';
import { resolve, join, dirname } from 'node:path';

import { askChoice } from '../init/prompt.ts';
import { startDotsSpinner } from '../init/spinner.ts';
import { stepHardening, stepBackup, type HardeningResult } from '../init/steps.ts';
import { configureMatrixAlerts } from './matrix.ts';
import { renderHardeningChecklist, renderBackupEnv } from '../init/render.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { detectBunkerWeb, dockerNotAnsweringText, runBunkerWeb, type BunkerWebDetection } from './bunkerweb.ts';
import {
	checkBackups,
	checkCanary,
	checkIpfsSeeding,
	checkService,
	readBackupFacts,
	readIpfsSeedingFacts
} from './health.ts';

export interface HardenCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** What harden reads from the server; tests replace these. */
export interface HardenDeps {
	readonly isTTY?: boolean;
	readonly detectBunkerWeb?: () => Promise<BunkerWebDetection>;
	readonly runBunkerWeb?: typeof runBunkerWeb;
	/** /etc/morphit (MORPHIT_ETC_DIR / MORPHIT_ENV_ROOT relocate it). */
	readonly etcDir?: string;
	/** /etc/passwd, for the morphit user's home. */
	readonly passwdPath?: string;
	readonly serviceState?: (unit: string) => string;
}

interface ExistingInstance {
	readonly instanceName: string;
	readonly origin: string | null;
}

/** The few config values the checklist needs, as the services see them:
 *  morphit.config.env (+ morphit.env) loaded the usual way, OS env winning.
 *  Absent → sensible placeholders, so `harden` works before `init` too. */
function loadExistingInstance(repoRoot: string): ExistingInstance {
	loadInstanceEnv(repoRoot);
	const name = (process.env.MORPHIT_INSTANCE_NAME ?? '').trim();
	const origin = (process.env.MORPHIT_INSTANCE_ORIGIN ?? '').trim();
	return {
		instanceName: name !== '' ? name : 'my Morphit instance',
		origin: origin !== '' ? origin : null
	};
}

/** present / absent, or unknown when this user may not look (run with sudo). */
export function fileState(path: string): 'present' | 'absent' | 'unknown' {
	try {
		statSync(path);
		return 'present';
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
	}
}

/** The morphit service user's home, from /etc/passwd, or null. */
export function morphitHome(passwdPath = '/etc/passwd'): string | null {
	try {
		const line = readFileSync(passwdPath, 'utf8')
			.split('\n')
			.find((l) => l.startsWith('morphit:'));
		const home = line?.split(':')[5]?.trim() ?? '';
		return home.startsWith('/') ? home : null;
	} catch {
		return null;
	}
}

/** A backup folder the printed commands can carry as it is: an absolute path
 *  of letters, digits and . _ / - only. It is typed by the operator and goes
 *  into `install -d …` and a printf format inside single quotes, so a space,
 *  quote, `;` or `%` there would break the command or run something else
 *  (v1.21.18 review). PURE. */
export function isSafeBackupDir(dir: string): boolean {
	return /^\/[A-Za-z0-9._\/-]*$/.test(dir) && !dir.split('/').includes('..');
}

/** The commands that turn on the shipped backup timer for a NEW
 *  /etc/morphit/backup.env (never run when one is already there). The backup
 *  folder must exist before the unit starts (its ReadWritePaths= is set up
 *  first, or it fails 226/NAMESPACE), and the unit only allows
 *  /home/morphit/backups unless a drop-in names the folder (as the Ansible
 *  install does). PURE. */
export function backupActivationCommands(repoRoot: string, envFile: string, backupDir: string): string[] {
	if (!isSafeBackupDir(backupDir))
		throw new Error(`refusing to build commands for the backup folder ${JSON.stringify(backupDir)}: only letters, digits and . _ / - are allowed`);
	const cmds = [
		`sudo install -d -m 700 -o morphit -g morphit ${backupDir}`,
		`sudo install -m 640 -o root -g morphit ${envFile} /etc/morphit/backup.env`,
		'sudo install -d -m 755 /usr/local/lib/morphit',
		`sudo install -m 755 ${join(repoRoot, 'ops', 'backup', 'morphit-backup.sh')} /usr/local/lib/morphit/`,
		`sudo install -m 644 ${join(repoRoot, 'ops', 'systemd', 'morphit-backup.service')} /etc/systemd/system/`,
		`sudo install -m 644 ${join(repoRoot, 'ops', 'systemd', 'morphit-backup.timer')} /etc/systemd/system/`
	];
	if (backupDir !== '/home/morphit/backups') {
		cmds.push(
			'sudo mkdir -p /etc/systemd/system/morphit-backup.service.d',
			`printf '[Service]\\nReadWritePaths=\\nReadWritePaths=${backupDir}\\n' | sudo tee /etc/systemd/system/morphit-backup.service.d/paths.conf >/dev/null`
		);
	}
	cmds.push('sudo systemctl daemon-reload', 'sudo systemctl enable --now morphit-backup.timer');
	return cmds;
}

export async function runHarden(ctx: HardenCtx, deps: HardenDeps = {}): Promise<number> {
	// Every option asks questions. Without a terminal no one can answer them,
	// and a menu with no default used to repeat "Choose" forever (review
	// 2026-10-29). Say how to run it instead.
	if ((deps.isTTY ?? process.stdin.isTTY === true) !== true) {
		console.log('');
		console.log('  Hardening asks you questions, so it needs a terminal. Run it in a terminal');
		console.log('  (an SSH session), on this server:  sudo morphit-ops harden');
		console.log('');
		return 1;
	}
	const repoRoot = ctx.flags.out ? resolve(ctx.flags.out) : defaultRepoRoot();
	const existing = loadExistingInstance(repoRoot);
	const etcDir =
		deps.etcDir ?? process.env.MORPHIT_ETC_DIR ?? `${process.env.MORPHIT_ENV_ROOT ?? ''}/etc/morphit`;
	const service = deps.serviceState ?? checkService;

	// Is BunkerWeb on this server? Asked of Docker (by image) and the disk —
	// a config line said "no" on every node it ran on.
	const stopLook = startDotsSpinner('Looking at what runs on this server…');
	let bunker: BunkerWebDetection;
	try {
		bunker = await (deps.detectBunkerWeb ?? (() => detectBunkerWeb()))();
	} finally {
		stopLook();
	}

	console.log('');
	console.log('━'.repeat(58));
	console.log('  Harden this server');
	console.log('━'.repeat(58));
	console.log('');
	console.log('  Locking down the host is the most important thing you do');
	console.log('  before going public — and none of it is Morphit-specific:');
	console.log('  SSH, firewall, automatic security updates, TLS, and a WAF');
	console.log('  are the baseline every internet-facing Ubuntu box needs.');
	console.log('');
	console.log('  Pick what you want to do; the full reference is OPERATIONS.md');
	console.log('  §34 (UFW + fail2ban), §35 (TLS), §37 (the complete hardening role).');
	console.log('');
	if (bunker.presence === 'docker-not-answering') {
		console.log(`  ⚠ ${dockerNotAnsweringText(bunker.dockerError, isRoot())}`);
		console.log('');
	}

	for (;;) {
		const choice = await askChoice('What would you like to do?', [
			'Write my personalized hardening checklist (recommended first step)',
			'Walk through the host checklist on screen (SSH, firewall, updates, TLS), then write it',
			'Set up BunkerWeb (the web firewall in front of the site), or check it',
			'Set up automatic daily database backups, or check them',
			'Set up IPFS release hosting (help keep Morphit releases alive), or check it',
			'Seed this release to IPFS now (make this box an origin host after an upgrade)',
			'Set up the warrant canary + PGP contact key (transparency signals for your users)',
			'Set up Matrix operator alerts (I mint the bot token for you — no hand-editing)',
			'See what the automated hardening put in place on this server',
			'Done'
		]);

		if (choice === 0) {
			await regenerateChecklist(repoRoot, existing, bunker);
		} else if (choice === 1) {
			// The init wizard's walkthrough, shown standalone; its answers decide
			// what the checklist says ("you chose to skip …").
			const answers = await stepHardening(bunkerWebInUse(bunker), { standalone: true });
			if (answers.generateChecklist) await regenerateChecklist(repoRoot, existing, bunker, answers);
		} else if (choice === 2) {
			// The guided installer: shows the status when BunkerWeb runs, never
			// overwrites an existing /etc/bunkerweb, and gets the certificate
			// the right way for what holds port 80.
			await (deps.runBunkerWeb ?? runBunkerWeb)({
				flags: {},
				positional: [],
				colorEnabled: ctx.colorEnabled
			});
		} else if (choice === 3) {
			await backups(repoRoot, etcDir, deps.passwdPath);
		} else if (choice === 4) {
			ipfsHosting(repoRoot, service);
		} else if (choice === 5) {
			ipfsSeed(repoRoot, existing, service);
		} else if (choice === 6) {
			canary(repoRoot, existing);
		} else if (choice === 7) {
			await configureMatrixAlerts(ctx.colorEnabled);
		} else if (choice === 8) {
			printHardeningInPlace(repoRoot);
		} else {
			// Done
			console.log('');
			console.log('  Harden away.  Come back any time, on this server:');
			console.log('    sudo morphit-ops harden');
			console.log('');
			return 0;
		}
	}
}

function isRoot(): boolean {
	return typeof process.geteuid === 'function' && process.geteuid() === 0;
}

/** BunkerWeb is in use here: running, stopped, or its settings in place. */
function bunkerWebInUse(b: BunkerWebDetection): boolean {
	return b.presence === 'running' || b.presence === 'stopped' || b.configDir;
}

async function regenerateChecklist(
	repoRoot: string,
	existing: ExistingInstance,
	bunker: BunkerWebDetection,
	confirmed?: HardeningResult
): Promise<void> {
	const running = bunker.presence === 'running';
	let bunkerWebEnabled = true;
	if (!running) {
		// Not running here: let the operator say whether it will be, since the
		// checklist's TLS + web-edge sections differ.
		const seen =
			bunker.presence === 'stopped'
				? 'found on this server, not running'
				: bunker.configDir
					? '/etc/bunkerweb is on this server'
					: bunker.presence === 'docker-not-answering'
						? 'could not ask Docker'
						: 'not found on this server';
		const idx = await askChoice(
			`Will BunkerWeb sit in front of this instance?  (${seen})`,
			[`Yes — BunkerWeb terminates TLS and fronts the stack`, `No — serving directly behind nginx/Caddy`],
			bunkerWebInUse(bunker) ? 0 : 1
		);
		bunkerWebEnabled = idx === 0;
	}

	const content = renderHardeningChecklist({
		instanceName: existing.instanceName,
		origin: existing.origin,
		bunkerWebEnabled,
		bunkerWebRunning: running,
		installDir: repoRoot,
		...(confirmed !== undefined
			? {
					confirmed: {
						sshLockdown: confirmed.sshLockdown,
						firewall: confirmed.firewall,
						autoUpdates: confirmed.autoUpdates,
						kernelHardening: confirmed.kernelHardening,
						intrusionDetection: confirmed.intrusionDetection
					}
				}
			: {})
	});
	const outPath = join(repoRoot, 'morphit-hardening-checklist.md');
	try {
		writeFileSync(outPath, content, { mode: 0o644 });
		chmodSync(outPath, 0o644);
	} catch (err) {
		console.log(
			`\n✗ Could not write the checklist: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}`
		);
		console.log(`  (it goes to ${sanitizeForTerm(outPath)}; on this server: sudo morphit-ops harden)\n`);
		return;
	}
	console.log('');
	console.log(`  ✓ Wrote ${sanitizeForTerm(outPath)} (a readable runbook, no secrets).`);
	console.log(`    Read it on this server:  less ${sanitizeForTerm(outPath)}`);
	console.log('    Work through it before you expose the instance publicly.  It leads');
	console.log('    with the SSH-lockout safety rule and gives each step its command.');
	console.log('');
}

async function backups(repoRoot: string, etcDir: string, passwdPath?: string): Promise<void> {
	const envPath = join(etcDir, 'backup.env');
	const state = fileState(envPath);
	if (state === 'unknown') {
		console.log('');
		console.log(`  ⚠ ${sanitizeForTerm(envPath)} could not be looked at as this user.`);
		console.log('    Run it with sudo, on this server:  sudo morphit-ops harden');
		console.log('');
		return;
	}
	if (state === 'present') {
		// Set up already (the install does it): show how they are doing, and
		// change nothing — its settings (database login, encryption key,
		// off-site copy) are not this command's to replace.
		const st = checkBackups(readBackupFacts(envPath), new Date());
		const mark = st.state === 'fresh' ? '✓' : st.state === 'not-configured' ? '○' : '⚠';
		console.log('');
		console.log(`  ${mark} Daily database backups are already set up on this server (${st.state}).`);
		if (st.newestName !== null) console.log(`    Newest: ${sanitizeForTerm(st.newestName)}`);
		console.log(`    ${sanitizeForTerm(st.detail)}`);
		console.log(`    Their settings: ${sanitizeForTerm(envPath)} (left as they are).`);
		console.log('    Full view, on this server:  sudo morphit-ops health');
		console.log('');
		return;
	}

	// Pass the deployed connection URL so the backup targets the real DB
	// (non-standard boxes on morphit_user/morphit_db work without editing).
	const home = morphitHome(passwdPath);
	const backup = await stepBackup(readDeployedDatabaseUrl(repoRoot) ?? '', {
		standalone: true,
		defaultBackupDir: `${home ?? '/home/morphit'}/backups`
	});
	if (!backup.enabled) return;
	const backupDir = backup.backupDir ?? `${home ?? '/home/morphit'}/backups`;
	if (!isSafeBackupDir(backupDir)) {
		console.log('');
		console.log(`  ✗ The backup folder ${JSON.stringify(sanitizeForTerm(backupDir))} has characters the commands`);
		console.log('    below cannot carry safely. Use a folder named with letters, digits and . _ / -');
		console.log('    only (for example /var/backups/morphit). Nothing was written. Choose this option');
		console.log('    again, on this server:  sudo morphit-ops harden');
		console.log('');
		return;
	}
	const backupEnvPath = join(repoRoot, 'ops', 'backup', 'backup.env');
	try {
		mkdirSync(dirname(backupEnvPath), { recursive: true });
		writeFileSync(backupEnvPath, renderBackupEnv(backup), { mode: 0o600 });
		chmodSync(backupEnvPath, 0o600);
	} catch (err) {
		console.log(
			`  ✗ Could not write ${sanitizeForTerm(backupEnvPath)}: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}`
		);
		console.log('    Run it with sudo, on this server:  sudo morphit-ops harden');
		return;
	}
	console.log(`  ✓ wrote ${sanitizeForTerm(backupEnvPath)}`);
	console.log('');
	console.log('  To turn on the shipped backup timer, run these in order, on this server:');
	console.log('');
	for (const cmd of backupActivationCommands(repoRoot, backupEnvPath, backupDir))
		console.log(`    ${sanitizeForTerm(cmd)}`);
	console.log('');
	console.log('  Then PROVE it dumps — a working run prints a byte count:');
	console.log('');
	console.log('    sudo systemctl start morphit-backup.service');
	console.log('    sudo journalctl -u morphit-backup.service -e --no-pager');
	console.log(`    sudo ls -lh ${sanitizeForTerm(backupDir)}`);
	console.log('');
	if (backup.dbContainer !== null) {
		console.log('  Your Postgres runs in a container, so the dump goes through');
		console.log('  `docker exec`. The unit runs as the morphit user, which must be');
		console.log('  able to reach docker — note this is root-equivalent access:');
		console.log('');
		console.log('    sudo usermod -aG docker morphit');
		console.log('');
	}
	console.log('  Full reference: docs/RUN-A-MORPHIT-NODE.md §9, OPERATIONS.md.');
	console.log('');
}

function ipfsHosting(repoRoot: string, service: (unit: string) => string): void {
	const daemon = service('ipfs');
	if (daemon !== 'not-installed' && daemon !== 'unknown') {
		// Set up already (on by default on installs): how it is doing.
		const st = checkIpfsSeeding(readIpfsSeedingFacts());
		console.log('');
		console.log(`  IPFS release hosting is set up on this server (${st.state}).`);
		console.log(`    ${sanitizeForTerm(st.detail)}`);
		console.log('');
		return;
	}
	const setup = join(repoRoot, 'ops', 'ipfs', 'morphit-ipfs-setup.sh');
	console.log('');
	console.log('  Every Morphit instance runs a small IPFS (Kubo) node that pins THIS');
	console.log('  instance\'s current signed release, so Morphit\'s releases survive even');
	console.log('  if every commercial pinning service drops them. The release CID comes');
	console.log('  from your own /v1/release (learned from the chain) — no middleman.');
	console.log('  Low-footprint: the lowpower Kubo profile, capped connections, ~12 MB.');
	console.log('');
	console.log('  It is not set up on this server yet. Set it up (installs Kubo + the');
	console.log('  pinning service + timer; safe to run again), on this server:');
	console.log('');
	console.log(`    sudo sh ${sanitizeForTerm(setup)}`);
	console.log('');
	console.log('  Then confirm + pin right away, on this server:');
	console.log('');
	console.log('    sudo systemctl status ipfs morphit-ipfs-pin.timer');
	console.log('    sudo systemctl start morphit-ipfs-pin.service');
	console.log('    sudo journalctl -u morphit-ipfs-pin -e --no-pager');
	console.log('');
	console.log('  Full reference: docs/RUN-A-MORPHIT-NODE.md, OPERATIONS.md §48.');
	console.log('');
}

/** The seed command for this server's installed release. PURE. */
export function ipfsSeedCommand(opts: {
	readonly seedScript: string;
	readonly tag: string;
	readonly origin: string | null;
	readonly hiddenOnly: boolean;
	/** A local copy of the release to stage from (no download). */
	readonly stageTarball?: string | null;
}): string {
	const env = ['IPFS_PATH=/var/lib/ipfs/.ipfs'];
	if (opts.origin !== null && /^https?:\/\/[^\s'"]+$/.test(opts.origin))
		env.push(`MORPHIT_SEED_ORIGIN=${opts.origin}`);
	if (opts.hiddenOnly) env.push('MORPHIT_SEED_HIDDEN_ONLY=1');
	if (opts.stageTarball != null) env.push(`MORPHIT_STAGE_TARBALL=${opts.stageTarball}`);
	return `sudo -u ipfs env ${env.join(' ')} sh ${opts.seedScript} ${opts.tag}`;
}

function ipfsSeed(repoRoot: string, existing: ExistingInstance, service: (unit: string) => string): void {
	console.log('');
	const daemon = service('ipfs');
	if (daemon === 'not-installed') {
		console.log('  IPFS release hosting is not set up on this server, so there is nothing');
		console.log('  to seed from. Set it up first: the option "Set up IPFS release hosting".');
		console.log('');
		return;
	}
	const tag = readCurrentVersion();
	if (tag === null) {
		console.log('  Could not tell which release is installed here (no readable');
		console.log(`  ${sanitizeForTerm(currentVersionFile())}), so there is no release to seed.`);
		console.log('');
		return;
	}
	const hiddenOnly = isHiddenOnlyNode();
	const seedScript = join(repoRoot, 'ops', 'ipfs', 'morphit-ipfs-seed.sh');
	if (hiddenOnly) {
		// A hidden-only node never downloads the release over clearnet, so the
		// seed needs a local copy: the canonical tarball an offline bundle ships.
		const local = join(dirname(currentVersionFile()), '.canonical-release', `morphit-${tag}.tar.gz`);
		if (!existsSync(local)) {
			console.log(`  This node is hidden-only, so seeding ${sanitizeForTerm(tag)} needs a local copy of the`);
			console.log('  release (it never downloads it over clearnet), and this server has none');
			console.log(`  (looked for ${sanitizeForTerm(local)}).`);
			console.log('  `sudo morphit-ops upgrade` seeds each release it installs, from the copy it');
			console.log('  brings. Nothing to run by hand now.');
			console.log('');
			console.log('  Full reference: docs/RUN-A-MORPHIT-NODE.md, OPERATIONS.md §48.');
			console.log('');
			return;
		}
		const cmd = ipfsSeedCommand({ seedScript, tag, origin: existing.origin, hiddenOnly, stageTarball: local });
		console.log(`  Seed the installed release (${sanitizeForTerm(tag)}) from this box, so other instances can`);
		console.log('  fetch it from you over Tor/I2P. `sudo morphit-ops upgrade` does this after every');
		console.log('  upgrade; run it by hand to check again after fixing something, on this server:');
		console.log('');
		console.log(`    ${sanitizeForTerm(cmd)}`);
		console.log('');
		console.log('  It adds the release from the local copy and asks nothing over clearnet. So it');
		console.log("  cannot fetch the release's published CID to compare with: the result is NOT");
		console.log('  cross-checked this time (upgrade passes the on-chain CID; you can add it as a');
		console.log('  last argument to have it checked).');
		console.log('');
		console.log('  Full reference: docs/RUN-A-MORPHIT-NODE.md, OPERATIONS.md §48.');
		console.log('');
		return;
	}
	const cmd = ipfsSeedCommand({
		seedScript,
		tag,
		origin: existing.origin,
		hiddenOnly
	});
	console.log(`  Seed the installed release (${sanitizeForTerm(tag)}) from this box, so other instances can`);
	console.log('  fetch it from you. `sudo morphit-ops upgrade` does this after every upgrade;');
	console.log('  run it by hand to check again after fixing something, on this server:');
	console.log('');
	console.log(`    ${sanitizeForTerm(cmd)}`);
	console.log('');
	console.log('  It re-stages the exact release directory, adds it to IPFS, and — when it can');
	console.log("  fetch the CID published with the release from the code host — compares the two,");
	console.log('  refusing to seed one that does not match ("✓ CID matches" when they did). Then');
	console.log('  it checks other nodes can fetch it, and says what to fix if not.');
	console.log('');
	console.log('  Full reference: docs/RUN-A-MORPHIT-NODE.md, OPERATIONS.md §48.');
	console.log('');
}

function canary(repoRoot: string, existing: ExistingInstance): void {
	// The served copy and its freshness, as `health` reads it.
	const st = checkCanary(join(repoRoot, 'apps', 'web', 'build', 'canary.txt'), new Date());
	console.log('');
	console.log('  Two transparency signals your instance serves from the site root:');
	console.log('');
	console.log('    • /canary.txt      a SIGNED warrant canary — it goes stale if you are');
	console.log('                       ever compelled + gagged, so silence means something');
	console.log('    • /pgp_keys.asc    the PGP public key that signs it, so users can check it');
	console.log('');
	console.log(`  Now: canary ${st.state}${st.state === 'fresh' ? '' : ` — ${sanitizeForTerm(st.detail)}`}`);
	console.log('');
	console.log('  The canary setup does both (it publishes your public key with the canary)');
	console.log('  and arms a weekly refresh. Where should it be signed?');
	console.log('');
	console.log('  a) On THIS server (simplest) — on this server:');
	console.log(`       cd ${sanitizeForTerm(repoRoot)} && sudo bash scripts/canary/setup.sh`);
	console.log('     and choose "On THIS computer".');
	console.log('');
	console.log('  b) On your own computer (safest: the signing key never sits on the server, so');
	console.log('     a seized server cannot keep stamping "all-clear") — on YOUR computer, from');
	console.log('     a copy of this Morphit release:');
	console.log('       bash scripts/canary/setup.sh');
	console.log('     and choose "On a remote server / VPS"; it signs there and uploads here.');
	console.log('');
	if (existing.origin !== null && /^https?:\/\/[^\s'"]+$/.test(existing.origin)) {
		console.log('  Confirm both are live (from any computer):');
		console.log('');
		console.log(`    curl -fsS ${sanitizeForTerm(existing.origin)}/canary.txt | head`);
		console.log(`    curl -fsS ${sanitizeForTerm(existing.origin)}/pgp_keys.asc | head`);
		console.log('');
	}
	console.log('  Full reference: OPERATIONS.md §36 (warrant canary).');
	console.log('');
}

/** What the hardening role leaves on disk, per pillar. */
export const HARDENING_MARKERS: readonly { readonly label: string; readonly path: string }[] = [
	{ label: 'SSH lockdown (key-only, no root login)', path: '/etc/ssh/sshd_config.d/99-morphit-hardening.conf' },
	{ label: 'Kernel + network settings (sysctl)', path: '/etc/sysctl.d/99-morphit-hardening.conf' },
	{ label: 'Automatic security updates', path: '/etc/apt/apt.conf.d/20auto-upgrades' },
	{ label: 'fail2ban (bans brute-force logins)', path: '/etc/fail2ban/jail.local' },
	{ label: 'Audit log rules (auditd)', path: '/etc/audit/rules.d/morphit.rules' },
	{ label: 'Intrusion detection (AIDE)', path: '/etc/aide/aide.conf.d/99-morphit' }
];

function printHardeningInPlace(repoRoot: string, root = process.env.MORPHIT_ENV_ROOT ?? ''): void {
	console.log('');
	console.log('  The guided install (sudo morphit-ops install) runs the Ansible playbook in');
	console.log('  ops/ansible/, which applies all of this. What is in place on this server:');
	console.log('');
	let found = 0;
	let unknown = 0;
	for (const m of HARDENING_MARKERS) {
		const st = fileState(`${root}${m.path}`);
		if (st === 'present') found++;
		if (st === 'unknown') unknown++;
		const mark = st === 'present' ? '✓' : st === 'absent' ? '○' : '?';
		console.log(`    ${mark} ${m.label.padEnd(42)} ${m.path}`);
	}
	console.log('');
	if (unknown > 0) {
		console.log('  Some could not be looked at as this user: on this server, sudo morphit-ops harden');
	} else if (found === HARDENING_MARKERS.length) {
		console.log('  All of it is in place. Nothing to do; the upgrade keeps it that way.');
	} else {
		console.log('  What is missing (○): follow your checklist (the first option), or apply the');
		console.log('  whole role with Ansible from your own computer, in the ops/ansible folder of a');
		console.log('  copy of this Morphit release, with this server in inventory/hosts.yml:');
		console.log('');
		console.log('    ansible-playbook -i inventory/hosts.yml playbook.yml --tags hardening --check');
		console.log('    ansible-playbook -i inventory/hosts.yml playbook.yml --tags hardening');
		console.log('');
		console.log(`  (the first only shows what would change). Reference: ${sanitizeForTerm(join(repoRoot, 'ops', 'ansible', 'README.md'))}, OPERATIONS.md §37.`);
	}
	console.log('');
}
