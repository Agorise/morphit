#!/usr/bin/env tsx
/*
 * order-completion-semantics — v1.5.5 (t155) guard.
 *
 * Ken's report, in one line: he and his counterparty completed a trade — BLURT
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
 *   3. The completion is best-effort AFTER the review — the review is already
 *      irreversible on-chain, so a failed completion must not report the submit
 *      as failed and invite a duplicate review.
 *   4. my/orders passes completeOwnedOrder (every order there is the user's).
 *   5. The chat gates it on `orderIsMine` — a chat may be about the PEER's
 *      order, and completing is owner-only.
 *   6. The client never names ITSELF as counterparty (the handler rejects
 *      counterparty_is_self, which would cost the user the whole completion).
 */

import { readFileSync } from 'node:fs';
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
	'LeaveFeedbackForm broadcasts order_complete for an owned order',
	/if \(completeOwnedOrder\) \{ try \{ await broadcastOrderComplete\(/.test(form),
	'submitting a review on your OWN order must also mark it complete — otherwise a settled trade stays Live, stays in the orderbook, keeps its Cancel button and counts 0 under Paid (Ken hit exactly this)'
);

// ── 2. it names the counterparty ────────────────────────────────────
check(
	'the reviewed subject is named as the counterparty (both sides credited)',
	/await broadcastOrderComplete\(state\.live, orderPermlink, subject\)/.test(form),
	'without the counterparty only the OWNER is credited a trade; the taker owns no order and would read "0 trades" forever'
);

// ── 3. best-effort, and AFTER the review ────────────────────────────
check(
	'the completion cannot fail the review (best-effort, caught)',
	/if \(completeOwnedOrder\) \{ try \{ await broadcastOrderComplete\([^)]*\); \} catch/.test(form),
	'the review is already irreversible on-chain; a failed completion must not report the submit as failed and invite a duplicate review'
);
check(
	'the completion runs AFTER the review broadcast',
	form.indexOf('await broadcastFeedback(') !== -1 &&
		form.indexOf('await broadcastFeedback(') < form.indexOf('await broadcastOrderComplete('),
	'the review is what the user typed — it must land first'
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
