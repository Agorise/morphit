/**
 * Resolve the Morphit install (repo) root for `morphit-ops` commands.
 *
 * This was previously copy-pasted (and had drifted into four variants)
 * across altAddress / exportAltnetKey / importAltnetKey / harden / edit /
 * init. It now lives here so there is one definition with one behaviour.
 *
 * ── Why this is subtle: the post-upgrade stale-CWD trap ──────────────
 *
 * `morphit-ops upgrade` RENAMES the live install directory to
 * `<install>.bak-<epoch-ms>` before extracting a fresh tree into
 * `<install>`. A shell (or any process) that was sitting inside the
 * install when the upgrade ran keeps a working directory that now points
 * INTO that backup — bash still PRINTS the old path in its prompt, but
 * `process.cwd()` (and the kernel) resolve it to `…/<install>.bak-<ts>/…`.
 *
 * A naive "walk up from cwd to the repo root" therefore resolves every
 * config path into the backup directory, and the operator sees errors
 * like `No morphit.config.env found at /opt/morphit.bak-1781151799741/…`
 * even though their instance is perfectly healthy under `/opt/morphit`.
 *
 * So: after the cwd walk, if the result still contains a `.bak-<ts>`
 * segment, we strip it, re-walk from the recovered path, and — only if
 * that yields a real install (has a package.json) — use it instead.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Matches an upgrade-backup path segment like `.bak-1781151799741`. */
const BACKUP_SEGMENT_RE = /\.bak-\d+(?=\/|$)/;

/** True if the package.json at `pkgPath` declares a `workspaces` field —
 *  the marker for the monorepo root (workspace members do not). */
function declaresWorkspaces(pkgPath: string): boolean {
	try {
		const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf-8'));
		return typeof parsed === 'object' && parsed !== null && 'workspaces' in parsed;
	} catch {
		return false;
	}
}

/**
 * Walk up from `start` to the Morphit monorepo root.
 *
 * The root is identified by its `workspaces` field — NOT by "the topmost
 * package.json whose parent has none", because `apps/` has no package.json
 * and breaks that chain: a previous version walked up from `apps/relay` and
 * stopped AT `apps/relay` (its parent `apps/` has no package.json), yielding
 * the relay app dir instead of the repo root. So this scans every ancestor,
 * returns the first that declares `workspaces`, and otherwise falls back to
 * the highest ancestor that has any package.json (then to `start`).
 */
function walkUpToRepoRoot(start: string): string {
	let dir = start;
	let highestPkg: string | null = null;
	for (let i = 0; i < 24; i++) {
		const pkg = `${dir}/package.json`;
		if (existsSync(pkg)) {
			if (declaresWorkspaces(pkg)) return dir; // the monorepo root
			highestPkg = dir; // fallback: remember the highest package.json dir
		}
		const parent = resolve(dir, '..');
		if (parent === dir) break; // filesystem root
		dir = parent;
	}
	return highestPkg ?? start;
}

/**
 * Resolve the install root from the current working directory, recovering
 * automatically if the cwd is stranded in a post-upgrade `.bak-<ts>`
 * backup (see file header).
 */
export function defaultRepoRoot(): string {
	const fromCwd = walkUpToRepoRoot(process.cwd());
	if (!BACKUP_SEGMENT_RE.test(fromCwd)) return fromCwd;

	// Stale CWD from a recent upgrade — recover the live install path.
	const recoveredStart = fromCwd.replace(BACKUP_SEGMENT_RE, '');
	const recovered = walkUpToRepoRoot(recoveredStart);
	if (recovered !== fromCwd && existsSync(`${recovered}/package.json`)) {
		return recovered;
	}
	return fromCwd;
}

/**
 * True when the current working directory is stranded inside a post-
 * upgrade backup AND a live install was recovered. Commands can call this
 * to print a one-line heads-up so the operator understands why the path
 * they're acting on differs from `pwd`, and can `cd` to refresh.
 */
export function cwdStrandedInUpgradeBackup(): boolean {
	const fromCwd = walkUpToRepoRoot(process.cwd());
	if (!BACKUP_SEGMENT_RE.test(fromCwd)) return false;
	const recovered = walkUpToRepoRoot(fromCwd.replace(BACKUP_SEGMENT_RE, ''));
	return recovered !== fromCwd && existsSync(`${recovered}/package.json`);
}
