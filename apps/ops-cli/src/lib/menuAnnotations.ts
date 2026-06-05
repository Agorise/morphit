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
 *   - latestVersion: the newest release tag from Forgejo, via a short-
 *     timeout fetch (own lightweight fetcher — NOT upgrade's 30s one).
 *   - unresolvedFlags: recent abuse flags where NEITHER named account
 *     is blocked on this instance (i.e. the operator hasn't acted) —
 *     best-effort DB read, null if config/DB unavailable.
 *   - relayBalanceStatus: the relay account's liquid BLURT graded
 *     against thresholds.relayBalance ('warn'/'error' when running low),
 *     via a short-timeout chain read; null if config/chain unavailable.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, applyThreshold } from '../config.ts';
import { createDatabase } from '../db.ts';
import { lookupBlurtAccount } from '../init/chainCheck.ts';

export interface MenuAnnotations {
	readonly currentVersion: string | null;
	readonly latestVersion: string | null;
	readonly unresolvedFlags: number | null;
	readonly relayBalanceStatus: 'ok' | 'warn' | 'error' | null;
}

const DEFAULT_INSTALL_DIR = '/opt/morphit';
const DEFAULT_RELEASE_HOST = 'git.agorise.net';
const DEFAULT_RELEASE_REPO = 'agorise/morphit';
const FLAG_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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

/** Newest release tag from Forgejo, bounded by `timeoutMs`. Returns
 *  null on any error/timeout. Prefers /releases/latest (stable), falls
 *  back to the newest release of any kind. */
export async function fetchLatestVersion(timeoutMs = 2500): Promise<string | null> {
	const host = process.env.MORPHIT_RELEASE_HOST ?? DEFAULT_RELEASE_HOST;
	const repo = process.env.MORPHIT_RELEASE_REPO ?? DEFAULT_RELEASE_REPO;
	const base = `https://${host}/api/v1/repos/${repo}`;

	const getTag = async (url: string): Promise<string | null> => {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
			if (!res.ok) return null;
			const body = (await res.json()) as unknown;
			const rel = Array.isArray(body) ? body[0] : body;
			const tag = (rel as { tag_name?: unknown } | undefined)?.tag_name;
			return typeof tag === 'string' ? tag : null;
		} catch {
			return null;
		} finally {
			clearTimeout(t);
		}
	};

	const stable = await getTag(`${base}/releases/latest`);
	if (stable !== null) return stable;
	// No stable release (beta period): newest of any kind.
	return getTag(`${base}/releases?limit=1`);
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
				[cutoff, config.officialAccount]
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
export async function relayBalanceStatus(timeoutMs = 2500): Promise<'ok' | 'warn' | 'error' | null> {
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

/** Gather all menu annotations in parallel, best-effort. Never throws. */
export async function gatherMenuAnnotations(): Promise<MenuAnnotations> {
	const [latestVersion, unresolvedFlags, relayBalance] = await Promise.all([
		fetchLatestVersion().catch(() => null),
		unresolvedFlagCount().catch(() => null),
		relayBalanceStatus().catch(() => null)
	]);
	return {
		currentVersion: readCurrentVersion(),
		latestVersion,
		unresolvedFlags,
		relayBalanceStatus: relayBalance
	};
}
