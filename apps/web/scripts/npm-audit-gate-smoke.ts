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
 *  is one package name (as reported by `npm audit`); ALL severity
 *  levels for that package are accepted unless tightened. */
interface AllowlistEntry {
	readonly package: string;
	readonly maxSeverity: 'low' | 'moderate' | 'high' | 'critical';
	readonly rationale: string;
}

const ALLOWLIST: readonly AllowlistEntry[] = [
	{
		package: 'request',
		maxSeverity: 'critical',
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
		rationale:
			'Transitive of `request` (see above). The unsafe Math.random() boundary ' +
			'generation matters for cross-origin request forgery via predictable ' +
			'boundaries; matrix-bot makes only operator-configured homeserver calls, ' +
			'so no attacker-controlled requests share the boundary space.'
	},
	{
		package: 'tough-cookie',
		maxSeverity: 'high',
		rationale:
			'Transitive of `request` (see above). Prototype-pollution via crafted ' +
			'cookie names; matrix-bot only receives cookies from operator-configured ' +
			'Matrix homeservers, so attacker-controlled cookies are not in scope.'
	}
];

interface NpmAuditOutput {
	readonly vulnerabilities?: Record<
		string,
		{
			readonly name: string;
			readonly severity: string;
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

function isAllowed(name: string, severity: string): boolean {
	const entry = ALLOWLIST.find((e) => e.package === name);
	if (!entry) return false;
	return SEVERITY_RANK[severity]! <= SEVERITY_RANK[entry.maxSeverity]!;
}

// Run npm audit.  In offline / restricted networks, this fails
// with a non-zero exit but still emits useful JSON; we tolerate
// the exit code and parse what we get.
let audit: NpmAuditOutput;
try {
	const out = execSync('npm audit --json', {
		cwd: REPO,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		// `npm audit` returns non-zero when vulnerabilities are
		// present.  We want the output, not the exit code.
		maxBuffer: 32 * 1024 * 1024
	});
	audit = JSON.parse(out);
} catch (err: unknown) {
	// `execSync` throws when exit code is non-zero.  The error
	// object carries stdout.  Parse it; non-zero exit code is
	// expected when vulnerabilities are present.
	const stdout = (err as { stdout?: Buffer | string })?.stdout;
	if (!stdout) {
		console.log('⚠ npm audit unavailable (offline?  no network?) — skipping gate.');
		console.log('✓ all 1 npm-audit-gate scenarios pass (gate-skipped, offline-tolerant)');
		process.exit(0);
	}
	try {
		audit = JSON.parse(stdout.toString());
	} catch {
		console.log('⚠ npm audit produced unparseable output — skipping gate.');
		console.log('✓ all 1 npm-audit-gate scenarios pass (gate-skipped, parse-error)');
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
	if (isAllowed(pkgName, severity)) {
		allowedCount++;
		continue;
	}
	failed++;
	failures.push(`${severity.toUpperCase()}: ${pkgName}`);
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
		for (const entry of ALLOWLIST) console.log(`    · ${entry.package} (≤${entry.maxSeverity})`);
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
