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
 *      the dependency instead of accepting it). npm's own `fixAvailable` flag
 *      is not enough: in v1.21.1 it put the fix on express (whose qs was the
 *      advisory) and called tsx's esbuild 0.28.0 -> 0.28.2 a major, so this
 *      gate passed while a plain `npm audit fix` changed both. So the gate
 *      also runs `npm audit fix --package-lock-only` (never --force: that
 *      allows major changes) on a COPY of the manifests and lockfile, and
 *      fails on any version it would change;
 *   4. an allowlist entry has no category, reason or review date;
 *   5. the audit, or the in-range fix check, cannot run at all (registry
 *      unreachable, bad output) — the gate never passes on no information.
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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * says why). `fixes` is what inRangeFixesOrReason() found an in-range
 * `npm audit fix` would change: an array, null when that check could not run
 * (`fixReason` says why), or undefined when it was not asked for.
 * Returns { failures: string[], warnings: string[], notes: string[] }.
 */
export function evaluate(
	audit,
	allowlistText,
	{ mode = 'strict', reason = null, fixes = undefined, fixReason = null } = {}
) {
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
	if (fixes === null) {
		failures.push(
			`the in-range fix check (npm audit fix, without --force, on a copy) could not run — ${fixReason ?? 'no reason given'}. With no answer nothing is known about available fixes, so this does not pass, in either mode.`
		);
	} else if (Array.isArray(fixes)) {
		// One line per package; optional platform binaries (esbuild's @esbuild/*)
		// move with their package and are only counted.
		const byName = new Map();
		let optional = 0;
		for (const f of fixes) {
			if (f.optional) {
				optional++;
				continue;
			}
			const what =
				f.from === null
					? `adds ${f.path} ${f.to}`
					: f.to === null
						? `drops ${f.path} ${f.from}`
						: `${f.path} ${f.from} → ${f.to}`;
			byName.set(f.name, [...(byName.get(f.name) ?? []), what]);
		}
		for (const [name, whats] of byName) {
			const msg = `an in-range fix exists: \`npm audit fix\` (no --force) changes ${name}: ${whats.join('; ')} — run npm update --package-lock-only ${name}, check the lockfile diff, and remove the allowlist entries npm then stops reporting`;
			(report ? warnings : failures).push(msg);
		}
		if (optional > 0) {
			const msg = `an in-range fix exists: \`npm audit fix\` (no --force) also changes ${optional} optional platform package(s) (e.g. ${fixes.find((f) => f.optional).path})${byName.size > 0 ? ', which move with the packages above' : ''}`;
			(report ? warnings : failures).push(msg);
		}
	}
	return { failures, warnings, notes };
}

/** { version, optional } by lockfile path, for every package the lockfile records. */
function lockVersions(lockText) {
	const out = new Map();
	const lock = JSON.parse(lockText);
	for (const [path, e] of Object.entries(lock.packages ?? {})) {
		if (path === '' || e === null || typeof e !== 'object') continue;
		out.set(path, {
			version: typeof e.version === 'string' ? e.version : e.link ? 'link' : '',
			optional: e.optional === true
		});
	}
	return out;
}

/** The package name a lockfile path installs (its last node_modules/ segment). */
function nameOf(path) {
	const i = path.lastIndexOf('node_modules/');
	return i === -1 ? path : path.slice(i + 'node_modules/'.length);
}

/**
 * What a plain `npm audit fix` — NEVER --force, which allows major version
 * changes — would change in the lockfile: { fixes, reason }. It runs on a COPY
 * (the root package.json, .npmrc, package-lock.json and every workspace's
 * package.json, in a temp directory), so the repository is never touched.
 * `fixes` lists every lockfile path whose version would change, appear or go;
 * it is null when the check could not run, and `reason` then says why.
 */
export function inRangeFixesOrReason(cwd = repoRoot) {
	let dir = null;
	try {
		const lockText = readFileSync(join(cwd, 'package-lock.json'), 'utf8');
		const lock = JSON.parse(lockText);
		dir = mkdtempSync(join(tmpdir(), 'morphit-audit-fix-'));
		const files = ['package.json', 'package-lock.json'];
		if (existsSync(join(cwd, '.npmrc'))) files.push('.npmrc');
		for (const path of Object.keys(lock.packages ?? {})) {
			// Workspaces: lockfile paths outside node_modules.
			if (path !== '' && !path.includes('node_modules/')) files.push(join(path, 'package.json'));
		}
		for (const f of files) {
			if (!existsSync(join(cwd, f))) continue;
			mkdirSync(dirname(join(dir, f)), { recursive: true });
			copyFileSync(join(cwd, f), join(dir, f));
		}
		try {
			execFileSync(
				'npm',
				['audit', 'fix', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
				{
					cwd: dir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
					maxBuffer: 32 * 1024 * 1024,
					timeout: 300_000
				}
			);
		} catch (err) {
			// npm audit fix exits non-zero while advisories it cannot fix remain;
			// what counts is whether it rewrote the lockfile, read below. A timeout
			// or a missing npm is no answer.
			if (err && (err.code === 'ENOENT' || err.signal === 'SIGTERM')) {
				return { fixes: null, reason: reasonOf(err) };
			}
		}
		const before = lockVersions(lockText);
		const after = lockVersions(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
		const fixes = [];
		for (const [path, v] of before) {
			const w = after.get(path);
			const base = { path, name: nameOf(path), optional: v.optional && (w?.optional ?? true) };
			if (w === undefined) fixes.push({ ...base, from: v.version, to: null });
			else if (w.version !== v.version) fixes.push({ ...base, from: v.version, to: w.version });
		}
		for (const [path, w] of after) {
			if (!before.has(path))
				fixes.push({ path, name: nameOf(path), optional: w.optional, from: null, to: w.version });
		}
		return { fixes, reason: null };
	} catch (err) {
		return { fixes: null, reason: err instanceof Error ? err.message : String(err) };
	} finally {
		if (dir !== null) rmSync(dir, { recursive: true, force: true });
	}
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
	const { fixes, reason: fixReason } = inRangeFixesOrReason();
	const v = evaluate(audit, readFileSync(ALLOWLIST_PATH, 'utf8'), {
		mode,
		reason,
		fixes,
		fixReason
	});
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
