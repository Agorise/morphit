#!/usr/bin/env node
/**
 * Supply-chain audit gate.
 *
 * Runs `npm audit --json` (lockfile only) and checks it against THE allowlist,
 * .audit-allowlist.json (also read by apps/web/scripts/npm-audit-gate-smoke.ts).
 * It FAILS when:
 *   1. a moderate, high or critical advisory is not in the allowlist;
 *   2. an allowlisted advisory is no longer reported (remove the entry: a
 *      stale allowlist hides the next advisory with the same id);
 *   3. npm can fix a reported advisory WITHOUT a major version change (update
 *      the dependency instead of accepting it);
 *   4. an allowlist entry has no category, reason or review date;
 *   5. the audit cannot run at all (registry unreachable, bad output) — the
 *      gate never passes on no information.
 * Low advisories not in the allowlist are reported, not failed.
 *
 * Release report mode (MORPHIT_AUDIT_GATE_MODE=report, set only by
 * release.yml): rule 1 for a HIGH and rules 2/3 print a warning instead of
 * failing, because the registry can change between CI and the release run on
 * the same commit; a new CRITICAL and rules 4/5 still fail.
 *
 *   node scripts/audit-gate.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ALLOWLIST_PATH = join(repoRoot, '.audit-allowlist.json');
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse + validate the allowlist file text. Returns { allow, problems }. */
export function parseAllowlist(text) {
	const problems = [];
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { allow: {}, problems: [`.audit-allowlist.json is not JSON: ${e.message}`] };
	}
	const allow = raw && typeof raw.allow === 'object' && raw.allow !== null ? raw.allow : null;
	if (allow === null) return { allow: {}, problems: ['.audit-allowlist.json has no "allow" map'] };
	const cats = new Set(Object.keys(raw._categories ?? {}));
	for (const [id, e] of Object.entries(allow)) {
		if (!/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.test(id))
			problems.push(`${id}: not a GHSA id`);
		if (!e || typeof e.package !== 'string' || e.package === '') problems.push(`${id}: no package`);
		if (!(e?.severity in RANK)) problems.push(`${id}: bad severity "${e?.severity}"`);
		if (!cats.has(e?.category))
			problems.push(`${id}: category "${e?.category}" is not one of _categories`);
		if (typeof e?.rationale !== 'string' || e.rationale.length < 40)
			problems.push(`${id}: no reason given`);
		if (typeof e?.lastReviewed !== 'string' || !DATE_RE.test(e.lastReviewed))
			problems.push(`${id}: no lastReviewed date`);
	}
	return { allow, problems };
}

/** Every advisory the audit reports: id → { package, severity, title, fixable }. */
export function advisoriesOf(audit) {
	const found = new Map();
	for (const v of Object.values(audit?.vulnerabilities ?? {})) {
		const fix = v.fixAvailable;
		const fixable =
			fix === true || (fix !== null && typeof fix === 'object' && fix.isSemVerMajor === false);
		for (const via of v.via ?? []) {
			if (typeof via !== 'object' || via === null) continue;
			const id = String(via.url ?? '').match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/)?.[0];
			if (!id) continue;
			const prev = found.get(id);
			found.set(id, {
				package: via.name ?? v.name ?? '',
				severity: via.severity ?? v.severity ?? '',
				title: via.title ?? '',
				fixable: (prev?.fixable ?? false) || (v.name === via.name && fixable)
			});
		}
	}
	return found;
}

/**
 * The verdict. `audit` is npm's JSON or null when it could not run (`reason`
 * says why).
 * Returns { failures: string[], warnings: string[], notes: string[] }.
 */
export function evaluate(audit, allowlistText, { mode = 'strict', reason = null } = {}) {
	const failures = [];
	const warnings = [];
	const notes = [];
	const report = mode === 'report';
	const { allow, problems } = parseAllowlist(allowlistText);
	failures.push(...problems);
	if (audit === null || typeof audit !== 'object' || typeof audit.vulnerabilities !== 'object') {
		failures.push(
			`the audit could not run — ${reason ?? 'npm gave no audit JSON'}. It needs the npm registry (CI and the release run have it); with no audit nothing is known about the dependencies, so this does not pass, in either mode.`
		);
		return { failures, warnings, notes };
	}
	const found = advisoriesOf(audit);
	for (const [id, a] of found) {
		const listed = Object.prototype.hasOwnProperty.call(allow, id);
		if (a.fixable) {
			const msg = `${id} (${a.package}, ${a.severity}): an update within the current major fixes it — update ${a.package} (npm update --package-lock-only ${a.package}) instead of accepting it`;
			(report ? warnings : failures).push(msg);
		}
		if (listed) continue;
		const rank = RANK[a.severity] ?? 0;
		const msg = `${id} (${a.package}, ${a.severity}) is not in .audit-allowlist.json: ${a.title}`;
		if (rank >= RANK.critical) failures.push(msg);
		else if (rank >= RANK.high) (report ? warnings : failures).push(msg);
		else if (rank >= RANK.moderate) (report ? warnings : failures).push(msg);
		else notes.push(msg);
	}
	for (const id of Object.keys(allow)) {
		if (!found.has(id)) {
			const msg = `${id} (${allow[id].package}) is in .audit-allowlist.json but npm no longer reports it — remove the entry`;
			(report ? warnings : failures).push(msg);
		}
	}
	return { failures, warnings, notes };
}

const PROXY_VARS = [
	'HTTPS_PROXY',
	'https_proxy',
	'npm_config_https_proxy',
	'HTTP_PROXY',
	'http_proxy'
];

/** Why npm printed no audit: npm's own message when it gave one. */
function reasonOf(err) {
	const out = err && typeof err.stdout === 'string' ? err.stdout.trim() : '';
	const errText = err && typeof err.stderr === 'string' ? err.stderr : '';
	let why = '';
	if (err && err.code === 'ENOENT') why = 'npm is not installed (or not on PATH)';
	else if (err && err.signal === 'SIGTERM') why = 'npm audit did not finish within 180 s';
	else {
		try {
			const j = JSON.parse(out);
			if (j && typeof j.message === 'string') why = `npm: ${j.message}`;
			else if (j && j.error && typeof j.error.summary === 'string' && j.error.summary !== '')
				why = `npm: ${j.error.summary}`;
		} catch {
			/* not JSON */
		}
		if (why === '') {
			const line = errText.split('\n').find((l) => /^npm (error|ERR!|warn)/.test(l));
			why = line ? line.trim() : 'npm printed no audit JSON';
		}
	}
	const proxy = PROXY_VARS.some((k) => (process.env[k] ?? '') !== '');
	return proxy ? why : `${why} (no proxy variable is set in this environment)`;
}

/**
 * `npm audit --json` for the lockfile: { audit, reason }. `audit` is null when
 * npm gave no audit; `reason` then says why, in npm's own words when it can.
 */
export function auditOrReason(cwd = repoRoot) {
	try {
		return {
			audit: JSON.parse(
				execFileSync('npm', ['audit', '--json', '--package-lock-only'], {
					cwd,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
					maxBuffer: 32 * 1024 * 1024,
					timeout: 180_000
				})
			),
			reason: null
		};
	} catch (err) {
		// npm audit exits non-zero WHEN advisories exist; the JSON is on stdout.
		if (err && typeof err.stdout === 'string' && err.stdout.trim().startsWith('{')) {
			try {
				const j = JSON.parse(err.stdout);
				// An npm error object (e.g. ENOTFOUND) is not an audit.
				if (typeof j.vulnerabilities === 'object') return { audit: j, reason: null };
			} catch {
				/* fall through */
			}
		}
		return { audit: null, reason: reasonOf(err) };
	}
}

/** `npm audit --json` for the lockfile; null when no parseable output. */
export function runAudit(cwd = repoRoot) {
	return auditOrReason(cwd).audit;
}

function main() {
	const mode = process.env.MORPHIT_AUDIT_GATE_MODE === 'report' ? 'report' : 'strict';
	const { audit, reason } = auditOrReason();
	const v = evaluate(audit, readFileSync(ALLOWLIST_PATH, 'utf8'), { mode, reason });
	const total = audit ? advisoriesOf(audit).size : 0;
	console.log(`audit-gate (${mode}): ${total} advisories reported.`);
	for (const n of v.notes) console.log(`  note: ${n}`);
	for (const w of v.warnings) {
		console.log(`  warn: ${w}`);
		console.log(`::warning title=npm audit::${w}`);
	}
	if (v.failures.length > 0) {
		for (const f of v.failures) console.error(`  ✗ ${f}`);
		console.error(`✗ audit gate failed (${v.failures.length}).`);
		process.exit(1);
	}
	console.log(
		'✓ audit gate: every reported advisory is triaged, none is fixable in range, no stale entry.'
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
