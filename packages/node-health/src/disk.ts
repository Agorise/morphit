/**
 * @morphit/node-health — health disk-path resolution (PURE).
 *
 * WHY THIS EXISTS (cp708).  The health "disk" figure (in both the
 * `morphit-ops` health view and the public /v1/health `system` block)
 * used to `statfs('/')` unconditionally.  On a single-volume box —
 * morphit.io — that's correct: the DB, IPFS repo, and backups all live
 * on `/`.  But on a SPLIT-VOLUME node (a dedicated data mount holding
 * Postgres / the chain index — the unbounded grower), `/` can sit at a
 * comfortable 30% while the data volume is minutes from full, and the
 * health figure would cheerfully report the wrong filesystem.
 *
 * The fix: measure the filesystem that holds the node's DATA, chosen by
 * `MORPHIT_HEALTH_DISK_PATH`, defaulting to `/`.  Single-volume boxes
 * are unaffected (the default resolves to the same mount).  The guided
 * ansible install sets `MORPHIT_HEALTH_DISK_PATH` to the Postgres data
 * directory's parent (`/var/lib/postgresql` by default), so a
 * split-volume node reports its DATA volume out of the box.  A manual /
 * dockerised install (morphit.io) leaves it unset → `/` → correct.
 *
 * This resolver is PURE (string in, string out).  The caller does the
 * `statfs`; if the configured path can't be stat'd it falls back to `/`
 * so a stray env value can never blank the disk figure.
 */

/** The env var operators / ansible set to point the health disk figure
 *  at the node's data volume.  A single absolute path.  Unset → `/`. */
export const HEALTH_DISK_PATH_ENV = 'MORPHIT_HEALTH_DISK_PATH';

/** The always-present fallback: the root filesystem. */
export const DEFAULT_HEALTH_DISK_PATH = '/';

/**
 * Resolve the filesystem path whose usage the health disk figure should
 * report.  PURE.
 *
 * - `MORPHIT_HEALTH_DISK_PATH` set to a non-empty, absolute path → use it.
 * - Anything else (unset, empty, whitespace, or a non-absolute value that
 *   could be a shell artefact) → `/`.
 *
 * Only ABSOLUTE paths are honoured: a relative path would resolve against
 * the indexer's cwd (unpredictable under systemd) and measure the wrong
 * mount, so we ignore it and fall back to `/` rather than guess.
 */
export function resolveHealthDiskPath(env: Readonly<Record<string, string | undefined>>): string {
	const raw = env[HEALTH_DISK_PATH_ENV];
	if (typeof raw !== 'string') return DEFAULT_HEALTH_DISK_PATH;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return DEFAULT_HEALTH_DISK_PATH;
	if (!trimmed.startsWith('/')) return DEFAULT_HEALTH_DISK_PATH;
	return trimmed;
}
