/**
 * chat-thread-model-smoke — the meta-guard for the chat threading model.
 *
 * Morphit's chat threading behavior was broken and re-broken across three
 * releases. `docs/CHAT-THREADING-MODEL.md` is now the canonical spec, and each
 * invariant has a tamper-tested guard. THIS smoke guards the guards:
 *   1. the canonical doc exists and still states all five invariants (so it
 *      can't be gutted or deleted silently);
 *   2. the conversations query groups by (peer, order_permlink) with a NULL
 *      permlink as its own group (INV-2/3/4 — one card per thread, null is a
 *      first-class thread);
 *   3. every threading guard is still REGISTERED in the smoke runner (so nobody
 *      can quietly drop a guard and let a regression back in).
 *
 * If this smoke fails, the threading model's protection has been weakened —
 * do not "fix" it by loosening the assertions. See docs/CHAT-THREADING-MODEL.md.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(repo, p), 'utf8');

let failures = 0;
let total = 0;
function check(name: string, cond: boolean): void {
	total++;
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

// ── 1. The canonical doc exists and states all five invariants ──────────────
let doc = '';
try {
	doc = read('docs/CHAT-THREADING-MODEL.md');
} catch {
	/* handled by the check below */
}
check('docs/CHAT-THREADING-MODEL.md exists', doc.length > 0);
for (const inv of ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5']) {
	check(`the model doc still states ${inv}`, doc.includes(inv));
}
check(
	'the doc still names the (peer, order_permlink) thread identity',
	/\(peer, ?order_permlink\)|\(`?peer`?, ?`?order_permlink`?\)/.test(doc)
);
check(
	'the doc still asserts null is a first-class thread (not a bug)',
	/null[\s\S]{0,80}(first-class|real thread|thread of its own|not a bug)/i.test(doc)
);
check(
	'the doc still names the TWO tag points (client + server must agree)',
	/two tag points/i.test(doc)
);

// ── 2. The conversations query groups by (peer, order_permlink) ─────────────
const conv = read('apps/indexer/src/api/conversations.ts');
check(
	'conversations query GROUPs BY (peer, order_permlink) — one card per thread',
	/GROUP BY peer, order_permlink/.test(conv)
);
// A NULL group is only "its own thread" if the order-details join is
// null-tolerant (skips the lookup when the permlink is null) rather than
// dropping the row.
check(
	'the order-details join tolerates a NULL permlink (null thread survives)',
	/g\.order_permlink IS NOT NULL/.test(conv)
);

// ── 3. Every threading guard is still registered in the runner ──────────────
const runner = read('scripts/run-smokes.sh');
for (const guard of [
	'chat-thread-remount-smoke', // INV-5 client tag
	'chat-order-tag-storage-smoke', // INV-5 server tag
	'chat-inbox-threading-smoke', // INV-1 + INV-5 viewer filter
	'chat-fastpath-dedup-smoke', // INV-5 reconciliation
	'chat-thread-model-smoke' // this meta-guard itself
]) {
	check(`guard "${guard}" is still registered in run-smokes.sh`, runner.includes(guard));
}

if (failures === 0) {
	console.log(`✓ all ${total} chat-thread-model scenarios passed`);
} else {
	console.log(`\n✗ ${failures} of ${total} chat-thread-model checks FAILED`);
	process.exit(1);
}
