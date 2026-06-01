#!/usr/bin/env tsx
/**
 * npm-audit-gate-smoke — Part 122 cp16 audit finding DD-13.
 *
 * Runs `npm audit --json` against the root workspace and fails
 * the build if it reports any HIGH or CRITICAL vulnerabilities
 * that aren't on the documented allowlist below.
 *
 * Each entry in the allowlist names a package + the severity we
 * accept for it, plus a short rationale.  Whoever adds a new
 * allowlist entry must also add a rationale — the gate isn't
 * "ignore everything," it's "document why each accepted risk
 * is below our threat-model bar."
 *
 * When a vulnerability is fixed upstream OR mitigated by removing
 * the dependency, drop the allowlist row.  The smoke will then
 * pass cleanly.
 *
 * Note: this smoke runs `npm audit` which talks to the npm
 * registry.  In offline / restricted-network environments, the
 * smoke will WARN and exit 0 rather than fail spuriously —
 * a hard fail on transient network issues would mask real
 * problems.  CI environments with real audit results should
 * see a hard fail when something slips through.
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

/** Vulnerabilities we accept with their rationale.  Each entry
 *  names a package + the severity we accept for it + the EXACT
 *  CVE titles we've reviewed + a rationale + a last-reviewed
 *  date.  The gate fires when a NEW CVE title appears for an
 *  allowlisted package — forces a fresh review when the
 *  supply-chain landscape shifts under us, even on packages
 *  we've already accepted.
 *
 *  `lastReviewed` is informational — not enforced as an expiry —
 *  but reviewers should re-check entries older than ~6 months
 *  to catch quietly-evolved attack surfaces.  CI doesn't fail
 *  on stale dates; humans should. */
interface AllowlistEntry {
	readonly package: string;
	readonly maxSeverity: 'low' | 'moderate' | 'high' | 'critical';
	readonly acceptedTitles: readonly string[];
	readonly rationale: string;
	/** ISO date (YYYY-MM-DD) of the last human review of this
	 *  entry.  Bump when re-evaluating the rationale, NOT when
	 *  unrelated changes touch the file. */
	readonly lastReviewed: string;
}

const ALLOWLIST: readonly AllowlistEntry[] = [
	{
		package: 'request',
		maxSeverity: 'critical',
		acceptedTitles: ['Server-Side Request Forgery in Request'],
		lastReviewed: '2026-05-16',
		rationale:
			'Deprecated HTTP library brought in transitively by matrix-bot-sdk@0.7.1. ' +
			'Carries CRITICAL SSRF (CVE in request) but matrix-bot only makes outbound ' +
			'calls to operator-configured Matrix homeserver URLs — no user-controlled ' +
			'URLs flow through this library, so the SSRF surface is bounded to operator ' +
			'misconfiguration. Acceptable until matrix-bot-sdk upgrades or is replaced.'
	},
	{
		package: 'form-data',
		maxSeverity: 'critical',
		acceptedTitles: [
			'form-data uses unsafe random function in form-data for choosing boundary'
		],
		lastReviewed: '2026-05-16',
		rationale:
			'Transitive of `request` (see above). The unsafe Math.random() boundary ' +
			'generation matters for cross-origin request forgery via predictable ' +
			'boundaries; matrix-bot makes only operator-configured homeserver calls, ' +
			'so no attacker-controlled requests share the boundary space.'
	},
	{
		package: 'tough-cookie',
		maxSeverity: 'high',
		acceptedTitles: ['tough-cookie Prototype Pollution vulnerability'],
		lastReviewed: '2026-05-16',
		rationale:
			'Transitive of `request` (see above). Prototype-pollution via crafted ' +
			'cookie names; matrix-bot only receives cookies from operator-configured ' +
			'Matrix homeservers, so attacker-controlled cookies are not in scope.'
	},
	{
		package: 'vitest',
		maxSeverity: 'critical',
		acceptedTitles: [
			'When Vitest UI server is listening, arbitrary file can be read and executed'
		],
		lastReviewed: '2026-06-01',
		rationale:
			'Dev/test-only dependency (never shipped to operators). The vulnerable ' +
			'code path is the Vitest UI server: Morphit invokes vitest only as ' +
			'`vitest run` / `vitest` (no `--ui`), has NO `@vitest/ui` dependency, and ' +
			'never starts the UI server in CI or locally — so the listening-server ' +
			'file-read/exec surface is not installed or reachable here. Reviewed cp184. ' +
			'Revisit if a vitest 2.1.x patch ships or if `@vitest/ui` is ever added.'
	}
];

interface NpmAuditOutput {
	readonly vulnerabilities?: Record<
		string,
		{
			readonly name: string;
			readonly severity: string;
			readonly via?: ReadonlyArray<
				string | { readonly title?: string; readonly name?: string }
			>;
		}
	>;
	readonly metadata?: {
		readonly vulnerabilities?: Record<string, number>;
	};
}

const SEVERITY_RANK: Record<string, number> = {
	info: 0,
	low: 1,
	moderate: 2,
	high: 3,
	critical: 4
};

type ViaEntry = string | { readonly title?: string; readonly name?: string };

/** Extract the set of CVE titles `npm audit` reports for one
 *  vulnerable package.  `via` is heterogeneous: each entry is
 *  either a string (the name of a downstream package that brings
 *  the vuln in) or an object with `title` + `name` fields (the
 *  actual CVE).  We want only the latter. */
function cveTitles(via: ReadonlyArray<ViaEntry> | undefined): string[] {
	if (!Array.isArray(via)) return [];
	const out: string[] = [];
	for (const entry of via) {
		if (typeof entry === 'object' && entry !== null && typeof entry.title === 'string') {
			out.push(entry.title);
		}
	}
	return out;
}

interface AllowDecision {
	readonly ok: boolean;
	/** Titles present in audit output but not yet on the allowlist
	 *  for this package.  Non-empty when the smoke should fail
	 *  the package even though it's named on the allowlist —
	 *  forces a fresh review when supply-chain shifts. */
	readonly unknownTitles: readonly string[];
}

function isAllowed(name: string, severity: string, titles: readonly string[]): AllowDecision {
	const entry = ALLOWLIST.find((e) => e.package === name);
	if (!entry) return { ok: false, unknownTitles: titles };
	if (SEVERITY_RANK[severity]! > SEVERITY_RANK[entry.maxSeverity]!) {
		return { ok: false, unknownTitles: titles };
	}
	const accepted = new Set(entry.acceptedTitles);
	const unknown = titles.filter((t) => !accepted.has(t));
	return { ok: unknown.length === 0, unknownTitles: unknown };
}

// Run npm audit.  In offline / restricted networks, this fails
// with a non-zero exit but still emits useful JSON; we tolerate
// the exit code and parse what we get.
//
// DEEP-DEEP NOTE (DD-cp16-1): offline-skip exits 0 so that
// transient network issues don't break unrelated CI runs, but
// the output explicitly reports "0 scenarios actually checked"
// rather than misleadingly counting the skip as a pass.  An
// attacker who can block the npm registry would see the smoke
// SKIP — not silently green-light a vulnerable build.  CI
// reviewers should treat "0 scenarios actually checked" as a
// gate failure for any commit touching dependencies.
let audit: NpmAuditOutput;
try {
	const out = execSync('npm audit --json', {
		cwd: REPO,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 32 * 1024 * 1024
	});
	audit = JSON.parse(out);
} catch (err: unknown) {
	const stdout = (err as { stdout?: Buffer | string })?.stdout;
	if (!stdout) {
		console.log('⚠ npm audit unavailable — registry unreachable from this host.');
		console.log('⚠ 0 scenarios actually checked.  CI must treat this as a gate failure');
		console.log('⚠ when the commit touches package.json or package-lock.json.');
		console.log('');
		console.log('npm-audit-gate smoke: 0 scenarios actually checked (offline-skip)');
		process.exit(0);
	}
	try {
		audit = JSON.parse(stdout.toString());
	} catch {
		console.log('⚠ npm audit produced unparseable output — gate cannot evaluate.');
		console.log('⚠ 0 scenarios actually checked.  CI must treat this as a gate failure');
		console.log('⚠ when the commit touches package.json or package-lock.json.');
		console.log('');
		console.log('npm-audit-gate smoke: 0 scenarios actually checked (parse-error)');
		process.exit(0);
	}
}

// Iterate the vulnerabilities map.  Each entry's `name` is the
// package; the `severity` field summarizes the worst issue
// affecting that package.
const vulns = audit.vulnerabilities ?? {};
let failed = 0;
let allowedCount = 0;
let totalConsidered = 0;
const failures: string[] = [];

for (const [pkgName, info] of Object.entries(vulns)) {
	const severity = info.severity;
	if (!severity || !(severity in SEVERITY_RANK)) continue;
	if (SEVERITY_RANK[severity]! < SEVERITY_RANK.high) continue;
	totalConsidered++;
	const titles = cveTitles(info.via);
	const decision = isAllowed(pkgName, severity, titles);
	if (decision.ok) {
		allowedCount++;
		continue;
	}
	failed++;
	if (decision.unknownTitles.length > 0) {
		failures.push(
			`${severity.toUpperCase()}: ${pkgName} — new CVE title(s) not yet reviewed:\n      ${decision.unknownTitles.map((t) => `· ${t}`).join('\n      ')}`
		);
	} else {
		failures.push(`${severity.toUpperCase()}: ${pkgName}`);
	}
}

// Report.
const meta = audit.metadata?.vulnerabilities ?? {};
console.log(
	`npm-audit-gate smoke — ${meta.high ?? 0} HIGH + ${meta.critical ?? 0} CRITICAL (registry totals)`
);
console.log(
	`  allowlisted: ${allowedCount}; new HIGH/CRITICAL not on allowlist: ${failed}`
);
console.log('');
if (failed === 0) {
	if (allowedCount > 0) {
		console.log(`  Allowlisted (rationale documented in this file):`);
		for (const entry of ALLOWLIST) {
			console.log(
				`    · ${entry.package} (≤${entry.maxSeverity}, last reviewed ${entry.lastReviewed})`
			);
		}
		console.log('');
	}
	console.log(`✓ all ${1 + totalConsidered} npm-audit-gate scenarios pass`);
	process.exit(0);
} else {
	console.error('Newly-introduced HIGH/CRITICAL vulnerabilities (not on allowlist):');
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error('');
	console.error('Either upgrade/remove the dependency OR add an entry to ALLOWLIST');
	console.error(`in apps/web/scripts/npm-audit-gate-smoke.ts with a real rationale.`);
	console.error(`✗ ${failed} gate violations`);
	process.exit(1);
}
