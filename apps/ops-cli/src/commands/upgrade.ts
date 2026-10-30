/**
 * morphit-ops upgrade — check for and apply Morphit releases.
 *
 * initial implementation.  Manual-only by default
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
 *                                  download; the tarball must match @morphit's
 *                                  signed on-chain release record or carry a
 *                                  pinned signature (see below). Its prebuilt
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
 * Integrity model. A tarball is installed only when one of these holds:
 *
 *   - Its SHA-256 equals the hash in @morphit's `morphit_release_v1` record
 *     for that exact version, read from the chain through this node's own
 *     indexer and checked by recovering the transaction signature to the
 *     posting key pinned in @morphit/operator-config (lib/releaseAnchor.ts).
 *     This works on every path: clearnet, offline and hidden-only.
 *
 *   - It carries a detached signature (`*.tar.gz.asc`) that gpg reports good
 *     AND that was made by a fingerprint pinned in @morphit/operator-config.
 *     The key material comes from the running install's
 *     `.forgejo/release-signers/`, but a key a release adds there is not
 *     trusted unless its fingerprint is pinned.
 *
 *   The Forgejo primary's `.tar.gz.sha256` is only a transit check: when it is
 *   there it must match the bytes and agree with the chain, but it never makes
 *   a tarball installable on its own. Mirrors carry bytes; they decide nothing.
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

import { readNoFollow, writeNoFollow } from '../lib/noFollowFs.ts';
import {
	tryResolveHiddenUpgrade,
	readHiddenReleaseTarget,
	readOnchainReleaseTag,
	readReleaseRecordHint,
	isHiddenOnly,
	type HiddenUpgradeResolution,
	RELEASE_VERSION_RE
} from '../init/hiddenUpgradeResolve.js';
import {
	HiddenUpgradeWaitError,
	renderHiddenWait,
	parseWaitChoice,
	formatDuration,
	KEEP_TRYING_EVERY_MS,
	KEEP_TRYING_FOR_MS,
	type HiddenWaitChoice
} from '../init/hiddenUpgradeWait.ts';
import {
	indexerUnitEnvFiles,
	locateLocalIndexer,
	getLocalIndexerJson,
	type ListenerVerifier,
	type LocalIndexerOptions
} from '../init/hiddenUpgradeLocalIndexer.ts';
import {
	normalizeContactUrl,
	INSTANCE_ENV,
	MORPHIT_RELEASE_ACCOUNT,
	MORPHIT_OFFICIAL_POSTING_PUBKEY,
	RELEASE_SIGNER_FINGERPRINTS,
	BLURT_MAINNET_CHAIN_ID,
	normalizeFingerprint
} from '@morphit/operator-config';
import {
	findSignedReleaseAnchor,
	RECORD_MAX_PAGES_HIDDEN,
	RECORD_PAGE_SIZE_HIDDEN,
	RECORD_READ_TIMEOUT_HIDDEN_MS,
	type CondenserRead,
	type ReleaseAnchor
} from '../lib/releaseAnchor.ts';
import { chainRead, directNodeReaders } from '../lib/chainAccess.ts';
import {
	installDepsForHiddenNode,
	lockedTreeProblems,
	carryNativeAddons,
	withoutProxyEnv
} from '../lib/depsInstall.ts';
import { withSpinner, startDotsSpinner, startPausableSpinner } from '../init/spinner.ts';
import { runAsync, runSpinning, showOutput, sleepMs, systemctlSpinning } from '../lib/spinRun.ts';
import { healIpfsPrivacy } from '../lib/ipfsPrivacyHeal.ts';
import { healIpfsGc } from '../lib/ipfsGcHeal.ts';
import {
	fetchFrontendBaseThroughTor,
	realBaseFetchRuntime,
	type BaseFetchRuntime
} from '../lib/frontendBaseFetch.ts';
import { healTorOnlyOs } from '../lib/torOnlyOsHeal.ts';
import { healClockFallback, realClockFallbackRuntime } from '../lib/clockFallbackHeal.ts';
import { heal as healServicePrivileges } from '../lib/unitPrivilegeHeal.ts';
import { heal as healForwarding } from '../lib/sysctlForwardHeal.ts';
import { heal as healTlsRenewalHeal } from '../lib/tlsRenewHeal.ts';
import {
	dnsLookup,
	healBunkerWebWww,
	applyWaitMs,
	upstreamResolvers,
	WWW_DB_PY,
	WWW_RULE_FILE,
	type ApplyResult,
	type SiteList,
	type WwwRuntime
} from '../lib/bunkerwebWww.ts';
import type { HealCtx, HealResult } from '../lib/healTypes.ts';
import {
	healMatrixBotTorOnly,
	realMatrixTorOnlyRuntime,
	recheckStoppedMatrixBot
} from '../lib/matrixTorOnlyHeal.ts';
import { heal as healBridgeCidr } from '../lib/bridgeCidrHeal.ts';
import { healNodeRuntime } from '../lib/nodeRuntimeHeal.ts';
import { heal as healNginxVhosts } from '../lib/nginxVhostHeal.ts';
import { heal as healHiddenRpcEnv } from '../lib/hiddenRpcEnvHeal.ts';
import { heal as healRelayHealthEnv } from '../lib/relayHealthEnvHeal.ts';
import { healReleaseMonitor, realReleaseMonitorRuntime } from '../lib/releaseMonitorHeal.ts';
import { closeQuietly, codeHostAgent } from '../lib/codeHostAgent.ts';
import { heal as healPgRoles } from '../lib/pgRoleHeal.ts';
import { heal as healIndexerEnvShadow } from '../lib/indexerEnvShadowHeal.ts';
import { heal as healDisplayShadow } from '../lib/displayShadowHeal.ts';
import { heal as healTorPow } from '../lib/torPowHeal.ts';
import { heal as healTorBridges } from '../lib/torBridgesHeal.ts';
import { heal as healEtcPerms } from '../lib/etcPermHeal.ts';
import { heal as healMailRelay } from '../lib/mailRelayHeal.ts';
import { heal as healVapid } from '../lib/vapidHeal.ts';
import { heal as healLogLevel } from '../lib/logLevelHeal.ts';
import { heal as healTorOnlyEgress } from '../lib/torOnlyEgressHeal.ts';
import { heal as healIndexerMemory } from '../lib/indexerMemoryHeal.ts';
import { heal as healOsQuiet } from '../lib/osQuietHeal.ts';
import { heal as healBunkerwebJobs } from '../lib/bunkerwebJobsHeal.ts';
import { healCanaryRefreshRepo, realCanaryRepoRuntime } from '../lib/canaryRepoHeal.ts';
import { resolveInstanceOrigin, syncInstanceOrigin } from '../lib/instanceOrigin.ts';
import {
	healEmptyFeeAddressLines,
	realFeeAddressRuntime,
	verifyFeeAddressHeal
} from '../lib/feeAddressEmptyHeal.ts';
import {
	AFTER_RESTART_UNIT,
	afterRestartDeadline,
	afterRestartLogPath,
	baseFetchBudgetMs,
	launchAfterRestartHeals,
	waitForRestarts,
	waitForAnswers,
	waitForUnitIdle
} from '../lib/afterRestartHeal.ts';
import { removeStaleRegPassFiles } from './register.ts';
import { UPSTREAM_CANARY_KEY_FPR, armoredKeyFingerprints } from '../init/installSummary.ts';
import {
	relayJournalNotice,
	JOURNAL_NOTICE_MARKER,
	noticeMarkerExists,
	writeNoticeMarker
} from '../lib/journalNotice.ts';
import {
	healProxyConfig,
	SELF_HEAL_CHILD_TIMEOUT_MS,
	parseDockerInspect,
	identifyContainers,
	composeRefOf,
	composeArgs,
	composeCommand,
	parseComposeModel,
	serverNameOf,
	type ContainerInfo,
	type ComposeRef
} from '../lib/proxyConfigHeal.ts';
import {
	measuredSchedulerCycleMs,
	waitForSchedulerCycle,
	type SchedulerCycle
} from '../lib/bunkerwebScheduler.ts';
import {
	copyCount,
	listRuleCopies,
	modsecRuleFix,
	planRuleDedupe,
	removeRuleCopies,
	restoreRuleCopies,
	type RemovedCopies
} from '../lib/bunkerwebRuleDedupe.ts';
import {
	healFeeRecipientRegistration,
	type FeeRecipientHealOutcome
} from '../lib/feeRecipientHeal.ts';
import { healRelayStateDir, startIfEnabledButStopped } from '../lib/relayStateHeal.ts';
import {
	describeWebHeal,
	followWebHeal,
	launchWebHeal,
	readWebHealState,
	webHealLogPath,
	webHealStatusRow,
	WEB_HEAL_MAX_S,
	WEB_HEAL_UNIT,
	writeWebHealState,
	type WebHealState
} from '../lib/webHeal.ts';
import { isHiddenOnlyNode, localIndexerBases, readLocalRelease } from '../lib/hiddenOnly.ts';
import { healNpmUpdateNotice as healNpmNoticeGlobal } from '../lib/npmNotice.ts';
import {
	applyBranding,
	brandingConfigured,
	checkServedOgImage,
	readBrandingSettings,
	syncTouchedToWebRoot,
	BRAND_SLOTS_FILE
} from '../lib/branding.ts';
import {
	readFileSync,
	writeFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	readdirSync,
	statSync,
	copyFileSync,
	cpSync,
	readlinkSync,
	chmodSync,
	openSync,
	readSync,
	writeSync,
	closeSync,
	fstatSync,
	realpathSync,
	constants as fsConstants
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';

import {
	error as printError,
	info,
	warn,
	warningCount,
	plainText,
	sanitizeForTerm
} from '../render/term.ts';
import { refreshManagedUnits } from '../lib/refreshUnits.ts';
import {
	describeHelperRefresh,
	refreshHelperScripts,
	DEFAULT_HELPER_DIR,
	HELPER_SCRIPTS
} from '../lib/refreshHelperScripts.ts';
import {
	applyAndVerifyRelayHeal,
	relayHealBackupPath,
	readEffectiveEnv,
	INDEXER_ENV_FILES,
	RELAY_ENV_FILES,
	RELAY_ENV_TARGETS
} from '../lib/relayHiddenHeal.ts';
import { daemonReload } from '../lib/restartServices.ts';
import { healXmrExplorerList } from '../lib/feeExplorerListHeal.ts';
import { healBtcExplorerList } from '../lib/btcFeeExplorerListHeal.ts';
import { chooseCanaryDirOwner, parsePasswdRefreshTarget } from '../lib/canaryDirOwner.ts';
import { type CanaryCarry, carryCanaryForward } from '../lib/canaryCarry.ts';
import {
	detectDbContainerAsync,
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
	MATRIX_BOT_ENV_PATH,
	matrixBotReadiness,
	readMatrixBotEnv,
	syncMatrixBotServiceAtTerminal,
	writeMatrixBotPosture
} from '../lib/matrixBot.ts';

interface UpgradeFlags {
	readonly 'check-only'?: string;
	readonly yes?: string;
	readonly json?: string;
	readonly [key: string]: string | undefined;
}

interface RunUpgradeOptions {
	readonly flags: UpgradeFlags;
	readonly positional: readonly string[];
	/** Where this node's own indexer answers. Tests only; the default is the
	 *  loopback + docker-bridge list the hidden resolver already uses. */
	readonly localIndexerBases?: readonly string[];
	/** How the local indexer's listener is authenticated. Tests only; the
	 *  default proves from /proc that it is morphit-indexer.service.
	 * */
	readonly verifyLocalIndexer?: ListenerVerifier;
	/** The release trust anchors. Tests only; the default is the pinned set in
	 *  @morphit/operator-config and chain reads through lib/chainAccess.ts. */
	readonly trust?: {
		readonly postingPubkey?: string;
		readonly signerFingerprints?: readonly string[];
		readonly chainRead?: CondenserRead;
	};
	/** What an up-to-date box runs instead of an upgrade. Tests only; the
	 *  default is this release's heals (runHealsAgain). */
	readonly healsWhenUpToDate?: () => Promise<number>;
	/** The clock the release-record wait runs on. Tests only. */
	readonly anchorWait?: {
		readonly now?: () => number;
		readonly sleep?: (ms: number) => Promise<void>;
	};
	/** The account it runs as (default: this process's uid). Tests only. */
	readonly uid?: number;
	/** v1.21.6: a zero-clearnet wait — whether it may ask, how it asks, and the
	 *  pause between "keep trying" tries. Tests only. */
	readonly hiddenWait?: {
		readonly interactive?: boolean;
		readonly ask?: () => Promise<HiddenWaitChoice>;
		readonly sleep?: (ms: number) => Promise<void>;
		readonly now?: () => number;
	};
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
/** How long the upgrade keeps asking for a release record no node lists yet
 *  (a record broadcast moments ago, or nodes behind the chain) before it
 *  refuses an unsigned release. */
export const RELEASE_RECORD_WAIT_MS = 180_000;

/** v1.21.6: how long a ZERO-CLEARNET upgrade keeps asking its own indexer for
 *  the signed release record when no answer comes in time (each read may take
 *  a minute over Tor/I2P) or the answer lacks the record. morphitlat,
 *  2026-10-10: two upgrades stopped after one 60-second read; the third went
 *  through a minute later. */
export const HIDDEN_RELEASE_RECORD_WAIT_MS = 8 * 60_000;

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
const SERVICES_TO_RESTART = ['morphit-indexer.service', 'morphit-relay.service'];

// ─── Mirror fallback + source-independent integrity (beta5) ─────────
//
// Which source the bytes come from does not matter for trust: see the
// integrity model in the header and integrityGate().

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
		const spec = raw
			.trim()
			.replace(/^https?:\/\//, '')
			.replace(/\/+$/, '');
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
 *  Trust is the same as online: the tarball must match the hash in @morphit's
 *  signed on-chain release record (read through this node's own indexer), or
 *  carry a good signature from a pinned release-signer key. Otherwise it is
 *  refused. */
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
		throw new Error(
			`--from-file: expected a .tar.gz release tarball, got ${basename(tarballPath)}`
		);
	}
	if (!SAFE_ASSET_NAME.test(basename(tarballPath))) {
		throw new Error(
			`--from-file: rename the tarball to its release name (like morphit-v1.18.0-offline.tar.gz); ` +
				`only letters, digits, dots, dashes and underscores are accepted.`
		);
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
 * for a node whose clearnet is filtered upstream). On every upgrade, if the
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

/** Step 10's onion heal, for the upgrade: when it put this node's onion into
 *  the config, the operator re-publishes the registration — named in the last
 *  lines, with the command that does it (`register`, the main menu's
 *  "Re-publish my registration on-chain"). Never throws. */
export function captureTorOnion(configPath: string, onionPath?: string): void {
	try {
		const heal = healTorOnionInConfig(configPath, onionPath);
		if (heal.healed) {
			info(`Captured this node's Tor onion into the config so it's advertised: ${heal.onion}`);
			leftForYou.push(
				"Tell the federation about this node's Tor address (it was just added to the config): on this server, sudo morphit-ops register (in the menu: Re-publish my registration on-chain)"
			);
		}
	} catch {
		/* non-fatal — the node still works over clearnet */
	}
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
	// Prerelease identifiers as semver orders them: dot by dot, numbers as
	// numbers (rc.10 after rc.9), a number before a word, more after fewer.
	const xa = pa.pre!.split('.');
	const xb = pb.pre!.split('.');
	for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
		const ia = xa[i];
		const ib = xb[i];
		if (ia === undefined) return -1;
		if (ib === undefined) return 1;
		const na = /^\d+$/.test(ia);
		const nb = /^\d+$/.test(ib);
		if (na && nb) {
			if (Number(ia) !== Number(ib)) return Number(ia) - Number(ib);
		} else if (na !== nb) {
			return na ? -1 : 1;
		} else if (ia !== ib) {
			return ia < ib ? -1 : 1;
		}
	}
	return 0;
}

/** Is `latest` a strictly newer release than the installed `current`? When
 *  both are version numbers this is compareTags() > 0 — an OLDER or equal tag
 *  is never an upgrade. When the installed version
 *  cannot be read, any different tag counts, as before. PURE. */
export function isNewerRelease(latest: string, current: string): boolean {
	const isVer = (t: string): boolean => /^v?\d+\.\d+\.\d+(?:-.+)?$/.test(t.trim());
	if (isVer(latest) && isVer(current)) return compareTags(latest, current) > 0;
	return latest !== current;
}

/** Does this box serve /canary.txt for its own origin? Asked on loopback.
 *  this was an `sh -c` string built from the
 *  configured origin's host with no quoting, so a value like `x;cmd` ran `cmd`
 *  as root. It is now curl with an argument list, and a host that is not a
 *  host name is not probed at all. */
export function probeLiveCanary(origin: string): boolean {
	const args = liveCanaryCurlArgs(origin);
	if (args === null) return false;
	return spawnSync('curl', args, { stdio: 'ignore', timeout: 20_000 }).status === 0;
}

/** {@link probeLiveCanary} without blocking the event loop (up to 15 s), so the
 *  upgrade's spinner keeps turning while it is asked. */
async function probeLiveCanaryAsync(origin: string): Promise<boolean> {
	const args = liveCanaryCurlArgs(origin);
	if (args === null) return false;
	return (await runAsync('curl', args, { timeoutMs: 20_000 })).status === 0;
}

/** curl's argument list for the live-canary probe; null when `origin` does not
 *  name a host (never probed). PURE. */
function liveCanaryCurlArgs(origin: string): string[] | null {
	const host = origin.replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
	if (!/^[A-Za-z0-9.-]+$/.test(host)) return null;
	return [
		'-fsS',
		'-o',
		'/dev/null',
		'--max-time',
		'15',
		'-k',
		'--noproxy',
		'*',
		'--resolve',
		`${host}:443:127.0.0.1`,
		`https://${host}/canary.txt`
	];
}

/** Do two tags name the same release? A leading "v" is optional. PURE. */
export function sameReleaseTag(a: string, b: string): boolean {
	return a.trim().replace(/^v/, '') === b.trim().replace(/^v/, '');
}

/** Scan the offline drop-dir for the newest release tarball an operator has
 *  left there, with its sibling `.asc` when there is one. A release publishes
 *  the offline bundle without an `.asc`; step 6 then checks it against the
 *  `offline_sha256` in @morphit's signed release record, and refuses it when
 *  neither that nor a pinned signature is available. Returns the newest
 *  {tarballPath, sigPath, tag} or null. Never throws. */
export function findLocalOfflineRelease(
	installDir: string
): { tarballPath: string; sigPath: string | null; tag: string } | null {
	const dir = offlineReleaseDir(installDir);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null; // dir absent / unreadable — nothing dropped
	}
	let best: { tarballPath: string; sigPath: string | null; tag: string } | null = null;
	for (const name of names) {
		if (!name.endsWith('.tar.gz') || name.endsWith('.sha256.tar.gz')) continue;
		if (!SAFE_ASSET_NAME.test(name)) continue;
		const tag = parseTagFromTarballName(name);
		if (tag === null) continue;
		const tarballPath = join(dir, name);
		const sigPath = existsSync(`${tarballPath}.asc`) ? `${tarballPath}.asc` : null;
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
		// read. Offline, step 6 needs the signed on-chain record or a pinned signature.
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

/** A release asset name that is a plain file name (no path, no spaces). */
export const SAFE_ASSET_NAME = /^[A-Za-z0-9._-]+$/;

/** Pick the tarball + sha256 + (optional) detached GPG signature out of a
 *  release's assets. Returns null if the required tarball+sha pair is
 *  missing. PURE. */
export function selectReleaseAssets(
	allAssets: readonly ForgejoReleaseAsset[]
): SelectedAssets | null {
	// Asset names come from the release source — a
	// mirror when the primary is down — and name files in the temp dir:
	// join(tmpDir, '../../etc/x.tar.gz') is /etc/x.tar.gz, written as root. An
	// asset whose name is not a plain file name is ignored.
	const assets = allAssets.filter((a) => SAFE_ASSET_NAME.test(a.name));
	const tarballs = assets.filter(
		(a) => a.name.endsWith('.tar.gz') && !a.name.endsWith('.sha256.tar.gz')
	);
	// Prefer the SLIM canonical tarball (morphit-<ver>.tar.gz) for ONLINE upgrades:
	// it's the artifact the SHA-256 anchor + verify-download are built around, and
	// it's small (deps are restored by `npm ci`). The self-contained
	// morphit-<ver>-offline.tar.gz is a SEPARATE, far larger artifact with its OWN
	// hash, meant only for --from-file / drop-dir installs. this function
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
	| 'onchain-anchored-sha256'
	| 'hidden-federation-onchain-sha256';

/** What checking a release's detached signature found. */
export type SignatureCheck =
	/** No .asc came with the release. */
	| 'absent'
	/** gpg reported a good signature from a PINNED release-signer fingerprint. */
	| 'valid'
	/** A signature was there and gpg ran, and it did NOT verify, or it was made
	 *  by a key that is not pinned. */
	| 'invalid'
	/** It could not be checked here at all (no gpg, no signer keys). */
	| 'unverifiable';

/**
 * The whole step-6 decision, as run by runUpgrade. PURE.
 *
 * Two things can make a tarball installable, and nothing else:
 *   - its SHA-256 equals the hash in the `morphit_release_v1` op whose
 *     signature recovers to @morphit's pinned posting key (`chainHash`, read by
 *     lib/releaseAnchor.ts), or
 *   - a detached signature from a PINNED release-signer fingerprint.
 * The Forgejo primary's `.sha256` (`primaryHash`) is a transit check only: it
 * must match the bytes when present, and it must agree with the chain, but it
 * is never enough on its own. Before this, an unsigned tarball whose hash the
 * primary vouched for was installed as root on every clearnet node, and the
 * offline and hidden paths took the hash from the local indexer's
 * `/v1/release`, which repeats what one RPC node served.
 *
 * Kept from v1.18.0 (ops-2, ops-3): a present signature that does not verify
 * refuses, and a valid signature never overrides a known hash mismatch (a
 * signature is not bound to a version; the chain record is).
 */
export function integrityGate(args: {
	signature: SignatureCheck;
	/** The hash the signed on-chain record names for THIS tarball variant, or
	 *  null when there is no such record (or it names no hash for the variant). */
	chainHash: string | null;
	/** The `.sha256` the trusted primary served, or null (offline, primary down). */
	primaryHash: string | null;
	actualHash: string;
	/** Fetched over Tor/I2P from a federation peer (hidden-only node). */
	hidden: { servedBy: string; tag: string } | null;
}): { allowed: boolean; proof: IntegrityProof | null; reason: string } {
	const refuse = (reason: string) => ({ allowed: false, proof: null, reason });
	if (args.signature === 'invalid') {
		return refuse(
			'The release came with a signature (.asc), but it is not a good signature from a pinned ' +
				'release-signer key. Nothing was changed. Try again later; if it keeps happening, the ' +
				'release source is serving files that were altered.'
		);
	}
	if (args.chainHash !== null && args.primaryHash !== null && args.chainHash !== args.primaryHash) {
		return refuse(
			`The release hash @morphit signed on chain and the hash the release host serves disagree.\n` +
				`  On chain: ${args.chainHash}\n` +
				`  Host:     ${args.primaryHash}\n` +
				'  Nothing was changed. The release host is serving a different file than the one @morphit published.'
		);
	}
	for (const [from, want] of [
		['the signed on-chain record', args.chainHash],
		['the release host', args.primaryHash]
	] as const) {
		if (want !== null && want !== args.actualHash) {
			return refuse(
				`SHA-256 mismatch on the downloaded tarball.\n` +
					`  Expected (from ${from}): ${want}\n` +
					`  Actual:  ${args.actualHash}\n` +
					'  Nothing was changed. The tarball was altered in transit, or the SHA file is stale.'
			);
		}
	}
	if (args.chainHash !== null) {
		return args.hidden !== null
			? {
					allowed: true,
					proof: 'hidden-federation-onchain-sha256',
					reason: `Fetched over Tor/I2P from ${args.hidden.servedBy} and matched the SHA-256 in @morphit's signed release record for ${args.hidden.tag}.`
				}
			: {
					allowed: true,
					proof: 'onchain-anchored-sha256',
					reason:
						"SHA-256 matched the hash in @morphit's release record on chain (signature checked against the pinned posting key)."
				};
	}
	if (args.signature === 'valid') {
		return {
			allowed: true,
			proof: 'gpg-signature',
			reason: 'Good signature from a pinned release-signer key.'
		};
	}
	return refuse(
		args.signature === 'unverifiable'
			? 'The release signature could not be checked on this box (gpg or the signer keys are missing), and ' +
					"no signed on-chain release record names this tarball's hash. Nothing was changed."
			: 'The release is not signed, and no signed on-chain release record names its hash. Nothing was ' +
					'changed. If the release was published moments ago, its on-chain record may not be broadcast yet: ' +
					'try again later.'
	);
}

/** True iff `gpg` is on PATH. */
function gpgAvailable(): boolean {
	return spawnSync('which', ['gpg'], { stdio: 'pipe', timeout: 3000 }).status === 0;
}

/** The fingerprints a VALIDSIG status line names: the signing key and, when a
 *  subkey signed, its primary key. PURE. */
export function validSigFingerprints(statusOutput: string): string[] {
	const out: string[] = [];
	for (const line of statusOutput.split('\n')) {
		const m = /^\[GNUPG:\] VALIDSIG (.*)$/.exec(line.trim());
		if (!m) continue;
		const f = (m[1] ?? '').trim().split(/\s+/);
		if (f[0]) out.push(normalizeFingerprint(f[0]));
		const primary = f[9];
		if (f.length >= 10 && primary) out.push(normalizeFingerprint(primary));
	}
	return out;
}

/** Verify a detached signature; true only for a good signature from a pinned
 *  release-signer fingerprint. */
export function verifyDetachedSignature(
	installDir: string,
	tarballPath: string,
	sigPath: string,
	pinned: readonly string[] = RELEASE_SIGNER_FINGERPRINTS
): boolean {
	return checkDetachedSignature(installDir, tarballPath, sigPath, pinned) === 'valid';
}

/** Check a detached signature in a throwaway keyring (never the operator's
 *  ~/.gnupg). The key MATERIAL comes from the running install's
 *  `.forgejo/release-signers/*.asc`; whether a signature counts is decided by
 *  `pinned`, the fingerprints in @morphit/operator-config. A good signature from
 *  any other key — one a release added to its own signer directory, say — is
 *  'invalid', exactly like a bad one. */
export function checkDetachedSignature(
	installDir: string,
	tarballPath: string,
	sigPath: string,
	pinned: readonly string[] = RELEASE_SIGNER_FINGERPRINTS
): SignatureCheck {
	if (!gpgAvailable()) {
		info(
			'gpg is not installed on this box, so the release signature cannot be checked here; the signed on-chain record is used instead.'
		);
		return 'unverifiable';
	}
	const signersDir = join(installDir, '.forgejo', 'release-signers');
	if (!existsSync(signersDir)) return 'unverifiable';
	const keyFiles = readdirSync(signersDir).filter((f) => f.endsWith('.asc'));
	if (keyFiles.length === 0) return 'unverifiable';
	const allowed = new Set(pinned.map(normalizeFingerprint));

	const gnupgHome = mkdtempSync(join(tmpdir(), 'morphit-gpg-'));
	// gpg runs synchronously (up to 15 s per key, 20 s to verify): the spinner's
	// label is on the line for the whole check, and taken off before a warning.
	const spin = startPausableSpinner('Checking the release signature…');
	try {
		// Lock down the throwaway home (gpg insists on 0700).
		spawnSync('chmod', ['700', gnupgHome], { stdio: 'ignore' });
		let imported = 0;
		for (const kf of keyFiles) {
			const imp = spawnSync(
				'gpg',
				['--homedir', gnupgHome, '--batch', '--import', join(signersDir, kf)],
				{
					stdio: 'pipe',
					timeout: 15000
				}
			);
			if (imp.status !== 0) {
				spin.say(() => warn(`Could not import release-signer key ${kf}.`));
			} else {
				imported++;
			}
		}
		if (imported === 0) return 'unverifiable';
		const res = spawnSync(
			'gpg',
			['--homedir', gnupgHome, '--batch', '--status-fd', '1', '--verify', sigPath, tarballPath],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }
		);
		spin.stop();
		const status = typeof res.stdout === 'string' ? res.stdout : '';
		// A trustworthy result = a zero exit AND a VALIDSIG line naming a pinned key.
		if (res.status !== 0) return 'invalid';
		return validSigFingerprints(status).some((f) => allowed.has(f)) ? 'valid' : 'invalid';
	} finally {
		spin.stop();
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
export function classifyMcpHealth(
	status: number,
	bodyText: string
): 'ok' | 'bad_status' | 'bad_body' {
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
			lastDetail =
				verdict === 'bad_status' ? `HTTP ${res.status}` : `HTTP ${res.status}, unexpected body`;
		} catch (e) {
			lastDetail = e instanceof Error ? e.message : String(e);
		} finally {
			clearTimeout(timer);
		}
		if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
	}
	return { reachable: false, detail: lastDetail };
}

/** The IPFS seed script's exit code (step 12), for the operator:
 *  0 seeded and checked; 3 seeded, but a check it printed with a "⚠" needs the
 *  operator (peers cannot fetch from this box, or it advertises a wrong
 *  address) — a warning, never a ✓ after those lines; anything else did not
 *  finish. Exported for its test. */
export function reportSeedResult(tag: string, code: number): void {
	// Its own last line already says "✓ Seeded <tag> to IPFS: …" with what was
	// checked (v1.21.17 audit, L1: one line, not five).
	if (code === 0) return;
	if (code === 3) {
		warn(
			`Seeded ${tag} to IPFS, but its checks above (the lines marked ⚠) found something to fix on this server: ` +
				'until it is fixed, peers cannot fetch the release from this box (or reach it at the address it advertises). ' +
				'Each of those lines says what to do; to check again afterwards: sudo morphit-ops harden → "Seed this release to IPFS"'
		);
		return;
	}
	// Say what is actually unfinished. "Did not complete" left an operator
	// unsure whether peers could fetch from this box at all: the CID had
	// been announced, but the Tor/I2P verification had not run. Name that,
	// and give a command that WORKS — the raw script needs a tag argument,
	// so pointing at it bare produces a usage error.
	warn(
		'IPFS self-seed did not finish its checks (non-fatal). The release itself is ' +
			'unaffected — git mirrors + the on-chain SHA-256 are the anchors — but this ' +
			'box has NOT confirmed it serves the release over Tor/I2P, so hidden-only ' +
			'peers may not be able to upgrade from it yet. Re-run the checks with: ' +
			'sudo morphit-ops harden → "Seed this release to IPFS"'
	);
}

/** Step 10b-reach: after its restart, does the MCP answer its health check?
 *  Up to ~20 s of retries while it binds its listener, under a spinner (never
 *  a silent pause). ✓ when it answers, else a warning with where to look.
 *  True when it answered. Exported for its test. */
export async function checkMcpAnswers(
	mcpHost: string,
	mcpPort: number,
	probeOpts: { attempts?: number; delayMs?: number; timeoutMs?: number } = {}
): Promise<boolean> {
	const healthUrl = buildMcpHealthUrl(mcpHost, mcpPort);
	const probe = await withSpinner('Checking the MCP server answers on its new version…', () =>
		probeMcpHealth(healthUrl, probeOpts)
	);
	if (probe.reachable) {
		info('✓ MCP server redeployed for this release, restarted, and answering its health check.');
		return true;
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
		return false;
	}
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

/** Every-upgrade Docker-aware assurance (v1.8.4 B): if the operator has
 *  a backup configured but its DB_CONTAINER is empty WHILE their Postgres is
 *  actually containerized, the daily backup is dumping the host (= nothing).
 *  Detect that drift and WARN with the exact one-line fix. Best-effort + never
 *  throws: an unreadable/absent backup.env, or a host Postgres, is a silent
 *  no-op. We deliberately do NOT auto-edit the operator's root-owned /etc
 *  config (same warn-don't-mutate posture as the MCP + canary checks). IMPURE. */
async function ensureBackupDockerAware(installDir: string): Promise<void> {
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
		const detected = await withSpinner('Checking the backup reaches the database…', () =>
			detectDbContainerAsync(dbUser, dbName)
		);
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
 * this used to be a raw byte-diff of schema.sql, and it lied on every
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
 *  v1.8.12 — `schemaBaselineChanged()` alone is not that question. It
 *  diffs schema.sql and nothing else, so ANY schema edit triggered the
 *  "changed IN PLACE — not via a numbered migration" warning, even when a
 *  numbered migration existed and had already been applied automatically at
 *  indexer start-up.
 *
 *  The maintainer hit exactly that upgrading to v1.8.12, which ships MIGRATION 51: his
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
		throw new Error(`Frontend deploy did not produce ${join(webRoot, 'index.html')}.`);
	}
}

/** How to PUBLISH a freshly-built frontend after the (always-run) build.
 *  beta11 (supersedes). */
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
 *  beta11 — `frontendContainer` REPLACES the container-present boolean.
 *  A later change assumed the container was named "morphit-frontend" and
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
 *  compose file (the two wrong assumptions).  Returns the container
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

/** {@link findFrontendContainer} without blocking the event loop (docker can
 *  take seconds per call on a busy box), so the spinner keeps turning. */
async function findFrontendContainerAsync(buildDir: string): Promise<string | null> {
	if ((await runAsync('docker', ['--version'], { timeoutMs: 5000 })).status !== 0) return null;
	const ps = await runAsync('docker', ['ps', '--format', '{{.Names}}'], { timeoutMs: 5000 });
	if (ps.status !== 0) return null;
	const names = ps.stdout
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	for (const name of names) {
		const insp = await runAsync(
			'docker',
			['inspect', '--format', '{{range .Mounts}}{{.Source}}\n{{end}}', name],
			{ timeoutMs: 5000 }
		);
		if (insp.status !== 0) continue;
		if (containerMountsBuildDir(parseMountSources(insp.stdout), buildDir)) return name;
	}
	return null;
}

/** `docker restart <name>` so the container re-binds the freshly-built
 *  apps/web/build on start (a running container keeps serving the
 *  pre-upgrade inode after the install dir was renamed).  BEST-EFFORT — a
 *  failure here must NOT roll the upgrade back (the backend is already
 *  upgraded and the build is fresh on disk); we warn with the manual
 *  command instead.  No name assumption: the exact container we detected,
 *  rebuilt through its own Compose project (from its labels) when it has one.
 *  Exported for its test.  IMPURE. */
/** Section headings an operator must read before answering the upgrade
 *  question (how to upgrade, what a zero-clearnet node must do, what every node
 *  is asked afterwards). Always shown in full, up to MUST_READ_MAX lines each. */
const MUST_READ =
	/^#{2,3}\s+(?:upgrading\b|.*\b(?:zero-clearnet|every node|action needed|before upgrading|breaking)\b)/i;
const MUST_READ_MAX = 120;

/** PURE. The part of release notes worth showing before the upgrade question:
 *  the opening paragraphs, up to the first section heading (`## …`), at most
 *  `max` lines, without the title line; then every section an operator must
 *  read before answering (MUST_READ), in full. `more` is true when anything
 *  was left out. */
export function releaseNotesSummary(body: string, max = 14): { lines: string[]; more: boolean } {
	const all = body.replace(/\r/g, '').split('\n');
	const trimEnd = (l: string[]): string[] => {
		const out = [...l];
		while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
		return out;
	};
	let start = 0;
	if (/^#\s/.test(all[0] ?? '')) start = 1;
	while (start < all.length && all[start]!.trim() === '') start++;
	let end = start;
	while (end < all.length && !/^##\s/.test(all[end]!)) end++;
	let lines = all.slice(start, end);
	let more = false;
	if (lines.length > max) {
		lines = lines.slice(0, max);
		more = true;
	}
	lines = trimEnd(lines);
	if (lines.length === 0 && end >= all.length)
		return { lines: all.slice(0, max), more: all.length > max };
	// The sections after the opening: the must-read ones are shown, the rest counted.
	let i = end;
	while (i < all.length) {
		let j = i + 1;
		while (j < all.length && !/^##\s/.test(all[j]!)) j++;
		const take = (from: number, to: number): void => {
			let sec = trimEnd(all.slice(from, to));
			if (sec.length > MUST_READ_MAX) {
				sec = sec.slice(0, MUST_READ_MAX);
				more = true;
			}
			lines.push('', ...sec);
		};
		if (MUST_READ.test(all[i]!)) {
			take(i, j);
		} else {
			more = true;
			// A must-read `###` part inside another section is shown on its own.
			for (let k = i + 1; k < j; k++) {
				if (!/^###\s/.test(all[k]!) || !MUST_READ.test(all[k]!)) continue;
				let e = k + 1;
				while (e < j && !/^###\s/.test(all[e]!)) e++;
				take(k, e);
				k = e - 1;
			}
		}
		i = j;
	}
	return { lines, more };
}

/** PURE. The tarball member holding `tag`'s release notes, from `tar -tzf`'s
 *  listing: docs/release-notes/RELEASE-NOTES-<tag>.md since v1.21.1, at the top
 *  before. Null when there is none. */
export function releaseNotesMember(listing: string, tag: string): string | null {
	const name = `RELEASE-NOTES-${tag}.md`;
	for (const line of listing.split('\n')) {
		const m = line.trim();
		if (m === name || m.endsWith(`/${name}`)) return m;
	}
	return null;
}

/** The release notes inside a release tarball (a Tor/I2P-only node's download,
 *  or an offline bundle's tarball): the same bytes its SHA-256 covers, nothing
 *  fetched. Null when they cannot be read. IMPURE (runs tar). */
export function readNotesFromTarball(
	tarballPath: string,
	tag: string
): { body: string; member: string } | null {
	try {
		const list = spawnSync('tar', ['-tzf', tarballPath], {
			encoding: 'utf8',
			timeout: 60_000,
			maxBuffer: 64 * 1024 * 1024
		});
		if (list.status !== 0 || typeof list.stdout !== 'string') return null;
		const member = releaseNotesMember(list.stdout, tag);
		if (member === null) return null;
		const r = spawnSync('tar', ['-xzOf', tarballPath, member], {
			encoding: 'utf8',
			timeout: 60_000,
			maxBuffer: 8 * 1024 * 1024
		});
		if (r.status !== 0 || typeof r.stdout !== 'string' || r.stdout.trim() === '') return null;
		return { body: r.stdout.trim(), member };
	} catch {
		return null;
	}
}

/** {@link readNotesFromTarball} without blocking the event loop (tar reads the
 *  whole tarball, twice), so the spinner keeps turning while it runs. */
async function readNotesFromTarballAsync(
	tarballPath: string,
	tag: string
): Promise<{ body: string; member: string } | null> {
	const list = await runAsync('tar', ['-tzf', tarballPath], {
		timeoutMs: 60_000,
		maxOutputBytes: 64 * 1024 * 1024
	});
	if (list.status !== 0) return null;
	const member = releaseNotesMember(list.stdout, tag);
	if (member === null) return null;
	const r = await runAsync('tar', ['-xzOf', tarballPath, member], {
		timeoutMs: 60_000,
		maxOutputBytes: 8 * 1024 * 1024
	});
	if (r.status !== 0 || r.stdout.trim() === '') return null;
	return { body: r.stdout.trim(), member };
}

/** PURE. One line of Markdown as plain text for a terminal (v1.21.17 audit,
 *  L6: "**Operators: …**" and `sudo …` were printed with their marks):
 *  headings without their #, bold/italic and code marks dropped, a link as
 *  "text (address)", a list item with a bullet. */
export function plainMarkdown(line: string): string {
	return (
		line
			.replace(/^(\s*)#{1,6}\s+/, '$1')
			.replace(/^(\s*)[-*+]\s+/, '$1• ')
			.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
			.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
			// bold that runs over two lines leaves one ** on each
			.replace(/\*\*/g, '')
			.replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, '$1$2')
			.replace(/`([^`]+)`/g, '$1')
	);
}

/** Print the release notes' summary before the upgrade question, and where
 *  the rest is. Exported for its test. */
export function showReleaseNotes(notesBody: string, fullNotes: () => string | null): void {
	const summary = releaseNotesSummary(notesBody);
	info('Release notes (summary):');
	for (const line of summary.lines) {
		// defense-in-depth.  latest.body is the release
		// body fetched from Forgejo — upstream-trusted content but
		// not source-controlled review-gated (a compromised release-
		// publishing account could plant terminal escapes here).
		// Plain text: no control sequence, and no colour or style either
		// (conceal, SGR 8, would hide the lines after it).
		console.log(`  ${plainText(plainMarkdown(line))}`.trimEnd());
	}
	if (summary.more) {
		const where = fullNotes();
		if (where !== null) console.log(`  … the full notes: ${plainText(where)}`);
	}
}

/** PURE. Where the operator reads the full notes: the release's web page, or —
 *  when the release came as a tarball (no web page) — the command that prints
 *  the notes from it. Null when there is neither. */
export function fullNotesPointer(
	htmlUrl: string,
	tarballPath: string | null,
	member: string | null
): string | null {
	if (/^https?:\/\//.test(htmlUrl)) return htmlUrl;
	if (tarballPath !== null && member !== null) {
		const q = (x: string): string => `'${x.replace(/'/g, `'\\''`)}'`;
		return `tar -xzOf ${q(tarballPath)} ${q(member)} | less   (in another terminal, while this question waits)`;
	}
	return null;
}

/** PURE. What a quiet step that worked still shows: its build warnings
 *  (esbuild's "▲ [WARNING]" blocks), nothing else. */
export function stepWarnings(output: string): string {
	const lines = output.replace(/\r/g, '').split('\n');
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!/\[WARNING\]/.test(lines[i]!)) continue;
		// The warning, then its indented detail (esbuild puts one blank line
		// before it: file, code, explanation), up to the next blank line.
		out.push(lines[i]!);
		let j = i + 1;
		if (j < lines.length && lines[j]!.trim() === '' && /^\s+\S/.test(lines[j + 1] ?? '')) j++;
		while (j < lines.length && /^\s+\S/.test(lines[j]!)) out.push(lines[j++]!);
		i = j - 1;
	}
	return out.join('\n');
}

/** Where the step that ran last keeps its full output when it failed (null
 *  when it worked): read at once by stepFailed(), which carries it on the
 *  error a rollback is given. */
let lastFailedStepLog: string | null = null;

/** Where a step that failed keeps its full output: root's log directory
 *  (root:morphit 0750), one root-only file per failure. MORPHIT_STEP_LOG_DIR
 *  moves it (tests). */
function stepLogDir(): string {
	return process.env.MORPHIT_STEP_LOG_DIR ?? '/var/log/morphit';
}

/** How a step's process ended. */
export interface StepEnd {
	readonly code: number | null;
	readonly signal: string | null;
	/** Its time limit, when it was stopped for running past it. */
	readonly timedOutAfterMs: number | null;
	/** Why it could not be started at all. */
	readonly error: string | null;
}

/** PURE. A step that did not end well, in plain words: a time limit or a
 *  signal is named as such (not "exited 1", not "ETIMEDOUT"). */
export function describeStepEnd(name: string, end: StepEnd): string {
	if (end.error !== null) return `${name} could not be started (${end.error})`;
	if (end.timedOutAfterMs !== null) {
		const s = Math.round(end.timedOutAfterMs / 1000);
		return `${name} was stopped: it was still running after ${s >= 120 && s % 60 === 0 ? `${s / 60} minutes` : `${s} s`}, its time limit`;
	}
	if (end.signal !== null) return `${name} was stopped by a signal (${end.signal})`;
	return `${name} failed (exit code ${end.code ?? 'unknown'})`;
}

/** Copy a failed step's output to the step log directory (a NEW root-only
 *  file, never through a link). The kept path, or null when it could not. */
function keepStepLog(from: string, name: string): string | null {
	try {
		const dir = stepLogDir();
		mkdirSync(dir, { recursive: true, mode: 0o750 });
		const slug =
			name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '') || 'step';
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const to = join(dir, `upgrade-${slug}-${stamp}.log`);
		// COPYFILE_EXCL: a new file (a link or file already there is refused).
		copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
		chmodSync(to, 0o600);
		return to;
	} catch {
		return null;
	}
}

/**
 * Run a child process while the braille spinner turns, then show its output.
 *
 * WHY NOT spawnSync: spawnSync BLOCKS the event loop, so no setInterval can
 * fire and a spinner wrapped around it never draws — the screen sits still for
 * as long as the step runs. The async spawn keeps the loop turning.
 *
 * Output goes to a file, not the terminal (a spinner and a child writing to
 * the same TTY corrupt each other's lines) and not a memory buffer (a long
 * build's output can be large). It is shown once the step finishes: all of it,
 * or with `quietOnSuccess` only its build warnings (`warningsOnSuccess`,
 * stepWarnings) when it worked and its last 40 lines when it did not. A step
 * that failed keeps its FULL output in /var/log/morphit and says where, and
 * says plainly when it was stopped at its time limit or by a signal.
 *
 * Standing rule: NO STEP RUNS SILENT. Every pause long enough to look like a
 * hang gets a spinner, so an admin always knows work is happening.
 */
export async function runStepWithSpinner(
	label: string,
	cmd: string,
	args: readonly string[],
	opts: {
		cwd?: string;
		timeoutMs?: number;
		env?: NodeJS.ProcessEnv;
		/** Show the command's output only when it fails (its last 40 lines);
		 *  on success only its warnings (stepWarnings). */
		quietOnSuccess?: boolean;
		/** With quietOnSuccess: also show its build warnings when it worked
		 *  (default true). */
		warningsOnSuccess?: boolean;
		/** What the step is called in the line that says how it failed
		 *  (default: the command and its first argument). */
		name?: string;
		/** Exit codes that are a result the caller reports, not a failure of
		 *  the step (shown like success, returned as they are). */
		alsoFine?: readonly number[];
		/** How the step's process ended (a signal included). */
		onEnd?: (end: StepEnd) => void;
	} = {}
): Promise<number> {
	// Only THIS step's output, when it fails: never an earlier step's (M3).
	lastFailedStepLog = null;
	const name =
		opts.name ??
		`${basename(cmd)}${args[0] !== undefined && !args[0].startsWith('-') ? ` ${args[0]}` : ''}`;
	let dir: string | null = null;
	let fd: number | null = null;
	let keepTemp = false;
	const stop = startDotsSpinner(label);
	try {
		dir = mkdtempSync(join(tmpdir(), 'morphit-step-'));
		const log = join(dir, 'out.log');
		fd = openSync(log, 'w', 0o600);
		const out = fd;
		const end = await new Promise<StepEnd>((resolveStep) => {
			let settled = false;
			let timer: NodeJS.Timeout | null = null;
			let timedOut = false;
			const settle = (e: StepEnd): void => {
				if (settled) return;
				settled = true;
				if (timer !== null) clearTimeout(timer);
				resolveStep(e);
			};
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(cmd, [...args], {
					cwd: opts.cwd,
					stdio: ['ignore', out, out],
					...(opts.env !== undefined ? { env: opts.env } : {})
				});
			} catch (e) {
				settle({
					code: null,
					signal: null,
					timedOutAfterMs: null,
					error: e instanceof Error ? e.message : String(e)
				});
				return;
			}
			if (opts.timeoutMs !== undefined) {
				const limit = opts.timeoutMs;
				timer = setTimeout(() => {
					timedOut = true;
					try {
						child.kill('SIGKILL');
					} catch {
						/* already gone */
					}
				}, limit);
			}
			child.on('error', (e) =>
				settle({ code: null, signal: null, timedOutAfterMs: null, error: e.message })
			);
			child.on('close', (code, signal) =>
				settle({
					code,
					signal,
					timedOutAfterMs: timedOut ? (opts.timeoutMs ?? null) : null,
					error: null
				})
			);
		});
		closeSync(fd);
		fd = null;
		stop();
		opts.onEnd?.(end);
		const text = (): string => {
			try {
				return readFileSync(log, 'utf8');
			} catch {
				return '';
			}
		};
		const ok =
			end.code !== null &&
			(end.code === 0 || (opts.alsoFine ?? []).includes(end.code)) &&
			end.error === null &&
			end.timedOutAfterMs === null;
		const shown = ok
			? opts.quietOnSuccess !== true
				? text()
				: opts.warningsOnSuccess === false
					? ''
					: stepWarnings(text())
			: opts.quietOnSuccess !== true
				? text()
				: text().trimEnd().split('\n').slice(-40).join('\n');
		if (shown.trim() !== '') process.stdout.write(shown.endsWith('\n') ? shown : `${shown}\n`);
		if (ok) return end.code ?? 0;
		let kept = keepStepLog(log, name);
		if (kept === null) {
			keepTemp = true;
			kept = log;
		}
		lastFailedStepLog = kept;
		info(`${describeStepEnd(name, end)}. Its full output is kept on this server: sudo cat ${kept}`);
		return end.code !== null && end.code !== 0 ? end.code : end.timedOutAfterMs !== null ? 124 : 1;
	} catch (e) {
		stop();
		info(`${name} could not be run (${e instanceof Error ? e.message : String(e)}).`);
		return 1;
	} finally {
		stop();
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* already closed */
			}
		}
		if (dir !== null && !keepTemp) rmSync(dir, { recursive: true, force: true });
	}
}

/** A step whose output only matters when it fails (Docker's build progress,
 *  for one), with the spinner turning meanwhile: on success nothing is shown;
 *  on failure its last lines, how it ended and where its full output is. True
 *  when it exited 0. */
export async function runShowingOutputOnFailure(
	label: string,
	cmd: string,
	args: readonly string[],
	timeoutMs: number,
	onEnd?: (end: StepEnd) => void
): Promise<boolean> {
	return (
		(await runStepWithSpinner(label, cmd, args, {
			timeoutMs,
			quietOnSuccess: true,
			warningsOnSuccess: false,
			...(onEnd !== undefined ? { onEnd } : {})
		})) === 0
	);
}

/** How many earlier copies of the frontend container's nginx.conf are kept
 *  (nginx.conf.bak-<time>): the newest ones; older ones are removed. */
export const FRONTEND_CONF_BACKUPS_KEPT = 2;

/** The nginx.conf.bak-<time> copies this upgrade makes, in a folder. PURE. */
function isConfBackupName(n: string): boolean {
	return /^nginx\.conf\.bak-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(n);
}

export async function restartFrontendContainer(
	name: string,
	installDir: string,
	o: {
		/** A rollback puts the previous release back: its settings, not "this release's". */
		readonly restoring?: boolean;
		/** The upgrade was stopped (Ctrl+C, a closed session): no second way is tried. */
		readonly stopped?: () => boolean;
	} = {}
): Promise<void> {
	const whose =
		o.restoring === true ? "the restored release's settings" : "this release's settings";
	// The frontend nginx.conf is BAKED into the image at build time, so a plain
	// restart keeps a STALE config (timeapp: the `/v1/` 4 KB body cap that
	// 413'd every avatar upload survived every restart + every backend upgrade).
	// When the container is compose-managed, REBUILD it after refreshing its
	// build-context nginx.conf from the upgraded repo, so config fixes actually
	// ship. Falls back to a plain restart when it isn't compose-managed.
	//
	// Wave 5 (B-from-C §4): address the container's WHOLE Compose project (every
	// file, env file, project name and directory, from its labels — a first-file
	// -only `-f` drops overrides) and rebuild ONLY its service (`--no-deps`), so
	// the rebuild never brings up or recreates anything else in the stack.
	let ref: ComposeRef | null = null;
	try {
		const insp = spawnSync('docker', ['inspect', name], {
			encoding: 'utf8',
			timeout: 10_000,
			maxBuffer: 16 * 1024 * 1024
		});
		const c = insp.status === 0 ? parseDockerInspect(insp.stdout ?? '[]')[0] : undefined;
		ref = c ? composeRefOf(c) : null;
	} catch {
		ref = null;
	}

	if (ref !== null && existsSync(ref.files[0]!)) {
		try {
			// Build context is <workdir>/frontend; refresh its nginx.conf from the
			// upgraded repo so the rebuild bakes the CURRENT config.
			const srcConf = join(installDir, 'ops', 'bunkerweb', 'frontend', 'nginx.conf');
			const dstConf = join(
				ref.workDir !== '' ? ref.workDir : dirname(ref.files[0]!),
				'frontend',
				'nginx.conf'
			);
			// Only when it differs, and the previous copy is kept first (it is the
			// operator's Compose project, not the release's: v1.21.17 audit, L10).
			const incoming = existsSync(srcConf) ? readFileSync(srcConf) : null;
			const current = existsSync(dstConf) ? readFileSync(dstConf) : null;
			if (
				incoming !== null &&
				existsSync(dirname(dstConf)) &&
				(current === null || !current.equals(incoming))
			) {
				let kept: string | null = null;
				let step: 'copy' | 'write' = 'copy';
				try {
					if (current !== null) {
						kept = `${dstConf}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
						copyFileSync(dstConf, kept, fsConstants.COPYFILE_EXCL);
					}
					step = 'write';
					copyFileSync(srcConf, dstConf);
					info(
						`The frontend container's nginx.conf (${dstConf}) now has ${whose}` +
							(kept !== null ? `; the previous one is kept at ${kept}.` : '.')
					);
				} catch (e) {
					// Never silent: the container is rebuilt with the file as it was
					// (v1.21.18 audit, L5).
					const why = e instanceof Error ? e.message : String(e);
					warn(
						step === 'copy'
							? `The frontend container's nginx.conf (${dstConf}) was left as it was: a copy of it could not be kept first (${why}), so ${whose} were not put in it. On this server: sudo cp ${dstConf} ${dstConf}.bak && sudo cp ${srcConf} ${dstConf} && sudo ${composeCommand(ref, ['up', '-d', '--no-deps', '--build', '--force-recreate', ref.service])}`
							: `The frontend container's nginx.conf (${dstConf}) could not be written (${why}), so ${whose} were not put in it${kept !== null ? ` (the previous one is kept at ${kept})` : ''}. On this server: sudo cp ${srcConf} ${dstConf} && sudo ${composeCommand(ref, ['up', '-d', '--no-deps', '--build', '--force-recreate', ref.service])}`
					);
				}
				// Only the newest copies stay (one per upgrade piled up).
				try {
					const dir = dirname(dstConf);
					const old = readdirSync(dir).filter(isConfBackupName).sort();
					for (const n of old.slice(0, Math.max(0, old.length - FRONTEND_CONF_BACKUPS_KEPT)))
						rmSync(join(dir, n), { force: true });
				} catch {
					/* an old copy left is harmless */
				}
			}
		} catch {
			/* best-effort — the rebuild still recreates the container */
		}
		// --force-recreate is LOAD-BEARING: on an upgrade the rebuilt image is
		// usually byte-identical (same nginx.conf), so a plain `up --build` sees no
		// change and leaves the RUNNING container in place — still bind-mounted to
		// the pre-upgrade apps/web/build inode (step 7 renamed the install to .bak),
		// so it serves the STALE build (seen on an instance at v1.17.0: upgrade reported
		// success while /verify.json stayed 1.16.13). Forcing the recreate re-binds
		// the mount to the freshly-extracted build, fixing config AND content.
		const up = composeArgs(ref, [
			'up',
			'-d',
			'--no-deps',
			'--build',
			'--force-recreate',
			ref.service
		]);
		// Up to 5 minutes each, its output only on failure: the spinner turns
		// meanwhile (the label is printed once when there is no terminal).
		const label = `Rebuilding the frontend container "${name}" so it serves the current config + build (this can take a few minutes)…`;
		// A stop (Ctrl+C, a closed session) ends the rebuild: no second way is
		// tried after it (v1.21.18 audit, M2: the docker-compose build, up to
		// 300 s, and a restart ran after a Ctrl+C).
		let bySignal = false;
		const first = await runShowingOutputOnFailure(label, 'docker', up, 300_000, (e) => {
			bySignal = isStopSignal(e.signal);
		});
		if (!first && o.stopped !== undefined) await settleSignals();
		const stopped = (): boolean => bySignal || (o.stopped?.() ?? false);
		if (!first && stopped()) return;
		const rebuilt =
			first || (await runShowingOutputOnFailure(label, 'docker-compose', up.slice(1), 300_000));
		if (rebuilt) {
			info(`\u2713 Frontend container "${name}" rebuilt (config changes applied).`);
			return;
		}
		if (o.stopped !== undefined) await settleSignals();
		if (stopped()) return;
		warn('Could not rebuild the frontend via compose; falling back to a restart.');
	}

	if (
		!(await runShowingOutputOnFailure(
			`Restarting the frontend container "${name}" so it serves the new build…`,
			'docker',
			['restart', name],
			120_000
		))
	) {
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

/** Step 9 on a clearnet node: npm ci (with no install scripts), then the
 *  installed tree checked against the lockfile, then the Matrix bot's native
 *  add-ons carried over from the previous install where unchanged. Throws —
 *  the upgrade rolls back — when any of it fails. Exported for its test. */
export async function installDepsWithNpmCi(installDir: string, backupDir: string): Promise<void> {
	const ciCode = await runStepWithSpinner(
		'Installing dependencies (npm ci) — this can take a minute…',
		'npm',
		['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
		{ cwd: installDir, quietOnSuccess: true }
	);
	if (ciCode !== 0) throw stepFailed(`npm ci exited ${ciCode}`);
	const lockText = readFileSync(join(installDir, 'package-lock.json'), 'utf8');
	const problems = lockedTreeProblems(installDir, lockText);
	if (problems.length > 0) {
		throw new Error(
			`the installed dependencies do not match the lockfile (${problems.slice(0, 3).join('; ')})`
		);
	}
	// The native add-ons of the previous install are reused when their version
	// did not change: routine, nothing to say (v1.21.17 audit, L1).
	carryNativeAddons(backupDir, installDir, lockText);
}

/**
 * Step 9d — verify the new frontend is actually being SERVED (beta14).
 *
 * Confirms the just-built service worker is what the live frontend serves.
 * When it isn't, the "Load it now" update prompt never fires for users (the
 * recurring symptom) — so say so loudly with the specific fix, instead of
 * reporting a silent success. Best-effort: never fails the upgrade. True only
 * when the served frontend was SEEN to be this build (the last word says "the
 * site serves it" only then). Exported for its test.
 */
export async function verifyServedFrontend(
	plan: { copyToWebRoot: boolean; restartContainer: string | null },
	buildDir: string,
	webRoot: string
): Promise<boolean> {
	// For the last word: true only when the served frontend was seen to be this build.
	let frontendVerified = false;
	if (plan.copyToWebRoot || plan.restartContainer) {
		try {
			const builtVersion = readBuiltVersion(buildDir);
			// the container was JUST restarted; give it a moment to come
			// back up before deciding we can't verify. Without this, the check
			// almost always runs before the web server is serving again and prints
			// "Could not auto-verify the served frontend", which looks like a
			// failure on an upgrade that actually worked. Retry a few times.
			const servedVersion = await withSpinner(
				'Checking the site serves the new frontend…',
				async () => {
					let v = await resolveServedVersion(plan, webRoot);
					for (let attempt = 0; v === null && attempt < 5; attempt++) {
						await new Promise((r) => setTimeout(r, 2000));
						v = await resolveServedVersion(plan, webRoot);
					}
					return v;
				}
			);
			const verdict = classifyFrontendVerify(builtVersion, servedVersion);
			if (verdict === 'fresh') {
				frontendVerified = true;
				info(
					`\u2713 Verified the live frontend is serving this build ` +
						`(version ${builtVersion}). Visitors who have the site open ` +
						`see the "Load it now" prompt within a few minutes.`
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
					await runShowingOutputOnFailure(
						`Restarting "${plan.restartContainer}"…`,
						'docker',
						['restart', plan.restartContainer],
						60_000
					);
					const reServed = await withSpinner(
						'Checking the site serves the new frontend after the restart…',
						async () => {
							let v = await resolveServedVersion(plan, webRoot);
							for (let attempt = 0; v === null && attempt < 5; attempt++) {
								await new Promise((r) => setTimeout(r, 2000));
								v = await resolveServedVersion(plan, webRoot);
							}
							return v;
						}
					);
					if (classifyFrontendVerify(builtVersion, reServed) === 'fresh') {
						healed = true;
						frontendVerified = true;
						info(
							`\u2713 Verified the live frontend is serving this build ` +
								`(version ${builtVersion}) after a restart. Visitors who have ` +
								`the site open see the "Load it now" prompt within a few minutes.`
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

	return frontendVerified;
}

/** Step 12b's timers: the snapshot units installed from this release, the
 *  weekly mirror timer on, and — only where the operator opted in with the
 *  env file — the daily publish timer; each READ BACK from systemd and said
 *  as it is. `o` relocates the paths (tests). Exported for its test. */
export async function armSnapshotTimers(
	installDir: string,
	o: { readonly systemdDir?: string; readonly publishEnv?: string } = {}
): Promise<void> {
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
	const changed: string[] = [];
	for (const u of units) {
		const src = join(installDir, 'ops', 'systemd', u);
		if (!existsSync(src)) continue;
		const dest = join(o.systemdDir ?? '/etc/systemd/system', u);
		const incoming = readFileSync(src, 'utf8');
		if (existsSync(dest) && readFileSync(dest, 'utf8') === incoming) continue;
		writeFileSync(dest, incoming);
		changed.push(u);
	}
	if (changed.length > 0) {
		await runSpinning('Reloading systemd…', 'systemctl', ['daemon-reload'], {
			timeoutMs: 60_000
		});
	}
	// A timer whose schedule changed is restarted, so its new schedule is
	// the one it runs.
	const arm = async (timer: string, label: string): Promise<void> => {
		await runSpinning(label, 'systemctl', ['enable', '--now', timer], { timeoutMs: 60_000 });
		if (changed.includes(timer))
			await runSpinning(label, 'systemctl', ['restart', timer], { timeoutMs: 60_000 });
	};
	await arm('morphit-snapshot-mirror.timer', 'Turning on the snapshot mirror timer…');
	const mirrorTimer = readTimer('morphit-snapshot-mirror.timer');
	// It was just turned on with `enable --now`: saying that again is circular
	// (v1.21.18 audit, M7); what systemd says about it is the next step.
	if (!mirrorTimer.active)
		warn(
			'The weekly snapshot mirror timer did not start (it was just turned on, and systemd does not show it running), so this box only refreshes its mirror when it upgrades. To see why, on this server: sudo systemctl status morphit-snapshot-mirror.timer and sudo journalctl -u morphit-snapshot-mirror.service -n 50 --no-pager'
		);
	// Enable publishing ONLY where the operator has opted in by dropping the
	// env file. Explicit and reversible: exactly one instance in the
	// federation should publish, and an upgrade must never make a box start
	// signing snapshots under its own account by surprise.
	if (existsSync(o.publishEnv ?? '/etc/morphit/snapshot-publish.env')) {
		await arm('morphit-snapshot-publish.timer', 'Turning on the snapshot publish timer…');
		// Read back, not assumed (v1.21.17 audit, M4: "timer armed" was
		// printed whatever systemctl did).
		const t = readTimer('morphit-snapshot-publish.timer');
		// Promises nothing about the mirror's line below (v1.21.18 audit, L7: it
		// said that line gives the anchored snapshot's age, which it does not
		// always).
		if (t.active)
			info(
				`  This box publishes the federation snapshot: its daily job is on (checked; next run ${t.next ?? 'not scheduled yet'}). Anchoring each one on chain is done on your laptop.`
			);
		else
			warn(
				'This box is set up to publish the federation snapshot (/etc/morphit/snapshot-publish.env), but its daily timer did not start (it was just turned on, and systemd does not show it running), so no new snapshot is exported. To see why, on this server: sudo systemctl status morphit-snapshot-publish.timer and sudo journalctl -u morphit-snapshot-publish.service -n 50 --no-pager'
			);
	}
}

/** Step 10b: the MCP server's own tree (/opt/morphit-mcp) gets this release's
 *  code. It is started or restarted only when the operator has it ON: menu 17
 *  turns it off with `systemctl disable --now`, and an upgrade used to start
 *  it again ("Started morphit-mcp (it was not previously active)", v1.21.17
 *  audit D-H3). A started one is checked to stay running (a Type=simple unit's
 *  restart "succeeds" even when it crashes at once) and to answer its health
 *  check. False when it should run and does not. Exported for its test. */
export async function redeployMcpOnUpgrade(
	installDir: string,
	o: {
		readonly settleMs?: number;
		/** The upgrade was stopped: its own last lines say what is left. */
		readonly stopped?: () => boolean;
	} = {}
): Promise<boolean> {
	const mcpUnitPath = join(
		process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system',
		'morphit-mcp.service'
	);
	// (No MCP unit on this server: nothing to redeploy, nothing to say.)
	if (!existsSync(mcpUnitPath)) return true;
	const mcpDest = process.env.MORPHIT_MCP_DEPLOY_DIR ?? '/opt/morphit-mcp';
	const mcpUser = process.env.MORPHIT_MCP_DEPLOY_USER ?? 'morphit-mcp';
	const deployScript = join(installDir, 'ops', 'scripts', 'deploy-mcp.sh');
	const wasActive =
		spawnSync('systemctl', ['is-active', '--quiet', 'morphit-mcp.service'], { timeout: 10_000 })
			.status === 0;
	const enabled = (
		spawnSync('systemctl', ['is-enabled', 'morphit-mcp.service'], {
			encoding: 'utf8',
			timeout: 10_000
		}).stdout ?? ''
	).trim();
	// On: enabled (or running anyway, e.g. started by hand). Off: menu 17's
	// `disable --now`, or never turned on.
	const on = wasActive || enabled === 'enabled' || enabled === 'enabled-runtime';
	// The new code is put in place either way, so turning it on later runs it.
	const depCode = await runStepWithSpinner(
		'Redeploying the MCP server…',
		'bash',
		[deployScript, installDir, mcpDest, mcpUser],
		{ quietOnSuccess: true, warningsOnSuccess: false, name: 'deploy-mcp.sh' }
	);
	if (depCode !== 0 && o.stopped !== undefined) await settleSignals();
	// Stopped (the deploy got the signal too): the upgrade's last lines name it.
	if (depCode !== 0 && o.stopped?.() === true) return true;
	if (depCode !== 0) {
		warn(
			`The MCP server's new code could not be put in place (deploy-mcp.sh exit ${depCode}), so ${on ? 'it may keep running the previous release' : 'it has the previous release'}. ` +
				`On this server: sudo bash ${deployScript} ${installDir} ${mcpDest} ${mcpUser}` +
				(on ? ' && sudo systemctl restart morphit-mcp' : '')
		);
		return !on;
	}
	if (!on) {
		info(
			'✓ MCP server: this release is in place, and the server stays off as you set it (menu 17 turns it on).'
		);
		return true;
	}
	const rs = await runStepWithSpinner(
		wasActive ? 'Restarting the MCP server…' : 'Starting the MCP server…',
		'systemctl',
		[wasActive ? 'restart' : 'start', 'morphit-mcp.service'],
		{ quietOnSuccess: true, warningsOnSuccess: false }
	);
	let running = false;
	if (rs === 0)
		await withSpinner('Checking the MCP server stays up…', async () => {
			await new Promise((r) => setTimeout(r, o.settleMs ?? 3_000));
			running =
				spawnSync('systemctl', ['is-active', '--quiet', 'morphit-mcp.service'], {
					timeout: 10_000
				}).status === 0;
		});
	if (!running) {
		warn(
			`The MCP server ${rs === 0 ? 'stopped again right after it was started' : 'could not be started'} on this release. ` +
				'On this server: sudo journalctl -u morphit-mcp -n 50'
		);
		return false;
	}
	// ─── 10b-reach. Post-restart MCP reachability probe ──
	// Its CONFIGURED LOCAL bind (/etc/morphit/mcp.env), not the public site:
	// behind BunkerWeb the bind is often the Docker-bridge gateway (172.18.0.1),
	// which a loopback-only probe would miss. A miss WARNS (the MCP is isolated,
	// read-only and non-critical), never rolls back.
	const { host: mcpHost, port: mcpPort } = resolveMcpHttpBind(mcpEnvFile());
	return await checkMcpAnswers(mcpHost, mcpPort);
}

/** A timer as systemd has it now: running, and when it fires next. */
function readTimer(unit: string): { readonly active: boolean; readonly next: string | null } {
	const active =
		spawnSync('systemctl', ['is-active', '--quiet', unit], { timeout: 10_000 }).status === 0;
	const r = spawnSync('systemctl', ['show', '-p', 'NextElapseUSecRealtime', '--value', unit], {
		encoding: 'utf8',
		timeout: 10_000
	});
	const next = r.status === 0 ? (r.stdout ?? '').trim() : '';
	return { active, next: next !== '' && next !== 'n/a' ? next : null };
}

/** Why an upgrade stopped on a signal, in plain words. PURE. */
export function stoppedWhy(sig: NodeJS.Signals): string {
	return sig === 'SIGINT'
		? 'you pressed Ctrl+C'
		: sig === 'SIGHUP'
			? 'the connection to this server closed (the terminal or SSH session ended)'
			: `it was asked to stop (${sig})`;
}

/** The error a rollback is given when a signal stopped the install. */
export class UpgradeStopped extends Error {
	constructor(readonly sig: NodeJS.Signals) {
		super(stoppedWhy(sig));
	}
}

/** A step failed; `log` is where THAT step's full output is kept (or null).
 *  A rollback names only this log (v1.21.18 audit, M3: it named whatever
 *  step had failed last, a non-fatal one included). */
export class StepFailed extends Error {
	constructor(
		message: string,
		readonly log: string | null
	) {
		super(message);
	}
}

/** The error for a step that just failed, carrying its own kept output. */
function stepFailed(message: string): StepFailed {
	return new StepFailed(message, lastFailedStepLog);
}

/** The exit code of an upgrade a signal stopped: 128 + the signal's number,
 *  as a shell reports it (Ctrl+C 130, a closed session 129, SIGTERM 143).
 *  PURE. */
export function signalExitCode(sig: NodeJS.Signals): number {
	return sig === 'SIGINT' ? 130 : sig === 'SIGHUP' ? 129 : sig === 'SIGTERM' ? 143 : 130;
}

/** Is this how a stop reaches a child (the terminal's Ctrl+C, a closed
 *  session, a SIGTERM)? A step's own time limit kills with SIGKILL. PURE. */
export function isStopSignal(
	sig: string | null | undefined
): sig is 'SIGINT' | 'SIGHUP' | 'SIGTERM' {
	return sig === 'SIGINT' || sig === 'SIGHUP' || sig === 'SIGTERM';
}

/** Let a signal that arrived while a blocking spawnSync held the event loop
 *  reach its handler: Node runs signal handlers only on a turn of the event
 *  loop (v1.21.18 audit, H1: right after the self-heal child, the guard still
 *  said "no signal", and the heals then ran again in this process). */
export async function settleSignals(): Promise<void> {
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
}

/**
 * From the moment /opt/morphit is moved aside until the services run the new
 * release, the install is half-way: Node's default on Ctrl+C or a closed SSH
 * session (SIGINT / SIGHUP) is to exit at once, which left /opt/morphit EMPTY
 * with no rollback and no message (v1.21.17 audit). While this guard is up
 * those signals (and SIGTERM) are only noted: the step that runs finishes or
 * fails (its own child got the signal too), and the upgrade then puts the
 * previous install back and says why. A closed terminal makes writes fail;
 * that must not end the process either. As fastSync.ts's restore does.
 * Exported for its test.
 */
export function guardInstallWindow(out: NodeJS.WriteStream = process.stdout): {
	readonly signal: () => NodeJS.Signals | null;
	/** A step's child was ended by this signal: a stop, though this process
	 *  may not have been sent it (only the child was). */
	readonly note: (sig: NodeJS.Signals) => void;
	/** The install is whole (every service runs the new release): a signal
	 *  from now on skips what is left instead of putting anything back. */
	readonly finishing: (tag: string) => void;
	readonly release: () => void;
} {
	let got: NodeJS.Signals | null = null;
	let doneTag: string | null = null;
	const quiet = (): void => undefined;
	const stop = (sig: NodeJS.Signals): void => {
		if (got !== null) return;
		got = sig;
		if (sig === 'SIGHUP') {
			process.stdout.on('error', quiet);
			process.stderr.on('error', quiet);
		}
		try {
			out.write(
				doneTag === null
					? `\nStopping — ${stoppedWhy(sig)}. The new release is half installed, so the previous one is being put back; please wait, this takes a moment.\n`
					: `\nStopping — ${stoppedWhy(sig)}. The upgrade itself is done (every service runs ${doneTag}), so nothing is undone; the steps still left are skipped.\n`
			);
		} catch {
			/* no terminal any more */
		}
	};
	const handlers = (['SIGINT', 'SIGHUP', 'SIGTERM'] as const).map((sig) => {
		const h = (): void => stop(sig);
		process.on(sig, h);
		return [sig, h] as const;
	});
	return {
		signal: () => got,
		note: stop,
		finishing: (tag) => {
			doneTag = tag;
		},
		release: () => {
			for (const [sig, h] of handlers) process.removeListener(sig, h);
		}
	};
}

/** A stopped or failed install's last lines also go to a file: after a closed
 *  SSH session nobody saw them. Its path, or null. */
function keepStoppedNote(lines: readonly string[]): string | null {
	try {
		const dir = stepLogDir();
		mkdirSync(dir, { recursive: true, mode: 0o750 });
		const f = join(dir, `upgrade-stopped-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
		writeFileSync(f, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
		return f;
	} catch {
		return null;
	}
}

export async function runUpgrade(opts: RunUpgradeOptions): Promise<number> {
	const upgradeStartedMs = Date.now();
	// The Tor bridges check alone (lib/torBridgesHeal.ts): what
	// morphit-tor-bridges.timer runs between upgrades. First, before the lines
	// below take the questions and warning counts a running upgrade keeps for
	// its last lines: the timer may fire during one.
	if (opts.flags['tor-bridges'] === 'true') return runTorBridgesCheck();
	// Everything below except a check changes files only root may change. A run
	// without sudo used to verify and download the release and then fail with
	// "EACCES … rename" (or, with --heals, print ten confusing warnings and
	// exit 0): say so first, and change nothing (v1.21.17 audit, M3).
	{
		const uid = opts.uid ?? process.getuid?.();
		const looksOnly = opts.flags['check-only'] === 'true' || opts.flags['json'] === 'true';
		if (!looksOnly && uid !== undefined && uid !== 0) {
			const cmd =
				opts.flags['heals'] === 'true'
					? HEALS_COMMAND
					: opts.flags['questions'] === 'true'
						? QUESTIONS_COMMAND
						: 'sudo morphit-ops upgrade';
			printError(
				`This needs the root account (it changes ${process.env.MORPHIT_INSTALL_DIR ?? DEFAULT_INSTALL_DIR} and system settings), so nothing was done. Run it with sudo: ${cmd}`
			);
			info(
				'  (To only see whether a newer release exists, without sudo: morphit-ops upgrade --check-only)'
			);
			return 1;
		}
	}
	// What an earlier run (or an older upgrader's heal phase) may have left for
	// its last lines is not this upgrade's: start clean.
	takeUpgradeQuestions();
	takeChildWarnings();
	// Neither downloads nor installs anything: the questions the heal phase
	// left for later, and this release's heals run again.
	if (opts.flags['questions'] === 'true') return runQuestions();
	if (opts.flags['heals'] === 'true') return runHealsAgain();
	const checkOnly = opts.flags['check-only'] === 'true';
	// Self-heal is the rule: a box already on the newest release still gets this
	// release's heals, so "the next `sudo morphit-ops upgrade` tries again" holds.
	const healsWhenUpToDate =
		opts.healsWhenUpToDate ??
		(() =>
			runHealsAgain({
				upToDate: true,
				installDir: process.env.MORPHIT_INSTALL_DIR ?? DEFAULT_INSTALL_DIR
			}));
	const forceYes = opts.flags['yes'] === 'true' || process.env.MORPHIT_AUTO_UPGRADE === '1';
	const jsonOutput = opts.flags['json'] === 'true';
	// Where a spinner goes before the --json document is printed: stderr, so
	// stdout carries only the JSON.
	const spinOut = jsonOutput ? process.stderr : process.stdout;

	// npm banner suppression now happens at CLI STARTUP (see main.ts). It was
	// here, which was too late: npm defers its "New major version available!"
	// notice to process EXIT, so a child spawned before this line printed it
	// anyway — an operator saw it after a clean upgrade, advising an npm upgrade
	// they must not perform, since the release vendors a pinned npm/node.

	// Each child step (npm, the builds, the MCP deploy, the seed, …) runs
	// through runStepWithSpinner (module level): a spinner while it runs, its
	// output after, the full output kept when it fails.

	// Before we spawn any child npm, strip an inherited offline flag. The ansible
	// launcher runs us via `npm exec --offline`; that flag would otherwise force
	// a clearnet node's `npm ci` cache-only and fail on any dependency not
	// already cached. A hidden-only node's npm never sees the inherited
	// environment: step 9 and the local builds set npm's network settings
	// explicitly (lib/depsInstall.ts).
	// Said nothing: an internal detail of how the launcher ran us.
	stripInheritedNpmOffline(process.env);

	// quiet npm's warn-level chatter for the child installs we run during
	// an upgrade. `npm ci` prints "npm warn deprecated …" for transitive packages
	// we don't control (matrix-bot-sdk still pulls the old `request` library,
	// better-sqlite3 pulls prebuild-install), which is noise an operator can't act
	// on and — mid-upgrade — reads like something is wrong. Errors still surface.
	// Only set for upgrades; a developer's own build keeps full output.
	if (!checkOnly) process.env.npm_config_loglevel = 'error';
	// raise the frontend build's chunk-size warning limit for upgrades so
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
	/** v1.21.15: on a CLEARNET node whose every release source failed, the
	 *  release fetched from the federation over Tor/I2P instead (verified the
	 *  same way). Kept apart from hiddenResolution: it does not make this node
	 *  hidden-only for the rest of the upgrade (npm and the record reads keep
	 *  their clearnet path). */
	let hiddenFallback: HiddenUpgradeResolution | null = null;
	// /etc/morphit is relocatable for tests, as for
	// mcpEnvFile(); unset on a real box.
	const etcDir = process.env.MORPHIT_ETC_DIR ?? '/etc/morphit';
	const hiddenConfigEnvPaths = [
		join(etcDir, 'indexer.env'),
		join(installDir, 'indexer.env'),
		join(etcDir, 'morphit.config.env'),
		join(installDir, 'morphit.config.env')
	];
	// Hidden-only is decided from this ROOT-OWNED
	// config, never from whatever answers on port 8081; the indexer is asked
	// only at its configured address, only after its listener is proven to be
	// morphit-indexer.service, and never the next address after one answers.
	const localIndexer: LocalIndexerOptions = {
		bases: opts.localIndexerBases,
		unitEnvFiles: indexerUnitEnvFiles(installDir, etcDir),
		verifyListener: opts.verifyLocalIndexer
	};
	const hiddenOpts = { ...localIndexer, configEnvPaths: hiddenConfigEnvPaths };
	const allowDowngrade = opts.flags['allow-downgrade'] === 'true';
	// v1.18.0 review (O10). A CHECK on a hidden-only node asks only "is there a
	// newer release?" — the answer is the on-chain release version this node's
	// own indexer already holds. It used to download the whole release over
	// Tor/I2P to learn that, which the release monitor's 30-second limit never
	// allowed, so no tor-only operator was ever told a release was out.
	// a real upgrade reads the same record FIRST, so
	// an on-chain release that is not newer is never downloaded at all.
	let hiddenCheckTag: string | null = null;
	if (offline === null) {
		try {
			hiddenCheckTag =
				(
					await withSpinner(
						"Reading the on-chain release record from this node's indexer…",
						() => readHiddenReleaseTarget(hiddenOpts),
						spinOut
					)
				)?.tag ?? null;
		} catch (err) {
			printError(
				`Could not check for a new release privately, so nothing was fetched and this node stays as it is: ` +
					`${err instanceof Error ? err.message : String(err)}`
			);
			return 5;
		}
		// `--json` only reports (it may run without sudo): never the heals and
		// never a download here; the JSON document below says up to date or not
		// (v1.21.18 audit: it ran the heals and printed no JSON).
		if (
			hiddenCheckTag !== null &&
			!checkOnly &&
			!jsonOutput &&
			localInfo !== null &&
			!allowDowngrade
		) {
			if (!isNewerRelease(hiddenCheckTag, localInfo.tag)) {
				info(`Current version: ${sanitizeForTerm(localInfo.tag)}`);
				info(`On-chain release: ${sanitizeForTerm(hiddenCheckTag)}`);
				info(
					compareTags(hiddenCheckTag, localInfo.tag) < 0
						? '✓ The on-chain release is older than this install, so nothing was changed.'
						: '✓ Already on the latest release.'
				);
				return healsWhenUpToDate();
			}
		}
	}
	if (offline === null && hiddenCheckTag !== null && !checkOnly && !jsonOutput) {
		// Over Tor/I2P this takes minutes and reports each step: the spinner
		// turns between the progress lines (taken off the line for each one),
		// says what it is doing right now, and counts the time.
		//
		// v1.21.6: when the release is not reachable over Tor/I2P YET, that is a
		// wait, not an error — the operator is told what was searched, what each
		// instance answered and that nothing changed, and (at a terminal) may try
		// again now, let it keep trying, or come back once more trusted instances
		// have upgraded and can share the release (src/init/hiddenUpgradeWait.ts).
		const interactive =
			opts.hiddenWait?.interactive ??
			(!forceYes && !jsonOutput && process.stdin.isTTY === true && process.stdout.isTTY === true);
		const askChoice = opts.hiddenWait?.ask ?? askHiddenWaitChoice;
		// The hour of "keep trying" runs on a steady clock (a Tor time sync may
		// step the wall clock meanwhile); the wall clock only names the time of
		// the next try.
		const steadyMs = opts.hiddenWait?.now ?? ((): number => performance.now());
		const wallMs = opts.hiddenWait?.now ?? Date.now;
		const pause = (ms: number): Promise<void> =>
			opts.hiddenWait?.sleep !== undefined
				? opts.hiddenWait.sleep(ms)
				: waitWithSpinner(ms, spinOut);
		let keepTryingUntil: number | null = null;
		let keepTryingSince = 0;
		let attempt = 0;
		for (;;) {
			attempt += 1;
			if (attempt > 1 && localInfo !== null) {
				// A try after a wait (up to an hour) looks again at what this server
				// runs: another session may have upgraded it meanwhile, and this run
				// must not offer "upgrade from <the old version>" (v1.21.6 review).
				const nowInfo = readLocalReleaseInfo(installDir);
				if (nowInfo === null || nowInfo.tag !== localInfo.tag) {
					info(
						nowInfo !== null
							? `This server now runs ${sanitizeForTerm(nowInfo.tag)}: another upgrade changed it while this one waited, so this one stops here (it changed nothing). Run \`sudo morphit-ops upgrade\` again to check for a newer release.`
							: `This server's release-info.json changed while this upgrade waited, so it stops here (it changed nothing). Run \`sudo morphit-ops upgrade\` again.`
					);
					return 5;
				}
			}
			const hiddenSpin = startPausableSpinner(
				'Fetching the release privately (over Tor/I2P)…',
				spinOut,
				{ elapsed: true }
			);
			let waitErr: HiddenUpgradeWaitError | null = null;
			try {
				hiddenResolution = await tryResolveHiddenUpgrade({
					...hiddenOpts,
					onProgress: (m) => hiddenSpin.say(() => info(m)),
					onStatus: (l) => hiddenSpin.relabel(l),
					...(opts.trust?.postingPubkey !== undefined
						? { postingPubkey: opts.trust.postingPubkey }
						: {}),
					...(opts.trust?.chainRead !== undefined ? { chainRead: opts.trust.chainRead } : {}),
					anchorWait: { waitMs: HIDDEN_RELEASE_RECORD_WAIT_MS, ...(opts.anchorWait ?? {}) }
				});
			} catch (err) {
				hiddenSpin.stop();
				if (!(err instanceof HiddenUpgradeWaitError)) {
					printError(
						`Hidden-only upgrade could not be completed privately (staying on the current version): ` +
							`${err instanceof Error ? err.message : String(err)}`
					);
					return 5; // fail-closed — never fall back to a clearnet mirror
				}
				waitErr = err;
			}
			hiddenSpin.stop();
			// A try can itself take minutes (the record wait alone up to
			// HIDDEN_RELEASE_RECORD_WAIT_MS): look again at what this server runs
			// after every try too, not only before the next one.
			if (localInfo !== null) {
				const nowInfo = readLocalReleaseInfo(installDir);
				if (nowInfo === null || nowInfo.tag !== localInfo.tag) {
					info(
						nowInfo !== null
							? `This server now runs ${sanitizeForTerm(nowInfo.tag)}: another upgrade changed it while this one waited, so this one stops here (it changed nothing). Run \`sudo morphit-ops upgrade\` again to check for a newer release.`
							: `This server's release-info.json changed while this upgrade waited, so it stops here (it changed nothing). Run \`sudo morphit-ops upgrade\` again.`
					);
					return 5;
				}
			}
			if (waitErr === null) break;

			const current = localInfo !== null ? sanitizeForTerm(localInfo.tag) : null;
			if (keepTryingUntil !== null && steadyMs() + KEEP_TRYING_EVERY_MS <= keepTryingUntil) {
				// Keeping at it: one calm line per try, not the whole explanation.
				const next = new Date(wallMs() + KEEP_TRYING_EVERY_MS);
				info(
					`⏳ Try ${attempt}: not reachable over Tor/I2P yet (${hiddenWaitSummary(waitErr)}). ` +
						`Next try at ${next.toTimeString().slice(0, 5)} — Ctrl-C stops; nothing has changed.`
				);
				await pause(KEEP_TRYING_EVERY_MS);
				continue;
			}
			if (keepTryingUntil !== null) {
				// The time it really took: a try can itself take minutes (v1.21.6 review).
				info(
					`Kept trying for ${formatDuration(steadyMs() - keepTryingSince)} (${attempt} tries in all); the release is still not reachable over Tor/I2P.`
				);
				keepTryingUntil = null;
			}
			for (const l of renderHiddenWait(waitErr, { current, interactive })) info(l);
			info(`  (For support: ${sanitizeForTerm(waitErr.message)})`);
			info('');
			if (!interactive) return 5; // fail-closed: nothing was changed
			const choice = await askChoice();
			if (choice === 'later') {
				info(
					'OK — nothing was changed. When more trusted instances have upgraded, run `sudo morphit-ops upgrade` again ' +
						'(or menu option 2): it searches them all over Tor and I2P.'
				);
				return 5;
			}
			if (choice === 'keep-trying') {
				keepTryingSince = steadyMs();
				keepTryingUntil = keepTryingSince + KEEP_TRYING_FOR_MS;
				const next = new Date(wallMs() + KEEP_TRYING_EVERY_MS);
				info(
					`It will try again ${KEEP_TRYING_EVERY_MS / 60_000} minutes after each try, for up to ${KEEP_TRYING_FOR_MS / 60_000} minutes ` +
						`(next at ${next.toTimeString().slice(0, 5)}), and ask you before installing. Ctrl-C stops it; nothing has changed.`
				);
				await pause(KEEP_TRYING_EVERY_MS);
			}
			// 'retry', or the first wait of 'keep-trying' is over: search again.
		}
		if (hiddenResolution === null) {
			// The node was hidden-only a moment ago; never fall back to clearnet.
			printError(
				'Hidden-only upgrade could not be completed privately (staying on the current version).'
			);
			return 5;
		}
		hiddenCheckTag = null;
		offline = {
			tarballPath: hiddenResolution.tarballPath,
			sigPath: null,
			tag: `v${hiddenResolution.version}`
		};
	}

	// 2026-10-08: a CHECK on any node first asks this node's own indexer for
	// @morphit's on-chain release record (on the box, no network). Since
	// v1.21.0 that record is what an unsigned release installs by, and the
	// ceremony broadcasts it before any box upgrades, so it names every
	// installable release. The release monitor runs this check twice a day: it
	// no longer needs git.agorise.net at all (privacy, and a slow or blocked
	// code host no longer means "no alert"). Only when the indexer does not
	// answer is the code host asked, as before.
	let onchainCheckTag: string | null = null;
	if (checkOnly && offline === null && hiddenCheckTag === null) {
		onchainCheckTag = await withSpinner(
			"Reading @morphit's on-chain release record from this node's indexer…",
			() => readOnchainReleaseTag(localIndexer),
			spinOut
		).catch(() => null);
	}

	// The PRIMARY is the trusted hash anchor. We fetch each source's
	// release listing; `primaryRelease` (if reachable) anchors the
	// SHA-256, while a mirror release lets us still SEE + (if signed)
	// install when the primary is down. Discovery order = source order.
	let primaryRelease: ForgejoRelease | null = null;
	/** The release the on-chain record names, when it was read (review
	 *  2026-10-08: the check reads the record, a real clearnet upgrade finds
	 *  releases on the code host; when they differ, the upgrade says so). */
	let onchainSeen: string | null = onchainCheckTag;
	const releasesBySource: Array<{ src: ReleaseSource; rel: ForgejoRelease }> = [];
	let latest: ForgejoRelease | null;
	if (hiddenCheckTag !== null) {
		latest = {
			tag_name: hiddenCheckTag,
			name: hiddenCheckTag,
			body: '',
			html_url: '',
			published_at: new Date(0).toISOString(),
			assets: []
		};
	} else if (onchainCheckTag !== null) {
		latest = {
			tag_name: onchainCheckTag,
			name: onchainCheckTag,
			body: `@morphit's on-chain record names ${onchainCheckTag}. Its notes: https://${host}/${repo}/releases/tag/${onchainCheckTag}`,
			html_url: `https://${host}/${repo}/releases/tag/${onchainCheckTag}`,
			published_at: new Date(0).toISOString(),
			assets: []
		};
	} else if (offline !== null) {
		latest = synthOfflineRelease(offline.tag, offline.tarballPath, offline.sigPath);
		info(`Offline upgrade — using local tarball: ${offline.tarballPath}`);
		// A tarball the hidden path fetched carries no .asc by design (its record
		// was verified before the fetch), so saying anything about a missing .asc
		// there would be noise. For a hand-supplied tarball, say which check step 6
		// will use instead — calmly: an unsigned offline bundle is normal.
		if (offline.sigPath === null && hiddenResolution === null && hiddenFallback === null) {
			info(
				"No sibling .asc signature next to the tarball; it will be checked against @morphit's signed " +
					'release record on chain instead, and refused if that record does not name its hash.'
			);
		}
	} else {
		const fetchErrors: string[] = [];
		for (const src of sources) {
			try {
				const rel = await withSpinner(
					`Checking ${src.host} for the latest release…`,
					() => fetchLatestRelease(src.host, src.repo),
					spinOut
				);
				releasesBySource.push({ src, rel });
				if (src.isPrimary) primaryRelease = rel;
				// A check needs one answer: asking the mirrors as well cost a 30 s
				// wait each on a network that drops connections (review 2026-10-08).
				if (checkOnly) break;
			} catch (err) {
				fetchErrors.push(`${src.host}: ${netFailureWords(err)}`);
			}
		}
		latest = primaryRelease ?? releasesBySource[0]?.rel ?? null;
		if (!checkOnly) {
			onchainSeen = await withSpinner(
				"Reading @morphit's on-chain release record from this node's indexer…",
				() => readOnchainReleaseTag(localIndexer),
				spinOut
			).catch(() => null);
			if (onchainSeen !== null && !RELEASE_VERSION_RE.test(onchainSeen)) onchainSeen = null;
		}
		if (latest === null) {
			// All network sources unreachable. Before giving up, fall back to a
			// signed tarball the operator has dropped in the offline dir — this is
			// what lets an upgrade begun online CONTINUE (or a fully offline box
			// upgrade) with the cable unplugged, exactly like the first install.
			const dropped = findLocalOfflineRelease(installDir);
			// A dropped tarball the operator put there wins — unless it is not newer
			// than what runs here (a leftover from an earlier offline upgrade: nothing
			// clears /opt/morphit-offline), so it never blocks the fallback below.
			const droppedUseful =
				dropped !== null &&
				(localInfo === null || allowDowngrade || isNewerRelease(dropped.tag, localInfo.tag));
			// Only for a release the on-chain record names as newer (nothing is
			// downloaded for a release this server already runs), and never for
			// `--json` (its stdout carries the JSON only, and it installs nothing).
			// `--check-only` never gets here with a record: it does not read one
			// (above), so it downloads nothing either.
			if (
				!droppedUseful &&
				!jsonOutput &&
				onchainSeen !== null &&
				(localInfo === null || isNewerRelease(onchainSeen, localInfo.tag))
			) {
				// v1.21.15: no release source answered over clearnet — ask the other
				// Morphit instances over Tor/I2P, as a zero-clearnet node always does.
				// Verified against @morphit's signed record; any failure here only
				// leads to the message below.
				const fbSpin = startPausableSpinner(
					'No release source answered — fetching the release over Tor/I2P…',
					spinOut,
					{ elapsed: true }
				);
				try {
					hiddenFallback = await tryResolveHiddenUpgrade({
						...hiddenOpts,
						fallback: true,
						onProgress: (m) => fbSpin.say(() => info(m)),
						onStatus: (l) => fbSpin.relabel(l),
						...(opts.trust?.postingPubkey !== undefined
							? { postingPubkey: opts.trust.postingPubkey }
							: {}),
						...(opts.trust?.chainRead !== undefined ? { chainRead: opts.trust.chainRead } : {}),
						// A bonus try on a clearnet node: the record is read once, no waiting.
						anchorWait: { ...(opts.anchorWait ?? {}), waitMs: 0 }
					});
				} catch (err) {
					fetchErrors.push(`Tor/I2P (the other Morphit instances): ${fallbackFailureText(err)}`);
				}
				fbSpin.stop();
				if (hiddenFallback !== null) {
					// The fetched copy lives in a temp dir of its own: never left behind.
					const fetchedDir = dirname(hiddenFallback.tarballPath);
					process.once('exit', () => rmSync(fetchedDir, { recursive: true, force: true }));
				}
				// The fetch can take minutes: another session may have upgraded this
				// server meanwhile (as the zero-clearnet path checks after each try).
				if (hiddenFallback !== null && localInfo !== null) {
					const nowInfo = readLocalReleaseInfo(installDir);
					if (nowInfo === null || nowInfo.tag !== localInfo.tag) {
						rmSync(dirname(hiddenFallback.tarballPath), { recursive: true, force: true });
						info(
							nowInfo !== null
								? `This server now runs ${sanitizeForTerm(nowInfo.tag)}: another upgrade changed it while this one fetched the release, so this one stops here (it changed nothing). Run \`sudo morphit-ops upgrade\` again to check for a newer release.`
								: `This server's release-info.json changed while this upgrade fetched the release, so it stops here (it changed nothing). Run \`sudo morphit-ops upgrade\` again.`
						);
						return 5;
					}
				}
			}
			if (hiddenFallback !== null) {
				offline = {
					tarballPath: hiddenFallback.tarballPath,
					sigPath: null,
					tag: `v${hiddenFallback.version}`
				};
				latest = synthOfflineRelease(offline.tag, offline.tarballPath, null);
			} else if (dropped !== null) {
				offline = dropped;
				latest = synthOfflineRelease(dropped.tag, dropped.tarballPath, dropped.sigPath);
				info(`No network — falling back to the local offline release: ${dropped.tarballPath}`);
			} else {
				const named =
					onchainSeen !== null && (localInfo === null || isNewerRelease(onchainSeen, localInfo.tag))
						? sanitizeForTerm(onchainSeen)
						: null;
				const lines = nothingFetchedLines({
					what:
						named !== null
							? `@morphit's on-chain release record names ${named}, but no place that publishes it could be reached, so nothing was downloaded. What was tried:`
							: 'Could not reach any place that publishes Morphit releases, so nothing was downloaded. What was tried:',
					tried: fetchErrors,
					current: localInfo !== null ? sanitizeForTerm(localInfo.tag) : 'what it ran before',
					host,
					offlineDir: offlineReleaseDir(installDir),
					tag: named
				});
				// One block (the reasons included), as before: callers read it whole.
				printError(lines.join('\n').replace(/^✗ /, ''));
				return 5;
			}
		} else if (primaryRelease === null) {
			info(
				`The primary (${host}/${repo}) did not answer, so a mirror is used to find the release. ` +
					"It installs only if it matches @morphit's signed on-chain release record or carries a pinned signature."
			);
		}
	}

	const currentTag = localInfo?.tag ?? '(unknown)';
	const latestTag = latest.tag_name;
	// The tag comes from a release source (a mirror
	// when the primary is down) and reaches file names and the confirmation
	// prompt. Only a version number is accepted.
	if (!RELEASE_VERSION_RE.test(latestTag)) {
		printError(
			`The release source named a version that is not a version number ` +
				`("${sanitizeForTerm(latestTag).slice(0, 40)}"), so nothing was changed.`
		);
		return 5;
	}
	// "Up to date" was plain string equality, so ANY
	// other tag — an older signed release a mirror served under the new name, or
	// an older on-chain re-broadcast — was installed as an "upgrade". Only a
	// strictly newer release is; --allow-downgrade is the explicit escape.
	const isNewer = isNewerRelease(latestTag, currentTag);
	const downgrading = !checkOnly && !isNewer && allowDowngrade && latestTag !== currentTag;
	const isUpToDate = !isNewer && !downgrading;

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
	if (onchainSeen !== null && isNewerRelease(onchainSeen, latestTag)) {
		info(
			`@morphit's on-chain release record names ${sanitizeForTerm(onchainSeen)}, which the release ` +
				`source did not offer yet. Run the upgrade again later to install it.`
		);
	}

	if (isUpToDate) {
		if (latestTag !== currentTag && compareTags(latestTag, currentTag) < 0) {
			info(
				`✓ The release offered (${latestTag}) is older than this install, so nothing was changed. ` +
					`To install it anyway, run the upgrade again with --allow-downgrade.`
			);
		} else {
			info('✓ Already on the latest release.');
		}
		return checkOnly ? 0 : healsWhenUpToDate();
	}

	console.log('');
	info(
		downgrading
			? `Downgrade requested (--allow-downgrade): ${latestTag}`
			: `Newer release available: ${latestTag}`
	);
	console.log('');
	// A hidden-only node fetches the tarball over Tor/I2P, so `latest.body` (the
	// Forgejo release body) is empty — morphitlat's operator saw a blank "Release
	// notes:" heading and upgraded blind. The tarball carries the notes
	// (docs/release-notes/RELEASE-NOTES-<tag>.md; at its top before v1.21.1), so
	// read them from there: same bytes the SHA-256 already covers, no clearnet,
	// nothing new to trust. (Up to v1.21.0 this looked for a RELEASE-NOTES.md the
	// tarball never had, so those nodes always saw "no release notes".)
	let notesBody = latest.body.trim();
	let notesMember: string | null = null;
	if (notesBody === '' && offline?.tarballPath) {
		const tarball = offline.tarballPath;
		const fromTar = await withSpinner('Reading the release notes from the tarball…', () =>
			readNotesFromTarballAsync(tarball, latestTag)
		);
		if (fromTar !== null) {
			notesBody = fromTar.body;
			notesMember = fromTar.member;
		}
	}
	if (notesBody === '') notesBody = '(no release notes available for this source)';
	showReleaseNotes(notesBody, () =>
		fullNotesPointer(latest.html_url, offline?.tarballPath ?? null, notesMember)
	);
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
		// What it may also do to the web firewall, said before the question
		// (L5): only where BunkerWeb runs.
		let bunkerweb = false;
		{
			const stop = startDotsSpinner('Looking for the web firewall (BunkerWeb)…');
			try {
				bunkerweb = findBunkerWebStack(join(installDir, 'apps', 'web', 'build')).stack !== null;
			} catch {
				bunkerweb = false;
			} finally {
				stop();
			}
		}
		const ok = await promptYes(
			// rl.question() is not sanitized, so a tag
			// carrying terminal escapes could repaint this question.
			`Apply ${downgrading ? 'DOWNGRADE' : 'upgrade'} from ${sanitizeForTerm(currentTag)} to ${sanitizeForTerm(latestTag)}?\n` +
				`This will: back up ${installDir}, install the new release, check that the site serves it, and restart the services` +
				(bunkerweb
					? `; and on the web firewall (BunkerWeb) it may change settings, recreate its containers, and ask Let's Encrypt to add the www address to the certificate.\n`
					: '.\n') +
				'(To upgrade without this question, e.g. from a script: sudo morphit-ops upgrade --yes)'
		);
		if (!ok) {
			if (lastPromptStoppedByCtrlC) {
				info('Stopped — you pressed Ctrl+C. Nothing was changed.');
				return 130;
			}
			info(
				`Not upgraded; nothing was changed. This server still runs ${sanitizeForTerm(currentTag)}.`
			);
			return 2;
		}
	}

	// ─── 5. Obtain the tarball ──────────────────────────────────
	const tmpDir = mkTempDir();
	let primaryHash: string | null = null;
	const tarballPath = join(tmpDir, chosenAssets.tarball.name);
	let bytesSource: ReleaseSource | null = null;
	let sigPath: string | null = null;

	if (offline !== null) {
		// OFFLINE (a --from-file / drop-dir tarball, or the one the hidden path
		// just fetched over Tor/I2P): copy it (+ its sibling .asc, if present) into
		// the scratch dir so verify/extract/cleanup are the same as online. There
		// is no primary here: step 6 needs the signed on-chain record or a pinned
		// signature.
		try {
			copyFileSync(offline.tarballPath, tarballPath);
			if (offline.sigPath !== null) {
				sigPath = `${tarballPath}.asc`;
				copyFileSync(offline.sigPath, sigPath);
			}
		} catch (err) {
			printError(
				`Could not read the local tarball: ${err instanceof Error ? err.message : String(err)}`
			);
			cleanupTmp(tmpDir);
			return 5;
		}
		// A non-null bytesSource just satisfies the "did we get bytes?" guard below;
		// it is never used as a network source offline.
		bytesSource = { host: 'local-file', repo: offline.tarballPath, isPrimary: false };
		info(`Using local tarball (${chosenAssets.tarball.name}).`);
		// A copy fetched over Tor/I2P sits in a temp dir of its own (resolver-made):
		// the scratch copy above is what is used from here on (v1.21.15 review).
		const fetched = hiddenResolution ?? hiddenFallback;
		if (fetched !== null) rmSync(dirname(fetched.tarballPath), { recursive: true, force: true });
	} else {
		// 5a. The primary's .sha256: a transit check, and a cross-check against the
		// chain in step 6. On its own it no longer makes a tarball installable.
		if (primaryRelease) {
			const primaryAssets = selectReleaseAssets(primaryRelease.assets);
			if (primaryAssets) {
				const primaryShaPath = join(tmpDir, 'primary.tar.gz.sha256');
				try {
					await withSpinner('Downloading the SHA-256 from the primary…', () =>
						downloadTo(primaryAssets.sha.browser_download_url, primaryShaPath)
					);
					primaryHash = parseShaFile(primaryShaPath);
				} catch (err) {
					warn(`Could not fetch the release's SHA-256 from ${host}: ${netFailureWords(err)}`);
				}
			}
		}

		// 5b. Download the tarball BYTES — primary first, then mirrors.
		const dlErrors: string[] = [];
		for (const { src, rel } of releasesBySource) {
			const a = selectReleaseAssets(rel.assets);
			if (!a) continue;
			try {
				info(
					`Downloading ${a.tarball.name} from ${src.host}${src.isPrimary ? ' (primary)' : ' (mirror)'}...`
				);
				await withSpinner(`Downloading the release from ${src.host}…`, () =>
					downloadTo(a.tarball.browser_download_url, tarballPath)
				);
				bytesSource = src;
				// Pull the detached signature from the SAME source, if present.
				if (a.sig) {
					sigPath = join(tmpDir, a.sig.name);
					const sig = { url: a.sig.browser_download_url, path: sigPath };
					try {
						await withSpinner('Downloading the release signature…', () =>
							downloadTo(sig.url, sig.path)
						);
					} catch {
						sigPath = null; // signature optional; the gate handles absence
					}
				}
				break;
			} catch (err) {
				dlErrors.push(`${src.host}: ${netFailureWords(err)}`);
			}
		}
		if (bytesSource === null) {
			const lines = nothingFetchedLines({
				what: `${latestTag} is listed, but its download did not complete from any place that publishes it, so nothing was installed. What was tried:`,
				tried: dlErrors,
				current: sanitizeForTerm(currentTag),
				host,
				offlineDir: offlineReleaseDir(installDir),
				tag: latestTag
			});
			printError(lines.join('\n').replace(/^✗ /, ''));
			cleanupTmp(tmpDir);
			return 5;
		}
	}

	// ─── 6. Verify integrity + decide trust ─────────────────────
	// The anchor is @morphit's signed release record for this exact version
	// (lib/releaseAnchor.ts), read through this node's own indexer first and, on
	// a hidden-only node, through nothing else. The hidden path already read and
	// verified it to know what to fetch, so it is reused.
	const wantOfflineHash = /-offline\.tar\.gz$/.test(chosenAssets.tarball.name);
	// Hidden-only decides where the record may be read from: this node's own
	// indexer, and nothing else. When it cannot be told, assume hidden-only.
	const nodeHiddenOnly =
		hiddenResolution !== null ||
		isHiddenOnlyNode() ||
		(await isHiddenOnly(hiddenOpts).catch(() => true));
	// The frontend and dist builds below are local (vite / esbuild / tsc). On a
	// hidden-only node npm is also told to stay offline and given no proxy, so
	// nothing it runs can leave the box.
	const localBuildEnv = nodeHiddenOnly
		? { ...withoutProxyEnv(process.env), npm_config_offline: 'true' }
		: undefined;
	// The signature needs no chain record, so it is checked first: a release
	// signed by a pinned key never waits for one.
	const signature: SignatureCheck =
		sigPath === null
			? 'absent'
			: checkDetachedSignature(
					installDir,
					tarballPath,
					sigPath,
					opts.trust?.signerFingerprints ?? RELEASE_SIGNER_FINGERPRINTS
				);
	let anchor: ReleaseAnchor | null = (hiddenResolution ?? hiddenFallback)?.anchor ?? null;
	if (anchor === null) {
		// v1.21.18: on a hidden-only node the indexer relays each read over
		// Tor/I2P, where one 1000-entry page of @morphit's history never arrived
		// (morphitlat, v1.21.16): a read there gets the time a page over Tor/I2P
		// needs, the history is read in small pages, and the block this node's
		// indexer names for the op is checked first — one small read. Clearnet
		// keeps its pages (one or two seconds each), and also gets the hint.
		const viaIndexer: CondenserRead =
			opts.trust?.chainRead ??
			((method, params) =>
				chainRead(method, params, {
					hiddenOnly: () => nodeHiddenOnly,
					hiddenReadTimeoutMs: RECORD_READ_TIMEOUT_HIDDEN_MS,
					...(opts.localIndexerBases !== undefined ? { indexerBases: opts.localIndexerBases } : {})
				}));
		// One answer without the record proves nothing: the indexer relays the read
		// to whichever node answers first, and a node behind the chain (or one
		// whose history does not list a record broadcast a minute ago) answers
		// without it (morphit.io, v1.21.2 → v1.21.3). The record is authenticated
		// by its signature, so every node may be asked: this node's indexer, then
		// each configured clearnet node directly (none on a hidden-only node).
		const sources: CondenserRead[] = [
			viaIndexer,
			...(opts.trust?.chainRead !== undefined
				? []
				: directNodeReaders({ hiddenOnly: () => nodeHiddenOnly }))
		];
		const anchorArgs = {
			tag: latestTag,
			signer: MORPHIT_RELEASE_ACCOUNT,
			pinnedPubkey: opts.trust?.postingPubkey ?? MORPHIT_OFFICIAL_POSTING_PUBKEY,
			chainId: BLURT_MAINNET_CHAIN_ID,
			...(nodeHiddenOnly
				? { pageSize: RECORD_PAGE_SIZE_HIDDEN, maxPages: RECORD_MAX_PAGES_HIDDEN }
				: {}),
			hint: await withSpinner(
				"Asking this node's indexer where @morphit's release record is…",
				() => readReleaseRecordHint(localIndexer, latestTag)
			)
		};
		const clockOpts = {
			...(opts.anchorWait?.now !== undefined ? { now: opts.anchorWait.now } : {}),
			...(opts.anchorWait?.sleep !== undefined ? { sleep: opts.anchorWait.sleep } : {})
		};
		let found = await withSpinner(
			`Reading @${MORPHIT_RELEASE_ACCOUNT}'s signed release record for ${latestTag} from the chain…`,
			() => findSignedReleaseAnchor({ sources, ...clockOpts }, anchorArgs)
		);
		if (!found.ok && 'notListed' in found && found.notListed === true && signature !== 'valid') {
			info(
				`  The record for ${latestTag} is not in the history these nodes serve yet: a record broadcast ` +
					'in the last few minutes can take a little while to appear there.'
			);
			found = await withSpinner(
				`Asking the nodes again for @${MORPHIT_RELEASE_ACCOUNT}'s release record (up to ${Math.round(RELEASE_RECORD_WAIT_MS / 60_000)} minutes)…`,
				() =>
					// A record that is merely late is among the newest entries: one page
					// per source each round, not four, for up to three minutes.
					findSignedReleaseAnchor(
						{ sources, waitMs: RELEASE_RECORD_WAIT_MS, intervalMs: 10_000, ...clockOpts },
						{ ...anchorArgs, maxPages: 1 }
					)
			);
		}
		if (found.ok) {
			anchor = found.anchor;
		} else {
			info(
				`  No signed on-chain release record to check against: ${sanitizeForTerm(found.reason)}.`
			);
		}
	}
	const chainHash =
		anchor === null ? null : wantOfflineHash ? anchor.offlineSha256 : anchor.sourceSha256;
	if (anchor !== null) {
		info(
			chainHash !== null
				? `  Found @${MORPHIT_RELEASE_ACCOUNT}'s signed release record for ${latestTag} (block ${anchor.blockNum}).`
				: `  @${MORPHIT_RELEASE_ACCOUNT}'s signed release record for ${latestTag} names no hash for the offline bundle; a pinned signature is needed for it.`
		);
	}
	const actualHash = computeSha256(tarballPath);
	const trust = integrityGate({
		signature,
		chainHash,
		primaryHash,
		actualHash,
		hidden: ((h) => (h !== null ? { servedBy: h.servedBy, tag: latestTag } : null))(
			hiddenResolution ?? hiddenFallback
		)
	});
	if (!trust.allowed) {
		printError(`Cannot verify the integrity of release ${latestTag}.\n  ${trust.reason}`);
		cleanupTmp(tmpDir);
		return 5;
	}
	info(`\u2713 Integrity verified (${trust.proof}). ${trust.reason}`);

	// ─── 7. Backup current install ──────────────────────────────
	// before we rename installDir out from under ourselves, move THIS
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
	// files changed outside the install dir from here
	// on (refreshed units, self-heal edits), for rollback() to put back.
	const restoreOnRollback: RollbackRestore[] = [];
	// From here until the services run the new release, a signal does not end
	// the process half-way: the previous install is put back (H2).
	const guard = guardInstallWindow();
	lastFailedStepLog = null;
	const undo = async (
		err: unknown,
		web?: Parameters<typeof rollback>[4],
		restore: readonly RollbackRestore[] = [],
		/** Said first when it was a failure, not a stop (v1.21.18 audit, L4:
		 *  "Extract failed" was printed for a Ctrl+C, before this wait). */
		failedLine?: string
	): Promise<number> => {
		// The signal also reaches the step's own child (tar, npm …), and its exit
		// can be seen before this process has run its own signal handler: give
		// that handler a moment, so a closed SSH session is not reported as
		// "tar exited 1" (seen under load in the battery, 2026-10-29).
		if (guard.signal() === null && err !== null) await new Promise((r) => setTimeout(r, 250));
		const sig = guard.signal();
		if (sig === null && failedLine !== undefined) warn(failedLine);
		try {
			const code = await rollback(
				installDir,
				backupDir,
				tmpDir,
				sig !== null ? new UpgradeStopped(sig) : err,
				web,
				restore
			);
			// Stopped and put back: the signal's own exit code (Ctrl+C 130);
			// a rollback that needs a hand (4) says so whatever stopped it.
			return sig !== null && code === 3 ? signalExitCode(sig) : code;
		} finally {
			guard.release();
		}
	};
	/** A signal came during the step that just ended: put the previous install
	 *  back. Waits a turn first, so a signal that arrived while a blocking
	 *  child ran is seen (H1). */
	const stoppedHere = async (web?: Parameters<typeof rollback>[4]): Promise<number | null> => {
		await settleSignals();
		return guard.signal() !== null ? undo(null, web, restoreOnRollback) : null;
	};
	info(`Backing up ${installDir} → ${backupDir}`);
	try {
		renameSync(installDir, backupDir);
	} catch (err) {
		guard.release();
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
		// defense-in-depth tar flags.
		//
		// GNU tar's documented defaults already refuse two of
		// the three classical tarball-extract escapes:
		//   - absolute paths (entry name starts with `/`) are
		//     stripped to relative with a warning, then
		//     extracted inside -C target;
		//   - `..` traversal entries are refused outright.
		// Empirically verified audit time.
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
		// Unpacking is long and silent: under the turning spinner (tar's own
		// output is shown only when it fails).
		const tarCode = await runStepWithSpinner(
			'Unpacking the new release…',
			'tar',
			[
				'-xzf',
				tarballPath,
				'-C',
				installDir,
				'--strip-components=0',
				'--no-same-owner',
				'--no-same-permissions',
				'--no-overwrite-dir'
			],
			{ quietOnSuccess: true, warningsOnSuccess: false, name: 'tar -xzf' }
		);
		if (tarCode !== 0) throw stepFailed(`tar -xzf ${tarballPath} exited ${tarCode}`);
	} catch (err) {
		return undo(err, undefined, [], `Extract failed; rolling back to ${backupDir}.`);
	}
	{
		const st = await stoppedHere();
		if (st !== null) return st;
	}

	// ─── 8a. The tarball must BE the release we chose ──────────────
	// Nothing checked that the extracted tree was the
	// version the source named: a mirror could serve an older signed tarball
	// under the new release's name and the banner would still say the new
	// version. The tarball's own release-info.json must name the chosen tag.
	{
		const extracted = readLocalReleaseInfo(installDir);
		if (extracted === null || !sameReleaseTag(extracted.tag, latestTag)) {
			warn(
				`The downloaded tarball is ${extracted === null ? 'not a Morphit release' : `release ${sanitizeForTerm(extracted.tag)}`}, ` +
					`not ${latestTag}; putting the previous install back.`
			);
			return undo(new Error(`tarball does not contain ${latestTag}`));
		}
	}

	// ─── 8b. Carry the operator's config + keys forward ────────────
	//
	// CRITICAL: the wizard writes the operator's config and
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
		return undo(err);
	}
	{
		const st = await stoppedHere();
		if (st !== null) return st;
	}

	// detect whether this upgrade crossed an indexer schema.sql
	// change. Both the old tree (now backupDir) and the new tree are on disk
	// at this point. If the baseline changed, an existing DB won't pick up
	// the in-place schema edits on its own, so we remind the operator at the
	// end to reset + re-sync the (chain-derived) indexer DB.
	// Only warn when the schema moved WITHOUT a migration to carry it — a
	// numbered migration is applied automatically at indexer start-up, so
	// warning then is a false alarm that invites an unnecessary DB reset.
	const schemaChanged = schemaChangedWithoutMigration(backupDir, installDir);

	// Secure the box's global npmrc BEFORE any root `npm` runs below (review B8).
	// The self-heal phase (step 10) also repairs it, but that is AFTER this
	// upgrade's own `npm ci`/`npm install` — too late to matter if the file had
	// been left world-writable and a code-execution key planted in it, since that
	// npm would already have run it as root. Doing it here strips such a key
	// first. Best-effort; never throws.
	try {
		const stopNpmrc = startDotsSpinner("Checking the box's global npm settings…");
		let npmrc: ReturnType<typeof healNpmNoticeGlobal>;
		try {
			npmrc = healNpmNoticeGlobal();
		} finally {
			stopNpmrc();
		}
		if (npmrc && npmrc.strippedKeys.length > 0) {
			warn(
				`Removed unexpected setting(s) from the box's global npmrc (${npmrc.path}) that had been ` +
					`left writable by a non-root account and could run code as root: ${npmrc.strippedKeys.join(', ')}. ` +
					`The file is now root-owned 0644. If you added any of these deliberately, re-add them with ` +
					`\`sudo npm config set --location=global …\` and then \`sudo chmod 644 ${npmrc.path}\`.`
			);
		}
	} catch {
		/* best-effort — never fail an upgrade over the npmrc repair */
	}

	// ─── 9. Install workspace dependencies ─────────────────────
	// Lifecycle scripts never run (--ignore-scripts): this runs as root, and a
	// dependency's install script is code from whoever published it. The only
	// packages that need one build native add-ons for the Matrix bot; those are
	// reused from the previous install when their version did not change (see
	// lib/depsInstall.ts) and otherwise rebuilt only where the bot runs.
	try {
		// A self-contained OFFLINE tarball ships a prebuilt node_modules carrying
		// the .morphit-bundle-complete marker — the same marker the Ansible install
		// checks. When present, nothing is installed.
		const bundleMarker = join(installDir, 'node_modules', '.morphit-bundle-complete');
		if (existsSync(bundleMarker)) {
			info('Offline bundle detected (prebuilt node_modules) — nothing to download.');
		} else if (nodeHiddenOnly) {
			// Zero-clearnet: reuse, or the registry through Tor only, or refuse.
			const socks = parseHostPortOr(
				readConfigValue(hiddenConfigEnvPaths, 'MORPHIT_INDEXER_TOR_SOCKS'),
				'127.0.0.1',
				9050
			);
			const outcome = await installDepsForHiddenNode({
				installDir,
				previousDir: backupDir,
				socks,
				runNpm: (args, env) =>
					runStepWithSpinner(
						'Installing dependencies through Tor — this can take several minutes…',
						'npm',
						args,
						{
							cwd: installDir,
							env
						}
					),
				copyTree: (from, to) =>
					runStepWithSpinner('Reusing the installed dependencies…', 'cp', [
						'-a',
						'--',
						from,
						to
					]).then((c) => c === 0),
				info
			});
			if (!outcome.ok) {
				throw stepFailed(
					`${outcome.reason}. To finish privately, bring the offline bundle to this box ` +
						`(morphit-${latestTag}-offline.tar.gz, from any mirror, on a USB stick if need be) and run on this box: ` +
						`sudo morphit-ops upgrade --from-file=/path/to/morphit-${latestTag}-offline.tar.gz ` +
						"(it is checked against @morphit's signed release record)"
				);
			}
			info(`\u2713 Dependencies ready (${outcome.strategy}: ${outcome.detail}).`);
		} else {
			await installDepsWithNpmCi(installDir, backupDir);
		}
		await ensureMatrixBotNatives(installDir, nodeHiddenOnly);
	} catch (err) {
		return undo(err, undefined, [], 'Installing dependencies did not complete; rolling back.');
	}
	{
		const st = await stoppedHere();
		if (st !== null) return st;
	}

	// ─── 9b. Rebuild the static web frontend (ALWAYS) ───
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
	// (Previously the build lived inside an `if (webRoot exists)` branch,
	// so on a container-served host — where the site is NOT served from
	// /var/www/morphit-frontend — the upgrade silently skipped the frontend
	// rebuild, reported success, and the container kept serving the OLD
	// build. That regression is what this unconditional build + the
	// publish plan below fix.)
	//
	// (canary) / — capture who should own apps/web/build so
	// we can restore it AFTER the rebuild. `npm run build` runs as root (sudo
	// morphit-ops) and vite RECREATES this dir root-owned — but it is ALSO the dir
	// the operator's (non-root) warrant-canary refresh uploads canary.txt +
	// pgp_keys.asc into over SSH, and the bind-mount frontend model serves straight
	// from it. Without restoring the owner afterward, every upgrade re-roots the
	// served dir and the next weekly canary upload fails with EACCES.
	//
	// read the owner from the OLD install (backupDir), NOT the fresh tree.
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
		// The release's own prebuilt frontend is the normal case: nothing to say.
		if (!existsSync(shippedBuild)) {
			info('No prebuilt frontend in this release — building the web frontend (apps/web)...');
			const buildCode = await runStepWithSpinner(
				'Building the web frontend — this can take a few minutes…',
				'npm',
				['run', 'build'],
				{ cwd: join(installDir, 'apps', 'web'), env: localBuildEnv, quietOnSuccess: true }
			);
			if (buildCode !== 0) throw stepFailed(`npm run build exited ${buildCode}`);
		}
	} catch (err) {
		// Nothing served has been touched yet (the build writes to
		// apps/web/build inside the install), so a build failure rolls back
		// cleanly.
		return undo(err, undefined, [], 'Frontend build failed; rolling back.');
	}
	{
		const st = await stoppedHere();
		if (st !== null) return st;
	}

	// ─── 9b1. Restore served-dir ownership + auto-restore the canary ──
	//
	// The rebuild re-rooted apps/web/build (and static/) and WIPED build/canary.txt
	// (it's written in AFTER the vite build, so a rebuild always drops it). Two
	// moves, both best-effort — the build already succeeded, so nothing here rolls
	// it back:
	//   1. Hand build/ AND static/ back to the non-root canary owner. The refresh
	//      writes static/canary.txt (generate.sh) then copies it into build/, so it
	//      needs BOTH writable; without this every upgrade re-roots them and the
	//      next canary upload/refresh fails with EACCES ("Permission denied").
	//   2. if this is a SAME-BOX operator (they sign HERE — their
	//      ~/.morphit/update-canary.sh exists), run that refresh AS them right now to
	//      put the canary straight back, no manual step. Placed BEFORE step 9c so the
	//      restored canary.txt is included when 9c copies build/ into a web root.
	//      REMOTE operators sign on a separate laptop → no refresh script here → this
	//      skips and the reminder near the end fires instead. Guarded: non-interactive
	//      + 90s timeout + no controlling tty, so a passphrase-protected key can never
	//      hang the upgrade; any failure falls through to the reminder.
	//   0. FIRST, while the new build/ is still root-owned: put back the canary
	//      that was served before the upgrade (canary.txt + pgp_keys.asc, the
	//      same signed bytes — lib/canaryCarry.ts). A canary signed on another
	//      computer used to be missing from every upgrade until its operator
	//      re-ran the refresh (morphit.io, vigilante.trading, v1.21.7), which
	//      reads as a canary that tripped. Its dates still run out on their own;
	//      the refresh below, on a box that signs here, replaces it with a new one.
	let canaryAutoRefreshed = false;
	const canaryCarried = carryOldCanary(backupDir, installDir);
	if (canaryDirUid >= 0) {
		const webBuild = join(installDir, 'apps', 'web', 'build');
		const webStatic = join(installDir, 'apps', 'web', 'static');
		// Run BOTH chowns (no short-circuit) so static/ is fixed even if build/ fails.
		let chownOk = true;
		for (const dir of [webBuild, webStatic]) {
			if (
				spawnSync('chown', ['-R', `${canaryDirUid}:${canaryDirGid}`, dir], { stdio: 'ignore' })
					.status !== 0
			) {
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

		// same-box auto-restore. Two mechanisms, tried in order:
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
		//      non-root owner (the original path — an operator who ran
		//      scripts/canary/setup.sh by hand as themselves, so their refresh lives
		//      in their own ~/.morphit and no system unit exists).
		// Either restores the canary immediately with no manual step; if BOTH miss,
		// the reminder near the end fires (and the weekly timer republishes on its
		// own regardless, well before the 14-day staleness window).
		// Auto-restore the canary if one is SET UP on this box — not merely if the
		// backup still held canary.txt. A prior upgrade can wipe the served file
		// before the weekly timer re-publishes, so gating on the backup file skipped
		// same-machine operators whose canary was mid-cycle (timeapp — the
		// upgrade broke his same-machine canary and didn't renew it). Detect the
		// setup two independent ways: the systemd unit, or the owner's refresh
		// script — and if EITHER exists, restore now regardless of the backup file.
		const hadCanaryFile = existsSync(join(backupDir, 'apps', 'web', 'build', 'canary.txt'));
		const haveCanaryUnit =
			spawnSync('systemctl', ['cat', 'morphit-canary.service'], {
				stdio: 'ignore',
				timeout: 10_000
			}).status === 0;
		const pw = spawnSync('getent', ['passwd', String(canaryDirUid)], { encoding: 'utf8' });
		const refreshTarget =
			pw.status === 0 && typeof pw.stdout === 'string' ? parsePasswdRefreshTarget(pw.stdout) : null;
		const haveRefreshScript = refreshTarget !== null && existsSync(refreshTarget.refreshScript);
		if (hadCanaryFile || haveCanaryUnit || haveRefreshScript) {
			if (haveCanaryUnit) {
				info('');
				info('Restoring your warrant canary automatically (running its scheduled refresh now)...');
				const start = await runSpinning(
					'Running the canary refresh (up to 3 minutes)…',
					'systemctl',
					['start', 'morphit-canary.service'],
					{ timeoutMs: 180_000 }
				);
				if (start.status === 0) {
					canaryAutoRefreshed = true;
					info('\u2713 Warrant canary restored automatically — nothing to do.');
				} else {
					info("(Couldn't trigger the canary service automatically; see the note below.)");
				}
			}
			if (!canaryAutoRefreshed && refreshTarget && haveRefreshScript) {
				info('');
				info(
					`Restoring your warrant canary automatically (running your refresh as ${refreshTarget.user})...`
				);
				// `sudo -n` never asks for a password, so the spinner is safe here.
				const refresh = await runSpinning(
					'Running the canary refresh (up to 90 s)…',
					'sudo',
					['-n', '-u', refreshTarget.user, '-H', 'bash', refreshTarget.refreshScript],
					{ timeoutMs: 90_000, env: { ...process.env, GPG_TTY: '' } }
				);
				if (refresh.status === 0) {
					canaryAutoRefreshed = true;
					info('\u2713 Warrant canary restored automatically — nothing to do.');
				} else {
					info("(Couldn't refresh the canary automatically; restore it manually — see below.)");
				}
			}
		}
	}

	afterCanaryRefresh(
		canaryCarried,
		canaryAutoRefreshed,
		Date.now(),
		(u) => spawnSync('systemctl', ['cat', u], { stdio: 'ignore', timeout: 10_000 }).status === 0
	);

	// ─── 9b2. Rebuild the dist-shipping workspaces ─────
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
			const code = await runStepWithSpinner(
				`Building ${wsDir === 'ops-cli' ? 'morphit-ops' : 'the MCP server'} for this release…`,
				'npm',
				['run', '--silent', 'build'],
				{ cwd: join(installDir, 'apps', wsDir), env: localBuildEnv, quietOnSuccess: true }
			);
			if (code !== 0) throw new Error(`npm run build exited ${code}`);
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

	{
		const st = await stoppedHere();
		if (st !== null) return st;
	}

	// ─── 9c. Publish the freshly-built frontend ────────────────
	//
	// Decide how to publish from two signals:
	//   • bare-metal nginx → <webRoot> exists → copy build/ into it.
	//   • containerized → a RUNNING container bind-mounts the build dir →
	//     `docker restart` it so it re-binds the new build (a running
	//     container keeps serving the pre-upgrade inode after the install
	//     dir was renamed above).  beta11: the container is identified by
	//     its apps/web/build mount, NOT by a name or compose file — the older
	//     `morphit-frontend`-name + repo-example-compose assumptions broke on
	//     real deployments (a compose project names it `<proj>-frontend-1`,
	//     and recreating it from the repo's example compose crash-looped on a
	//     cert path the operator's real stack didn't share).
	// Both may apply (do both); neither is a non-standard setup that earns a
	// loud warning — the build is fresh on disk either way.
	const buildDir = join(installDir, 'apps', 'web', 'build');
	const frontendContainer = await withSpinner('Looking for the frontend container…', () =>
		findFrontendContainerAsync(buildDir)
	);
	const plan = planFrontendDeploy({
		webRootExists: existsSync(webRoot),
		frontendContainer,
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
	// correct config + on-chain registration (seen on an instance at v1.17.0). operator_tag
	// here is INFORMATIONAL (matches /v1/instance + the directory); fee attribution
	// comes from the runtime indexer config and is unaffected either way.
	try {
		const opTag = readOperatorTagFromConfig();
		// Routine (every upgrade, every box): nothing to say (L1).
		if (opTag) patchVerifyJsonOperatorTag(buildDir, opTag);
	} catch {
		/* non-fatal — verify.json's operator_tag is informational */
	}
	// ─── 9b3. Re-apply this operator's branding (docs/BRANDING.md) ──
	//
	// The operator's logo / icons (/etc/morphit/branding) and brand name
	// (MORPHIT_INSTANCE_BRAND_NAME…) live OUTSIDE the install, so they survive
	// this upgrade; the fresh canonical build is re-branded in place here, BEFORE
	// either publish path, so the new frontend goes live already branded. Only
	// files the on-chain build-integrity check does not cover are touched.
	// NEVER fatal: a bad logo file must not roll back a good upgrade — on any
	// failure the build is left (or put back) plain Morphit, and we say how to fix.
	//
	// First: this instance's own origin in the pages, sitemap and
	// robots.txt, on the still-unbranded fresh build (brand slots are offsets
	// into the same pages). A hidden-only node never gets a clearnet origin.
	// Non-fatal, like the branding; the self-heal phase repeats it on the
	// served build.
	try {
		const o = resolveInstanceOrigin(installDir, nodeHiddenOnly);
		const r = syncInstanceOrigin(
			{ info, warn, spinner: (l) => startDotsSpinner(l) },
			{ installDir, buildDir, origin: o, webRoot: null }
		);
		// Its detail says what changed or what is wrong; "already" says nothing
		// (it printed "Instance origin: … — already.", L1).
		if (r.detail !== '') (r.verified ? info : warn)(sanitizeForTerm(r.detail));
	} catch (err) {
		warn(
			`Your instance origin could not be applied (${sanitizeForTerm(err instanceof Error ? err.message : String(err))}); ` +
				"pages name the build's origin until fixed. Run: sudo morphit-ops upgrade"
		);
	}
	try {
		const brandingSettings = readBrandingSettings(installDir);
		// Synchronous (it draws the icons): the spinner's label is on the line for it.
		const stopBrand = startDotsSpinner(
			brandingConfigured(brandingSettings)
				? 'Applying your branding to the new frontend…'
				: 'Checking the new frontend’s branding…'
		);
		let br: ReturnType<typeof applyBranding>;
		try {
			br = applyBranding({ buildDir, settings: brandingSettings });
		} finally {
			stopBrand();
		}
		if (!br.unsupported && br.active) {
			info(
				`\u2713 Applied your branding${br.brandName ? ` ("${sanitizeForTerm(br.brandName)}")` : ''} to the new frontend.`
			);
		}
		for (const w of br.warnings) warn(sanitizeForTerm(w));
	} catch (err) {
		warn(
			`Your branding could not be applied (${sanitizeForTerm(err instanceof Error ? err.message : String(err))}), ` +
				'so the plain Morphit look is served. Fix it, then run: sudo morphit-ops branding apply'
		);
		try {
			applyBranding({ buildDir, settings: readBrandingSettings(installDir), reset: true });
		} catch {
			/* the fresh build is canonical unless apply got partway — best-effort */
		}
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
			return undo(err, { webRoot, webRootBackup }, [], 'Frontend redeploy failed; rolling back.');
		}
	}
	if (plan.restartContainer) {
		// Best-effort: the backend already upgraded and the build is fresh, so
		// a docker hiccup must NOT roll the whole upgrade back.
		await restartFrontendContainer(plan.restartContainer, installDir, {
			stopped: () => guard.signal() !== null
		});
		// A stop during the rebuild ends here: the previous install goes back
		// (v1.21.18 audit, M2: the fallback build, a restart and the checks ran on).
		const st = await stoppedHere({ webRoot, webRootBackup, container: plan.restartContainer });
		if (st !== null) return st;
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
	// For the last word: true only when the served frontend was seen to be this build.
	const frontendVerified = await verifyServedFrontend(plan, buildDir, webRoot);
	{
		const st = await stoppedHere({ webRoot, webRootBackup, container: plan.restartContainer });
		if (st !== null) return st;
	}

	// ─── 9d-bis. Offer a warrant canary when the footer link would 404 (v1.17.1) ──
	//
	// The site footer UNCONDITIONALLY links /canary.txt. If this box serves no
	// canary AND has no way to make one, that link is a permanent 404 — bad for
	// visitors and terrible for SEO (seen on an instance: registered, upgraded, but the
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
		if (servedCanary || backupHadCanary) recordCanarySeen(canaryMarker);
		const everHadCanary = existsSync(canaryMarker);

		// And ask the LIVE SITE, which is what the footer link actually hits. The
		// build dir is only one way a canary can be served.
		let liveCanary = false;
		try {
			// Local reader: the shared one is defined further down, out of scope here.
			// Both config files are checked — settings live in either, depending on
			// how the instance was installed.
			const readCfgKey = (key: string): string => {
				for (const f of [join(installDir, 'morphit.config.env'), join(installDir, 'morphit.env')]) {
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
				liveCanary = await withSpinner('Asking this site for its warrant canary…', () =>
					probeLiveCanaryAsync(origin)
				);
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
				// A Ctrl+C at its questions reached it and this process: the stop
				// is handled below, nothing more is said about the canary (H1).
				await settleSignals();
				const setupErr = res.error as NodeJS.ErrnoException | undefined;
				if (isStopSignal(res.signal) && setupErr?.code !== 'ETIMEDOUT') guard.note(res.signal);
				if (guard.signal() !== null) {
					/* stopped: the rollback below says what happens */
				} else if (res.status === 0) {
					info('\u2713 Warrant canary set up and scheduled — the footer link now resolves.');
				} else {
					warn(`Canary setup didn't finish; you can run it anytime: sudo bash ${setupScript}`);
				}
			} else {
				// Ctrl+C (or a closed session) at the question is a stop, not a
				// "no": nothing more is said here (v1.21.18 audit, L3).
				await settleSignals();
				if (!lastPromptStoppedByCtrlC && guard.signal() === null)
					info(
						`No problem — skipping the canary. Set it up anytime with: ` +
							`sudo bash ${join(installDir, 'scripts', 'canary', 'setup.sh')}`
					);
			}
		}
	} catch {
		// best-effort — the canary offer must NEVER fail or hang the upgrade
	}

	{
		const st = await stoppedHere({ webRoot, webRootBackup, container: plan.restartContainer });
		if (st !== null) return st;
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
				// a rollback puts the previous unit back.
				if (r.backupPath) {
					restoreOnRollback.push({
						target: join(process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system', r.unit),
						backup: r.backupPath,
						isUnit: true
					});
				}
			}
			const reloaded = reloadNeeded
				? (await systemctlSpinning('Reloading systemd…', ['daemon-reload'])).status === 0
				: true;
			info(
				`Refreshed ${refreshed.length === 1 ? 'the service file' : `${refreshed.length} service files`} from this release: ` +
					`${refreshed.map((r) => r.unit).join(', ')} (each previous copy kept as <name>.bak)` +
					(reloadNeeded && reloaded ? '; systemd reloaded.' : '.')
			);
			if (!reloaded) {
				warn('Could not run `systemctl daemon-reload`; run it by hand before restarting.');
			}
		}
	} catch (err) {
		warn(
			`Could not refresh systemd unit files (continuing): ` +
				`${err instanceof Error ? err.message : String(err)}`
		);
	}

	// ─── 9f. Refresh the helper scripts Ansible copied into /usr/local/lib/morphit ──
	// Same rule as the units above: the timers/units run COPIES Ansible made
	// once, so a fix to morphit-first-online.sh / morphit-ipfs-pin.sh /
	// ipns-rebroadcast / ipfs-privacy / backup never reached an installed box
	// (wave 2, C3/C17). Only installed + differing files are replaced (with a
	// .bak, atomically, 0755 root:root, never through a link) and each is read
	// back to verify. A rollback puts the previous copy back. Best-effort.
	try {
		const helperDir = process.env.MORPHIT_HELPER_DIR ?? DEFAULT_HELPER_DIR;
		// Its log lines are failures (each says what happened): warnings.
		const helperResults = refreshHelperScripts({ releaseRoot: installDir, helperDir, log: warn });
		for (const r of helperResults) {
			if (r.action === 'refreshed' && r.backupPath) {
				restoreOnRollback.push({ target: join(helperDir, r.name), backup: r.backupPath });
			}
		}
		const helperLine = describeHelperRefresh(helperResults, helperDir);
		if (helperLine !== null) info(helperLine);
	} catch (err) {
		warn(
			`Could not refresh the helper scripts in /usr/local/lib/morphit (continuing): ` +
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
	captureTorOnion(join(installDir, 'morphit.config.env'));

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
				info(
					`Repaired an invalid contact URL in ${cfg}: "${sanitizeForTerm(rawVal)}" → "${sanitizeForTerm(fixed)}"`
				);
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
	// note the heal backups before the phase, so a
	// rollback restores exactly the files THIS run's heals changed.
	const envRoot = process.env.MORPHIT_ENV_ROOT ?? '';
	const healSnapshot = snapshotSelfHealBackups(RELAY_ENV_TARGETS.map((f) => `${envRoot}${f}`));
	// Wave 4 (P7): the self-heal phase now also refreshes the /usr/local/lib/morphit
	// helpers (`<name>.bak` first) — note their backups too, so a rollback after
	// the phase puts the previous helpers back like every other healed file.
	const helperDirForSnap = process.env.MORPHIT_HELPER_DIR ?? DEFAULT_HELPER_DIR;
	const helperSnapshot = snapshotSelfHealBackups(
		HELPER_SCRIPTS.map((h) => join(helperDirForSnap, h.name)),
		(t) => `${t}.bak`
	);
	// The heal phase leaves its open questions (and its warning count) here for
	// the last word (step 14); clear what an earlier run may have left.
	takeUpgradeQuestions();
	takeChildWarnings();
	// The heal phase ran as a child process: its warnings reach the last word
	// only through the count it leaves (an older release's child leaves none).
	let healChildRan = false;
	try {
		const newCli = join(installDir, 'apps', 'ops-cli', 'dist', 'main.js');
		if (existsSync(newCli)) {
			const r = spawnSync(process.execPath, [newCli, '__post-upgrade-selfheal'], {
				stdio: 'inherit',
				// This upgrade names what is left in its last lines (step 14).
				env: { ...process.env, MORPHIT_UPGRADE_SUMMARIZES: '1' },
				// Shared with the web-proxy heal, which finishes (or rolls back) before it.
				timeout: SELF_HEAL_CHILD_TIMEOUT_MS
			});
			// (pid 0: it could not be started at all.)
			healChildRan = typeof r.pid === 'number' && r.pid > 0;
			selfHealReexeced = r.status === 0;
			// The child was stopped by Ctrl+C or a closed session (not by its own
			// time limit, which also ends it with SIGTERM): that is a stop, even
			// when this process was not sent the signal itself.
			const childErr = r.error as NodeJS.ErrnoException | undefined;
			if (isStopSignal(r.signal) && childErr?.code !== 'ETIMEDOUT') guard.note(r.signal);
		}
	} catch {
		/* fall back to in-process below */
	}
	// A signal that came while spawnSync blocked reaches its handler only on a
	// turn of the event loop: wait for it before deciding (v1.21.18 audit, H1:
	// the heals then ran AGAIN in this process before the stop was seen).
	await settleSignals();
	if (guard.signal() !== null) {
		// Stopped while the heal phase ran (it got the signal too): its edits
		// are put back with the rest, never run again in-process.
		restoreOnRollback.push(...selfHealRestoreList(healSnapshot, installDir));
		restoreOnRollback.push(...selfHealRestoreList(helperSnapshot, installDir));
		return undo(
			null,
			{ webRoot, webRootBackup, container: plan.restartContainer },
			restoreOnRollback
		);
	}
	if (!selfHealReexeced) {
		// Run here instead: its open questions still go to this upgrade's last
		// lines (step 14), not into the middle of the output.
		process.env.MORPHIT_UPGRADE_SUMMARIZES = '1';
		await runSelfHeals();
	}
	restoreOnRollback.push(...selfHealRestoreList(healSnapshot, installDir));
	restoreOnRollback.push(...selfHealRestoreList(helperSnapshot, installDir));

	// Every service restarted here was seen to stay up on the new version (else
	// the upgrade rolls back); one that was down before and still is, an MCP or
	// Matrix bot that did not come back, or no service restarted at all, clears it.
	// The units and helpers refreshed above (step 9e/9f): a stop before the
	// restarts puts them back too.
	{
		const st = await stoppedHere({ webRoot, webRootBackup, container: plan.restartContainer });
		if (st !== null) return st;
	}
	// A stop is looked for before each service and while each is watched
	// (v1.21.18 audit, M1: it was not, so the next service was restarted too,
	// and the upgrade then went on for up to an hour of optional steps).
	const restartsDone = await restartServicesOnNewVersion(SERVICES_TO_RESTART, {
		stopped: () => guard.signal() !== null
	});
	if ('rollback' in restartsDone)
		return undo(
			restartsDone.rollback,
			{ webRoot, webRootBackup, container: plan.restartContainer },
			restoreOnRollback
		);
	// A stop that came while the last service was watched: its message said
	// the previous install is put back, so it is.
	{
		const st = await stoppedHere({ webRoot, webRootBackup, container: plan.restartContainer });
		if (st !== null) return st;
	}
	// Every service runs the new release (each was seen to stay up): the
	// install is whole. A signal from now on undoes nothing; the steps still
	// left are skipped, each named with how to do it (finishStop below).
	guard.finishing(latestTag);
	let servicesVerified = restartsDone.verified;
	const systemdDir = process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system';
	const matrixUnitPath = join(systemdDir, MATRIX_BOT_UNIT);
	/** Stopped after the install was whole: say what is done and what was
	 *  skipped or cut short — `from` (the step that ran last, which the
	 *  signal may have ended) on — and end with the signal's exit code. */
	const finishStop = async (from: FinishStep): Promise<number | null> => {
		await settleSignals();
		const sig = guard.signal();
		if (sig === null) return null;
		let ipfsUp = false;
		{
			const stopSpin = startDotsSpinner('Checking whether this server hosts IPFS…');
			try {
				ipfsUp =
					spawnSync(
						'sh',
						['-c', 'command -v ipfs >/dev/null 2>&1 && systemctl is-active --quiet ipfs'],
						{ stdio: 'ignore', timeout: 8000 }
					).status === 0;
			} finally {
				stopSpin();
			}
		}
		const lines = stoppedAfterInstallLines({
			why: stoppedWhy(sig),
			tag: latestTag,
			from,
			installDir,
			backupDir,
			mcp: existsSync(join(systemdDir, 'morphit-mcp.service'))
				? {
						deployScript: join(installDir, 'ops', 'scripts', 'deploy-mcp.sh'),
						dest: process.env.MORPHIT_MCP_DEPLOY_DIR ?? '/opt/morphit-mcp',
						user: process.env.MORPHIT_MCP_DEPLOY_USER ?? 'morphit-mcp'
					}
				: null,
			matrix: existsSync(matrixUnitPath),
			gateway: existsSync(join(installDir, 'ops', 'ipfs', 'morphit-gateway-firewall-heal.sh')),
			ipfs: ipfsUp
				? {
						mirrorScript: existsSync(join(installDir, 'ops', 'snapshot-mirror.sh'))
							? join(installDir, 'ops', 'snapshot-mirror.sh')
							: null
					}
				: null
		});
		const note = keepStoppedNote(lines);
		for (const l of lines) info(l);
		if (note !== null) info(`  (These lines are also kept on this server: sudo cat ${note})`);
		cleanupTmp(tmpDir);
		guard.release();
		return signalExitCode(sig);
	};
	{
		const st = await finishStop('mcp');
		if (st !== null) return st;
	}

	// ─── 10b. Redeploy + restart the MCP (its own isolated tree) ──
	// The MCP runs from a SELF-CONTAINED tree at /opt/morphit-mcp, separate
	// from the /opt/morphit install dir swapped above, so it does NOT pick
	// up new code from the swap — its source and the runtime packages it copies
	// out of this install's locked node_modules (no registry, no install
	// scripts) must be re-deployed and the service then restarted, or morphit-mcp keeps
	// running the OLD version forever (manually running deploy-mcp.sh +
	// restart after every upgrade was the previous rough edge).  Gated on
	// the unit being installed, so boxes without the MCP are untouched.  The
	// MCP is isolated, read-only, and non-critical, so a failure here WARNS
	// rather than rolling back the whole upgrade — morphit.io is unaffected.
	if (!(await redeployMcpOnUpgrade(installDir, { stopped: () => guard.signal() !== null })))
		servicesVerified = false;
	// (No MCP unit on this server: nothing to redeploy, nothing to say.)
	{
		const st = await finishStop('mcp');
		if (st !== null) return st;
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
	if (existsSync(matrixUnitPath) && !(await syncMatrixBotOnUpgrade())) servicesVerified = false;
	{
		const st = await finishStop('matrix');
		if (st !== null) return st;
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
		await withSpinner('Giving them a few seconds to stop…', () => sleepMs(3_000));
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

	{
		const st = await finishStop('sweep');
		if (st !== null) return st;
	}
	// ─── 10e. Keep the DB backup Docker-aware (v1.8.4 B) ──
	// If the operator's Postgres is containerized but their backup.env still
	// points a host pg_dump at it (DB_CONTAINER empty), the daily backup
	// silently captures nothing. Detect + warn with the one-line fix. No-op for
	// a host Postgres or an already-Docker-aware config.
	await ensureBackupDockerAware(installDir);

	// ─── 11. Prune old backups (tmp is cleaned AFTER the seed below, so
	//         the seed can reuse the tarball we already downloaded) ──
	pruneOldBackups(installDir);

	{
		const st = await finishStop('prune');
		if (st !== null) return st;
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

	{
		const st = await finishStop('gateway');
		if (st !== null) return st;
	}
	// A seed a stop ended is named in the upgrade's last lines, not as a failure.
	const reportSeedUnlessStopped = async (code: number): Promise<void> => {
		if (code !== 0) await settleSignals();
		if (code !== 0 && guard.signal() !== null) return;
		reportSeedResult(latestTag, code);
	};
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
				readKey(join(installDir, 'ops', 'bunkerweb', 'bunkerweb.env'), 'SERVER_NAME').split(
					/\s+/
				)[0] ||
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
				readKey(cfg, 'MORPHIT_INSTANCE_TOR_ADDRESS') ||
				readKey(altCfg, 'MORPHIT_INSTANCE_TOR_ADDRESS');
			// What Tor actually hosts. HiddenServiceDir/hostname is the authority.
			const routerOnion = (
				spawnSync(
					'sh',
					[
						'-c',
						"cat /var/lib/tor/*/hostname 2>/dev/null | grep -oE '[a-z2-7]{56}\\.onion' | head -1"
					],
					{ encoding: 'utf8', timeout: 10_000 }
				).stdout ?? ''
			).trim();
			// What i2pd actually hosts, from its own console. No root needed.
			const routerI2p = (
				await withSpinner("Reading this node's I2P address from its router…", () =>
					runAsync(
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
						{ timeoutMs: 15_000 }
					)
				)
			).stdout.trim();
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
		// this passed only the tag, so the seed script
		// curled git.agorise.net for the tag's CID after EVERY upgrade, hidden and
		// offline ones included, from the box's home IP. Hand it the on-chain CID
		// this node's own indexer holds (only when that record IS this tag; a signed
		// release installed before its broadcast has none yet), and tell it when the
		// node is hidden-only, which the unprivileged ipfs user cannot read from
		// indexer.env: then it never fetches, downloads or announces anything.
		const seedHiddenOnly = isHiddenOnlyNode();
		if (seedHiddenOnly) seedAddrArgs.push('MORPHIT_SEED_HIDDEN_ONLY=1');
		const onchainRelease = await withSpinner(
			"Reading the on-chain release record from this node's indexer…",
			() =>
				readLocalRelease(
					opts.localIndexerBases !== undefined ? { bases: opts.localIndexerBases } : {}
				)
		);
		const seedCidArg =
			onchainRelease !== null && onchainRelease.cid !== null && onchainRelease.tag === latestTag
				? [onchainRelease.cid]
				: [];
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
			// a Tor/I2P seeder, not just a consumer (every instance a seeder).
			// The offline bundle now ships the CANONICAL standard tarball under
			// .canonical-release/; if it's there, seed THAT — its CID matches the
			// on-chain anchor. Only skip when it's absent (an older bundle), where
			// hashing the -offline bundle itself could never match the anchor.
			const canonical = join(installDir, '.canonical-release', `morphit-${latestTag}.tar.gz`);
			if (ipfsHostingUp && existsSync(canonical)) {
				info('');
				info(
					`Seeding ${latestTag} to IPFS from the bundled canonical tarball (this box becomes a Tor/I2P origin host) …`
				);
				const seedEnv = ['env', 'IPFS_PATH=/var/lib/ipfs/.ipfs', ...seedAddrArgs];
				try {
					chmodSync(dirname(canonical), 0o755);
					chmodSync(canonical, 0o644);
					seedEnv.push(`MORPHIT_STAGE_TARBALL=${canonical}`);
				} catch {
					/* couldn't relax perms — the seed's download mode has no clearnet here, so it'll no-op */
				}
				await reportSeedUnlessStopped(
					await runStepWithSpinner(
						`Seeding ${latestTag} to IPFS\u2026`,
						'sudo',
						['-u', 'ipfs', ...seedEnv, 'sh', seedScript, latestTag, ...seedCidArg],
						{ timeoutMs: 1_200_000, name: 'The IPFS seed', alsoFine: [3] }
					)
				);
			} else {
				info('');
				info('Skipping the IPFS self-seed: this offline bundle does not carry the canonical');
				info(
					'tarball, so its bytes can\u2019t match the on-chain CID. (Newer bundles seed automatically.)'
				);
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
			await reportSeedUnlessStopped(
				await runStepWithSpinner(
					`Seeding ${latestTag} to IPFS\u2026`,
					'sudo',
					['-u', 'ipfs', ...seedEnv, 'sh', seedScript, latestTag, ...seedCidArg],
					{ timeoutMs: 1_200_000, name: 'The IPFS seed', alsoFine: [3] }
				)
			);
		}
	} catch {
		/* best-effort; never fail an upgrade over IPFS seeding */
	}

	{
		const st = await finishStop('seed');
		if (st !== null) return st;
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
				await armSnapshotTimers(installDir);
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
	{
		const st = await finishStop('mirror');
		if (st !== null) return st;
	}

	// ─── 13. Cleanup — remove the download scratch (incl. the ~13 MB
	//         tarball) now that both the install AND the seed are done. No
	//         junk left behind on disk. Deferred to here (not step 11) so
	//         the seed above could reuse the tarball we already had.
	// ─── 14. The last word: what happened, and what is left ──────
	printUpgradeSummary(
		gatherUpgradeSummary({
			from: currentTag,
			to: latestTag,
			backupDir,
			schemaChanged,
			canaryCleared: canaryClearedByUpgrade(
				canaryAutoRefreshed,
				existsSync(join(backupDir, 'apps', 'web', 'build', 'canary.txt')),
				canaryCarried
			),
			frontendVerified,
			servicesVerified,
			startedMs: upgradeStartedMs,
			healChildRan
		})
	);

	cleanupTmp(tmpDir);
	guard.release();

	return 0;
}

/** What is left once the install is whole, in order (finishStop). */
const FINISH_STEPS = ['mcp', 'matrix', 'sweep', 'prune', 'gateway', 'seed', 'mirror'] as const;
type FinishStep = (typeof FINISH_STEPS)[number];

/** PURE. The last lines of an upgrade stopped AFTER every service runs the
 *  new release (v1.21.18 audit, M1): what is done, then each step skipped or
 *  cut short from `from` on — the ones that apply on this server — with how
 *  it gets done. Exported for its test. */
export function stoppedAfterInstallLines(o: {
	readonly why: string;
	readonly tag: string;
	readonly from: FinishStep;
	readonly installDir: string;
	readonly backupDir: string;
	readonly mcp: {
		readonly deployScript: string;
		readonly dest: string;
		readonly user: string;
	} | null;
	readonly matrix: boolean;
	readonly gateway: boolean;
	/** This server hosts IPFS (the seed and the mirror run here). */
	readonly ipfs: { readonly mirrorScript: string | null } | null;
}): string[] {
	const bar = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
	const tag = sanitizeForTerm(o.tag);
	const from = FINISH_STEPS.indexOf(o.from);
	const left = (s: FinishStep): boolean => FINISH_STEPS.indexOf(s) >= from;
	const skipped: string[] = [];
	if (left('mcp') && o.mcp !== null)
		skipped.push(
			`the MCP server's update to ${tag} (it keeps the previous release's code until then); on this server: sudo bash ${o.mcp.deployScript} ${o.installDir} ${o.mcp.dest} ${o.mcp.user} && sudo systemctl try-restart morphit-mcp`
		);
	if (left('matrix') && o.matrix)
		skipped.push(
			`the Matrix alert bot's restart on ${tag}; on this server: sudo systemctl try-restart morphit-matrix-bot`
		);
	if (left('sweep'))
		skipped.push(
			`stopping programs still running from the previous install's folder, if any; to see them, on this server: sudo ls -l /proc/*/cwd 2>/dev/null | grep ${o.backupDir}`
		);
	if (left('prune'))
		skipped.push(
			'the check that the database backup reaches the database, and removing older copies of the install (the next upgrade does both)'
		);
	if (left('gateway') && o.gateway)
		skipped.push(
			"the check that the website reaches this server's IPFS gateway (the next upgrade does it)"
		);
	if (left('seed') && o.ipfs !== null)
		skipped.push(
			`seeding ${tag} to IPFS from this server (the next upgrade seeds the release it installs)`
		);
	if (left('mirror') && o.ipfs !== null)
		skipped.push(
			o.ipfs.mirrorScript !== null
				? `refreshing the federation-snapshot mirror (its weekly timer does it); to do it now, on this server: sudo bash ${o.ipfs.mirrorScript}`
				: 'refreshing the federation-snapshot mirror (its weekly timer does it)'
		);
	const out = [
		'',
		bar,
		`  ✓ Upgraded — this server runs ${tag} (stopped before the last steps)`,
		bar,
		'',
		`  Stopped: ${o.why}. Every service had restarted on ${tag} (checked), so nothing was undone.`,
		`  The previous install is kept at ${o.backupDir}.`
	];
	if (skipped.length > 0) {
		out.push('  Not done (or cut short) because it was stopped:');
		for (const l of skipped) out.push(`    • ${l}`);
	}
	return out;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** v1.18.0 (F32) — SELF-HEAL: on a node whose indexer uses no clearnet, give
 *  the relay no clearnet either. The old tor-only template never set the
 *  relay's endpoint list, and an upgrade does not re-render templates, so
 *  without this every EXISTING tor-only node would keep a relay that reaches
 *  the chain over clearnet — and lose its zero-clearnet claim, which now asks
 *  the relay. Runs before the service restarts below, so it takes effect on
 *  this upgrade. See lib/relayHiddenHeal.ts for exactly what it will and will
 *  not change. */
/**
 * Every post-upgrade self-heal, in order, EACH ON ITS OWN (v1.18.0 review, O7).
 *
 * The relay heal runs FIRST: it is quick, and it is the privacy one — a relay
 * on a tor-only node still reaching clearnet RPC from the box's own address.
 * It used to run last, after heals that restart docker containers and IPFS, so
 * a slow one could run the re-exec past its timeout and the relay heal never
 * ran at all; and the heals shared one try, so any one throwing skipped every
 * heal after it, silently. Each is now isolated and a failure is said out loud.
 */
export async function runSelfHeals(opts: { child?: boolean } = {}): Promise<void> {
	await runHealSteps(selfHealSteps(), opts);
}

/**
 * The heal phase as the child process the upgrade starts
 * (`morphit-ops __post-upgrade-selfheal`): every heal, each isolated; a heal
 * phase that stops early says so (a warning); and in every case — also at its
 * time limit (runHealSteps' SIGTERM handler) — its warning count is left for
 * the upgrade's last word. `steps` is a seam for its test.
 */
export async function runPostUpgradeSelfHealChild(
	steps: () => Array<[string, () => unknown]> = selfHealSteps
): Promise<void> {
	try {
		await runHealSteps(steps(), { child: true });
	} catch (e) {
		// Never silent: it counts as a warning in the upgrade's last lines.
		warn(
			`The repairs after the upgrade stopped early: ${e instanceof Error ? e.message : String(e)}`
		);
	} finally {
		recordChildWarnings();
	}
}

/**
 * The after-restart unit's body (`morphit-ops __post-upgrade-after-restart`,
 * output in its log): the heals that need the restarted services. If it stops
 * on an error, that is an error line ("[ERR] …" without colour), which the
 * upgrade's last word counts with the unit's warnings. `run` is a seam for its
 * test.
 */
export async function runAfterRestartUnit(
	sinceArg: string | undefined,
	run: (sinceUs: number) => Promise<void> = runAfterRestartHeals
): Promise<void> {
	try {
		await run(Number(sinceArg ?? '0'));
	} catch (e) {
		printError(
			`The checks after the restart stopped early: ${e instanceof Error ? e.message : String(e)}. On this server, to run them again: ${HEALS_COMMAND}`
		);
	}
}

/**
 * Run heal steps in order, each isolated. As the re-exec'd child (`child`) the
 * process is stopped with SIGTERM by the upgrader that started it once
 * SELF_HEAL_CHILD_TIMEOUT_MS is up — an older upgrader then says nothing and
 * runs its own, older heals — so the child says which step it was in, which
 * did not run, and the command that runs them.
 */
export async function runHealSteps(
	steps: Array<[string, () => unknown]>,
	opts: { child?: boolean } = {}
): Promise<void> {
	let at = -1;
	const onTerm = (): void => {
		const left = steps.slice(Math.max(at, 0)).map(([n]) => n);
		warn(
			`The upgrade stopped its heal step at the time limit${at >= 0 ? `, during ${steps[at]![0]}` : ''}. ` +
				`Not done this time: ${left.join(', ')}. ` +
				(afterRestartLaunched
					? 'The checks that need the restarted services still run in the background. '
					: '') +
				`Once the upgrade has finished, run: ${HEALS_COMMAND}`
		);
		// What this phase found so far still reaches the upgrade's last lines
		// (process.exit skips every finally).
		try {
			printDeferredQuestions();
		} catch {
			/* best-effort */
		}
		recordChildWarnings();
		process.exit(143);
	};
	if (opts.child) process.once('SIGTERM', onTerm);
	try {
		for (let i = 0; i < steps.length; i++) {
			at = i;
			const [name, heal] = steps[i]!;
			try {
				await heal();
			} catch (err) {
				warn(`Skipped ${name}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	} finally {
		if (opts.child) process.removeListener('SIGTERM', onTerm);
	}
}

/** The install this morphit-ops runs from (its dist bundle or its source), or null. */
function thisCliInstallDir(): string | null {
	let here: string;
	try {
		here = fileURLToPath(import.meta.url);
	} catch {
		return null;
	}
	return /^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(here)?.[1] ?? null;
}

function sameDir(a: string | null, b: string): boolean {
	if (a === null) return false;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

/** Re-runs this release's heals (`upgrade --heals`). */
const HEALS_COMMAND = 'sudo morphit-ops upgrade --heals';
/** Asks what the heal phase did not stop for (`upgrade --questions`). */
const QUESTIONS_COMMAND = 'sudo morphit-ops upgrade --questions';
/** What the heal phase left for `upgrade --questions`, in order. */
const deferredQuestions: string[] = [];
/** True only while `upgrade --questions` runs: then the heals ask. */
let askingQuestions = false;
/** The after-restart unit was started by this process. */
let afterRestartLaunched = false;

/** Things this upgrade found for the operator to do, named in its last lines. */
const leftForYou: string[] = [];

/** Step 9b1, part one: put back the canary served before the upgrade, from
 *  the old install (renamed by root to `backupDir`, the folder nothing below
 *  may be a link in) into the new build. Says what was not put back, and
 *  why. Never throws. Exported for its test. */
export function carryOldCanary(backupDir: string, installDir: string): CanaryCarry | null {
	try {
		const carried = carryCanaryForward(
			join(backupDir, 'apps', 'web', 'build'),
			join(installDir, 'apps', 'web', 'build'),
			{ trustedRoot: backupDir }
		);
		for (const sk of carried.skipped)
			info(
				`(The warrant canary's ${sk.name} from before the upgrade was not put back: ${sk.why}.)`
			);
		return carried;
	} catch {
		/* best-effort: the reminder at the end still names the refresh */
		return null;
	}
}

/** Did this upgrade leave the site without the canary it served before?
 *  Only when there was one, no same-server refresh signed a new one, and it
 *  was not put back. Exported for its test. */
export function canaryClearedByUpgrade(
	autoRefreshed: boolean,
	hadCanary: boolean,
	carried: CanaryCarry | null
): boolean {
	return !autoRefreshed && hadCanary && !(carried?.carried.includes('canary.txt') ?? false);
}

/** Step 9b1, part two (after a same-server refresh had its chance): report
 *  the canary that was put back — unless the refresh replaced it with a new
 *  one, or none was. Exported for its test. */
export function afterCanaryRefresh(
	carried: CanaryCarry | null,
	autoRefreshed: boolean,
	nowMs: number,
	unitExists: (unit: string) => boolean
): void {
	if (autoRefreshed || carried === null || !carried.carried.includes('canary.txt')) return;
	reportCarriedCanary(carried, nowMs, unitExists);
}

/** A carried canary with less validity than this left is named in the last
 *  lines (health's own warning margin). */
const CARRIED_CANARY_MARGIN_MS = 5 * 24 * 60 * 60 * 1000;

/** Say that the canary signed before the upgrade is served again, and when it
 *  runs out; one that runs out within days (or has, or has no readable date)
 *  goes to the last lines with the command that re-signs it. Exported for its
 *  test. */
export function reportCarriedCanary(
	carry: Pick<CanaryCarry, 'validThrough' | 'validThroughMs' | 'skipped'>,
	nowMs: number,
	unitExists: (unit: string) => boolean
): void {
	const until = carry.validThrough ?? 'no readable date';
	const resign = unitExists('morphit-canary.timer')
		? 'on this server: sudo systemctl start morphit-canary.service'
		: 'on the computer that holds its key: bash ~/.morphit/update-canary.sh';
	// Without its public key (/pgp_keys.asc) nobody can check the canary: the
	// refresh publishes the key again.
	const key = carry.skipped.find(
		(s) => s.name === 'pgp_keys.asc' && s.why !== 'the new install already has one'
	);
	if (key)
		leftForYou.push(
			`Publish the warrant canary's public key again (/pgp_keys.asc was not put back: ${key.why}) ${resign}`
		);
	if (
		Number.isFinite(carry.validThroughMs) &&
		carry.validThroughMs - nowMs >= CARRIED_CANARY_MARGIN_MS
	) {
		info(
			`\u2713 Warrant canary: the one you signed before the upgrade is served again, unchanged (valid through ${until}).`
		);
		return;
	}
	const due =
		Number.isFinite(carry.validThroughMs) && carry.validThroughMs > nowMs
			? `runs out on ${until}`
			: Number.isFinite(carry.validThroughMs)
				? `ran out on ${until}`
				: 'has no readable "Valid through" date';
	info(
		`Warrant canary: the one you signed before the upgrade is served again, unchanged, but it ${due}.`
	);
	leftForYou.push(`Re-sign the warrant canary (the one served again ${due}) ${resign}`);
}

/** Where the heal phase (a child process) leaves how many warnings it printed,
 *  so the upgrade's last word never says "Nothing else to do." after them. */
function upgradeWarningsFile(): string {
	return process.env.MORPHIT_UPGRADE_WARNINGS_FILE ?? '/run/morphit/upgrade-warnings';
}

/** The heal-phase child: record its warning count for the upgrade's last word. */
export function recordChildWarnings(): void {
	if (process.env.MORPHIT_UPGRADE_SUMMARIZES !== '1') return;
	try {
		const f = upgradeWarningsFile();
		mkdirSync(dirname(f), { recursive: true, mode: 0o755 });
		writeFileSync(f, `${warningCount()}\n`, { mode: 0o644 });
	} catch {
		/* the warnings themselves were printed */
	}
}

/** Read and remove the heal-phase child's warning count (none: 0). */
export function takeChildWarnings(): number {
	return takeChildWarningsReport() ?? 0;
}

/** Read and remove the heal-phase child's warning count; null when it left
 *  none (it could not, or an older release's child never does). */
export function takeChildWarningsReport(): number | null {
	const f = upgradeWarningsFile();
	try {
		const text = readFileSync(f, 'utf8');
		rmSync(f, { force: true });
		const n = Number.parseInt(text.trim(), 10);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return null;
	}
}

/** Where the heal phase leaves its open questions for the upgrade's last word. */
function upgradeQuestionsFile(): string {
	return process.env.MORPHIT_UPGRADE_QUESTIONS_FILE ?? '/run/morphit/upgrade-questions';
}

/** Read and remove the questions the heal phase left (none: []). */
export function takeUpgradeQuestions(): string[] {
	const f = upgradeQuestionsFile();
	try {
		const text = readFileSync(f, 'utf8');
		rmSync(f, { force: true });
		return text
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l !== '');
	} catch {
		return [];
	}
}

/** The background checks for the last lines: still running (read the log
 *  later), or finished — then only their warnings, if any, are named. */
function backgroundChecksForSummary(
	startedMs: number,
	isActive: (unit: string) => boolean
): {
	backgroundLog: string | null;
	backgroundWarnings: number;
} {
	if (!afterRestartLogWrittenSince(startedMs))
		return { backgroundLog: null, backgroundWarnings: 0 };
	const running = isActive(AFTER_RESTART_UNIT);
	if (running) return { backgroundLog: afterRestartLogPath(), backgroundWarnings: 0 };
	let n = 0;
	try {
		n = (readNoFollow(afterRestartLogPath()) ?? '')
			.split('\n')
			.filter((l) => /^\s*(?:\[WARN\]|\[ERR\]|⚠|✗)\s/.test(l)).length;
	} catch {
		n = 0;
	}
	return { backgroundLog: null, backgroundWarnings: n };
}

/** The background checks' log was written by THIS upgrade's run of them. */
function afterRestartLogWrittenSince(ms: number): boolean {
	try {
		return statSync(afterRestartLogPath()).mtimeMs >= ms - 1000;
	} catch {
		return false;
	}
}

/** `systemctl is-active --quiet <unit>` on this server. */
function unitIsActive(unit: string): boolean {
	return spawnSync('systemctl', ['is-active', '--quiet', unit], { timeout: 10_000 }).status === 0;
}

/** The background web heal (lib/webHeal.ts) for the last word: still running,
 *  or — when THIS upgrade's run (or one it followed) ended in something the
 *  operator must see — that outcome in a line. Its state file is read, not
 *  only the unit: the heal often ends after the heal phase stopped watching.
 *  Exported for its test. */
export function webHealForSummary(
	startedMs: number,
	deps: {
		readonly isActive?: (unit: string) => boolean;
		readonly readState?: () => WebHealState | null;
		readonly now?: () => number;
	} = {}
): { running: boolean; outcome: string | null } {
	if ((deps.isActive ?? unitIsActive)(WEB_HEAL_UNIT)) return { running: true, outcome: null };
	const s = (deps.readState ?? (() => readWebHealState()))();
	if (s === null) return { running: false, outcome: null };
	// This upgrade's: ended (or, for one that never wrote its end, started)
	// during it.
	const at = Date.parse(s.finishedAt ?? s.startedAt);
	if (!Number.isFinite(at) || at < startedMs - 5_000) return { running: false, outcome: null };
	// The heal phase showed how it ended (its warnings are counted above).
	if (s.shown === true) return { running: false, outcome: null };
	if (s.state === 'running')
		return {
			running: false,
			outcome: `The web-proxy settings heal (${WEB_HEAL_UNIT}) stopped before it finished, so nothing says how it ended. What it did is in its log, on this server: sudo cat ${webHealLogPath()} — to run it again: ${HEALS_COMMAND}`
		};
	if (webHealStatusRow(s).status !== 'warn') return { running: false, outcome: null };
	return {
		running: false,
		outcome: `The web-proxy settings (BunkerWeb): ${describeWebHeal(s, (deps.now ?? Date.now)())}. On this server: sudo morphit-ops status`
	};
}

/** Everything the upgrade's last word needs, read from where each part was
 *  left: the heal phase's questions and warning count (files), this process's
 *  warnings and to-do items, the background checks (their log and unit), the
 *  background web heal (its unit and state file), the canary timer.
 *  `isActive`/`unitExists` are seams for its test (default: systemctl).
 *  Exported for its test. */
export function gatherUpgradeSummary(
	base: {
		readonly from: string;
		readonly to: string;
		readonly backupDir: string;
		readonly schemaChanged: boolean;
		/** The upgrade cleared the canary file and nothing re-signed it. */
		readonly canaryCleared: boolean;
		readonly frontendVerified: boolean;
		/** Each service this upgrade restarted was seen to stay up on it. */
		readonly servicesVerified?: boolean;
		readonly startedMs: number;
		/** The heal phase ran as a child process (else in this one). */
		readonly healChildRan: boolean;
	},
	deps: {
		readonly isActive?: (unit: string) => boolean;
		readonly unitExists?: (unit: string) => boolean;
	} = {}
): UpgradeSummary {
	const isActive = deps.isActive ?? unitIsActive;
	const unitExists =
		deps.unitExists ??
		((u: string) =>
			spawnSync('systemctl', ['cat', u], { stdio: 'ignore', timeout: 10_000 }).status === 0);
	const childWarnings = takeChildWarningsReport();
	const web = webHealForSummary(base.startedMs, { isActive });
	return {
		from: base.from,
		to: base.to,
		backupDir: base.backupDir,
		schemaChanged: base.schemaChanged,
		canaryLeft: base.canaryCleared,
		canaryTimer: base.canaryCleared && unitExists('morphit-canary.timer'),
		questions: takeUpgradeQuestions(),
		...backgroundChecksForSummary(base.startedMs, isActive),
		warnings: warningCount() + (childWarnings ?? 0),
		healPhaseUncounted: base.healChildRan && childWarnings === null,
		frontendVerified: base.frontendVerified,
		servicesVerified: base.servicesVerified === true,
		todo: [...leftForYou],
		webHealRunning: web.running,
		webHealOutcome: web.outcome
	};
}

export interface UpgradeSummary {
	readonly from: string;
	readonly to: string;
	readonly backupDir: string;
	readonly schemaChanged: boolean;
	/** The canary file was cleared and nothing on this box re-signed it. */
	readonly canaryLeft: boolean;
	/** This box re-signs its canary on a timer. */
	readonly canaryTimer: boolean;
	/** What the heal phase did not stop to ask. */
	readonly questions: readonly string[];
	/** The background checks' log, when this upgrade started them and they
	 *  are still running. */
	readonly backgroundLog: string | null;
	/** Warnings the background checks printed, when they already finished. */
	readonly backgroundWarnings?: number;
	/** Warnings printed during this upgrade (its own and the heal phase's). */
	readonly warnings: number;
	/** Other things this upgrade found for the operator to do. */
	readonly todo?: readonly string[];
	/** The background web heal (BunkerWeb) is still at work. */
	readonly webHealRunning?: boolean;
	/** How this upgrade's background web heal ended, when the operator must
	 *  see it (a line), else null. */
	readonly webHealOutcome?: string | null;
	/** The heal phase ran as a child that left no warning count (an older
	 *  release's, on a downgrade): its warnings could not be counted. */
	readonly healPhaseUncounted?: boolean;
	/** The served frontend was seen to be this build. */
	readonly frontendVerified: boolean;
	/** Each service this upgrade restarted was seen to stay up on it (its
	 *  restart step's own check, independent of other warnings). */
	readonly servicesVerified?: boolean;
}

/** PURE. The upgrade's last lines: that it worked, then what is left, each
 *  with the command and the machine it runs on. */
export function upgradeSummaryLines(s: UpgradeSummary): string[] {
	const out = [
		'',
		'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
		`  ✓ Success — your Morphit server is now running ${s.to}`,
		'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
		'',
		`  Upgraded ${s.from} → ${s.to}.` +
			(s.servicesVerified === true ? ' Every service restarted on it (checked).' : '') +
			(s.frontendVerified ? ' The site serves it (checked).' : ''),
		`  The previous install is kept at ${s.backupDir} (later upgrades remove old copies).`
	];
	const left: string[] = [];
	// Both markers: a warning is "⚠" or "[WARN]" depending on whether the
	// process that printed it uses colour (the heal phase and the scripts
	// the upgrade runs do not always match this one).
	if (s.warnings > 0) {
		left.push(
			`${s.warnings === 1 ? 'One warning' : `${s.warnings} warnings`} above (the lines marked ⚠ or [WARN]): each says what to do and where`
		);
	}
	if (s.healPhaseUncounted) {
		left.push(
			`The repairs after the install (run by ${s.to}'s morphit-ops) left no count of their warnings: read their lines above for any marked ⚠ or [WARN]`
		);
	}
	for (const t of s.todo ?? []) left.push(t);
	if (s.webHealRunning) {
		left.push(
			`${WEB_HEAL_STILL_RUNNING} See how it ended, on this server: sudo morphit-ops status`
		);
	}
	if (s.webHealOutcome) left.push(s.webHealOutcome);
	if (s.canaryLeft) {
		left.push(
			s.canaryTimer
				? 'The warrant canary: this box re-signs it within a week; to do it now, on this server: sudo systemctl start morphit-canary.service'
				: 'Re-sign the warrant canary (the upgrade cleared it) on the computer that holds its key: bash ~/.morphit/update-canary.sh'
		);
	}
	if (s.questions.length > 0) {
		left.push(
			`Questions the upgrade did not wait for: ${s.questions.join('; ')}. On this server: ${QUESTIONS_COMMAND}`
		);
	}
	if ((s.backgroundWarnings ?? 0) > 0) {
		left.push(
			`The background checks finished with ${s.backgroundWarnings === 1 ? 'a warning' : `${s.backgroundWarnings} warnings`}; read ${s.backgroundWarnings === 1 ? 'it' : 'them'} on this server: sudo cat ${afterRestartLogPath()}`
		);
	}
	if (s.backgroundLog !== null) {
		left.push(
			`Checks that need the restarted services are still running. In a few minutes, on this server: sudo cat ${s.backgroundLog} (its last line is "Done." when they have finished)`
		);
	}
	if (s.schemaChanged) {
		left.push(
			'The database schema changed in place in this version (not by a numbered migration). On this server run: sudo morphit-ops doctor (OPERATIONS.md §46 has the reset + re-sync steps if it reports drift)'
		);
	}
	out.push('');
	if (left.length === 0) out.push('  Nothing else to do.');
	else {
		out.push('  Left for you:');
		for (const l of left) out.push(`    • ${l}`);
	}
	return out;
}

function printUpgradeSummary(s: UpgradeSummary): void {
	for (const l of upgradeSummaryLines(s)) info(l);
}

/** The heal phase never waits for an answer (an older upgrader stops it at
 *  300 s, and `--yes` / MORPHIT_AUTO_UPGRADE=1 runs have no one to answer):
 *  the heal takes its safe default and the question is left for later. */
function deferQuestion(what: string): null {
	if (!deferredQuestions.includes(what)) deferredQuestions.push(what);
	return null;
}

/** The heal phase's last word on the questions it did not stop for. */
export function printDeferredQuestions(): void {
	if (deferredQuestions.length === 0) return;
	// For the upgrade's last word (it runs this phase as a child process, or
	// in-process when the child could not finish).
	if (
		process.argv.includes('__post-upgrade-selfheal') ||
		process.env.MORPHIT_UPGRADE_SUMMARIZES === '1'
	) {
		let written = false;
		try {
			const f = upgradeQuestionsFile();
			mkdirSync(dirname(f), { recursive: true, mode: 0o755 });
			writeFileSync(f, `${deferredQuestions.join('\n')}\n`, { mode: 0o644 });
			written = true;
		} catch {
			/* the line below still names them */
		}
		// The upgrade that started this phase lists them in its last lines.
		if (written && process.env.MORPHIT_UPGRADE_SUMMARIZES === '1') return;
	}
	info(
		`Left for you to answer (the upgrade did not wait): ${deferredQuestions.join('; ')}. ` +
			`When you like, on this server: ${QUESTIONS_COMMAND}`
	);
}

/** `upgrade --questions`: the questions the heal phase leaves for later, at a terminal. */
async function runQuestions(): Promise<number> {
	if (process.stdin.isTTY !== true) {
		printError(
			`This asks the questions the upgrade did not stop for, so run it from a terminal: ${QUESTIONS_COMMAND}`
		);
		return 2;
	}
	askingQuestions = true;
	try {
		await runHealSteps([
			['the relay log notice', () => healRelayJournalNotice()],
			['the Matrix bot tor-only heal', () => healMatrixBotTorOnlyNow()]
		]);
	} finally {
		askingQuestions = false;
	}
	info('✓ No other question is waiting.');
	return 0;
}

/** `morphit-ops upgrade --tor-bridges`: the Tor bridges check and repair on
 *  its own (the timer's run). Exit 0 when Tor works afterwards. */
export async function runTorBridgesCheck(
	run: (ctx: HealCtx, installDir: string) => Promise<HealResult> = healTorBridges
): Promise<number> {
	if (process.getuid?.() !== 0) {
		info('The Tor bridges check edits /etc/tor/torrc: run it with sudo.');
		return 1;
	}
	const r = await run(healCtx(), selfHealInstallDir());
	(r.verified ? info : warn)(r.detail);
	return r.verified ? 0 : 1;
}

/** `upgrade --heals`: this release's heals again, then the checks that need
 *  the services running it (they already are), all in this process. */
export async function runHealsAgain(
	o: {
		upToDate?: boolean;
		installDir?: string;
		/** Tests: the heal steps and the after-restart steps. */
		steps?: () => Array<[string, () => unknown]>;
		afterSteps?: () => Array<[string, () => Promise<void>]>;
		/** Tests: is the background web heal (morphit-web-heal) still at work? */
		webHealRunning?: () => boolean;
	} = {}
): Promise<number> {
	if (o.upToDate && process.getuid?.() !== 0) {
		info("Run it with sudo to also check this release's repairs on this server.");
		return 0;
	}
	// The heals are this morphit-ops's own release's: run them only for the
	// install it belongs to (never, say, from a checkout pointed at another).
	if (o.upToDate && o.installDir !== undefined && !sameDir(thisCliInstallDir(), o.installDir)) {
		info(
			`This morphit-ops is not the one installed in ${o.installDir}, so its repairs were not run there.`
		);
		return 0;
	}
	info(
		o.upToDate
			? "Checking this release's repairs on this server (nothing is downloaded or installed)…"
			: 'Running the heals of this release again (nothing is downloaded or installed)…'
	);
	const before = warningCount();
	await runHealSteps((o.steps ?? selfHealSteps)().filter(([n]) => n !== 'the after-restart heals'));
	// Nothing restarts here: the services already run this release (L7).
	await runAfterRestartHeals(0, {
		servicesRestarted: false,
		...(o.afterSteps !== undefined ? { steps: o.afterSteps } : {})
	});
	// The last word, counted (v1.21.17 audit, L7: it ended exit 0 with no count).
	const n = warningCount() - before;
	// Not "every repair is in place" while the web firewall's check still runs
	// in the background (v1.21.18 audit, M6).
	const bgRunning = (o.webHealRunning ?? (() => unitIsActive(WEB_HEAL_UNIT)))();
	const still =
		"the web firewall's check, still running in the background (on this server: sudo morphit-ops status)";
	info(
		n === 0
			? bgRunning
				? `Done, except ${still}.`
				: '✓ Done: every repair of this release is in place on this server; nothing else to do.'
			: `Done, with ${n === 1 ? 'one warning' : `${n} warnings`} above (the lines marked ⚠ or [WARN]): each says what to do and where.` +
					(bgRunning ? ` Not finished yet: ${still}.` : '')
	);
	// `upgrade --heals` exits 1 when a repair warned (a script can tell). A plain
	// `upgrade` on an up-to-date box exits 0, as docs/UPGRADING.md says: the
	// warnings above say what to do (v1.21.18 audit, M6).
	return n === 0 || o.upToDate === true ? 0 : 1;
}

/** The self-heal steps, in order (exported so the ORDER and each step's effect
 *  are tested for real). This phase is the only part of an upgrade that runs
 *  the NEW binary on the upgrade that ships it, so every fix that must reach an
 *  installed box on THIS upgrade belongs here. */
export function selfHealSteps(): Array<[string, () => unknown]> {
	return [
		['the relay RPC heal', () => healRelayClearnet()],
		// Wave 4 (P7): refresh the helpers Ansible copied into /usr/local/lib/morphit
		// HERE, so C3 (first-online ran a user's canary script as root) and C17
		// (ipfs-pin's 900 s stall on hidden-only nodes) are fixed on the upgrade that
		// ships them — the old orchestrator's step 9f only exists from the NEXT one.
		// Idempotent: a helper already refreshed by step 9f is 'unchanged'.
		['the helper-script refresh', () => healHelperScripts()],
		// v1.20.0 (C13, owned by lib/torOnlyOsHeal.ts): on a TOR-ONLY node only,
		// apt over Tor (verified by a real refresh over Tor, put back if it cannot
		// be), no clearnet NTP (only once the Tor time check is seen working), no
		// Ubuntu news fetches. Early, before the slow network heals, and bounded:
		// in the re-exec'd child it stops itself in time (never leaving apt
		// switched but unchecked), and morphit-tor-only-recover.timer finishes or
		// undoes any switch a kill still interrupts.
		[
			'the tor-only OS heal',
			() => healTorOnlyOs({ info, warn, spinner: (l) => startDotsSpinner(l) })
		],
		// (lib/unitPrivilegeHeal.ts): the indexer and relay run as their
		// own unprivileged users and the install tree goes back to root; verified
		// per service (uid in /proc, an HTTP answer, no restart loop), else a
		// run-as-root drop-in is written and verified. Early (after the tor-only OS
		// heal, which stays first): before the network heals and the service
		// restarts of step 10.
		[
			'the service-user heal',
			() => reportHeal(healServicePrivileges({ info, warn, spinner: (l) => startDotsSpinner(l) }))
		],
		// v1.21.15 (lib/clockFallbackHeal.ts): on a node that keeps clearnet NTP,
		// the clock falls back to the onion time sources over Tor when NTP cannot
		// keep it (a tor-only node has its own timer, from the heal above).
		[
			'the clock fallback heal',
			() =>
				reportHeal(
					Promise.resolve(
						healClockFallback(healCtx(), realClockFallbackRuntime(selfHealInstallDir()))
					)
				)
		],
		// lib/indexerMemoryHeal.ts: the indexer gets its memory cap (MemoryMax) on
		// the running service too. The upgrade refreshes the units (and reloads
		// systemd) before this phase; `upgrade --heals` runs it as well. It never
		// restarts the indexer.
		['the indexer memory cap heal', () => reportHeal(healIndexerMemory(healCtx()))],
		// (lib/torPowHeal.ts): the onion services get Tor's proof-of-work
		// defence; Tor reloads only when the option was added and
		// `tor --verify-config` accepts it. After the tor-only OS heal.
		['the onion PoW heal', () => reportHeal(healTorPow(healCtx()))],
		// (lib/etcPermHeal.ts): /etc/morphit back to root:morphit 0750.
		['the /etc/morphit permission heal', () => reportHeal(healEtcPerms(healCtx()))],
		// (lib/mailRelayHeal.ts): no mail relay to the example placeholder
		// (none at all on a tor-only node) and fail2ban bans without mailing
		// whois reports; postfix / fail2ban reload only when changed.
		['the alert mail heal', () => reportHeal(healMailRelay(healCtx()))],
		// (lib/nodeRuntimeHeal.ts): an offline install's /usr/local Node is
		// updated from a newer bundled vendor/node (no network), before the
		// upgrade restarts the services on it.
		[
			'the Node runtime update',
			() => reportHeal(healNodeRuntime(healCtx(), { installDir: selfHealInstallDir() }))
		],
		// Round 2, item 6 (lib/osQuietHeal.ts): every node turns off the OS fetches
		// a server does not need (motd/Pro news, fwupd refresh, pollinate); each
		// part is read back, a part that does not check out is reverted and named.
		['the quiet OS heal', () => reportHeal(healOsQuiet(healCtx()))],
		// v1.20.2 (lib/feeExplorerListHeal.ts): a node set up before v1.20.0 still
		// lists three dead XMR explorers in morphit.env and none of the newer
		// sources (since v1.21.0 also the onion explorers, asked first over Tor).
		// Quick, no network; before the restarts below, so the indexer starts on
		// the new list.
		// (lib/feeAddressEmptyHeal.ts): an empty fee-address line
		// now turns that fee method off; commented once per box, before the
		// upgrade restarts the indexer on the new meaning.
		[
			'the empty fee-address line heal',
			() => reportHeal(healEmptyFeeAddressLines(healCtx(), realFeeAddressRuntime()))
		],
		[
			'the Monero fee-source heal',
			() => healXmrExplorerList(process.env.MORPHIT_ENV_ROOT ?? '', info, warn)
		],
		// v1.21.0 (lib/btcFeeExplorerListHeal.ts): a wizard-written BTC list has
		// only the two clearnet explorers; add the onion ones (asked first, over
		// Tor), once, keeping the operator's own entries. Quick, no network.
		[
			'the Bitcoin fee-source heal',
			() => healBtcExplorerList(process.env.MORPHIT_ENV_ROOT ?? '', info, warn)
		],
		// (lib/sysctlForwardHeal.ts): Docker hosts need IPv4 forwarding for
		// their published ports; hardening had switched it off. Before the
		// web-proxy heals (its fallback may restart Docker).
		[
			'the IPv4 forwarding heal',
			() => reportHeal(healForwarding({ info, warn, spinner: (l) => startDotsSpinner(l) }))
		],
		// existing nodes get the Kubo privacy settings a
		// fresh install now gets (tor-only: off the public IPFS network).
		[
			'the IPFS privacy heal',
			() => healIpfsPrivacy({ info, warn, spinner: (l) => startDotsSpinner(l) })
		],
		// A template fix is not a fix for INSTALLED nodes (upgrade does not re-run
		// Ansible), so open the IPFS swarm port here too (review B7).
		['the IPFS swarm firewall heal', () => healIpfsSwarmFirewall()],
		['the web containers\u2019 firewall heal', () => healBridgeFirewall()],
		['the IPFS gateway heal', () => healIpfsGatewayExposure()],
		['the frontend config heal', () => healFrontendConfig()],
		// A certificate set up to renew with port 80 of its own cannot renew while
		// BunkerWeb holds port 80. After the frontend config heal: the webroot probe
		// goes through the frontend. Never on a hidden-only node (it asks
		// Let's Encrypt, which is clearnet).
		['the TLS renewal heal', () => healTlsRenewalUnlessHidden()],
		// (lib/bridgeCidrHeal.ts): the indexer trusts its frontend's Docker
		// bridge as a proxy; written before the upgrade restarts the indexer (it
		// restarts it itself only when it changed something).
		['the proxy-bridge heal', () => reportHeal(healBridgeCidr(healCtx()))],
		// (lib/nginxVhostHeal.ts): missing
		// settings in a bare-metal nginx box's Morphit vhosts; Docker boxes skip it.
		['the nginx vhost heal', () => reportHeal(healNginxVhosts(healCtx()))],
		// v1.20.0 (C1/C2/B11, owned by lib/proxyConfigHeal.ts): the web containers'
		// Docker logs stop keeping visitor addresses, BunkerWeb gets Morphit's
		// headers, host.docker.internal → the real bridge gateway. After the
		// frontend config heal, so the frontend already runs the current config.
		// v1.20.1: together with the BunkerWeb WAF heal, and on a BunkerWeb box in
		// the BACKGROUND (lib/webHeal.ts) — a slow BunkerWeb cannot finish inside
		// this child's 300 s. The result is shown last ('the web-proxy result').
		['the web-proxy heals', () => startWebProxyHeals()],
		// npm's "New major version of npm available!" notice, box-wide.
		['the npm notice heal', () => healNpmUpdateNotice()],
		// Per-instance branding (docs/BRANDING.md). Runs here too so an upgrade
		// DRIVEN BY AN OLDER morphit-ops (whose upgrade flow predates branding)
		// still goes live branded; idempotent when the new flow already applied it.
		['the branding heal', () => healBranding()],
		// v1.20.0 (G1, owned by lib/feeRecipientHeal.ts): other instances accept
		// the 90 % leg of BLURT fees paid through this node only to the fees
		// account in its ON-CHAIN registration, which every pre-v1.20 one lacks.
		// Re-publishes it unattended (relay key via its sealed credential) and
		// reads it back, else one calm line with the command. Late in the phase:
		// it needs no restarted service, and it stops itself before the
		// child's kill.
		// v1.20.0 (C16, owned by lib/ipfsGcHeal.ts): every IPFS node gets the
		// weekly clean-up (superseded releases + indexer snapshots) and runs it
		// once now. Needs no network, so it is the same on a tor-only node.
		[
			'the IPFS clean-up',
			async () => {
				const r = await healIpfsGc({ info, warn, spinner: (l) => startDotsSpinner(l) });
				if (r.kind === 'ran' && r.summary.result === 'nothing-to-do') routineCheck();
				return r;
			}
		],
		['the fees-account registration heal', () => healFeesAccountRegistrationNow()],
		// v1.20.1 (lib/relayStateHeal.ts): the relay's state moves out of
		// /var/lib/morphit, which the capability-less relay cannot enter; an
		// operator's SIGNUPS_DISABLED moves with it, and the old path links there.
		[
			'the relay state-directory heal',
			() => healRelayStateDir(process.env.MORPHIT_ENV_ROOT ?? '', info)
		],
		// v1.20.1: an enabled relay that is not running (morphitir: exited with
		// status 0 and was never restarted) is started and checked. The upgrade
		// restarting it afterwards is harmless.
		['the stopped-relay heal', () => startIfEnabledButStopped('morphit-relay.service', info, warn)],
		// The heals that need the services restarted on THIS release run in a
		// background unit once they are (lib/afterRestartHeal.ts). Started here:
		// after the last heal that restarts the indexer or the relay itself (the
		// unit waits for the restarts that come after its start), and before
		// the steps that have a question for the operator.
		['the after-restart heals', () => startAfterRestartHeals()],
		// (lib/journalNotice.ts): once per box, say whether older relay
		// logs still hold signup network prefixes and offer to drop the journal.
		['the relay log notice', () => healRelayJournalNotice()],
		// The Matrix bot's secret-free posture (lib/matrixBot.ts), for the
		// indexer's clearnet check; written from the env file so boxes set up
		// before it existed get it on this upgrade. No network.
		// on a tor-only node the bot reaches its homeserver only
		// through Tor; a clearnet one is stopped unless the operator types
		// KEEP-CLEARNET. Before the posture, which then records the outcome.
		['the Matrix bot tor-only heal', () => healMatrixBotTorOnlyNow()],
		// older `register` / fee-recipient runs decrypted the relay's
		// sealed passphrase into a world-readable /run file; one a killed run
		// left behind is removed here (a reboot clears /run too). No network.
		['the stale passphrase file clean-up', () => healStaleRegPassFiles()],
		// 2026-10-08: no backup question any more. The upgrade used to offer to
		// encrypt (or delete) the plain-text database backups already on the
		// box, and named it in every upgrade's last lines until answered. The
		// database holds nothing sensitive and the chain holds what matters, so
		// upgrades leave the backups alone and ask nothing. (The install wizard
		// still offers an age key for an operator who wants encrypted backups.)
		// (lib/canaryRepoHeal.ts): the weekly canary refresh runs the installed
		// release's canary code, not the copy it was first set up from. No network.
		['the canary refresh-source heal', () => healCanaryRefreshRepoNow()],
		// say so when this instance still serves morphit.io's canary key
		// as its own /pgp_keys.asc. No network.
		['the canary key check', () => warnUpstreamCanaryKey()],
		['the Matrix bot posture', () => healMatrixBotPosture()],
		// v1.20.1: with whatever time this child has left (the two steps after
		// it only print).
		['the web-proxy result', () => showWebProxyResult()],
		['the routine checks summary', () => printRoutineSummary()],
		['the questions left for later', () => printDeferredQuestions()]
	];
}

/** The fees-account registration heal (lib/feeRecipientHeal.ts) in the heal
 *  phase. When it ends `needs_operator` — the operator must run `register` —
 *  its line is a warning (counted for the last word, marked ⚠), not one more
 *  calm line. That line is the last it prints before returning, so it is held
 *  back only until the outcome is known. `seams` are the lib's own (tests).
 *  Exported for its test. */
export async function healFeesAccountRegistrationNow(
	seams: Partial<Parameters<typeof healFeeRecipientRegistration>[0]> = {}
): Promise<FeeRecipientHealOutcome> {
	// (An object: the line is set inside the callbacks.)
	const held: { line: string | null } = { line: null };
	const flush = (): void => {
		if (held.line !== null) info(held.line);
		held.line = null;
	};
	let outcome: FeeRecipientHealOutcome = 'unknown';
	try {
		outcome = await healFeeRecipientRegistration({
			info: (m) => {
				flush();
				// The lib's "not in your on-chain operator registration yet … run on
				// this server: sudo morphit-ops register" line ends a needs_operator run.
				if (/is not in your on-chain operator registration yet/.test(m)) held.line = m;
				else info(m);
			},
			warn,
			spinner: (l) => {
				flush();
				return startDotsSpinner(l);
			},
			...seams
		});
	} finally {
		if (held.line !== null) (outcome === 'needs_operator' ? warn : info)(held.line.trim());
	}
	return outcome;
}

/** The Matrix bot loads two native add-ons that `npm ci --ignore-scripts`
 *  does not put in place. Where the bot is configured, put them in place from
 *  pinned SHA-256s (scripts/fetch-matrix-bot-natives.mjs of the NEW tree) — or,
 *  on a hidden-only node, only check them (no download over the clearnet). Never
 *  fails the upgrade: without them the bot alone stays down, and this says how to
 *  fix it. */
async function ensureMatrixBotNatives(installDir: string, hiddenOnly: boolean): Promise<void> {
	try {
		if (!matrixBotReadiness(readMatrixBotEnv()).run) return;
		const script = join(installDir, 'scripts', 'fetch-matrix-bot-natives.mjs');
		if (!existsSync(script)) return;
		// Up to 5 minutes (a download): under the turning spinner, its output
		// shown after.
		const r = {
			status: await runStepWithSpinner(
				hiddenOnly
					? "Checking the Matrix bot's native add-ons…"
					: "Putting the Matrix bot's native add-ons in place (pinned SHA-256)…",
				process.execPath,
				[script, installDir, ...(hiddenOnly ? ['--verify-only'] : [])],
				{ timeoutMs: 300_000, quietOnSuccess: true, name: 'fetch-matrix-bot-natives' }
			)
		};
		if (r.status !== 0) {
			warn(
				hiddenOnly
					? 'The Matrix bot changed native add-ons in this release and this zero-clearnet node cannot download them, so the bot stays down. ' +
							'Bring the offline bundle of this release (it carries them) and run on this box: sudo morphit-ops upgrade --from-file=<path>'
					: `The Matrix bot's native add-ons could not be put in place, so the bot stays down; the rest of the node is unaffected. To retry, run on this box: sudo node ${script} ${installDir}`
			);
		}
	} catch {
		/* never fail an upgrade over the bot's add-ons */
	}
}

/** Step 10c: the Matrix alert bot follows its configured alert username —
 *  enabled and restarted on this release when one is set, else stopped. A
 *  restart is only reported once the bot is SEEN running a few seconds later
 *  (one that exits at once "restarted" too); the wait shows a spinner.
 *  False when it should run and was not seen running. Exported for its test. */
export async function syncMatrixBotOnUpgrade(
	o: { readonly envPath?: string; readonly settleMs?: number } = {}
): Promise<boolean> {
	const readiness = matrixBotReadiness(readMatrixBotEnv(o.envPath));
	if (!readiness.run) {
		// No alert username: the bot stays stopped (nothing to say).
		await syncMatrixBotServiceAtTerminal(false, {});
		return true;
	}
	const res = await syncMatrixBotServiceAtTerminal(true, { restart: true });
	let running = false;
	if (res.ok) {
		await withSpinner('Checking the Matrix alert bot stays up…', async () => {
			await new Promise((r) => setTimeout(r, o.settleMs ?? 3_000));
			running =
				spawnSync('systemctl', ['is-active', '--quiet', MATRIX_BOT_UNIT], { timeout: 10_000 })
					.status === 0;
		});
	}
	if (res.ok && running) {
		info('✓ Matrix alert bot restarted on this release (seen running).');
		return true;
	}
	if (res.ok)
		warn(
			'The Matrix alert bot was restarted but is not running a few seconds later. On this server: ' +
				'`sudo journalctl -u morphit-matrix-bot -n 50`'
		);
	else
		warn(
			'Could not enable/restart morphit-matrix-bot. Start it with ' +
				'`sudo systemctl enable --now morphit-matrix-bot` and check ' +
				'`journalctl -u morphit-matrix-bot`.'
		);
	return false;
}

/** Write matrix-bot.posture from matrix-bot.env when the bot is configured
 *  here. MORPHIT_ENV_ROOT relocates the file for tests. */
export function healMatrixBotPosture(): void {
	const env = `${process.env.MORPHIT_ENV_ROOT ?? ''}${MATRIX_BOT_ENV_PATH}`;
	if (!existsSync(env)) return;
	writeMatrixBotPosture(readFileSync(env, 'utf8'), env);
}

/** The relay-log notice with the box's journalctl and terminal. */
export async function healRelayJournalNotice(): Promise<void> {
	const marker = process.env.MORPHIT_JOURNAL_NOTICE_MARKER ?? JOURNAL_NOTICE_MARKER;
	// In the heal phase a long journal must not eat the time the heals after
	// this one need; `upgrade --questions` can afford a full scan.
	const limitMs = askingQuestions ? 300_000 : 60_000;
	let timedOut = false;
	const count = (): number | null => {
		if (spawnSync('sh', ['-c', 'command -v journalctl'], { stdio: 'ignore' }).status !== 0)
			return null;
		const r = spawnSync(
			'sh',
			[
				'-c',
				`journalctl -u morphit-relay.service --no-pager -o cat 2>/dev/null | grep -c '"sequential_pattern_rejected".*bucketKey'`
			],
			{ encoding: 'utf8', timeout: limitMs, maxBuffer: 1024 * 1024 }
		);
		if (r.signal !== null || r.error !== undefined) {
			timedOut = true;
			return null;
		}
		const n = Number((r.stdout ?? '').trim());
		return Number.isInteger(n) && n >= 0 ? n : null;
	};
	const outcome = await relayJournalNotice({
		count,
		vacuum: () =>
			spawnSync('journalctl', ['--rotate'], { stdio: 'ignore', timeout: 120_000 }).status === 0 &&
			spawnSync('journalctl', ['--vacuum-time=1s'], { stdio: 'ignore', timeout: 300_000 })
				.status === 0,
		ask: async (q) =>
			askingQuestions
				? process.stdin.isTTY === true
					? promptYes(q)
					: null
				: deferQuestion('whether to drop the journal history that holds old relay log lines'),
		later: QUESTIONS_COMMAND,
		markerExists: () => noticeMarkerExists(marker),
		writeMarker: (t) => writeNoticeMarker(marker, t),
		info,
		warn,
		spinner: (l) => startDotsSpinner(l)
	});
	if (outcome === 'unknown' && timedOut)
		warn(
			`The relay's older log lines could not be counted within ${limitMs / 1000} s, so nothing was asked or changed. To check them: ${QUESTIONS_COMMAND}`
		);
}

/** The TLS renewal heal, skipped without a word on a hidden-only node. */
export async function healTlsRenewalUnlessHidden(
	hiddenOnly: () => boolean = () => isHiddenOnlyNode()
): Promise<void> {
	if (hiddenOnly()) return;
	await reportHeal(healTlsRenewalHeal({ info, warn, spinner: (l) => startDotsSpinner(l) }));
}

/** The install the self-heal phase belongs to (the new CLI runs from it). */
function selfHealInstallDir(): string {
	return (
		/^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '')?.[1] ??
		((process.env.MORPHIT_INSTALL_DIR ?? '').trim() || '/opt/morphit')
	);
}

function healCtx(): { info: typeof info; warn: typeof warn; spinner: (l: string) => () => void } {
	return { info, warn, spinner: (l) => startDotsSpinner(l) };
}

/**
 * Heals that need the indexer / relay already running this release (each
 * restarts what it changes, then verifies against the running service):
 * hidden RPC list, relay health gate, database roles,
 * indexer.env shadows, Instances card settings, Web Push keys, log level; and the
 * tor-only egress rule, which needs more time than the self-heal phase
 * has. Run by the background unit after the restarts.
 */
export function afterRestartHealSteps(): Array<[string, () => Promise<void>]> {
	return [
		['the hidden RPC list heal', () => reportHeal(healHiddenRpcEnv(healCtx()))],
		['the relay health heal', () => reportHeal(healRelayHealthEnv(healCtx()))],
		['the database role heal', () => reportHeal(healPgRoles(healCtx()))],
		['the indexer.env heal', () => reportHeal(healIndexerEnvShadow(healCtx()))],
		// v1.21.10: install-time copies of the name / contact link in indexer.env
		// no longer override morphit.config.env (the Instances card).
		['the Instances card settings heal', () => reportHeal(healDisplayShadow(healCtx()))],
		// an empty relay-vapid.env is generated again; checked against
		// the restarted relay's local health.
		['the Web Push key heal', () => reportHeal(healVapid(healCtx()))],
		// an unknown MORPHIT_LOG_LEVEL → info, checked in the restarted indexer.
		['the log level heal', () => reportHeal(healLogLevel(healCtx()))],
		// the running indexer shows the fee addresses again.
		['the fee address check', () => checkFeeAddressHeal()],
		// 2026-10-08 (lib/releaseMonitorHeal.ts): the twice-a-day release check
		// is installed, turned on and run once (it reads the restarted indexer's
		// on-chain release record). Nothing installed it before.
		[
			'the release check heal',
			() =>
				reportHeal(healReleaseMonitor(healCtx(), realReleaseMonitorRuntime(selfHealInstallDir())))
		],
		// 2026-10-09 (lib/torBridgesHeal.ts): when this network filters plain Tor
		// (morphitir: torproject.org sinkholed, circuits starved), Tor moves onto
		// the release's built-in bridges, proven by its .onion loading, else put
		// back. Before the tor-only egress heal, whose checks go through Tor.
		['the Tor bridges heal', () => reportHeal(healTorBridges(healCtx(), selfHealInstallDir()))],
		// last — up to about four minutes of Tor checks, which the
		// self-heal child (killed at 300 s) cannot always afford after the
		// tor-only OS heal, and it may restart Docker, so it waits for the
		// background web-proxy heal first.
		['the tor-only egress heal', () => healTorOnlyEgressAfterWebHeal()],
		// The upgrader of v1.20.2 and older enables a bot the Matrix tor-only heal
		// stopped once the services are back; disable it again.
		[
			'the Matrix bot stop check',
			() =>
				reportHeal(
					recheckStoppedMatrixBot(
						healCtx(),
						realMatrixTorOnlyRuntime(async () => null)
					)
				)
		],
		// Last (up to 15 minutes, so nothing else waits behind it), after the
		// tor-only egress heal: Docker now pulls through Tor, so a hidden-only node
		// fetches the frontend's pinned nginx base here (the rebuild in the web heal
		// only has seconds), then rebuilds the frontend onto it.
		['the frontend base image fetch', () => fetchFrontendBaseNow()]
	];
}

/** The frontend base fetch (lib/frontendBaseFetch.ts) on this box; when the
 *  image arrived, the web heals rebuild the frontend onto it at once. */
export async function fetchFrontendBaseNow(
	deps: {
		readonly runtime?: BaseFetchRuntime;
		readonly waitIdle?: (unit: string) => Promise<'idle' | 'timed-out'>;
		readonly rebuild?: () => Promise<void>;
		/** When the after-restart unit is stopped (ms); the pull fits before it. */
		readonly deadline?: number;
	} = {}
): Promise<void> {
	const res = await fetchFrontendBaseThroughTor(
		healCtx(),
		deps.runtime ??
			realBaseFetchRuntime({
				frontend: () => findFrontendContainer(installBuildDir()),
				buildDir: installBuildDir()
			}),
		() => baseFetchBudgetMs(deps.deadline ?? afterRestartDeadline())
	);
	await reportHeal(Promise.resolve(res));
	// The base is here (fetched, loaded from the offline bundle, or already
	// here while the frontend is not on it yet): rebuild onto it.
	if (!['fetched', 'loaded', 'here'].includes(res.strategy)) return;
	// The rebuild edits the same compose files and containers as the background
	// web heal: never at the same time as it.
	if (
		(await (deps.waitIdle ?? ((u: string) => waitForUnitIdle(u)))(WEB_HEAL_UNIT)) === 'timed-out'
	) {
		warn(
			"The frontend's new nginx base is on this server, but the background web heal is still running, so the frontend was not rebuilt onto it now; on this server, later: sudo morphit-ops upgrade --heals"
		);
		return;
	}
	// The rebuild is the web heal's own job: start it as its own unit (its own
	// lock and time), so it never runs alongside another one.
	await (
		deps.rebuild ??
		(async () => {
			const r = launchWebHeal();
			if (r === 'unavailable')
				warn(
					"The frontend's new nginx base is on this server, but the rebuild onto it could not be started; on this server: sudo morphit-ops upgrade --heals"
				);
			else
				info(
					'The frontend is rebuilt onto its new nginx base in the background; see how it ended, on this server: sudo morphit-ops status'
				);
		})
	)();
}

/** after the restart, the methods whose empty line was commented have
 *  an address in the running indexer's /v1/instance. */
async function checkFeeAddressHeal(): Promise<void> {
	await reportHeal(
		verifyFeeAddressHeal(healCtx(), {
			markerText: () => realFeeAddressRuntime().markerText(),
			hiddenOnly: () => isHiddenOnlyNode(),
			bases: () => localIndexerBases(),
			instance: async () => {
				for (const base of localIndexerBases()) {
					try {
						return await getLocalIndexerJson<{
							treasury?: { btc?: string | null; xmr?: string | null };
						}>(base, '/v1/instance');
					} catch {
						/* next base */
					}
				}
				return null;
			}
		})
	);
}

/** The tor-only egress heal (lib/torOnlyEgressHeal.ts), once no web-proxy heal
 *  is running: it may restart Docker, which would cut that heal short. */
export async function healTorOnlyEgressAfterWebHeal(
	deps: { readonly waitIdle?: (unit: string) => Promise<'idle' | 'timed-out'> } = {}
): Promise<void> {
	const waitIdle = deps.waitIdle ?? ((u: string) => waitForUnitIdle(u));
	if ((await waitIdle(WEB_HEAL_UNIT)) === 'timed-out') {
		warn(
			`Tor-only egress rule: not checked this time — the web-proxy heal (${WEB_HEAL_UNIT}) was still running after 10 minutes, ` +
				'and this check may restart Docker. It runs again at the next upgrade.'
		);
		return;
	}
	await reportHeal(healTorOnlyEgress(healCtx()));
}

/** The background unit's body: wait for the restarts, then run the heals. */
export async function runAfterRestartHeals(
	sinceUs: number,
	/** Tests: the waits and the steps. */
	deps: {
		readonly waitRestarts?: typeof waitForRestarts;
		readonly waitAnswers?: (services: readonly string[]) => Promise<string[]>;
		readonly steps?: () => Array<[string, () => Promise<void>]>;
		/** false (`upgrade --heals`): nothing was restarted, so nothing is
		 *  waited for — the checks run against what runs now. */
		readonly servicesRestarted?: boolean;
	} = {}
): Promise<void> {
	const services = ['morphit-indexer.service', 'morphit-relay.service'];
	if (deps.servicesRestarted === false) {
		for (const [name, step] of (deps.steps ?? afterRestartHealSteps)()) {
			try {
				await step();
			} catch (e) {
				warn(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		printRoutineSummary();
		return;
	}
	info(`Waiting for ${services.join(' and ')} to restart on the new version…`);
	const w = await (deps.waitRestarts ?? waitForRestarts)(sinceUs, services);
	if (w === 'timed-out')
		warn('They did not restart within 15 minutes; running the checks against what is running now.');
	else {
		// Restarted is not listening yet: the relay answers only after its key,
		// clock and RPC-directory steps (2026-10-08).
		const stop = startDotsSpinner('Waiting for them to answer on their health addresses…');
		let silent: string[];
		try {
			silent = await (deps.waitAnswers ?? ((s) => waitForAnswers(s)))(services);
		} finally {
			stop();
		}
		if (silent.length > 0)
			warn(
				`${silent.join(' and ')} did not answer on ${silent.length === 1 ? 'its' : 'their'} health address within 5 minutes of the restart; ` +
					'running the checks against what is running now.'
			);
	}
	for (const [name, step] of (deps.steps ?? afterRestartHealSteps)()) {
		try {
			await step();
		} catch (e) {
			warn(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	printRoutineSummary();
	info('Done.');
}

/** Start the background unit and tell the operator where its results go. */
export async function startAfterRestartHeals(): Promise<void> {
	let r = launchAfterRestartHeals();
	if (r === 'already-running') {
		// An earlier upgrade's run: it runs THAT release's code and checks. Stop
		// it and start this release's (which does all of its work again). Async,
		// so the spinner draws while systemd stops it (up to two minutes).
		let stopped = false;
		try {
			stopped =
				(await runStepWithSpinner(
					`Stopping the background checks an earlier upgrade started (${AFTER_RESTART_UNIT}), to run this release's…`,
					'systemctl',
					['stop', AFTER_RESTART_UNIT],
					{ timeoutMs: 120_000, quietOnSuccess: true, name: `systemctl stop ${AFTER_RESTART_UNIT}` }
				)) === 0 &&
				spawnSync('systemctl', ['is-active', '--quiet', AFTER_RESTART_UNIT], {
					stdio: 'ignore',
					timeout: 10_000
				}).status !== 0;
		} catch {
			stopped = false;
		}
		if (stopped) r = launchAfterRestartHeals();
		if (r === 'already-running') {
			afterRestartLaunched = false;
			warn(
				`This release's checks that need the restarted services did not run: the background checks an earlier upgrade started (${AFTER_RESTART_UNIT}) are still running and could not be stopped. ` +
					`Once they have finished (on this server, \`systemctl is-active ${AFTER_RESTART_UNIT}\` says inactive), on this server: sudo morphit-ops upgrade --heals`
			);
			return;
		}
		if (r === 'launched')
			info(
				"Stopped the background checks an earlier upgrade started (they ran that release's code); this release's run instead."
			);
	}
	afterRestartLaunched = r !== 'unavailable';
	if (r === 'unavailable') {
		warn(
			'Could not start the checks that run after the services restart (systemd-run did not start ' +
				`${AFTER_RESTART_UNIT}); they run again at the next upgrade.`
		);
		return;
	}
	// An upgrade that names what is left in its last lines says this there.
	if (process.env.MORPHIT_UPGRADE_SUMMARIZES === '1') return;
	info(
		`The checks that need the restarted services run in the background (${AFTER_RESTART_UNIT}) once they are back; ` +
			`results: sudo cat ${afterRestartLogPath()}`
	);
}

/** Warn when the served /pgp_keys.asc is morphit.io's canary key. */
export function warnUpstreamCanaryKey(
	buildDir = join(selfHealInstallDir(), 'apps', 'web', 'build')
): void {
	const key = join(buildDir, 'pgp_keys.asc');
	if (!existsSync(key)) return;
	if (armoredKeyFingerprints(key)?.includes(UPSTREAM_CANARY_KEY_FPR)) {
		warn(
			`This instance serves morphit.io's canary key as its own /pgp_keys.asc (${UPSTREAM_CANARY_KEY_FPR.slice(-16)}). ` +
				'Visitors would check your canary against a key that is not yours. Add yours: sudo morphit-ops harden'
		);
	}
}

/** Remove /run/morphit-reg-*.pass leftovers and say so. */
export function healStaleRegPassFiles(dir = '/run'): void {
	const r = removeStaleRegPassFiles(dir);
	if (r.found === 0) return;
	if (r.left === 0) info(`Removed ${r.found} leftover relay passphrase file(s) from ${dir}.`);
	else
		warn(
			`${r.left} relay passphrase file(s) could not be removed; on this server run: sudo rm -f ${dir}/morphit-reg-*.pass`
		);
}

/** Ask the operator at the terminal; null when there is none, or no answer
 *  within 2 minutes (the self-heal child is stopped at 300 s, and the heals
 *  after this one must still run). */
async function askOnTerminal(q: string): Promise<string | null> {
	if (process.stdin.isTTY !== true) return null;
	const readline = await import('node:readline/promises');
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await rl.question(`${q}\n> `, { signal: AbortSignal.timeout(120_000) })).trim();
	} catch {
		return null;
	} finally {
		rl.close();
	}
}

/** The Matrix bot tor-only heal (lib/matrixTorOnlyHeal.ts) on this box. */
export async function healMatrixBotTorOnlyNow(): Promise<void> {
	await reportHeal(
		healMatrixBotTorOnly(
			healCtx(),
			realMatrixTorOnlyRuntime(
				askingQuestions
					? askOnTerminal
					: async () => deferQuestion('whether to keep the Matrix bot on its clearnet homeserver')
			)
		)
	);
}

/** What a heal reports when it found nothing to change and nothing for the
 *  operator to do: its end state was observed, and there is nothing new. */
const ROUTINE_STRATEGIES = new Set([
	'already',
	'skipped',
	'not-tor-only',
	'not-installed',
	'not-present',
	'no-bot',
	'no-backups',
	'nothing-to-check',
	'kept-by-choice'
]);

/** PURE. A heal result that needs no line of its own: observed, already right
 *  or not applicable to this server, AND with nothing to tell — no detail, or a
 *  detail the heal itself marked `routine` (it only says there was nothing to
 *  do). A result that names an action, a notice or a failure is always shown,
 *  whatever its strategy. */
export function isRoutineHeal(r: HealResult): boolean {
	return (
		r.verified &&
		(ROUTINE_STRATEGIES.has(r.strategy) || r.strategy.startsWith('already')) &&
		(r.detail === '' || r.routine === true)
	);
}

/** Checks this run that found nothing to change (summed up in one line). */
let routineChecks = 0;

/** Count one check that found nothing to change (it prints nothing itself). */
function routineCheck(): void {
	routineChecks++;
}

/** One line for every check that found nothing to change, then start over. */
export function printRoutineSummary(): void {
	if (routineChecks === 0) return;
	info(
		`\u2713 ${routineChecks} other check${routineChecks === 1 ? '' : 's'} found nothing to change.`
	);
	routineChecks = 0;
}

/** Print a heal's result: nothing for a routine one (it is counted), info when
 *  its end state was observed, warn otherwise. */
export async function reportHeal(r: Promise<HealResult>): Promise<void> {
	const res = await r;
	if (isRoutineHeal(res)) {
		routineCheck();
		return;
	}
	if (res.detail === '') return;
	(res.verified ? info : warn)(res.detail);
}

/** The canary refresh-source heal in the heal phase (lib/canaryRepoHeal.ts). */
export async function healCanaryRefreshRepoNow(): Promise<void> {
	await reportHeal(
		Promise.resolve(healCanaryRefreshRepo(selfHealInstallDir(), realCanaryRepoRuntime()))
	);
}

/** When the background web heal was started by this process (ms), or null. */
let webHealLaunchedAt: number | null = null;

function installBuildDir(): string {
	return join(
		/^(.*)\/apps\/ops-cli\/dist\//.exec(process.argv[1] ?? '')?.[1] ?? '/opt/morphit',
		'apps',
		'web',
		'build'
	);
}

/** The heals themselves: the WAF, then the web-proxy privacy/headers. Runs in
 *  the background unit (`morphit-ops __web-heal`) with the time BunkerWeb
 *  needs, or in the upgrade with bounded waits. Writes the state file. */
export async function runWebProxyHealsNow(opts: { readonly background: boolean }): Promise<void> {
	const startedAt = new Date().toISOString();
	const warningsBefore = warningCount();
	if (opts.background) writeWebHealState({ state: 'running', startedAt });
	let result = 'error';
	let detail: string | undefined;
	let except: string | undefined;
	try {
		await healBunkerWebWaf(undefined, installBuildDir(), {
			reloadBudgetMs: opts.background ? 10 * 60_000 : 60_000
		});
		const out = await healProxyConfig({
			info,
			warn,
			spinner: (l) => startDotsSpinner(l),
			buildDir: installBuildDir(),
			...(opts.background ? { budgetMs: 20 * 60_000 } : {})
		});
		result = out.kind;
		detail = 'reason' in out ? out.reason : undefined;
		// Round 2, item 6 (lib/bunkerwebJobsHeal.ts): BunkerWeb's scheduler runs
		// Morphit's job lists, so it fetches nothing from the internet. After the
		// proxy-config heal (both edit the compose file; this one only the
		// scheduler's volumes), and here because its scheduler recreate and log
		// check can take minutes — this job runs in the background unit on a
		// BunkerWeb box, never under the self-heal child's 300 s limit. A box
		// without a running BunkerWeb scheduler is skipped in one line.
		await reportHeal(healBunkerwebJobs({ info, warn, spinner: (l) => startDotsSpinner(l) }));
		// v1.21.11 (lib/bunkerwebWww.ts): www.<domain> answers, goes to the
		// domain, and is on the certificate. Last: it recreates BunkerWeb and asks
		// Let's Encrypt, and it checks its rule against the settings the heals
		// above left.
		// Finished before the run that hosts it ends: the background unit's time
		// limit, or the self-heal child's (a few minutes: never enough to recreate
		// BunkerWeb, so there the heal only says what it finds).
		const www = await healBunkerWebWwwNow(installBuildDir(), {
			background: opts.background,
			deadline: wwwHealDeadline({
				background: opts.background,
				startedAtMs: Date.parse(startedAt),
				nowMs: Date.now(),
				uptimeS: process.uptime()
			})
		});
		// Its own warning says what; the outcome must not claim it is in place.
		if (www !== null && !www.verified) except = 'the www address';
	} catch (err) {
		detail = err instanceof Error ? err.message : String(err);
		throw err;
	} finally {
		writeWebHealState({
			state: 'done',
			startedAt,
			finishedAt: new Date().toISOString(),
			result,
			...(detail !== undefined ? { detail } : {}),
			...(except !== undefined ? { except } : {}),
			...(warningCount() > warningsBefore ? { warnings: warningCount() - warningsBefore } : {}),
			// Run here: its warnings and its end are shown here, not again at
			// the end of the upgrade.
			...(!opts.background ? { shown: true } : {})
		});
	}
	// Run here (not in the background unit): say how it ended, as the
	// background path does at the end of the heals. Its warnings were printed
	// right here (each counted once).
	if (!opts.background) {
		const n = warningCount() - warningsBefore;
		reportWebProxyOutcome(
			{
				state: 'done',
				startedAt,
				finishedAt: new Date().toISOString(),
				result,
				...(detail !== undefined ? { detail } : {}),
				...(except !== undefined ? { except } : {}),
				...(n > 0 ? { warnings: n } : {})
			},
			n
		);
	}
}

/** Post-upgrade step: on a BunkerWeb box start the heals in the background;
 *  otherwise (or when that is impossible) run them here as before. `deps` are
 *  seams for its test. */
export async function startWebProxyHeals(
	deps: {
		readonly isBunkerWeb?: () => boolean;
		readonly launch?: () => ReturnType<typeof launchWebHeal>;
		readonly runHere?: () => Promise<void>;
	} = {}
): Promise<void> {
	let bunkerweb = false;
	try {
		bunkerweb = (
			deps.isBunkerWeb ?? (() => findBunkerWebStack(installBuildDir()).stack !== null)
		)();
	} catch {
		bunkerweb = false;
	}
	if (bunkerweb) {
		const at = Date.now();
		const r = (deps.launch ?? (() => launchWebHeal()))();
		if (r === 'launched' || r === 'already-running') {
			// One already at work (an earlier upgrade's, or the frontend rebuild)
			// started before now: follow THAT run to its end, by its own start.
			const running = r === 'already-running' ? readWebHealState() : null;
			const since =
				running !== null && running.state === 'running' ? Date.parse(running.startedAt) : NaN;
			webHealLaunchedAt = Number.isFinite(since) ? Math.min(since, at) : at;
			info(
				r === 'launched'
					? "BunkerWeb's settings are checked in the background (a change takes BunkerWeb minutes to apply); how that ends is shown further down, or in this upgrade's last lines if it takes longer."
					: "BunkerWeb's settings are already being checked in the background; how that ends is shown further down, or in this upgrade's last lines if it takes longer."
			);
			return;
		}
	}
	await (deps.runHere ?? (() => runWebProxyHealsNow({ background: false })))();
}

/** Post-upgrade step (last): show the background heal's progress and result
 *  while this child has time; else say plainly that it carries on. Exported
 *  for its test. */
export async function showWebProxyResult(): Promise<void> {
	if (webHealLaunchedAt === null) return;
	// Finish before the child's kill (it started process.uptime() s ago).
	const until = Date.now() - process.uptime() * 1000 + SELF_HEAL_CHILD_TIMEOUT_MS - 25_000;
	// Every warning the background run printed is relayed here as a warning
	// of its own (counted once); the outcome line then adds only what they did
	// not already say (v1.21.17: one www problem was shown three times and
	// counted twice).
	let relayed = 0;
	const s = await followWebHeal(until, webHealLaunchedAt, {
		info,
		warn: (m) => {
			relayed++;
			warn(m);
		},
		spinner: (l) => startDotsSpinner(l)
	});
	if (s === null) {
		// The upgrade that started this phase names it in its last lines: still
		// running then, or how it ended (it reads the state file).
		if (process.env.MORPHIT_UPGRADE_SUMMARIZES === '1') return;
		info(`${WEB_HEAL_STILL_RUNNING} See how it ended, on this server: sudo morphit-ops status`);
		return;
	}
	reportWebProxyOutcome(s, relayed);
	// Shown here: the upgrade's last lines do not repeat it.
	if (relayed >= (s.warnings ?? 0)) writeWebHealState({ ...s, shown: true });
}

/** The background web heal (morphit-web-heal) is still at work: true whether
 *  the upgrade started it for the web-proxy settings or the after-restart
 *  checks started it to rebuild the frontend onto its new base. */
const WEB_HEAL_STILL_RUNNING =
	'The web-proxy settings (BunkerWeb and the frontend container) are still being applied in the background; if a check fails, the previous settings are put back by themselves.';

/** One web-heal outcome for the operator: nothing (counted) when nothing
 *  changed and nothing was warned about, ✓ when applied, a warning for
 *  anything else. Exported for its test. */
export function reportWebProxyOutcome(s: WebHealState, relayed = 0): void {
	const n = s.warnings ?? 0;
	const ok = s.result === 'already' || s.result === 'no-proxy' || s.result === 'applied';
	if ((s.result === 'already' || s.result === 'no-proxy') && n === 0 && !s.except) {
		routineCheck();
		return;
	}
	// Its warnings were already shown above, each counted once.
	const allShown = n > 0 && relayed >= n;
	if (ok && allShown) {
		// They said what is wrong; the settings themselves are in place. A
		// change it made is still news.
		if (s.result === 'applied')
			info(
				`✓ Web-proxy settings: applied and checked; the warning above is about ${s.except ?? 'one of its checks'}.`
			);
		return;
	}
	const line = `Web-proxy settings: ${describeWebHeal({ ...s, ...(allShown ? { warnings: 0 } : {}) }, Date.now())}.`;
	// Only an applied change is good news; anything else —
	// rolled back, failed, left alone, no time — needs the operator. So does
	// a run whose warnings could not be relayed (its log could not be read):
	// the line names them and their log. One whose warnings were relayed is
	// the conclusion of what they said, not another warning.
	if (s.result === 'applied' && n === 0 && !s.except) info(`✓ ${line}`);
	else if ((s.result === 'unchecked' && n === 0) || allShown) info(line);
	else warn(line);
}

/** Self-heal: refresh /usr/local/lib/morphit helpers from the release this
 *  binary belongs to (see lib/refreshHelperScripts.ts for the rules). */
export function healHelperScripts(): void {
	let installDir = (process.env.MORPHIT_INSTALL_DIR ?? '').trim() || '/opt/morphit';
	const m = /^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '');
	if (m && m[1] && existsSync(join(m[1], 'ops'))) installDir = m[1];
	const helperDir = process.env.MORPHIT_HELPER_DIR ?? DEFAULT_HELPER_DIR;
	// A refresh that failed is a warning (each one says what happened), never
	// "found nothing to change".
	const results = refreshHelperScripts({ releaseRoot: installDir, helperDir, log: warn });
	const line = describeHelperRefresh(results, helperDir);
	if (line !== null) info(line);
	// (A helper that is not a regular file, a failed refresh: the refresh's own
	// log line, a warning, says so.)
	if (
		line === null &&
		results.every((r) => ['unchanged', 'not-installed', 'no-release-copy'].includes(r.action))
	)
		routineCheck();
}

export async function healRelayClearnet(): Promise<void> {
	// MORPHIT_ENV_ROOT relocates the env files under a directory, as
	// MORPHIT_SYSTEMD_DIR relocates units: it is how the test drives this real
	// entry point against scratch files. Unset on a real box.
	const root = process.env.MORPHIT_ENV_ROOT ?? '';
	const at = (files: readonly string[]): string[] => files.map((f) => `${root}${f}`);
	const relayFiles = at(RELAY_ENV_FILES);
	// Where the relay answers its health check: its own bind, read the way the
	// unit reads it. A wildcard bind is reached on loopback.
	const listen = (() => {
		try {
			const v = readEffectiveEnv(relayFiles, [
				'MORPHIT_RELAY_LISTEN_HOST',
				'MORPHIT_RELAY_LISTEN_PORT'
			]);
			const host = (v.get('MORPHIT_RELAY_LISTEN_HOST') ?? '').trim();
			const port = Number((v.get('MORPHIT_RELAY_LISTEN_PORT') ?? '').trim()) || 8080;
			return {
				host: host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host,
				port
			};
		} catch {
			return { host: '127.0.0.1', port: 8080 };
		}
	})();
	// A test drives the real entry point with no systemd: it says so, and the
	// heal then stops at "written", which is what it can honestly claim.
	const noSystemd = process.env.MORPHIT_HEAL_NO_SYSTEMD === '1';
	await applyAndVerifyRelayHeal({
		indexerFiles: at(INDEXER_ENV_FILES),
		relayFiles,
		targets: at(RELAY_ENV_TARGETS),
		info,
		warn,
		runtime: {
			isActive: () =>
				!noSystemd &&
				spawnSync('systemctl', ['is-active', '--quiet', 'morphit-relay.service']).status === 0,
			restart: () =>
				spawnSync('systemctl', ['restart', 'morphit-relay.service'], { timeout: 60_000 }).status ===
				0,
			// only a relay systemd reports as failing is
			// reverted; a slow first chain read over Tor is not a failure.
			unitState: () => {
				const r = spawnSync(
					'systemctl',
					[
						'show',
						'-p',
						'ActiveState',
						'-p',
						'SubState',
						'-p',
						'NRestarts',
						'morphit-relay.service'
					],
					{ encoding: 'utf8', timeout: 10_000 }
				);
				if (r.status !== 0 || typeof r.stdout !== 'string')
					throw new Error('systemctl show failed');
				const v = (k: string): string =>
					new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout)?.[1]?.trim() ?? '';
				const n = Number(v('NRestarts'));
				return {
					activeState: v('ActiveState'),
					subState: v('SubState'),
					restarts: v('NRestarts') !== '' && Number.isInteger(n) ? n : null
				};
			},
			health: async () => {
				const ctrl = new AbortController();
				const t = setTimeout(() => ctrl.abort(), 3_000);
				try {
					const host = listen.host.includes(':') ? `[${listen.host}]` : listen.host;
					const res = await fetch(`http://${host}:${listen.port}/v1/health`, {
						signal: ctrl.signal
					});
					// Capped before parsing, like every body this file reads (the
					// hardening rule: no bare res.json()). The relay's health report
					// is a few hundred bytes; anything past 64 KB is not one.
					const txt = await res.text().catch(() => '');
					let body: { hidden_only?: unknown } = {};
					if (txt.length <= 65536) {
						try {
							body = JSON.parse(txt) as { hidden_only?: unknown };
						} catch {
							body = {};
						}
					}
					return {
						reachable: res.ok,
						hiddenOnly: typeof body.hidden_only === 'boolean' ? body.hidden_only : null
					};
				} catch {
					return { reachable: false, hiddenOnly: null };
				} finally {
					clearTimeout(t);
				}
			},
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			spinner: (label) => startDotsSpinner(label)
		}
	});
}

/** npm's "New major version" notice, box-wide — see ../lib/npmNotice.ts. */
export function healNpmUpdateNotice(): void {
	const stop = startDotsSpinner("Checking the box's global npm settings…");
	try {
		healNpmNoticeGlobal();
	} finally {
		stop();
	}
}

/** Per-instance branding self-heal (docs/BRANDING.md): re-apply the operator's
 *  branding to the served build and mirror any change into a bare-metal web
 *  root (a container frontend bind-mounts the build, so it is live at once).
 *  Idempotent — a build that already matches is left untouched. */
export function healBranding(): void {
	let installDir = (process.env.MORPHIT_INSTALL_DIR ?? '').trim() || '/opt/morphit';
	const m = /^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '');
	if (m && m[1] && existsSync(join(m[1], 'apps', 'web'))) installDir = m[1];
	const buildDir = join(installDir, 'apps', 'web', 'build');
	const webRoot = resolveWebRoot(process.env);
	// the served build names this instance's origin (resets and
	// re-applies the branding around it when it has to).
	try {
		const r = syncInstanceOrigin(healCtx(), {
			installDir,
			buildDir,
			webRoot: existsSync(webRoot) ? webRoot : null
		});
		if (r.detail !== '') (r.verified ? info : warn)(sanitizeForTerm(r.detail));
		if (r.strategy !== 'no-map' && r.strategy !== 'already')
			info(`Instance origin: ${r.origin} — ${r.strategy}.`);
	} catch (err) {
		warn(
			`Your instance origin could not be applied (${sanitizeForTerm(err instanceof Error ? err.message : String(err))}). Run: sudo morphit-ops upgrade`
		);
	}
	if (!existsSync(join(buildDir, BRAND_SLOTS_FILE))) return; // pre-branding build
	const stopBrand = startDotsSpinner('Checking the live frontend’s branding…');
	let br: ReturnType<typeof applyBranding>;
	try {
		br = applyBranding({ buildDir, settings: readBrandingSettings(installDir) });
	} finally {
		stopBrand();
	}
	for (const w of br.warnings) warn(sanitizeForTerm(w));
	if (br.touched.length > 0) {
		if (existsSync(webRoot)) syncTouchedToWebRoot(buildDir, webRoot, br.touched);
		info(
			br.active
				? `\u2713 Applied your branding${br.brandName ? ` ("${sanitizeForTerm(br.brandName)}")` : ''} to the live frontend.`
				: '\u2713 Frontend branding reset to the plain Morphit look (no branding configured).'
		);
	}
	// The link-preview image (og-image.png): OBSERVE what is served \u2014 this
	// branding's own picture when it draws one, else the one verify.json lists.
	// A bare-metal web root that missed an earlier copy gets it now.
	const servedDir = existsSync(webRoot) ? webRoot : buildDir;
	let og = checkServedOgImage(servedDir, br.ogImageSha256);
	if (!og.ok && servedDir === webRoot) {
		syncTouchedToWebRoot(buildDir, webRoot, ['og-image.png']);
		og = checkServedOgImage(webRoot, br.ogImageSha256);
		if (og.ok) info(`✓ Link-preview image (og-image.png) re-published to ${webRoot}.`);
	}
	if (!og.ok) {
		warn(
			`The link-preview image is not up to date: ${sanitizeForTerm(og.detail)}. Run: sudo morphit-ops branding apply`
		);
	} else if (br.ogImageSha256 !== null && br.touched.includes('og-image.png')) {
		info(
			`\u2713 Link-preview image (og-image.png) is your own (served sha256 ${og.sha256?.slice(0, 12)}\u2026).`
		);
	}
}

/** v1.16.13 — SELF-HEAL: rebuild the compose-managed frontend so a shipped
 *  nginx.conf change (e.g. the v1.16.12 `/v1/broadcast` body cap) lands on the
 *  SAME upgrade. The frontend's nginx.conf is BAKED into its image, so the main
 *  upgrade flow's restart alone keeps a stale config — and because this runs from
 *  the NEW binary in the re-exec self-heal phase (like the WAF/IPFS heals), a
 *  config fix applies on the release that ships it, not one upgrade later
 *  (seen on an instance: the nginx fix sat undeployed because the driving orchestrator
 *  only restarted the frontend). Self-contained + best-effort; no-ops if there's
 *  no compose-managed frontend. Docker layer-caching makes a no-change rebuild
 *  cheap, so running it every upgrade is fine. */
export async function healFrontendConfig(): Promise<void> {
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
		const name = await withSpinner('Looking for the frontend container…', () =>
			findFrontendContainerAsync(buildDir)
		);
		if (name !== null) {
			// SKIP when the running container ALREADY has this config.
			//
			// The main upgrade flow also refreshes nginx.conf and rebuilds, so on any
			// reasonably current orchestrator this heal rebuilt and RESTARTED the
			// frontend a second time, seconds after the first — two restarts, two
			// brief outages, on every upgrade forever. The rebuild is cheap thanks to
			// layer caching, but the RESTART is not free: it is downtime on a working
			// instance for no change.
			//
			// The heal still matters when the driving binary is old enough not to
			// rebuild (which is why it exists), so decide on evidence rather than
			// assuming either way: ask the container what config it is actually
			// serving and compare it to the repo's. Identical → nothing to heal.
			const repoConf = join(installDir, 'ops', 'bunkerweb', 'frontend', 'nginx.conf');
			let alreadyCurrent = false;
			try {
				if (existsSync(repoConf)) {
					const live = await withSpinner('Reading the frontend’s running nginx config…', () =>
						runAsync('docker', ['exec', name, 'cat', '/etc/nginx/conf.d/morphit.conf'], {
							timeoutMs: 20_000
						})
					);
					if (live.status === 0) {
						alreadyCurrent = live.stdout === readFileSync(repoConf, 'utf8');
					}
				}
			} catch {
				/* cannot tell → fall through and heal, as before */
			}
			if (alreadyCurrent) {
				routineCheck();
			} else {
				// restartFrontendContainer refreshes the build-context nginx.conf from
				// the upgraded repo and rebuilds when compose-managed (else restarts).
				await restartFrontendContainer(name, installDir);
			}
		}
	} catch {
		/* best-effort — never fail the self-heal phase over the frontend */
	}
}

/** Deps for the IPFS swarm-firewall heal — injectable so the behaviour is
 *  testable without a live ufw/systemd/Kubo. */
export interface IpfsSwarmFirewallDeps {
	/** Does this box host IPFS (a Kubo repo is present)? */
	kuboPresent?: () => boolean;
	/** Is this a hidden-only node (no public swarm — 4001 must stay closed)? */
	hiddenOnly?: () => boolean;
	/** Run a command; returns exit status + stdout. */
	run?: (cmd: string, args: readonly string[]) => { status: number | null; stdout: string };
	info?: (m: string) => void;
	warn?: (m: string) => void;
}

/** Is ufw enforcing at all? `ufw status` prints "Status: inactive" when off. */
export function ufwIsActive(ufwStatus: string): boolean {
	return /^\s*Status:\s*active\b/im.test(ufwStatus);
}

/** Parse `ufw status` and decide whether 4001 is ALLOWED on BOTH tcp and udp.
 *  PURE (review B7; wave 4). Only rules whose Action is ALLOW count (a DENY /
 *  REJECT / LIMIT line naming 4001 is not an opening). A bare `4001` rule (no
 *  proto) covers both; otherwise both `4001/tcp` and `4001/udp` must be allowed. */
export function ufwAllows4001Both(ufwStatus: string): boolean {
	const allowed = (port: string): boolean =>
		ufwStatus
			.split('\n')
			.some((l) =>
				new RegExp(`^\\s*${port.replace('/', '\\/')}(?:\\s+\\(v6\\))?\\s+ALLOW\\b`, 'i').test(l)
			);
	if (allowed('4001')) return true;
	return allowed('4001/tcp') && allowed('4001/udp');
}

/**
 * SELF-HEAL: open the IPFS swarm port 4001 (BOTH tcp and udp — Kubo swarms over
 * TCP and QUIC/UDP) on a CLEARNET IPFS-hosting box, on upgrade (review B7). The
 * Ansible ufw role opens it, but a template fix never reaches an already-
 * installed node (upgrade does not re-run Ansible), and morphit.io is a manual
 * /opt/morphit install Ansible never touches — the same defect class that left
 * the gateway firewall rule undelivered. VERIFY, then log: read `ufw status`
 * back and only claim success when BOTH protocols are actually allowed. A
 * hidden-only node (no public swarm) and a box with no Kubo are left untouched.
 */
export function healIpfsSwarmFirewall(deps: IpfsSwarmFirewallDeps = {}): void {
	const say = deps.info ?? info;
	const warnFn = deps.warn ?? warn;
	const run =
		deps.run ??
		((cmd: string, args: readonly string[]) => {
			const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout: 20_000 });
			return { status: r.status, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` };
		});
	const kuboPresent =
		deps.kuboPresent ??
		(() =>
			['/var/lib/ipfs/.ipfs', '/var/lib/ipfs', '/opt/ipfs/.ipfs'].some((c) => {
				try {
					return existsSync(join(c, 'config'));
				} catch {
					return false;
				}
			}));
	const hiddenOnly = deps.hiddenOnly ?? (() => isHiddenOnlyNode());

	try {
		if (!kuboPresent()) return; // not an IPFS host — nothing to open
		if (hiddenOnly()) return; // no public swarm on a hidden-only node
		if (run('sh', ['-c', 'command -v ufw >/dev/null 2>&1']).status !== 0) return; // no ufw here

		const status = run('ufw', ['status']).stdout;
		// ufw installed but switched OFF: it blocks nothing, so there is no rule to
		// open — say so once, calmly, instead of "could not confirm" every upgrade.
		if (!ufwIsActive(status)) {
			say(
				'IPFS: ufw is not active on this box, so nothing blocks the swarm port 4001 — no firewall rule to add.'
			);
			return;
		}
		const already = ufwAllows4001Both(status);
		if (already) return; // steady state

		// Primary: open both protocols.
		run('ufw', ['allow', '4001/tcp']);
		run('ufw', ['allow', '4001/udp']);

		// VERIFY by observing ufw's own state, not the exit codes.
		if (ufwAllows4001Both(run('ufw', ['status']).stdout)) {
			say(
				'IPFS: opened the swarm port 4001 (tcp+udp) so public gateways + QUIC peers can fetch your seeded releases.'
			);
		} else {
			warnFn(
				'IPFS: could not confirm the swarm port 4001 is open on BOTH tcp and udp. If public ' +
					'gateways cannot fetch your seeded releases, run on this box: ' +
					'sudo ufw allow 4001/tcp && sudo ufw allow 4001/udp && sudo systemctl restart ipfs'
			);
		}
	} catch {
		/* best-effort — never fail the self-heal phase over the swarm firewall */
	}
}

export interface BridgeFirewallDeps {
	run?: (cmd: string, args: readonly string[]) => { status: number | null; stdout: string };
	/** This box hosts IPFS with its gateway exposed to the web containers. */
	ipfsGateway?: () => boolean;
	/** morphit-mcp runs (the frontend proxies /mcp to it). */
	mcpRunning?: () => boolean;
	info?: (m: string) => void;
	warn?: (m: string) => void;
}

/**
 * SELF-HEAL (v1.21.7): the firewall rules that let the install's web
 * containers (bunkerweb_net) reach the host's relay (8080), indexer (8081),
 * IPFS gateway (8082) and MCP (8124). Without them every /v1 call from the
 * site hangs and peers list the node as "Clearnet blocked" — what the
 * install's SSH safety revert left on a fresh VPS by emptying the firewall
 * (2026-10-12). Only on the install's own layout (the bunkerweb_net network,
 * its subnet read from Docker), only when ufw is on, adding only the missing
 * rules, from that subnet only. Verified by reading ufw back.
 */
/** How the bridge heal runs ufw and docker: LC_ALL=C, because ufw's status
 *  words are translated on a non-English box. */
export function bridgeHealRun(
	cmd: string,
	args: readonly string[]
): { status: number | null; stdout: string } {
	const r = spawnSync(cmd, [...args], {
		encoding: 'utf8',
		timeout: 20_000,
		env: { ...process.env, LC_ALL: 'C' }
	});
	return { status: r.status, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The subnet the web containers' rules are opened from: the first private
 *  IPv4 subnet of bunkerweb_net (a dual-stack network lists an IPv6 one too),
 *  never wider than its private range — a "0.0.0.0/0" or a public range would
 *  have opened the relay, indexer and MCP to the internet (review,
 *  2026-10-12). null when there is none. PURE. */
export function bridgeSubnet(inspectOutput: string): string | null {
	for (const cand of inspectOutput.split(/\s+/)) {
		const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cand);
		if (!m) continue;
		const [a, b, c, d, len] = m.slice(1).map(Number) as [number, number, number, number, number];
		if ([a, b, c, d].some((o) => o > 255) || len > 32) continue;
		const ok =
			(a === 10 && len >= 8) ||
			(a === 172 && b >= 16 && b <= 31 && len >= 12) ||
			(a === 192 && b === 168 && len >= 16);
		if (ok) return cand;
	}
	return null;
}

export function healBridgeFirewall(deps: BridgeFirewallDeps = {}): void {
	const say = deps.info ?? info;
	const warnFn = deps.warn ?? warn;
	const run = deps.run ?? bridgeHealRun;
	const ipfsGateway =
		deps.ipfsGateway ??
		(() => run('systemctl', ['is-active', '--quiet', 'ipfs.service']).status === 0);
	const mcpRunning =
		deps.mcpRunning ??
		(() => run('systemctl', ['is-active', '--quiet', 'morphit-mcp.service']).status === 0);
	try {
		if (
			run('sh', ['-c', 'command -v ufw >/dev/null 2>&1 && command -v docker >/dev/null 2>&1'])
				.status !== 0
		)
			return;
		const net = run('docker', [
			'network',
			'inspect',
			'bunkerweb_net',
			'-f',
			'{{range .IPAM.Config}}{{.Subnet}} {{end}}'
		]);
		if (net.status !== 0) return; // not the install's layout
		const subnet = bridgeSubnet(net.stdout);
		if (subnet === null) {
			say(
				`Firewall: bunkerweb_net has no private IPv4 subnet (${net.stdout.trim().slice(0, 80)}), so the ` +
					'web containers\u2019 firewall rules were not checked.'
			);
			return;
		}
		const status = (): string => run('ufw', ['status']).stdout;
		if (!ufwIsActive(status())) return;
		const ports = [
			'8080',
			'8081',
			...(ipfsGateway() ? ['8082'] : []),
			...(mcpRunning() ? ['8124'] : [])
		];
		const esc = subnet.replace(/[./]/g, (c) => `\\${c}`);
		const has = (text: string, p: string): boolean =>
			new RegExp(`^\\s*${p}\\/tcp\\s+ALLOW(?:\\s+IN)?\\s+${esc}(?:\\s+#.*)?\\s*$`, 'im').test(text);
		const missing = ports.filter((p) => !has(status(), p));
		if (missing.length === 0) return;
		for (const p of missing)
			run('ufw', ['allow', 'from', subnet, 'to', 'any', 'port', p, 'proto', 'tcp']);
		const after = status();
		const still = missing.filter((p) => !has(after, p));
		if (still.length === 0) {
			say(
				`Firewall: the web containers (${subnet}) can reach this box\u2019s services again ` +
					`(added port${missing.length === 1 ? '' : 's'} ${missing.join(', ')}).`
			);
		} else {
			warnFn(
				`Firewall: could not confirm the web containers (${subnet}) may reach port(s) ${still.join(', ')}; ` +
					`the site's /v1 calls will hang. Run: ${still
						.map((p) => `sudo ufw allow from ${subnet} to any port ${p} proto tcp`)
						.join(' && ')}`
			);
		}
	} catch {
		/* best-effort — never fail the self-heal phase over this */
	}
}

/** v1.16.10 — SELF-HEAL: expose this box's Kubo gateway over Tor/I2P so it is a
 *  federation seeder, automatically, on upgrade (the maintainer's mandate: every instance a
 *  hidden seeder, zero manual steps). Safe because Gateway.NoFetch=true means the
 *  gateway serves ONLY the release CIDs this node has pinned — never an arbitrary
 *  CID, so it is not an open proxy. Trap-everything + verified against the running
 *  daemon; a box without IPFS hosting no-ops. */
export async function healIpfsGatewayExposure(): Promise<void> {
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
	// Asynchronous, so the spinner below keeps turning (each can take 20 s).
	const ipfs = async (args: string[]): Promise<{ ok: boolean; out: string }> => {
		const asUser = process.getuid?.() === 0;
		const cmd = asUser ? 'sudo' : 'env';
		const pre = asUser
			? ['-u', USER, 'env', `IPFS_PATH=${repo}`, 'ipfs']
			: [`IPFS_PATH=${repo}`, 'ipfs'];
		const r = await runAsync(cmd, [...pre, ...args], { timeoutMs: 20000 });
		return { ok: r.status === 0, out: r.output.trim() };
	};

	// Already exposed + safe? Then skip the restart (steady state).
	const { curGw, curNoFetch } = await withSpinner(
		'Checking the IPFS gateway settings…',
		async () => ({
			curGw: await ipfs(['config', 'Addresses.Gateway']),
			curNoFetch: await ipfs(['config', 'Gateway.NoFetch'])
		})
	);
	const alreadyExposed = curGw.ok && curGw.out.includes('0.0.0.0');
	const alreadyNoFetch = curNoFetch.ok && /true/i.test(curNoFetch.out);
	if (alreadyExposed && alreadyNoFetch) return;

	let changed = false;
	// NoFetch FIRST (so we never briefly expose an open proxy), then the bind.
	await withSpinner('Setting the IPFS gateway to serve only pinned releases…', async () => {
		if (!alreadyNoFetch && (await ipfs(['config', '--json', 'Gateway.NoFetch', 'true'])).ok)
			changed = true;
		if (!alreadyExposed && (await ipfs(['config', 'Addresses.Gateway', EXPOSE_ADDR])).ok)
			changed = true;
	});
	if (!changed) {
		warn(
			'IPFS: gateway exposure could not be set (config unavailable) — will apply on the next installer run.'
		);
		return;
	}
	info(
		'IPFS: exposing the release gateway over this box\u2019s .onion/.i2p (NoFetch: serves only pinned releases).'
	);

	// Restart Kubo so the new bind takes effect, and make sure the IPNS
	// rebroadcaster (anti-stale) is running — fallback across unit names.
	const restarted = await withSpinner('Restarting IPFS with the new gateway setting…', async () => {
		let ok = false;
		for (const u of ['ipfs.service', 'kubo.service', 'ipfs']) {
			if ((await runAsync('systemctl', ['restart', u], { timeoutMs: 40000 })).status === 0) {
				ok = true;
				break;
			}
		}
		await runAsync('systemctl', ['enable', '--now', 'morphit-ipns-rebroadcast.service'], {
			timeoutMs: 20000
		});
		return ok;
	});
	if (!restarted) {
		info('IPFS: gateway configured; restart the ipfs service to apply (systemctl restart ipfs).');
		return;
	}

	// VERIFY against the running daemon: the gateway must answer on the bridge.
	try {
		const probe = await withSpinner('Checking the IPFS gateway is listening…', async () => {
			await sleepMs(4_000);
			return runAsync(
				'curl',
				[
					'-s',
					'-o',
					'/dev/null',
					'-w',
					'%{http_code}',
					'--max-time',
					'6',
					'http://127.0.0.1:8082/'
				],
				{ timeoutMs: 10000 }
			);
		});
		const code = probe.stdout.trim();
		// A host-side 127.0.0.1 probe only proves the gateway is LISTENING \u2014 NOT
		// that a container or a Tor/I2P peer can reach it (the v1.17.1 false-\u2713 was
		// exactly this: it passed for weeks while UFW dropped the container\u2192host
		// connect). The real peer path (frontend \u2192 gateway) is confirmed by the
		// firewall heal + the seeder's per-transport self-verify, so claim only
		// what THIS probe shows (review B9).
		info(
			/^[0-9]{3}$/.test(code)
				? 'IPFS: gateway is listening on the host bridge (:8082). Whether peers can reach it over Tor/I2P is confirmed by the gateway-firewall heal + the seeder self-verify later in this upgrade.'
				: 'IPFS: gateway restart done; it should begin listening shortly (the seeder self-verify later checks the real Tor/I2P peer path).'
		);
	} catch {
		/* verification is best-effort */
	}
}

/** Parse an nginx/BunkerWeb size string ("1m", "512k", "64k", "1024") to bytes,
 *  or null if unparseable. */
/** PURE. curl's `--resolve` value that sends a request for `origin` to this
 *  server's own port (127.0.0.1), or null when the origin is not an https
 *  name this server answers on the clearnet edge (a hidden address, an IP). */
export function bodyProbeResolve(origin: string): string | null {
	let u: URL;
	try {
		u = new URL(origin);
	} catch {
		return null;
	}
	const host = u.hostname;
	if (u.protocol !== 'https:' || host === '' || /\.(onion|i2p)$/i.test(host)) return null;
	if (/^[0-9.]+$/.test(host) || host.includes(':')) return null;
	return `${host}:${u.port || '443'}:127.0.0.1`;
}

/** PURE. Where the body-limit probe asks, in order (a `--resolve` value, or
 *  null for the address itself): BunkerWeb on this server — not public DNS: a
 *  box often cannot reach its own public address, and the answer must be this
 *  server's — at the address's own port, then at 443 (where the exemption check
 *  asks), then the address itself (a BunkerWeb published on one host address
 *  only does not answer on 127.0.0.1) — but never that last one on a
 *  hidden-only node. Null for a Tor/I2P address: it cannot be asked from here
 *  without Tor, so there is no check and nothing to report. */
export function bodyProbeCandidates(
	origin: string,
	hiddenOnly = false
): Array<{ readonly url: string; readonly resolve: string | null }> | null {
	let u: URL;
	try {
		u = new URL(origin);
	} catch {
		return null;
	}
	if (/\.(onion|i2p|loki)\.?$/i.test(u.hostname)) return null;
	const target = (port: string): string =>
		`${u.protocol}//${u.hostname}${port ? `:${port}` : ''}/v1/broadcast`;
	const out: Array<{ url: string; resolve: string | null }> = [];
	const first = bodyProbeResolve(origin);
	if (first !== null) {
		out.push({ url: target(u.port), resolve: first });
		// 443 on this server, asked at the address WITHOUT its port (a --resolve
		// entry only applies to the port the URL names).
		if (u.port !== '' && u.port !== '443')
			out.push({ url: target(''), resolve: `${u.hostname}:443:127.0.0.1` });
	}
	// The address itself goes through public DNS (and may leave this server):
	// never on a hidden-only node.
	if (!hiddenOnly) out.push({ url: target(u.port), resolve: null });
	return out;
}

/** One ~50 KB POST to /v1/broadcast through curl: its HTTP status, '' or
 *  '000' when nothing answered. A `resolve` candidate is THIS server: curl is
 *  told to skip any proxy from the environment (https_proxy, ALL_PROXY), which
 *  would make it ignore --resolve and ask somewhere else. */
export function probeBroadcastBodyVia(c: { url: string; resolve: string | null }): string {
	// ~50 KB: under the relay's 64 KB cap, far above a real avatar broadcast.
	const blob = 'A'.repeat(50 * 1024);
	const r = spawnSync(
		'curl',
		[
			'-s',
			...(c.resolve !== null ? ['-k', '--noproxy', '*', '--resolve', c.resolve] : []),
			'-o',
			'/dev/null',
			'-w',
			'%{http_code}',
			'--max-time',
			'12',
			'-X',
			'POST',
			c.url,
			'-H',
			'content-type: application/json',
			'--data',
			`{"probe":"${blob}"}`
		],
		{ encoding: 'utf8', timeout: 20000 }
	);
	return (r.stdout ?? '').trim();
}

/** The body-limit probe over `candidates` in order (bodyProbeCandidates): the
 *  first real answer. Exported for its test. */
export function probeBroadcastBody(
	candidates: ReadonlyArray<{ readonly url: string; readonly resolve: string | null }>
): string {
	let code = '';
	for (const c of candidates) {
		code = probeBroadcastBodyVia(c);
		if (code !== '' && code !== '000') break;
	}
	return code;
}

function parseNginxSize(s: string): number | null {
	const m = /^(\d+)\s*([kmg]?)$/i.exec(s.trim());
	if (!m) return null;
	const mult: Record<string, number> = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
	const factor = mult[(m[2] ?? '').toLowerCase()];
	if (factor === undefined) return null;
	return Number(m[1]) * factor;
}

/** Classify a curl `%{http_code}` from the /v1/broadcast body-limit probe. PURE
 *  (review B9). Only a real HTTP answer is conclusive: 413 = still too large;
 *  any other 2xx/4xx = the body fits; `000`/empty (connect failure, e.g. a box
 *  whose clearnet is filtered upstream) or a 5xx edge error = we could NOT check,
 *  so the caller must NOT report "OK". */
export function classifyBroadcastProbe(code: string): 'fits' | 'too-large' | 'unreachable' {
	const c = (code ?? '').trim();
	if (c === '413') return 'too-large';
	if (/^[0-9]{3}$/.test(c) && c !== '000' && !c.startsWith('5')) return 'fits';
	return 'unreachable';
}

/** The install's apps/web/build for the binary that is running (the self-heal
 *  child runs <install>/apps/ops-cli/dist/…), so the frontend container can be
 *  told apart from BunkerWeb by its mount. */
function runningInstallBuildDir(): string {
	const root = /^(.*)\/apps\/ops-cli\/dist\//.exec(process.argv[1] ?? '')?.[1] ?? '/opt/morphit';
	return join(root, 'apps', 'web', 'build');
}

const BUNKERWEB_IMAGE = /(^|\/)bunkerity\/bunkerweb(?=$|[:@])/;

/** BunkerWeb's own containers on this server (wave 5, B-from-C §4). Found the
 *  way the web-proxy heal finds them (lib/proxyConfigHeal.ts): the edge by IMAGE
 *  bunkerity/bunkerweb, tie-broken by host port 443; schedulers by image, and
 *  only those in the edge's Compose project. NEVER by name: on morphit.io every
 *  container is called bunkerweb-<service>-1 (frontend, onion service,
 *  crowdsec, db…), and the old name match picked the frontend. */
export interface BunkerWebStack {
	readonly edge: ContainerInfo;
	/** The edge's Compose project (all files, env files, directory), or null
	 *  when it was not started by Docker Compose. */
	readonly ref: ComposeRef | null;
	/** The Compose services to reload/recreate: the edge's and its scheduler's —
	 *  never the whole stack (a plain `up` can recreate the database). */
	readonly services: readonly string[];
	/** The scheduler to drop config files into, when there is exactly one. */
	readonly scheduler: ContainerInfo | null;
}

export function findBunkerWebStack(buildDir: string): {
	stack: BunkerWebStack | null;
	note: string | null;
} {
	const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], {
		encoding: 'utf8',
		timeout: 8000
	});
	if (ps.error || ps.status !== 0) return { stack: null, note: null };
	const names = (ps.stdout ?? '')
		.split('\n')
		.map((x) => x.trim())
		.filter(Boolean);
	if (names.length === 0) return { stack: null, note: null };
	const insp = spawnSync('docker', ['inspect', ...names], {
		encoding: 'utf8',
		timeout: 15000,
		maxBuffer: 64 * 1024 * 1024
	});
	const list = parseDockerInspect(insp.stdout || '[]');
	const id = identifyContainers(list, buildDir);
	const edge = id.edge;
	if (edge === null) {
		const bws = list.filter((c) => c.running && BUNKERWEB_IMAGE.test(c.image)).map((c) => c.name);
		return {
			stack: null,
			note:
				bws.length > 1
					? `WAF: found several BunkerWeb containers on this server (${bws.join(', ')}) and could not tell which one is the public one, so the WAF settings were left alone.`
					: null
		};
	}
	const ref = composeRefOf(edge);
	const sameProject = (c: ContainerInfo): ComposeRef | null => {
		const r = composeRefOf(c);
		return r !== null &&
			ref !== null &&
			r.project === ref.project &&
			r.files.join(',') === ref.files.join(',')
			? r
			: null;
	};
	const schedulers =
		ref !== null ? id.schedulers.filter((s) => sameProject(s) !== null) : id.schedulers;
	return {
		stack: {
			edge,
			ref,
			services:
				ref !== null
					? [...new Set([ref.service, ...schedulers.map((s) => sameProject(s)!.service)])]
					: [],
			scheduler: schedulers.length === 1 ? schedulers[0]! : null
		},
		note: null
	};
}

/** The settings file BunkerWeb's edge reads, as Docker Compose declares it
 *  (`env_file`). When this Compose is too old to show it, `fallback` counts only
 *  if it sits in the edge's own Compose directory. null (with a calm note) when
 *  it cannot be told — then the WAF settings are left alone. */
function bunkerWebEnvFile(
	stack: BunkerWebStack,
	fallback: string
): { path: string | null; note: string | null } {
	const ref = stack.ref;
	if (ref === null)
		return existsSync(fallback)
			? { path: fallback, note: null }
			: {
					path: null,
					note: `WAF: ${stack.edge.name} was not started by Docker Compose and ${fallback} does not exist, so the WAF settings were left alone.`
				};
	const r = spawnSync(
		'docker',
		composeArgs(ref, ['config', '--format', 'json', '--no-env-resolution']),
		{
			encoding: 'utf8',
			timeout: 30000,
			maxBuffer: 64 * 1024 * 1024
		}
	);
	const model = r.status === 0 && (r.stdout ?? '') !== '' ? parseComposeModel(r.stdout) : null;
	const ef = model?.get(ref.service)?.envFiles ?? null;
	if (ef !== null && ef.length > 0) {
		const named = ef.filter((p) => /(^|\/)bunkerweb\.env$/.test(p));
		const path = named.length === 1 ? named[0]! : ef.length === 1 ? ef[0]! : null;
		return path !== null
			? { path, note: null }
			: {
					path: null,
					note: `WAF: BunkerWeb reads several settings files (${ef.join(', ')}), so the WAF settings were left alone.`
				};
	}
	const dirs = new Set([ref.workDir, ...ref.files.map((f) => dirname(f))].filter(Boolean));
	if (existsSync(fallback) && dirs.has(dirname(fallback))) return { path: fallback, note: null };
	return {
		path: null,
		note:
			ef === null
				? `WAF: could not tell which settings file BunkerWeb reads (Docker Compose did not say), so the WAF settings were left alone.`
				: `WAF: BunkerWeb's settings are not in a file Docker Compose reads for it, so the WAF settings were left alone.`
	};
}

/** `docker compose … <args>` for exactly this project, then the old
 *  `docker-compose` binary with the same arguments. true on the first success. */
function composeRun(ref: ComposeRef, args: readonly string[], timeout: number): boolean {
	const a = composeArgs(ref, args);
	for (const [cmd, argv] of [
		['docker', a],
		['docker-compose', a.slice(1)]
	] as Array<[string, string[]]>) {
		try {
			if (spawnSync(cmd, argv, { encoding: 'utf8', timeout }).status === 0) return true;
		} catch {
			/* try the next binary */
		}
	}
	return false;
}

/** When the www heal must be done (ms since the epoch): the background web
 *  heal's time limit after its start, less a minute; or the self-heal child's,
 *  counted from the process's start, less 25 s. PURE; exported for its test. */
export function wwwHealDeadline(o: {
	readonly background: boolean;
	readonly startedAtMs: number;
	readonly nowMs: number;
	readonly uptimeS: number;
}): number {
	return o.background
		? o.startedAtMs + WEB_HEAL_MAX_S * 1000 - 60_000
		: o.nowMs - o.uptimeS * 1000 + SELF_HEAL_CHILD_TIMEOUT_MS - 25_000;
}

/** The www heal (lib/bunkerwebWww.ts) on this server's BunkerWeb, finished by
 *  `deadline` (ms since the epoch: the end of the run that hosts it). Exported
 *  for its wiring test. */
export async function healBunkerWebWwwNow(
	buildDir = installBuildDir(),
	opts: { readonly deadline?: number; readonly background?: boolean } = {}
): Promise<HealResult | null> {
	let stack: BunkerWebStack | null = null;
	try {
		stack = findBunkerWebStack(buildDir).stack;
	} catch {
		stack = null;
	}
	const deadline = opts.deadline ?? Date.now() + 30 * 60_000;
	// No BunkerWeb running: the WAF heal before this one has said so, and the
	// heal skips without a word (its settings file is "none").
	const rt =
		stack !== null
			? realWwwRuntime(stack, buildDir, deadline, opts.background ?? true)
			: {
					...realWwwRuntime(
						{
							edge: { name: '' },
							ref: null,
							services: [],
							scheduler: null
						} as unknown as BunkerWebStack,
						buildDir,
						deadline,
						opts.background ?? true
					),
					envFile: () => ({ path: null, note: null })
				};
	const r = healBunkerWebWww({ info, warn, spinner: (l) => startDotsSpinner(l) }, rt);
	await reportHeal(r);
	return r.catch(() => null);
}

/** The box as the www heal sees it. Exported for its test
 *  (test/bunkerwebWwwRuntime.test.ts) and the end-to-end run against real
 *  certbot, nginx and an ACME server recorded in the audit. */
export function realWwwRuntime(
	stack: BunkerWebStack,
	buildDir: string,
	deadline: number,
	background = true
): WwwRuntime {
	const sched = stack.scheduler?.name ?? null;
	const ref = stack.ref;
	const sh = (cmd: string, args: readonly string[], timeout = 30_000) => {
		try {
			const r = spawnSync(cmd, args as string[], {
				encoding: 'utf8',
				timeout,
				maxBuffer: 16 * 1024 * 1024
			});
			return {
				ok: r.status === 0,
				status: r.status ?? -1,
				out: r.stdout ?? '',
				err: r.stderr ?? ''
			};
		} catch {
			return { ok: false, status: -1, out: '', err: '' };
		}
	};
	// Every connection to this server, with the name (Host, SNI) kept. A proxy
	// in the environment would make curl ask somewhere else.
	const curlBase = ['--noproxy', '*', '--connect-to', '::127.0.0.1:', '--max-time', '15'];
	// The scheduler's reason when the last apply was refused.
	let refusal: string | null = null;
	/** WWW_DB_PY inside the scheduler; its JSON answer, or null. */
	const wwwDb = (env: Record<string, string>): Record<string, unknown> | null => {
		if (sched === null) return null;
		const args = ['exec', '-i'];
		for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
		const r = sh('docker', [...args, sched, 'python3', '-c', WWW_DB_PY], 30_000);
		if (!r.ok) return null;
		try {
			return JSON.parse(r.out.trim()) as Record<string, unknown>;
		} catch {
			return null;
		}
	};
	const readText = (p: string): string | null => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	};
	return {
		hiddenOnly: () => isHiddenOnlyNode(),
		envFile: () => ({
			path: bunkerWebEnvFile(stack, '/etc/bunkerweb/bunkerweb.env').path,
			note: null
		}),
		readFile: readText,
		writeFile: (p, text, mode = 0o644) => {
			try {
				mkdirSync(dirname(p), { recursive: true });
				// In place: an existing file keeps its owner and mode.
				writeFileSync(p, text, { encoding: 'utf8', mode });
				return true;
			} catch {
				return false;
			}
		},
		removeFile: (p) => {
			try {
				rmSync(p, { force: true });
			} catch {
				/* a stray probe file is harmless */
			}
		},
		backup: (p, text) => {
			const copy = `${p}.bak-${Date.now()}`;
			try {
				writeFileSync(copy, text, { encoding: 'utf8', mode: 0o600 });
				return copy;
			} catch {
				return null;
			}
		},
		composeAccepts: () =>
			ref === null || sh('docker', composeArgs(ref, ['config', '-q']), 60_000).ok,
		// systemd-resolved's own upstream servers when it runs (its stub would
		// also answer from /etc/hosts); else the system's resolvers.
		lookup: (name) =>
			dnsLookup(name, upstreamResolvers(readText('/run/systemd/resolve/resolv.conf')) ?? undefined),
		liveEnv: () => {
			if (!stack.edge.name) return null;
			const r = sh(
				'docker',
				['inspect', stack.edge.name, '--format', '{{json .Config.Env}}'],
				15_000
			);
			if (!r.ok) return null;
			try {
				const list = JSON.parse(r.out) as string[];
				const m = new Map<string, string>();
				for (const kv of list) {
					const i = kv.indexOf('=');
					if (i > 0) m.set(kv.slice(0, i), kv.slice(i + 1));
				}
				return m;
			} catch {
				return null;
			}
		},
		apply: (why, recreate): ApplyResult => {
			const wait = applyWaitMs(deadline - Date.now());
			if (wait === null) return 'no-time';
			// A recreate only through Compose: a plain `docker restart` keeps a
			// container's old environment, so it would load nothing.
			if (recreate && ref === null) return 'not-restarted';
			if (!recreate && sched === null) return 'not-restarted';
			const since = new Date(Date.now() - 2_000).toISOString();
			const stop = startDotsSpinner('Restarting BunkerWeb’s services…');
			let started: boolean;
			try {
				started = recreate
					? composeRun(
							ref!,
							['up', '-d', '--no-deps', '--force-recreate', ...stack.services],
							180_000
						)
					: sh('docker', ['restart', sched!], 60_000).ok;
			} finally {
				stop();
			}
			if (!started) return 'not-restarted';
			if (sched === null) return 'pending';
			info(`www: ${why}; BunkerWeb is rebuilding its settings…`);
			const spin = startPausableSpinner('Waiting for BunkerWeb to load its new settings…');
			let c: ReturnType<typeof waitForSchedulerCycle>;
			try {
				c = waitForSchedulerCycle({
					scheduler: sched,
					edge: stack.edge.name,
					sinceIso: since,
					budgetMs: wait,
					note: (m) => spin.say(() => info(`www: ${m}`))
				});
			} finally {
				spin.stop();
			}
			refusal = c.kind === 'refused' ? c.reason : null;
			return c.kind === 'loaded' ? 'loaded' : c.kind === 'refused' ? 'refused' : 'pending';
		},
		writeSchedulerConf: (name, conf) => {
			if (sched === null) return 'failed';
			const r = sh('docker', [
				'exec',
				'-e',
				`MORPHIT_CONF=${conf}`,
				sched,
				'sh',
				'-c',
				`for d in /data/configs /etc/bunkerweb/configs; do [ -d "$d" ] || continue; f="$d/server-http/${name}.conf"; [ "$(cat "$f" 2>/dev/null)" = "$MORPHIT_CONF" ] && { echo unchanged; exit 0; }; mkdir -p "$d/server-http" && printf '%s\\n' "$MORPHIT_CONF" > "$f" && { echo written; exit 0; }; exit 1; done; exit 1`
			]);
			return !r.ok ? 'failed' : r.out.trim() === 'unchanged' ? 'unchanged' : 'written';
		},
		request: (url, o = {}) => {
			const r = sh('curl', [
				'-s',
				...(o.verify ? [] : ['-k']),
				...curlBase,
				'-o',
				'/dev/null',
				...(o.headers ? ['-D', '-'] : []),
				'-w',
				'\n%{http_code}\n%{redirect_url}',
				url
			]);
			const lines = r.out.split('\n');
			const location = (lines.pop() ?? '').trim();
			const code = (lines.pop() ?? '').trim();
			// No answer, or a certificate check that failed (curl 35/51/58/60): '000'.
			return {
				code: r.ok ? code : '000',
				location,
				headers: lines.join('\n'),
				exit: r.status
			};
		},
		fetchFollow: (url) => {
			const r = sh('curl', ['-skL', ...curlBase, url]);
			return r.ok ? r.out : null;
		},
		certNames: (name) => {
			try {
				const pem = readFileSync(`/etc/letsencrypt/live/${name}/cert.pem`, 'utf8');
				const san = new X509Certificate(pem).subjectAltName ?? '';
				return [...san.matchAll(/DNS:([^,\s]+)/g)].map((m) => m[1]!.toLowerCase());
			} catch {
				return null;
			}
		},
		certbotPresent: () => sh('certbot', ['--version']).ok,
		certbot: (args) => {
			const r = sh('certbot', args, 300_000);
			return { ok: r.ok, out: `${r.out}${r.err}` };
		},
		certPermissions: () => {
			sh('chgrp', ['-R', '101', '/etc/letsencrypt/live', '/etc/letsencrypt/archive']);
			sh('chmod', ['-R', 'g+rX', '/etc/letsencrypt/live', '/etc/letsencrypt/archive']);
		},
		buildDir: () => buildDir,
		timeLeftMs: () => deadline - Date.now(),
		inBackground: () => background,
		composeManaged: () => ref !== null,
		edgeSettingsSource: () => {
			if (ref === null) return null;
			const envPath = bunkerWebEnvFile(stack, '/etc/bunkerweb/bunkerweb.env').path;
			const r = sh(
				'docker',
				composeArgs(ref, ['config', '--format', 'json', '--no-env-resolution']),
				30_000
			);
			const svc = r.ok ? parseComposeModel(r.out)?.get(ref.service) : undefined;
			if (!svc || svc.envFiles === null) return null;
			return {
				readsFile: envPath !== null && svc.envFiles.includes(envPath),
				overrides: [...svc.environment.keys()],
				values: svc.environment
			};
		},
		nginxConfig: () => {
			if (!stack.edge.name) return null;
			const stop = startDotsSpinner('Reading the nginx config BunkerWeb really runs…');
			let r: ReturnType<typeof sh>;
			try {
				r = sh('docker', ['exec', stack.edge.name, 'sh', '-c', 'nginx -T 2>/dev/null'], 20_000);
			} finally {
				stop();
			}
			return r.ok && /\bserver\s*\{/.test(r.out) ? r.out : null;
		},
		siteList: () => {
			const j = wwwDb({ MODE: 'list' });
			if (j === null || !['sqlite', 'other', 'missing'].includes(String(j.db))) return null;
			const ids = Array.isArray(j.ids)
				? j.ids.filter((x): x is string => typeof x === 'string')
				: [];
			return { db: j.db as SiteList['db'], ids };
		},
		addSiteNames: (add, first) => {
			const j = wwwDb({ MODE: 'add', ADD: add.join(' '), FIRST: first });
			return j !== null && j.added === add.length && typeof j.backup === 'string'
				? { backup: j.backup }
				: null;
		},
		removeRuleCopy: () => {
			const j = wwwDb({ MODE: 'unrule', NAME: WWW_RULE_FILE });
			return j !== null && (Number(j.rows) > 0 || Number(j.moved) > 0);
		},
		lastRefusal: () => refusal,
		recreateCommand: () =>
			ref !== null
				? `sudo ${composeCommand(ref, ['up', '-d', '--no-deps', '--force-recreate', ...stack.services])}`
				: null,
		containerNames: () => ({ edge: stack.edge.name, scheduler: sched })
	};
}

/** BunkerWeb's catch-all request limit (LIMIT_REQ_URL, default `/` at 2r/s,
 *  counted per visitor and per file) narrowed to the addresses that reach a
 *  server process: a first visit fetches the same script file three times
 *  within a second (page, offline cache, tamper check) and the third got a
 *  429 (vigilante.trading, v1.21.8). The same value is in bunkerweb.env.j2 and
 *  bunkerweb.env.example (bunkerweb-smoke checks all three agree). */
export const BW_LIMIT_REQ_URL = '^/(?:ipfs|ipns|rss)/|^/mcp';
export const BW_LIMIT_REQ_RATE = '2r/s';
/** Downloads at once per visitor over HTTP/2: a browser keeps up to 128 going
 *  on one connection (nginx's default), BunkerWeb allowed 100. */
export const BW_LIMIT_CONN_MAX_HTTP2 = '256';

/** v1.16.9 — SELF-HEAL the BunkerWeb WAF so the /v1/ + /relay/ JSON APIs work.
 *  The maintainer's mandate: trap every condition, try each fix more than one way, VERIFY it
 *  took against the RUNNING container, fall through, never throw. Fixes three
 *  live-box-confirmed failure modes that 4xx a legitimate avatar/order broadcast:
 *    A. MAX_CLIENT_SIZE too small  → 413 on the ~8 KB avatar broadcast.
 *    B. bad-behavior counts routine API 400s → bans the client IP → 403 on all.
 *    C. ModSecurity CRS flags the base64 avatar payload → 403.
 *  Best-effort + idempotent: a non-BunkerWeb deploy just no-ops; a steady-state
 *  box where everything is already applied skips the reload.
 *
 *  D. USE_REAL_IP=yes + REAL_IP_FROM=0.0.0.0/0 made the
 *     public edge believe every visitor's X-Forwarded-For, so anyone could pick
 *     their own address per request (past BunkerWeb's bans and the relay's per-IP
 *     signup limits). Templates aren't re-rendered on upgrade, so turn it off here.
 *
 *  E. BunkerWeb's default request limit (2 per second per visitor and file,
 *     on every address) answered 429 to a browser's own first visit, and its
 *     100 downloads at once to a slow one (vigilante.trading, v1.21.8). Set where the operator
 *     left BunkerWeb's default; an operator's own value is kept.
 *
 *  Wave 5 (B-from-C §4): BunkerWeb is found by IMAGE (findBunkerWebStack), its
 *  settings file is the one Docker Compose says it reads, and reloads touch only
 *  BunkerWeb's own services (`up -d --no-deps <edge> <scheduler>`) — never a
 *  whole-stack `up`, never another container. Can't tell which container or
 *  file → change nothing and say so calmly.
 *  `bwEnv` (used only when Compose can't say) and `buildDir` are parameters so
 *  the tests can run this against a temp dir. */
export async function healBunkerWebWaf(
	bwEnv = '/etc/bunkerweb/bunkerweb.env',
	buildDir = runningInstallBuildDir(),
	opts: { readonly reloadBudgetMs?: number } = {}
): Promise<void> {
	wafPassed = [];
	try {
		await healBunkerWebWafSteps(bwEnv, buildDir, opts);
	} finally {
		// What was checked live and passed, in one plain line (v1.21.17 audit,
		// L1); each check's own detail is a "  · " line, kept in the background
		// heal's log, not relayed into the upgrade's output.
		if (wafPassed.length > 0)
			info(`✓ Web firewall (BunkerWeb), checked on this server: ${wafPassed.join(', ')}.`);
		wafPassed = [];
	}
}

/** The live WAF checks that passed in this run (see healBunkerWebWaf). */
let wafPassed: string[] = [];

/** A live WAF check passed: a few words for the ✓ line, and its detail as a
 *  "  · " line — printed where it is read in full (the background heal's
 *  log, a direct run), not inside an upgrade, whose summary line says it. */
function wafOk(short: string, detail: string): void {
	wafPassed.push(short);
	if (process.env.MORPHIT_UPGRADE_SUMMARIZES !== '1') info(`  · ${detail}`);
}

async function healBunkerWebWafSteps(
	bwEnv: string,
	buildDir: string,
	opts: { readonly reloadBudgetMs?: number }
): Promise<void> {
	let found: ReturnType<typeof findBunkerWebStack>;
	try {
		found = findBunkerWebStack(buildDir);
	} catch {
		return;
	}
	if (found.note !== null) info(found.note);
	const stack = found.stack;
	if (stack === null) {
		// Not a BunkerWeb deployment, or BunkerWeb isn't running right now.
		if (found.note === null && existsSync(bwEnv))
			info(
				'WAF: BunkerWeb is not running on this server, so its settings were left as they are; the next `morphit-ops upgrade` checks them again.'
			);
		return;
	}
	const envFile = bunkerWebEnvFile(stack, bwEnv);
	if (envFile.note !== null) info(envFile.note);
	if (envFile.path === null) return;
	bwEnv = envFile.path;

	const bw = stack.edge.name;
	const sched = stack.scheduler?.name ?? null;
	const ref = stack.ref;
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

	/** A value without the quotes an env file may put round it. */
	const unq = (v: string | null): string =>
		(v ?? '')
			.trim()
			.replace(/^["']|["']$/g, '')
			.trim();

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

	// ── Fix B: bad-behavior must NOT ban real visitors for routine answers. ──
	//    Morphit counts only 401 405 444 (bunkerweb.env.j2 / .example, README):
	//    400 is a rejected broadcast, 403 is BunkerWeb's answer to a banned
	//    visitor (counting it never ends a ban), 404 is "no chat key / no profile
	//    yet" and PWA probing, 429 is a normal burst. Where BunkerWeb's default is
	//    in force (no line, or its own list), or the list this heal wrote before
	//    v1.21.12 (the default less 400), it becomes Morphit's; an operator's own
	//    list only loses 400. BunkerWeb's default counting window bans for a day
	//    after 10 counted answers a minute; Morphit's is 50 a minute, an hour.
	try {
		const cur = getVal('BAD_BEHAVIOR_STATUS_CODES');
		const norm = (v: string): string => unq(v).trim().split(/\s+/).join(' ');
		const joined =
			cur === null ||
			norm(cur) === BW_DEFAULT_BAD_BEHAVIOR_CODES ||
			norm(cur) === BW_DEFAULT_BAD_BEHAVIOR_CODES.replace(/^400 /, '')
				? MORPHIT_BAD_BEHAVIOR_CODES
				: norm(cur)
						.split(' ')
						.filter((c) => c !== '400')
						.join(' ');
		if (cur === null || norm(cur) !== joined) {
			setVal('BAD_BEHAVIOR_STATUS_CODES', joined);
			info(
				`WAF: bad-behavior bans now count only ${joined} (a "not found", a refused broadcast, a ban page or a short burst is ordinary use and must not ban a visitor).`
			);
		}
		for (const [k, v] of [
			['BAD_BEHAVIOR_THRESHOLD', '50'],
			['BAD_BEHAVIOR_COUNT_TIME', '60'],
			['BAD_BEHAVIOR_BAN_TIME', '3600']
		] as const) {
			if (getVal(k) === null) {
				setVal(k, v);
				info(
					`WAF: ${k}=${v} (BunkerWeb's default banned a visitor for a day after 10 counted answers in a minute).`
				);
			}
		}
	} catch {
		/* keep going */
	}

	// ── Fix C: the ModSec exemption, as the setting BunkerWeb documents. ONE copy
	//    only: v1.16.9–v1.20.0 also wrote it as a file, which BunkerWeb 1.5 imports
	//    as a second custom config; with both loaded nginx refuses every new config
	//    ("Rule id: 1990001 is duplicated") and BunkerWeb silently keeps the last one
	//    that worked (morphitir, 2026-09-30: frozen since Sep 7). The extra copies
	//    are removed below (lib/bunkerwebRuleDedupe.ts). ──
	try {
		// Also replaces the rule earlier releases shipped: it turned ModSecurity's
		// rules off for the APIs; this one also says, belt and braces, that the
		// audit log and request-body reading are off for them, whatever version
		// of ModSecurity BunkerWeb runs.
		const fix = modsecRuleFix(getVal('CUSTOM_CONF_MODSEC_morphit_json_api_off'));
		if (fix !== null) {
			setVal('CUSTOM_CONF_MODSEC_morphit_json_api_off', fix);
			info('WAF: the JSON APIs get no ModSecurity rules, audit log or body inspection.');
		}
	} catch {
		/* keep going */
	}

	// ── Fix D: BunkerWeb is the public edge — it must not believe a visitor's
	//    X-Forwarded-For. Turn USE_REAL_IP off when it trusts that header from
	//    everyone (a /0 entry) or from BunkerWeb's default private ranges (unset
	//    REAL_IP_FROM), which include the Docker bridge IPv6 visitors arrive from.
	//    A deliberate CDN setup (REAL_IP_FROM listing that CDN's ranges) is left
	//    alone. ──
	try {
		if (unq(getVal('USE_REAL_IP')).toLowerCase() === 'yes') {
			const from = unq(getVal('REAL_IP_FROM'));
			const wide =
				from === '' ||
				from.split(/\s+/).some((e) => /\/0$/.test(e) || e === '0.0.0.0' || e === '::');
			if (wide) {
				setVal('USE_REAL_IP', 'no');
				info(
					"WAF: set USE_REAL_IP=no. BunkerWeb is the public edge, so it now uses each visitor's real address instead of one they could type in."
				);
			}
		}
	} catch {
		/* keep going */
	}

	// ── Fix E: the site's own files must not hit BunkerWeb's request limit.
	//    BunkerWeb's default rule (every address, 2 per second per visitor and
	//    file) is narrowed to the addresses a server process answers; where the
	//    operator set their own rule or rate it is kept. Same for the number of
	//    downloads at once over HTTP/2 when BunkerWeb's default is in force. ──
	try {
		if (unq(getVal('USE_LIMIT_REQ')).toLowerCase() !== 'no') {
			const url = unq(getVal('LIMIT_REQ_URL'));
			const rate = unq(getVal('LIMIT_REQ_RATE'));
			if ((url === '' || url === '/') && (rate === '' || rate === '2r/s')) {
				setVal('LIMIT_REQ_URL', BW_LIMIT_REQ_URL);
				setVal('LIMIT_REQ_RATE', BW_LIMIT_REQ_RATE);
				info(
					"WAF: the site's own files no longer count toward BunkerWeb's request limit (a first visit fetches some files three times in a second); IPFS, RSS and MCP keep it."
				);
			}
		}
		if (
			unq(getVal('USE_LIMIT_CONN')).toLowerCase() !== 'no' &&
			unq(getVal('LIMIT_CONN_MAX_HTTP2')) === ''
		) {
			setVal('LIMIT_CONN_MAX_HTTP2', BW_LIMIT_CONN_MAX_HTTP2);
			info(
				`WAF: a visitor may now download ${BW_LIMIT_CONN_MAX_HTTP2} files at once over HTTP/2 (BunkerWeb's default of 100 turned away part of a first visit on a slow line).`
			);
		}
	} catch {
		/* keep going */
	}

	// ── Fix F: the indexer's and the relay's own answers reach the browser.
	//    BunkerWeb's default (REVERSE_PROXY_INTERCEPT_ERRORS=yes) replaces every
	//    4xx/5xx answer from the site with its own HTML error page, so the app
	//    lost the reason for every refusal: a 404 "no chat key yet" became
	//    "Malformed response from indexer (status 404)", a chain rejection's 400
	//    became "the chain rejected the transaction" (v1.21.12). BunkerWeb's
	//    own answers (WAF blocks, limits) keep its pages. ──
	//    Every copy of the line counts (Compose reads the last one), so all are
	//    made "no" and only one is kept.
	try {
		const lines = [...env.matchAll(/^REVERSE_PROXY_INTERCEPT_ERRORS=(.*)$/gm)];
		if (lines.length !== 1 || unq(lines[0]![1] ?? '').toLowerCase() !== 'no') {
			env = env.replace(/^REVERSE_PROXY_INTERCEPT_ERRORS=.*\n?/gm, '');
			setVal('REVERSE_PROXY_INTERCEPT_ERRORS', 'no');
			info(
				'WAF: BunkerWeb set to pass the site\'s own error answers through with their reason (it replaced them with its own page, so the app showed "Malformed response" or "the chain rejected the transaction" without saying why).'
			);
		}
	} catch {
		/* keep going */
	}

	const envChanged = changed;
	if (envChanged) {
		try {
			writeFileSync(bwEnv, env, 'utf8');
		} catch {
			/* couldn't write env — the reload below still applies what it can */
		}
	}

	// ── Extra copies of the exemption: keep exactly one (v1.20.1). ──
	let removed: RemovedCopies | null = null;
	if (sched !== null) {
		const copies = listRuleCopies(sched);
		if (copies !== null && copyCount(copies) > 1) {
			const plan = planRuleDedupe(copies);
			removed = removeRuleCopies(sched, plan);
			if (removed !== null && (removed.rows.length > 0 || removed.moved.length > 0)) {
				info(
					`WAF: removed ${removed.rows.length + removed.moved.length} extra copy(ies) of Morphit's API firewall exception (kept: ${plan.keep ?? 'the setting'}). A second copy makes BunkerWeb refuse every new config.`
				);
			} else {
				removed = null;
				warn(
					"WAF: found Morphit's API firewall exception more than once but could not remove the extra copy; BunkerWeb may keep refusing new settings until it is removed."
				);
			}
		}
	}

	// ── Apply. A setting change needs BunkerWeb's services RECREATED (a plain
	//    `docker restart` keeps a container's old environment); a removed copy
	//    only needs the scheduler to rebuild. Only BunkerWeb's own services, never
	//    the whole stack (a whole-stack `up` can recreate the database, wave 5). ──
	const reloadBudgetMs = opts.reloadBudgetMs ?? 8 * 60_000;
	const measured = sched !== null ? measuredSchedulerCycleMs(sched) : null;
	const applyAndWait = (why: string, recreate: boolean): SchedulerCycle | null => {
		if (sched === null) return null;
		const since = new Date(Date.now() - 2_000).toISOString();
		const strategies: Array<() => boolean> = recreate
			? [
					() =>
						ref !== null &&
						composeRun(
							ref,
							['up', '-d', '--no-deps', '--force-recreate', ...stack.services],
							180000
						),
					() =>
						spawnSync('docker', ['restart', sched], { encoding: 'utf8', timeout: 60000 }).status ===
						0
				]
			: [
					() =>
						spawnSync('docker', ['restart', sched], { encoding: 'utf8', timeout: 60000 }).status ===
						0,
					() =>
						ref !== null && composeRun(ref, ['up', '-d', '--no-deps', ...stack.services], 180000)
				];
		let started = false;
		// Synchronous docker/compose calls (up to minutes): the spinner's label is
		// on the line for them.
		const stopRestart = startDotsSpinner('Restarting BunkerWeb’s services…');
		try {
			for (const strat of strategies) {
				try {
					if (strat()) {
						started = true;
						break;
					}
				} catch {
					/* try the next strategy */
				}
			}
		} finally {
			stopRestart();
		}
		if (!started) {
			warn(
				ref !== null
					? `WAF: ${why}, but BunkerWeb could not be restarted automatically. To apply it, run on this server: sudo ${composeCommand(ref, ['up', '-d', '--no-deps', '--force-recreate', ...stack.services])}`
					: `WAF: ${why}, but BunkerWeb could not be restarted automatically. To apply it, run on this server: sudo docker restart ${sched}`
			);
			return null;
		}
		info(
			measured !== null && measured > 60_000
				? `WAF: ${why}; BunkerWeb is rebuilding its settings (about ${Math.round(measured / 60_000)} min here, its downloads are slow on this network)…`
				: `WAF: ${why}; BunkerWeb is rebuilding its settings…`
		);
		// Up to 8 minutes: the spinner is on the line, taken off for each note.
		const waitSpin = startPausableSpinner('Waiting for BunkerWeb to load its new settings…');
		let c: ReturnType<typeof waitForSchedulerCycle>;
		try {
			c = waitForSchedulerCycle({
				scheduler: sched,
				edge: bw,
				sinceIso: since,
				budgetMs: reloadBudgetMs,
				note: (m) => waitSpin.say(() => info(`WAF: ${m}`))
			});
		} finally {
			waitSpin.stop();
		}
		if (c.kind === 'loaded')
			info(
				`WAF: BunkerWeb built, tested and loaded its new settings (${Math.round(c.waitedMs / 1000)} s).`
			);
		else if (c.kind === 'refused')
			warn(`WAF: ${c.reason}. Nothing is broken: the site runs as before.`);
		else
			info(
				`WAF: BunkerWeb had not finished rebuilding its settings after ${Math.round(c.waitedMs / 60_000)} min; it loads them by itself when it is done.`
			);
		return c;
	};

	let cycle: SchedulerCycle | null = null;
	if (envChanged || removed !== null) {
		cycle = applyAndWait(envChanged ? 'settings written' : 'extra copy removed', envChanged);
	}

	// ── VERIFY the exemption against the LIVE site: a request to /v1/ that the
	//    Core Rule Set blocks everywhere else must pass, and the same request to
	//    the home page must still be blocked (ModSecurity is on). If /v1/ is
	//    blocked after removing a copy, put the copies back (never leave the API
	//    without its exemption). ──
	const site = serverNameOf(env);
	const liveProbe = (path: string): string => {
		if (!site) return '';
		const q = '?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E';
		const r = spawnSync(
			'curl',
			[
				'-sk',
				'-o',
				'/dev/null',
				'-w',
				'%{http_code}',
				'--max-time',
				'15',
				// This server, not a proxy from the environment (with one, curl
				// ignores --resolve and asks somewhere else).
				'--noproxy',
				'*',
				'--resolve',
				`${site}:443:127.0.0.1`,
				`https://${site}${path}${q}`
			],
			{ encoding: 'utf8', timeout: 25000 }
		);
		return (r.stdout ?? '').trim();
	};
	try {
		const stopProbe = site ? startDotsSpinner('Checking the WAF lets the API through…') : () => {};
		let api: string;
		let relay: string;
		let home: string;
		try {
			api = liveProbe('/v1/health');
			// The relay's own path too: the exemption covers /relay/ as well, and
			// only what was asked is claimed (v1.21.17 audit, L2).
			relay = liveProbe('/relay/v1/health');
			home = liveProbe('/');
		} finally {
			stopProbe();
		}
		if (api === '403' && home === '403') {
			if (removed !== null && sched !== null && restoreRuleCopies(sched, removed)) {
				warn(
					'WAF: the API was blocked by ModSecurity after the extra exception copy was removed, so it was put back.'
				);
				applyAndWait('the previous exception copies restored', false);
			} else {
				warn(
					`WAF: ModSecurity blocks Morphit's API (/v1/) on ${site}. Its exception is not loaded; broadcasts from this site may fail.`
				);
			}
		} else if (home === '403' && /^[0-9]{3}$/.test(api) && api !== '000') {
			const n = sched !== null ? listRuleCopies(sched) : null;
			const relayOk = /^[0-9]{3}$/.test(relay) && relay !== '000' && relay !== '403';
			if (relay === '403')
				warn(
					`WAF: ModSecurity lets the API (/v1/) through on ${site} but blocks the relay (/relay/: a request it blocks elsewhere was answered 403), so sign-ups and broadcasts through this site may fail. On this server: sudo docker exec ${bw} nginx -T | grep -n 1990001`
				);
			wafOk(
				relayOk ? 'the API and the relay get through' : 'the API gets through',
				`WAF: ${relayOk ? '/v1/ + /relay/' : '/v1/'} exemption verified live (a request ModSecurity blocks elsewhere reaches the API: ${api}${relayOk ? `, the relay: ${relay}` : ''}${!relayOk && relay !== '403' ? `; the relay could not be checked: ${relay || 'no answer'}` : ''})${n !== null ? `; stored ${copyCount(n)} time(s)` : ''}.`
			);
		}
		// Anything else (no answer, ModSecurity off): nothing to conclude, say nothing.
	} catch {
		/* best-effort */
	}
	void cycle;

	// (2) BODY SIZE — prove a real-sized broadcast is NOT rejected 413, and if it
	//     is, ESCALATE: the MAX_CLIENT_SIZE env sometimes never renders into nginx,
	//     so drop a raw `client_max_body_size` directive as a config FILE (the
	//     mechanism BunkerWeb reliably honors) and reload. Figure it out, as requested.
	try {
		const origin = readInstanceEnvValue(INSTANCE_ENV.ORIGIN);
		// A hidden-only node never asks the address through public DNS.
		const candidates = origin ? bodyProbeCandidates(origin, isHiddenOnlyNode()) : null;
		if (origin && candidates !== null && candidates.length > 0) {
			const probe = (): string => {
				const stop = startDotsSpinner('Checking a real-sized broadcast gets through…');
				try {
					return probeBroadcastBody(candidates);
				} finally {
					stop();
				}
			};
			let code = probe();
			if (code === '413' && sched !== null) {
				info(
					'WAF: a real-sized broadcast is still 413 — the MAX_CLIENT_SIZE env did not render; escalating via a config file.'
				);
				const root =
					(
						spawnSync(
							'docker',
							[
								'exec',
								sched,
								'sh',
								'-c',
								'for d in /data/configs /etc/bunkerweb/configs; do [ -d "$d" ] && { echo "$d"; break; }; done'
							],
							{
								encoding: 'utf8',
								timeout: 8000
							}
						).stdout ?? ''
					).trim() || '/data/configs';
				// (a) nginx client_max_body_size (server context) — harmless if already large.
				spawnSync(
					'docker',
					[
						'exec',
						sched,
						'sh',
						'-c',
						`mkdir -p '${root}/server-http' && printf '%s\\n' 'client_max_body_size 1m;' > '${root}/server-http/morphit-body-size.conf'`
					],
					{ encoding: 'utf8', timeout: 8000 }
				);
				// (b) THE actual 413 source when client_max_body_size is already generous:
				//     ModSecurity's request-body limit. `ruleEngine=Off` for /v1/ does NOT
				//     lift it (it's enforced during body-reading, before rules), so raise
				//     the no-files limit and set ProcessPartial so ModSec never rejects a
				//     legitimate avatar/order broadcast on size (timeapp: the recurring
				//     413 was ModSec, not nginx — client_max_body_size was 1G/10m).
				spawnSync(
					'docker',
					[
						'exec',
						sched,
						'sh',
						'-c',
						`mkdir -p '${root}/modsec' && printf '%s\\n' 'SecRequestBodyLimit 13107200' 'SecRequestBodyNoFilesLimit 1048576' 'SecRequestBodyLimitAction ProcessPartial' > '${root}/modsec/morphit-body-limit.conf'`
					],
					{ encoding: 'utf8', timeout: 8000 }
				);
				applyAndWait('body-size limits written', false);
				code = probe();
			}
			const verdict = classifyBroadcastProbe(code);
			// Only a fitting broadcast is good news; the rest needs the operator.
			if (verdict === 'fits')
				wafOk(
					'uploads fit',
					`WAF: broadcast body limit OK (a ~50 KB POST returned ${code}, not 413) — avatar/order uploads fit.`
				);
			else
				warn(
					verdict === 'too-large'
						? `WAF: broadcast body limit STILL 413 after escalation — capture \`docker exec ${bw} nginx -T 2>/dev/null | grep client_max_body_size\` and send it.`
						: // 000 / empty / 5xx: we could NOT reach the edge to check (e.g.
							// morphitir, whose clearnet is filtered upstream). Never claim OK for
							// an unverified condition (review B9).
							`WAF: the broadcast body-limit check got no answer from this server (curl ${code || 'no response'}); the WAF settings were applied. To check again later, on this server: ${HEALS_COMMAND}`
				);
		}
	} catch {
		/* best-effort — never fail the upgrade over a probe */
	}

	// (3) REAL IP (Fix D) — when the env now says USE_REAL_IP=no, prove the RUNNING
	//     nginx has no `set_real_ip_from` left. If it still has, BunkerWeb either
	//     kept its old environment or refused the rebuilt config — recreate its own
	//     services once and wait for its verdict. (wave 5)
	try {
		if (unq(getVal('USE_REAL_IP')).toLowerCase() !== 'yes') {
			const liveTrustsXff = (): boolean | null => {
				const stop = startDotsSpinner('Reading BunkerWeb’s running nginx config…');
				let r: { status: number | null; stdout: string | null };
				try {
					r = spawnSync('docker', ['exec', bw, 'sh', '-c', 'nginx -T 2>/dev/null'], {
						encoding: 'utf8',
						timeout: 20000,
						maxBuffer: 64 * 1024 * 1024
					});
				} finally {
					stop();
				}
				const out = r.stdout ?? '';
				if (r.status !== 0 || !/\bserver\s*\{/.test(out)) return null; // can't tell
				return /^\s*set_real_ip_from\s/m.test(out);
			};
			let live = liveTrustsXff();
			if (live === true && cycle?.kind !== 'refused' && ref !== null) {
				const c = applyAndWait('recreating BunkerWeb so it reads USE_REAL_IP=no', true);
				if (c !== null) live = liveTrustsXff();
			}
			if (live === false)
				wafOk(
					'visitors keep their own address',
					"WAF: real-IP verified live — BunkerWeb uses each visitor's own address."
				);
			// It asks the operator to act: a warning (counted for the last word).
			else if (live === true)
				warn(
					ref !== null
						? `WAF: BunkerWeb still has the old real-IP setting loaded. When convenient, run on this server: sudo ${composeCommand(ref, ['up', '-d', '--no-deps', '--force-recreate', ...stack.services])}`
						: `WAF: BunkerWeb still has the old real-IP setting loaded. ${bw} was not started by Docker Compose; recreate it on this server the way it was started so it reads ${bwEnv} again.`
				);
		}
	} catch {
		/* best-effort — never fail the upgrade over a probe */
	}

	// (4) REQUEST LIMIT (Fix E) — when the env carries Morphit's rule, prove the
	//     RUNNING BunkerWeb lets the home page be fetched three times in a second
	//     (its old rule answered the third with 429). Still limited → recreate its
	//     own services once and look again; then ask the operator. curl runs
	//     without blocking (up to 25 s), so the spinner turns for the whole wait.
	try {
		if (site && unq(getVal('LIMIT_REQ_URL')) === BW_LIMIT_REQ_URL) {
			const repeated = async (): Promise<'free' | 'limited' | null> => {
				const url = `https://${site}/`;
				const stop = startDotsSpinner('Checking a page can be fetched three times in a second…');
				let out = '';
				try {
					out = (
						await runAsync(
							'curl',
							[
								'-sk',
								'--max-time',
								'15',
								'--noproxy',
								'*',
								'--resolve',
								`${site}:443:127.0.0.1`,
								'-w',
								'%{http_code} ',
								'-o',
								'/dev/null',
								url,
								'-o',
								'/dev/null',
								url,
								'-o',
								'/dev/null',
								url
							],
							{ timeoutMs: 25000 }
						)
					).stdout;
				} finally {
					stop();
				}
				return classifyRepeatProbe(out);
			};
			let live = await repeated();
			if (live === 'limited' && cycle?.kind !== 'refused' && ref !== null) {
				const c = applyAndWait("recreating BunkerWeb so it reads Morphit's request limit", true);
				if (c !== null) live = await repeated();
			}
			if (live === 'free')
				wafOk(
					'a page can be fetched three times in a second',
					'WAF: request limit verified live — the home page fetched three times in a second got no 429.'
				);
			// No answer from this server's own edge: never reported as checked
			// (review B9). The settings were applied either way.
			else if (live === null)
				info(
					`WAF: the request-limit check got no answer from this server, so it could not be checked; the WAF settings were applied. To check again later, on this server: ${HEALS_COMMAND}`
				);
			else if (live === 'limited')
				warn(
					ref !== null
						? `WAF: BunkerWeb still limits the site's own files (a first visit can fail to load part of a page). When convenient, run on this server: sudo ${composeCommand(ref, ['up', '-d', '--no-deps', '--force-recreate', ...stack.services])}`
						: `WAF: BunkerWeb still limits the site's own files (a first visit can fail to load part of a page). ${bw} was not started by Docker Compose; recreate it on this server the way it was started so it reads ${bwEnv} again.`
				);
		}
	} catch {
		/* best-effort — never fail the upgrade over a probe */
	}

	// (5) ERROR ANSWERS (Fix F) — prove the RUNNING BunkerWeb passes the
	//     indexer's own error answer through: a chat key that does not exist
	//     must come back as the indexer's JSON 404, not BunkerWeb's page. Still
	//     replaced → recreate its own services once and look again; then ask the
	//     operator.
	try {
		if (site && unq(getVal('REVERSE_PROXY_INTERCEPT_ERRORS')).toLowerCase() === 'no') {
			// BunkerWeb's Compose service setting it itself (`environment:`) wins
			// over the file, and no recreate changes that: say where it is.
			const composeSetsIt = (): boolean => {
				if (ref === null) return false;
				const r = spawnSync(
					'docker',
					composeArgs(ref, ['config', '--format', 'json', '--no-env-resolution']),
					{
						encoding: 'utf8',
						timeout: 30000,
						maxBuffer: 64 * 1024 * 1024
					}
				);
				const svc =
					r.status === 0 && (r.stdout ?? '') !== ''
						? parseComposeModel(r.stdout)?.get(ref.service)
						: undefined;
				return svc?.environment.has('REVERSE_PROXY_INTERCEPT_ERRORS') ?? false;
			};
			const probe = async (): Promise<'passes' | 'replaced' | null> => {
				const stop = startDotsSpinner("Checking the site's own error answers reach the browser…");
				let out = '';
				try {
					out = (
						await runAsync(
							'curl',
							[
								'-sk',
								'--max-time',
								'15',
								'--noproxy',
								'*',
								'--resolve',
								`${site}:443:127.0.0.1`,
								'-w',
								'\n%{http_code}',
								`https://${site}/v1/chat-identity/${ERROR_PROBE_ACCOUNT}`
							],
							{ timeoutMs: 25000 }
						)
					).stdout;
				} finally {
					stop();
				}
				const i = out.lastIndexOf('\n');
				return classifyErrorPassThrough(out.slice(i + 1).trim(), out.slice(0, Math.max(i, 0)));
			};
			let live = await probe();
			// Not while BunkerWeb is still loading the settings just written
			// (cycle 'pending'): a second recreate would restart that load.
			const overridden = live === 'replaced' && composeSetsIt();
			if (
				live === 'replaced' &&
				!overridden &&
				cycle?.kind !== 'refused' &&
				cycle?.kind !== 'pending' &&
				ref !== null
			) {
				const c = applyAndWait('recreating BunkerWeb so it passes the error answers through', true);
				if (c !== null) live = await probe();
			}
			if (live === 'passes')
				wafOk(
					"the site's own error answers reach the browser",
					"WAF: error answers verified live — a missing chat key came back as the indexer's own answer, with its reason."
				);
			else if (live === null)
				info(
					`WAF: the error-answer check got no usable answer from this server, so it could not be checked; the setting was applied. To check again later, on this server: ${HEALS_COMMAND}`
				);
			else if (overridden)
				warn(
					`WAF: BunkerWeb still replaces the site's error answers with its own page: its Docker Compose service sets REVERSE_PROXY_INTERCEPT_ERRORS itself (an environment: entry), which wins over ${bwEnv}. Set it to "no" there, then run on this server: sudo ${composeCommand(ref!, ['up', '-d', '--no-deps', '--force-recreate', ...stack.services])}`
				);
			else
				warn(
					ref !== null
						? `WAF: BunkerWeb still replaces the site's error answers with its own page (chat and profile saves then show "Malformed response" or "the chain rejected the transaction" without the reason). When convenient, run on this server: sudo ${composeCommand(ref, ['up', '-d', '--no-deps', '--force-recreate', ...stack.services])}`
						: `WAF: BunkerWeb still replaces the site's error answers with its own page. ${bw} was not started by Docker Compose; recreate it on this server the way it was started so it reads ${bwEnv} again.`
				);
		}
	} catch {
		/* best-effort — never fail the upgrade over a probe */
	}
}

/** The account the error-answer check asks for. The indexer accepts the name
 *  (ACCOUNT_NAME_RE) and answers 404 not_found; Blurt can never create it (each
 *  part of a name must be at least 3 characters, and "zz" is 2), so no one can
 *  publish a chat key under it and turn the check into a 200. */
export const ERROR_PROBE_ACCOUNT = 'zz.morphit-probe';

/** BunkerWeb 1.5's own BAD_BEHAVIOR_STATUS_CODES (badbehavior/plugin.json). */
export const BW_DEFAULT_BAD_BEHAVIOR_CODES = '400 401 403 404 405 429 444';
/** Morphit's (bunkerweb.env.j2, bunkerweb.env.example). */
export const MORPHIT_BAD_BEHAVIOR_CODES = '401 405 444';

/** What a request for a chat key that does not exist came back as through
 *  BunkerWeb: 'passes' when it is the indexer's own JSON answer (404,
 *  code not_found), 'replaced' when BunkerWeb answered with its own error
 *  page instead, null when nothing can be said (no answer, another status).
 *  PURE. */
export function classifyErrorPassThrough(
	status: string,
	body: string
): 'passes' | 'replaced' | null {
	if (status !== '404') return null;
	try {
		const j = JSON.parse(body) as { code?: unknown };
		return j && j.code === 'not_found' ? 'passes' : null;
	} catch {
		return /<html|<!doctype/i.test(body) ? 'replaced' : null;
	}
}

/** What the request-limit probe's curl wrote (`-w '%{http_code} '` for three
 *  fetches of the home page): 'limited' when one got a 429, 'free' when all
 *  three got an answer without one, null when any got no answer (000, cut
 *  short, nothing) — then nothing can be said either way (review B9). PURE. */
export function classifyRepeatProbe(out: string): 'free' | 'limited' | null {
	const codes = out.split(/\s+/).filter((c) => /^[0-9]{3}$/.test(c));
	if (codes.length !== 3 || codes.includes('000')) return null;
	return codes.includes('429') ? 'limited' : 'free';
}

/** The last non-empty value of `key` in the first of `files` that sets it. */
function readConfigValue(files: readonly string[], key: string): string | null {
	for (const f of files) {
		try {
			if (!existsSync(f)) continue;
			const m = readFileSync(f, 'utf8').match(
				new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, 'm')
			);
			if (!m) continue;
			const v = (m[1] ?? '')
				.trim()
				.replace(/^["']|["']$/g, '')
				.trim();
			if (v !== '') return v;
		} catch {
			/* unreadable — try the next */
		}
	}
	return null;
}

/** `host:port` → parts, or the defaults when absent or malformed. PURE. */
export function parseHostPortOr(
	v: string | null,
	host: string,
	port: number
): { host: string; port: number } {
	const m = /^\[?([0-9A-Za-z.:-]+?)\]?:(\d{1,5})$/.exec((v ?? '').trim());
	if (!m) return { host, port };
	const p = Number(m[2]);
	return p > 0 && p < 65536 ? { host: m[1]!, port: p } : { host, port };
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
			const m = readFileSync(f, 'utf8').match(
				new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, 'm')
			);
			if (!m) continue;
			const v = (m[1] ?? '')
				.trim()
				.replace(/^["']|["']$/g, '')
				.trim();
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
 *  otherwise left verify.json's operator_tag null forever (still null). */
function readOperatorTagFromConfig(): string | null {
	const fromConfig = readInstanceEnvValue(INSTANCE_ENV.OPERATOR_TAG);
	if (fromConfig) return fromConfig;
	// Fallback: ask the running indexer for this instance's on-chain tag.
	try {
		const origin = readInstanceEnvValue(INSTANCE_ENV.ORIGIN);
		if (!origin) return null;
		const norm = (s: string): string => s.replace(/\/+$/, '').toLowerCase();
		for (const base of [
			'http://127.0.0.1:8081',
			'http://172.18.0.1:8081',
			'http://172.17.0.1:8081'
		]) {
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
				: ((body as { instances?: Array<{ origin?: string; operator_tag?: string }> }).instances ??
					[]);
			const self = list.find(
				(e) => typeof e.origin === 'string' && norm(e.origin) === norm(origin)
			);
			const tag = self?.operator_tag;
			if (typeof tag === 'string' && tag.trim() !== '') return tag.trim();
		}
	} catch {
		/* best-effort — verify.json's operator_tag is informational */
	}
	return null;
}

/** Remember that this box has served a warrant canary (see step 9d-bis).
 *  Best-effort; never throws. */
export function recordCanarySeen(marker: string): void {
	try {
		mkdirSync(dirname(marker), { recursive: true });
		writeNoFollow(marker, `seen ${new Date().toISOString()}\n`, 0o644);
	} catch {
		/* best-effort; the checks in step 9d-bis still work without it */
	}
}

/** Stamp `operator_tag` into a build's verify.json without disturbing its
 *  formatting or the (asset) hash_manifest. Returns true if it changed the file.
 *  Never follows a link at verify.json (the build dir may be non-root-owned). */
export function patchVerifyJsonOperatorTag(buildDir: string, tag: string): boolean {
	const p = join(buildDir, 'verify.json');
	const txt = readNoFollow(p);
	if (txt === null) return false;
	const patched = txt.replace(
		/("operator_tag"[ \t]*:[ \t]*)(null|"[^"]*")/,
		`$1${JSON.stringify(tag)}`
	);
	if (patched === txt) return false;
	writeNoFollow(p, patched, 0o644);
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
// transfer STALLS this long, so a slow-but-steady link (a throttled, filtered one)
// can finish a large download instead of hitting a fixed total deadline.
const UPGRADE_STALL_TIMEOUT_MS = 90_000;

// fetch a release-metadata URL with all the safety the
// upgrade path needs: a hard timeout, manual redirect handling
// (a 30x to an unexpected host on the metadata call must be
// operator-visible), and a 1 MiB body cap before parse (the host
// is operator-configured so this isn't SSRF, but a MITM'd /
// compromised release API returning multi-GB JSON would OOM the
// upgrade run; Forgejo release payloads are <8 KB, so 1 MiB is
// 100x+ headroom).  Returns the raw text; the caller parses.
async function fetchReleaseJson(
	url: string
): Promise<{ ok: boolean; status: number; text: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), UPGRADE_FETCH_TIMEOUT_MS);
	// Node's own 10 s connect limit would cut a slow connect short of the 30 s
	// this waits (lib/codeHostAgent.ts).
	const agent = codeHostAgent(UPGRADE_FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Accept: 'application/json' },
			redirect: 'manual',
			signal: controller.signal,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lib.dom omits undici's dispatcher
			dispatcher: agent
		} as any);
		if (!res.ok) {
			return { ok: false, status: res.status, text: '' };
		}
		const RELEASE_JSON_MAX_BYTES = 1024 * 1024;
		// bound the response body before parse (cap
		// retained through the refactor of this fetch into a helper).
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
		closeQuietly(agent);
	}
}

/** PURE. Why a request to a release source failed, in plain words: the
 *  usual network causes by name (fetch's own "fetch failed" says nothing),
 *  the error's message otherwise. */
export function netFailureWords(err: unknown): string {
	const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
	const code = e?.cause?.code ?? '';
	if (e?.name === 'AbortError' || /TIMEOUT|ETIMEDOUT/.test(code)) return 'did not answer in time';
	if (code === 'ECONNREFUSED') return 'refused the connection';
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'its name could not be looked up (DNS)';
	if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'dropped the connection';
	if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'is not reachable from this server';
	if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return 'its certificate could not be checked';
	const m = /^HTTP (\d{3})\b/.exec(e?.message ?? '');
	if (m) return `answered HTTP ${m[1]}`;
	const msg = e?.message ?? String(err);
	return msg === 'fetch failed' && e?.cause?.message ? e.cause.message : msg;
}

/** The plain end of an upgrade that downloaded nothing: what was tried,
 *  that nothing changed, and the next step. PURE. Exported for its test. */
export function nothingFetchedLines(o: {
	readonly what: string;
	readonly tried: readonly string[];
	readonly current: string;
	readonly host: string;
	readonly offlineDir: string;
	readonly tag: string | null;
}): string[] {
	const bundle = `morphit-${o.tag ?? '<version>'}-offline.tar.gz`;
	return [
		`✗ ${o.what}`,
		...o.tried.map((t) => `    ${t}`),
		`  Nothing was changed; this server still runs ${o.current}.`,
		`  Next: once this server can reach ${o.host} again (to check, on this server: curl -sI https://${o.host}), run on this server: sudo morphit-ops upgrade`,
		`  Without a network: copy ${bundle} and its .asc into ${o.offlineDir}, then on this server: sudo morphit-ops upgrade`
	];
}

/** One line for why the Tor/I2P fallback of a clearnet node did not get the
 *  release (v1.21.15 review): plain words for the usual causes, the
 *  resolver's own message otherwise. */
export function fallbackFailureText(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	if (err instanceof HiddenUpgradeWaitError) {
		const peers = err.peers;
		if (
			err.stage === 'fetch' &&
			peers.length > 0 &&
			peers.every((p) => p.result === 'unreachable')
		) {
			return (
				`none of the ${peers.length} instance address(es) could be reached over Tor/I2P — is Tor running on ` +
				'this server? (sudo systemctl status tor)'
			);
		}
		if (err.stage === 'fetch' && peers.length > 0 && peers.every((p) => p.result === 'missing')) {
			return 'no other instance has this release yet (they get it as they upgrade).';
		}
		if (err.stage === 'peers') return 'no other instance publishes a Tor or I2P address yet.';
		if (err.stage === 'record')
			return "@morphit's signed record for this release could not be read yet.";
	}
	return msg;
}

async function fetchLatestRelease(host: string, repo: string): Promise<ForgejoRelease> {
	// `/releases/latest` returns the most recent
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
	// over a throttled, filtered link) must COMPLETE; the
	// old fixed 30 s cap guillotined healthy slow downloads mid-transfer. We also
	// STREAM to disk instead of buffering the whole file in memory.
	let timer!: ReturnType<typeof setTimeout>;
	const arm = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(), UPGRADE_STALL_TIMEOUT_MS);
	};
	arm();
	// A connect may take as long as a stall may last (lib/codeHostAgent.ts).
	const agent = codeHostAgent(UPGRADE_STALL_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lib.dom omits undici's dispatcher
			dispatcher: agent
		} as any);
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
		closeQuietly(agent);
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

/** The download scratch dir: always a NEW directory with an unpredictable name,
 *  mode 0700 (mkdtemp). It holds the release tarball between the integrity
 *  check and extraction, as root, so it must never be a directory — or a link
 *  to one — that something else created first (review B2: the old
 *  `morphit-upgrade-<Date.now()>` + mkdirSync({recursive}) adopted one). */
export function mkTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'morphit-upgrade-'));
}

function cleanupTmp(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

/**
 * remove an inherited npm "offline" flag from an environment.
 *
 * The Ansible `morphit-ops` launcher runs the CLI via `npm exec --offline`,
 * which exports `npm_config_offline=true` into our process environment. That
 * flag is inherited by every child npm we spawn during an upgrade and forces a
 * clearnet node's `npm ci` cache-only: any dependency not already in the local
 * npm cache then fails with `ENOTCACHED` and the whole upgrade rolls back.
 *
 * No other path relies on the inherited flag: the prebuilt-bundle path installs
 * nothing, a hidden-only node's npm gets its settings explicitly
 * (lib/depsInstall.ts), and the MCP redeploy (deploy-mcp.sh) runs no npm install
 * at all — it copies from the locked install. So stripping it is safe.
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

function runOrThrow(
	cmd: string,
	args: readonly string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): void {
	const result = spawnSync(cmd, args, {
		stdio: 'inherit',
		cwd: opts.cwd,
		...(opts.env !== undefined ? { env: opts.env } : {})
	});
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
	}
}

/** A file the upgrade changed outside the install dir, and the copy of it
 *  taken first. `isUnit` marks a systemd unit (a daemon-reload follows). */
export interface RollbackRestore {
	readonly target: string;
	readonly backup: string;
	readonly isUnit?: boolean;
}

/** The self-heal backups' state before the self-heal phase: a backup whose
 *  mtime changes (or that appears) during the phase was written by THIS run.
 *  */
export function snapshotSelfHealBackups(
	targets: readonly string[],
	backupOf: (target: string) => string = relayHealBackupPath
): ReadonlyArray<{ target: string; backup: string; mtimeMs: number | null }> {
	return targets.map((target) => {
		const backup = backupOf(target);
		let mtimeMs: number | null = null;
		try {
			mtimeMs = statSync(backup).mtimeMs;
		} catch {
			mtimeMs = null;
		}
		return { target, backup, mtimeMs };
	});
}

/** Which self-heal backups this run made, as files rollback() must restore.
 *  Files inside the install dir are left out: the directory swap already puts
 *  the previous ones back. */
export function selfHealRestoreList(
	snap: ReadonlyArray<{ target: string; backup: string; mtimeMs: number | null }>,
	installDir: string
): RollbackRestore[] {
	const inside = (p: string): boolean => resolve(p).startsWith(`${resolve(installDir)}/`);
	const out: RollbackRestore[] = [];
	for (const s of snap) {
		if (inside(s.target)) continue;
		let now: number | null = null;
		try {
			now = statSync(s.backup).mtimeMs;
		} catch {
			now = null;
		}
		if (now !== null && now !== s.mtimeMs) out.push({ target: s.target, backup: s.backup });
	}
	return out;
}

/** Injectable seams for rollback, so the recovery path is testable without a
 *  live systemd or docker. Both default to the real implementations. */
export interface RollbackDeps {
	restartContainer?: (name: string, installDir: string) => void | Promise<void>;
	systemctl?: (args: readonly string[]) => { status: number | null };
}

/** NRestarts for a unit right now, or 0 when it can't be read. */
function readUnitRestarts(svc: string): number {
	const r = spawnSync('systemctl', ['show', '-p', 'NRestarts', '--value', svc], {
		encoding: 'utf8',
		timeout: 10_000
	});
	const n = Number((r.stdout ?? '').trim());
	return r.status === 0 && Number.isInteger(n) && n >= 0 ? n : 0;
}

/** How many AUTOMATIC restarts inside the verification window count as a
 *  crash-loop. morphit-indexer.service deliberately exits + retries while
 *  Postgres is still coming up, so ONE (even two) restart is normal and must
 *  never roll back a good upgrade (wave 4, P6). */
export const CRASH_LOOP_RESTARTS = 3;
/** How long to watch a just-restarted unit, and how many consecutive steady
 *  "active" polls end the watch early. */
const RESTART_WINDOW_MS = 45_000;
const RESTART_POLL_MS = 1_500;
const STABLE_POLLS = 4;

/** Step 10: restart each service on the new version and watch it stay up.
 *  `verified` only when each one restarted and stayed up, and at least one
 *  did; `rollback` when a service that was running cannot run the new
 *  version (the caller undoes the upgrade). A service that was down before
 *  and still cannot start does not undo it. Exported for its test. */
export async function restartServicesOnNewVersion(
	services: readonly string[] = SERVICES_TO_RESTART,
	o: {
		/** The upgrade was stopped (Ctrl+C, a closed session): no further
		 *  service is restarted, and the caller puts the previous install back. */
		readonly stopped?: () => boolean;
		/** Tests: the watch window and the pause between looks (ms). */
		readonly windowMs?: number;
		readonly pollMs?: number;
	} = {}
): Promise<{ readonly verified: boolean } | { readonly rollback: Error }> {
	let servicesVerified = true;
	let restartedAny = false;
	const stopped = async (): Promise<boolean> => {
		if (o.stopped === undefined) return false;
		await settleSignals();
		return o.stopped();
	};
	const stopError = (): Error => new Error('the upgrade was stopped while the services restarted');
	for (const svc of services) {
		// Before each service (v1.21.18 audit, M1: the relay was restarted on
		// the new release after a Ctrl+C during the indexer's).
		if (await stopped()) return { rollback: stopError() };
		const isActive = spawnSync('systemctl', ['is-active', '--quiet', svc]).status === 0;
		if (!isActive) {
			// v1.20.1: an ENABLED service that is not running is meant to run
			// (morphitir's relay had exited with status 0 and been left down);
			// start it on the new version below. Disabled / absent: skip.
			const enabled = (
				spawnSync('systemctl', ['is-enabled', svc], { encoding: 'utf8' }).stdout ?? ''
			).trim();
			if (enabled !== 'enabled') {
				info(`Skipping ${svc} (not active on this host).`);
				continue;
			}
			info(`${svc} is enabled but was not running; starting it on the new version.`);
		}
		const restartsBefore = readUnitRestarts(svc);
		try {
			// Under the turning spinner (systemctl's output shown if it fails).
			const code = await runStepWithSpinner(`Restarting ${svc}…`, 'systemctl', ['restart', svc], {
				quietOnSuccess: true,
				warningsOnSuccess: false
			});
			if (code !== 0) throw stepFailed(`systemctl restart ${svc} exited ${code}`);
		} catch (err) {
			// A stop that ended the restart is not a service that failed.
			if (await stopped()) return { rollback: stopError() };
			// It was down before this upgrade: the upgrade did not break it, so it
			// does not undo the upgrade — say so and carry on.
			if (!isActive) {
				warn(
					`${svc} was not running before this upgrade and could not be started now. See: sudo journalctl -u ${svc} -n 50`
				);
				servicesVerified = false;
				continue;
			}
			warn(`Service restart failed for ${svc}; rolling back.`);
			return { rollback: err instanceof Error ? err : new Error(String(err)) };
		}
		// `systemctl restart` on a Type=simple unit returns success the instant it
		// forks the process — it does NOT mean the new code STAYED up. VERIFY by
		// observing the running state (the heal mandate): a unit that crashed on the
		// new code flips to `failed`, or auto-restarts (NRestarts climbs). Poll a
		// short window; `activating`/a slow first chain read over Tor is NOT a
		// failure. Only a confirmed `failed`/crash-loop rolls back — so a
		// half-upgraded box is never left running the new code down.
		const outcome = await verifyUnitStayedUp(svc, restartsBefore, {
			stopped: o.stopped,
			windowMs: o.windowMs,
			pollMs: o.pollMs
		});
		if (outcome === 'stopped') return { rollback: stopError() };
		if (outcome === 'down' && !isActive) {
			warn(
				`${svc} was not running before this upgrade and did not stay up when started now. See: sudo journalctl -u ${svc} -n 50`
			);
			servicesVerified = false;
			continue;
		}
		if (outcome === 'down') {
			warn(`${svc} did not stay up after restarting on the new version; rolling back.`);
			return { rollback: new Error(`${svc} failed to come up after the upgrade restart`) };
		}
		restartedAny = true;
	}
	if (await stopped()) return { rollback: stopError() };
	if (!restartedAny) servicesVerified = false;
	return { verified: servicesVerified };
}

/** Classify ONE observation of a unit after the upgrade restarted it. PURE
 *  (v1.20.0, B6; wave 4, P6). `failed`, or CRASH_LOOP_RESTARTS+ automatic
 *  restarts since the upgrade's own restart, = down. `active` = up. Anything
 *  else (activating / auto-restart pending) = wait — until the window is over,
 *  when a unit that is still not active = down. */
export function classifyUnitOutcome(
	activeState: string,
	restartsBefore: number,
	restartsNow: number,
	windowOver = false
): 'up' | 'down' | 'wait' {
	if (activeState === 'failed') return 'down';
	if (restartsNow - restartsBefore >= CRASH_LOOP_RESTARTS) return 'down';
	if (activeState === 'active') return 'up';
	return windowOver ? 'down' : 'wait';
}

/** Decide from the samples seen so far. PURE. 'down' as soon as any sample is
 *  down; 'up' once the last STABLE_POLLS samples are all active with no new
 *  restart between them (steady), or when the window is over and the last
 *  sample is up; otherwise 'wait'. */
export function evaluateRestartSamples(
	restartsBefore: number,
	samples: ReadonlyArray<{ activeState: string; restarts: number }>,
	windowOver: boolean
): 'up' | 'down' | 'wait' {
	if (samples.length === 0) return windowOver ? 'down' : 'wait';
	for (const x of samples) {
		if (classifyUnitOutcome(x.activeState, restartsBefore, x.restarts) === 'down') return 'down';
	}
	const tail = samples.slice(-STABLE_POLLS);
	if (
		tail.length === STABLE_POLLS &&
		tail.every((x) => x.activeState === 'active' && x.restarts === tail[0]!.restarts)
	) {
		return 'up';
	}
	if (windowOver) {
		const last = samples[samples.length - 1]!;
		return classifyUnitOutcome(last.activeState, restartsBefore, last.restarts, true);
	}
	return 'wait';
}

/** Observe whether a just-restarted unit came up and STAYED up, polling its
 *  running state (not the restart exit code) under a spinner so the pause is
 *  never silent. Returns 'up' or 'down'. */
async function verifyUnitStayedUp(
	svc: string,
	restartsBefore: number,
	o: {
		readonly stopped?: (() => boolean) | undefined;
		readonly windowMs?: number | undefined;
		readonly pollMs?: number | undefined;
	} = {}
): Promise<'up' | 'down' | 'stopped'> {
	const stop = startDotsSpinner(`Checking ${svc} came up on the new version…`);
	try {
		const samples: Array<{ activeState: string; restarts: number }> = [];
		const deadline = Date.now() + (o.windowMs ?? RESTART_WINDOW_MS);
		for (;;) {
			// A stop while it is watched ends the watch (M1).
			if (o.stopped?.() === true) return 'stopped';
			const r = spawnSync('systemctl', ['show', '-p', 'ActiveState', '--value', svc], {
				encoding: 'utf8',
				timeout: 10_000
			});
			samples.push({ activeState: (r.stdout ?? '').trim(), restarts: readUnitRestarts(svc) });
			const verdict = evaluateRestartSamples(restartsBefore, samples, Date.now() >= deadline);
			if (verdict !== 'wait') return verdict;
			await new Promise((res) => setTimeout(res, o.pollMs ?? RESTART_POLL_MS));
		}
	} finally {
		stop();
	}
}

export async function rollback(
	installDir: string,
	backupDir: string,
	tmpDir: string,
	err: unknown,
	web?: { webRoot: string; webRootBackup: string | null; container?: string | null },
	restore: readonly RollbackRestore[] = [],
	deps: RollbackDeps = {}
): Promise<number> {
	const restartContainer =
		deps.restartContainer ??
		((name: string, dir: string) => restartFrontendContainer(name, dir, { restoring: true }));
	const systemctl =
		deps.systemctl ?? ((args: readonly string[]) => spawnSync('systemctl', [...args]));
	const reason = err instanceof Error ? err.message : String(err);
	if (err instanceof UpgradeStopped) info(`Upgrade stopped: ${reason}.`);
	else printError(`Upgrade failed: ${reason}`);
	// What the heal phase left for the upgrade's last word (step 14), which a
	// rollback never reaches: say it here instead of losing it.
	{
		const q = takeUpgradeQuestions();
		takeChildWarnings();
		if (q.length > 0)
			info(
				`The heal phase had left questions for you (they come back with the next upgrade): ${q.join('; ')}.`
			);
		// The background checks run this (failed) release's code against the
		// services being put back: stop them. (The BunkerWeb settings heal, if it
		// runs, does not depend on the release and puts its files back by itself
		// if it is stopped; it is left to finish.)
		const bg = systemctl(['is-active', '--quiet', AFTER_RESTART_UNIT]);
		if (bg?.status === 0) {
			const stopSpin = startDotsSpinner('Stopping the background checks…');
			let stopped: boolean;
			try {
				stopped = systemctl(['stop', AFTER_RESTART_UNIT])?.status === 0;
			} finally {
				stopSpin();
			}
			info(
				stopped
					? `Stopped the background checks (${AFTER_RESTART_UNIT}) that ran this release's code; what they did so far is in ${afterRestartLogPath()}.`
					: `The background checks (${AFTER_RESTART_UNIT}) could not be stopped; on this server: sudo systemctl stop ${AFTER_RESTART_UNIT}`
			);
		}
	}
	info(`Rolling back: removing partial extract at ${installDir}`);
	try {
		rmSync(installDir, { recursive: true, force: true });
	} catch (rmErr) {
		printError(
			`Rollback failed at rm step: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`
		);
		printError(
			`Manual intervention needed: ${installDir} is in a partial state; ${backupDir} contains the prior install.`
		);
		cleanupTmp(tmpDir);
		return 4;
	}
	try {
		renameSync(backupDir, installDir);
	} catch (renameErr) {
		printError(
			`Rollback failed at rename step: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`
		);
		printError(
			`Manual intervention needed: ${backupDir} contains the prior install; manually move it back to ${installDir}.`
		);
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
	// a container frontend bind-mounts <install>/apps/web/
	// build. Step 9c re-created the container on the NEW install; after the
	// delete + rename above, that mount points at a directory that no longer
	// exists (the kernel keeps the deleted inode: the site serves an empty tree
	// and nginx 500-loops). Re-bind it to the restored install.
	if (web?.container) {
		try {
			await restartContainer(web.container, installDir);
			info(`Re-attached the frontend container "${web.container}" to the restored install.`);
		} catch (ctErr) {
			warn(
				`Could not restart the frontend container "${web.container}": ` +
					`${ctErr instanceof Error ? ctErr.message : String(ctErr)}. ` +
					`Restart it by hand so it serves the restored build: sudo docker restart ${web.container}`
			);
		}
	}
	// The self-heal phase edits files OUTSIDE the
	// install dir (the relay heal appends to /etc/morphit/relay.env) and the
	// upgrade refreshes systemd units. Rolling back only /opt/morphit left the
	// previous version to start on the NEW version's relay settings and units.
	// Put back every file this run recorded, before restarting anything.
	let unitsRestored = false;
	for (const r of restore) {
		try {
			copyFileSync(r.backup, r.target);
			if (r.isUnit === true) unitsRestored = true;
			info(`Restored ${r.target} as it was before this upgrade.`);
		} catch (restoreErr) {
			warn(
				`Could not restore ${r.target} from ${r.backup}: ` +
					`${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}. ` +
					`Copy it back by hand: sudo cp ${r.backup} ${r.target}`
			);
		}
	}
	if (
		unitsRestored &&
		!(() => {
			const stop = startDotsSpinner('Reloading systemd…');
			try {
				return daemonReload();
			} finally {
				stop();
			}
		})()
	) {
		warn(
			'Could not run `systemctl daemon-reload`; run it by hand so the restored units take effect.'
		);
	}
	// Best-effort: restart services after rollback so the old version is running.
	// Restart every INSTALLED unit, not only the ones reporting is-active: a unit
	// that CRASHED on the new code (the very reason we are rolling back) reports
	// INACTIVE, and the old is-active-only gate then skipped it — leaving that
	// service DOWN on a box the rollback otherwise restored (review B6). An
	// enabled unit is one this box runs; a genuinely-absent unit fails both checks
	// and is skipped.
	for (const svc of SERVICES_TO_RESTART) {
		const installed =
			systemctl(['is-enabled', '--quiet', svc]).status === 0 ||
			systemctl(['is-active', '--quiet', svc]).status === 0;
		if (!installed) continue;
		// As the default runner, without blocking: the spinner turns while it
		// restarts; an injected runner (tests) is called as it is.
		if (deps.systemctl === undefined)
			await runSpinning(`Restarting ${svc} on the previous version…`, 'systemctl', [
				'restart',
				svc
			]);
		else {
			const stop = startDotsSpinner(`Restarting ${svc} on the previous version…`);
			try {
				systemctl(['restart', svc]);
			} finally {
				stop();
			}
		}
	}
	cleanupTmp(tmpDir);
	// The last word: where this server is now, checked, why the upgrade
	// stopped and where that step's full output is (L8).
	const running: string[] = [];
	const down: string[] = [];
	for (const svc of SERVICES_TO_RESTART) {
		if (systemctl(['is-enabled', '--quiet', svc]).status !== 0) continue;
		(systemctl(['is-active', '--quiet', svc]).status === 0 ? running : down).push(svc);
	}
	const lines = rollbackConclusion({
		installDir,
		tag: readLocalReleaseInfo(installDir)?.tag ?? null,
		running,
		down,
		reason,
		stopped: err instanceof UpgradeStopped,
		// Only the log of the step that made the upgrade fail (M3).
		log: err instanceof StepFailed ? err.log : null
	});
	const note = keepStoppedNote(lines);
	for (const l of lines) info(l);
	if (note !== null) info(`  (These lines are also kept on this server: sudo cat ${note})`);
	return 3;
}

/** PURE. A rolled-back upgrade's last lines. Exported for its test. */
export function rollbackConclusion(o: {
	readonly installDir: string;
	readonly tag: string | null;
	readonly running: readonly string[];
	readonly down: readonly string[];
	readonly reason: string;
	readonly stopped: boolean;
	readonly log: string | null;
}): string[] {
	const bar = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
	const on = o.tag !== null ? sanitizeForTerm(o.tag) : 'the version it ran before';
	const out = [
		'',
		bar,
		`  ✗ Not upgraded — this server is back on ${on}`,
		bar,
		'',
		`  The previous install is back in ${o.installDir}` +
			(o.running.length > 0
				? `, and ${o.running.join(' and ')} ${o.running.length === 1 ? 'runs' : 'run'} on it (checked).`
				: '.')
	];
	for (const d of o.down)
		out.push(`  ${d} is not running; on this server: sudo journalctl -u ${d} -n 50`);
	out.push(
		`  Why: ${o.stopped ? o.reason : `the upgrade failed (${o.reason})`}.` +
			(!o.stopped && o.log !== null
				? ` The step's full output, on this server: sudo cat ${o.log}`
				: '')
	);
	out.push('  To try again later, on this server: sudo morphit-ops upgrade');
	return out;
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
			const fields = stat
				.slice(stat.lastIndexOf(')') + 1)
				.trim()
				.split(/\s+/);
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

/** v1.21.6: a few words on why a zero-clearnet try had to wait (one line per
 *  try while it keeps trying by itself). */
function hiddenWaitSummary(e: HiddenUpgradeWaitError): string {
	if (e.stage === 'record') {
		return e.recordNotListed
			? 'the signed record is not listed yet'
			: 'the signed record could not be read in time';
	}
	if (e.stage === 'peers') return 'no instance with a Tor/I2P address listed yet';
	const missing = e.peers.filter((p) => p.result === 'missing').length;
	const silent = e.peers.filter(
		(p) => p.result === 'no_answer' || p.result === 'unreachable'
	).length;
	const unusable = e.peers.length - missing - silent;
	const parts: string[] = [];
	if (missing > 0) parts.push(`${missing} address${missing === 1 ? '' : 'es'} without a copy yet`);
	if (silent > 0) parts.push(`${silent} not answering`);
	if (unusable > 0) parts.push(`${unusable} with no usable copy`);
	return parts.length > 0 ? parts.join(', ') : 'no copy found';
}

/** v1.21.6: wait `ms` with the spinner counting down (Ctrl-C stops the whole
 *  upgrade; nothing has been changed at this point). */
async function waitWithSpinner(ms: number, out: NodeJS.WriteStream): Promise<void> {
	// A steady clock, like the wait itself (setTimeout): a step of the wall
	// clock does not make the countdown jump.
	const until = performance.now() + ms;
	const stop = startDotsSpinner(() => {
		const left = Math.max(0, Math.ceil((until - performance.now()) / 1000));
		return `Next try in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} — Ctrl-C stops (nothing has changed)`;
	}, out);
	try {
		await new Promise<void>((r) => setTimeout(r, ms));
	} finally {
		stop();
	}
}

/** v1.21.6: ask what to do after a zero-clearnet wait (terminal only; Enter =
 *  try again now). Asks again on an answer it does not understand. */
async function askHiddenWaitChoice(): Promise<HiddenWaitChoice> {
	const readline = await import('node:readline/promises');
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		for (;;) {
			let answer: string;
			try {
				answer = await rl.question('Enter 1, 2 or 3 [1]: ');
			} catch {
				// stdin closed (Ctrl-D) or Ctrl-C: leave the box as it is, and end
				// the prompt line so the next message starts on its own line.
				process.stdout.write('\n');
				return 'later';
			}
			const c = parseWaitChoice(answer);
			if (c !== null) return c;
			info('Please enter 1 (try again now), 2 (keep trying by itself) or 3 (stop for now).');
		}
	} finally {
		rl.close();
	}
}

/** How long to wait for an answer when stdin is NOT a terminal. Piped answers
 *  arrive at once; a stuck pipe must not wedge an upgrade. */
const NON_TTY_ANSWER_TIMEOUT_MS = 20_000;

/** The last question was ended by Ctrl+C (at a terminal). */
let lastPromptStoppedByCtrlC = false;

/** One line from a stdin that is not a terminal (piped answers), or null at
 *  once when it has ended (/dev/null: cron, the release monitor) or after
 *  `timeoutMs` (a pipe that never delivers). What follows the line is put
 *  back for the next question. */
function readPipedLine(timeoutMs: number): Promise<string | null> {
	const input = process.stdin;
	return new Promise((resolveLine) => {
		let buf = '';
		let done = false;
		const finish = (v: string | null): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			input.removeListener('data', onData);
			input.removeListener('end', onEnd);
			input.removeListener('error', onEnd);
			input.pause();
			resolveLine(v);
		};
		const onData = (d: Buffer | string): void => {
			buf += d.toString();
			const i = buf.indexOf('\n');
			if (i < 0) return;
			const rest = buf.slice(i + 1);
			if (rest !== '') input.unshift(Buffer.from(rest));
			finish(buf.slice(0, i));
		};
		const onEnd = (): void => finish(buf === '' ? null : buf);
		const timer = setTimeout(() => finish(null), timeoutMs);
		if (input.readableEnded) {
			finish(null);
			return;
		}
		input.on('data', onData);
		input.once('end', onEnd);
		input.once('error', onEnd);
		input.resume();
	});
}

async function promptYes(message: string): Promise<boolean> {
	lastPromptStoppedByCtrlC = false;
	// NEVER block forever, but DO accept piped answers: feeding answers
	// through a pipe is ordinary automation. A stdin that never delivers (an
	// open pipe, `ssh -T`, a systemd unit with stdin attached) is given up on
	// after NON_TTY_ANSWER_TIMEOUT_MS; one that has ENDED (/dev/null: cron, a
	// script) is "no" at once — readline waited the whole 20 s for it (v1.21.17
	// audit, L4). Declining leaves the box as it was.
	if (process.stdin.isTTY !== true) {
		process.stdout.write(`${message}\n[y/N]: `);
		const line = await readPipedLine(NON_TTY_ANSWER_TIMEOUT_MS);
		if (line === null) {
			process.stdout.write('\n');
			info('(No answer came on stdin, so the answer is no.)');
			return false;
		}
		process.stdout.write('\n');
		const a = line.trim().toLowerCase();
		return a === 'y' || a === 'yes';
	}
	// At a terminal: Node's readline (not imported at the module top, to keep
	// the cost off the --check-only path), with unlimited time to answer.
	const readline = await import('node:readline/promises');
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	// Ctrl+C at the question means stop, not "no answer on stdin" (L3). While
	// the install is half-way (the signal guard is up), it is passed on as the
	// signal it is, so the previous install is put back.
	// (A closed interface leaves the question pending: it is aborted instead.)
	const ac = new AbortController();
	rl.on('SIGINT', () => {
		lastPromptStoppedByCtrlC = true;
		process.stdout.write('\n');
		ac.abort();
		if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT', 'SIGINT');
	});
	rl.on('close', () => ac.abort());
	let answer = '';
	try {
		answer = (await rl.question(`${message}\n[y/N]: `, { signal: ac.signal })).trim().toLowerCase();
	} catch {
		// Ctrl+C (above) or Ctrl+D: the safe answer.
		rl.close();
		if (!lastPromptStoppedByCtrlC) info('(No answer, so the answer is no.)');
		return false;
	}
	rl.close();
	return answer === 'y' || answer === 'yes';
}
