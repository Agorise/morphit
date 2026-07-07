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
	fail('at least one job parsed from workflows', 'parser found zero jobs — convention drift suspected');
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
			.join('; ')}.  cp145 added this invariant — without timeout-minutes, a hung step burns the runner's default ceiling (often unlimited on Forgejo).  Pick a value 2-3x the observed runtime of the job and add \`timeout-minutes: N\` directly under runs-on.`
	);
}

/* ---------------- invariant 2: timeout-minutes in 1..90 ---------------- */

const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 90;
const outOfRange = allJobs.filter(
	(j) => j.timeoutMinutes !== null && (j.timeoutMinutes < TIMEOUT_MIN || j.timeoutMinutes > TIMEOUT_MAX)
);
if (outOfRange.length === 0) {
	pass(`every timeout-minutes is in sane range (${TIMEOUT_MIN}..${TIMEOUT_MAX})`);
} else {
	fail(
		`every timeout-minutes is in sane range (${TIMEOUT_MIN}..${TIMEOUT_MAX})`,
		`out-of-range timeouts: ${outOfRange
			.map((j) => `${j.workflow}::${j.name}=${j.timeoutMinutes}`)
			.join('; ')}.  Values <${TIMEOUT_MIN} are typos; values >${TIMEOUT_MAX} defeat the purpose of having a ceiling.  If a job genuinely needs >${TIMEOUT_MAX}min, consider splitting it into stages.`
	);
}

/* ---------------- invariant 3: concrete runs-on (no -latest) ---------------- */

const movingTargetAliases = ['ubuntu-latest', 'macos-latest', 'windows-latest', 'macos-12', 'macos-11'];
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
			.join('; ')}.  Use a concrete version like ubuntu-24.04 — moving-target aliases break reproducibility when GitHub/Forgejo rotates what -latest points at.`
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

/* ---------------- report ---------------- */

/* ---------------- invariant 4 (cp190): apt-get update is repo-scoped ----------------
 *
 * CI runs 523/524 died when the runner base image's third-party
 * repo (repo.zabbix.com) served a corrupt index and `apt-get
 * update` exited 100 — before any Morphit step ran.  We install
 * nothing from those repos, so every `apt-get update` in a
 * workflow must be scoped to the base Ubuntu sources with
 * `Dir::Etc::sourceparts=-`, which makes apt ignore
 * /etc/apt/sources.list.d/ entirely.  This pins that so a future
 * edit can't silently reintroduce a bare, flake-prone update.
 */
for (const wf of workflowFiles) {
	const text = readFileSync(wf, 'utf8');
	const rel = relative(REPO_ROOT, wf);
	// Find each `apt-get update` occurrence that is actual command
	// text (skip comment lines beginning with #).
	const updateLines = text
		.split('\n')
		.filter((ln) => /apt-get update/.test(ln) && !/^\s*#/.test(ln));
	if (updateLines.length === 0) {
		// No apt usage in this workflow — nothing to harden.
		pass(`${rel}: no unscoped apt-get update`);
		continue;
	}
	// Every workflow that runs apt-get update must also carry the
	// sourceparts scoping somewhere in the file (the flag sits on a
	// continuation line of the same command).
	if (/Dir::Etc::sourceparts=-/.test(text)) {
		pass(`${rel}: apt-get update is scoped to base repos (Dir::Etc::sourceparts=-)`);
	} else {
		fail(
			`${rel}: apt-get update is scoped to base repos (Dir::Etc::sourceparts=-)`,
			'found apt-get update without Dir::Etc::sourceparts=- — a flaky third-party repo in the runner image can fail it (see CI runs 523/524)'
		);
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
