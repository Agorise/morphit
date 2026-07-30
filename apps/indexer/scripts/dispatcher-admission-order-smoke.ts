/**
 * Dispatcher admission-priority sort — tsx smoke runner.
 *
 * Regression guard for the chat_v1 order-tag bug. A same-block "post order +
 * first message about that order" MUST run order_v1 (and stranger_fee_v1 /
 * block_v1) BEFORE chat_v1, so the Q11 order-bypass in the chat handler sees
 * the freshly-posted order instead of hard-rejecting the message with
 * `order_permlink_not_found` — which dropped the first message permanently and
 * suppressed its notification. Blurt does not order a block's transactions by
 * dependency, so the chat can land in an earlier tx than the order it names;
 * sortOpsForAdmission is what re-lifts the admission-affecting ops above chat.
 *
 * sortOpsForAdmission is pure (no DB), so this runs anywhere.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/dispatcher-admission-order-smoke.ts
 */

import {
	sortOpsForAdmission,
	PRE_CHAT_ADMISSION_OP_IDS,
	OP_IDS
} from '../src/indexer/dispatcher.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  \u2713 ${name}`);
	} catch (err) {
		failures++;
		console.log(`  \u2717 ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Minimal located-op shape: sortOpsForAdmission only reads `.op.id`. The
 *  `tag` lets us assert identity + relative order after the sort. */
type Loc = { op: { id: string }; trxInBlock: number; opInTrx: number; tag: string };
let seq = 0;
function mk(id: string, tag: string): Loc {
	const t = seq++;
	return { op: { id }, trxInBlock: t, opInTrx: 0, tag };
}
function tags(list: readonly Loc[]): string[] {
	return list.map((l) => l.tag);
}
function assertTags(actual: readonly Loc[], expected: string[], label: string): void {
	const a = JSON.stringify(tags(actual));
	const e = JSON.stringify(expected);
	if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

const CHAT = OP_IDS.chatMessage;
const ORDER = OP_IDS.order;
const FEE = OP_IDS.strangerFee;
const BLOCK = OP_IDS.block;
const FEEDBACK = OP_IDS.feedback;

// 1 — THE BUG: chat op precedes the order op on-chain; the sort must lift the
//     order op above it so the Q11 bypass can find the order.
scenario('order_v1 runs before a chat_v1 that landed in an earlier tx (the bug)', () => {
	seq = 0;
	const chat = mk(CHAT, 'chat');
	const order = mk(ORDER, 'order');
	assertTags(sortOpsForAdmission([chat, order]), ['order', 'chat'], 'order-before-chat');
});

// 2 — an already-correct input is left untouched.
scenario('order_v1 already before chat_v1 stays put', () => {
	seq = 0;
	const order = mk(ORDER, 'order');
	const chat = mk(CHAT, 'chat');
	assertTags(sortOpsForAdmission([order, chat]), ['order', 'chat'], 'stable');
});

// 3 — the original Finding A9 guarantees still hold.
scenario('stranger_fee_v1 runs before an earlier chat_v1', () => {
	seq = 0;
	const chat = mk(CHAT, 'chat');
	const fee = mk(FEE, 'fee');
	assertTags(sortOpsForAdmission([chat, fee]), ['fee', 'chat'], 'fee-before-chat');
});
scenario('block_v1 runs before an earlier chat_v1', () => {
	seq = 0;
	const chat = mk(CHAT, 'chat');
	const block = mk(BLOCK, 'block');
	assertTags(sortOpsForAdmission([chat, block]), ['block', 'chat'], 'block-before-chat');
});

// 4 — all three admission ops precede chat, in their on-chain (tx) order.
scenario('order + fee + block all precede a chat that came first, in tx order', () => {
	seq = 0;
	const chat = mk(CHAT, 'chat');
	const order = mk(ORDER, 'order');
	const fee = mk(FEE, 'fee');
	const block = mk(BLOCK, 'block');
	assertTags(
		sortOpsForAdmission([chat, order, fee, block]),
		['order', 'fee', 'block', 'chat'],
		'all-admission-before-chat'
	);
});

// 5 — stability: two admission ops keep their chronological order.
scenario('multiple admission ops keep chronological order (stable sort)', () => {
	seq = 0;
	const fee1 = mk(FEE, 'fee1');
	const chat = mk(CHAT, 'chat');
	const fee2 = mk(FEE, 'fee2');
	assertTags(
		sortOpsForAdmission([fee1, chat, fee2]),
		['fee1', 'fee2', 'chat'],
		'fee-order-preserved'
	);
});

// 6 — non-admission ops are only lifted above chat as a CLASS; their relative
//     order with each other and with chat is preserved.
scenario('non-admission ops preserve their relative order', () => {
	seq = 0;
	const feedback = mk(FEEDBACK, 'feedback');
	const chat = mk(CHAT, 'chat');
	const order = mk(ORDER, 'order');
	assertTags(
		sortOpsForAdmission([feedback, chat, order]),
		['order', 'feedback', 'chat'],
		'non-admission-stable'
	);
});

// 7 — the admission set is exactly the three gate-source ops; chat is NOT in it
//     (a chat that admits another chat would be nonsense).
scenario('PRE_CHAT_ADMISSION_OP_IDS holds order/fee/block and not chat', () => {
	for (const id of [ORDER, FEE, BLOCK]) {
		if (!PRE_CHAT_ADMISSION_OP_IDS.has(id)) throw new Error(`missing ${id}`);
	}
	if (PRE_CHAT_ADMISSION_OP_IDS.has(CHAT)) {
		throw new Error('chat_v1 must NOT be admission-priority');
	}
});

console.log(`\n${'\u2500'.repeat(54)}`);
if (failures === 0) {
	console.log(`\u2713 all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
