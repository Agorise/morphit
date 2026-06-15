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

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, readdirSync, statSync, copyFileSync, cpSync, readlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import { error as printError, info, warn, sanitizeForTerm } from '../render/term.ts';
import { refreshManagedUnits } from '../lib/refreshUnits.ts';
import { daemonReload } from '../lib/restartServices.ts';

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

// Services to restart on upgrade.  Listed in dependency order
// (deps before consumers).  If a service unit doesn't exist on
// the host, the restart attempt is skipped with an INFO log.
const SERVICES_TO_RESTART = [
	'morphit-indexer.service',
	'morphit-relay.service',
	'morphit-matrix-bot.service'
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

/** Parse the primary host/repo + the MORPHIT_RELEASE_MIRRORS env into an
 *  ordered, de-duplicated source list (primary always first + trusted).
 *  Each mirror entry is `host` (reuse primary repo) or `host/owner/repo`.
 *  PURE. */
export function parseReleaseSources(
	primaryHost: string,
	primaryRepo: string,
	mirrorsEnv: string | undefined
): ReleaseSource[] {
	const sources: ReleaseSource[] = [{ host: primaryHost, repo: primaryRepo, isPrimary: true }];
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

/** Pick the tarball + sha256 + (optional) detached GPG signature out of a
 *  release's assets. Returns null if the required tarball+sha pair is
 *  missing. PURE. */
export function selectReleaseAssets(
	assets: readonly ForgejoReleaseAsset[]
): SelectedAssets | null {
	const tarball = assets.find(
		(a) => a.name.endsWith('.tar.gz') && !a.name.endsWith('.sha256.tar.gz')
	);
	const sha = assets.find((a) => a.name.endsWith('.tar.gz.sha256'));
	const sig = assets.find((a) => a.name.endsWith('.tar.gz.asc')) ?? null;
	if (!tarball || !sha) return null;
	return { tarball, sha, sig };
}

type IntegrityProof = 'gpg-signature' | 'primary-https-hash' | 'primary-anchored-hash';

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
}): TrustDecision {
	if (args.sigVerified) {
		return {
			allowed: true,
			proof: 'gpg-signature',
			reason: 'GPG signature verified against the release-signer keys shipped in the install.'
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
			'No trusted integrity proof: the release is unsigned and the trusted primary could not ' +
			'provide the expected hash. Refusing to install a mirror-supplied tarball that can only ' +
			'be checked against the mirror\u2019s own checksum.'
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

/** True if this version's indexer `schema.sql` differs from the one in the
 *  previous install (now the backup) — i.e. the upgrade crossed a schema
 *  change. Reads two files; returns false if either is missing/unreadable
 *  (can't tell → don't nag the operator). cp217. */
export function schemaBaselineChanged(oldInstallDir: string, newInstallDir: string): boolean {
	const rel = join('apps', 'indexer', 'src', 'db', 'schema.sql');
	const oldP = join(oldInstallDir, rel);
	const newP = join(newInstallDir, rel);
	if (!existsSync(oldP) || !existsSync(newP)) return false;
	try {
		return readFileSync(oldP, 'utf8') !== readFileSync(newP, 'utf8');
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
 *  /usr/share/nginx/html; a custom stack like Ken's binds the same dir). */
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
function restartFrontendContainer(name: string): void {
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
		for (let attempt = 0; attempt < 5; attempt++) {
			for (const ip of containerBridgeIps(plan.restartContainer)) {
				const v = await fetchServedVersion(`http://${ip}:80/verify.json`);
				if (v !== null) return v;
			}
			if (attempt < 4) await new Promise((r) => setTimeout(r, 1500));
		}
	}
	return null;
}


export async function runUpgrade(opts: RunUpgradeOptions): Promise<number> {
	const checkOnly = opts.flags['check-only'] === 'true';
	const forceYes = opts.flags['yes'] === 'true' || process.env.MORPHIT_AUTO_UPGRADE === '1';
	const jsonOutput = opts.flags['json'] === 'true';

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
	// The PRIMARY is the trusted hash anchor. We fetch each source's
	// release listing; `primaryRelease` (if reachable) anchors the
	// SHA-256, while a mirror release lets us still SEE + (if signed)
	// install when the primary is down. Discovery order = source order.
	let primaryRelease: ForgejoRelease | null = null;
	const releasesBySource: Array<{ src: ReleaseSource; rel: ForgejoRelease }> = [];
	const fetchErrors: string[] = [];
	for (const src of sources) {
		try {
			const rel = await fetchLatestRelease(src.host, src.repo);
			releasesBySource.push({ src, rel });
			if (src.isPrimary) primaryRelease = rel;
		} catch (err) {
			fetchErrors.push(`${src.host}/${src.repo}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	const latest = primaryRelease ?? releasesBySource[0]?.rel ?? null;
	if (latest === null) {
		printError(
			`Could not reach any release source.\n  ` + fetchErrors.join('\n  ')
		);
		return 5;
	}
	if (primaryRelease === null) {
		warn(`Primary (${host}/${repo}) unreachable; using mirror for discovery. A valid release signature will be REQUIRED to install.`);
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

	// ─── 5. Download + verify (mirror-aware, integrity-anchored) ─
	const tmpDir = mkTempDir();

	// 5a. Trust anchor: the SHA-256 always comes from the PRIMARY.
	let expectedHash: string | null = null;
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
	const tarballPath = join(tmpDir, chosenAssets.tarball.name);
	let bytesFromPrimary = false;
	let bytesSource: ReleaseSource | null = null;
	let sigPath: string | null = null;
	const dlErrors: string[] = [];
	for (const { src, rel } of releasesBySource) {
		const a = selectReleaseAssets(rel.assets);
		if (!a) continue;
		try {
			info(`Downloading ${a.tarball.name} from ${src.host}${src.isPrimary ? ' (primary)' : ' (mirror)'}...`);
			await downloadTo(a.tarball.browser_download_url, tarballPath);
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
	const trust = decideTrust({
		bytesFromPrimary,
		sigVerified,
		hashMatched,
		hashFromPrimary: expectedHash !== null
	});
	if (!trust.allowed) {
		printError(`Cannot verify the integrity of release ${latestTag}.\n  ${trust.reason}`);
		cleanupTmp(tmpDir);
		return 5;
	}
	info(`\u2713 Integrity verified (${trust.proof}). ${trust.reason}`);


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
	const schemaChanged = schemaBaselineChanged(backupDir, installDir);

	// ─── 9. Install workspace dependencies ─────────────────────
	try {
		info('Running npm ci in installed dir (this can take a minute)...');
		runOrThrow('npm', ['ci', '--no-audit', '--no-fund'], { cwd: installDir });
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
	try {
		info('Building the web frontend (apps/web)...');
		runOrThrow('npm', ['run', 'build'], { cwd: join(installDir, 'apps', 'web') });
	} catch (err) {
		// Nothing served has been touched yet (the build writes to
		// apps/web/build inside the install), so a build failure rolls back
		// cleanly.
		warn('Frontend build failed; rolling back.');
		return rollback(installDir, backupDir, tmpDir, err);
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
		restartFrontendContainer(plan.restartContainer);
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
			const servedVersion = await resolveServedVersion(plan, webRoot);
			const verdict = classifyFrontendVerify(builtVersion, servedVersion);
			if (verdict === 'fresh') {
				info(
					`\u2713 Verified the live frontend is serving this build ` +
						`(version ${builtVersion}). Returning visitors get the ` +
						`"Load it now" update prompt within ~60s.`
				);
			} else if (verdict === 'stale') {
				warn(
					`The frontend being SERVED is still the old build (version ` +
						`${servedVersion}); this upgrade built ${builtVersion}. The ` +
						`"Load it now" update prompt will NOT appear until the served ` +
						`build matches. ` +
						(plan.restartContainer
							? `Your frontend container "${plan.restartContainer}" is serving ` +
								`a stale copy: if it bind-mounts ${buildDir}, ` +
								`"docker restart ${plan.restartContainer}" should fix it; if ` +
								`it BAKES the build into its image, rebuild that image so it ` +
								`includes the new build.`
							: `Check that ${webRoot} received the new build and that your ` +
								`web server is not caching /verify.json or /service-worker.js.`)
				);
			} else {
				info(
					`(Could not auto-verify the served frontend. Check it with: ` +
						`curl -s <your-site>/verify.json — its "morphit_version" should ` +
						`match this build.)`
				);
			}
		} catch {
			// verification is best-effort; never fail the upgrade over it
		}
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
		const dep = spawnSync('bash', [deployScript, installDir, mcpDest, mcpUser], {
			stdio: 'inherit'
		});
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
			} else if (!mcpWasActive) {
				info('Started morphit-mcp (it was not previously active).');
			}
		}
	} else {
		info('Skipping MCP redeploy (morphit-mcp.service is not installed on this host).');
	}

	// Safeguard: a manually-run indexer/relay (not the systemd units handled
	// above) is now orphaned on the OLD code — the dir swap moved its source
	// out from under it, and we can't restart a service we don't manage. Say
	// so loudly so morphit.io doesn't silently keep serving stale code.
	const orphaned = pidsWithCwdUnder(backupDir);
	if (orphaned.length > 0) {
		warn(
			`${orphaned.length} process(es) are still running from the previous ` +
				`install at ${backupDir} (PIDs ${orphaned.join(', ')}) — they are now ` +
				`on the OLD code and are not systemd-managed, so this upgrade could not ` +
				`restart them. Restart them from ${installDir}, or install the systemd ` +
				`units in ops/systemd/ so future upgrades restart them automatically.`
		);
	}

	// ─── 11. Cleanup + prune old backups ───────────────────────
	cleanupTmp(tmpDir);
	pruneOldBackups(installDir);

	info('');
	info(`✓ Upgrade complete: ${currentTag} → ${latestTag}`);
	info(`Previous install kept at: ${backupDir}`);

	if (schemaChanged) {
		info('');
		info('⚠ The database schema changed in this version.');
		info('  Existing indexer data is rebuilt from the chain, so this is safe to');
		info('  fix. Run `morphit-ops doctor` — it now checks whether your DB needs');
		info('  a reset, and OPERATIONS.md §46 has the reset + re-sync steps.');
	}

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
