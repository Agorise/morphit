#!/usr/bin/env tsx
/*
 * order-completion-semantics — v1.5.5 (t155) guard.
 *
 * The maintainer's report, in one line: he and his counterparty completed a trade — BLURT
 * sent, Payment Receipt in the chat, both parties reviewed each other — and the
 * order still read "Live". It stayed searchable in the orderbook, still offered
 * "Cancel this order", still sat under Active orders, still showed "(Live)" in
 * the chat inbox, and the Paid pill counted 0.
 *
 * ROOT CAUSE: `broadcastOrderComplete` was called ONLY from my/orders'
 * auto-complete + manual-complete paths. The button labelled "Mark complete /
 * review" and the chat panel headed "Mark this trade complete" both went
 * through LeaveFeedbackForm, which posted the REVIEW and nothing else. The
 * completion half of both labels was never implemented.
 *
 * The whole downstream cluster follows from the order's status, so it all fixes
 * itself once the op is actually broadcast (the orderbook already filters
 * status='live'). That makes this one op the load-bearing piece of the batch —
 * hence a smoke.
 *
 * WHAT IS PINNED
 *   1. LeaveFeedbackForm broadcasts order_complete when (and only when) the
 *      caller asserts the user owns the cited order.
 *   2. It names the reviewed subject as the counterparty, so BOTH sides get
 *      trade credit (a taker owns no order and would otherwise read "0 trades"
 *      forever).
 *   3. The completion goes FIRST and is best-effort: from the consensus
 *      activation time (2026-11-01) a review citing the order is accepted only
 *      when the pair traded on it, and the completion naming the reviewed party
 *      is that proof (reviewAndComplete.ts). A failed completion still sends the
 *      review. Checked by RUNNING sendReviewAndCompletion, not by reading it.
 *   4. my/orders passes completeOwnedOrder (every order there is the user's).
 *   5. The chat gates it on `orderIsMine` — a chat may be about the PEER's
 *      order, and completing is owner-only.
 *   6. The client never names ITSELF as counterparty (the handler rejects
 *      counterparty_is_self, which would cost the user the whole completion).
 */

import { readFileSync } from 'node:fs';
import { sendReviewAndCompletion } from '../src/lib/feedback/reviewAndComplete';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');

const FORM = resolve(WEB, 'src/lib/components/LeaveFeedbackForm.svelte');
const CHAT = resolve(WEB, 'src/lib/components/ConversationView.svelte');
const MYORDERS = resolve(WEB, 'src/routes/[lang]/my/orders/+page.svelte');
const OPS = resolve(WEB, 'src/lib/blurt/ops/order.ts');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
	}
}

/** Whitespace-flattened source — assertions must survive reformatting. */
function flat(p: string): string {
	return readFileSync(p, 'utf8').replace(/\s+/g, ' ');
}

const form = flat(FORM);
const chat = flat(CHAT);
const myOrders = flat(MYORDERS);
const ops = flat(OPS);

// ── 1. the form completes the order ─────────────────────────────────
check(
	'LeaveFeedbackForm sends the completion for an owned order',
	/sendReviewAndCompletion\( \{ sendCompletion: \(\) => broadcastOrderComplete\(/.test(form) &&
		/completeOwnedOrder && !completionSent \)/.test(form),
	'submitting a review on your OWN order must also mark it complete — otherwise a settled trade stays Live, stays in the orderbook, keeps its Cancel button and counts 0 under Paid (the maintainer hit exactly this)'
);

// ── 2. it names the counterparty ────────────────────────────────────
check(
	'the reviewed subject is named as the counterparty (both sides credited)',
	/broadcastOrderComplete\(state\.live, orderPermlink, subject\)/.test(form),
	'without the counterparty only the OWNER is credited a trade; the taker owns no order and would read "0 trades" forever'
);

// ── 3. FIRST, and best-effort (run, not read) ──────────────────────
async function order(completionFails: boolean): Promise<string[]> {
	const calls: string[] = [];
	await sendReviewAndCompletion(
		{
			sendReview: async () => {
				calls.push('review');
				return { block_num: 1, trx_id: 't' };
			},
			sendCompletion: async () => {
				calls.push('complete');
				if (completionFails) throw new Error('locked');
			}
		},
		true
	);
	return calls;
}
const ok = await order(false);
check(
	'the completion reaches the chain BEFORE the review',
	ok.join(',') === 'complete,review',
	`got ${ok.join(',')} — from 2026-11-01 a review on an order the pair did not chat about is dropped unless the completion naming them is already on chain`
);
const failed = await order(true);
check(
	'a failed completion still sends the review (best-effort)',
	failed.join(',') === 'complete,review',
	`got ${failed.join(',')}`
);

// ── 4. my/orders opts in ────────────────────────────────────────────
check(
	'my/orders passes completeOwnedOrder (every order there is the user’s own)',
	/<LeaveFeedbackForm[^>]*completeOwnedOrder=\{true\}/.test(myOrders),
	'the button says "Mark complete / review" — it must do both halves'
);

// ── 5. the chat gates on ownership ──────────────────────────────────
check(
	'chat gates completion on orderIsMine (a chat may be about the PEER’s order)',
	/<LeaveFeedbackForm[^>]*completeOwnedOrder=\{orderIsMine\}/.test(chat),
	'completing is owner-only; in the other direction it is the peer’s job'
);
check(
	'orderIsMine is derived from the resolved order OWNER, not the peer',
	/const orderIsMine = \$derived\(orderOwner !== null && orderOwner === me\)/.test(chat),
	'ownership must come from the order record, never assumed from who opened the chat'
);

// ── 6. never name yourself ──────────────────────────────────────────
check(
	'broadcastOrderComplete refuses to name the signer as counterparty',
	/counterparty !== account/.test(ops) && /\{ permlink, counterparty \} : \{ permlink \}/.test(ops),
	'the handler rejects counterparty_is_self outright, which would cost the user the whole completion and leave the listing live'
);

console.log('\n' + '─'.repeat(58));
if (fail === 0) {
	console.log(`✓ all ${pass} order-completion-semantics scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
