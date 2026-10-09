#!/usr/bin/env tsx
/**
 * npm-audit-gate-smoke — the dependency audit, in the smoke battery.
 *
 * ONE allowlist, ONE rule set: this runs
 * scripts/audit-gate.mjs's verdict over `npm audit` against
 * scripts/audit-allowlist.json. It used to carry its own, different allowlist (by
 * package and title) and skipped with exit 0 when the registry could not be
 * reached; now an audit that cannot run fails, a stale entry fails, and an
 * advisory npm can fix within the current major fails (update instead).
 *
 * RELEASE REPORT MODE: release.yml re-runs the battery on the commit ci.yml
 * already passed, and the registry can change in between; it sets
 * MORPHIT_AUDIT_GATE_MODE=report, so a new HIGH, a stale entry or an in-range
 * fix only warns (::warning::). A new CRITICAL still fails. ci.yml never sets
 * it (ci-workflow-hardening-smoke enforces that).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = join(import.meta.dirname, '..', '..', '..');
const REPORT_MODE = process.env.MORPHIT_AUDIT_GATE_MODE === 'report';

type Verdict = { failures: string[]; warnings: string[]; notes: string[] };
const gate = (await import(pathToFileURL(join(REPO, 'scripts', 'audit-gate.mjs')).href)) as {
	auditOrReason: (cwd?: string) => { audit: unknown; reason: string | null };
	evaluate: (
		audit: unknown,
		allowText: string,
		o?: { mode?: string; reason?: string | null; fixes?: unknown; fixReason?: string | null }
	) => Verdict;
	inRangeFixesOrReason: (cwd?: string) => { fixes: unknown; reason: string | null };
	ALLOWLIST_PATH: string;
};

const { audit, reason } = gate.auditOrReason(REPO);
// The same in-range check CI's audit job runs: an advisory a plain (never
// --force) `npm audit fix` would clear must be fixed, not allowlisted.
const { fixes, reason: fixReason } = gate.inRangeFixesOrReason(REPO);
const v = gate.evaluate(audit, readFileSync(gate.ALLOWLIST_PATH, 'utf8'), {
	mode: REPORT_MODE ? 'report' : 'strict',
	reason,
	fixes,
	fixReason
});
for (const n of v.notes) console.log(`  note: ${n}`);
for (const w of v.warnings) {
	console.log(`  ⚠ ${w}`);
	console.log(`::warning title=npm audit::${w}`);
}
for (const f of v.failures) console.log(`  ✗ ${f}`);
if (v.failures.length > 0) {
	console.log(`✗ npm-audit-gate: ${v.failures.length} failed`);
	process.exit(1);
}
// The runner tallies the canonical `✓ all N` line; without it a pass counts as
// a failure.
console.log(
	`✓ all 1 npm-audit-gate checks passed — every advisory triaged in scripts/audit-allowlist.json${REPORT_MODE ? ' (report mode)' : ''}`
);
