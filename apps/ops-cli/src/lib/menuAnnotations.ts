/**
 * Best-effort menu annotations (beta5).
 *
 * The main menu renders BEFORE config/DB are loaded, so everything
 * here is best-effort and MUST NOT throw or hang: each lookup is
 * bounded by a short timeout and returns null on any failure. The menu
 * shows what it can and silently omits the rest.
 *
 *   - currentVersion: the installed Morphit release tag, read from
 *     <installDir>/release-info.json (no network).
 *   - latestVersion: @morphit's on-chain release record, read from this node's
 *     own indexer (its listener proven to be morphit-indexer.service, as the
 *     upgrade checks it; no network beyond the box). Only when that does not
 *     answer, and never on a hidden-only node, the release tag from the code
 *     host (MENU_RELEASE_HOST_TIMEOUT_MS). A signed offline tarball in the drop
 *     dir counts too. 2026-10-08: the menu asked only the code host, for 2.5 s,
 *     and morphit.io's menu said "couldn't check for updates" while v1.21.2 was
 *     out and its record already on chain. The record exists before any box
 *     upgrades (the ceremony broadcasts first) and is what an unsigned release
 *     installs by, so it is the answer; the code host is not told about this
 *     server each time the menu opens. Hidden-only is decided as the upgrade
 *     decides it (isHiddenOnly); when that cannot be told, the node is treated
 *     as hidden-only. The menu waits with the braille spinner.
 *   - unresolvedFlags: recent abuse flags where NEITHER named account
 *     is blocked on this instance (i.e. the operator hasn't acted) —
 *     best-effort DB read, null if config/DB unavailable.
 *   - relayBalanceStatus: the relay account's liquid BLURT graded
 *     against thresholds.relayBalance ('warn'/'error' when running low),
 *     via a short-timeout chain read; null if config/chain unavailable. On a
 *     hidden-only node the read goes through this node's own indexer
 *     (lookupBlurtAccount decides that).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, applyThreshold } from '../config.ts';
import { createDatabase } from '../db.ts';
import { lookupBlurtAccount } from '../init/chainCheck.ts';
import { findLocalOfflineRelease, compareTags } from '../commands/upgrade.ts';
import { startDotsSpinner } from '../init/spinner.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { closeQuietly, codeHostAgent } from './codeHostAgent.ts';
import {
	isHiddenOnly,
	readOnchainReleaseTag,
	type HiddenOnlyOptions
} from '../init/hiddenUpgradeResolve.ts';
import {
	indexerUnitEnvFiles,
	type LocalIndexerOptions
} from '../init/hiddenUpgradeLocalIndexer.ts';

export interface MenuAnnotations {
	readonly currentVersion: string | null;
	readonly latestVersion: string | null;
	/** True when `latestVersion` came from a signed tarball dropped in the
	 *  offline release dir rather than the network — so the menu can say so and
	 *  the operator knows an offline upgrade is ready to go. */
	readonly latestIsOffline: boolean;
	readonly unresolvedFlags: number | null;
	readonly relayBalanceStatus: 'ok' | 'warn' | 'error' | null;
}

const DEFAULT_INSTALL_DIR = '/opt/morphit';
const DEFAULT_RELEASE_HOST = 'git.agorise.net';
const DEFAULT_RELEASE_REPO = 'agorise/morphit';
const FLAG_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** How long the menu waits for the code host's answer (with the spinner). */
export const MENU_RELEASE_HOST_TIMEOUT_MS = 10_000;
/** How long the menu waits for this node's own indexer (on the box). */
export const MENU_ONCHAIN_TIMEOUT_MS = 4_000;
/** A release tag the menu may show. */
const TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/;

/** Installed release tag from release-info.json, or null. Sync, no
 *  network, never throws. */
export function readCurrentVersion(): string | null {
	const installDir = process.env.MORPHIT_INSTALL_DIR ?? DEFAULT_INSTALL_DIR;
	const p = join(installDir, 'release-info.json');
	if (!existsSync(p)) return null;
	try {
		const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { tag?: unknown };
		return typeof parsed.tag === 'string' ? parsed.tag : null;
	} catch {
		return null;
	}
}

/** Newest release tag from the code host (Forgejo), bounded by `timeoutMs`.
 *  Returns null on any error/timeout. Prefers /releases/latest (stable), falls
 *  back to the newest release of any kind. Callers never call it on a
 *  hidden-only node (gatherMenuAnnotations decides that first). */
export async function fetchLatestVersion(
	timeoutMs = MENU_RELEASE_HOST_TIMEOUT_MS
): Promise<string | null> {
	// Belt and braces: never the code host from a node whose config says
	// hidden-only, whoever calls this.
	if (isHiddenOnlyNode()) return null;
	const host = process.env.MORPHIT_RELEASE_HOST ?? DEFAULT_RELEASE_HOST;
	const repo = process.env.MORPHIT_RELEASE_REPO ?? DEFAULT_RELEASE_REPO;
	const base = `https://${host}/api/v1/repos/${repo}`;

	// The tag, or the HTTP status when the host answered without one, or null
	// when it did not answer at all.
	const getTag = async (url: string): Promise<string | number | null> => {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		// Node's own 10 s connect limit would cut a slow connect short of ours.
		const agent = codeHostAgent(timeoutMs);
		try {
			const res = await fetch(url, {
				signal: ctrl.signal,
				headers: { accept: 'application/json' },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lib.dom omits undici's dispatcher
				dispatcher: agent
			} as any);
			if (!res.ok) return res.status;
			const body = (await res.json()) as unknown;
			const rel = Array.isArray(body) ? body[0] : body;
			const tag = (rel as { tag_name?: unknown } | undefined)?.tag_name;
			return typeof tag === 'string' ? tag : res.status;
		} catch {
			return null;
		} finally {
			clearTimeout(t);
			closeQuietly(agent);
		}
	};

	const stable = await getTag(`${base}/releases/latest`);
	if (typeof stable === 'string') return stable;
	// No stable release (beta period): newest of any kind — only when the host
	// SAID so (404). 2026-10-08 (morphit.io): a host that did not answer was
	// asked a second time, so a 2.5 s limit took 5 s and a failure cost two waits.
	if (stable !== 404) return null;
	const any = await getTag(`${base}/releases?limit=1`);
	return typeof any === 'string' ? any : null;
}

/** Best-effort count of recent abuse flags where NEITHER named account
 *  is blocked on this instance. Loads config + DB, bounded by
 *  `timeoutMs`; returns null if anything is unavailable. */
export async function unresolvedFlagCount(timeoutMs = 2500): Promise<number | null> {
	const work = (async (): Promise<number | null> => {
		let config;
		try {
			config = loadConfig();
		} catch {
			return null; // not configured yet (pre-install menu)
		}
		let db;
		try {
			db = await createDatabase(config);
		} catch {
			return null;
		}
		try {
			const cutoff = new Date(Date.now() - FLAG_WINDOW_MS);
			const r = await db.query<{ n: number | string }>(
				`SELECT
				   (SELECT count(*) FROM suspicious_reciprocity sr
				     WHERE sr.detected_at >= $1
				       AND NOT EXISTS (SELECT 1 FROM operator_blocks ob
				                         WHERE ob.operator = $2 AND ob.state = 'blocked'
				                           AND ob.blocked IN (sr.account_a, sr.account_b)))
				 + (SELECT count(*) FROM related_accounts ra
				     WHERE ra.detected_at >= $1
				       AND NOT EXISTS (SELECT 1 FROM operator_blocks ob
				                         WHERE ob.operator = $2 AND ob.state = 'blocked'
				                           AND ob.blocked IN (ra.account_a, ra.account_b)))
				   AS n`,
				[cutoff, config.operatorAccount]
			);
			const n = r.rows[0]?.n;
			return n === undefined ? null : Number(n);
		} catch {
			return null;
		} finally {
			try {
				await db.close();
			} catch {
				/* ignore */
			}
		}
	})();

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Best-effort relay-balance health for the menu: fetch the relay
 *  account's liquid BLURT and grade it against thresholds.relayBalance
 *  (lower is worse). Bounded by `timeoutMs`; returns null if config or
 *  the chain are unavailable. Never throws. */
export async function relayBalanceStatus(
	timeoutMs = 2500
): Promise<'ok' | 'warn' | 'error' | null> {
	const work = (async (): Promise<'ok' | 'warn' | 'error' | null> => {
		let config;
		try {
			config = loadConfig();
		} catch {
			return null; // not configured yet (pre-install menu)
		}
		try {
			const acct = await lookupBlurtAccount(config.relayAccount);
			if (acct === null) return null; // account not found
			return applyThreshold(acct.balanceBlurt, config.thresholds.relayBalance);
		} catch {
			return null; // transport failure / all endpoints down
		}
	})();

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<'ok' | 'warn' | 'error' | null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function menuDirs(): { installDir: string; etcDir: string } {
	return {
		installDir: process.env.MORPHIT_INSTALL_DIR ?? DEFAULT_INSTALL_DIR,
		// MORPHIT_ENV_ROOT relocates /etc/morphit for tests, as lib/hiddenOnly does.
		etcDir: process.env.MORPHIT_ETC_DIR ?? `${process.env.MORPHIT_ENV_ROOT ?? ''}/etc/morphit`
	};
}

/** The indexer config the menu reads its listen address from (as the upgrade does). */
function menuLocalIndexer(): LocalIndexerOptions {
	const { installDir, etcDir } = menuDirs();
	return { unitEnvFiles: indexerUnitEnvFiles(installDir, etcDir) };
}

/** What decides hidden-only for the menu: the same files and rule as the upgrade. */
function menuHiddenOpts(local: LocalIndexerOptions): HiddenOnlyOptions {
	const { installDir, etcDir } = menuDirs();
	return {
		...local,
		unitEnvFiles: local.unitEnvFiles ?? indexerUnitEnvFiles(installDir, etcDir),
		configEnvPaths: [
			join(etcDir, 'indexer.env'),
			join(installDir, 'indexer.env'),
			join(etcDir, 'morphit.config.env'),
			join(installDir, 'morphit.config.env')
		]
	};
}

/** @morphit's on-chain release tag, from this node's own AUTHENTICATED indexer
 *  (the listener proven to be morphit-indexer.service, as the upgrade checks),
 *  or null. */
export async function fetchOnchainLatestVersion(
	opts: LocalIndexerOptions = menuLocalIndexer(),
	timeoutMs = MENU_ONCHAIN_TIMEOUT_MS
): Promise<string | null> {
	const tag = await readOnchainReleaseTag(opts, timeoutMs);
	return tag !== null && TAG_RE.test(tag) ? tag : null;
}

/** The newest of the tags given (nulls and non-tags skipped), or null. */
export function newestTag(tags: ReadonlyArray<string | null>): string | null {
	let best: string | null = null;
	for (const t of tags) {
		if (t === null || !TAG_RE.test(t)) continue;
		if (best === null || compareTags(t, best) > 0) best = t;
	}
	return best;
}

/** Gather all menu annotations in parallel, best-effort. Never throws. The
 *  braille spinner turns while it waits. */
export async function gatherMenuAnnotations(
	deps: {
		readonly spinner?: (label: string) => () => void;
		/** Tests: where this node's indexer is and how its listener is proven. */
		readonly localIndexer?: LocalIndexerOptions;
	} = {}
): Promise<MenuAnnotations> {
	const stop = (deps.spinner ?? ((l: string) => startDotsSpinner(l)))(
		'Checking for a newer Morphit release…'
	);
	let networkLatest: string | null;
	let unresolvedFlags: number | null;
	let relayBalance: MenuAnnotations['relayBalanceStatus'];
	const local = deps.localIndexer ?? menuLocalIndexer();
	const release = async (): Promise<string | null> => {
		// Undecidable counts as hidden-only: no clearnet request on a doubt.
		const hidden = await isHiddenOnly(menuHiddenOpts(local)).catch(() => true);
		const onchain = await fetchOnchainLatestVersion(local).catch(() => null);
		if (onchain !== null || hidden) return onchain;
		return fetchLatestVersion().catch(() => null);
	};
	try {
		[networkLatest, unresolvedFlags, relayBalance] = await Promise.all([
			release().catch(() => null),
			unresolvedFlagCount().catch(() => null),
			relayBalanceStatus().catch(() => null)
		]);
	} finally {
		stop();
	}

	// A signed offline tarball dropped by the operator counts as an available
	// release too — so the "update available" marker shows even with no network,
	// and the operator knows a cable-unplugged upgrade is ready. Newest wins.
	let latestVersion = newestTag([networkLatest]);
	let latestIsOffline = false;
	try {
		const installDir = process.env.MORPHIT_INSTALL_DIR ?? DEFAULT_INSTALL_DIR;
		const local = findLocalOfflineRelease(installDir);
		if (local !== null && (latestVersion === null || compareTags(local.tag, latestVersion) > 0)) {
			latestVersion = local.tag;
			latestIsOffline = true;
		}
	} catch {
		// best-effort; ignore
	}

	return {
		currentVersion: readCurrentVersion(),
		latestVersion,
		latestIsOffline,
		unresolvedFlags,
		relayBalanceStatus: relayBalance
	};
}
