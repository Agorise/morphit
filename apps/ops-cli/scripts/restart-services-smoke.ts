/**
 * restart-services smoke (cp225).
 *
 * Guards the grandma-friendly fix where `morphit-ops edit` (menu #3) and
 * `alt-address` (menu #4) now OFFER to restart the affected service(s)
 * and do it — instead of printing a `systemctl` line the operator has to
 * run by hand.  Setting the Tor/Lokinet/I2P footer address must light up
 * the pill with no manual restart.
 *
 * Covers:
 *   - restartServices: per-unit exec, status→failure-list propagation.
 *   - offerRestart: decline path (no exec, returns false), accept+success
 *     (returns true), accept+partial-failure (returns false).
 *   - wiring: edit.ts + altAddress.ts import AND call offerRestart, and no
 *     longer leave a bare "copy this systemctl line" as the only path.
 *   - helper safety: sudo only when non-root (getuid guard) + inherited
 *     stdio in the real runner.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { restartServices, offerRestart, type RestartExec } from '../src/lib/restartServices.ts';

const ROOT = join(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
function ok(n: string): void {
	console.log(`  ✓ ${n}`);
	pass++;
}
function bad(n: string, d = ''): void {
	console.error(`  ✗ ${n}`);
	if (d) console.error(`      ${d}`);
	fail++;
}
function expect(n: string, cond: boolean, d = ''): void {
	cond ? ok(n) : bad(n, d);
}

console.log('\n── restart-services smoke (cp225) ──\n');

// ─── restartServices: status propagation ───
{
	const calls: Array<{ cmd: string; args: readonly string[] }> = [];
	const allOk: RestartExec = (cmd, args) => {
		calls.push({ cmd, args });
		return { status: 0 };
	};
	const failed = restartServices(['morphit-indexer', 'morphit-relay'], allOk);
	expect('restartServices: all-success → no failures', failed.length === 0, `got ${JSON.stringify(failed)}`);
	expect('restartServices: one exec call per unit', calls.length === 2, `got ${calls.length}`);
	expect(
		'restartServices: each call is a `restart <unit>`',
		calls.every((c) => c.args.includes('restart')) &&
			calls.some((c) => c.args.includes('morphit-indexer')) &&
			calls.some((c) => c.args.includes('morphit-relay')),
		JSON.stringify(calls)
	);
}
{
	const partial: RestartExec = (_cmd, args) => ({ status: args.includes('morphit-relay') ? 1 : 0 });
	const failed = restartServices(['morphit-indexer', 'morphit-relay'], partial);
	expect(
		'restartServices: a non-zero status lands the unit in the failure list',
		failed.length === 1 && failed[0] === 'morphit-relay',
		JSON.stringify(failed)
	);
}
{
	const spawnError: RestartExec = () => ({ status: null }); // binary-not-found shape
	const failed = restartServices(['morphit-indexer'], spawnError);
	expect('restartServices: null status (spawn error) counts as failure', failed.length === 1, JSON.stringify(failed));
}

// ─── offerRestart: decline / accept-success / accept-failure ───
{
	let execCalled = false;
	const exec: RestartExec = () => {
		execCalled = true;
		return { status: 0 };
	};
	const res = await offerRestart(['morphit-indexer'], { confirm: async () => false, exec });
	expect('offerRestart: decline → returns false', res === false);
	expect('offerRestart: decline → NEVER restarts', execCalled === false);
}
{
	const res = await offerRestart(['morphit-indexer'], { confirm: async () => true, exec: () => ({ status: 0 }) });
	expect('offerRestart: accept + success → returns true', res === true);
}
{
	const res = await offerRestart(['morphit-indexer'], { confirm: async () => true, exec: () => ({ status: 1 }) });
	expect('offerRestart: accept + failure → returns false (manual fallback printed)', res === false);
}
{
	const res = await offerRestart([], { confirm: async () => true, exec: () => ({ status: 0 }) });
	expect('offerRestart: empty unit list → no-op false', res === false);
}
{
	// The default must be YES so a bare Enter applies the change.
	let sawDefault: boolean | null = null;
	await offerRestart(['morphit-indexer'], {
		confirm: async (_q, def) => {
			sawDefault = def;
			return false;
		},
		exec: () => ({ status: 0 })
	});
	expect('offerRestart: prompt defaults to YES (Enter restarts)', sawDefault === true, `default was ${sawDefault}`);
}

// ─── helper source safety ───
{
	const src = readFileSync(join(ROOT, 'src/lib/restartServices.ts'), 'utf-8');
	expect('helper: sudo only when NOT root (getuid guard)', /getuid/.test(src) && /\bsudo\b/.test(src), '');
	expect("helper: real runner inherits stdio", /stdio:\s*'inherit'/.test(src), '');
	expect('helper: exports restartServices + offerRestart', /export function restartServices/.test(src) && /export async function offerRestart/.test(src), '');
}

// ─── wiring: edit.ts + altAddress.ts ───
{
	const edit = readFileSync(join(ROOT, 'src/commands/edit.ts'), 'utf-8');
	expect('edit.ts: imports offerRestart from the helper', /import\s*\{[^}]*offerRestart[^}]*\}\s*from\s*'\.\.\/lib\/restartServices\.ts'/.test(edit), '');
	expect('edit.ts: calls offerRestart(...)', /offerRestart\(/.test(edit), '');
	expect(
		'edit.ts: restarts indexer, + relay when origin changed',
		/morphit-indexer/.test(edit) && /originChanged\)\s*unitsToRestart\.push\('morphit-relay'\)/.test(edit),
		''
	);
	expect(
		'edit.ts: no longer prints a bare manual-only restart as the sole path',
		!/console\.log\('\s*sudo systemctl restart morphit-indexer'\)/.test(edit),
		'a hardcoded manual-only restart line is still present'
	);
}
{
	const alt = readFileSync(join(ROOT, 'src/commands/altAddress.ts'), 'utf-8');
	expect('altAddress.ts: imports offerRestart from the helper', /import\s*\{[^}]*offerRestart[^}]*\}\s*from\s*'\.\.\/lib\/restartServices\.ts'/.test(alt), '');
	expect('altAddress.ts: calls offerRestart([\'morphit-indexer\'])', /offerRestart\(\['morphit-indexer'\]\)/.test(alt), '');
	expect(
		'altAddress.ts: dropped the old "Last step — restart the indexer" manual block',
		!/Last step — restart the indexer/.test(alt),
		'the old manual-restart block is still present'
	);
}

const total = pass + fail;
console.log(`\n${pass} passed, ${fail} failed (${total} total)`);
if (fail > 0) {
	console.error('\nrestart-services smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} restart-services scenarios passed`);
