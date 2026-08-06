/**
 * db-container-detect-smoke (cp509 / v1.8.4 B)
 *
 * The built-in DB backup is now Docker-aware: the shipped
 * ops/backup/morphit-backup.sh dumps THROUGH `docker exec
 * "$DB_CONTAINER" pg_dump …` when DB_CONTAINER is set, and the wizard
 * (install) + `morphit-ops upgrade` (every upgrade) AUTO-DETECT that
 * container so the operator never has to know its name.
 *
 * The live detection (detectDbContainer) shells out to `docker`, which
 * the sandbox has no way to exercise, so — as required — this is a STATIC
 * smoke over the PURE cores that carry the real logic:
 *   1. parseContainerNames  — `docker ps` stdout → clean name list.
 *   2. isPostgresImage      — image-reference → is-Postgres.
 *   3. selectDbContainer    — candidate list → chosen container (or null),
 *      including the "provably-inside" vs "sole-candidate fallback" vs
 *      "ambiguous → null" branches.
 *   4. parseBackupDbContainer — backup.env text → DB_CONTAINER value.
 *   5. assessBackupDockerDrift — the every-upgrade drift verdict.
 *
 * What must never regress: a single containerized Postgres is found; a
 * host-only box yields null (host pg_dump path); an explicitly-rejected DB
 * is never chosen; and the upgrade drift check fires ONLY when a container
 * is detected AND DB_CONTAINER is empty AND a backup is configured.
 */

import {
	parseContainerNames,
	isPostgresImage,
	selectDbContainer,
	parseBackupDbContainer,
	assessBackupDockerDrift,
	dbIdentityFromUrl,
	type DbContainerCandidate
} from '../src/lib/dbContainer.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}`);
	}
}

// ─── parseContainerNames ──────────────────────────────────────────
check(
	'parseContainerNames splits + trims + drops blanks',
	JSON.stringify(parseContainerNames('bunkerweb-db-1\n morphit-web \n\nredis\n')) ===
		JSON.stringify(['bunkerweb-db-1', 'morphit-web', 'redis'])
);
check('parseContainerNames on empty → []', parseContainerNames('').length === 0);

// ─── isPostgresImage ──────────────────────────────────────────────
check('isPostgresImage: bare postgres', isPostgresImage('postgres'));
check('isPostgresImage: postgres:16-alpine', isPostgresImage('postgres:16-alpine'));
check('isPostgresImage: registry-qualified', isPostgresImage('registry.example.com/library/postgres:16'));
check('isPostgresImage: postgresql variant', isPostgresImage('bitnami/postgresql:16'));
check('isPostgresImage: postgis derivative', isPostgresImage('postgis/postgis:16-3.4'));
check('isPostgresImage: NOT redis', !isPostgresImage('redis:7-alpine'));
check('isPostgresImage: NOT nginx', !isPostgresImage('nginx:1.27'));

// ─── selectDbContainer ────────────────────────────────────────────
const soleProvable: DbContainerCandidate[] = [
	{ name: 'redis', image: 'redis:7', dbPresent: null },
	{ name: 'bunkerweb-db-1', image: 'postgres:16-alpine', dbPresent: true }
];
check("selectDbContainer picks the postgres container with the DB present", selectDbContainer(soleProvable) === 'bunkerweb-db-1');

const soleInconclusive: DbContainerCandidate[] = [
	{ name: 'web', image: 'nginx', dbPresent: null },
	{ name: 'db', image: 'postgres:16', dbPresent: null } // fresh install: DB not created yet
];
check('selectDbContainer falls back to the SOLE postgres candidate when the probe is inconclusive', selectDbContainer(soleInconclusive) === 'db');

const hostOnly: DbContainerCandidate[] = [
	{ name: 'web', image: 'nginx', dbPresent: null },
	{ name: 'cache', image: 'redis:7', dbPresent: null }
];
check('selectDbContainer → null when there is NO postgres container (host Postgres)', selectDbContainer(hostOnly) === null);

const rejected: DbContainerCandidate[] = [
	{ name: 'other-app-db', image: 'postgres:15', dbPresent: false } // a DIFFERENT app's postgres, morphit DB not in it
];
check('selectDbContainer → null when the only postgres candidate is explicitly rejected', selectDbContainer(rejected) === null);

const twoInconclusive: DbContainerCandidate[] = [
	{ name: 'pg-a', image: 'postgres:16', dbPresent: null },
	{ name: 'pg-b', image: 'postgres:15', dbPresent: null }
];
check('selectDbContainer → null when ambiguous (≥2 inconclusive postgres candidates)', selectDbContainer(twoInconclusive) === null);

const twoOneProvable: DbContainerCandidate[] = [
	{ name: 'pg-a', image: 'postgres:16', dbPresent: null },
	{ name: 'pg-b', image: 'postgres:15', dbPresent: true } // morphit DB is provably in pg-b
];
check('selectDbContainer prefers the provable one even amid multiple postgres containers', selectDbContainer(twoOneProvable) === 'pg-b');

check('selectDbContainer on empty candidate list → null', selectDbContainer([]) === null);

// ─── parseBackupDbContainer ───────────────────────────────────────
check(
	'parseBackupDbContainer reads a bare value',
	parseBackupDbContainer('BACKUP_DIR=/x\nDB_CONTAINER=bunkerweb-db-1\nRETAIN_DAYS=30') === 'bunkerweb-db-1'
);
check('parseBackupDbContainer: empty assignment → ""', parseBackupDbContainer('DB_CONTAINER=') === '');
check('parseBackupDbContainer: absent line → ""', parseBackupDbContainer('BACKUP_DIR=/x\nRETAIN_DAYS=30') === '');
check("parseBackupDbContainer strips single quotes", parseBackupDbContainer("DB_CONTAINER='my-db'") === 'my-db');
check('parseBackupDbContainer strips double quotes', parseBackupDbContainer('DB_CONTAINER="my-db"') === 'my-db');
check('parseBackupDbContainer tolerates surrounding whitespace', parseBackupDbContainer('  DB_CONTAINER =  my-db  ') === 'my-db');

// ─── assessBackupDockerDrift ──────────────────────────────────────
check(
	'drift: containerized DB + empty DB_CONTAINER + backup configured → drift',
	JSON.stringify(assessBackupDockerDrift(true, '', 'bunkerweb-db-1')) ===
		JSON.stringify({ kind: 'drift', container: 'bunkerweb-db-1' })
);
check(
	'no drift: DB_CONTAINER already set → ok',
	assessBackupDockerDrift(true, 'bunkerweb-db-1', 'bunkerweb-db-1').kind === 'ok'
);
check(
	'no drift: host Postgres (no container detected) → ok',
	assessBackupDockerDrift(true, '', null).kind === 'ok'
);
check(
	'no drift: backup not configured → ok (never nag)',
	assessBackupDockerDrift(false, '', 'bunkerweb-db-1').kind === 'ok'
);
check(
	'no drift: whitespace-only DB_CONTAINER treated as set-enough is NOT — empty after trim triggers drift',
	assessBackupDockerDrift(true, '   ', 'bunkerweb-db-1').kind === 'drift'
);

// ─── dbIdentityFromUrl (real DB name/user from the connection URL) ──
check(
	'dbIdentityFromUrl: standard user:pass@host:port/db',
	JSON.stringify(dbIdentityFromUrl('postgres://morphit:secret@localhost:5432/morphit_indexer')) ===
		JSON.stringify({ dbName: 'morphit_indexer', dbUser: 'morphit' })
);
check(
	"dbIdentityFromUrl: Ken's BunkerWeb box (morphit_user/morphit_db)",
	JSON.stringify(dbIdentityFromUrl('postgresql://morphit_user:p@172.18.0.4:5432/morphit_db')) ===
		JSON.stringify({ dbName: 'morphit_db', dbUser: 'morphit_user' })
);
check(
	'dbIdentityFromUrl: peer auth (no password)',
	JSON.stringify(dbIdentityFromUrl('postgres://morphit@127.0.0.1/morphit')) ===
		JSON.stringify({ dbName: 'morphit', dbUser: 'morphit' })
);
check(
	'dbIdentityFromUrl: query params ignored (db name is the path, not the query)',
	JSON.stringify(dbIdentityFromUrl('postgres://u:p@h:5432/mydb?sslmode=require')) ===
		JSON.stringify({ dbName: 'mydb', dbUser: 'u' })
);
check(
	'dbIdentityFromUrl: percent-encoded user is decoded',
	dbIdentityFromUrl('postgres://user%40realm:p@h/db')?.dbUser === 'user@realm'
);
check('dbIdentityFromUrl: non-postgres URL → null', dbIdentityFromUrl('mysql://u:p@h/db') === null);
check('dbIdentityFromUrl: garbage → null', dbIdentityFromUrl('not a url') === null);
check('dbIdentityFromUrl: missing db name → null', dbIdentityFromUrl('postgres://u:p@h:5432/') === null);
check('dbIdentityFromUrl: missing user → null', dbIdentityFromUrl('postgres://@h:5432/db') === null);

console.log('');
if (failed === 0) {
	console.log(`✓ all ${passed} db-container-detect scenarios passed`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} of ${passed + failed} db-container-detect scenarios FAILED`);
	process.exit(1);
}
