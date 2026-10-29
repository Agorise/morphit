#!/usr/bin/env tsx
/**
 * review-status-wiring — v1.21.17.
 *
 * A review the indexers refused (a first trade's, before the rule changed)
 * showed its stars until the next reload; then the chat asked for a review
 * again on every visit, and nothing said it had not counted. sentReviews.ts
 * keeps what was sent and asks the instance what became of it; this smoke
 * pins that every surface goes by it.
 *
 * Tamper tests (each must turn this red):
 *   - The form stops keeping what it sent.
 *   - The chat asks for a review whatever the instance says (drop reviewWanted).
 *   - The chat stops saying a review did not count.
 *   - The review stops naming the peer on an order completed with no partner
 *     named, or names one over a partner already named.
 *   - The inbox re-subscribes on every refresh, or loses the "not counted" label.
 *   - My profile stops listing what I sent that is not in the indexer's list,
 *     lists counted ones as news, or re-asks about every review on each change.
 *   - A text loses its {date} / @{peer} in any language.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(WEB, p), 'utf8');
const form = read('src/lib/components/LeaveFeedbackForm.svelte');
const chat = read('src/lib/components/ConversationView.svelte');
const inbox = read('src/routes/[lang]/chat/+page.svelte');
const profile = read('src/routes/[lang]/[x+40][account=account]/+page.svelte');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean): void => {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (cond) passed++;
	else failed++;
};

check(
	'the form keeps what it sent, with its transaction',
	/rememberSentReview\(\{[\s\S]{0,300}trx_id: result\.trx_id/.test(form)
);
check(
	'the form re-fills a review sent again (a saved draft still wins)',
	/\} else if \(resend\) \{\s*rating = resend\.rating;\s*comment = resend\.comment \?\? '';/.test(
		form
	)
);
check(
	'the chat watches the review of this trade',
	/watchSentReview\(ref\)\.subscribe\(\(v\) => \(reviewVerdict = v\)\)/.test(chat)
);
check(
	'the chat asks only when none was sent, or one may be sent again',
	/reviewVerdict\.kind === 'resend' \|\| \(reviewVerdict\.kind === 'pending' && mySentReview === null\)/.test(
		chat
	) && /!justSubmittedFeedback &&\s*reviewWanted &&/.test(chat)
);
check(
	'the chat says when a review did not count',
	/\{:else if reviewNotCounted\}[\s\S]{0,600}chat\.feedback\.not_counted_later[\s\S]{0,300}chat\.feedback\.not_counted'/.test(
		chat
	)
);
check(
	'the review completes the order (naming this peer) unless a partner is already named',
	/completeOwnedOrder=\{orderIsMine &&\s*!\(orderRecord\?\.status === 'completed' && orderRecord\.completed_counterparty != null\)\}/.test(
		chat
	) && /resend=\{reviewResend\}/.test(chat)
);
check(
	'the inbox keeps its watchers across refreshes',
	/if \(reviewWatches\.has\(watchKey\)\) continue;/.test(inbox) &&
		/if \(!wanted\.has\(watchKey\)\) \{\s*stop\(\);\s*reviewWatches\.delete\(watchKey\);/.test(
			inbox
		)
);
check(
	'the inbox shows what was sent after a reload, and whether it counted',
	/\(sent \? sentReviewAsRecord\(sent\) : null\) \?\?/.test(inbox) &&
		/data-testid="inbox-review-not-counted"/.test(inbox) &&
		// a review that may be sent again has not counted either
		/verdict\.kind === 'later' \|\|\s*verdict\.kind === 'resend' \|\|\s*verdict\.kind === 'needs_transfer'\s*\?\s*'later'/.test(
			inbox
		)
);
check(
	'the inbox asks only when none was sent, or one may be sent again',
	/verdict\.kind === 'resend' \|\| \(verdict\.kind === 'pending' && record === null\)/.test(inbox)
);
check(
	'my profile lists what I sent that the indexer does not list',
	/sentReviewsBy\(account\)\s*\.filter\(/.test(profile) &&
		/k !== undefined && k !== 'checking' && k !== 'counted'/.test(profile) &&
		/if \(sentWatches\.has\(trx\)\) continue;/.test(profile) &&
		/if \(!isOwnProfile \|\| feedbackGivenState !== 'ready'\) return \[\];/.test(profile) &&
		/data-testid="given-sent-not-listed"/.test(profile)
);

check(
	'a first trade waiting for its proof says who must send whom 1 BLURT (chat, inbox, profile)',
	/reviewNotCounted\.kind === 'needs_transfer'[\s\S]{0,120}chat\.feedback\.not_counted_needs_transfer/.test(
		chat
	) &&
		/verdict\.kind === 'needs_transfer'\) &&/.test(inbox) &&
		/v\?\.kind === 'needs_transfer'[\s\S]{0,80}profile\.given_needs_transfer/.test(profile)
);

const needs: Array<[string, string, string[]]> = [
	['chat', 'not_counted_needs_transfer', ['{peer}', '{from}', '{to}', '{date}']],
	['profile', 'given_needs_transfer', ['{from}', '{to}', '{date}']],
	['chat', 'not_counted_later', ['{peer}', '{date}']],
	['chat', 'not_counted', ['{peer}']],
	['chat', 'resend_now', ['{peer}']],
	['profile', 'given_not_counted_later', ['{date}']]
];
for (const { code } of SUPPORTED_LOCALES) {
	const d = JSON.parse(read(`src/lib/i18n/locales/${code}.json`)) as {
		chat: { feedback: Record<string, string>; inbox: Record<string, string> };
		profile: Record<string, string>;
	};
	for (const [ns, key, holes] of needs) {
		const v = ns === 'chat' ? d.chat.feedback[key] : d.profile[key];
		check(
			`${code} ${ns}.${key} carries ${holes.join(' ')}`,
			holes.every((h) => v?.includes(h))
		);
	}
	for (const key of ['given_not_counted', 'given_send_again', 'given_pending', 'given_open_chat']) {
		check(`${code} profile.${key}`, (d.profile[key] ?? '').length > 0);
	}
	for (const key of ['review_not_counted_yet', 'review_not_counted']) {
		check(`${code} chat.inbox.${key}`, (d.chat.inbox[key] ?? '').length > 0);
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) {
	console.log(`✓ all ${passed} review-status-wiring scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failed} of ${passed + failed} review-status-wiring scenarios FAILED`);
process.exit(1);
