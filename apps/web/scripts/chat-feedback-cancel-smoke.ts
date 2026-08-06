#!/usr/bin/env tsx
/**
 * apps/web/scripts/chat-feedback-cancel-smoke.ts  (v1.9.0, Ken)
 *
 * The "Mark this trade complete" card's Cancel button did nothing: LeaveFeedbackForm
 * wired its Cancel to an `onCancel` prop, but ConversationView never passed one, so
 * the click was a no-op. This pins the wiring so it can't regress:
 *   - LeaveFeedbackForm's Cancel button calls the onCancel prop
 *   - ConversationView passes onCancel (dismissing the card via feedbackDismissed)
 *   - the card is gated on !feedbackDismissed so the dismissal actually hides it
 *
 * Greps strip comments first.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMP = resolve(HERE, '..', 'src', 'lib', 'components');
let pass = 0,
	fail = 0;
const ok = (m: string) => (pass++, console.log(`  \u2713 ${m}`));
const bad = (m: string, d = '') => (fail++, console.log(`  \u2717 ${m}${d ? `\n      ${d}` : ''}`));
const strip = (s: string) =>
	s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const read = (p: string) => strip(readFileSync(p, 'utf8'));

// LeaveFeedbackForm: an onCancel prop, and the Cancel button calls it.
{
	const f = read(resolve(COMP, 'LeaveFeedbackForm.svelte'));
	/onCancel\??:\s*\(\)\s*=>\s*void/.test(f)
		? ok('LeaveFeedbackForm declares onCancel prop')
		: bad('LeaveFeedbackForm declares onCancel prop');
	// the ghost Cancel button binds onclick to onCancel
	/onclick=\{onCancel\}/.test(f)
		? ok('Cancel button onclick={onCancel}')
		: bad('Cancel button onclick={onCancel}');
}

// ConversationView: passes onCancel + gates on the dismissal flag.
{
	const v = read(resolve(COMP, 'ConversationView.svelte'));
	/let feedbackDismissed\s*=\s*\$state\(false\)/.test(v)
		? ok('ConversationView has feedbackDismissed state')
		: bad('ConversationView has feedbackDismissed state');
	/onCancel=\{\(\)\s*=>\s*\(feedbackDismissed\s*=\s*true\)\}/.test(v)
		? ok('passes onCancel that dismisses the card')
		: bad('passes onCancel that dismisses the card');
	/canLeaveFeedback\s*&&\s*!feedbackDismissed/.test(v)
		? ok('card gated on !feedbackDismissed')
		: bad('card gated on !feedbackDismissed');
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 chat-feedback-cancel smoke FAILED (${fail})`);
	process.exit(1);
}
console.log('\u2713 feedback Cancel wired end-to-end (prop → button → dismissal gate)');
console.log(`\u2713 all ${pass} chat-feedback-cancel scenarios passed`);
