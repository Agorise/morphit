/**
 * morphit-ops upgrade — check for and apply Morphit releases.
 *
 * Part 122 cp8 — initial implementation.  Manual-only by default
 * per Ken's preference; opt-in `MORPHIT_AUTO_UPGRADE=1` to skip
 * the confirmation prompt (for cron/automation use).
 *
 * Subcommand modes:
 *
 *   morphit-ops upgrade --check-only
 *     Polls the Forgejo release API for the latest published
 *     release.  Compares against the locally-installed
 *     `release-info.json`.  Prints version comparison + release
 *     notes URL.  Exits 0 if up-to-date, 0 if a newer release
 *     is available (with "available" output), 1 on error.
 *     Suitable for cron + the morphit-release-monitor sidecar.
 *
 *   morphit-ops upgrade
 *     Full flow: check → download → SHA-256 verify → show
 *     release notes → prompt for confirmation → backup current
 *     install → extract new tarball → `npm ci` → restart
 *     services → roll back on any error.
 *
 * Environment:
 *
 *   MORPHIT_AUTO_UPGRADE          (default unset) — set to '1'
 *                                  to skip the y/N confirmation
 *                                  prompt.  Required for cron use.
 *   MORPHIT_RELEASE_HOST          (default: git.agorise.net)
 *   MORPHIT_RELEASE_REPO          (default: agorise/morphit)
 *   MORPHIT_INSTALL_DIR           (default: /opt/morphit)
 *   MORPHIT_BACKUP_KEEP           (default: 3) — backups to retain
 *
 * What `morphit-ops upgrade` does NOT do (intentionally):
 *
 *   - GPG tag-signature verify.  The CI already verifies that
 *     the tag is signed by an authorized key before building the
 *     tarball, so the SHA-256 chain (Forgejo HTTPS → release
 *     listing → tarball SHA → matches downloaded tarball) is
 *     sufficient for the post-CI path.  Operators who want
 *     belt-and-braces can verify the tag signature themselves
 *     with `git clone && git tag -v vX.Y.Z`.  Documented in
 *     docs/UPGRADING.md.
 *
 *   - Schema migrations.  This release tooling is pre-launch;
 *     post-launch schema changes will land as MIGRATIONS[] entries
 *     and `runMigrations()` will apply them at indexer start.
 *     The upgrade flow restarts the indexer which triggers
 *     migration application.  No separate migration step here.
 *
 *   - Cross-major upgrades.  This tool assumes the new version is
 *     the same major as the current install (e.g. v1.x → v1.y).
 *     Major-version upgrades may have manual steps and will be
 *     called out in the release notes.
 *
 * Exit codes:
 *   0 — success (up-to-date OR upgrade applied)
 *   1 — newer release available (--check-only mode)
 *   2 — user declined upgrade at confirmation prompt
 *   3 — upgrade failed (rolled back to previous version)
 *   4 — upgrade failed AND rollback failed (operator intervention needed)
 *   5 — preflight check failed (network, permissions, ...)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import { error as printError, info, warn } from '../render/term.ts';

interface UpgradeFlags {
	readonly 'check-only'?: string;
	readonly 'yes'?: string;
	readonly 'json'?: string;
	readonly [key: string]: string | undefined;
}

interface RunUpgradeOptions {
	readonly flags: UpgradeFlags;
	readonly positional: readonly string[];
}

interface ReleaseInfo {
	readonly tag: string;
	readonly commit: string;
	readonly build_time: string;
	readonly builder: string;
}

interface ForgejoRelease {
	readonly tag_name: string;
	readonly name: string;
	readonly body: string;
	readonly html_url: string;
	readonly published_at: string;
	readonly assets: readonly ForgejoReleaseAsset[];
}

interface ForgejoReleaseAsset {
	readonly name: string;
	readonly browser_download_url: string;
	readonly size: number;
}

const DEFAULT_HOST = 'git.agorise.net';
const DEFAULT_REPO = 'agorise/morphit';
const DEFAULT_INSTALL_DIR = '/opt/morphit';
const DEFAULT_BACKUP_KEEP = 3;

// Services to restart on upgrade.  Listed in dependency order
// (deps before consumers).  If a service unit doesn't exist on
// the host, the restart attempt is skipped with an INFO log.
const SERVICES_TO_RESTART = [
	'morphit-indexer.service',
	'morphit-relay.service',
	'morphit-matrix-bot.service'
];

export async function runUpgrade(opts: RunUpgradeOptions): Promise<number> {
	const checkOnly = opts.flags['check-only'] === 'true';
	const forceYes = opts.flags['yes'] === 'true' || process.env.MORPHIT_AUTO_UPGRADE === '1';
	const jsonOutput = opts.flags['json'] === 'true';

	const host = process.env.MORPHIT_RELEASE_HOST ?? DEFAULT_HOST;
	const repo = process.env.MORPHIT_RELEASE_REPO ?? DEFAULT_REPO;
	const installDir = process.env.MORPHIT_INSTALL_DIR ?? DEFAULT_INSTALL_DIR;

	// ─── 1. Read locally-installed version ──────────────────────
	const localInfo = readLocalReleaseInfo(installDir);
	if (localInfo === null && !checkOnly) {
		printError(
			`No release-info.json at ${installDir}/release-info.json. ` +
				`Is ${installDir} a Morphit install? ` +
				`First-time installs should follow docs/RUN-A-MORPHIT-NODE.md, not 'morphit-ops upgrade'.`
		);
		return 5;
	}

	// ─── 2. Fetch latest release from Forgejo ───────────────────
	let latest: ForgejoRelease;
	try {
		latest = await fetchLatestRelease(host, repo);
	} catch (err) {
		printError(
			`Could not reach Forgejo release API at https://${host}/${repo}: ` +
				(err instanceof Error ? err.message : String(err))
		);
		return 5;
	}

	const currentTag = localInfo?.tag ?? '(unknown)';
	const latestTag = latest.tag_name;
	const isUpToDate = currentTag === latestTag;

	if (jsonOutput) {
		const payload = {
			current: currentTag,
			latest: latestTag,
			up_to_date: isUpToDate,
			release_url: latest.html_url,
			published_at: latest.published_at
		};
		console.log(JSON.stringify(payload, null, 2));
		return isUpToDate ? 0 : 1;
	}

	info(`Current version: ${currentTag}`);
	info(`Latest version:  ${latestTag}`);
	info(`Release URL:     ${latest.html_url}`);

	if (isUpToDate) {
		info('✓ Already on the latest release.');
		return 0;
	}

	console.log('');
	info(`Newer release available: ${latestTag}`);
	console.log('');
	info('Release notes:');
	for (const line of latest.body.trim().split('\n')) {
		console.log(`  ${line}`);
	}
	console.log('');

	if (checkOnly) {
		// Exit 1 to make it scriptable: cron + sidecars can
		// react to a non-zero return code from --check-only as
		// "a newer release exists".
		return 1;
	}

	// ─── 3. Locate tarball + sha256 asset URLs ──────────────────
	const tarballAsset = latest.assets.find((a) => a.name.endsWith('.tar.gz') && !a.name.endsWith('.sha256.tar.gz'));
	const shaAsset = latest.assets.find((a) => a.name.endsWith('.tar.gz.sha256'));
	if (!tarballAsset || !shaAsset) {
		printError(
			`Release ${latestTag} is missing required assets. ` +
				`Expected one *.tar.gz and one *.tar.gz.sha256; found: ` +
				`[${latest.assets.map((a) => a.name).join(', ')}].`
		);
		return 5;
	}

	// ─── 4. Confirmation prompt ─────────────────────────────────
	if (!forceYes) {
		const ok = await promptYes(
			`Apply upgrade from ${currentTag} to ${latestTag}?\n` +
				`This will: backup ${installDir}, extract new tarball, run npm ci, restart services.\n` +
				`Set MORPHIT_AUTO_UPGRADE=1 to skip this prompt in future runs.`
		);
		if (!ok) {
			info('Upgrade declined.');
			return 2;
		}
	}

	// ─── 5. Download tarball + sha256 ──────────────────────────
	const tmpDir = mkTempDir();
	const tarballPath = join(tmpDir, tarballAsset.name);
	const shaPath = join(tmpDir, shaAsset.name);

	try {
		info(`Downloading ${tarballAsset.name} (${tarballAsset.size} bytes)...`);
		await downloadTo(tarballAsset.browser_download_url, tarballPath);
		info(`Downloading ${shaAsset.name}...`);
		await downloadTo(shaAsset.browser_download_url, shaPath);
	} catch (err) {
		printError(
			`Download failed: ` + (err instanceof Error ? err.message : String(err))
		);
		cleanupTmp(tmpDir);
		return 5;
	}

	// ─── 6. Verify SHA256 ──────────────────────────────────────
	const expectedHash = parseShaFile(shaPath);
	const actualHash = computeSha256(tarballPath);
	if (expectedHash !== actualHash) {
		printError(
			`SHA-256 mismatch on downloaded tarball.\n` +
				`  Expected: ${expectedHash}\n` +
				`  Actual:   ${actualHash}\n` +
				`Refusing to proceed.  The tarball was tampered with in transit, or the SHA file is stale.`
		);
		cleanupTmp(tmpDir);
		return 5;
	}
	info('✓ SHA-256 verified.');

	// ─── 7. Backup current install ──────────────────────────────
	const backupDir = `${installDir}.bak-${Date.now()}`;
	info(`Backing up ${installDir} → ${backupDir}`);
	try {
		renameSync(installDir, backupDir);
	} catch (err) {
		printError(
			`Backup failed (could not rename ${installDir} → ${backupDir}): ` +
				(err instanceof Error ? err.message : String(err))
		);
		cleanupTmp(tmpDir);
		return 5;
	}

	// ─── 8. Extract new tarball ────────────────────────────────
	try {
		mkdirSync(installDir, { recursive: true });
		info(`Extracting ${tarballAsset.name} to ${installDir}...`);
		// cp131 LOW-010 — defense-in-depth tar flags.
		//
		// GNU tar's documented defaults already refuse two of
		// the three classical tarball-extract escapes:
		//   - absolute paths (entry name starts with `/`) are
		//     stripped to relative with a warning, then
		//     extracted inside -C target;
		//   - `..` traversal entries are refused outright.
		// Empirically verified at cp131 audit time.
		//
		// What the defaults DO permit:
		//   - the archive may set ownership on extracted files
		//     to whatever uid/gid the entries name (when run
		//     as root);
		//   - the archive may set file modes including setuid
		//     / setgid bits;
		//   - the archive may overwrite a non-empty existing
		//     directory with a regular-file entry of the same
		//     name, OR overwrite a regular-file with a symlink.
		//
		// A CI-built Morphit tarball never relies on any of
		// these, so disabling them costs nothing.  A compromised
		// build host (or supply-chain replacement of the tarball
		// AND its .sha256 sibling) could exploit any of them.
		// Explicit flags shut them off:
		//
		//   --no-same-owner       (don't honor archived uid/gid;
		//                          extracted files belong to the
		//                          process user, no setuid-as-root
		//                          via a maliciously-owned entry)
		//   --no-same-permissions (don't honor archived setuid/
		//                          setgid bits; mode is clipped by
		//                          the umask)
		//   --no-overwrite-dir    (refuse to replace an existing
		//                          directory with a file of the
		//                          same name)
		//
		// `--strip-components=0` is kept for the explicit "we
		// don't strip" record.  `-p` is INTENTIONALLY NOT used
		// (it would override --no-same-permissions).
		runOrThrow('tar', [
			'-xzf',
			tarballPath,
			'-C',
			installDir,
			'--strip-components=0',
			'--no-same-owner',
			'--no-same-permissions',
			'--no-overwrite-dir'
		]);
	} catch (err) {
		warn(`Extract failed; rolling back to ${backupDir}.`);
		return rollback(installDir, backupDir, tmpDir, err);
	}

	// ─── 9. Install workspace dependencies ─────────────────────
	try {
		info('Running npm ci in installed dir (this can take a minute)...');
		runOrThrow('npm', ['ci', '--no-audit', '--no-fund'], { cwd: installDir });
	} catch (err) {
		warn('npm ci failed; rolling back.');
		return rollback(installDir, backupDir, tmpDir, err);
	}

	// ─── 10. Restart services ──────────────────────────────────
	for (const svc of SERVICES_TO_RESTART) {
		const isActive = spawnSync('systemctl', ['is-active', '--quiet', svc]).status === 0;
		if (!isActive) {
			info(`Skipping ${svc} (not active on this host).`);
			continue;
		}
		info(`Restarting ${svc}...`);
		try {
			runOrThrow('systemctl', ['restart', svc]);
		} catch (err) {
			warn(`Service restart failed for ${svc}; rolling back.`);
			return rollback(installDir, backupDir, tmpDir, err);
		}
	}

	// ─── 11. Cleanup + prune old backups ───────────────────────
	cleanupTmp(tmpDir);
	pruneOldBackups(installDir);

	info('');
	info(`✓ Upgrade complete: ${currentTag} → ${latestTag}`);
	info(`Previous install kept at: ${backupDir}`);
	return 0;
}

// ─── Helpers ──────────────────────────────────────────────────────

function readLocalReleaseInfo(installDir: string): ReleaseInfo | null {
	const p = join(installDir, 'release-info.json');
	if (!existsSync(p)) return null;
	try {
		const raw = readFileSync(p, 'utf-8');
		const parsed = JSON.parse(raw) as ReleaseInfo;
		if (typeof parsed.tag !== 'string') return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Timeout for network calls in the upgrade flow.  The upgrade
 *  command is interactive — operators run it manually — but if
 *  `git.agorise.net` hangs (DNS issue, captive portal, slow
 *  mirror) we want a bounded wait, not an indefinite block.
 *  Conservative 30s; release-archive downloads are typically a
 *  few hundred KB and complete in under a second. */
const UPGRADE_FETCH_TIMEOUT_MS = 30_000;

async function fetchLatestRelease(host: string, repo: string): Promise<ForgejoRelease> {
	const url = `https://${host}/api/v1/repos/${repo}/releases/latest`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), UPGRADE_FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Accept: 'application/json' },
			signal: controller.signal
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} from ${url}`);
		}
		const body = (await res.json()) as ForgejoRelease;
		if (typeof body.tag_name !== 'string') {
			throw new Error(`Forgejo API response missing tag_name field`);
		}
		return body;
	} finally {
		clearTimeout(timer);
	}
}

async function downloadTo(url: string, dest: string): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), UPGRADE_FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} from ${url}`);
		}
		const buf = Buffer.from(await res.arrayBuffer());
		writeFileSync(dest, buf);
	} finally {
		clearTimeout(timer);
	}
}

function parseShaFile(path: string): string {
	const raw = readFileSync(path, 'utf-8').trim();
	// sha256sum output is `<hex>  <filename>`; first token is the hash.
	const m = /^([a-f0-9]{64})\b/.exec(raw);
	if (!m) {
		throw new Error(`Could not parse SHA-256 hex from ${path}`);
	}
	return m[1]!;
}

function computeSha256(path: string): string {
	const h = createHash('sha256');
	h.update(readFileSync(path));
	return h.digest('hex');
}

function mkTempDir(): string {
	const dir = join(tmpdir(), `morphit-upgrade-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupTmp(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

function runOrThrow(cmd: string, args: readonly string[], opts: { cwd?: string } = {}): void {
	const result = spawnSync(cmd, args, {
		stdio: 'inherit',
		cwd: opts.cwd
	});
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
	}
}

function rollback(installDir: string, backupDir: string, tmpDir: string, err: unknown): number {
	printError(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
	info(`Rolling back: removing partial extract at ${installDir}`);
	try {
		rmSync(installDir, { recursive: true, force: true });
	} catch (rmErr) {
		printError(
			`Rollback failed at rm step: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`
		);
		printError(`Manual intervention needed: ${installDir} is in a partial state; ${backupDir} contains the prior install.`);
		cleanupTmp(tmpDir);
		return 4;
	}
	try {
		renameSync(backupDir, installDir);
	} catch (renameErr) {
		printError(
			`Rollback failed at rename step: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`
		);
		printError(`Manual intervention needed: ${backupDir} contains the prior install; manually move it back to ${installDir}.`);
		cleanupTmp(tmpDir);
		return 4;
	}
	// Best-effort: restart services after rollback so the old version is running.
	for (const svc of SERVICES_TO_RESTART) {
		const isActive = spawnSync('systemctl', ['is-active', '--quiet', svc]).status === 0;
		if (!isActive) continue;
		spawnSync('systemctl', ['restart', svc]);
	}
	cleanupTmp(tmpDir);
	info(`Rolled back to previous install at ${installDir}.`);
	return 3;
}

function pruneOldBackups(installDir: string): void {
	const parent = dirname(installDir);
	const base = installDir.split('/').pop() ?? 'morphit';
	const keep = Number(process.env.MORPHIT_BACKUP_KEEP ?? DEFAULT_BACKUP_KEEP);
	if (!Number.isFinite(keep) || keep < 1) return;
	if (!existsSync(parent)) return;
	const entries = readdirSync(parent)
		.filter((name) => name.startsWith(`${base}.bak-`))
		.map((name) => ({
			name,
			path: join(parent, name),
			mtime: statSync(join(parent, name)).mtimeMs
		}))
		.sort((a, b) => b.mtime - a.mtime); // newest first
	for (const ent of entries.slice(keep)) {
		try {
			rmSync(ent.path, { recursive: true, force: true });
			info(`Pruned old backup: ${ent.path}`);
		} catch {
			// best-effort
		}
	}
}

async function promptYes(message: string): Promise<boolean> {
	// Use Node's readline.  We don't `import readline from 'node:readline/promises'`
	// at the module top to keep the cost off the --check-only path.
	const readline = await import('node:readline/promises');
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	const answer = (await rl.question(`${message}\n[y/N]: `)).trim().toLowerCase();
	rl.close();
	return answer === 'y' || answer === 'yes';
}
