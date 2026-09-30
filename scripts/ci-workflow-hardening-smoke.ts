/**
 * CI workflow hardening smoke (cp145).
 *
 * Catches the class of CI bug that cp145 fixed: a Forgejo Actions
 * job declared without `timeout-minutes:` will fall back to the
 * runner's default ceiling (often unlimited on self-hosted
 * Forgejo, 360 minutes on hosted GitHub Actions).  cp143's
 * per-smoke timeout inside scripts/run-smokes.sh catches hangs
 * inside the smoke battery; this job-level timeout catches
 * everything else (npm ci, tsc, svelte-kit sync, svelte-check,
 * ansible-galaxy, gpg --import, git fetch, tar, etc.).
 *
 * Three invariants enforced here, against every workflow YAML
 * file under `.forgejo/workflows/`:
 *
 *   1. Every job declares `timeout-minutes:`.  The whole point
 *      of cp145 — any unbounded step gets caught at the
 *      job-level wall before it can burn the runner's default.
 *
 *   2. Every job's `timeout-minutes:` is in a sane range (1..90).
 *      Below 1 is a typo; above 90 defeats the purpose of having
 *      a ceiling at all.  The current ship has 5 / 10 / 10 / 45 / 60
 *      across the 5 jobs.
 *
 *   3. Every job declares `runs-on:` with a concrete OS pin (e.g.
 *      `ubuntu-24.04`), not a moving-target alias like
 *      `ubuntu-latest`.  Moving-target aliases break
 *      reproducibility: a job that worked yesterday could fail
 *      tomorrow when GitHub/Forgejo rotates what `-latest`
 *      points to.
 *
 * REGEX-BASED PARSING (not YAML library): the project's transitive
 * deps include `yaml` but no workspace declares it as a direct
 * dependency — importing it from a smoke would create a phantom-
 * dep risk.  The workflow YAML follows tight, hand-maintained
 * conventions (2-space job indent, 4-space field indent), so a
 * regex state machine is sufficient.  If the conventions ever
 * drift, this smoke will surface ambiguity by failing more loudly
 * than wrong (the patterns require literal indentation depths).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const WORKFLOWS_DIR = join(REPO_ROOT, '.forgejo', 'workflows');

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

/* ---------------- discover workflows ---------------- */

const workflowFiles = readdirSync(WORKFLOWS_DIR)
	.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
	.map((f) => join(WORKFLOWS_DIR, f));

if (workflowFiles.length === 0) {
	fail('at least one workflow file present', `no *.yml / *.yaml under ${WORKFLOWS_DIR}`);
}

/* ---------------- job extraction ---------------- */

interface ParsedJob {
	workflow: string; // file path (relative to repo root)
	name: string; // job key from YAML
	startLine: number; // 1-indexed
	endLine: number;
	timeoutMinutes: number | null;
	runsOn: string | null;
}

/**
 * Walk the file line-by-line.  Detect the `jobs:` top-level block,
 * then within it, each job's key (2-space indent + name + colon).
 * Each job spans from its key line to either the next 2-space
 * job key OR a 0-space top-level key (e.g. another file-level
 * `concurrency:`, though we never see that after `jobs:` in
 * practice).
 *
 * Within each job's range, scan for `^    timeout-minutes:`
 * (4-space indent) and `^    runs-on:` (4-space indent).  Steps
 * use 4-space + dash-prefix, which won't match these key:value
 * patterns.
 */
function parseWorkflow(path: string): ParsedJob[] {
	const text = readFileSync(path, 'utf8');
	const lines = text.split('\n');
	const jobs: ParsedJob[] = [];

	let inJobsBlock = false;
	let currentJob: ParsedJob | null = null;

	const jobsLineRe = /^jobs:\s*$/;
	const jobKeyRe = /^ {2}([a-zA-Z_][a-zA-Z0-9_-]*):\s*$/;
	const topLevelKeyRe = /^[a-zA-Z_]/; // any 0-indent line begins a top-level key
	const timeoutRe = /^ {4}timeout-minutes:\s*(\d+)\s*(#.*)?$/;
	const runsOnRe = /^ {4}runs-on:\s*([a-zA-Z0-9._-]+|\$\{\{[^}]+\}\})\s*(#.*)?$/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		if (!inJobsBlock) {
			if (jobsLineRe.test(line)) {
				inJobsBlock = true;
			}
			continue;
		}

		// We're in the jobs: block.  A top-level (0-indent) line ends it.
		if (line.length > 0 && topLevelKeyRe.test(line)) {
			if (currentJob) {
				currentJob.endLine = lineNum - 1;
				jobs.push(currentJob);
				currentJob = null;
			}
			inJobsBlock = false;
			continue;
		}

		const jobMatch = line.match(jobKeyRe);
		if (jobMatch) {
			if (currentJob) {
				currentJob.endLine = lineNum - 1;
				jobs.push(currentJob);
			}
			currentJob = {
				workflow: relative(REPO_ROOT, path),
				name: jobMatch[1],
				startLine: lineNum,
				endLine: lines.length, // updated when we close
				timeoutMinutes: null,
				runsOn: null
			};
			continue;
		}

		if (!currentJob) continue;

		const timeoutMatch = line.match(timeoutRe);
		if (timeoutMatch) {
			currentJob.timeoutMinutes = parseInt(timeoutMatch[1], 10);
			continue;
		}

		const runsOnMatch = line.match(runsOnRe);
		if (runsOnMatch) {
			currentJob.runsOn = runsOnMatch[1];
			continue;
		}
	}

	if (currentJob) {
		currentJob.endLine = lines.length;
		jobs.push(currentJob);
	}

	return jobs;
}

const allJobs: ParsedJob[] = [];
for (const wf of workflowFiles) {
	allJobs.push(...parseWorkflow(wf));
}

if (allJobs.length === 0) {
	fail(
		'at least one job parsed from workflows',
		'parser found zero jobs — convention drift suspected'
	);
}

/* ---------------- invariant 1: every job has timeout-minutes ---------------- */

const noTimeout = allJobs.filter((j) => j.timeoutMinutes === null);
if (noTimeout.length === 0) {
	pass(
		`every CI job declares timeout-minutes (${allJobs.length} jobs across ${workflowFiles.length} workflows)`
	);
} else {
	fail(
		'every CI job declares timeout-minutes',
		`missing timeout-minutes: ${noTimeout
			.map((j) => `${j.workflow}::${j.name} (line ${j.startLine})`)
			.join(
				'; '
			)}.  cp145 added this invariant — without timeout-minutes, a hung step burns the runner's default ceiling (often unlimited on Forgejo).  Pick a value 2-3x the observed runtime of the job and add \`timeout-minutes: N\` directly under runs-on.`
	);
}

/* ---------------- invariant 2: timeout-minutes in 1..90 ---------------- */

const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 90;
const outOfRange = allJobs.filter(
	(j) =>
		j.timeoutMinutes !== null && (j.timeoutMinutes < TIMEOUT_MIN || j.timeoutMinutes > TIMEOUT_MAX)
);
if (outOfRange.length === 0) {
	pass(`every timeout-minutes is in sane range (${TIMEOUT_MIN}..${TIMEOUT_MAX})`);
} else {
	fail(
		`every timeout-minutes is in sane range (${TIMEOUT_MIN}..${TIMEOUT_MAX})`,
		`out-of-range timeouts: ${outOfRange
			.map((j) => `${j.workflow}::${j.name}=${j.timeoutMinutes}`)
			.join(
				'; '
			)}.  Values <${TIMEOUT_MIN} are typos; values >${TIMEOUT_MAX} defeat the purpose of having a ceiling.  If a job genuinely needs >${TIMEOUT_MAX}min, consider splitting it into stages.`
	);
}

/* ---------------- invariant 3: concrete runs-on (no -latest) ---------------- */

const movingTargetAliases = [
	'ubuntu-latest',
	'macos-latest',
	'windows-latest',
	'macos-12',
	'macos-11'
];
const movingTarget = allJobs.filter(
	(j) => j.runsOn !== null && movingTargetAliases.includes(j.runsOn)
);
if (movingTarget.length === 0) {
	pass(
		`every job pins runs-on to a concrete OS version (${allJobs.length} jobs checked, no -latest aliases)`
	);
} else {
	fail(
		'every job pins runs-on to a concrete OS version',
		`moving-target aliases: ${movingTarget
			.map((j) => `${j.workflow}::${j.name}=${j.runsOn}`)
			.join(
				'; '
			)}.  Use a concrete version like ubuntu-24.04 — moving-target aliases break reproducibility when GitHub/Forgejo rotates what -latest points at.`
	);
}

const noRunsOn = allJobs.filter((j) => j.runsOn === null);
if (noRunsOn.length === 0) {
	pass(`every job has a runs-on declared`);
} else {
	fail(
		'every job has a runs-on declared',
		`missing runs-on: ${noRunsOn.map((j) => `${j.workflow}::${j.name}`).join('; ')}`
	);
}

/* ---------------- invariant 5: smokes that need Postgres get Postgres in CI ----------------
 *
 * (v1.20.0) Two relay smokes drive REAL Postgres. Without TEST_DATABASE_URL they
 * print a skip line and no `✓ all N` line; run-smokes.sh counts that as a
 * failure, so the first CI push after they landed failed the whole smoke job —
 * the local battery always had a database, so it never saw the skip path. Rule:
 * if any smoke registered in scripts/run-smokes.sh reads TEST_DATABASE_URL, the
 * job that runs run-smokes.sh must declare a postgres service AND set
 * TEST_DATABASE_URL.
 */
{
	const name = 'the CI job running run-smokes.sh provides Postgres to the smokes that need it';
	const runner = readFileSync(join(REPO_ROOT, 'scripts', 'run-smokes.sh'), 'utf8');
	const entries = [...runner.matchAll(/^\s*"([^":]+):([A-Za-z0-9._-]+)"\s*$/gm)].map((m) => ({
		dir: m[1]!,
		smoke: m[2]!
	}));
	const needDb = entries
		.filter(({ dir, smoke }) => {
			try {
				return /process\.env\.TEST_DATABASE_URL/.test(
					readFileSync(join(REPO_ROOT, dir, 'scripts', `${smoke}.ts`), 'utf8')
				);
			} catch {
				return false;
			}
		})
		.map(({ dir, smoke }) => `${dir}:${smoke}`);
	const smokeJobs = allJobs.filter((j) => {
		const body = readFileSync(join(REPO_ROOT, j.workflow), 'utf8')
			.split('\n')
			.slice(j.startLine - 1, j.endLine)
			.join('\n');
		// An executed line (a `run:` or a script line), not a comment that names it.
		return /^(?!\s*#).*\bbash scripts\/run-smokes\.sh\b/m.test(body);
	});
	if (entries.length < 100) {
		fail(
			name,
			`parsed only ${entries.length} entries from run-smokes.sh — the SMOKES parser is broken`
		);
	} else if (needDb.length === 0) {
		pass(`${name} (no registered smoke reads TEST_DATABASE_URL)`);
	} else if (smokeJobs.length === 0) {
		fail(name, 'no workflow job runs scripts/run-smokes.sh');
	} else {
		const missing = smokeJobs.filter((j) => {
			const body = readFileSync(join(REPO_ROOT, j.workflow), 'utf8')
				.split('\n')
				.slice(j.startLine - 1, j.endLine)
				.join('\n');
			return !(
				/^ {4}services:\s*$/m.test(body) &&
				/^ {8}image:\s*postgres:/m.test(body) &&
				/TEST_DATABASE_URL:\s*postgres(ql)?:\/\//.test(body)
			);
		});
		if (missing.length === 0) {
			pass(`${name} (${needDb.length} smoke(s): ${needDb.join(', ')})`);
		} else {
			fail(
				name,
				`${missing.map((j) => `${j.workflow}::${j.name}`).join('; ')} runs run-smokes.sh without a postgres service + TEST_DATABASE_URL, but ${needDb.join(', ')} need(s) one — they will print a skip line and fail the job`
			);
		}
	}
}

/* ---------------- report ---------------- */

/* ---------------- invariant 4: apt-get update is container-executor-clean ----------------
 *
 * The runner is now a CONTAINER executor: jobs run as root inside node:20-bookworm.
 * The old `Dir::Etc::sourceparts=-` scoping (a workaround for the previous HOST
 * executor's third-party Ubuntu repos) actively BREAKS apt on this clean Debian
 * image — it nulls the real sources, so `apt-get update` produces an empty package
 * list and installs fail ("no installation candidate"). And `sudo` isn't installed
 * in the image. So every `apt-get update` must be PLAIN: no sudo, and no
 * `Dir::Etc::sourceparts` override. This pins that so a future edit can't
 * reintroduce either host-executor-ism.
 */
for (const wf of workflowFiles) {
	const text = readFileSync(wf, 'utf8');
	const rel = relative(REPO_ROOT, wf);
	const updateLines = text
		.split('\n')
		.filter((ln) => /apt-get update/.test(ln) && !/^\s*#/.test(ln));
	if (updateLines.length === 0) {
		pass(`${rel}: no apt-get update`);
		continue;
	}
	if (/Dir::Etc::sourceparts/.test(text)) {
		fail(
			`${rel}: apt-get update is container-executor-clean (no source-list override)`,
			'found Dir::Etc::sourceparts — that host-executor flag nulls apt sources on node:20-bookworm (empty package list → install fails)'
		);
	} else if (updateLines.some((ln) => /\bsudo\b/.test(ln))) {
		fail(
			`${rel}: apt-get update is container-executor-clean (no sudo)`,
			'found `sudo apt-get update` — the container executor runs jobs as root and has no sudo'
		);
	} else {
		pass(`${rel}: apt-get update is container-executor-clean (plain, root, real sources)`);
	}
}

/* ---------------- invariant 5: the integration job has the client tools its suites run ----------------
 *
 * v1.18.0 (CI run 2061). The snapshot suites run the REAL export (pg_dump + psql
 * \copy) and the REAL restore, which refuses a psql without `\restrict` (16.10+).
 * The job container's own client is not that: every restore died with "psql is
 * too old" before reading the dump — which the refusal tests could not tell
 * apart from a real refusal. The integration job must install the 16.x client
 * from PGDG, trust that repository only by the key's checked fingerprint, and
 * prove `\restrict` works, all before the tests run.
 */
{
	const ci = join(WORKFLOWS_DIR, 'ci.yml');
	const text = readFileSync(ci, 'utf8');
	const start = text.search(/^ {2}integration:\s*$/m);
	const rest = start < 0 ? '' : text.slice(start + 1);
	const nextJob = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
	const job = nextJob < 0 ? rest : rest.slice(0, nextJob);
	const code = job
		.split('\n')
		.filter((ln) => !/^\s*#/.test(ln))
		.join('\n');
	const at = (re: RegExp): number => code.search(re);
	const tests = at(/npm run test:integration/);
	const install = at(/apt-get install[^\n]*postgresql-client-16/);
	const fingerprint = at(/B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8/);
	const signedBy = at(/signed-by=[^\]\s]+apt\.postgresql\.org/);
	const restrict = at(/\\\\restrict k0[^\n]*\|\s*psql[^\n]*ON_ERROR_STOP=1/);
	const name =
		'.forgejo/workflows/ci.yml: the integration job installs psql/pg_dump 16 with \\restrict before its tests';
	if (start < 0 || tests < 0) {
		fail(name, 'could not find the integration job or its `npm run test:integration` step');
	} else if (install < 0 || install > tests) {
		fail(name, 'no `apt-get install … postgresql-client-16` before the integration tests');
	} else if (signedBy < 0 || fingerprint < 0 || fingerprint > install) {
		fail(
			name,
			'the PGDG repository must be added with signed-by and its key checked against the fingerprint B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 before anything is installed from it'
		);
	} else if (restrict < 0 || restrict < install || restrict > tests) {
		fail(name, 'nothing proves, before the tests, that the installed psql accepts \\restrict');
	} else {
		pass(name);
	}
}

/* ---------------- invariant 6: the audit report mode stays release-only ----------------
 *
 * (v1.20.0) npm-audit-gate-smoke has a release-time report mode
 * (MORPHIT_AUDIT_GATE_MODE=report): a HIGH advisory published AFTER ci.yml
 * passed the commit is printed as a warning instead of failing the release.
 * That is only safe if ci.yml stays strict. Rule: no ci.yml line sets it, and
 * release.yml sets it exactly once, to `report`, on the step that runs
 * run-smokes.sh.
 */
{
	const name = 'the npm-audit report mode is set only in release.yml, never in ci.yml';
	const code = (f: string): string =>
		readFileSync(join(WORKFLOWS_DIR, f), 'utf8')
			.split('\n')
			.filter((ln) => !/^\s*#/.test(ln))
			.join('\n');
	const others = readdirSync(WORKFLOWS_DIR).filter(
		(f) => /\.ya?ml$/.test(f) && f !== 'release.yml' && /MORPHIT_AUDIT_GATE_MODE/.test(code(f))
	);
	const rel = code('release.yml');
	const sets = [...rel.matchAll(/MORPHIT_AUDIT_GATE_MODE:\s*(\S+)/g)];
	const onSmokeStep =
		/MORPHIT_AUDIT_GATE_MODE:\s*report\s*\n\s*run:\s*bash scripts\/run-smokes\.sh/.test(rel);
	if (others.length > 0) {
		fail(
			name,
			`${others.join(', ')} sets MORPHIT_AUDIT_GATE_MODE — ci.yml must gate every push strictly`
		);
	} else if (sets.length !== 1 || sets[0]![1] !== 'report' || !onSmokeStep) {
		fail(
			name,
			'release.yml must set `MORPHIT_AUDIT_GATE_MODE: report` exactly once, as the last env line of the step that runs `bash scripts/run-smokes.sh`'
		);
	} else {
		pass(name);
	}
}

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log(`  ${ANSI_GREEN}✓${ANSI_RESET} ${r.name}`);
	} else {
		console.log(`  ${ANSI_RED}✗${ANSI_RESET} ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log(`✗ ${failed} of ${results.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(`✓ all ${results.length} scenarios passed`);
}
