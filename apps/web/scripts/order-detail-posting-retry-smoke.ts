#!/usr/bin/env tsx
/**
 * Smoke: the order-detail page no longer flashes a scary "Order not found"
 * at a user who just posted. Anchor 2026-07-08.
 *
 * A freshly-posted order is likely still indexing, so the POSTER sees a
 * reassuring "still posting" state and auto-retries before ever seeing
 * not-found; a manual "Check again" is offered. Anyone else asking for an
 * order the indexer does not have gets the plain not-found answer at once —
 * telling a stranger "your order is being posted" about a mistyped or removed
 * link was wrong. All strings exist in every locale.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const page = readFileSync(
	join(WEB, 'src', 'routes', '[lang]', '[x+40][account=account]', '[permlink=permlink]', '+page.svelte'),
	'utf8'
);

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

check("Phase type includes 'pending'", /type Phase =[^;]*'pending'/.test(page));
check('loadOrder retries on not-found instead of giving up immediately', /attempt < ORDER_RETRY_ATTEMPTS/.test(page) && /loadOrder\(attempt \+ 1\)/.test(page));
// The window is deliberately modest and NOT sized against indexer lag — sizing
// it that way is what broke it. Nothing here should ever grow this to "cover"
// irreversibility: 90s of spinner is not a fix, and the owner never reaches this
// path any more.
check('a modest retry still smooths a genuine race', /ORDER_RETRY_ATTEMPTS = 8/.test(page) && /ORDER_RETRY_INTERVAL_MS = 3000/.test(page));
// What actually keeps a poster from not-found: their own browser staged the
// order at broadcast, and the staged copy is merged before the verdict.
check(
	"the owner can't reach not-found at all (the staged order answers first)",
	/mergePendingOrders\(indexed, get\(pendingOrders\)/.test(page)
);
check('the retry is no longer what stands between a poster and "not found"', /pendingOrders/.test(page));
check('only shows pending (not not_found) while retries remain', /phase = 'pending';[\s\S]{0,120}orderRetryTimer = setTimeout/.test(page));
check(
	'the "being posted" wait is only for the poster (a stranger gets not-found at once)',
	/if \(viewerAccount === a && attempt < ORDER_RETRY_ATTEMPTS\) \{\s*phase = 'pending';/.test(page)
);
// The load runs in an $effect keyed on account + permlink; its teardown (route
// change or destroy) clears the pending retry.
check(
	'retry timer is cleared on teardown (no dangling timer)',
	/return \(\) => \{[\s\S]{0,120}clearTimeout\(orderRetryTimer\)/.test(page)
);
check('manual retryLoadOrder exists', /function retryLoadOrder/.test(page));

// pending branch UI
check("pending branch shows the reassuring 'still posting' copy + a spinner", /phase === 'pending'[\s\S]{0,400}animate-spin[\s\S]{0,300}order_detail\.posting_title[\s\S]{0,200}order_detail\.posting_body/.test(page));
check('pending + not_found both offer Check again wired to retryLoadOrder', (page.match(/onclick=\{retryLoadOrder\}/g)?.length ?? 0) >= 2 && (page.match(/order_detail\.check_again/g)?.length ?? 0) >= 2);

// locales
// Derived from the single source of truth so adding an 11th locale can never
// silently skip this smoke (locale-source-of-truth-smoke enforces this).
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
let locOk = true;
for (const loc of LOCALES) {
	const od = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', `${loc}.json`), 'utf8'))?.order_detail;
	if (!od) locOk = false;
	for (const k of ['not_found_title', 'not_found_body', 'posting_title', 'posting_body', 'check_again']) {
		if (typeof od?.[k] !== 'string' || !od[k]) locOk = false;
	}
}
check('all 10 locales have not_found_* + posting_* + check_again', locOk);
const en = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', 'en.json'), 'utf8')).order_detail;
// The poster, seconds after paying a listing fee, sees the posting copy, which
// must say WAIT, not GONE. The not-found copy is what a stranger (or the poster
// after every retry) sees, so it must not claim the order is being posted.
check(
	'EN posting copy says the order is on its way and is checked automatically',
	/being (?:posted|confirmed)/i.test(en.posting_title + ' ' + en.posting_body) &&
		/automatically/i.test(en.posting_body)
);
check(
	'EN not-found copy does not tell a stranger the order is being posted',
	!/being (?:posted|confirmed)|loading/i.test(en.not_found_title + ' ' + en.not_found_body)
);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} order-detail-posting-retry scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} order-detail-posting-retry checks FAILED`);
	process.exit(1);
}
