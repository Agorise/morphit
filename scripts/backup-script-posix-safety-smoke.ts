#!/usr/bin/env tsx
/**
 * backup-script-posix-safety — cp514 (post-v1.8.7, found live on Ken's VPS).
 *
 * THE BUG THIS EXISTS TO CATCH. `ops/backup/morphit-backup.sh` is `#!/bin/sh`,
 * which on every Debian/Ubuntu host is DASH. It carried:
 *
 *     ( set -o pipefail 2>/dev/null || true ) >/dev/null
 *
 * `pipefail` is not POSIX and dash rejects it. `set` is a SPECIAL builtin, so
 * dash exits the shell IMMEDIATELY on a bad option — it never reaches the
 * `|| true`, and the failing subshell's status then trips the parent's
 * `set -e`. The `2>/dev/null` swallowed the one diagnostic. Net effect: the
 * script exited 2, silently, BEFORE pg_dump ever ran — so the built-in
 * Docker-aware backup shipped in v1.8.4 never produced a single dump on any
 * Ubuntu box. Ken hit it as a bare `status=2/INVALIDARGUMENT` with no message.
 *
 * WHY NOTHING CAUGHT IT: the backup work shipped with STATIC smokes only —
 * nothing ever EXECUTED the script, and `sh -n` parses it fine (it's a runtime
 * option error, not a syntax error). So this smoke actually runs the guard
 * under dash.
 *
 * Tamper tests (each must turn this red):
 *   - Restore the `( set -o pipefail 2>/dev/null || true )` form → fails.
 *   - Drop the `if ( ... ); then` condition context → fails.
 *   - Any new bare `set -o pipefail` at top level → fails.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SCRIPT = join(REPO, 'ops/backup/morphit-backup.sh');
const src = readFileSync(SCRIPT, 'utf8');
/** Comment lines are stripped for the anti-pattern checks: the fix's own
 *  explanatory comment necessarily QUOTES the broken form it replaced, and a
 *  naive scan of the whole file would flag that documentation as the bug. */
const code = src
	.split('\n')
	.filter((l) => !/^\s*#/.test(l))
	.join('\n');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── backup-script-posix-safety (cp514) ────────────────\n');

check(
	'the broken `|| true` pipefail guard is gone',
	!/\(\s*set -o pipefail\s+2>\/dev\/null\s*\|\|\s*true\s*\)/.test(code),
	'a special-builtin failure in dash exits before `|| true` is ever evaluated'
);
check(
	'pipefail is probed inside an `if` CONDITION (where set -e is suppressed)',
	/if \( set -o pipefail \) 2>\/dev\/null; then/.test(src),
	'only a condition context survives dash exiting the probe subshell'
);
check(
	'no unguarded top-level `set -o pipefail`',
	!/^set -o pipefail/m.test(code),
	'a bare pipefail kills the script outright under dash'
);

// The real proof: run the guard AS WRITTEN under dash with the script's own
// `set -eu`, and confirm execution continues past it.
const guard = /if \( set -o pipefail \) 2>\/dev\/null; then\s*\n\s*set -o pipefail\s*\n\s*fi/.exec(src);
check('the guard block is present verbatim to execute', guard !== null);
if (guard) {
	for (const shell of ['dash', 'sh', 'bash']) {
		let ok = false;
		let out = '';
		try {
			out = execFileSync(shell, ['-c', `set -eu\n${guard[0]}\necho REACHED`], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe']
			});
			ok = out.includes('REACHED');
		} catch (err) {
			ok = false;
			out = String((err as { stderr?: string }).stderr ?? err);
		}
		check(
			`execution continues past the guard under ${shell} (reaches the dump step)`,
			ok,
			`the script would exit before pg_dump — silent, backup-less. got: ${out.trim().slice(0, 120)}`
		);
	}
}

// Whole-file parse under the shebang's own interpreter.
try {
	execFileSync('sh', ['-n', SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
	check('morphit-backup.sh parses clean under /bin/sh', true);
} catch (err) {
	check('morphit-backup.sh parses clean under /bin/sh', false, String(err));
}

/* ────────────────────────────────────────────────────────────────────
 * cp526 — THE SECOND, DEEPER BUG IN THE SAME LINE OF DEFENCE.
 *
 * cp514 (above) proved the script no longer DIES at the pipefail probe.
 * It did not prove the script NOTICES A FAILED DUMP — and it did not,
 * because the probe is FALSE on the platform we target: Debian/Ubuntu
 * build dash WITHOUT pipefail. So `pg_dump | gzip` reported gzip's 0,
 * `set -e` saw a clean run, and the `-s` emptiness guard could not help
 * because gzip-of-a-failed-dump is a valid ~20-byte member. A refused DB
 * connection wrote 20 bytes, renamed it to a real backup name, printed
 * "wrote ... (20 bytes)" and exited 0 — which `morphit-ops health` then
 * reported as a FRESH backup. The v1.8.9 freshness alarm, added to catch
 * "no backups at all", was silenced by garbage backups.
 *
 * The only thing that can see this is EXECUTING THE WHOLE SCRIPT with a
 * failing pg_dump under BOTH shells. Static greps and the guard-snippet
 * run above are both blind to it. Same lesson as cp514, one layer down:
 * prove the behaviour, not the syntax.
 *
 * Tamper tests (each must turn this red):
 *   - Drop the `$DUMP_STATUS` capture → A/B/docker scenarios fail.
 *   - Revert the size guard to a bare `[ ! -s "$TMPFILE" ]` → C fails.
 *   - Break the happy path → D fails.
 * ──────────────────────────────────────────────────────────────────── */
const shellsToProve = ['dash', 'bash'];

/** Run the REAL script in an isolated dir with a scripted fake pg_dump. */
const runScript = (
	shell: string,
	pgDumpBody: string,
	extraEnvLines: string[] = [],
	extraBins: Record<string, string> = {}
): { code: number; kept: number; out: string } => {
	const root = mkdtempSync(join(tmpdir(), 'morphit-backup-smoke-'));
	try {
		const bin = join(root, 'bin');
		const backups = join(root, 'backups');
		mkdirSync(bin, { recursive: true });
		mkdirSync(backups, { recursive: true });
		writeFileSync(join(bin, 'pg_dump'), pgDumpBody, { mode: 0o755 });
		for (const [name, body] of Object.entries(extraBins)) {
			writeFileSync(join(bin, name), body, { mode: 0o755 });
		}
		const envFile = join(root, 'backup.env');
		writeFileSync(
			envFile,
			[
				`BACKUP_DIR=${backups}`,
				'RETAIN_DAYS=30',
				'DB_NAME=morphit_db',
				'DB_USER=morphit_user',
				...extraEnvLines
			].join('\n') + '\n'
		);

		let code = 0;
		let out = '';
		try {
			out = execFileSync(shell, [SCRIPT], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ''}`,
					BACKUP_ENV: envFile
				}
			});
		} catch (err) {
			const e = err as { status?: number; stdout?: string; stderr?: string };
			code = e.status ?? 1;
			out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
		}
		// Count only FINAL backup names — a leftover `.partial` is not a backup.
		const kept = readdirSync(backups).filter((f) => /\.sql\.gz(\.age)?$/.test(f)).length;
		return { code, kept, out };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

const FAIL_SILENT = '#!/bin/sh\necho "pg_dump: error: connection to server failed" >&2\nexit 1\n';
const FAIL_PARTIAL = '#!/bin/sh\necho "-- partial dump"\necho "CREATE TABLE orders();"\nexit 1\n';
const OK_BUT_EMPTY = '#!/bin/sh\nexit 0\n';
const HEALTHY = '#!/bin/sh\necho "-- dump $*"\necho "CREATE TABLE orders();"\n';

for (const shell of shellsToProve) {
	// A — the exact shape Ken's box would hit if the DB were unreachable.
	const a = runScript(shell, FAIL_SILENT);
	check(
		`[${shell}] a pg_dump that fails with NO output keeps no backup`,
		a.code !== 0 && a.kept === 0,
		`exit=${a.code} kept=${a.kept} — a failed dump was banked as a real backup`
	);

	// B — the common real-world case: dump dies partway, gzip still succeeds.
	const b = runScript(shell, FAIL_PARTIAL);
	check(
		`[${shell}] a pg_dump that fails MID-dump keeps no backup`,
		b.code !== 0 && b.kept === 0,
		`exit=${b.code} kept=${b.kept} — a TRUNCATED dump was banked as a real backup`
	);

	// C — exit 0 with no rows: what the old `-s` guard was meant to catch and
	//     could not, because gzip of nothing is 20 bytes, not 0.
	const c = runScript(shell, OK_BUT_EMPTY);
	check(
		`[${shell}] a pg_dump that exits 0 but emits nothing keeps no backup`,
		c.code !== 0 && c.kept === 0,
		`exit=${c.code} kept=${c.kept} — an empty dump passed the size guard`
	);

	// D — the fix must not cost us working backups.
	const d = runScript(shell, HEALTHY);
	check(
		`[${shell}] a healthy pg_dump still produces exactly one backup`,
		d.code === 0 && d.kept === 1 && /morphit-backup: wrote /.test(d.out),
		`exit=${d.code} kept=${d.kept} out=${d.out.trim().slice(0, 160)}`
	);
}

// E — the Docker-aware path is what Ken actually runs (dockerized Postgres),
//     and `docker exec` forwards the container command's status, so the same
//     capture has to hold there.
const DOCKER_FAILS = '#!/bin/sh\necho "Error: No such container: $2" >&2\nexit 1\n';
const DOCKER_PASSTHROUGH = '#!/bin/sh\nshift 2\nexec "$@"\n';
const dockerEnv = ['DB_CONTAINER=morphit-db-1'];

const e1 = runScript('dash', HEALTHY, dockerEnv, { docker: DOCKER_FAILS });
check(
	'[dash] a failed `docker exec` dump keeps no backup',
	e1.code !== 0 && e1.kept === 0,
	`exit=${e1.code} kept=${e1.kept} — a containerized dump failure was banked`
);
const e2 = runScript('dash', HEALTHY, dockerEnv, { docker: DOCKER_PASSTHROUGH });
check(
	'[dash] a healthy `docker exec` dump still produces a backup',
	e2.code === 0 && e2.kept === 1,
	`exit=${e2.code} kept=${e2.kept} out=${e2.out.trim().slice(0, 160)}`
);

// F — the age-encrypted path wraps the stream again, so its empty-baseline is
//     ~200 bytes, not 20; the guard must be computed, never hardcoded.
const FAKE_AGE = "#!/bin/sh\nprintf 'age-encrypted:'\ncat\n";
const ageEnv = ['AGE_RECIPIENT=age1notaplaceholder000000000000000000000000000000'];
const f1 = runScript('dash', FAIL_SILENT, ageEnv, { age: FAKE_AGE });
check(
	'[dash] a failed dump on the age-encrypted path keeps no backup',
	f1.code !== 0 && f1.kept === 0,
	`exit=${f1.code} kept=${f1.kept}`
);
const f2 = runScript('dash', HEALTHY, ageEnv, { age: FAKE_AGE });
check(
	'[dash] a healthy dump on the age-encrypted path still produces a backup',
	f2.code === 0 && f2.kept === 1,
	`exit=${f2.code} kept=${f2.kept} out=${f2.out.trim().slice(0, 160)}`
);

// G — the capture must not depend on pipefail, because the platform we ship to
//     does not have it. Assert the explicit status file exists in the source.
check(
	'pg_dump status is captured explicitly, not left to `pipefail`',
	/DUMP_STATUS=/.test(code) && /\$DUMP_CMD "\$DB_NAME" && dump_rc=0 \|\| dump_rc=\$\?/.test(code),
	'without the status file the pipeline reports gzip 0 on every Ubuntu box'
);
check(
	'the emptiness guard is measured against an empty-stream baseline',
	/EMPTY_SIZE=/.test(code) && !/\[ ! -s "\$TMPFILE" \]/.test(code),
	'a bare `-s` cannot see a 20-byte gzip of a failed dump'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} backup-script-posix-safety checks passed` : '✗ backup-script-posix-safety FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
