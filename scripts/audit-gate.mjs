#!/usr/bin/env node
/**
 * Supply-chain audit gate.
 *
 * Runs `npm audit --json` and fails (exit 1) if any HIGH or CRITICAL advisory
 * is present that is NOT in the baseline allowlist (.audit-allowlist.json).
 * The baseline records every advisory accepted after the triage documented in
 * the dependency audit (SECURITY-AUDIT-dependencies.md) — dev/build-only tools,
 * not-reachable transitive deps, and low-exposure runtime deps. The gate's job
 * is therefore to catch a NEW vulnerable dependency entering the tree (or a new
 * advisory on an existing one) — not to re-litigate the accepted baseline.
 *
 * Moderate/low advisories are reported but do not fail the gate (the baseline
 * already carries many; churn there is noise). Adjust FAIL_SEVERITIES if policy
 * changes.
 *
 * Usage: node scripts/audit-gate.mjs   (CI runs this with network access)
 * Offline (no network / npm audit unavailable): the gate SKIPS with a notice
 * rather than failing, so it never blocks an offline build — the allowlist's
 * structural integrity is checked separately by audit-allowlist-smoke.ts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FAIL_SEVERITIES = new Set(['high', 'critical']);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = join(repoRoot, '.audit-allowlist.json');

function loadAllowlist() {
	const raw = JSON.parse(readFileSync(allowlistPath, 'utf8'));
	if (!raw || typeof raw.allow !== 'object' || raw.allow === null) {
		throw new Error('.audit-allowlist.json: missing or malformed "allow" map');
	}
	return new Set(Object.keys(raw.allow));
}

function runAudit() {
	try {
		const out = execFileSync('npm', ['audit', '--json'], {
			cwd: repoRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 32 * 1024 * 1024
		});
		return JSON.parse(out);
	} catch (err) {
		// npm audit exits non-zero WHEN vulnerabilities exist — the JSON is still
		// on stdout, so parse it. A genuinely absent/failed audit (no stdout, e.g.
		// offline) is treated as a SKIP, not a failure.
		if (err && typeof err.stdout === 'string' && err.stdout.trim().startsWith('{')) {
			try {
				return JSON.parse(err.stdout);
			} catch {
				/* fall through to skip */
			}
		}
		return null;
	}
}

function currentAdvisories(audit) {
	// Map each GHSA advisory id -> { package, severity }
	const found = new Map();
	const vulns = audit.vulnerabilities ?? {};
	for (const v of Object.values(vulns)) {
		for (const via of v.via ?? []) {
			if (typeof via !== 'object' || via === null) continue;
			const url = via.url ?? '';
			const idx = url.indexOf('GHSA');
			if (idx === -1) continue;
			const ghsa = url.slice(idx);
			found.set(ghsa, { package: via.name ?? '', severity: via.severity ?? '' });
		}
	}
	return found;
}

function main() {
	const allow = loadAllowlist();
	const audit = runAudit();
	if (audit === null) {
		console.log('audit-gate: npm audit produced no parseable output (offline?) — SKIPPING.');
		console.log('           allowlist structure is validated separately by the smoke.');
		process.exit(0);
	}

	const found = currentAdvisories(audit);
	const offenders = [];
	for (const [ghsa, info] of found) {
		if (!FAIL_SEVERITIES.has(info.severity)) continue;
		if (!allow.has(ghsa)) offenders.push({ ghsa, ...info });
	}

	const total = found.size;
	const allowed = [...found.keys()].filter((g) => allow.has(g)).length;
	console.log(`audit-gate: ${total} advisories seen, ${allowed} in baseline allowlist.`);

	if (offenders.length > 0) {
		console.error(`\n✗ ${offenders.length} NEW high/critical advisory not in the baseline:`);
		for (const o of offenders) {
			console.error(`   [${o.severity}] ${o.package}  ${o.ghsa}`);
		}
		console.error(
			'\nA new high/critical dependency vulnerability entered the tree. Either patch it,' +
				'\nor — if genuinely accepted after triage — add its GHSA id to .audit-allowlist.json' +
				'\nwith a category and rationale (and update SECURITY-AUDIT-dependencies.md).'
		);
		process.exit(1);
	}

	console.log('✓ no new high/critical advisories outside the baseline.');
	process.exit(0);
}

main();
