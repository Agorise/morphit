/**
 * moderation-smoke (beta5).
 *
 * Unit-tests the pure aggregation behind the merged moderation screen
 * (collectFlaggedAccounts) and asserts the command's structural
 * guarantees: the interactive block/unblock resolution is gated on a
 * TTY, reuses the shared instance-local write path, and supports
 * --json. (The block write path itself is covered by local-block-smoke
 * + the real-Postgres lifecycle check.)
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFlaggedAccounts } from '../src/lib/moderationSignals.ts';

let pass = 0;
let fail = 0;
const eq = (n: string, a: unknown, b: unknown) => {
	const ok = JSON.stringify(a) === JSON.stringify(b);
	if (ok) {
		pass++;
		console.log(`  \u2713 ${n}`);
	} else {
		fail++;
		console.log(`  \u2717 ${n}`);
		console.log(`      got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
	}
};
const truthy = (n: string, c: boolean) => {
	if (c) {
		pass++;
		console.log(`  \u2713 ${n}`);
	} else {
		fail++;
		console.log(`  \u2717 ${n}`);
	}
};

// collectFlaggedAccounts — distinct + sorted across both streams
eq('empty → []', collectFlaggedAccounts([], []), []);
eq(
	'dedups within + across streams, sorted',
	collectFlaggedAccounts(
		[
			{ account_a: 'bob', account_b: 'alice' },
			{ account_a: 'alice', account_b: 'carol' }
		],
		[{ account_a: 'carol', account_b: 'dave' }]
	),
	['alice', 'bob', 'carol', 'dave']
);
eq(
	'reciprocity-only',
	collectFlaggedAccounts([{ account_a: 'zed', account_b: 'amy' }], []),
	['amy', 'zed']
);

// Structural guards on the command source
const src = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'moderation.ts'),
	'utf8'
);
truthy('resolution gated on a TTY', src.includes('process.stdin.isTTY !== true'));
truthy('reuses the shared block write path (applyLocalBlock)', src.includes('applyLocalBlock'));
truthy('rejects self-block in the loop', src.includes('your own operator account'));
truthy('supports --json (skips the prompt)', /json[\s\S]{0,40}emitJson/.test(src));
truthy(
	'shows block status per flagged account',
	src.includes('fetchBlockStatuses') && src.includes('[BLOCKED]')
);
truthy(
	'frames blocking as instance-local + reversible',
	src.includes('THIS instance only') && src.includes('reversible')
);

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 moderation smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} moderation scenarios passed`);
