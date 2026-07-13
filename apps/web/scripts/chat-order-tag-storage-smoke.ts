/**
 * chat-order-tag-storage-smoke — v1.4.9 (t.txt #4 root cause, server side)
 *
 * The indexer's chat handler validates a message's `order_permlink` against
 * `orders WHERE account IN (recipient, signer)` — i.e. the tag is legitimate
 * when the order belongs to EITHER party. The stored tag must follow that same
 * rule. The long-standing bug was that the INSERT gated storage on
 * `orderResponseBypass` (recipient-owns-a-live-order) instead — so the order
 * OWNER's own replies had their tag stripped to NULL, splitting the thread into
 * a phantom "RE: -" card the other party never saw (three releases of this).
 *
 * `orderResponseBypass` must stay NARROW: it governs ONLY the stranger-fee gate.
 * It must NOT gate the stored `order_permlink`. Pin both facts.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = readFileSync(join(repo, 'apps/indexer/src/indexer/handlers/chat.ts'), 'utf8');

// Strip line comments so a doc-comment describing the OLD behaviour can't
// satisfy or trip a check.
const code = src
	.split('\n')
	.map((l) => {
		const i = l.indexOf('//');
		return i === -1 ? l : l.slice(0, i);
	})
	.join('\n');

let failures = 0;
let total = 0;
function check(name: string, cond: boolean): void {
	total++;
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

// 1. The order-validation lookup accepts an order owned by EITHER party.
check(
	'orderCheck validates against account IN (recipient, signer) — either party',
	/account IN \(\$2, \$4\)/.test(code)
);

// 2. The INSERT's order_permlink value column stores the validated permlink
//    directly (kept for either party), NOT gated on orderResponseBypass.
check(
	'the INSERT stores `claimedPermlink ?? null` (tag kept for either party)',
	/claimedPermlink \?\? null/.test(code)
);
check(
	'the INSERT does NOT gate the stored tag on orderResponseBypass',
	!/orderResponseBypass\s*\?\s*\(?claimedPermlink/.test(code)
);

// 3. orderResponseBypass still exists and still gates the stranger-fee path
//    (it must remain narrow, not be deleted).
check(
	'orderResponseBypass is still computed (recipient owns a live order)',
	/orderResponseBypass\s*=\s*ord\.account === recipient && ord\.live/.test(code)
);
check(
	'orderResponseBypass still gates the stranger-fee admission path',
	/if \(!orderResponseBypass\)/.test(code)
);

if (failures === 0) {
	console.log(`✓ all ${total} chat-order-tag-storage scenarios passed`);
} else {
	console.log(`\n✗ ${failures} of ${total} chat-order-tag-storage checks FAILED`);
	process.exit(1);
}
