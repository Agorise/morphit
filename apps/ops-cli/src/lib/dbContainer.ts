// ─────────────────────────────────────────────────────────────────────
// Docker DB-container detection — the "Docker-aware" half of the built-in
// backup (cp509 / v1.8.4 B).
//
// The shipped backup script (ops/backup/morphit-backup.sh) dumps THROUGH
// `docker exec "$DB_CONTAINER" pg_dump …` when DB_CONTAINER is set, so a
// containerized Postgres (a BunkerWeb / docker-compose Postgres — e.g. Ken's
// `bunkerweb-db-1`, postgres:16-alpine) is backed up correctly instead of a
// host `pg_dump` finding nothing. This module is how the wizard (install) and
// `morphit-ops upgrade` (every upgrade) DISCOVER that container name, so the
// operator never has to know it.
//
// Detection is name-AGNOSTIC (the same lesson as findFrontendContainer in
// upgrade.ts — cp236 hard-coded a container name and a compose file and was
// wrong on both counts): we look at the image + whether the morphit DB is
// actually reachable inside, never at a specific name.
//
// The pure parsing/selection cores (parseContainerNames / isPostgresImage /
// selectDbContainer) carry the real logic and are covered by static smokes;
// the impure orchestrator (detectDbContainer) is a thin `docker` wrapper that
// the sandbox can't exercise (no Docker), so it stays deliberately trivial.
// ─────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/** Read MORPHIT_INDEXER_DATABASE_URL out of the deployed `morphit.env` in
 *  `installDir`, so a post-install flow (harden, upgrade) can resolve the
 *  operator's REAL database identity without re-asking. Read-only — parses the
 *  file directly, never mutates process.env. Returns undefined when the file is
 *  absent/unreadable or the key isn't set. IMPURE; never throws. */
export function readDeployedDatabaseUrl(installDir: string): string | undefined {
	try {
		const envPath = join(installDir, 'morphit.env');
		if (!existsSync(envPath)) return undefined;
		const parsed = parseEnv(readFileSync(envPath, 'utf-8'));
		const url = parsed.MORPHIT_INDEXER_DATABASE_URL;
		return typeof url === 'string' && url !== '' ? url : undefined;
	} catch {
		return undefined;
	}
}

/** The morphit indexer database name + authenticating user, resolved for the
 *  backup. Primary source is the running config's connection URL
 *  (MORPHIT_INDEXER_DATABASE_URL, parsed by {@link dbIdentityFromUrl}); these
 *  init.sql-default constants are the FALLBACK when that URL is absent or
 *  unparseable. Shared by the backup.env renderer (render.ts) and the
 *  Docker-container detection below so the name the DB-existence probe checks
 *  always matches the name the backup will dump. */
export const BACKUP_DB_NAME = 'morphit_indexer';
export const BACKUP_DB_USER = 'morphit_indexer';

/** A resolved (database name, authenticating user) pair. */
export interface DbIdentity {
	readonly dbName: string;
	readonly dbUser: string;
}

/** Parse a Postgres connection URL for the authenticating user + database
 *  name, so the backup targets the operator's ACTUAL database rather than the
 *  init.sql defaults (e.g. a BunkerWeb box on `morphit_user`/`morphit_db`).
 *  `postgres://USER:PASS@HOST:PORT/DBNAME?params` → { dbUser: USER, dbName:
 *  DBNAME }. Returns null when the string isn't a postgres URL or is missing
 *  either the user or the database, so callers fall back to the defaults.
 *  Values are percent-decoded. PURE. */
export function dbIdentityFromUrl(databaseUrl: string): DbIdentity | null {
	try {
		const u = new URL(databaseUrl.trim());
		if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null;
		const dbUser = decodeURIComponent(u.username);
		// pathname is "/dbname" (query params live in u.search, not here); strip
		// the leading slash and decode. Guard a trailing-slash / empty path.
		const dbName = decodeURIComponent(u.pathname.replace(/^\/+/, '').split('/')[0] ?? '');
		if (dbUser === '' || dbName === '') return null;
		return { dbName, dbUser };
	} catch {
		return null;
	}
}

/** Parse `docker ps --format '{{.Names}}'` stdout into a clean name list.
 *  PURE. */
export function parseContainerNames(psStdout: string): string[] {
	return psStdout
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Does an image reference look like a Postgres (or Postgres-family) image?
 *  Matches the common forms — `postgres`, `postgres:16-alpine`,
 *  `library/postgres`, `registry.example.com/postgres:16`, `bitnami/postgresql`
 *  — plus the mainstream Postgres-SERVER derivatives an operator might run the
 *  indexer DB on (`postgis/postgis`, `timescale/timescaledb`). Tested by a
 *  Postgres-family token anywhere in the reference, case-insensitive. This is
 *  only a cheap PRE-FILTER (avoids probing every container); the authoritative
 *  check is the in-container DB-existence probe. PURE. */
export function isPostgresImage(image: string): boolean {
	return /postgres(ql)?|postgis|timescale/i.test(image);
}

/** A container considered as a possible morphit-DB host. */
export interface DbContainerCandidate {
	readonly name: string;
	readonly image: string;
	/** Tri-state result of probing whether the morphit DB is reachable inside
	 *  this container via the trust/peer path the backup will use:
	 *    true  — the DB exists + is reachable (strong match),
	 *    false — the container answered but the DB is NOT there (reject),
	 *    null  — the probe was inconclusive (probe not run / errored / DB not
	 *            created yet on a fresh install). */
	readonly dbPresent: boolean | null;
}

/** Choose the morphit-DB container from the candidates.  Selection order:
 *   1. Any candidate with a Postgres image where dbPresent === true — the DB
 *      is provably inside it. If several (unusual), the FIRST such wins
 *      (docker ps order); a duplicate morphit DB across two live Postgres
 *      containers is a misconfiguration we don't try to arbitrate.
 *   2. Otherwise, if there is EXACTLY ONE Postgres-image candidate and its
 *      probe was inconclusive (dbPresent !== false) — a fresh install where
 *      the DB isn't created yet, or an environment where the probe couldn't
 *      run — fall back to that sole candidate. A single Postgres container on
 *      a morphit host is overwhelmingly the DB.
 *   3. Otherwise null (no Postgres container, or the only matches were
 *      explicitly rejected, or the choice is ambiguous among ≥2 inconclusive
 *      candidates — better to leave DB_CONTAINER unset than guess wrong).
 *  PURE. */
export function selectDbContainer(candidates: readonly DbContainerCandidate[]): string | null {
	const pg = candidates.filter((c) => isPostgresImage(c.image));
	const present = pg.find((c) => c.dbPresent === true);
	if (present) return present.name;
	const notRejected = pg.filter((c) => c.dbPresent !== false);
	const sole = notRejected.length === 1 ? notRejected[0] : undefined;
	if (sole) return sole.name;
	return null;
}

/** Is `docker` usable on this host? IMPURE. (Mirrors upgrade.ts's helper; kept
 *  local so this module has no cross-command import.) */
function dockerUsable(): boolean {
	return spawnSync('docker', ['--version'], { stdio: 'pipe', timeout: 3000 }).status === 0;
}

/** Best-effort `docker inspect` of a container's image reference. IMPURE. */
function containerImage(name: string): string {
	const insp = spawnSync('docker', ['inspect', '--format', '{{.Config.Image}}', name], {
		stdio: 'pipe',
		timeout: 5000,
		encoding: 'utf8'
	});
	return insp.status === 0 ? (insp.stdout ?? '').trim() : '';
}

/** Probe whether database `dbName` exists inside container `name`, reachable
 *  as `dbUser` via the container-local socket (trust/peer auth — the exact
 *  path the backup's `docker exec … pg_dump` will use). Returns true/false, or
 *  null when the probe itself couldn't run (psql missing, exec errored). The
 *  query is a parameter-free existence check against pg_database. IMPURE. */
function probeDbPresent(name: string, dbUser: string, dbName: string): boolean | null {
	const res = spawnSync(
		'docker',
		[
			'exec',
			name,
			'psql',
			'-U',
			dbUser,
			'-tAc',
			`SELECT 1 FROM pg_database WHERE datname='${dbName}'`
		],
		{ stdio: 'pipe', timeout: 8000, encoding: 'utf8' }
	);
	// A non-zero exit can mean "psql not present / auth failed / server down"
	// (inconclusive → null) rather than "DB absent" — we only treat a clean
	// exit as authoritative.
	if (res.status !== 0) return null;
	return (res.stdout ?? '').trim() === '1';
}

/** Detect the Docker container running the morphit Postgres, for the
 *  Docker-aware backup path.  Returns the container name, or null when docker
 *  is absent or no Postgres container is found. Never throws.  IMPURE — the
 *  thin orchestration over the pure cores above. */
export function detectDbContainer(dbUser: string, dbName: string): string | null {
	if (!dockerUsable()) return null;
	const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], {
		stdio: 'pipe',
		timeout: 5000,
		encoding: 'utf8'
	});
	if (ps.status !== 0) return null;
	const names = parseContainerNames(ps.stdout ?? '');
	const candidates: DbContainerCandidate[] = [];
	for (const name of names) {
		const image = containerImage(name);
		if (!isPostgresImage(image)) continue; // skip the non-Postgres probe cost
		candidates.push({ name, image, dbPresent: probeDbPresent(name, dbUser, dbName) });
	}
	return selectDbContainer(candidates);
}

// ─── Every-upgrade Docker-aware drift check (pure cores) ───────────────
// `morphit-ops upgrade` re-checks that a configured backup stays Docker-aware
// across upgrades: if the operator's Postgres is containerized but their
// backup.env still routes the dump at a HOST pg_dump (DB_CONTAINER empty), the
// daily backup silently captures nothing. We detect that drift and warn with
// the exact one-line fix (consistent with the upgrade flow's warn-don't-mutate
// posture — we never auto-edit the operator's root-owned /etc config).

/** Extract the DB_CONTAINER value from backup.env text — '' when the line is
 *  absent or set empty. Strips one layer of surrounding quotes. PURE. */
export function parseBackupDbContainer(backupEnvText: string): string {
	for (const line of backupEnvText.split('\n')) {
		const m = line.match(/^\s*DB_CONTAINER\s*=\s*(.*)$/);
		if (m) {
			return (m[1] ?? '')
				.trim()
				.replace(/^(['"])(.*)\1$/, '$2')
				.trim();
		}
	}
	return '';
}

/** Verdict for the every-upgrade Docker-aware backup check. */
export type BackupDockerVerdict =
	| { readonly kind: 'ok' }
	| { readonly kind: 'drift'; readonly container: string };

/** Decide whether a configured backup has Docker-drift. PURE.
 *   - backupConfigured=false      → 'ok' (no backup.env, or unreadable — not
 *                                    something to nag about on every upgrade).
 *   - DB_CONTAINER already set     → 'ok' (already Docker-aware).
 *   - no container detected        → 'ok' (host Postgres; host pg_dump correct).
 *   - container detected + empty    → 'drift' (the actionable case: the DB is
 *                                    containerized but the backup dumps the host). */
export function assessBackupDockerDrift(
	backupConfigured: boolean,
	dbContainerConfigured: string,
	detectedContainer: string | null
): BackupDockerVerdict {
	if (!backupConfigured) return { kind: 'ok' };
	if (dbContainerConfigured.trim() !== '') return { kind: 'ok' };
	if (detectedContainer === null) return { kind: 'ok' };
	return { kind: 'drift', container: detectedContainer };
}
