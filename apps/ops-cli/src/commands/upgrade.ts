/**
 * morphit-ops upgrade — check for and apply Morphit releases.
 *
 * Part 122 cp8 — initial implementation.  Manual-only by default
 * per the maintainer's preference; opt-in `MORPHIT_AUTO_UPGRADE=1` to skip
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
 *     install → extract new tarball → `npm ci` → ALWAYS rebuild the
 *     static web frontend → publish it (copy into the bare-metal web
 *     root and/or `docker restart` the container that bind-mounts the
 *     build) → restart services → roll back on any error.
 *
 * Environment:
 *
 *   MORPHIT_AUTO_UPGRADE          (default unset) — set to '1'
 *                                  to skip the y/N confirmation
 *                                  prompt.  Required for cron use.
 *   MORPHIT_UPGRADE_TARBALL       (default unset) — absolute path to a
 *                                  local, self-contained signed
 *                                  morphit-<ver>-offline.tar.gz. When set
 *                                  (or --from-file=PATH), the upgrade runs
 *                                  FULLY OFFLINE: no network discovery, no
 *                                  download; the tarball's sibling `.asc` is
 *                                  verified against the local signer keys and
 *                                  an UNSIGNED tarball is refused. Its prebuilt
 *                                  node_modules (the .morphit-bundle-complete
 *                                  marker) skips npm ci, so the rebuild needs
 *                                  no registry either — cable-unplugged upgrade.
 *   MORPHIT_RELEASE_HOST          (default: git.agorise.net)
 *   MORPHIT_RELEASE_REPO          (default: agorise/morphit)
 *   MORPHIT_RELEASE_MIRRORS       (default unset) — comma-separated
 *                                  fallback sources, each `host` (reuse
 *                                  the primary repo) or `host/owner/repo`.
 *                                  Tried in order after the primary.
 *   MORPHIT_INSTALL_DIR           (default: /opt/morphit)
 *   MORPHIT_WEB_ROOT              (default: /var/www/morphit-frontend)
 *                                  — where bare-metal nginx serves the
 *                                  static frontend from; if it exists, the
 *                                  upgrade copies the freshly-built bundle
 *                                  here. Set this if your bare-metal site is
 *                                  served from a custom path. The web app is
 *                                  ALWAYS rebuilt regardless; on a host
 *                                  running a Docker frontend (the container
 *                                  that bind-mounts <install>/apps/web/build,
 *                                  whatever its name) the upgrade `docker
 *                                  restart`s that container so it re-binds the
 *                                  fresh build, instead of copying. If NEITHER
 *                                  target is found, the rebuilt bundle is left
 *                                  on disk with a warning to publish it by hand.
 *   MORPHIT_BACKUP_KEEP           (default: 3) — backups to retain
 *
 * Mirror + integrity model (beta5):
 *
 *   - GPG detached signature.  If the release carries a
 *     `*.tar.gz.asc`, it is verified against the release-signer PUBLIC
 *     keys that ship in the install at `.forgejo/release-signers/*.asc`
 *     (a LOCAL, code-reviewed trust anchor — not fetched from the
 *     download source).  A tarball that passes is trusted no matter
 *     which mirror served the bytes — this is what makes a fully
 *     standalone mirror safe (Morphit priority #2, unstoppable).
 *     Publishing the signature requires a CI signing key — see
 *     `.forgejo/workflows/release.yml` + docs/UPGRADING.md.
 *
 *   - Anchored SHA-256.  When there's no signature, the `.tar.gz.sha256`
 *     is always taken from the TRUSTED PRIMARY over HTTPS; the tarball
 *     bytes may be mirrored; the bytes are verified against the
 *     primary's hash.  A hostile mirror can't forge this.  If the
 *     primary is fully unreachable AND the release is unsigned, the
 *     upgrade REFUSES — checking a mirror's tarball against that same
 *     mirror's checksum proves nothing.
 *
 * What `morphit-ops upgrade` does NOT do (intentionally):
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

import { tryResolveHiddenUpgrade, type HiddenUpgradeResolution } from '../init/hiddenUpgradeResolve.js';
import { normalizeContactUrl, INSTANCE_ENV } from '@morphit/operator-config';
import { withSpinner, startDotsSpinner } from '../init/spinner.ts';
import { readFileSync, writeFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, readdirSync, statSync, copyFileSync, cpSync, readlinkSync, chmodSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import { error as printError, info, warn, sanitizeForTerm } from '../render/term.ts';
import { refreshManagedUnits } from '../lib/refreshUnits.ts';
import { daemonReload } from '../lib/restartServices.ts';
import { chooseCanaryDirOwner, parsePasswdRefreshTarget } from '../lib/canaryDirOwner.ts';
import {
	detectDbContainer,
	parseBackupDbContainer,
	assessBackupDockerDrift,
	dbIdentityFromUrl,
	readDeployedDatabaseUrl,
	type DbIdentity,
	BACKUP_DB_NAME,
	BACKUP_DB_USER
} from '../lib/dbContainer.ts';
import {
	MATRIX_BOT_UNIT,
	matrixBotReadiness,
	readMatrixBotEnv,
	syncMatrixBotService
} from '../lib/matrixBot.ts';

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
const DEFAULT_WEB_ROOT = '/var/www/morphit-frontend';
const DEFAULT_BACKUP_KEEP = 3;

// Services to restart UNCONDITIONALLY on upgrade.  Listed in dependency
// order (deps before consumers).  If a service unit doesn't exist on
// the host, the restart attempt is skipped with an INFO log.
//
// NOTE: morphit-matrix-bot is deliberately NOT in this list — it is
// handled by a dedicated lifecycle sync below (step 10c) that
// enable+restarts it only when a valid alert username is configured and
// disable+stops it otherwise, per the operator's `morphit-ops matrix`
// setting.  Restarting it unconditionally would needlessly bounce a unit
// that is meant to stay cleanly inert on instances not using Matrix.
const SERVICES_TO_RESTART = [
	'morphit-indexer.service',
	'morphit-relay.service'
];

// ─── Mirror fallback + source-independent integrity (beta5) ─────────
//
// Two layers, in trust order:
//
//   1. GPG detached signature (`*.tar.gz.asc`) verified against the
//      release-signer PUBLIC keys that ship IN the install at
//      `.forgejo/release-signers/*.asc`. Because the trust anchor is
//      local (already-running, code-reviewed) and not fetched from the
//      download source, a tarball that passes this check is trusted no
//      matter which mirror served the bytes — true unstoppable upgrades.
//
//   2. Anchored SHA-256: the tiny `.tar.gz.sha256` is always taken from
//      the TRUSTED PRIMARY over HTTPS; the big tarball bytes may come
//      from a mirror; we verify the bytes against the primary's hash.
//      A hostile mirror can't forge this (it doesn't control the hash).
//      If the primary is fully unreachable AND there's no valid
//      signature, we REFUSE — verifying a mirror's tarball against that
//      same mirror's checksum proves nothing.

interface ReleaseSource {
	readonly host: string;
	readonly repo: string;
	readonly isPrimary: boolean;
}

/** codeberg.org + gitea.com mirrors that publish the SAME signed release as
 *  the canonical primary — codeberg.org (Forgejo) + gitea.com (Gitea).  Built in so
 *  `morphit-ops upgrade` auto-rotates off git.agorise.net the moment it's
 *  unreachable, with NO MORPHIT_RELEASE_MIRRORS config.  ONLY hosts that speak the
 *  same `/api/v1/repos/{repo}/releases` API qualify — the download page's other
 *  mirrors (GitHub, GitLab, SourceForge, …) are git push-mirrors on different APIs
 *  and stay out of the auto-rotation (they carry the signed tag + source, not a
 *  Forgejo release object with attached assets). */
export const BUILTIN_RELEASE_MIRRORS: ReadonlyArray<{ host: string; repo: string }> = [
	{ host: 'codeberg.org', repo: 'agorise/morphit' },
	{ host: 'gitea.com', repo: 'agorise/morphit' }
];

/** Parse the primary host/repo + built-in mirrors + the MORPHIT_RELEASE_MIRRORS env
 *  into an ordered, de-duplicated source list (primary always first + trusted).
 *  Each env mirror entry is `host` (reuse primary repo) or `host/owner/repo`.
 *  Built-in mirrors are added ONLY for the canonical primary — a fork points its own
 *  primary + mirrors, and our signers wouldn't validate its releases anyway.  PURE. */
export function parseReleaseSources(
	primaryHost: string,
	primaryRepo: string,
	mirrorsEnv: string | undefined
): ReleaseSource[] {
	const sources: ReleaseSource[] = [{ host: primaryHost, repo: primaryRepo, isPrimary: true }];
	// Built-in codeberg.org + gitea.com mirrors first (auto-rotation with zero config),
	// but only when the primary is the canonical one — otherwise a custom/forked install
	// would be polling a project it didn't ship.
	if (primaryHost === DEFAULT_HOST && primaryRepo === DEFAULT_REPO) {
		for (const m of BUILTIN_RELEASE_MIRRORS) {
			if (sources.some((s) => s.host === m.host && s.repo === m.repo)) continue;
			sources.push({ host: m.host, repo: m.repo, isPrimary: false });
		}
	}
	// Then any operator-added mirrors from the env.
	for (const raw of (mirrorsEnv ?? '').split(',')) {
		const spec = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
		if (spec === '') continue;
		const slash = spec.indexOf('/');
		const host = slash === -1 ? spec : spec.slice(0, slash);
		const repo = slash === -1 ? primaryRepo : spec.slice(slash + 1);
		if (host === '' || repo === '') continue;
		if (sources.some((s) => s.host === host && s.repo === repo)) continue;
		sources.push({ host, repo, isPrimary: false });
	}
	return sources;
}

interface SelectedAssets {
	readonly tarball: ForgejoReleaseAsset;
	readonly sha: ForgejoReleaseAsset;
	readonly sig: ForgejoReleaseAsset | null;
}

/** Parse a vX.Y.Z tag from a release tarball filename, e.g.
 *  'morphit-v1.10.0-offline.tar.gz' or 'morphit-v1.10.0.tar.gz' → 'v1.10.0'. PURE. */
export function parseTagFromTarballName(name: string): string | null {
	// Optional prerelease (-beta.49, -rc.1, …) is captured, but the -offline
	// BUNDLE suffix is not part of the version, so a negative lookahead skips it.
	const m = /v(\d+\.\d+\.\d+(?:-(?!offline)[0-9A-Za-z.]+)?)/.exec(name);
	return m ? `v${m[1]}` : null;
}

/** Resolve the operator-supplied LOCAL release tarball for a fully OFFLINE
 *  upgrade (cable unplugged). Point at a downloaded self-contained
 *  morphit-<ver>-offline.tar.gz with `--from-file=<path>` (or the
 *  MORPHIT_UPGRADE_TARBALL env). Returns the tarball + sibling `.asc` (if any)
 *  + the version parsed from the filename, or null when no offline source was
 *  requested (the normal network path). Throws on a bad/missing path.
 *
 *  Trust is unchanged: with no reachable primary there is no anchored hash, so
 *  decideTrust() will REQUIRE a valid GPG signature (verified against the local
 *  code-reviewed signer keys) — an UNSIGNED offline tarball is refused, exactly
 *  as an unsigned release is refused online when the trusted primary is down. */
export function resolveOfflineTarball(
	flags: UpgradeFlags
): { tarballPath: string; sigPath: string | null; tag: string } | null {
	const raw = (flags['from-file'] ?? process.env.MORPHIT_UPGRADE_TARBALL ?? '').trim();
	if (raw === '') return null;
	const tarballPath = resolve(raw);
	if (!existsSync(tarballPath)) {
		throw new Error(`--from-file: no such file: ${tarballPath}`);
	}
	if (!tarballPath.endsWith('.tar.gz')) {
		throw new Error(`--from-file: expected a .tar.gz release tarball, got ${basename(tarballPath)}`);
	}
	const sib = `${tarballPath}.asc`;
	const sigPath = existsSync(sib) ? sib : null;
	const tag = parseTagFromTarballName(basename(tarballPath));
	if (tag === null) {
		throw new Error(
			`--from-file: could not read a version (vX.Y.Z) from ${basename(tarballPath)}. ` +
				`Expected a name like morphit-v1.10.0-offline.tar.gz.`
		);
	}
	return { tarballPath, sigPath, tag };
}

/** The conventional drop-dir where an operator leaves offline release tarballs
 *  (copied from a USB stick / another machine). Default `<installDir>-offline`
 *  — a SIBLING of the install dir, so it survives the upgrade's rename-swap.
 *  Override with MORPHIT_OFFLINE_RELEASE_DIR. */
export function offlineReleaseDir(installDir: string): string {
	return process.env.MORPHIT_OFFLINE_RELEASE_DIR ?? `${installDir}-offline`;
}

/**
 * Self-heal the advertised Tor onion. The onion is generated a few seconds after
 * Tor first starts, so on some boxes the install-time config write loses the
 * race and leaves MORPHIT_INSTANCE_TOR_ADDRESS empty — the node then advertises
 * `tor: null` in /v1/instance and the federation can't reach it over Tor (fatal
 * for a censored/Iran node whose clearnet is blocked). On every upgrade, if the
 * onion now exists on disk but the config value is empty, populate it. Idempotent
 * (a non-empty value is left alone), root-only (the onion file is 0700
 * debian-tor). PURE core via applyOnionHeal for testing.
 */
export function applyOnionHeal(envText: string, onion: string): { text: string; changed: boolean } {
	const cur = envText.match(/^MORPHIT_INSTANCE_TOR_ADDRESS=(.*)$/m)?.[1]?.trim() ?? '';
	if (cur.endsWith('.onion')) return { text: envText, changed: false }; // already set — don't clobber
	if (!onion.endsWith('.onion')) return { text: envText, changed: false };
	const line = `MORPHIT_INSTANCE_TOR_ADDRESS=${onion}`;
	if (/^MORPHIT_INSTANCE_TOR_ADDRESS=.*$/m.test(envText)) {
		return { text: envText.replace(/^MORPHIT_INSTANCE_TOR_ADDRESS=.*$/m, line), changed: true };
	}
	return { text: `${envText.replace(/\s*$/, '')}\n${line}\n`, changed: true };
}

export function healTorOnionInConfig(
	configPath: string,
	onionPath = '/var/lib/tor/morphit/hostname'
): { healed: boolean; onion: string | null } {
	let env: string;
	try {
		env = readFileSync(configPath, 'utf8');
	} catch {
		return { healed: false, onion: null };
	}
	let onion = '';
	try {
		onion = readFileSync(onionPath, 'utf8').trim();
	} catch {
		return { healed: false, onion: null }; // no onion on disk yet
	}
	const { text, changed } = applyOnionHeal(env, onion);
	if (!changed) return { healed: false, onion: onion.endsWith('.onion') ? onion : null };
	try {
		writeFileSync(configPath, text);
	} catch {
		return { healed: false, onion };
	}
	return { healed: true, onion };
}

/** Compare two vX.Y.Z[-pre] tags. Returns >0 if a is newer, <0 if older, 0 if
 *  equal/uncomparable. Release (no prerelease) beats a prerelease of the same
 *  X.Y.Z. PURE. */
export function compareTags(a: string, b: string): number {
	const parse = (t: string): { nums: number[]; pre: string | null } | null => {
		const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(t.trim());
		if (!m) return null;
		return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
	};
	const pa = parse(a);
	const pb = parse(b);
	if (pa === null || pb === null) return 0;
	for (let i = 0; i < 3; i++) {
		if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! - pb.nums[i]!;
	}
	// same X.Y.Z: a release (pre null) is newer than a prerelease
	if (pa.pre === null && pb.pre !== null) return 1;
	if (pa.pre !== null && pb.pre === null) return -1;
	if (pa.pre === null && pb.pre === null) return 0;
	return pa.pre! < pb.pre! ? -1 : pa.pre! > pb.pre! ? 1 : 0;
}

/** Scan the offline drop-dir for the newest signed release tarball an operator
 *  has left there. A tarball with NO sibling `.asc` is ignored — offline installs
 *  require a signature (an unsigned tarball can't be trusted with no primary to
 *  anchor a hash). Returns the newest {tarballPath, sigPath, tag} or null. Never
 *  throws. */
export function findLocalOfflineRelease(installDir: string): { tarballPath: string; sigPath: string; tag: string } | null {
	const dir = offlineReleaseDir(installDir);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null; // dir absent / unreadable — nothing dropped
	}
	let best: { tarballPath: string; sigPath: string; tag: string } | null = null;
	for (const name of names) {
		if (!name.endsWith('.tar.gz') || name.endsWith('.sha256.tar.gz')) continue;
		const tag = parseTagFromTarballName(name);
		if (tag === null) continue;
		const tarballPath = join(dir, name);
		const sigPath = `${tarballPath}.asc`;
		if (!existsSync(sigPath)) continue; // unsigned → not trustable offline
		if (best === null || compareTags(tag, best.tag) > 0) {
			best = { tarballPath, sigPath, tag };
		}
	}
	return best;
}

/** Build a minimal ForgejoRelease describing a LOCAL offline tarball so the
 *  offline path reuses the SAME downstream flow (version compare, trust,
 *  extract, rebuild) as the online one. The asset "URLs" are local paths and are
 *  never fetched — the offline branch copies from disk. PURE. */
function synthOfflineRelease(
	tag: string,
	tarballPath: string,
	sigPath: string | null
): ForgejoRelease {
	const name = basename(tarballPath);
	const assets: ForgejoReleaseAsset[] = [
		{ name, browser_download_url: tarballPath, size: 0 },
		// A synthetic .sha256 asset keeps selectReleaseAssets() happy; it is never
		// downloaded or trusted offline (expectedHash stays null → GPG-sig required).
		{ name: `${name}.sha256`, browser_download_url: `${tarballPath}.sha256`, size: 0 }
	];
	if (sigPath !== null) {
		assets.push({ name: `${name}.asc`, browser_download_url: sigPath, size: 0 });
	}
	return {
		tag_name: tag,
		name: tag,
		body: '',
		html_url: `file://${tarballPath}`,
		published_at: new Date(0).toISOString(),
		assets
	};
}

/** Pick the tarball + sha256 + (optional) detached GPG signature out of a
 *  release's assets. Returns null if the required tarball+sha pair is
 *  missing. PURE. */
export function selectReleaseAssets(
	assets: readonly ForgejoReleaseAsset[]
): SelectedAssets | null {
	const tarballs = assets.filter(
		(a) => a.name.endsWith('.tar.gz') && !a.name.endsWith('.sha256.tar.gz')
	);
	// Prefer the SLIM canonical tarball (morphit-<ver>.tar.gz) for ONLINE upgrades:
	// it's the artifact the SHA-256 anchor + verify-download are built around, and
	// it's small (deps are restored by `npm ci`). The self-contained
	// morphit-<ver>-offline.tar.gz is a SEPARATE, far larger artifact with its OWN
	// hash, meant only for --from-file / drop-dir installs. cp669: this function
	// used to grab the FIRST `.tar.gz` and the FIRST `.tar.gz.sha256` — so once
	// 1.10.1 added the -offline asset a release had TWO of each, and an online
	// upgrade could download the huge -offline bundle (timing out on a home
	// connection), fall back to a mirror serving the SLIM tarball, and then compare
	// the slim bytes against the -offline hash → a false "SHA-256 mismatch". Fall
	// back to an -offline tarball ONLY when it's the sole tarball (the synthetic
	// release the --from-file path builds).
	const tarball = tarballs.find((a) => !a.name.endsWith('-offline.tar.gz')) ?? tarballs[0];
	if (!tarball) return null;
	// The .sha256 (and .asc) MUST belong to the SELECTED tarball — a release ships
	// BOTH variants' .sha256, so match by EXACT name, never "the first one".
	const sha = assets.find((a) => a.name === `${tarball.name}.sha256`);
	const sig = assets.find((a) => a.name === `${tarball.name}.asc`) ?? null;
	if (!sha) return null;
	return { tarball, sha, sig };
}

type IntegrityProof =
	| 'gpg-signature'
	| 'primary-https-hash'
	| 'primary-anchored-hash'
	| 'onchain-anchored-sha256';

interface TrustDecision {
	readonly allowed: boolean;
	readonly proof: IntegrityProof | null;
	readonly reason: string;
}

/** Decide whether a downloaded tarball may be installed. PURE.
 *  - A verified GPG signature trusts ANY byte source.
 *  - Otherwise the SHA-256 must match a hash that came from the trusted
 *    primary (bytes may still have been mirrored).
 *  - Otherwise REFUSE. */
export function decideTrust(args: {
	bytesFromPrimary: boolean;
	sigVerified: boolean;
	hashMatched: boolean;
	hashFromPrimary: boolean;
	hashFromChain?: boolean;
}): TrustDecision {
	if (args.sigVerified) {
		return {
			allowed: true,
			proof: 'gpg-signature',
			reason: 'GPG signature verified against the release-signer keys shipped in the install.'
		};
	}
	// v1.16.9 — a SHA-256 anchored ON-CHAIN by @morphit's signed release broadcast
	// (read from the LOCAL indexer, no clearnet) is a valid trust anchor too — it
	// lets a hidden / air-gapped node apply an offline tarball with no hand-signing.
	if (args.hashMatched && args.hashFromChain) {
		return {
			allowed: true,
			proof: 'onchain-anchored-sha256',
			reason:
				'SHA-256 matched the release hash @morphit published on-chain (read from your local indexer — no clearnet).'
		};
	}
	if (args.hashMatched && args.hashFromPrimary) {
		return {
			allowed: true,
			proof: args.bytesFromPrimary ? 'primary-https-hash' : 'primary-anchored-hash',
			reason: args.bytesFromPrimary
				? 'SHA-256 verified against the trusted primary over HTTPS.'
				: 'SHA-256 verified against the trusted primary (tarball bytes came from a mirror).'
		};
	}
	return {
		allowed: false,
		proof: null,
		reason:
			'No trusted integrity proof: the release is unsigned and neither the trusted primary nor the ' +
			'on-chain anchor could provide the expected hash. Refusing to install a mirror-supplied tarball ' +
			'that can only be checked against the mirror\u2019s own checksum.'
	};
}

/** True iff `gpg` is on PATH. */
function gpgAvailable(): boolean {
	return spawnSync('which', ['gpg'], { stdio: 'pipe', timeout: 3000 }).status === 0;
}

/** Verify a detached signature against the release-signer pubkeys shipped
 *  at <installDir>/.forgejo/release-signers/*.asc, using a throwaway
 *  keyring (never touches the operator's ~/.gnupg). Returns true only if
 *  gpg reports a GOOD signature from one of the shipped keys. */
export function verifyDetachedSignature(
	installDir: string,
	tarballPath: string,
	sigPath: string
): boolean {
	if (!gpgAvailable()) {
		warn('gpg not found on PATH — cannot verify the release signature (will fall back to hash anchoring).');
		return false;
	}
	const signersDir = join(installDir, '.forgejo', 'release-signers');
	if (!existsSync(signersDir)) return false;
	const keyFiles = readdirSync(signersDir).filter((f) => f.endsWith('.asc'));
	if (keyFiles.length === 0) return false;

	const gnupgHome = mkdtempSync(join(tmpdir(), 'morphit-gpg-'));
	try {
		// Lock down the throwaway home (gpg insists on 0700).
		spawnSync('chmod', ['700', gnupgHome], { stdio: 'ignore' });
		for (const kf of keyFiles) {
			const imp = spawnSync('gpg', ['--homedir', gnupgHome, '--batch', '--import', join(signersDir, kf)], {
				stdio: 'pipe',
				timeout: 15000
			});
			if (imp.status !== 0) {
				warn(`Could not import release-signer key ${kf}.`);
			}
		}
		const res = spawnSync(
			'gpg',
			['--homedir', gnupgHome, '--batch', '--status-fd', '1', '--verify', sigPath, tarballPath],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }
		);
		const status = typeof res.stdout === 'string' ? res.stdout : '';
		// A trustworthy result = a GOODSIG/VALIDSIG line AND a zero exit.
		return res.status === 0 && /\bVALIDSIG\b/.test(status);
	} finally {
		rmSync(gnupgHome, { recursive: true, force: true });
	}
}


/** Resolve the directory nginx serves the static frontend from.
 *  `MORPHIT_WEB_ROOT` overrides; default matches docs/RUN-A-MORPHIT-NODE.md
 *  §8 (`/var/www/morphit-frontend`). PURE. */
export function resolveWebRoot(env: { MORPHIT_WEB_ROOT?: string }): string {
	const v = (env.MORPHIT_WEB_ROOT ?? '').trim();
	return v === '' ? DEFAULT_WEB_ROOT : v;
}



/** Path to the MCP server's optional env file. systemd reads it as
 *  `EnvironmentFile=-/etc/morphit/mcp.env`, which OVERRIDES the unit's
 *  `Environment=` defaults. `MORPHIT_ETC_DIR` overrides `/etc/morphit` for
 *  tests. PURE. */
export function mcpEnvFile(): string {
	const etc = process.env.MORPHIT_ETC_DIR ?? '/etc/morphit';
	return join(etc, 'mcp.env');
}

/** The HTTP bind `morphit-mcp.service` actually listens on. The unit sets
 *  `MORPHIT_MCP_HTTP_HOST=127.0.0.1` / `_PORT=8124` as DEFAULTS and reads
 *  `/etc/morphit/mcp.env` AFTER, so a value there wins. On a BunkerWeb/Docker
 *  host that file typically pins the bridge gateway
 *  (`MORPHIT_MCP_HTTP_HOST=172.18.0.1`) so a reverse proxy can reach the
 *  service — the exact reason a reachability probe must read the CONFIGURED
 *  host and never assume loopback (a `127.0.0.1` probe would miss a
 *  bridge-bound listener). Reads the file if present; otherwise returns the
 *  unit defaults. Last assignment wins (mirrors `set -a; . file`). */
export function resolveMcpHttpBind(mcpEnvPath: string): { host: string; port: number } {
	let host = '127.0.0.1';
	let port = 8124;
	if (existsSync(mcpEnvPath)) {
		let text = '';
		try {
			text = readFileSync(mcpEnvPath, 'utf-8');
		} catch {
			text = '';
		}
		for (const line of text.split('\n')) {
			const h = line.match(/^\s*MORPHIT_MCP_HTTP_HOST\s*=\s*(\S+)/);
			if (h) {
				const v = h[1]!.replace(/^["']|["']$/g, '').trim();
				if (v) host = v;
			}
			const p = line.match(/^\s*MORPHIT_MCP_HTTP_PORT\s*=\s*(\S+)/);
			if (p) {
				const n = Number(p[1]!.replace(/^["']|["']$/g, '').trim());
				if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
			}
		}
	}
	return { host, port };
}

/** Build the MCP `/health` URL for a host:port, bracketing IPv6 literals so
 *  `fetch` parses them. PURE. */
export function buildMcpHealthUrl(host: string, port: number): string {
	const h = host.includes(':') ? `[${host}]` : host;
	return `http://${h}:${port}/health`;
}

/** Classify a `/health` response. The MCP HTTP transport answers
 *  `GET /health` → `200 { status: 'ok', transport: 'http' }` (liveness only —
 *  no auth, not rate-limited; `apps/mcp-server/src/main.ts`). PURE. */
export function classifyMcpHealth(status: number, bodyText: string): 'ok' | 'bad_status' | 'bad_body' {
	if (status !== 200) return 'bad_status';
	try {
		const j = JSON.parse(bodyText) as { status?: unknown };
		return j && j.status === 'ok' ? 'ok' : 'bad_body';
	} catch {
		return 'bad_body';
	}
}

/** Probe the MCP `/health` endpoint with a few retries — the service needs a
 *  moment to bind its listener after a restart. Best-effort: returns
 *  reachability + a short human detail, NEVER throws. Not pure (network); the
 *  verdict classification is the pure `classifyMcpHealth`. */
async function probeMcpHealth(
	url: string,
	opts: { attempts?: number; delayMs?: number; timeoutMs?: number } = {}
): Promise<{ reachable: boolean; detail: string }> {
	const attempts = opts.attempts ?? 5;
	const delayMs = opts.delayMs ?? 1500;
	const timeoutMs = opts.timeoutMs ?? 3000;
	let lastDetail = 'no response';
	for (let i = 0; i < attempts; i++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
			const text = (await res.text()).slice(0, 4096);
			const verdict = classifyMcpHealth(res.status, text);
			if (verdict === 'ok') return { reachable: true, detail: `HTTP ${res.status}` };
			lastDetail = verdict === 'bad_status' ? `HTTP ${res.status}` : `HTTP ${res.status}, unexpected body`;
		} catch (e) {
			lastDetail = e instanceof Error ? e.message : String(e);
		} finally {
			clearTimeout(timer);
		}
		if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
	}
	return { reachable: false, detail: lastDetail };
}

/** Path to the operator's backup config. Root-owned; the upgrade (privileged)
 *  can read it. */
function backupEnvFile(): string {
	const etc = process.env.MORPHIT_ETC_DIR ?? '/etc/morphit';
	return join(etc, 'backup.env');
}

/** Resolve the DB name + user the backup should target by parsing the deployed
 *  morphit.env's MORPHIT_INDEXER_DATABASE_URL (falls back to the init.sql
 *  defaults). Read-only; never throws. IMPURE. */
function resolveDbIdentity(installDir: string): DbIdentity {
	const url = readDeployedDatabaseUrl(installDir);
	if (url) {
		const id = dbIdentityFromUrl(url);
		if (id) return id;
	}
	return { dbName: BACKUP_DB_NAME, dbUser: BACKUP_DB_USER };
}

/** Every-upgrade Docker-aware assurance (cp509 / v1.8.4 B): if the operator has
 *  a backup configured but its DB_CONTAINER is empty WHILE their Postgres is
 *  actually containerized, the daily backup is dumping the host (= nothing).
 *  Detect that drift and WARN with the exact one-line fix. Best-effort + never
 *  throws: an unreadable/absent backup.env, or a host Postgres, is a silent
 *  no-op. We deliberately do NOT auto-edit the operator's root-owned /etc
 *  config (same warn-don't-mutate posture as the MCP + canary checks). IMPURE. */
function ensureBackupDockerAware(installDir: string): void {
	try {
		const path = backupEnvFile();
		if (!existsSync(path)) return; // backups not configured — nothing to nag
		let text: string;
		try {
			text = readFileSync(path, 'utf-8');
		} catch {
			return; // unreadable as this user — skip silently
		}
		const configured = parseBackupDbContainer(text);
		if (configured !== '') return; // already Docker-aware — nothing to do
		// DB_CONTAINER is empty. Is the DB actually containerized? Probe under the
		// operator's REAL db name/user (from the deployed connection URL), so a
		// non-standard box (e.g. morphit_user/morphit_db) matches provably.
		const { dbName, dbUser } = resolveDbIdentity(installDir);
		const detected = detectDbContainer(dbUser, dbName);
		const verdict = assessBackupDockerDrift(true, configured, detected);
		if (verdict.kind !== 'drift') return;
		info('');
		warn(
			`Your Postgres is running in the container "${verdict.container}", but ${path} has ` +
				`DB_CONTAINER empty — your daily backup is dumping the HOST, not the container, so it ` +
				`is likely capturing nothing. Make it Docker-aware (one line, then it dumps via ` +
				`\`docker exec ${verdict.container} pg_dump\`):\n` +
				`      sudo sed -i 's/^DB_CONTAINER=.*/DB_CONTAINER=${verdict.container}/' ${path}\n` +
				`  Test it immediately with \`sudo systemctl start morphit-backup.service\` and check ` +
				`\`journalctl -u morphit-backup.service\`.`
		);
	} catch {
		/* best-effort assurance; never fail an upgrade over the backup check */
	}
}
/**
 * Split schema.sql into its `-- ─── v<N> …` sections, keyed by version.
 * Everything before the first marker is the preamble, keyed as version 0.
 *
 * Exported for the smoke; pure.
 */
export function splitSchemaSections(sql: string): Map<number, string> {
	const out = new Map<number, string>();
	const marker = /^-- \u2500\u2500\u2500 v(\d+)\b/gm;
	const starts: { version: number; index: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = marker.exec(sql)) !== null) {
		starts.push({ version: Number(m[1]), index: m.index });
	}
	if (starts.length === 0) {
		out.set(0, sql);
		return out;
	}
	out.set(0, sql.slice(0, starts[0]!.index));
	for (let i = 0; i < starts.length; i++) {
		const from = starts[i]!.index;
		const to = i + 1 < starts.length ? starts[i + 1]!.index : sql.length;
		out.set(starts[i]!.version, sql.slice(from, to));
	}
	return out;
}

/**
 * Does an EXISTING database need operator attention after this upgrade?
 *
 * cp447 — this used to be a raw byte-diff of schema.sql, and it lied on every
 * release. Since v37 the convention is that a schema change ships as a NEW
 * `-- ─── v<N>` section plus a numbered entry in `MIGRATIONS[]`, which the
 * indexer applies to an existing DB automatically at start-up. A byte-diff
 * cannot tell that apart from the pre-v37 situation — schema.sql edited IN
 * PLACE, which an existing DB never picks up — so it told operators their
 * database might need a reset every time we shipped a perfectly ordinary
 * migration. Telling someone to reset a chain-derived DB they did not need to
 * reset is hours of re-sync for nothing, and worse, it trains them to ignore
 * the warning that will one day be real.
 *
 * So: sections that are NEW in this version are the additive, self-applying
 * kind. Strip them, and compare what remains. Anything else that moved — the
 * preamble, a table body, an existing section rewritten — is an in-place edit
 * that an existing DB will NOT pick up, and the operator does need to know.
 */
/** Highest `version:` in the tree's MIGRATIONS[] array, or 0 if unreadable.
 *
 *  Read from SOURCE rather than the DB: this runs during an upgrade, before
 *  the indexer restarts, so the DB has not seen the new migration yet. */
export function highestMigrationVersion(installDir: string): number {
	const p = join(installDir, 'apps', 'indexer', 'src', 'db', 'migrations.ts');
	if (!existsSync(p)) return 0;
	try {
		const src = readFileSync(p, 'utf8');
		let highest = 0;
		for (const m of src.matchAll(/^\s*version:\s*(\d+)\s*,/gm)) {
			const n = Number(m[1]);
			if (Number.isFinite(n) && n > highest) highest = n;
		}
		return highest;
	} catch {
		return 0;
	}
}

/** Did this upgrade edit schema.sql WITHOUT shipping a migration to carry the
 *  change to existing databases?
 *
 *  v1.8.12 (the maintainer) — `schemaBaselineChanged()` alone is not that question. It
 *  diffs schema.sql and nothing else, so ANY schema edit triggered the
 *  "changed IN PLACE — not via a numbered migration" warning, even when a
 *  numbered migration existed and had already been applied automatically at
 *  indexer start-up.
 *
 *  the maintainer hit exactly that upgrading to v1.8.12, which ships MIGRATION 51: his
 *  database was correctly updated, and the upgrade told him it was not and
 *  pointed him at a reset + re-sync procedure. A false alarm that recommends
 *  rebuilding a database is worse than no alarm — it spends the operator's
 *  trust and invites unnecessary downtime.
 *
 *  The real condition is BOTH: schema.sql changed AND no new migration
 *  arrived to carry it. */
export function schemaChangedWithoutMigration(
	oldInstallDir: string,
	newInstallDir: string
): boolean {
	if (!schemaBaselineChanged(oldInstallDir, newInstallDir)) return false;
	const before = highestMigrationVersion(oldInstallDir);
	const after = highestMigrationVersion(newInstallDir);
	// A new numbered migration means the change IS carried to existing DBs.
	return after <= before;
}

export function schemaBaselineChanged(oldInstallDir: string, newInstallDir: string): boolean {
	const rel = join('apps', 'indexer', 'src', 'db', 'schema.sql');
	const oldP = join(oldInstallDir, rel);
	const newP = join(newInstallDir, rel);
	if (!existsSync(oldP) || !existsSync(newP)) return false;
	try {
		const oldSql = readFileSync(oldP, 'utf8');
		const newSql = readFileSync(newP, 'utf8');
		if (oldSql === newSql) return false;

		const oldSections = splitSchemaSections(oldSql);
		const newSections = splitSchemaSections(newSql);

		// Every section the old install already knew about must still carry the
		// same SQL, and none may have vanished. Sections only the new install has
		// are the additive migrations the indexer runs itself.
		//
		// Compare with each section's boundary whitespace normalized (`.trim()`):
		// a section's trailing whitespace SHIFTS whenever a LATER section is
		// appended after it (the new `-- ─── v<N>` marker moves where this
		// section ends — e.g. the formerly-last section gains the blank line that
		// now precedes the next marker). That is never a real schema change, so a
		// byte-exact compare would cry drift on every release that adds a section.
		// Only a change to a section's actual CONTENT means an existing DB is
		// missing something.
		for (const [version, oldBody] of oldSections) {
			const newBody = newSections.get(version);
			if (newBody === undefined || newBody.trim() !== oldBody.trim()) return true;
		}
		return false;
	} catch {
		return false;
	}
}

/** Copy a freshly-built SvelteKit static site (`buildDir`, e.g.
 *  <install>/apps/web/build) into the web root nginx serves. Overwrites
 *  same-named files and leaves any other existing files in place — the
 *  same end-state as the documented `cp -r apps/web/build/* <webRoot>/`.
 *  Throws if the build is missing/empty or if `index.html` didn't land
 *  (a wrecked deploy we must NOT leave live — the caller rolls back).
 *  Side-effectful but self-contained, so it's unit-tested directly. */
export function deployFrontendBuild(buildDir: string, webRoot: string): void {
	if (!existsSync(buildDir) || !existsSync(join(buildDir, 'index.html'))) {
		throw new Error(
			`Web build not found at ${buildDir} (expected an index.html). ` +
				`Did 'npm run build' in apps/web succeed?`
		);
	}
	mkdirSync(webRoot, { recursive: true });
	// cpSync mirrors buildDir's CONTENTS into webRoot (webRoot/index.html,
	// not webRoot/build/index.html); force:true overwrites existing files.
	cpSync(buildDir, webRoot, { recursive: true, force: true });
	if (!existsSync(join(webRoot, 'index.html'))) {
		throw new Error(
			`Frontend deploy did not produce ${join(webRoot, 'index.html')}.`
		);
	}
}

/** How to PUBLISH a freshly-built frontend after the (always-run) build.
 *  beta11 (supersedes cp236). */
export interface FrontendDeployPlan {
	/** Copy build/ into <webRoot> — the bare-metal nginx model. */
	readonly copyToWebRoot: boolean;
	/** Name of the container that bind-mounts the freshly-built
	 *  apps/web/build — `docker restart` it so it re-binds the new build.
	 *  null when no such container was found. */
	readonly restartContainer: string | null;
	/** Non-null when NEITHER publish path applies — a non-standard serving
	 *  setup the operator must finish by hand.  The build is still fresh. */
	readonly warn: string | null;
}

/** Decide how to publish the freshly-built frontend from two signals: does
 *  the bare-metal web root exist, and is there a running container that
 *  bind-mounts the build dir.  Both may apply (do both); neither is a
 *  non-standard setup that earns a loud warning.  The BUILD itself always
 *  runs before this — this only covers post-build publishing.  PURE (so the
 *  smoke can exhaust the four cases).
 *
 *  beta11 — `frontendContainer` REPLACES cp236's container-present boolean.
 *  cp236 assumed the container was named "morphit-frontend" and
 *  recreated it via the repo's example compose file — both wrong on real
 *  deployments (a `docker compose` project names it `<project>-frontend-1`,
 *  e.g. `bunkerweb-frontend-1`, and recreating it with the repo's example
 *  compose can crash-loop the container on a cert/config path the operator's
 *  real stack doesn't share).  We now identify the container by the
 *  apps/web/build mount it carries and just `docker restart` it (no
 *  compose-file, no name assumption). */
export function planFrontendDeploy(opts: {
	webRootExists: boolean;
	frontendContainer: string | null;
	webRoot: string;
	buildDir: string;
}): FrontendDeployPlan {
	const copyToWebRoot = opts.webRootExists;
	const restartContainer = opts.frontendContainer;
	const warn =
		!copyToWebRoot && restartContainer === null
			? `Web frontend was rebuilt at ${opts.buildDir}, but no known serving target ` +
				`was found — neither the web root ${opts.webRoot} nor a running container ` +
				`bind-mounting ${opts.buildDir}. If your site is served from a custom path, ` +
				`set MORPHIT_WEB_ROOT and re-run, or copy ${opts.buildDir}/* to your web root ` +
				`by hand (and restart your frontend container if you run one). The backend ` +
				`services were still upgraded.`
			: null;
	return { copyToWebRoot, restartContainer, warn };
}

/** Best-effort: is `docker` usable on this host? IMPURE. */
function dockerAvailable(): boolean {
	return spawnSync('docker', ['--version'], { stdio: 'pipe', timeout: 3000 }).status === 0;
}

/** Normalize a filesystem path for mount comparison: drop a single
 *  trailing slash (but keep a bare "/").  PURE. */
export function normalizeMountPath(p: string): string {
	const t = p.trim();
	if (t.length > 1 && t.endsWith('/')) return t.slice(0, -1);
	return t;
}

/** Parse the newline-separated mount Sources our `docker inspect --format`
 *  emits into a clean list.  PURE. */
export function parseMountSources(inspectStdout: string): string[] {
	return inspectStdout
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Does a container (given its bind-mount Sources) bind-mount the build
 *  dir?  Compares normalized paths for an exact match.  PURE.  This is the
 *  robust, name-agnostic signal that a container serves OUR frontend build
 *  (the canonical compose binds `<install>/apps/web/build` →
 *  /usr/share/nginx/html; a custom stack like the maintainer's binds the same dir). */
export function containerMountsBuildDir(sources: readonly string[], buildDir: string): boolean {
	const target = normalizeMountPath(buildDir);
	return sources.some((s) => normalizeMountPath(s) === target);
}

/** Find the RUNNING container that bind-mounts the freshly-built
 *  apps/web/build — identified by the mount, NOT by a container name or a
 *  compose file (cp236's two wrong assumptions).  Returns the container
 *  name, or null if docker is absent / no running container mounts the
 *  build dir.  IMPURE. */
function findFrontendContainer(buildDir: string): string | null {
	if (!dockerAvailable()) return null;
	const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], {
		stdio: 'pipe',
		timeout: 5000,
		encoding: 'utf8'
	});
	if (ps.status !== 0) return null;
	const names = (ps.stdout ?? '')
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	for (const name of names) {
		const insp = spawnSync(
			'docker',
			['inspect', '--format', '{{range .Mounts}}{{.Source}}\n{{end}}', name],
			{ stdio: 'pipe', timeout: 5000, encoding: 'utf8' }
		);
		if (insp.status !== 0) continue;
		const sources = parseMountSources(insp.stdout ?? '');
		if (containerMountsBuildDir(sources, buildDir)) return name;
	}
	return null;
}

/** `docker restart <name>` so the container re-binds the freshly-built
 *  apps/web/build on start (a running container keeps serving the
 *  pre-upgrade inode after the install dir was renamed).  BEST-EFFORT — a
 *  failure here must NOT roll the upgrade back (the backend is already
 *  upgraded and the build is fresh on disk); we warn with the manual
 *  command instead.  No compose file, no name assumption — just restart the
 *  exact container we detected.  IMPURE. */
function restartFrontendContainer(name: string, installDir: string): void {
	// The frontend nginx.conf is BAKED into the image at build time, so a plain
	// restart keeps a STALE config (the maintainer/timeapp: the `/v1/` 4 KB body cap that
	// 413'd every avatar upload survived every restart + every backend upgrade).
	// When the container is compose-managed, REBUILD it after refreshing its
	// build-context nginx.conf from the upgraded repo, so config fixes actually
	// ship. Falls back to a plain restart when it isn't compose-managed.
	const label = (key: string): string =>
		(
			spawnSync('docker', ['inspect', name, '--format', `{{ index .Config.Labels "${key}" }}`], {
				encoding: 'utf8',
				timeout: 10_000
			}).stdout ?? ''
		).trim();
	const configFile = (label('com.docker.compose.project.config_files').split(',')[0] ?? '').trim();
	const workDir = label('com.docker.compose.project.working_dir');
	const service = label('com.docker.compose.service');

	if (configFile !== '' && existsSync(configFile) && service !== '') {
		try {
			// Build context is <workdir>/frontend; refresh its nginx.conf from the
			// upgraded repo so the rebuild bakes the CURRENT config.
			const srcConf = join(installDir, 'ops', 'bunkerweb', 'frontend', 'nginx.conf');
			const dstConf = join(workDir !== '' ? workDir : dirname(configFile), 'frontend', 'nginx.conf');
			if (existsSync(srcConf) && existsSync(dirname(dstConf))) {
				copyFileSync(srcConf, dstConf);
				info('Refreshed the frontend nginx.conf from the upgraded release.');
			}
		} catch {
			/* best-effort — the rebuild still recreates the container */
		}
		info(`Rebuilding the frontend container "${name}" so it serves the current config + build...`);
		// --force-recreate is LOAD-BEARING: on an upgrade the rebuilt image is
		// usually byte-identical (same nginx.conf), so a plain `up --build` sees no
		// change and leaves the RUNNING container in place — still bind-mounted to
		// the pre-upgrade apps/web/build inode (step 7 renamed the install to .bak),
		// so it serves the STALE build (the maintainer/morphitir v1.17.0: upgrade reported
		// success while /verify.json stayed 1.16.13). Forcing the recreate re-binds
		// the mount to the freshly-extracted build, fixing config AND content.
		const rebuilt =
			spawnSync('docker', ['compose', '-f', configFile, 'up', '-d', '--build', '--force-recreate', service], { stdio: 'inherit', timeout: 300_000 }).status === 0 ||
			spawnSync('docker-compose', ['-f', configFile, 'up', '-d', '--build', '--force-recreate', service], { stdio: 'inherit', timeout: 300_000 }).status === 0;
		if (rebuilt) {
			info(`\u2713 Frontend container "${name}" rebuilt (config changes applied).`);
			return;
		}
		warn('Could not rebuild the frontend via compose; falling back to a restart.');
	}

	info(`Restarting the frontend container "${name}" so it serves the new build...`);
	const res = spawnSync('docker', ['restart', name], { stdio: 'inherit' });
	if (res.status !== 0) {
		warn(
			`Could not restart the frontend container automatically. Run this yourself so ` +
				`it serves the new build:\n      docker restart ${name}`
		);
		return;
	}
	info(`\u2713 Frontend container "${name}" restarted.`);
}

// ─── Frontend "is the new build actually served?" verification (beta14) ──
//
// The publish step above rebuilds + republishes the frontend, but nothing
// confirmed the RESULT reaches browsers.  When it silently doesn't — a
// container serving a baked-in image, a detection miss, a stale copy — the
// new service worker never ships, so the "Load it now" update prompt never
// fires (the recurring symptom).  We compare the build `version` written to
// build/verify.json — a single stable token, identical on the built and
// served sides — and say exactly what's wrong when they differ, instead of
// reporting a silent success.

/** Parse the build `version` field out of a verify.json document. The
 *  postbuild step (scripts/build-verify-json.mjs) writes
 *  `{ "version": "1.0.0-beta.N", … }` to build/verify.json, giving one
 *  stable, unambiguous token that is identical in the built file and what a
 *  correctly-publishing server serves. (The previous check grepped a
 *  `morphit-<version>` literal out of the service worker, but SvelteKit
 *  concatenates its per-build version at runtime, so no such literal
 *  survives minification — the check always came back "unknown".)  PURE. */
export function parseVerifyJsonVersion(jsonSource: string): string | null {
	try {
		// The field is `morphit_version` — the exact key
		// scripts/build-verify-json.mjs writes and the
		// about-this-instance page reads.  (Reading a bare `version`
		// here silently returned null on every real verify.json, so the
		// served-frontend check always reported "unknown" — the very bug
		// this check was meant to fix.  Guarded by FD-21c.)
		const v = (JSON.parse(jsonSource) as { morphit_version?: unknown }).morphit_version;
		return typeof v === 'string' && v.length > 0 ? v : null;
	} catch {
		return null;
	}
}

export type FrontendVerifyState = 'fresh' | 'stale' | 'unknown';

/** Compare the just-built SW version against the served one.  PURE. */
export function classifyFrontendVerify(
	builtVersion: string | null,
	servedVersion: string | null
): FrontendVerifyState {
	if (builtVersion === null || servedVersion === null) return 'unknown';
	return builtVersion === servedVersion ? 'fresh' : 'stale';
}

/** Read + parse the freshly-built frontend's version from build/verify.json. */
function readBuiltVersion(buildDir: string): string | null {
	try {
		const p = join(buildDir, 'verify.json');
		if (!existsSync(p)) return null;
		return parseVerifyJsonVersion(readFileSync(p, 'utf8'));
	} catch {
		return null;
	}
}

/** The container's own bridge IP(s), so the host can fetch what the
 *  frontend container actually serves (bypassing the public proxy/cert;
 *  BunkerWeb has no server-side cache, so the container's bytes are what
 *  browsers get). */
function containerBridgeIps(name: string): string[] {
	try {
		const insp = spawnSync(
			'docker',
			['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', name],
			{ stdio: 'pipe', timeout: 5000, encoding: 'utf8' }
		);
		if (insp.status !== 0) return [];
		return (insp.stdout ?? '')
			.split(/\s+/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && /^[0-9.]+$/.test(s));
	} catch {
		return [];
	}
}

/** Fetch + parse the served frontend's version from /verify.json (best-effort). */
async function fetchServedVersion(url: string, timeoutMs = 4000): Promise<string | null> {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
		if (!res.ok) return null;
		return parseVerifyJsonVersion(await res.text());
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

/** Resolve the served frontend version for whichever publish path applied.
 *  Bare-metal: read the copied build/verify.json under webRoot.  Containerized:
 *  fetch the just-restarted container's own :80/verify.json (with a short
 *  retry while it comes back up).  Returns null when it can't be determined. */
async function resolveServedVersion(
	plan: { copyToWebRoot: boolean; restartContainer: string | null },
	webRoot: string
): Promise<string | null> {
	if (plan.copyToWebRoot) {
		try {
			const p = join(webRoot, 'verify.json');
			if (existsSync(p)) return parseVerifyJsonVersion(readFileSync(p, 'utf8'));
		} catch {
			// fall through to the container probe (covers "both")
		}
	}
	if (plan.restartContainer) {
		const container = plan.restartContainer;
		const served = await withSpinner('Waiting for the upgraded service to come up…', async () => {
			for (let attempt = 0; attempt < 5; attempt++) {
				for (const ip of containerBridgeIps(container)) {
					const v = await fetchServedVersion(`http://${ip}:80/verify.json`);
					if (v !== null) return v;
				}
				if (attempt < 4) await new Promise((r) => setTimeout(r, 1500));
			}
			return null;
		});
		if (served !== null) return served;
	}
	return null;
}


export async function runUpgrade(opts: RunUpgradeOptions): Promise<number> {
	const checkOnly = opts.flags['check-only'] === 'true';
	const forceYes = opts.flags['yes'] === 'true' || process.env.MORPHIT_AUTO_UPGRADE === '1';
	const jsonOutput = opts.flags['json'] === 'true';

	// npm banner suppression now happens at CLI STARTUP (see main.ts). It was
	// here, which was too late: npm defers its "New major version available!"
	// notice to process EXIT, so a child spawned before this line printed it
	// anyway — an operator saw it after a clean upgrade, advising an npm upgrade
	// they must not perform, since the release vendors a pinned npm/node.

/**
 * Run a child process while the braille spinner turns, then replay its output.
 *
 * WHY NOT spawnSync: spawnSync BLOCKS the event loop, so no setInterval can
 * fire and a spinner wrapped around it would sit frozen — worse than none. The
 * async spawn keeps the loop turning so the spinner actually animates.
 *
 * Output is captured rather than inherited, because a spinner and a child both
 * writing to the same TTY corrupt each other's lines. It is replayed verbatim
 * once the step finishes, so nothing is lost — the operator just sees it as a
 * block after the step instead of dribbling out during it.
 *
 * the maintainer's standing rule: NO STEP RUNS SILENT. Every pause long enough to look
 * like a hang gets a spinner, so an admin always knows work is happening.
 */
async function runStepWithSpinner(
	label: string,
	cmd: string,
	args: readonly string[],
	opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<number> {
	const stop = startDotsSpinner(label);
	try {
		return await new Promise<number>((resolveStep) => {
			const child = spawn(cmd, [...args], {
				cwd: opts.cwd,
				stdio: ['ignore', 'pipe', 'pipe']
			});
			let buf = '';
			child.stdout?.on('data', (d: Buffer) => {
				buf += d.toString();
			});
			child.stderr?.on('data', (d: Buffer) => {
				buf += d.toString();
			});
			let timer: NodeJS.Timeout | null = null;
			if (opts.timeoutMs !== undefined) {
				timer = setTimeout(() => {
					try {
						child.kill('SIGKILL');
					} catch {
						/* already gone */
					}
				}, opts.timeoutMs);
			}
			const finish = (code: number): void => {
				if (timer !== null) clearTimeout(timer);
				stop();
				if (buf.trim() !== '') process.stdout.write(buf.endsWith('\n') ? buf : buf + '\n');
				resolveStep(code);
			};
			child.on('error', () => finish(1));
			child.on('close', (code) => finish(code ?? 1));
		});
	} finally {
		stop();
	}
}

	// cp674 — before we spawn any child npm, strip an inherited offline flag.
	// The ansible launcher runs us via `npm exec --offline`; that flag would
	// otherwise force the upgrade's `npm ci` (and the MCP redeploy's
	// `npm install`) cache-only and fail on any dependency not already cached.
	// Safe for air-gapped upgrades too — those skip npm ci / pass --offline
	// explicitly themselves (see stripInheritedNpmOffline docs).
	const clearedOfflineFlags = stripInheritedNpmOffline(process.env);
	if (clearedOfflineFlags.length > 0 && !checkOnly) {
		info(
			`Cleared inherited npm offline flag(s) so dependency install can reach the registry when needed: ${clearedOfflineFlags.join(', ')}.`
		);
	}

	// cp686 — quiet npm's warn-level chatter for the child installs we run during
	// an upgrade. `npm ci` prints "npm warn deprecated …" for transitive packages
	// we don't control (matrix-bot-sdk still pulls the old `request` library,
	// better-sqlite3 pulls prebuild-install), which is noise an operator can't act
	// on and — mid-upgrade — reads like something is wrong. Errors still surface.
	// Only set for upgrades; a developer's own build keeps full output.
	if (!checkOnly) process.env.npm_config_loglevel = 'error';
	// cp687 — raise the frontend build's chunk-size warning limit for upgrades so
	// operators don't see a "(!) some chunks are larger than 500 kB" hint they
	// can't act on. Dev/CI builds keep the warning (they don't set this).
	if (!checkOnly) process.env.MORPHIT_QUIET_BUILD = '1';

	const host = process.env.MORPHIT_RELEASE_HOST ?? DEFAULT_HOST;
	const repo = process.env.MORPHIT_RELEASE_REPO ?? DEFAULT_REPO;
	const installDir = process.env.MORPHIT_INSTALL_DIR ?? DEFAULT_INSTALL_DIR;
	const webRoot = resolveWebRoot(process.env);
	const sources = parseReleaseSources(host, repo, process.env.MORPHIT_RELEASE_MIRRORS);

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

	// ─── 2. Discover the latest release across sources ──────────
	// OFFLINE: an operator-supplied local tarball (--from-file / MORPHIT_UPGRADE_
	// TARBALL) bypasses all network discovery + download — the whole point of the
	// offline-first guarantee (install AND upgrade must work cable-unplugged).
	let offline: { tarballPath: string; sigPath: string | null; tag: string } | null;
	try {
		offline = resolveOfflineTarball(opts.flags);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		return 5;
	}

	// v1.16.1 — HIDDEN-ONLY upgrade. When no explicit local tarball was given and
	// this node is hidden-only (clearnet RPC pool empty), fetch the release from a
	// federation peer's IPFS gateway over Tor/I2P, verified against the on-chain
	// SHA-256 (fail-closed: throws rather than touch clearnet). The verified
	// tarball is then handed to the SAME offline apply path below — only the trust
	// gate is overridden (its anchor is the on-chain SHA, not a GPG sig/primary).
	let hiddenResolution: HiddenUpgradeResolution | null = null;
	if (offline === null) {
		try {
			hiddenResolution = await tryResolveHiddenUpgrade({
				// The hidden-only signal lives where the RPC pool is actually
				// written — indexer.env — NOT morphit.config.env (the v1.16.6 bug).
				// The resolver prefers the local indexer's clearnet_eliminated and
				// only falls back to these files if it can't reach the indexer.
				configEnvPaths: [
					'/etc/morphit/indexer.env',
					join(installDir, 'indexer.env'),
					'/etc/morphit/morphit.config.env',
					join(installDir, 'morphit.config.env')
				],
				onProgress: (m) => info(m)
			});
		} catch (err) {
			printError(
				`Hidden-only upgrade could not be completed privately (staying on the current version): ` +
					`${err instanceof Error ? err.message : String(err)}`
			);
			return 5; // fail-closed — never fall back to a clearnet mirror
		}
		if (hiddenResolution !== null) {
			offline = { tarballPath: hiddenResolution.tarballPath, sigPath: null, tag: `v${hiddenResolution.version}` };
		}
	}

	// The PRIMARY is the trusted hash anchor. We fetch each source's
	// release listing; `primaryRelease` (if reachable) anchors the
	// SHA-256, while a mirror release lets us still SEE + (if signed)
	// install when the primary is down. Discovery order = source order.
	let primaryRelease: ForgejoRelease | null = null;
	const releasesBySource: Array<{ src: ReleaseSource; rel: ForgejoRelease }> = [];
	let latest: ForgejoRelease | null;
	if (offline !== null) {
		latest = synthOfflineRelease(offline.tag, offline.tarballPath, offline.sigPath);
		info(`Offline upgrade — using local tarball: ${offline.tarballPath}`);
		// A HIDDEN-federation fetch carries no sibling .asc by design: its trust
		// anchor is the SHA-256 @morphit published ON-CHAIN, read from this node's
		// own indexer (hidden-federation-onchain-sha256) — strictly stronger than a
		// local-keyring signature check, and it needs no clearnet. Warning about a
		// missing .asc there is FALSE and alarming: it says the tarball "will be
		// refused" moments before the upgrade verifies and proceeds (the maintainer/morphitlat
		// v1.17.1). Only warn for a hand-supplied --from-file tarball, which really
		// does require the signature.
		if (offline.sigPath === null && hiddenResolution === null) {
			// Accurate wording matters here: an unsigned --from-file tarball is NOT
			// automatically refused. Below, a missing .asc falls back to the release
			// SHA-256 @morphit published ON-CHAIN (read from this node's own
			// indexer), and the upgrade proceeds if the bytes match. Claiming it
			// "will be refused" and then succeeding is the same class of false
			// alarm as the hidden-path warning this release just removed.
			warn(
				'No sibling .asc signature next to the tarball. This upgrade will fall back to the ' +
					'release SHA-256 published on-chain; it is refused only if neither a valid signature ' +
					'nor a matching on-chain hash can be established.'
			);
		}
	} else {
		const fetchErrors: string[] = [];
		for (const src of sources) {
			try {
				const rel = await withSpinner(
					`Checking ${src.host} for the latest release…`,
					() => fetchLatestRelease(src.host, src.repo)
				);
				releasesBySource.push({ src, rel });
				if (src.isPrimary) primaryRelease = rel;
			} catch (err) {
				fetchErrors.push(`${src.host}/${src.repo}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		latest = primaryRelease ?? releasesBySource[0]?.rel ?? null;
		if (latest === null) {
			// All network sources unreachable. Before giving up, fall back to a
			// signed tarball the operator has dropped in the offline dir — this is
			// what lets an upgrade begun online CONTINUE (or a fully offline box
			// upgrade) with the cable unplugged, exactly like the first install.
			const dropped = findLocalOfflineRelease(installDir);
			if (dropped !== null) {
				offline = dropped;
				latest = synthOfflineRelease(dropped.tag, dropped.tarballPath, dropped.sigPath);
				info(`No network — falling back to the local offline release: ${dropped.tarballPath}`);
			} else {
				printError(
					`Could not reach any release source, and no signed offline tarball was found in ` +
						`${offlineReleaseDir(installDir)} (drop a morphit-<ver>-offline.tar.gz + its .asc there, ` +
						`or use --from-file=PATH).\n  ` + fetchErrors.join('\n  ')
				);
				return 5;
			}
		} else if (primaryRelease === null) {
			warn(`Primary (${host}/${repo}) unreachable; using mirror for discovery. A valid release signature will be REQUIRED to install.`);
		}
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
	// A hidden-only node fetches the tarball over Tor/I2P, so `latest.body` (the
	// Forgejo release body) is empty — morphitlat's operator saw a blank "Release
	// notes:" heading and upgraded blind. The tarball itself ships RELEASE-NOTES.md,
	// so read it from there when the body is empty: same bytes the SHA-256 already
	// covers, no clearnet, nothing new to trust.
	let notesBody = latest.body.trim();
	if (notesBody === '' && offline?.tarballPath) {
		try {
			const r = spawnSync(
				'tar',
				['-xzOf', offline.tarballPath, '--wildcards', '*/RELEASE-NOTES.md'],
				{ encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
			);
			if (r.status === 0 && typeof r.stdout === 'string') notesBody = r.stdout.trim();
		} catch {
			/* notes are a courtesy; never block an upgrade on them */
		}
	}
	if (notesBody === '') notesBody = '(no release notes available for this source)';
	info('Release notes:');
	for (const line of notesBody.split('\n')) {
		// cp139-C-19: defense-in-depth.  latest.body is the release
		// body fetched from Forgejo — upstream-trusted content but
		// not source-controlled review-gated (a compromised release-
		// publishing account could plant terminal escapes here).
		// Sanitize before display.
		console.log(`  ${sanitizeForTerm(line)}`);
	}
	console.log('');

	if (checkOnly) {
		// Exit 1 to make it scriptable: cron + sidecars can
		// react to a non-zero return code from --check-only as
		// "a newer release exists".
		return 1;
	}

	// ─── 3. Locate assets on the chosen release ─────────────────
	const chosenAssets = selectReleaseAssets(latest.assets);
	if (!chosenAssets) {
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
				`This will: backup ${installDir}, extract new tarball, run npm ci, rebuild + redeploy the web frontend (and verify it's actually being served), restart services.\n` +
				`Set MORPHIT_AUTO_UPGRADE=1 to skip this prompt in future runs.`
		);
		if (!ok) {
			info('Upgrade declined.');
			return 2;
		}
	}

	// ─── 5. Obtain the tarball + verify (mirror-aware, integrity-anchored) ─
	const tmpDir = mkTempDir();
	let expectedHash: string | null = null;
	let expectedHashFromChain = false;
	const tarballPath = join(tmpDir, chosenAssets.tarball.name);
	let bytesFromPrimary = false;
	let bytesSource: ReleaseSource | null = null;
	let sigPath: string | null = null;

	if (offline !== null) {
		// OFFLINE: copy the local tarball (+ its sibling .asc, if present) into the
		// scratch dir so verify/extract/cleanup are byte-identical to the online
		// path. No network is touched: expectedHash stays null, so decideTrust()
		// below REQUIRES a verified GPG signature — an unsigned offline tarball is
		// refused, exactly like an unsigned release when the primary is unreachable.
		try {
			copyFileSync(offline.tarballPath, tarballPath);
			if (offline.sigPath !== null) {
				sigPath = `${tarballPath}.asc`;
				copyFileSync(offline.sigPath, sigPath);
			}
		} catch (err) {
			printError(`Could not read the local tarball: ${err instanceof Error ? err.message : String(err)}`);
			cleanupTmp(tmpDir);
			return 5;
		}
		// A non-null bytesSource just satisfies the "did we get bytes?" guard below;
		// it is never used as a network source offline.
		bytesSource = { host: 'local-file', repo: offline.tarballPath, isPrimary: false };
		info(`Using local offline tarball (${chosenAssets.tarball.name}); no network required.`);
		// v1.16.9 — a hidden / air-gapped node has a TRUSTED anchor even with NO
		// .asc: the release SHA-256 that @morphit published ON-CHAIN via its signed
		// release broadcast, which the LOCAL indexer serves at /v1/release over the
		// node's own (possibly hidden) RPC — zero clearnet. If the offline tarball's
		// hash matches that, we trust it with no hand-signing. `offline_sha256`
		// anchors the self-contained `-offline` bundle; `source_sha256` the standard
		// tarball. (A valid .asc, if present, still wins in decideTrust below.)
		if (offline.sigPath === null) {
			const wantOffline = /-offline\.tar\.gz$/.test(offline.tarballPath);
			const onchainSha = await readOnchainReleaseSha(latestTag, wantOffline);
			if (onchainSha) {
				expectedHash = onchainSha;
				expectedHashFromChain = true;
				info('  Verifying against the release SHA-256 published on-chain (read from your local indexer).');
			}
		}
	} else {
		// 5a. Trust anchor: the SHA-256 always comes from the PRIMARY.
		if (primaryRelease) {
			const primaryAssets = selectReleaseAssets(primaryRelease.assets);
			if (primaryAssets) {
				const primaryShaPath = join(tmpDir, 'primary.tar.gz.sha256');
				try {
					await downloadTo(primaryAssets.sha.browser_download_url, primaryShaPath);
					expectedHash = parseShaFile(primaryShaPath);
				} catch (err) {
					warn(`Could not fetch the SHA-256 from the primary: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		// 5b. Download the tarball BYTES — primary first, then mirrors.
		const dlErrors: string[] = [];
		for (const { src, rel } of releasesBySource) {
			const a = selectReleaseAssets(rel.assets);
			if (!a) continue;
			try {
				info(`Downloading ${a.tarball.name} from ${src.host}${src.isPrimary ? ' (primary)' : ' (mirror)'}...`);
				await withSpinner(
					`Downloading the release from ${src.host}…`,
					() => downloadTo(a.tarball.browser_download_url, tarballPath)
				);
				bytesFromPrimary = src.isPrimary;
				bytesSource = src;
				// Pull the detached signature from the SAME source, if present.
				if (a.sig) {
					sigPath = join(tmpDir, a.sig.name);
					try {
						await downloadTo(a.sig.browser_download_url, sigPath);
					} catch {
						sigPath = null; // signature optional; trust logic handles absence
					}
				}
				break;
			} catch (err) {
				dlErrors.push(`${src.host}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (bytesSource === null) {
			printError(`Could not download the release tarball from any source.\n  ${dlErrors.join('\n  ')}`);
			cleanupTmp(tmpDir);
			return 5;
		}
	}

	// ─── 6. Verify integrity + decide trust ─────────────────────
	const sigVerified = sigPath !== null && verifyDetachedSignature(installDir, tarballPath, sigPath);
	const actualHash = computeSha256(tarballPath);
	const hashMatched = expectedHash !== null && expectedHash === actualHash;
	if (expectedHash !== null && !hashMatched && !sigVerified) {
		printError(
			`SHA-256 mismatch on downloaded tarball.\n` +
				`  Expected (from primary): ${expectedHash}\n` +
				`  Actual:                  ${actualHash}\n` +
				`Refusing to proceed.  The tarball was tampered with in transit, or the SHA file is stale.`
		);
		cleanupTmp(tmpDir);
		return 5;
	}
	const trust =
		hiddenResolution !== null
			? {
					allowed: true,
					proof: 'hidden-federation-onchain-sha256',
					reason: `Fetched over Tor/I2P from ${hiddenResolution.servedBy} and verified against the on-chain SHA-256 for ${latestTag}.`
				}
			: decideTrust({
					bytesFromPrimary,
					sigVerified,
					hashMatched,
					hashFromPrimary: expectedHash !== null && !expectedHashFromChain,
					hashFromChain: expectedHashFromChain && hashMatched
				});
	if (!trust.allowed) {
		printError(`Cannot verify the integrity of release ${latestTag}.\n  ${trust.reason}`);
		cleanupTmp(tmpDir);
		return 5;
	}
	info(`\u2713 Integrity verified (${trust.proof}). ${trust.reason}`);


	// ─── 7. Backup current install ──────────────────────────────
	// cp685 — before we rename installDir out from under ourselves, move THIS
	// process to a stable directory. The morphit-ops launcher runs us with the
	// cwd inside the install dir; once we rename it to the backup, that cwd path
	// no longer exists, and every shell we spawn afterward (npm lifecycle
	// scripts, the MCP deploy) prints alarming "getcwd: cannot access parent
	// directories" / "getcwd() failed" errors — harmless, but they read like a
	// broken install to a new operator. Chdir to '/' (always present) so every
	// child inherits a valid cwd. The build/extract/npm steps all pass an
	// explicit cwd, so this doesn't change their behaviour.
	try {
		process.chdir('/');
	} catch {
		/* '/' is always accessible; ignore the impossible failure */
	}
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
		info(`Extracting ${chosenAssets.tarball.name} to ${installDir}...`);
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

	// ─── 8b. Carry the operator's config + keys forward ────────────
	//
	// CRITICAL (cp189): the wizard writes the operator's config and
	// signing key INSIDE the install tree —
	//   - morphit.config.env            (operator-tunable knobs)
	//   - morphit.env                   (critical infra: DB URL,
	//                                     account names, active-key path)
	//   - apps/relay/keystore.json or .wif (the relay ACTIVE key)
	//   - apps/relay/altnet (dir)        (Tor/Lokinet/I2P keys)
	//   - morphit-hardening-checklist.md  (operator runbook)
	// The release tarball does NOT contain any of these (they're the
	// operator's secrets/config, never committed).  Step 7 renamed the
	// old install to backupDir and step 8 extracted a FRESH tree, so
	// without this step the operator's config + signing key would be
	// stranded in the .bak dir and the indexer/relay would start with
	// nothing — a wrecked instance.  Copy them back, preserving the
	// 0600 perms the wizard set (copyFileSync/cpSync preserve mode).
	//
	// We only copy files that EXIST in the backup (a first-time
	// installer who somehow ran upgrade wouldn't have them) and never
	// overwrite a file the new tree legitimately ships (these paths are
	// all operator-data paths the tree never contains, so no conflict).
	try {
		const preserve: Array<{ rel: string; kind: 'file' | 'dir' }> = [
			{ rel: 'morphit.config.env', kind: 'file' },
			{ rel: 'morphit.env', kind: 'file' },
			{ rel: 'apps/relay/keystore.json', kind: 'file' },
			{ rel: 'apps/relay/keystore.wif', kind: 'file' },
			{ rel: 'apps/relay/altnet', kind: 'dir' },
			{ rel: 'morphit-hardening-checklist.md', kind: 'file' }
		];
		let carried = 0;
		for (const item of preserve) {
			const from = join(backupDir, item.rel);
			const to = join(installDir, item.rel);
			if (!existsSync(from)) continue;
			mkdirSync(dirname(to), { recursive: true });
			if (item.kind === 'dir') {
				cpSync(from, to, { recursive: true, preserveTimestamps: true });
			} else {
				copyFileSync(from, to);
			}
			carried++;
		}
		if (carried > 0) {
			info(`Carried ${carried} config/key file(s) forward from the previous install.`);
		} else {
			// No config in the backup is suspicious for an upgrade (vs a
			// first install) — warn but don't fail; the operator may have
			// a non-standard layout (e.g. systemd EnvironmentFile= pointing
			// outside the tree).
			warn(
				'No config/keystore files found in the previous install to carry forward. ' +
					'If your instance keeps its config inside the install dir, verify ' +
					`${installDir} has morphit.config.env, morphit.env, and apps/relay/keystore.* ` +
					'before restarting services.'
			);
		}
	} catch (err) {
		warn('Failed to carry config/keys forward; rolling back.');
		return rollback(installDir, backupDir, tmpDir, err);
	}

	// cp217 — detect whether this upgrade crossed an indexer schema.sql
	// change. Both the old tree (now backupDir) and the new tree are on disk
	// at this point. If the baseline changed, an existing DB won't pick up
	// the in-place schema edits on its own, so we remind the operator at the
	// end to reset + re-sync the (chain-derived) indexer DB.
	// Only warn when the schema moved WITHOUT a migration to carry it — a
	// numbered migration is applied automatically at indexer start-up, so
	// warning then is a false alarm that invites an unnecessary DB reset.
	const schemaChanged = schemaChangedWithoutMigration(backupDir, installDir);

	// ─── 9. Install workspace dependencies ─────────────────────
	try {
		// A self-contained OFFLINE tarball ships a prebuilt node_modules carrying
		// the .morphit-bundle-complete marker — the same marker the Ansible install
		// checks. When present, npm ci (the one step that would reach the registry)
		// is SKIPPED so an offline `morphit-ops upgrade` completes cable-unplugged.
		// An ordinary online tarball has no marker → npm ci runs as before.
		const bundleMarker = join(installDir, 'node_modules', '.morphit-bundle-complete');
		if (existsSync(bundleMarker)) {
			info('Offline bundle detected (prebuilt node_modules) — skipping npm ci; no registry needed.');
		} else {
			const ciCode = await runStepWithSpinner(
				'Installing dependencies (npm ci) — this can take a minute…',
				'npm',
				['ci', '--no-audit', '--no-fund'],
				{ cwd: installDir }
			);
			if (ciCode !== 0) throw new Error(`npm ci exited ${ciCode}`);
		}
	} catch (err) {
		warn('npm ci failed; rolling back.');
		return rollback(installDir, backupDir, tmpDir, err);
	}

	// ─── 9b. Rebuild the static web frontend (ALWAYS, cp236) ───
	//
	// The Node services (indexer/relay/matrix-bot) run from TS source via
	// tsx — no build step — so `npm ci` above is all they need. The WEB app
	// is different: it's a static SvelteKit build (`vite build` → apps/web/
	// build), and the release tarball does NOT ship a prebuilt build. That
	// build output is what BOTH deployment models serve: bare-metal nginx
	// copies it into <webRoot>, and a containerized frontend (BunkerWeb or a
	// custom stack) bind-mounts it from <install>/apps/web/build. So the
	// build must ALWAYS run — regardless of whether <webRoot> exists.
	//
	// (Before cp236 the build lived inside an `if (webRoot exists)` branch,
	// so on a container-served host — where the site is NOT served from
	// /var/www/morphit-frontend — the upgrade silently skipped the frontend
	// rebuild, reported success, and the container kept serving the OLD
	// build. That regression is what this unconditional build + the
	// publish plan below fix.)
	//
	// cp619 (the maintainer — canary) / cp624 fix — capture who should own apps/web/build so
	// we can restore it AFTER the rebuild. `npm run build` runs as root (sudo
	// morphit-ops) and vite RECREATES this dir root-owned — but it is ALSO the dir
	// the operator's (non-root) warrant-canary refresh uploads canary.txt +
	// pgp_keys.asc into over SSH, and the bind-mount frontend model serves straight
	// from it. Without restoring the owner afterward, every upgrade re-roots the
	// served dir and the next weekly canary upload fails with EACCES.
	//
	// cp624: read the owner from the OLD install (backupDir), NOT the fresh tree.
	// Step 7 renamed the operator's install — with their chowned, non-root build/ —
	// to backupDir, and step 8 extracted a FRESH root-owned tree that has NO build/
	// yet. Reading installDir here therefore always saw root (or an absent build/)
	// and preserved NOTHING, so a root-owned /opt/morphit install still hit EACCES.
	// The operator's real ownership lives in backupDir. Prefer the non-root owner on
	// the OLD build/, else the OLD install-dir owner. -1 => none found → leave it
	// root (the operator sets ownership themselves once).
	let canaryDirUid = -1;
	let canaryDirGid = -1;
	{
		const oldBuild = join(backupDir, 'apps', 'web', 'build');
		const readOwner = (p: string): { uid: number; gid: number } | null => {
			try {
				const s = statSync(p);
				return { uid: s.uid, gid: s.gid };
			} catch {
				return null;
			}
		};
		const owner = chooseCanaryDirOwner(readOwner(oldBuild), readOwner(backupDir));
		if (owner) {
			canaryDirUid = owner.uid;
			canaryDirGid = owner.gid;
		}
	}
	try {
		// Prefer the CANONICAL prebuilt frontend shipped in the release tarball:
		// deploying @morphit's exact bytes is what lets a federated operator pass
		// the on-chain build-integrity check (a local rebuild isn't byte-reproducible
		// and trips the tamper banner). Only rebuild if the prebuilt is absent — an
		// older tarball, or a source checkout — so nothing regresses.
		const shippedBuild = join(installDir, 'apps', 'web', 'build', 'index.html');
		if (existsSync(shippedBuild)) {
			info('Using the prebuilt web frontend shipped in the release (no rebuild).');
		} else {
			info('No prebuilt frontend in this release — building the web frontend (apps/web)...');
			runOrThrow('npm', ['run', 'build'], { cwd: join(installDir, 'apps', 'web') });
		}
	} catch (err) {
		// Nothing served has been touched yet (the build writes to
		// apps/web/build inside the install), so a build failure rolls back
		// cleanly.
		warn('Frontend build failed; rolling back.');
		return rollback(installDir, backupDir, tmpDir, err);
	}

	// ─── 9b1. Restore served-dir ownership + auto-restore the canary (cp619/cp622) ──
	//
	// The rebuild re-rooted apps/web/build (and static/) and WIPED build/canary.txt
	// (it's written in AFTER the vite build, so a rebuild always drops it). Two
	// moves, both best-effort — the build already succeeded, so nothing here rolls
	// it back:
	//   1. Hand build/ AND static/ back to the non-root canary owner. The refresh
	//      writes static/canary.txt (generate.sh) then copies it into build/, so it
	//      needs BOTH writable; without this every upgrade re-roots them and the
	//      next canary upload/refresh fails with EACCES ("Permission denied").
	//   2. cp622: if this is a SAME-BOX operator (they sign HERE — their
	//      ~/.morphit/update-canary.sh exists), run that refresh AS them right now to
	//      put the canary straight back, no manual step. Placed BEFORE step 9c so the
	//      restored canary.txt is included when 9c copies build/ into a web root.
	//      REMOTE operators sign on a separate laptop → no refresh script here → this
	//      skips and the reminder near the end fires instead. Guarded: non-interactive
	//      + 90s timeout + no controlling tty, so a passphrase-protected key can never
	//      hang the upgrade; any failure falls through to the reminder.
	let canaryAutoRefreshed = false;
	if (canaryDirUid >= 0) {
		const webBuild = join(installDir, 'apps', 'web', 'build');
		const webStatic = join(installDir, 'apps', 'web', 'static');
		// Run BOTH chowns (no short-circuit) so static/ is fixed even if build/ fails.
		let chownOk = true;
		for (const dir of [webBuild, webStatic]) {
			if (spawnSync('chown', ['-R', `${canaryDirUid}:${canaryDirGid}`, dir], { stdio: 'ignore' }).status !== 0) {
				chownOk = false;
			}
		}
		if (chownOk) {
			info(
				`\u2713 Restored ${webBuild} ownership so your warrant-canary upload keeps ` +
					`working across upgrades.`
			);
		} else {
			warn(
				`Could not restore ownership of ${webBuild}. If your weekly warrant-canary ` +
					`upload later fails with "Permission denied", run once on this box: ` +
					`sudo chown -R <your-ssh-user> ${webBuild}`
			);
		}

		// cp622 / cp754 — same-box auto-restore. Two mechanisms, tried in order:
		//   1. Trigger the canary's OWN systemd service (morphit-canary.service) —
		//      the exact unit the weekly morphit-canary.timer fires. Path-agnostic:
		//      it re-lays the canary via whatever refresh the install configured,
		//      wherever that script lives, so it covers Ansible / appliance installs
		//      (a system morphit-canary.service, MORPHIT_CANARY_REFRESH empty, and no
		//      ~/.morphit/update-canary.sh — the shape a real morphitlat box showed)
		//      that mechanism #2 could never find. The upgrade runs as root so a
		//      system-scope start works; the unit is oneshot, so start BLOCKS until
		//      the refresh finishes (or the 180s timeout trips — the refresh fetches
		//      chain-head + a price + a headline, possibly over Tor, then signs).
		//   2. Fall back to the interactive-setup home-dir refresh script, run AS the
		//      non-root owner (the original cp622 path — an operator who ran
		//      scripts/canary/setup.sh by hand as themselves, so their refresh lives
		//      in their own ~/.morphit and no system unit exists).
		// Either restores the canary immediately with no manual step; if BOTH miss,
		// the reminder near the end fires (and the weekly timer republishes on its
		// own regardless, well before the 14-day staleness window).
		// Auto-restore the canary if one is SET UP on this box — not merely if the
		// backup still held canary.txt. A prior upgrade can wipe the served file
		// before the weekly timer re-publishes, so gating on the backup file skipped
		// same-machine operators whose canary was mid-cycle (the maintainer: timeapp — the
		// upgrade broke his same-machine canary and didn't renew it). Detect the
		// setup two independent ways: the systemd unit, or the owner's refresh
		// script — and if EITHER exists, restore now regardless of the backup file.
		const hadCanaryFile = existsSync(join(backupDir, 'apps', 'web', 'build', 'canary.txt'));
		const haveCanaryUnit =
			spawnSync('systemctl', ['cat', 'morphit-canary.service'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
		const pw = spawnSync('getent', ['passwd', String(canaryDirUid)], { encoding: 'utf8' });
		const refreshTarget =
			pw.status === 0 && typeof pw.stdout === 'string' ? parsePasswdRefreshTarget(pw.stdout) : null;
		const haveRefreshScript = refreshTarget !== null && existsSync(refreshTarget.refreshScript);
		if (hadCanaryFile || haveCanaryUnit || haveRefreshScript) {
			if (haveCanaryUnit) {
				info('');
				info('Restoring your warrant canary automatically (running its scheduled refresh now)...');
				const start = spawnSync('systemctl', ['start', 'morphit-canary.service'], {
					stdio: 'ignore',
					timeout: 180_000
				});
				if (start.status === 0) {
					canaryAutoRefreshed = true;
					info('\u2713 Warrant canary restored automatically — nothing to do.');
				} else {
					info("(Couldn't trigger the canary service automatically; see the note below.)");
				}
			}
			if (!canaryAutoRefreshed && refreshTarget && haveRefreshScript) {
				info('');
				info(`Restoring your warrant canary automatically (running your refresh as ${refreshTarget.user})...`);
				const refresh = spawnSync('sudo', ['-n', '-u', refreshTarget.user, '-H', 'bash', refreshTarget.refreshScript], {
					stdio: 'ignore',
					timeout: 90_000,
					env: { ...process.env, GPG_TTY: '' }
				});
				if (refresh.status === 0) {
					canaryAutoRefreshed = true;
					info('\u2713 Warrant canary restored automatically — nothing to do.');
				} else {
					info("(Couldn't refresh the canary automatically; restore it manually — see below.)");
				}
			}
		}
	}

	// ─── 9b2. Rebuild the dist-shipping workspaces (cp296) ─────
	//
	// Unlike the indexer/relay/matrix-bot (pure tsx-from-source), TWO
	// workspaces EXECUTE from a compiled `dist/` bundle, and `dist/` is
	// gitignored + NOT shipped in the tarball:
	//   • morphit-mcp — its `bin` points straight at `dist/main.js`.
	//   • morphit-ops — its bin launcher PREFERS `dist/main.js` when
	//     present (falling back to tsx source otherwise).
	// `npm ci` builds neither, so before this step an upgrade left the
	// OLD-version dist on disk: the MCP server ran stale code, and
	// `morphit-ops` itself preferred its own stale bundle over the
	// freshly-extracted source. Rebuild both now so each runs the new
	// version. NON-FATAL: nothing served has changed, the ops launcher
	// self-heals by falling back to source if its bundle is missing, so
	// we warn loudly rather than roll back an already-built frontend.
	for (const wsDir of ['ops-cli', 'mcp-server'] as const) {
		try {
			info(`Rebuilding the ${wsDir} dist bundle...`);
			runOrThrow('npm', ['run', 'build'], { cwd: join(installDir, 'apps', wsDir) });
		} catch {
			warn(
				wsDir === 'ops-cli'
					? `Could not rebuild morphit-ops's dist bundle. It will fall back to running ` +
							`its TypeScript source via tsx (correct, just not precompiled). Run ` +
							`\`npm run build\` in ${join(installDir, 'apps', wsDir)} to restore the fast path.`
					: `Could not rebuild the MCP server's dist bundle. \`morphit-mcp\` may run stale ` +
							`code until you run \`npm run build\` in ${join(installDir, 'apps', wsDir)} by hand.`
			);
		}
	}

	// ─── 9c. Publish the freshly-built frontend ────────────────
	//
	// Decide how to publish from two signals:
	//   • bare-metal nginx → <webRoot> exists → copy build/ into it.
	//   • containerized → a RUNNING container bind-mounts the build dir →
	//     `docker restart` it so it re-binds the new build (a running
	//     container keeps serving the pre-upgrade inode after the install
	//     dir was renamed above).  beta11: the container is identified by
	//     its apps/web/build mount, NOT by a name or compose file — cp236's
	//     `morphit-frontend`-name + repo-example-compose assumptions broke on
	//     real deployments (a compose project names it `<proj>-frontend-1`,
	//     and recreating it from the repo's example compose crash-looped on a
	//     cert path the operator's real stack didn't share).
	// Both may apply (do both); neither is a non-standard setup that earns a
	// loud warning — the build is fresh on disk either way.
	const buildDir = join(installDir, 'apps', 'web', 'build');
	const plan = planFrontendDeploy({
		webRootExists: existsSync(webRoot),
		frontendContainer: findFrontendContainer(buildDir),
		webRoot,
		buildDir
	});

	let webRootBackup: string | null = null;
	// Stamp THIS operator's tag into the served verify.json from the on-disk config
	// BEFORE either deploy path. The PREBUILT frontend ships operator_tag=null, and
	// BOTH deployment models serve THIS file: bare-metal copies buildDir → webRoot,
	// and the containerized frontend bind-mounts buildDir directly. Previously the
	// stamp lived ONLY inside the copyToWebRoot branch, so every CONTAINERIZED
	// instance (BunkerWeb/custom bind-mount) served operator_tag=null despite a
	// correct config + on-chain registration (the maintainer/morphitir v1.17.0). operator_tag
	// here is INFORMATIONAL (matches /v1/instance + the directory); fee attribution
	// comes from the runtime indexer config and is unaffected either way.
	try {
		const opTag = readOperatorTagFromConfig();
		if (opTag && patchVerifyJsonOperatorTag(buildDir, opTag)) {
			info(`Stamped operator_tag "${sanitizeForTerm(opTag)}" into verify.json.`);
		}
	} catch {
		/* non-fatal — verify.json's operator_tag is informational */
	}
	if (plan.copyToWebRoot) {
		try {
			// Snapshot the current web root so a deploy failure (or a later
			// step's rollback) can restore the previous site.
			webRootBackup = join(tmpDir, 'web-root-backup');
			cpSync(webRoot, webRootBackup, { recursive: true });
			info(`Redeploying ${buildDir} → ${webRoot}...`);
			deployFrontendBuild(buildDir, webRoot);
			// Preserve the operator's web-root ownership (www-data, or whatever
			// the web server runs as) so the freshly-copied files stay readable.
			// Best-effort: vite output is world-readable anyway.
			try {
				const st = statSync(webRoot);
				spawnSync('chown', ['-R', `${st.uid}:${st.gid}`, webRoot], { stdio: 'ignore' });
			} catch {
				// non-fatal
			}
			info(`\u2713 Web frontend redeployed to ${webRoot}.`);
		} catch (err) {
			warn('Frontend redeploy failed; rolling back.');
			return rollback(installDir, backupDir, tmpDir, err, { webRoot, webRootBackup });
		}
	}
	if (plan.restartContainer) {
		// Best-effort: the backend already upgraded and the build is fresh, so
		// a docker hiccup must NOT roll the whole upgrade back.
		restartFrontendContainer(plan.restartContainer, installDir);
	}
	if (plan.warn) {
		warn(plan.warn);
	}

	// ─── 9d. Verify the new frontend is actually being SERVED (beta14) ──
	//
	// Confirms the just-built service worker is what the live frontend
	// serves.  When it isn't, the "Load it now" update prompt never fires
	// for users (the recurring symptom) — so say so loudly with the
	// specific fix, instead of reporting a silent success.  Best-effort:
	// never fails the upgrade.
	if (plan.copyToWebRoot || plan.restartContainer) {
		try {
			const builtVersion = readBuiltVersion(buildDir);
			// cp688 — the container was JUST restarted; give it a moment to come
			// back up before deciding we can't verify. Without this, the check
			// almost always runs before the web server is serving again and prints
			// "Could not auto-verify the served frontend", which looks like a
			// failure on an upgrade that actually worked. Retry a few times.
			let servedVersion = await resolveServedVersion(plan, webRoot);
			for (let attempt = 0; servedVersion === null && attempt < 5; attempt++) {
				await new Promise((r) => setTimeout(r, 2000));
				servedVersion = await resolveServedVersion(plan, webRoot);
			}
			const verdict = classifyFrontendVerify(builtVersion, servedVersion);
			if (verdict === 'fresh') {
				info(
					`\u2713 Verified the live frontend is serving this build ` +
						`(version ${builtVersion}). Returning visitors get the ` +
						`"Load it now" update prompt within ~60s.`
				);
			} else if (verdict === 'stale') {
				// Actively self-heal before giving up. The usual cause is a running
				// container still bound to the PRE-upgrade build inode (the install
				// dir was renamed to .bak under it). A restart re-binds it to the
				// freshly-extracted build. Try it, re-verify, and only warn (with the
				// manual command) if it is STILL stale — never fail the upgrade.
				let healed = false;
				if (plan.restartContainer) {
					info(
						`The served frontend is still the old build (${servedVersion}); ` +
							`restarting "${plan.restartContainer}" so it re-binds the new build...`
					);
					spawnSync('docker', ['restart', plan.restartContainer], {
						stdio: 'inherit',
						timeout: 60_000
					});
					let reServed = await resolveServedVersion(plan, webRoot);
					for (let attempt = 0; reServed === null && attempt < 5; attempt++) {
						await new Promise((r) => setTimeout(r, 2000));
						reServed = await resolveServedVersion(plan, webRoot);
					}
					if (classifyFrontendVerify(builtVersion, reServed) === 'fresh') {
						healed = true;
						info(
							`\u2713 Verified the live frontend is serving this build ` +
								`(version ${builtVersion}) after a restart. Returning visitors ` +
								`get the "Load it now" prompt within ~60s.`
						);
					}
				}
				if (!healed) {
					warn(
						`The frontend being SERVED is still the old build (version ` +
							`${servedVersion}); this upgrade built ${builtVersion}. The ` +
							`"Load it now" update prompt will NOT appear until the served ` +
							`build matches. ` +
							(plan.restartContainer
								? `Your frontend container "${plan.restartContainer}" is serving ` +
									`a stale copy even after a restart: if it BAKES the build into ` +
									`its image, rebuild that image; otherwise confirm it bind-mounts ` +
									`${buildDir} and is not caching /verify.json.`
								: `Check that ${webRoot} received the new build and that your ` +
									`web server is not caching /verify.json or /service-worker.js.`)
					);
				}
			}
			// verdict === 'unknown': the box couldn't read its own served
			// /verify.json (e.g. a Tor-only node, or a home box whose NAT won't
			// hairpin its own public URL). The upgrade itself already reported
			// success, and "unknown" is not evidence of a problem — so stay
			// SILENT rather than printing a "Could not auto-verify …" line that
			// reads like a failure on an upgrade that worked (v1.11.1).
		} catch {
			// verification is best-effort; never fail the upgrade over it
		}
	}

	// ─── 9d-bis. Offer a warrant canary when the footer link would 404 (v1.17.1) ──
	//
	// The site footer UNCONDITIONALLY links /canary.txt. If this box serves no
	// canary AND has no way to make one, that link is a permanent 404 — bad for
	// visitors and terrible for SEO (the maintainer/morphitir: registered, upgraded, but the
	// footer canary link was dead). Offer a turnkey SAME-BOX setup: it generates a
	// signing key, signs the first canary, and schedules the weekly refresh — the
	// admin says "yes" once and accepts a couple of pre-filled defaults, nothing
	// more. Skip SILENTLY when:
	//   • non-interactive (cron / MORPHIT_AUTO_UPGRADE) — can't prompt,
	//   • a canary is already served (link works),
	//   • an on-box morphit-canary.service exists (it'll refresh on its own), or
	//   • the box WAS serving a canary before this upgrade — that's a REMOTE
	//     (laptop-signed) operator whose next refresh re-uploads canary.txt; setting
	//     up a second, on-box canary would fight their real one.
	try {
		const canaryBuildDir = join(installDir, 'apps', 'web', 'build');
		const servedCanary = existsSync(join(canaryBuildDir, 'canary.txt'));
		const backupHadCanary = existsSync(join(backupDir, 'apps', 'web', 'build', 'canary.txt'));
		const haveCanaryUnit =
			spawnSync('systemctl', ['cat', 'morphit-canary.service'], {
				stdio: 'ignore',
				timeout: 10_000
			}).status === 0;

		// A REMOTE (laptop-signed) operator must be remembered PERMANENTLY.
		//
		// The backup check alone is too fragile: it only remembers one upgrade back.
		// An operator who signs off-box re-uploads canary.txt after each upgrade, so
		// missing ONE refresh — because the previous upgrade errored, say — made the
		// next one conclude the box had never had a canary and offer to set up a
		// second, on-box one that would fight their real key. That happened, and the
		// prompt stopped an unattended upgrade dead waiting for an answer.
		//
		// So: the first time a canary is seen, write a marker and never ask again.
		const canaryMarker = '/var/lib/morphit/canary-seen';
		if (servedCanary || backupHadCanary) {
			try {
				mkdirSync(dirname(canaryMarker), { recursive: true });
				writeFileSync(canaryMarker, `seen ${new Date().toISOString()}\n`);
			} catch {
				/* best-effort; the checks below still work without it */
			}
		}
		const everHadCanary = existsSync(canaryMarker);

		// And ask the LIVE SITE, which is what the footer link actually hits. The
		// build dir is only one way a canary can be served.
		let liveCanary = false;
		try {
			// Local reader: the shared one is defined further down, out of scope here.
			// Both config files are checked — settings live in either, depending on
			// how the instance was installed.
			const readCfgKey = (key: string): string => {
				for (const f of [
					join(installDir, 'morphit.config.env'),
					join(installDir, 'morphit.env')
				]) {
					if (!existsSync(f)) continue;
					const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+)$`, 'm').exec(
						readFileSync(f, 'utf8')
					);
					if (m) return m[1]!.trim().replace(/^["']|["']$/g, '');
				}
				return '';
			};
			const origin = readCfgKey('MORPHIT_INSTANCE_ORIGIN');
			if (origin !== '') {
				const host = origin.replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
				liveCanary =
					spawnSync(
						'sh',
						[
							'-c',
							`curl -fsS -o /dev/null --max-time 15 -k --resolve ${host}:443:127.0.0.1 ` +
								`https://${host}/canary.txt`
						],
						{ stdio: 'ignore', timeout: 20_000 }
					).status === 0;
			}
		} catch {
			/* a failed probe must never cause a prompt on its own */
		}

		const deadFooterLink =
			!servedCanary && !backupHadCanary && !haveCanaryUnit && !everHadCanary && !liveCanary;
		if (deadFooterLink && !forceYes && process.stdin.isTTY === true) {
			info('');
			const wantsCanary = await promptYes(
				`Your site footer links to a warrant canary, but this box has none set up, ` +
					`so that link is a dead 404 (bad for visitors and SEO). A warrant canary is a ` +
					`signed, auto-refreshed notice that you've received no secret legal orders — a ` +
					`strong trust signal for a no-KYC marketplace.\n` +
					`Set one up now, right here on this box? It's automatic — I generate a signing ` +
					`key, sign the first canary, and schedule the weekly refresh (a couple of ` +
					`Enter-to-accept defaults, nothing to look up).`
			);
			if (wantsCanary) {
				const setupScript = join(installDir, 'scripts', 'canary', 'setup.sh');
				const tag = readOperatorTagFromConfig() ?? 'morphit';
				let host = '';
				try {
					const origin = readInstanceEnvValue(INSTANCE_ENV.ORIGIN);
					if (origin) host = new URL(origin).hostname;
				} catch {
					/* Tor-only or unset origin — fall back to the tag below */
				}
				const email = `canary@${host || `${tag}.local`}`;
				const res = spawnSync('bash', [setupScript], {
					stdio: 'inherit',
					timeout: 600_000,
					env: {
						...process.env,
						MORPHIT_CANARY_MODE: 'local',
						MORPHIT_CANARY_SERVE_DIR: canaryBuildDir,
						MORPHIT_CANARY_OPERATOR_NAME: tag,
						MORPHIT_CANARY_OPERATOR_EMAIL: email
					}
				});
				if (res.status === 0) {
					info('\u2713 Warrant canary set up and scheduled — the footer link now resolves.');
				} else {
					warn(
						`Canary setup didn't finish; you can run it anytime: sudo bash ${setupScript}`
					);
				}
			} else {
				info(
					`No problem — skipping the canary. Set it up anytime with: ` +
						`sudo bash ${join(installDir, 'scripts', 'canary', 'setup.sh')}`
				);
			}
		}
	} catch {
		// best-effort — the canary offer must NEVER fail or hang the upgrade
	}

	// ─── 9e. Refresh systemd unit files from the new templates ──
	// The units in ops/systemd/ are STATIC files an operator copies to
	// /etc/systemd/system/ once at init; this upgrade just extracted fresh
	// copies into installDir.  Bring the INSTALLED units up to date so a
	// unit fix (e.g. an added RestrictAddressFamilies=AF_UNIX, without
	// which a tsx-run service crash-loops on EAFNOSUPPORT) reaches an
	// already-installed box — historically upgrade only restarted services
	// and never refreshed the unit files, so such fixes never landed.
	// Best-effort: never fails the upgrade.  Drop-ins (<unit>.d/) are
	// untouched; a changed unit is backed up to <unit>.bak first.  The
	// daemon-reload here means the restart step below picks up the new
	// units; refreshed timer/monitor units take effect on their next run.
	try {
		const { results, reloadNeeded } = refreshManagedUnits({
			templateDir: join(installDir, 'ops', 'systemd'),
			systemdDir: process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system',
			apply: true
		});
		const refreshed = results.filter((r) => r.action === 'refreshed');
		if (refreshed.length > 0) {
			for (const r of refreshed) {
				info(
					`Refreshed ${r.unit} from the new template` +
						(r.backupPath ? ` (previous saved to ${basename(r.backupPath)})` : '')
				);
			}
			if (reloadNeeded) {
				if (daemonReload()) {
					info('Reloaded systemd so the refreshed units take effect.');
				} else {
					warn('Could not run `systemctl daemon-reload`; run it by hand before restarting.');
				}
			}
		}
	} catch (err) {
		warn(
			`Could not refresh systemd unit files (continuing): ` +
				`${err instanceof Error ? err.message : String(err)}`
		);
	}

	// ─── 10. Restart services ──────────────────────────────────
	// First, self-heal the advertised Tor onion: on some boxes the onion is
	// generated after the install-time config write, leaving the config value
	// empty and the node advertising `tor: null` (unreachable over Tor — fatal
	// for a censored node). Populate it now if the onion exists but the config
	// is empty, so the indexer restart below picks it up and /v1/instance
	// advertises it. Idempotent + safe on every upgrade.
	try {
		const heal = healTorOnionInConfig(join(installDir, 'morphit.config.env'));
		if (heal.healed) {
			info(`Captured this node's Tor onion into the config so it's advertised: ${heal.onion}`);
			info('  (Re-broadcast it to the federation with:  sudo morphit-ops  → Alt addresses.)');
		}
	} catch {
		/* non-fatal — the node still works over clearnet */
	}

	// v1.16.7 — self-heal a bare-email contact URL that an older `edit → branding`
	// wrote (e.g. `you@host.tld`, no scheme). Not a valid URL, it used to fail the
	// indexer's config validation and crash-loop the node. Normalize it to
	// `mailto:` so the file is correct + re-broadcastable. (The indexer now also
	// tolerates it at runtime, but we fix the source of truth.)
	for (const cfg of ['/opt/morphit/morphit.config.env', '/etc/morphit/indexer.env']) {
		try {
			if (!existsSync(cfg)) continue;
			const txt = readFileSync(cfg, 'utf8');
			const m = txt.match(/^([ \t]*MORPHIT_INSTANCE_CONTACT_URL[ \t]*=[ \t]*)(.*)$/m);
			if (!m) continue;
			const rawVal = (m[2] ?? '').trim().replace(/^["']|["']$/g, '');
			const fixed = normalizeContactUrl(rawVal);
			if (rawVal !== '' && fixed && fixed !== rawVal) {
				writeFileSync(cfg, txt.replace(m[0], `${m[1] ?? ''}${fixed}`), 'utf8');
				info(`Repaired an invalid contact URL in ${cfg}: "${sanitizeForTerm(rawVal)}" → "${sanitizeForTerm(fixed)}"`);
			}
		} catch {
			/* non-fatal — the indexer tolerates a bad contact URL at runtime now */
		}
	}

	// v1.16.11 — run the self-heals from the JUST-INSTALLED binary, not this
	// (older) orchestrator, so a self-heal shipped in THIS release applies on THIS
	// upgrade instead of one release later. The new ops-cli dist was rebuilt above,
	// so re-exec it for a dedicated self-heal phase. If that binary is too old to
	// know the hidden subcommand (or the re-exec fails), fall back to running the
	// heals in-process — the upgrade must never fail over self-healing.
	//   Heals (see their definitions): healBunkerWebWaf() — the BunkerWeb WAF
	//   (413/403 on /v1/ + /relay/); healIpfsGatewayExposure() — expose the Kubo
	//   gateway over Tor/I2P (NoFetch-safe) so every instance is a seeder.
	let selfHealReexeced = false;
	try {
		const newCli = join(installDir, 'apps', 'ops-cli', 'dist', 'main.js');
		if (existsSync(newCli)) {
			const r = spawnSync(process.execPath, [newCli, '__post-upgrade-selfheal'], {
				stdio: 'inherit',
				timeout: 300_000
			});
			selfHealReexeced = r.status === 0;
		}
	} catch {
		/* fall back to in-process below */
	}
	if (!selfHealReexeced) {
		healBunkerWebWaf();
		healIpfsGatewayExposure();
		healFrontendConfig();
	}

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
			return rollback(installDir, backupDir, tmpDir, err, { webRoot, webRootBackup });
		}
	}

	// ─── 10b. Redeploy + restart the MCP (its own vendored tree) ──
	// The MCP runs from a SELF-CONTAINED tree at /opt/morphit-mcp, separate
	// from the /opt/morphit install dir swapped above, so it does NOT pick
	// up new code from the swap — its vendored deps + source must be
	// re-deployed and the service then restarted, or morphit-mcp keeps
	// running the OLD version forever (manually running deploy-mcp.sh +
	// restart after every upgrade was the previous rough edge).  Gated on
	// the unit being installed, so boxes without the MCP are untouched.  The
	// MCP is isolated, read-only, and non-critical, so a failure here WARNS
	// rather than rolling back the whole upgrade — morphit.io is unaffected.
	const mcpUnitPath = join(
		process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system',
		'morphit-mcp.service'
	);
	if (existsSync(mcpUnitPath)) {
		const mcpDest = process.env.MORPHIT_MCP_DEPLOY_DIR ?? '/opt/morphit-mcp';
		const mcpUser = process.env.MORPHIT_MCP_DEPLOY_USER ?? 'morphit-mcp';
		const deployScript = join(installDir, 'ops', 'scripts', 'deploy-mcp.sh');
		const mcpWasActive =
			spawnSync('systemctl', ['is-active', '--quiet', 'morphit-mcp.service']).status === 0;
		info('Redeploying the MCP server (vendored tree) for the new version...');
		const depCode = await runStepWithSpinner(
			'Redeploying the MCP server…',
			'bash',
			[deployScript, installDir, mcpDest, mcpUser]
		);
		const dep = { status: depCode };
		if (dep.status !== 0) {
			warn(
				`MCP redeploy failed (deploy-mcp.sh exit ${dep.status ?? 'signal'}); morphit-mcp ` +
					`may keep running stale code. Re-run \`sudo bash ${deployScript} ${installDir} ` +
					`${mcpDest} ${mcpUser}\` then \`sudo systemctl restart morphit-mcp\`.`
			);
		} else {
			info('Restarting morphit-mcp...');
			const rs = spawnSync('systemctl', ['restart', 'morphit-mcp.service'], {
				stdio: 'inherit'
			});
			if (rs.status !== 0) {
				warn(
					`morphit-mcp restart failed (exit ${rs.status ?? 'signal'}); the new code is ` +
						`deployed. Start it with \`sudo systemctl restart morphit-mcp\` and check ` +
						`\`journalctl -u morphit-mcp\`.`
				);
			} else {
				if (!mcpWasActive) {
					info('Started morphit-mcp (it was not previously active).');
				}
				// ─── 10b-reach. Post-restart MCP reachability probe ──
				// Confirm the freshly-restarted MCP actually bound its HTTP
				// listener. Probe the CONFIGURED LOCAL bind (read from
				// /etc/morphit/mcp.env), NOT the public site — on a BunkerWeb
				// deployment the WAF/reverse-proxy fronts the service at /mcp,
				// so the direct bind is the clean liveness signal, and the bind
				// host is often the Docker-bridge gateway (172.18.0.1), which a
				// loopback-only probe would miss. Best-effort + NON-FATAL: the
				// MCP is isolated + read-only + non-critical, so a miss WARNS
				// (with the exact place to look) rather than rolling back an
				// otherwise-good upgrade.
				const { host: mcpHost, port: mcpPort } = resolveMcpHttpBind(mcpEnvFile());
				const healthUrl = buildMcpHealthUrl(mcpHost, mcpPort);
				info(`Checking the MCP is reachable at ${mcpHost}:${mcpPort} ...`);
				const probe = await probeMcpHealth(healthUrl);
				if (probe.reachable) {
					info(`✓ MCP is up (${healthUrl} → ok).`);
				} else {
					warn(
						`MCP did not answer at ${mcpHost}:${mcpPort} (${probe.detail}). The new code ` +
							`is deployed and the service was restarted, so this is likely a transient ` +
							`startup delay or a bind mismatch — morphit.io itself is unaffected. Check ` +
							`\`journalctl -u morphit-mcp\`, confirm MORPHIT_MCP_HTTP_HOST/PORT in ` +
							`${mcpEnvFile()} points where you expect it to listen (e.g. 172.18.0.1 on a ` +
							`Docker-bridge / BunkerWeb host, 127.0.0.1 otherwise) and that a host ` +
							`process can reach that address.`
					);
				}
			}
		}
	} else {
		info('Skipping MCP redeploy (morphit-mcp.service is not installed on this host).');
	}

	// ─── 10c. Sync the matrix-bot to the configured alert username ──
	// The matrix-bot is opt-in: it only runs when a valid alert MXID is
	// configured in /etc/morphit/matrix-bot.env.  On every upgrade we
	// re-check that field and bring the service into line — enable +
	// restart it (to pick up the new code) when a username is set, or
	// disable + stop it when it isn't — so an operator who set or cleared
	// their Matrix username between upgrades lands in the right state with
	// no manual step.  Gated on the unit being installed; the bot is
	// isolated and non-critical, so a failure WARNs rather than rolling
	// back the whole upgrade (morphit.io is unaffected).
	const matrixUnitPath = join(
		process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system',
		MATRIX_BOT_UNIT
	);
	if (existsSync(matrixUnitPath)) {
		const readiness = matrixBotReadiness(readMatrixBotEnv());
		if (readiness.run) {
			info('Matrix alert username configured — enabling + restarting morphit-matrix-bot...');
			const res = syncMatrixBotService(true, { restart: true });
			if (!res.ok) {
				warn(
					'Could not enable/restart morphit-matrix-bot. Start it with ' +
						'`sudo systemctl enable --now morphit-matrix-bot` and check ' +
						'`journalctl -u morphit-matrix-bot`.'
				);
			}
		} else {
			info('No Matrix alert username configured — ensuring morphit-matrix-bot is stopped.');
			syncMatrixBotService(false, {});
		}
	} else {
		info(
			'Skipping matrix-bot lifecycle (morphit-matrix-bot.service is not installed on this host).'
		);
	}

	// ─── 10d. Confirm the chat fast-path (sub-6s delivery) state ──
	// Safeguard: a process still running with its cwd inside the OLD install
	// (now the .bak dir) is orphaned on stale code — the dir swap moved its
	// source out from under it. The new systemd units already run the new code,
	// so these are superseded duplicates (worst case: an old indexer double-
	// writing the DB). Stop them automatically — SIGTERM, a grace pause, then
	// SIGKILL any straggler — so the box is never left running a mix of old and
	// new. Only PIDs whose cwd is under backupDir are ever touched.
	// Never sweep the upgrade's OWN process chain (self, shell, sudo, launcher):
	// they share the now-.bak cwd but killing them aborts the upgrade mid-finish.
	const protectedPids = selfAndAncestorPids();
	const orphaned = pidsWithCwdUnder(backupDir).filter((pid) => !protectedPids.has(pid));
	if (orphaned.length > 0) {
		// Calm, one line — this is routine housekeeping, not an alarm. (The old
		// wording dumped raw PIDs + a paragraph of explanation every upgrade,
		// which read as scary/redundant.) The detail only appears if we CAN'T
		// stop them, which is the only case an operator needs to act on.
		info(`Superseding ${orphaned.length} stale worker process(es) from the previous version…`);
		for (const pid of orphaned) {
			try {
				process.kill(pid, 'SIGTERM');
			} catch {
				/* already exited */
			}
		}
		// Grace period for a clean shutdown, then force any straggler.
		spawnSync('sleep', ['3'], { stdio: 'ignore' });
		for (const pid of pidsWithCwdUnder(backupDir).filter((pid) => !protectedPids.has(pid))) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				/* gone */
			}
		}
		const stillThere = pidsWithCwdUnder(backupDir).filter((pid) => !protectedPids.has(pid));
		if (stillThere.length > 0) {
			warn(
				`Could not stop ${stillThere.length} leftover process(es) (PIDs ` +
					`${stillThere.join(', ')}). Stop them by hand: sudo kill -9 ${stillThere.join(' ')}`
			);
		}
	}

	// ─── 10e. Keep the DB backup Docker-aware (cp509 / v1.8.4 B) ──
	// If the operator's Postgres is containerized but their backup.env still
	// points a host pg_dump at it (DB_CONTAINER empty), the daily backup
	// silently captures nothing. Detect + warn with the one-line fix. No-op for
	// a host Postgres or an already-Docker-aware config.
	ensureBackupDockerAware(installDir);

	// ─── 11. Prune old backups (tmp is cleaned AFTER the seed below, so
	//         the seed can reuse the tarball we already downloaded) ──
	pruneOldBackups(installDir);

	info('');
	info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	info(`  ✓ Success — your Morphit server is now running ${latestTag}`);
	info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	info('');
	info(`  Congratulations! Upgraded ${currentTag} → ${latestTag}. Every service was`);
	info('  restarted and the new frontend is live — nothing else to do.');
	info(`  (Your previous install is kept at ${backupDir} — safe to delete once`);
	info('   you have confirmed everything works.)');

	if (schemaChanged) {
		info('');
		info('⚠ The database schema changed IN PLACE in this version — not via a');
		info('  numbered migration.');
		info('  An existing database will NOT pick that up on its own. Indexer data is');
		info('  rebuilt from the chain, so this is safe to fix: run `morphit-ops doctor`');
		info('  — it checks whether your DB actually drifted — and OPERATIONS.md §46 has');
		info('  the reset + re-sync steps.');
		info('  (Ordinary numbered migrations are applied automatically at indexer');
		info('   start-up and do NOT print this.)');
	}

	// cp431 — a warrant canary lives in the served build/ dir (operators sign
	// it OFF-server and upload it). build/ is rebuilt on every upgrade, so the
	// canary is now gone. If the previous install had one, remind the operator
	// to re-upload it — otherwise it silently goes stale and users get a FALSE
	// tamper warning after 14 days, through no fault of the operator.
	try {
		// cp622: skip the reminder when we already restored it automatically above.
		if (!canaryAutoRefreshed && existsSync(join(backupDir, 'apps', 'web', 'build', 'canary.txt'))) {
			info('');
			info('\u2139 Your warrant canary needs re-signing after this upgrade.');
			info('  Redeploying the frontend clears the signed file — this is normal, and');
			info('  NOT urgent: it republishes on its own at the next scheduled (weekly)');
			info('  refresh, well before the 14-day staleness window. To restore it right');
			info('  now, use whichever matches your setup:');
			info('');
			info('    \u2022 Appliance / guided install (the usual case) — re-run its refresh:');
			info('          sudo systemctl start morphit-canary.service');
			info('      or  sudo morphit-ops  \u2192  Harden this server  (it re-lays the canary)');
			info('    \u2022 Signing on a SEPARATE computer (a public server whose key is kept');
			info('      off-box) — run your refresh there:');
			info('          bash ~/.morphit/update-canary.sh');
			info('');
			info('  Never set one up? Run  sudo morphit-ops  \u2192  Harden this server.');
			info('  More detail: OPERATIONS.md \u00a736 (warrant canary).');
		}
	} catch {
		/* best-effort reminder; never fail an upgrade over a missing dir */
	}

	// ─── 11b. Heal the frontend → IPFS-gateway path BEFORE seeding ──
	// v1.17.2 codified the "allow the bunkerweb network to reach the IPFS
	// gateway" firewall rule in the Ansible bunkerweb role — but morphit.io is a
	// MANUAL /opt/morphit install that Ansible never touches, and an Ansible box
	// only picks the rule up on a re-harden. So the fix for the defect that
	// stranded morphitlat for weeks would not have reached the boxes that have
	// it. Run the self-heal here, as root, on EVERY upgrade: it observes the real
	// container-to-host path and repairs it in place (ufw → iptables → restart),
	// so an instance admin never has to be told to paste a firewall command.
	// Ordered BEFORE the seed so the seed's own per-transport verify runs against
	// an already-healed path. Best-effort and non-fatal by construction — the
	// script always exits 0 and can never fail an upgrade.
	try {
		const healScript = join(installDir, 'ops', 'ipfs', 'morphit-gateway-firewall-heal.sh');
		if (existsSync(healScript)) {
			await runStepWithSpinner(
				'Checking the frontend can reach this box\u2019s IPFS gateway…',
				'sh',
				[healScript],
				{ timeoutMs: 180_000 }
			);
		}
	} catch {
		/* never fail an upgrade over the firewall self-heal */
	}

	// ─── 12. Self-seed this release to IPFS (become an origin host) ──
	// v1.9.3: if this box runs IPFS release hosting (Kubo installed + the ipfs
	// service active — the opt-in `morphit-ops harden` → "Set up IPFS release
	// hosting", ON by default on Ansible installs), make it an ORIGIN host of the
	// release just installed: re-stage the canonical directory, `ipfs add` it, and
	// assert the CID matches the tag's published anchor. Other instances then pin
	// it from the network. Best-effort + NON-FATAL — a box without IPFS hosting
	// skips quietly, and any seed failure never fails the upgrade (git mirrors +
	// the on-chain SHA-256 are the real anchors). Runs the shipped seed script as
	// the ipfs service user.
	try {
		const seedScript = join(installDir, 'ops', 'ipfs', 'morphit-ipfs-seed.sh');
		// Resolve this box's own public + hidden addresses HERE, as root, and hand
		// them to the seed script. The script runs as the unprivileged `ipfs` user,
		// and /var/lib/tor/<svc>/ is mode 700 owned by debian-tor — so its own
		// lookup silently found nothing and every instance reported "no hidden
		// address configured" even with a live .onion, leaving the per-transport
		// verification inert on exactly the boxes it was written for.
		const seedAddrArgs: string[] = [];
		try {
			const readKey = (file: string, key: string): string => {
				if (!existsSync(file)) return '';
				const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+)$`, 'm').exec(
					readFileSync(file, 'utf8')
				);
				return m ? m[1]!.trim().replace(/^["']|["']$/g, '') : '';
			};
			const cfg = join(installDir, 'morphit.config.env');
			const idxEnv = '/etc/morphit/indexer.env';
			// morphit.env is the OTHER carried-forward config file, and on all three
			// live instances it is where the origin and hidden addresses actually are.
			const altCfg = join(installDir, 'morphit.env');
			// BunkerWeb's SERVER_NAME is the last resort and, in practice, the one
			// source that is always populated: the edge cannot serve the site without
			// it. Both real instances turned out to have neither MORPHIT_INSTANCE_ORIGIN
			// nor MORPHIT_INDEXER_PUBLIC_ORIGIN recorded anywhere.
			const origin =
				readKey(cfg, 'MORPHIT_INSTANCE_ORIGIN') ||
				readKey(altCfg, 'MORPHIT_INSTANCE_ORIGIN') ||
				readKey(idxEnv, 'MORPHIT_INDEXER_PUBLIC_ORIGIN') ||
				readKey(altCfg, 'MORPHIT_INDEXER_PUBLIC_ORIGIN') ||
				readKey(join(installDir, 'ops', 'bunkerweb', 'bunkerweb.env'), 'SERVER_NAME').split(/\s+/)[0] ||
				'';
			if (origin) seedAddrArgs.push(`MORPHIT_SEED_ORIGIN=${origin}`);

			// CONFIG and ROUTER addresses are resolved SEPARATELY, never as a
			// fallback chain, so the seed step can COMPARE them.
			//
			// morphitlat advertised a .b32.i2p its own i2pd did not host — the key
			// file had been regenerated at some point and the config was never
			// reconciled. Every peer's I2P fetch to that box failed for an unknown
			// length of time, masked by its .onion still working, and the seeder's
			// own check blamed "slow tunnels". Tor and i2pd both publish the truth
			// locally, so a stale address is detectable in one comparison — this is
			// the check that would have found it immediately.
			//
			// Our OWN onion. Never read it from indexer.env — that file lists other
			// people's Blurt RPC onions, and probing one would report a stranger's
			// node as our working seeder.
			const cfgOnion =
				readKey(cfg, 'MORPHIT_INSTANCE_TOR_ADDRESS') || readKey(altCfg, 'MORPHIT_INSTANCE_TOR_ADDRESS');
			// What Tor actually hosts. HiddenServiceDir/hostname is the authority.
			const routerOnion = (
				spawnSync(
					'sh',
					['-c', "cat /var/lib/tor/*/hostname 2>/dev/null | grep -oE '[a-z2-7]{56}\\.onion' | head -1"],
					{ encoding: 'utf8', timeout: 10_000 }
				).stdout ?? ''
			).trim();
			// What i2pd actually hosts, from its own console. No root needed.
			const routerI2p = (
				spawnSync(
					'sh',
					[
						'-c',
						// SCOPE THIS TO MORPHIT'S OWN TUNNEL. The first version took the
						// first .b32.i2p on the page, which is only correct on a router
						// hosting exactly one destination. A box running several tunnels
						// got a stranger's address compared against its own and was told
						// its correct config was "advertised wrong" — while the line right
						// below confirmed that same address served fine. A check that
						// cries wolf is worse than no check.
						//
						// The console renders one <div> per tunnel containing its NAME and
						// its b32, so split on tags and keep only the entry whose name
						// matches. If no tunnel is identifiable as ours, emit NOTHING —
						// silence is correct when we cannot tell which destination is ours.
						"curl -s --max-time 8 'http://127.0.0.1:7070/?page=i2p_tunnels' 2>/dev/null " +
							// Splitting on '<' keeps each tunnel's NAME together with its
							// href, which carries the b32 — the bare `.b32.i2p` text lands in
							// the following fragment, so read the href and append the suffix.
							"| tr '<' '\\n' " +
							"| grep -i 'morphit' " +
							"| grep -oE 'b32=[a-z2-7]{52}' | head -1 | cut -d= -f2 " +
							"| sed 's/$/.b32.i2p/'"
					],
					{ encoding: 'utf8', timeout: 15_000 }
				).stdout ?? ''
			).trim();
			if (routerOnion) seedAddrArgs.push(`MORPHIT_ROUTER_ONION=${routerOnion}`);
			if (routerI2p) seedAddrArgs.push(`MORPHIT_ROUTER_I2P=${routerI2p}`);
			const onion = cfgOnion || routerOnion;
			if (onion) seedAddrArgs.push(`MORPHIT_SEED_ONION=${onion}`);

			const i2p =
				readKey(cfg, 'MORPHIT_INSTANCE_I2P_B32_ADDRESS') ||
				readKey(altCfg, 'MORPHIT_INSTANCE_I2P_B32_ADDRESS') ||
				readKey(cfg, 'MORPHIT_INSTANCE_I2P_ADDRESS') ||
				readKey(altCfg, 'MORPHIT_INSTANCE_I2P_ADDRESS');
			if (i2p) seedAddrArgs.push(`MORPHIT_SEED_I2P=${i2p}`);
		} catch {
			/* detection is a nicety; the seed still runs and says what it could not find */
		}
		const ipfsHostingUp =
			spawnSync(
				'sh',
				['-c', 'command -v ipfs >/dev/null 2>&1 && systemctl is-active --quiet ipfs'],
				{ stdio: 'ignore', timeout: 8000 }
			).status === 0;
		if (!existsSync(seedScript)) {
			/* older tree without the seed script — skip silently */
		} else if (/-offline\.tar\.gz$/.test(tarballPath)) {
			// v1.16.10 — a hidden-only node that upgrades offline should ALSO become
			// a Tor/I2P seeder, not just a consumer (the maintainer: every instance a seeder).
			// The offline bundle now ships the CANONICAL standard tarball under
			// .canonical-release/; if it's there, seed THAT — its CID matches the
			// on-chain anchor. Only skip when it's absent (an older bundle), where
			// hashing the -offline bundle itself could never match the anchor.
			const canonical = join(installDir, '.canonical-release', `morphit-${latestTag}.tar.gz`);
			if (ipfsHostingUp && existsSync(canonical)) {
				info('');
				info(`Seeding ${latestTag} to IPFS from the bundled canonical tarball (this box becomes a Tor/I2P origin host) …`);
				const seedEnv = ['env', 'IPFS_PATH=/var/lib/ipfs/.ipfs', ...seedAddrArgs];
				try {
					chmodSync(dirname(canonical), 0o755);
					chmodSync(canonical, 0o644);
					seedEnv.push(`MORPHIT_STAGE_TARBALL=${canonical}`);
				} catch {
					/* couldn't relax perms — the seed's download mode has no clearnet here, so it'll no-op */
				}
				await runStepWithSpinner(
					`Seeding ${latestTag} to IPFS\u2026`,
					'sudo',
					['-u', 'ipfs', ...seedEnv, 'sh', seedScript, latestTag],
					{ timeoutMs: 1_200_000 }
				);
			} else {
				info('');
				info('Skipping the IPFS self-seed: this offline bundle does not carry the canonical');
				info('tarball, so its bytes can\u2019t match the on-chain CID. (Newer bundles seed automatically.)');
			}
		} else if (!ipfsHostingUp) {
			info('');
			info('IPFS release hosting is not set up on this box — skipping the self-seed.');
			info('  (Optional: `morphit-ops harden` → "Set up IPFS release hosting".)');
		} else {
			info('');
			info(`Seeding ${latestTag} to IPFS so this box becomes an origin host …`);
			// Reuse the tarball we ALREADY downloaded for this upgrade instead of
			// making the seed re-fetch the same ~13 MB over the network (painfully
			// slow on a Tor-only box). The stager's LOCAL mode (MORPHIT_STAGE_TARBALL)
			// copies it instead of curling. The tarball is a public release artifact,
			// so make it + its dir readable by the `ipfs` service user that runs the
			// seed. Falls back to download mode if the tarball isn't present.
			const seedEnv = ['env', 'IPFS_PATH=/var/lib/ipfs/.ipfs', ...seedAddrArgs];
			if (existsSync(tarballPath)) {
				try {
					chmodSync(tmpDir, 0o755);
					chmodSync(tarballPath, 0o644);
					seedEnv.push(`MORPHIT_STAGE_TARBALL=${tarballPath}`);
				} catch {
					/* couldn't relax perms — let the seed download mode handle it */
				}
			}
			const seedRes = await runStepWithSpinner(
				`Seeding ${latestTag} to IPFS\u2026`,
				'sudo',
				['-u', 'ipfs', ...seedEnv, 'sh', seedScript, latestTag],
				{ timeoutMs: 1_200_000 }
			);
			if (seedRes === 0) {
				info(`✓ Seeded ${latestTag} to IPFS.`);
			} else {
				// Say what is actually unfinished. "Did not complete" left an operator
				// unsure whether peers could fetch from this box at all: the CID had
				// been announced, but the Tor/I2P verification had not run. Name that,
				// and give a command that WORKS — the raw script needs a tag argument,
				// so pointing at it bare produces a usage error.
				warn(
					'IPFS self-seed did not finish its checks (non-fatal). The release itself is ' +
						'unaffected — git mirrors + the on-chain SHA-256 are the anchors — but this ' +
						'box has NOT confirmed it serves the release over Tor/I2P, so hidden-only ' +
						'peers may not be able to upgrade from it yet. Re-run the checks with:'
				);
				warn('    sudo morphit-ops harden   → "Seed this release to IPFS"');
			}
		}
	} catch {
		/* best-effort; never fail an upgrade over IPFS seeding */
	}

	// ─── 12b. Refresh this box's federation-snapshot mirror ──────────
	// Fast-sync gets a new node from an empty database to a live orderbook in
	// minutes instead of days. It needs one small (~600 kB) artifact: the indexer
	// snapshot @morphit anchors on-chain. If only the canonical box serves it,
	// morphit.io is a single point of failure for every new instance — and a
	// zero-clearnet newcomer, which can reach neither morphit.io's clearnet origin
	// nor a public IPFS gateway, cannot fast-sync at all.
	//
	// So every instance mirrors it. Pinning it here means this box re-serves the
	// snapshot over its own clearnet origin, .onion and .b32.i2p, and a newcomer
	// fetches from whichever peer is nearest on the transport it already speaks.
	// That is a reachability contribution, never a trust claim: the newcomer
	// proves every byte against the signed on-chain sha256, so a bad mirror is
	// caught by arithmetic. The job also runs weekly on a timer, so a box that
	// never upgrades again keeps its mirror current.
	//
	// Ordered AFTER the seed so a slow IPFS fetch can't delay the release work,
	// and best-effort throughout: the script always exits 0.
	try {
		const mirrorScript = join(installDir, 'ops', 'snapshot-mirror.sh');
		const ipfsUp =
			spawnSync(
				'sh',
				['-c', 'command -v ipfs >/dev/null 2>&1 && systemctl is-active --quiet ipfs'],
				{ stdio: 'ignore', timeout: 8000 }
			).status === 0;
		if (existsSync(mirrorScript) && ipfsUp) {
			// Install + enable the weekly timer ourselves. The Ansible ipfs role does
			// this too, but morphit.io is a MANUAL /opt/morphit install that Ansible
			// never touches — the exact defect class that left the gateway firewall
			// rule undelivered. Without this, the canonical box would never install
			// either snapshot timer and the whole feature would sit inert on the one
			// instance that matters most. Idempotent: re-copying an identical unit
			// and re-enabling an already-enabled timer are both no-ops.
			try {
				// Install the PUBLISH units too. Only the canonical box should ever
				// publish, so they stay inert until enabled — but they have to be
				// PRESENT to be enableable, and morphit.io is a manual install Ansible
				// never touches. Without this, even a first hand-made publish would
				// never get a recurring timer, and the snapshot would go stale again.
				const units = [
					'morphit-snapshot-mirror.service',
					'morphit-snapshot-mirror.timer',
					'morphit-snapshot-publish.service',
					'morphit-snapshot-publish.timer'
				];
				let installed = 0;
				for (const u of units) {
					const src = join(installDir, 'ops', 'systemd', u);
					if (!existsSync(src)) continue;
					const dest = join('/etc/systemd/system', u);
					const incoming = readFileSync(src, 'utf8');
					if (existsSync(dest) && readFileSync(dest, 'utf8') === incoming) continue;
					writeFileSync(dest, incoming);
					installed++;
				}
				if (installed > 0) {
					spawnSync('systemctl', ['daemon-reload'], { stdio: 'ignore', timeout: 60_000 });
				}
				spawnSync('systemctl', ['enable', '--now', 'morphit-snapshot-mirror.timer'], {
					stdio: 'ignore',
					timeout: 60_000
				});
				// Enable publishing ONLY where the operator has opted in by dropping the
				// env file. Explicit and reversible: exactly one instance in the
				// federation should publish, and an upgrade must never make a box start
				// signing snapshots under its own account by surprise.
				if (existsSync('/etc/morphit/snapshot-publish.env')) {
					spawnSync('systemctl', ['enable', '--now', 'morphit-snapshot-publish.timer'], {
						stdio: 'ignore',
						timeout: 60_000
					});
					info('  This box is configured as the federation snapshot publisher (timer armed).');
				}
			} catch {
				/* the timer is a convenience; the mirror below still runs this upgrade */
			}

			info('');
			await runStepWithSpinner(
				'Refreshing the federation-snapshot mirror (helps new nodes fast-sync from you)\u2026',
				'bash',
				[mirrorScript],
				{ timeoutMs: 1_800_000 }
			);
		}
	} catch {
		/* best-effort; never fail an upgrade over snapshot mirroring */
	}

	// ─── 13. Cleanup — remove the download scratch (incl. the ~13 MB
	//         tarball) now that both the install AND the seed are done. No
	//         junk left behind on disk. Deferred to here (not step 11) so
	//         the seed above could reuse the tarball we already had.
	cleanupTmp(tmpDir);

	return 0;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** v1.16.13 — SELF-HEAL: rebuild the compose-managed frontend so a shipped
 *  nginx.conf change (e.g. the v1.16.12 `/v1/broadcast` body cap) lands on the
 *  SAME upgrade. The frontend's nginx.conf is BAKED into its image, so the main
 *  upgrade flow's restart alone keeps a stale config — and because this runs from
 *  the NEW binary in the re-exec self-heal phase (like the WAF/IPFS heals), a
 *  config fix applies on the release that ships it, not one upgrade later
 *  (the maintainer/morphitir: the nginx fix sat undeployed because the driving orchestrator
 *  only restarted the frontend). Self-contained + best-effort; no-ops if there's
 *  no compose-managed frontend. Docker layer-caching makes a no-change rebuild
 *  cheap, so running it every upgrade is fine. */
export function healFrontendConfig(): void {
	try {
		// This runs from <installDir>/apps/ops-cli/dist/main.js — derive installDir
		// from that path, falling back to the standard /opt/morphit.
		let installDir = '/opt/morphit';
		const self = process.argv[1] ?? '';
		const m = /^(.*)\/apps\/ops-cli\/dist\//.exec(self);
		if (m && m[1] && existsSync(join(m[1], 'ops', 'bunkerweb', 'frontend', 'nginx.conf'))) {
			installDir = m[1];
		}
		const buildDir = join(installDir, 'apps', 'web', 'build');
		const name = findFrontendContainer(buildDir);
		if (name !== null) {
			// restartFrontendContainer refreshes the build-context nginx.conf from
			// the upgraded repo and rebuilds when compose-managed (else restarts).
			restartFrontendContainer(name, installDir);
		}
	} catch {
		/* best-effort — never fail the self-heal phase over the frontend */
	}
}

/** v1.16.10 — SELF-HEAL: expose this box's Kubo gateway over Tor/I2P so it is a
 *  federation seeder, automatically, on upgrade (the maintainer's mandate: every instance a
 *  hidden seeder, zero manual steps). Safe because Gateway.NoFetch=true means the
 *  gateway serves ONLY the release CIDs this node has pinned — never an arbitrary
 *  CID, so it is not an open proxy. Trap-everything + verified against the running
 *  daemon; a box without IPFS hosting no-ops. */
export function healIpfsGatewayExposure(): void {
	// Locate the Kubo repo (a couple of known layouts) — its presence is what
	// tells us this box hosts IPFS at all.
	const repoCandidates = ['/var/lib/ipfs/.ipfs', '/var/lib/ipfs', '/opt/ipfs/.ipfs'];
	let repo = '';
	for (const c of repoCandidates) {
		try {
			if (existsSync(join(c, 'config'))) {
				repo = c;
				break;
			}
		} catch {
			/* next */
		}
	}
	if (repo === '') return; // no Kubo repo → not an IPFS-hosting node
	const EXPOSE_ADDR = '/ip4/0.0.0.0/tcp/8082';
	const USER = 'ipfs';

	// Run an `ipfs` subcommand against the repo, as the ipfs user when we're root.
	const ipfs = (args: string[]): { ok: boolean; out: string } => {
		const asUser = process.getuid?.() === 0;
		const cmd = asUser ? 'sudo' : 'env';
		const pre = asUser
			? ['-u', USER, 'env', `IPFS_PATH=${repo}`, 'ipfs']
			: [`IPFS_PATH=${repo}`, 'ipfs'];
		try {
			const r = spawnSync(cmd, [...pre, ...args], { encoding: 'utf8', timeout: 20000 });
			return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
		} catch {
			return { ok: false, out: '' };
		}
	};

	// Already exposed + safe? Then skip the restart (steady state).
	const curGw = ipfs(['config', 'Addresses.Gateway']);
	const curNoFetch = ipfs(['config', 'Gateway.NoFetch']);
	const alreadyExposed = curGw.ok && curGw.out.includes('0.0.0.0');
	const alreadyNoFetch = curNoFetch.ok && /true/i.test(curNoFetch.out);
	if (alreadyExposed && alreadyNoFetch) return;

	let changed = false;
	// NoFetch FIRST (so we never briefly expose an open proxy), then the bind.
	if (!alreadyNoFetch && ipfs(['config', '--json', 'Gateway.NoFetch', 'true']).ok) changed = true;
	if (!alreadyExposed && ipfs(['config', 'Addresses.Gateway', EXPOSE_ADDR]).ok) changed = true;
	if (!changed) {
		info('IPFS: gateway exposure could not be set (config unavailable) — will apply on the next installer run.');
		return;
	}
	info('IPFS: exposing the release gateway over this box\u2019s .onion/.i2p (NoFetch: serves only pinned releases).');

	// Restart Kubo so the new bind takes effect, and make sure the IPNS
	// rebroadcaster (anti-stale) is running — fallback across unit names.
	const restarted = ['ipfs.service', 'kubo.service', 'ipfs'].some(
		(u) => spawnSync('systemctl', ['restart', u], { encoding: 'utf8', timeout: 40000 }).status === 0
	);
	spawnSync('systemctl', ['enable', '--now', 'morphit-ipns-rebroadcast.service'], { encoding: 'utf8', timeout: 20000 });
	if (!restarted) {
		info('IPFS: gateway configured; restart the ipfs service to apply (systemctl restart ipfs).');
		return;
	}

	// VERIFY against the running daemon: the gateway must answer on the bridge.
	try {
		spawnSync('sleep', ['4'], { timeout: 6000 });
		const probe = spawnSync(
			'curl',
			['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '6', 'http://127.0.0.1:8082/'],
			{ encoding: 'utf8', timeout: 10000 }
		);
		const code = (probe.stdout ?? '').trim();
		// Any HTTP response (even 404/400) proves the gateway is now listening.
		info(
			/^[0-9]{3}$/.test(code)
				? 'IPFS: gateway is live on the bridge \u2014 this instance now serves the release over Tor/I2P.'
				: 'IPFS: gateway restart done; it should be reachable shortly over Tor/I2P.'
		);
	} catch {
		/* verification is best-effort */
	}
}

/** Parse an nginx/BunkerWeb size string ("1m", "512k", "64k", "1024") to bytes,
 *  or null if unparseable. */
function parseNginxSize(s: string): number | null {
	const m = /^(\d+)\s*([kmg]?)$/i.exec(s.trim());
	if (!m) return null;
	const mult: Record<string, number> = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
	const factor = mult[(m[2] ?? '').toLowerCase()];
	if (factor === undefined) return null;
	return Number(m[1]) * factor;
}

/** First running docker container whose name matches `want` but not `avoid`. */
function dockerContainer(want: RegExp, avoid: RegExp | null): string | null {
	try {
		const out = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 8000 });
		if (out.status !== 0) return null;
		for (const name of (out.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean)) {
			if (want.test(name) && (avoid === null || !avoid.test(name))) return name;
		}
	} catch {
		/* docker not present */
	}
	return null;
}

/** v1.16.9 — SELF-HEAL the BunkerWeb WAF so the /v1/ + /relay/ JSON APIs work.
 *  the maintainer's mandate: trap every condition, try each fix more than one way, VERIFY it
 *  took against the RUNNING container, fall through, never throw. Fixes three
 *  live-box-confirmed failure modes that 4xx a legitimate avatar/order broadcast:
 *    A. MAX_CLIENT_SIZE too small  → 413 on the ~8 KB avatar broadcast.
 *    B. bad-behavior counts routine API 400s → bans the client IP → 403 on all.
 *    C. ModSecurity CRS flags the base64 avatar payload → 403.
 *  Best-effort + idempotent: a non-BunkerWeb deploy just no-ops; a steady-state
 *  box where everything is already applied skips the reload. */
export function healBunkerWebWaf(): void {
	const bwEnv = '/etc/bunkerweb/bunkerweb.env';
	try {
		if (!existsSync(bwEnv)) return; // not a BunkerWeb deployment — nothing to heal
	} catch {
		return;
	}

	const bw = dockerContainer(/bunkerweb/i, /scheduler|ui|db|redis|autoconf/i);
	const sched = dockerContainer(/scheduler/i, null);
	const RULE_ID = '1990001';
	const MODSEC_RULE =
		`SecRule REQUEST_URI "@rx ^/(v1|relay)/" "id:${RULE_ID},phase:1,t:none,nolog,pass,ctl:ruleEngine=Off"`;
	const RELAY_BODY_FLOOR = 64 * 1024; // the relay's own body cap; BunkerWeb must allow ≥ this
	let changed = false;

	let env = '';
	try {
		env = readFileSync(bwEnv, 'utf8');
	} catch {
		return;
	}
	const getVal = (key: string): string | null => {
		const m = new RegExp(`^${key}=(.*)$`, 'm').exec(env);
		return m ? (m[1] ?? null) : null;
	};
	const setVal = (key: string, val: string): void => {
		if (new RegExp(`^${key}=`, 'm').test(env)) {
			env = env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${val}`);
		} else {
			env = `${env.replace(/\n*$/, '')}\n${key}=${val}\n`;
		}
		changed = true;
	};

	// ── Fix A: MAX_CLIENT_SIZE — avatar/order broadcasts must not 413. ──
	try {
		const cur = getVal('MAX_CLIENT_SIZE');
		const curBytes = cur !== null ? parseNginxSize(cur) : null;
		if (cur === null || curBytes === null || curBytes < RELAY_BODY_FLOOR) {
			setVal('MAX_CLIENT_SIZE', '1m');
			info('WAF: set MAX_CLIENT_SIZE=1m so avatar/order broadcasts are not rejected 413.');
		}
	} catch {
		/* keep going */
	}

	// ── Fix B: bad-behavior must NOT ban on routine API 400s. ──
	try {
		const cur = getVal('BAD_BEHAVIOR_STATUS_CODES');
		const codes = (cur ?? '400 401 403 404 405 429 444').trim().split(/\s+/).filter((c) => c !== '400');
		const joined = codes.join(' ');
		if (cur === null || cur.trim() !== joined) {
			setVal('BAD_BEHAVIOR_STATUS_CODES', joined);
			info('WAF: removed 400 from bad-behavior triggers (a JSON API returns 400 routinely; it must not ban traders).');
		}
	} catch {
		/* keep going */
	}

	// ── Fix C, strategy 1: the ModSec exemption as an env var. ──
	try {
		if (!/^CUSTOM_CONF_MODSEC_morphit_json_api_off=/m.test(env)) {
			setVal('CUSTOM_CONF_MODSEC_morphit_json_api_off', MODSEC_RULE);
		}
	} catch {
		/* keep going */
	}

	if (changed) {
		try {
			writeFileSync(bwEnv, env, 'utf8');
		} catch {
			/* couldn't write env — the file strategy + reload below may still apply */
		}
	}

	// ── Fix C, strategy 2 (the one PROVEN to load): drop the rule as a FILE in the
	//    scheduler's config tree, which BunkerWeb renders even when the env var is
	//    ignored. Only counts as a change if it wasn't already there. ──
	if (sched !== null) {
		try {
			const root =
				(spawnSync('docker', [
					'exec', sched, 'sh', '-c',
					'for d in /data/configs /etc/bunkerweb/configs /data/config; do [ -d "$d" ] && { echo "$d"; break; }; done'
				], { encoding: 'utf8', timeout: 8000 }).stdout ?? '').trim() || '/data/configs';
			const conf = `${root}/modsec/morphit-json-api-off.conf`;
			const already =
				(spawnSync('docker', [
					'exec', sched, 'sh', '-c', `test -s '${conf}' && grep -q '${RULE_ID}' '${conf}' && echo yes`
				], { encoding: 'utf8', timeout: 8000 }).stdout ?? '').includes('yes');
			if (!already) {
				spawnSync('docker', [
					'exec', sched, 'sh', '-c',
					`mkdir -p '${root}/modsec' && printf '%s\\n' ${JSON.stringify(MODSEC_RULE)} > '${conf}'`
				], { encoding: 'utf8', timeout: 8000 });
				changed = true;
			}
		} catch {
			/* keep going */
		}
	}

	// ── Apply: reload via a fallback chain (only when we changed the env); stop at
	//    the first that succeeds. Even in steady state we still VERIFY below, because
	//    an env value can be present yet never rendered into nginx (the recurring
	//    413) — so we must observe the running limit, not trust `changed`.
	let reloaded = false;
	if (changed) {
		const composeFiles = ['/etc/bunkerweb/docker-compose.yml', '/opt/morphit/docker-compose.yml'];
		const strategies: Array<() => boolean> = [
		() => sched !== null && spawnSync('docker', ['restart', sched], { encoding: 'utf8', timeout: 60000 }).status === 0,
		...composeFiles.flatMap((f) =>
			existsSync(f)
				? [
						() => spawnSync('docker', ['compose', '-f', f, 'up', '-d'], { encoding: 'utf8', timeout: 120000 }).status === 0,
						() => spawnSync('docker-compose', ['-f', f, 'up', '-d'], { encoding: 'utf8', timeout: 120000 }).status === 0
					]
				: []
		),
		() => bw !== null && spawnSync('docker', ['restart', bw], { encoding: 'utf8', timeout: 60000 }).status === 0
	];
		let ok = false;
		for (const strat of strategies) {
			try {
				if (strat()) {
					ok = true;
					break;
				}
			} catch {
				/* try the next strategy */
			}
		}
		reloaded = ok;
		if (!reloaded) {
			info('WAF: settings written; could not auto-reload — they apply on the next `docker compose up -d`.');
		}
	}

	// ── VERIFY against the RUNNING container — ALWAYS, even in steady state,
	//    because an env value can be present yet never rendered into nginx (the
	//    recurring 413). Observe the real limits; don't trust that setting = applied.
	if (bw === null) return;
	if (reloaded) spawnSync('sleep', ['20'], { timeout: 25000 }); // let the scheduler regenerate

	// (1) ModSec /v1/ + /relay/ exemption actually loaded?
	try {
		const loaded =
			(spawnSync('docker', ['exec', bw, 'sh', '-c', `grep -rl '${RULE_ID}' /etc/bunkerweb /data 2>/dev/null | head -1`], {
				encoding: 'utf8',
				timeout: 10000
			}).stdout ?? '').trim().length > 0;
		if (loaded) info('WAF: /v1/ + /relay/ exemption verified live inside BunkerWeb.');
	} catch {
		/* best-effort */
	}

	// (2) BODY SIZE — prove a real-sized broadcast is NOT rejected 413, and if it
	//     is, ESCALATE: the MAX_CLIENT_SIZE env sometimes never renders into nginx,
	//     so drop a raw `client_max_body_size` directive as a config FILE (the
	//     mechanism BunkerWeb reliably honors) and reload. Figure it out, per the maintainer.
	try {
		const origin = readInstanceEnvValue(INSTANCE_ENV.ORIGIN);
		if (origin) {
			const target = `${origin.replace(/\/+$/, '')}/v1/broadcast`;
			const probe = (): string => {
				// ~50 KB: under the relay's 64 KB cap, far above a real avatar broadcast.
				const blob = 'A'.repeat(50 * 1024);
				const r = spawnSync(
					'curl',
					['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '12', '-X', 'POST', target, '-H', 'content-type: application/json', '--data', `{"probe":"${blob}"}`],
					{ encoding: 'utf8', timeout: 20000 }
				);
				return (r.stdout ?? '').trim();
			};
			let code = probe();
			if (code === '413' && sched !== null) {
				info('WAF: a real-sized broadcast is still 413 — the MAX_CLIENT_SIZE env did not render; escalating via a config file.');
				const root =
					(spawnSync('docker', ['exec', sched, 'sh', '-c', 'for d in /data/configs /etc/bunkerweb/configs; do [ -d "$d" ] && { echo "$d"; break; }; done'], {
						encoding: 'utf8',
						timeout: 8000
					}).stdout ?? '').trim() || '/data/configs';
				// (a) nginx client_max_body_size (server context) — harmless if already large.
				spawnSync(
					'docker',
					['exec', sched, 'sh', '-c', `mkdir -p '${root}/server-http' && printf '%s\\n' 'client_max_body_size 1m;' > '${root}/server-http/morphit-body-size.conf'`],
					{ encoding: 'utf8', timeout: 8000 }
				);
				// (b) THE actual 413 source when client_max_body_size is already generous:
				//     ModSecurity's request-body limit. `ruleEngine=Off` for /v1/ does NOT
				//     lift it (it's enforced during body-reading, before rules), so raise
				//     the no-files limit and set ProcessPartial so ModSec never rejects a
				//     legitimate avatar/order broadcast on size (the maintainer/timeapp: the recurring
				//     413 was ModSec, not nginx — client_max_body_size was 1G/10m).
				spawnSync(
					'docker',
					['exec', sched, 'sh', '-c', `mkdir -p '${root}/modsec' && printf '%s\\n' 'SecRequestBodyLimit 13107200' 'SecRequestBodyNoFilesLimit 1048576' 'SecRequestBodyLimitAction ProcessPartial' > '${root}/modsec/morphit-body-limit.conf'`],
					{ encoding: 'utf8', timeout: 8000 }
				);
				spawnSync('docker', ['restart', sched], { encoding: 'utf8', timeout: 60000 });
				spawnSync('docker', ['restart', bw], { encoding: 'utf8', timeout: 60000 });
				spawnSync('sleep', ['20'], { timeout: 25000 });
				code = probe();
			}
			info(
				code === '413'
					? `WAF: broadcast body limit STILL 413 after escalation — capture \`docker exec ${bw} nginx -T 2>/dev/null | grep client_max_body_size\` and send it.`
					: `WAF: broadcast body limit OK (a ~50 KB POST returned ${code || '?'}, not 413) — avatar/order uploads fit.`
			);
		}
	} catch {
		/* best-effort — never fail the upgrade over a probe */
	}
}

/** Read the release's on-chain SHA-256 anchor from the LOCAL indexer's
 *  /v1/release (served over the node's OWN RPC — no clearnet). Returns the
 *  `-offline` bundle hash when `wantOffline`, else the standard-tarball hash,
 *  and ONLY when the served release version matches `tag` (never trust a stale
 *  or different release's hash). Best-effort: null if unreachable / absent /
 *  version-mismatch. v1.16.9 — lets a hidden/air-gapped node apply an offline
 *  tarball with no hand-signed .asc. */
async function readOnchainReleaseSha(tag: string, wantOffline: boolean): Promise<string | null> {
	const bases = ['http://127.0.0.1:8081', 'http://172.18.0.1:8081', 'http://172.17.0.1:8081'];
	const want = tag.replace(/^v/, '');
	for (const base of bases) {
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 5000);
			const res = await fetch(`${base}/v1/release`, { signal: ctrl.signal });
			clearTimeout(timer);
			if (!res.ok) continue;
			// Cap the body before parsing — /v1/release is tiny; refuse an absurd
			// response rather than parse it (hardening: no bare res.json()).
			const txt = await res.text();
			if (txt.length > 65536) continue;
			const body = JSON.parse(txt) as {
				version?: string;
				distribution?: { source_sha256?: string; offline_sha256?: string } | null;
			};
			if ((body.version ?? '').replace(/^v/, '') !== want) continue; // stale/other release
			const d = body.distribution ?? {};
			const sha = wantOffline ? d.offline_sha256 : d.source_sha256;
			if (typeof sha === 'string' && /^[0-9a-f]{64}$/i.test(sha)) return sha.toLowerCase();
		} catch {
			/* try the next base */
		}
	}
	return null;
}

/** Read this operator's tag from the on-disk config (the authoritative,
 *  root-owned files), robustly. Uses [ \t]* (NOT \s*) around '=' so an empty
 *  value can't swallow the next line. Last non-empty wins. v1.16.9. */
/** Read a MORPHIT_INSTANCE_* value from the on-disk config files (first hit). */
function readInstanceEnvValue(key: string): string | null {
	const files = [
		'/etc/morphit/indexer.env',
		'/opt/morphit/morphit.config.env',
		'/etc/morphit/morphit.config.env',
		'/opt/morphit/indexer.env'
	];
	let found: string | null = null;
	for (const f of files) {
		try {
			if (!existsSync(f)) continue;
			const m = readFileSync(f, 'utf8').match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, 'm'));
			if (!m) continue;
			const v = (m[1] ?? '').trim().replace(/^["']|["']$/g, '').trim();
			if (v !== '') found = v;
		} catch {
			/* unreadable — skip */
		}
	}
	return found;
}

/** This operator's tag, most-authoritative-first: the on-disk config, then the
 *  ON-CHAIN registration the local indexer serves in /v1/instances (matched to
 *  this instance's own origin). The on-chain fallback fixes the case where the
 *  tag was registered on-chain but never written to the local config — which
 *  otherwise left verify.json's operator_tag null forever (the maintainer: still null). */
function readOperatorTagFromConfig(): string | null {
	const fromConfig = readInstanceEnvValue(INSTANCE_ENV.OPERATOR_TAG);
	if (fromConfig) return fromConfig;
	// Fallback: ask the running indexer for this instance's on-chain tag.
	try {
		const origin = readInstanceEnvValue(INSTANCE_ENV.ORIGIN);
		if (!origin) return null;
		const norm = (s: string): string => s.replace(/\/+$/, '').toLowerCase();
		for (const base of ['http://127.0.0.1:8081', 'http://172.18.0.1:8081', 'http://172.17.0.1:8081']) {
			const r = spawnSync('curl', ['-s', '--max-time', '6', `${base}/v1/instances`], {
				encoding: 'utf8',
				timeout: 10_000
			});
			if (r.status !== 0 || !r.stdout) continue;
			let body: unknown;
			try {
				body = JSON.parse(r.stdout);
			} catch {
				continue;
			}
			const list: Array<{ origin?: string; operator_tag?: string }> = Array.isArray(body)
				? (body as Array<{ origin?: string; operator_tag?: string }>)
				: ((body as { instances?: Array<{ origin?: string; operator_tag?: string }> }).instances ?? []);
			const self = list.find((e) => typeof e.origin === 'string' && norm(e.origin) === norm(origin));
			const tag = self?.operator_tag;
			if (typeof tag === 'string' && tag.trim() !== '') return tag.trim();
		}
	} catch {
		/* best-effort — verify.json's operator_tag is informational */
	}
	return null;
}

/** Stamp `operator_tag` into a build's verify.json without disturbing its
 *  formatting or the (asset) hash_manifest. Returns true if it changed the file. */
function patchVerifyJsonOperatorTag(buildDir: string, tag: string): boolean {
	const p = join(buildDir, 'verify.json');
	if (!existsSync(p)) return false;
	const txt = readFileSync(p, 'utf8');
	const patched = txt.replace(/("operator_tag"[ \t]*:[ \t]*)(null|"[^"]*")/, `$1${JSON.stringify(tag)}`);
	if (patched === txt) return false;
	writeFileSync(p, patched);
	return true;
}


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
// Idle (no-bytes) timeout for streaming the release tarball — abort only if the
// transfer STALLS this long, so a slow-but-steady link (the maintainer/morphitir, a filtered network)
// can finish a large download instead of hitting a fixed total deadline.
const UPGRADE_STALL_TIMEOUT_MS = 90_000;

// cp191 — fetch a release-metadata URL with all the safety the
// upgrade path needs: a hard timeout, manual redirect handling
// (a 30x to an unexpected host on the metadata call must be
// operator-visible), and a 1 MiB body cap before parse (the host
// is operator-configured so this isn't SSRF, but a MITM'd /
// compromised release API returning multi-GB JSON would OOM the
// upgrade run; Forgejo release payloads are <8 KB, so 1 MiB is
// 100x+ headroom).  Returns the raw text; the caller parses.
async function fetchReleaseJson(url: string): Promise<{ ok: boolean; status: number; text: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), UPGRADE_FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Accept: 'application/json' },
			redirect: 'manual',
			signal: controller.signal
		});
		if (!res.ok) {
			return { ok: false, status: res.status, text: '' };
		}
		const RELEASE_JSON_MAX_BYTES = 1024 * 1024;
		// cp160 F-opscli-1 — bound the response body before parse (cap
		// retained through the cp191 refactor of this fetch into a helper).
		const cl = res.headers.get('content-length');
		if (cl !== null) {
			const n = Number(cl);
			if (Number.isFinite(n) && n > RELEASE_JSON_MAX_BYTES) {
				controller.abort();
				throw new Error(
					`Forgejo release API body exceeds cap (Content-Length ${n} > ${RELEASE_JSON_MAX_BYTES}) from ${url}`
				);
			}
		}
		const text = await res.text();
		if (text.length > RELEASE_JSON_MAX_BYTES) {
			throw new Error(
				`Forgejo release API body exceeds cap (${text.length} > ${RELEASE_JSON_MAX_BYTES}) from ${url}`
			);
		}
		return { ok: true, status: res.status, text };
	} finally {
		clearTimeout(timer);
	}
}

async function fetchLatestRelease(host: string, repo: string): Promise<ForgejoRelease> {
	// cp191 — `/releases/latest` returns the most recent
	// NON-prerelease, non-draft release (Forgejo API semantics,
	// confirmed in their API source).  That's the right default for
	// an auto-upgrader: it protects operators on a stable release
	// from being offered a newer beta.  BUT during the beta period
	// there is NO non-prerelease release, so `/releases/latest`
	// 404s — and historically (beta1/beta2 both flagged
	// pre-release) that left `morphit-ops upgrade` unable to see any
	// release at all.  So: prefer `/releases/latest`, and if it 404s
	// (no stable exists yet), fall back to the newest release of any
	// kind via `/releases?limit=1` (newest-first; unauthenticated,
	// so drafts are excluded server-side).  Net: stable is preferred
	// when one exists; otherwise the newest prerelease is found even
	// if it carries the pre-release flag.
	const latestUrl = `https://${host}/api/v1/repos/${repo}/releases/latest`;
	const latestRes = await fetchReleaseJson(latestUrl);
	if (latestRes.ok) {
		const body = JSON.parse(latestRes.text) as ForgejoRelease;
		if (typeof body.tag_name !== 'string') {
			throw new Error(`Forgejo API response missing tag_name field`);
		}
		return body;
	}
	if (latestRes.status !== 404) {
		throw new Error(`HTTP ${latestRes.status} from ${latestUrl}`);
	}

	// No stable release — fall back to the newest release of any kind
	// (includes prereleases; the beta period lives here).
	const listUrl = `https://${host}/api/v1/repos/${repo}/releases?limit=1`;
	const listRes = await fetchReleaseJson(listUrl);
	if (!listRes.ok) {
		throw new Error(`HTTP ${listRes.status} from ${listUrl}`);
	}
	const list = JSON.parse(listRes.text) as ForgejoRelease[];
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error(
			`No releases found for ${repo} (neither a stable /releases/latest nor any prerelease). ` +
				`If a release was just published, confirm it is not a draft.`
		);
	}
	const newest = list[0];
	if (newest === undefined || typeof newest.tag_name !== 'string') {
		throw new Error(`Forgejo API response missing tag_name field`);
	}
	return newest;
}

async function downloadTo(url: string, dest: string): Promise<void> {
	const controller = new AbortController();
	// IDLE timeout, not a total deadline: abort only if NO bytes arrive for
	// UPGRADE_STALL_TIMEOUT_MS. A slow-but-progressing download (a 13 MB tarball
	// over a throttled/filtered link — the maintainer/morphitir in a filtered network) must COMPLETE; the
	// old fixed 30 s cap guillotined healthy slow downloads mid-transfer. We also
	// STREAM to disk instead of buffering the whole file in memory.
	let timer!: ReturnType<typeof setTimeout>;
	const arm = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(), UPGRADE_STALL_TIMEOUT_MS);
	};
	arm();
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} from ${url}`);
		}
		if (res.body === null) {
			// No readable stream (unusual) — fall back to a buffered read.
			writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
			return;
		}
		const out = createWriteStream(dest);
		const reader = res.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				arm(); // progress made — reset the stall timer
				if (value && value.length > 0) {
					if (!out.write(Buffer.from(value))) {
						await new Promise<void>((resolve) => out.once('drain', resolve));
					}
				}
			}
		} finally {
			await new Promise<void>((resolve, reject) =>
				out.end((err?: Error | null) => (err ? reject(err) : resolve()))
			);
		}
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

/**
 * cp674 — remove an inherited npm "offline" flag from an environment.
 *
 * The Ansible `morphit-ops` launcher runs the CLI via `npm exec --offline`,
 * which exports `npm_config_offline=true` into our process environment. That
 * flag is inherited by EVERY child npm we spawn during an upgrade — the
 * workspace `npm ci` and the MCP redeploy's `npm install` — and forces them
 * cache-only. Any dependency not already in the local npm cache (after a big
 * version jump, or a newly-added dep) then fails with `ENOTCACHED` and the whole
 * upgrade rolls back. The manual install's launcher is a plain symlink with no
 * `--offline`, which is why it was never hit there.
 *
 * The online upgrade REQUIRES the registry. The genuinely air-gapped paths never
 * rely on this inherited flag: the prebuilt-bundle path skips `npm ci` entirely,
 * and `deploy-mcp.sh` passes `--offline` explicitly on its own npm invocation
 * against a vendored cache. So stripping the inherited flag here is safe for both
 * online and offline upgrades.
 *
 * Mutates `env` in place; returns the names of the keys it cleared (for logging
 * and tests).
 */
export function stripInheritedNpmOffline(env: NodeJS.ProcessEnv): string[] {
	const keys = [
		'npm_config_offline',
		'npm_config_prefer_offline',
		'NPM_CONFIG_OFFLINE',
		'NPM_CONFIG_PREFER_OFFLINE'
	];
	const cleared: string[] = [];
	for (const k of keys) {
		if (env[k] !== undefined) {
			delete env[k];
			cleared.push(k);
		}
	}
	return cleared;
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

function rollback(
	installDir: string,
	backupDir: string,
	tmpDir: string,
	err: unknown,
	web?: { webRoot: string; webRootBackup: string | null }
): number {
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
	// Restore the previous web frontend if we'd already redeployed a new one,
	// so the served site matches the rolled-back backend (best-effort).
	if (web && web.webRootBackup !== null && existsSync(web.webRootBackup)) {
		try {
			cpSync(web.webRootBackup, web.webRoot, { recursive: true, force: true });
			info(`Restored the previous web frontend at ${web.webRoot}.`);
		} catch (webErr) {
			warn(
				`Could not restore the previous web frontend at ${web.webRoot}: ` +
					`${webErr instanceof Error ? webErr.message : String(webErr)}. ` +
					`Your site may be on the new build while services rolled back; ` +
					`rebuild apps/web and copy build/ to ${web.webRoot} to realign.`
			);
		}
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

/** PIDs whose current working directory is `dir` or a subdirectory of it.
 *  Linux-only (reads /proc); returns [] anywhere /proc is unavailable, so
 *  callers must treat an empty result as "best-effort / unknown", not a
 *  hard guarantee that nothing is using the tree. Used to (a) warn when a
 *  manually-run indexer/relay is left orphaned on stale code after the dir
 *  swap, and (b) refuse to prune a backup a live process is still reading. */
/** The current process plus its full ancestor chain (parent, grandparent, … up
 *  to init), from each /proc/<pid>/stat PPID field. The upgrade runs with its
 *  cwd inside the install dir that becomes the .bak dir, so its own process —
 *  and its shell / sudo / launcher ancestors — all show up in the cwd-based
 *  orphan sweep below. WITHOUT excluding them the sweep SIGTERMs the upgrade
 *  itself: the box upgrades fine, but the process dies with a scary "Terminated"
 *  and every remaining step (backup pruning, the success banner, the canary
 *  refresh) is skipped. These PIDs are always excluded from the sweep. */
export function selfAndAncestorPids(): Set<number> {
	const out = new Set<number>([process.pid]);
	let pid = process.pid;
	for (let hops = 0; pid > 1 && hops < 64; hops++) {
		let ppid = 0;
		try {
			// "pid (comm) state ppid …" — comm may contain spaces/parens, so parse
			// after the LAST ')': fields are then [state, ppid, …].
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
			const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
			ppid = Number(fields[1]);
		} catch {
			break;
		}
		if (!Number.isInteger(ppid) || ppid <= 0) break;
		out.add(ppid);
		pid = ppid;
	}
	return out;
}

function pidsWithCwdUnder(dir: string): number[] {
	const norm = (p: string): string => p.replace(/\/+$/, '') || '/';
	const target = norm(dir);
	const out: number[] = [];
	let procEntries: string[];
	try {
		procEntries = readdirSync('/proc');
	} catch {
		return out; // non-Linux / no /proc — best-effort only.
	}
	for (const e of procEntries) {
		if (!/^\d+$/.test(e)) continue;
		try {
			const cwd = norm(readlinkSync(`/proc/${e}/cwd`));
			if (cwd === target || cwd.startsWith(`${target}/`)) out.push(Number(e));
		} catch {
			// process exited, or /proc/<pid>/cwd not readable — skip.
		}
	}
	return out;
}

/** PIDs actively RUNNING CODE from `dir` — their executable
 *  (/proc/<pid>/exe) resolves under `dir`, or an absolute argument in their
 *  command line is a path under `dir` (e.g. `node /opt/morphit.bak-…/apps/
 *  indexer/dist/main.js`). This is the real "unsafe to delete" signal:
 *  deleting a backup a live service still executes from would yank its files
 *  mid-run. It deliberately does NOT flag a process that merely has its cwd
 *  parked under the tree (a leftover login shell, or a `less`/pager from
 *  `systemctl status`) — removing the directory under such a process is
 *  harmless, the kernel keeps it running with a now-stale cwd. Linux-only
 *  (reads /proc); [] anywhere /proc is unavailable. */
function pidsRunningFrom(dir: string): number[] {
	const norm = (p: string): string => p.replace(/\/+$/, '') || '/';
	const target = norm(dir);
	const under = (p: string): boolean => {
		if (!p || p[0] !== '/') return false; // absolute paths only
		const n = norm(p);
		return n === target || n.startsWith(`${target}/`);
	};
	const out: number[] = [];
	let procEntries: string[];
	try {
		procEntries = readdirSync('/proc');
	} catch {
		return out; // non-Linux / no /proc — best-effort only.
	}
	for (const e of procEntries) {
		if (!/^\d+$/.test(e)) continue;
		let hit = false;
		try {
			if (under(readlinkSync(`/proc/${e}/exe`))) hit = true;
		} catch {
			// exe unreadable (permissions / kernel thread) — fall through.
		}
		if (!hit) {
			try {
				const argv = readFileSync(`/proc/${e}/cmdline`, 'utf8').split('\0');
				if (argv.some((a) => under(a))) hit = true;
			} catch {
				// cmdline unreadable — skip.
			}
		}
		if (hit) out.push(Number(e));
	}
	return out;
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
		// Safeguard: only refuse to prune a backup that a live process is
		// actively RUNNING CODE from (a manually-started indexer/relay left on
		// the old tree) — deleting it then would yank its files mid-run. A
		// process that merely has its cwd parked under the tree (a leftover
		// login shell, or a `less`/pager from `systemctl status`) is harmless,
		// so prune anyway instead of nagging the operator on every upgrade;
		// the kernel keeps those processes running with a now-stale cwd.
		const runningFrom = pidsRunningFrom(ent.path);
		if (runningFrom.length > 0) {
			warn(
				`Not pruning ${ent.path}: ${runningFrom.length} process(es) are ` +
					`actively running code from it (PIDs ${runningFrom.join(', ')}). ` +
					`That looks like a service started from the old tree — restart ` +
					`it from ${installDir} (or move it onto the systemd units), then ` +
					`this backup is pruned on the next upgrade.`
			);
			continue;
		}
		try {
			const parked = pidsWithCwdUnder(ent.path);
			rmSync(ent.path, { recursive: true, force: true });
			if (parked.length > 0) {
				info(
					`Pruned old backup: ${ent.path} (${parked.length} idle ` +
						`shell/pager had it as a working directory — harmless; they ` +
						`keep running).`
				);
			} else {
				info(`Pruned old backup: ${ent.path}`);
			}
		} catch {
			// best-effort
		}
	}
}

/** How long to wait for an answer when stdin is NOT a terminal. Piped answers
 *  arrive at once; a stuck pipe must not wedge an upgrade. */
const NON_TTY_ANSWER_TIMEOUT_MS = 20_000;

async function promptYes(message: string): Promise<boolean> {
	// NEVER block forever, but DO accept piped answers.
	//
	// The hazard is not "stdin is not a terminal" — feeding answers through a
	// pipe is ordinary automation and must keep working. The hazard is stdin that
	// never delivers: an open pipe, `ssh -T`, or a systemd unit with stdin
	// attached, where readline waits for input that can never arrive and the
	// upgrade hangs silently after printing a question nobody sees. (With
	// /dev/null stdin — plain cron — readline gets EOF and returns, so that case
	// was already safe; I checked before assuming.)
	//
	// So: a human at a terminal gets unlimited time to answer, while a
	// non-terminal stdin gets a bounded wait — long enough for piped input, which
	// arrives at once, and short enough that a stuck pipe cannot wedge an
	// upgrade. Declining on timeout leaves the box as it was; hanging leaves an
	// upgrade half-open.
	// Use Node's readline.  We don't `import readline from 'node:readline/promises'`
	// at the module top to keep the cost off the --check-only path.
	const readline = await import('node:readline/promises');
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	const interactive = process.stdin.isTTY === true;
	let answer = '';
	try {
		if (interactive) {
			answer = (await rl.question(`${message}\n[y/N]: `)).trim().toLowerCase();
		} else {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), NON_TTY_ANSWER_TIMEOUT_MS);
			try {
				answer = (await rl.question(`${message}\n[y/N]: `, { signal: ac.signal }))
					.trim()
					.toLowerCase();
			} finally {
				clearTimeout(timer);
			}
		}
	} catch {
		// Aborted (or stdin closed) — decline, and say so, since nobody saw the
		// question.
		rl.close();
		info('(no answer on stdin — declining. Set MORPHIT_AUTO_UPGRADE=1 to proceed unattended.)');
		return false;
	}
	rl.close();
	return answer === 'y' || answer === 'yes';
}
