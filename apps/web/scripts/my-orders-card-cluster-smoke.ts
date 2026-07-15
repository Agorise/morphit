#!/usr/bin/env tsx
/**
 * Smoke: my/orders card cluster (#8, #9, #10). Anchor 2026-07-08.
 *
 *   #8  edit-window countdown pill: warm yellow (amber, not red), CENTERED
 *       ABOVE the Edit button, keeps its pulse near expiry; the confusing
 *       "No trade partner to review yet" line is gone (but the review button
 *       is still correctly withheld when there's no counterparty).
 *   #9  top fee-status explainer: 💡 prefix, "may appear to be missing"
 *       wording, and an X that dismisses it forever (localStorage).
 *   #10 "Mark complete / review" smooth-scrolls to the feedback form.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const page = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'my', 'orders', '+page.svelte'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

// ── #8 edit-window pill ─────────────────────────────────────────────────────
const editBlock = /\{#if withinEditWindow\(o\)\}[\s\S]*?\{:else if withinEditClosedNotice/.exec(page)?.[0] ?? '';
check('#8 pill uses warm amber, not red', /bg-amber-100[\s\S]*text-amber-900/.test(editBlock) && !/bg-red-100/.test(editBlock));
check('#8 pill is centered (self-center, not self-end)', /self-center/.test(editBlock) && !/self-end/.test(editBlock));
check('#8 pill keeps the pulse near expiry', /remaining <=\s*\n?\s*30[\s\S]*animate-pulse/.test(editBlock));
// pill appears ABOVE the Edit button (its <span> comes before the Edit BusyButton)
const pillIdx = editBlock.indexOf('edit_window_countdown');
const btnIdx = editBlock.indexOf('action_edit');
check('#8 pill is rendered ABOVE the Edit button', pillIdx !== -1 && btnIdx !== -1 && pillIdx < btnIdx);
check(
	'#8 the 0-counterparty branch explains itself, and still withholds the review button',
	// SUPERSEDED, v1.5.0 (t.txt line 1). The original ask was to delete the
	// confusing "No trade partner to review yet" line, leaving `{void 0}` — so
	// this asserted the key was ABSENT. Ken then revised it: an empty gap left
	// users wondering why no review button appeared, so the branch now renders a
	// green box ("No chats with a counterparty have happened yet").
	// The SAFETY property is unchanged and still checked: with zero reviewable
	// counterparties we must NOT offer the review button.
	/feedback_no_counterparty/.test(page) && /length === 0\}/.test(page)
);

// ── #9 fee-status banner ────────────────────────────────────────────────────
check('#9 banner is behind a dismiss guard', /\{#if !feeStatusBannerDismissed\}/.test(page));
check('#9 banner has an X that dismisses forever (persisted)', /dismissFeeStatusBanner/.test(page) && /FEE_BANNER_DISMISS_KEY/.test(page) && /safeLocal\.set\(FEE_BANNER_DISMISS_KEY/.test(page));
check('#9 dismiss reads persisted state on load', /safeLocal\.get\(FEE_BANNER_DISMISS_KEY\)/.test(page));

// Derived from the single source of truth so adding an 11th locale can never
// silently skip this smoke (locale-source-of-truth-smoke enforces this).
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
let bannerOk = true;
for (const loc of LOCALES) {
	const j = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', `${loc}.json`), 'utf8'));
	const fsb = j?.my_orders?.fee_status_banner;
	if (!fsb || typeof fsb.body !== 'string' || !fsb.body.startsWith('💡')) bannerOk = false;
	if (!fsb || typeof fsb.dismiss !== 'string') bannerOk = false;
}
check('#9 all 10 locales: body starts with 💡 + a dismiss label exists', bannerOk);
const en = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', 'en.json'), 'utf8'));
check('#9 EN body reworded to "may appear to be missing"', en.my_orders.fee_status_banner.body.includes('may appear to be missing'));

// ── #10 smooth-scroll to feedback form ──────────────────────────────────────
check('#10 has scrollToFeedbackForm helper', /function scrollToFeedbackForm/.test(page));
check('#10 helper is called when the review form opens', (page.match(/scrollToFeedbackForm\(/g)?.length ?? 0) >= 2);
check('#10 feedback form has a scroll anchor (feedback-form-{permlink} + scroll-mt-24)', /scroll-mt-24" id="feedback-form-\{o\.permlink\}"/.test(page));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} my-orders-card-cluster scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} my-orders-card-cluster checks FAILED`);
	process.exit(1);
}
