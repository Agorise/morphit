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
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
/** `process.cwd()` throws `ENOENT: … uv_cwd` when the directory the process
 *  was started in has been removed out from under it — most often after
 *  `morphit-ops upgrade` renamed/removed the old install dir while the
 *  operator's shell was still sitting inside it (the inode is gone, so the
 *  kernel can't name the cwd). Callers must NEVER crash on that: return null
 *  and let resolution fall back to this module's own location (always inside
 *  the installed tree). Before this guard, every menu action that resolved
 *  the install root died with a raw `✗ ENOENT: no such file or directory,
 *  uv_cwd`. */
export function safeCwd(): string | null {
	try {
		return process.cwd();
	} catch {
		return null;
	}
}

export function defaultRepoRoot(): string {
	const cwd = safeCwd();
	const fromCwd = cwd !== null ? walkUpToRepoRoot(cwd) : null;
	if (fromCwd !== null && BACKUP_SEGMENT_RE.test(fromCwd)) {
		// Stale CWD from a recent upgrade — recover the live install path.
		const recoveredStart = fromCwd.replace(BACKUP_SEGMENT_RE, '');
		const recovered = walkUpToRepoRoot(recoveredStart);
		if (recovered !== fromCwd && existsSync(`${recovered}/package.json`)) {
			return recovered;
		}
		return fromCwd;
	}
	// CWD walk landed on the real monorepo root (has a `workspaces`
	// package.json): honor it.
	if (fromCwd !== null && declaresWorkspaces(`${fromCwd}/package.json`)) return fromCwd;

	// Otherwise the operator ran `morphit-ops` from OUTSIDE the install
	// tree (e.g. their home dir), so the cwd-walk fell back to the cwd,
	// which has no workspaces package.json — and instance-env loading
	// then looked for morphit.config.env in the wrong place, surfacing
	// "No database URL configured" on Status dashboard. Recover from THIS
	// module's own location, which is always inside the installed tree
	// (whether running compiled dist or from source). (cp308 #16 fix.)
	const fromModule = walkUpToRepoRoot(dirname(fileURLToPath(import.meta.url)));
	if (declaresWorkspaces(`${fromModule}/package.json`)) {
		// Apply the same stale-.bak recovery to the module path, in case
		// the binary itself is being run out of a post-upgrade backup.
		if (BACKUP_SEGMENT_RE.test(fromModule)) {
			const recovered = walkUpToRepoRoot(fromModule.replace(BACKUP_SEGMENT_RE, ''));
			if (recovered !== fromModule && declaresWorkspaces(`${recovered}/package.json`)) {
				return recovered;
			}
		}
		return fromModule;
	}
	return fromCwd ?? fromModule;
}

/**
 * True when the current working directory is stranded inside a post-
 * upgrade backup AND a live install was recovered. Commands can call this
 * to print a one-line heads-up so the operator understands why the path
 * they're acting on differs from `pwd`, and can `cd` to refresh.
 */
export function cwdStrandedInUpgradeBackup(): boolean {
	const cwd = safeCwd();
	if (cwd === null) return false;
	const fromCwd = walkUpToRepoRoot(cwd);
	if (!BACKUP_SEGMENT_RE.test(fromCwd)) return false;
	const recovered = walkUpToRepoRoot(fromCwd.replace(BACKUP_SEGMENT_RE, ''));
	return recovered !== fromCwd && existsSync(`${recovered}/package.json`);
}
