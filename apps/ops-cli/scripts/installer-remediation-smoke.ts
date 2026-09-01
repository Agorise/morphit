#!/usr/bin/env tsx
/**
 * installer-remediation-smoke.ts (cp-installer-hardening)
 *
 * Locks the self-healing installer layer: every failing check gets a suggestion,
 * safe fixes are OFFERED (not forced), the journal records exactly what happened
 * (fixed / declined / manual / fix-failed), the final report surfaces it, and a
 * truly-stuck admin is pointed at agorise@pm.me. All deps injected — no terminal,
 * no shell, no host state.
 */
import {
	remediationFor,
	runRemediations,
	renderRemediationReport,
	SUPPORT_EMAIL,
	SUPPORT_MATRIX,
	type Remediation
} from '../src/init/remediation.ts';
import type { Check } from '../src/init/systemCheck.ts';

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean): void {
	if (ok) { pass++; console.log(`  ✓ ${desc}`); }
	else { fails.push(desc); console.log(`  ✗ ${desc}`); }
}
const mk = (name: string, actual: string, status: Check['status'], note?: string): Check => ({ name, actual, recommended: '', status, note });

console.log('\n── installer remediation smoke ────────────────────────\n');

check('support address is agorise@pm.me', SUPPORT_EMAIL === 'agorise@pm.me');

// ── remediationFor ────────────────────────────────────────────────
check('an OK check has no remediation', remediationFor(mk('x', 'ok', 'ok')) === null);
{
	const r = remediationFor(mk('localhost resolves', 'no', 'error'));
	check('no-localhost is AUTO-FIXABLE (adds to /etc/hosts)', !!r?.autoFix && /\/etc\/hosts/.test(r.autoFix.command));
}
{
	const r = remediationFor(mk('RAM total', '1.0 GB', 'warn'));
	check('low RAM offers a swapfile auto-fix', !!r?.autoFix && /swapfile/.test(r.autoFix.command));
}
{
	const r = remediationFor(mk('Port availability', 'in use: 80 (public HTTP)', 'error'));
	check('a port conflict gives a suggestion but NO auto-fix (won\'t kill other apps)', !!r && !r.autoFix && /ss -tlnp/.test(r.suggestion));
}
{
	const r = remediationFor(mk('Docker subnet', '172.20.0.0/16 taken', 'error'));
	check('a subnet clash suggests removing the network, no auto-fix', !!r && !r.autoFix && /docker network/.test(r.suggestion));
}
{
	const r = remediationFor(mk('Node.js', '18.0.0', 'error'));
	check('old Node suggests upgrade, no auto-fix (won\'t disturb their tooling)', !!r && !r.autoFix);
}
{
	const r = remediationFor(mk('Some novel error', 'weird', 'error', 'try turning it off and on'));
	check('an unknown error WITH a note gives that guidance, NOT a last resort', !!r && r.lastResort === false && /off and on/.test(r.suggestion));
}
{
	const r = remediationFor(mk('Some novel error', 'weird', 'error'));
	check('an unknown error with NO guidance at all IS the last resort (worst case)', !!r && r.lastResort === true);
}
check('an unknown WARN with no handler yields null (just shows its own note)', remediationFor(mk('Some novel warn', 'x', 'warn')) === null);

// ── runRemediations: outcomes ─────────────────────────────────────
async function run(checks: Check[], ans: boolean, execOk = true) {
	const cmds: string[] = [];
	const j = await runRemediations(checks, { ask: async () => ans, exec: (c) => { cmds.push(c); return execOk; }, print: () => {} });
	return { j, cmds };
}
{
	const { j, cmds } = await run([mk('localhost resolves', 'no', 'error')], true);
	check('YES to a fixable → outcome "fixed" + the command ran', j[0]?.outcome === 'fixed' && cmds.length === 1);
}
{
	const { j, cmds } = await run([mk('localhost resolves', 'no', 'error')], false);
	check('NO to a fixable → outcome "declined" + nothing ran', j[0]?.outcome === 'declined' && cmds.length === 0);
}
{
	const { j } = await run([mk('localhost resolves', 'no', 'error')], true, false);
	check('YES but the fix FAILS → outcome "fix-failed", NOT last-resort (manual command still given)', j[0]?.outcome === 'fix-failed' && j[0]?.lastResort === false);
}
{
	const { j, cmds } = await run([mk('Port availability', 'in use: 80', 'error')], true);
	check('a no-auto-fix item → outcome "manual", never prompts a shell command', j[0]?.outcome === 'manual' && cmds.length === 0);
}
{
	const { j } = await run([mk('all', 'good', 'ok')], true);
	check('OK checks produce no journal entries', j.length === 0);
}

// ── renderRemediationReport ───────────────────────────────────────
check('an empty journal renders nothing', renderRemediationReport([]) === '');
{
	const rep = renderRemediationReport([
		{ checkName: 'localhost resolves', problem: 'no', outcome: 'fixed', detail: 'you approved: echo…', lastResort: false },
		{ checkName: 'Port availability', problem: 'in use: 80', outcome: 'manual', detail: 'stop the app on 80', lastResort: false }
	]);
	check('report shows what was fixed', /Fixed during setup/.test(rep) && /localhost resolves/.test(rep));
	check('report shows what still needs attention', /Still needs your attention/.test(rep) && /Port availability .*\(manual\)/.test(rep));
	check('no lastResort item → no support line', !rep.includes(SUPPORT_EMAIL));
}
{
	const rep = renderRemediationReport([{ checkName: 'X', problem: 'y', outcome: 'fix-failed', detail: 'd', lastResort: true }]);
	check('a lastResort item → email + Matrix (preferred) both appear', rep.includes(SUPPORT_EMAIL) && rep.includes(SUPPORT_MATRIX) && /Matrix:.*preferred/.test(rep));
}
{
	// The common cases — a declined fix, a manual port conflict, a failed fix —
	// must NEVER surface the support email (the admin has a way forward).
	const rep = renderRemediationReport([
		{ checkName: 'localhost resolves', problem: 'no', outcome: 'declined', detail: 'add it to /etc/hosts', lastResort: false },
		{ checkName: 'Port availability', problem: 'in use: 80', outcome: 'manual', detail: 'stop the app on 80', lastResort: false },
		{ checkName: 'RAM total', problem: 'low', outcome: 'fix-failed', detail: 'run the swap command yourself', lastResort: false }
	]);
	check('ordinary failures do NOT show any support contact', !rep.includes(SUPPORT_EMAIL) && !rep.includes(SUPPORT_MATRIX));
}

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) { console.log(`✗ ${fails.length} of ${total} installer-remediation checks FAILED`); process.exit(1); }
console.log(`✓ all ${total} installer-remediation scenarios passed`);
