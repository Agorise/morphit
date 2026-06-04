/**
 * fast-forward-smoke (beta5).
 *
 * Unit-tests the PURE decision core of `morphit-ops fast-forward`
 * (planFastForward). The DB write itself needs Postgres and is a thin
 * wrapper; the branching logic (advance vs refuse-rewind vs noop vs
 * invalid + the skipped-block math) is what matters and is testable
 * here with no DB.
 */

import { planFastForward } from '../src/commands/fastForward.ts';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, detail = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (detail) console.log(`      ${detail}`);
};

function expect(name: string, cond: boolean, detail = '') {
	if (cond) ok(name);
	else bad(name, detail);
}

// advance — the main case
{
	const p = planFastForward(100, 1000);
	expect('advance: kind=advance', p.kind === 'advance', `got ${p.kind}`);
	expect('advance: skipped = target-current (900)', p.skipped === 900, `got ${p.skipped}`);
	expect('advance: message names the skipped range', /101.*1000/.test(p.message), p.message);
	expect('advance: message warns data is NOT indexed', /WITHOUT indexing/i.test(p.message));
}

// advance from a fresh-ish cursor to genesis-scale head
{
	const p = planFastForward(0, 59441298);
	expect('advance(0→genesis): kind=advance', p.kind === 'advance');
	expect('advance(0→genesis): skipped=59441298', p.skipped === 59441298, `got ${p.skipped}`);
}

// noop — already there
{
	const p = planFastForward(500, 500);
	expect('noop: kind=noop', p.kind === 'noop', `got ${p.kind}`);
	expect('noop: skipped=0', p.skipped === 0);
	expect('noop: message says nothing to do', /nothing to do/i.test(p.message));
}

// behind — forward-only refusal
{
	const p = planFastForward(1000, 500);
	expect('behind: kind=behind', p.kind === 'behind', `got ${p.kind}`);
	expect('behind: message refuses + mentions reset', /forward/i.test(p.message) && /reset/i.test(p.message));
}

// invalid — negative, fractional, NaN
{
	for (const [label, t] of [
		['negative', -1],
		['fractional', 3.5],
		['NaN', Number.NaN]
	] as const) {
		const p = planFastForward(100, t);
		expect(`invalid(${label}): kind=invalid`, p.kind === 'invalid', `got ${p.kind}`);
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 fast-forward smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} fast-forward scenarios passed`);
