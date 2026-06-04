/**
 * local-block-smoke (beta5).
 *
 * Unit-tests the PURE core of instance-local blocking: planLocalBlock
 * (the insert/reblock/amend/unblock/noop state machine) and
 * normalizeAccount. The DB write path (applyLocalBlock) + the listing-
 * query enforcement are exercised against a real Postgres separately.
 */

import { planLocalBlock, normalizeAccount } from '../src/lib/localBlock.ts';

let pass = 0;
let fail = 0;
const expect = (n: string, c: boolean, d = '') => {
	if (c) {
		pass++;
		console.log(`  \u2713 ${n}`);
	} else {
		fail++;
		console.log(`  \u2717 ${n}`);
		if (d) console.log(`      ${d}`);
	}
};

// normalizeAccount
expect('normalize: strips @ + lowercases', normalizeAccount('@Alice') === 'alice');
expect('normalize: accepts dotted/hyphen names', normalizeAccount('foo.bar-baz') === 'foo.bar-baz');
expect('normalize: rejects spaces/symbols', normalizeAccount('BAD NAME!') === null);
expect('normalize: rejects too short', normalizeAccount('ab') === null);
expect('normalize: rejects leading digit', normalizeAccount('1abc') === null);

const plan = (
	action: 'block' | 'unblock',
	currentState: 'blocked' | 'unblocked' | null,
	currentReason: string | null = null,
	reason = ''
) => planLocalBlock({ action, account: 'alice', reason, currentState, currentReason }).op;

// block transitions
expect('block + no row → insert', plan('block', null) === 'insert');
expect('block + unblocked → reblock', plan('block', 'unblocked') === 'reblock');
expect('block + blocked, same reason → noop', plan('block', 'blocked', 'spam', 'spam') === 'noop');
expect('block + blocked, new reason → amend', plan('block', 'blocked', 'spam', 'fraud') === 'amend');

// unblock transitions
expect('unblock + blocked → unblock', plan('unblock', 'blocked') === 'unblock');
expect('unblock + unblocked → noop', plan('unblock', 'unblocked') === 'noop');
expect('unblock + no row → noop', plan('unblock', null) === 'noop');

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 local-block smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} local-block scenarios passed`);
