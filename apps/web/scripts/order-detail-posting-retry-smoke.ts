#!/usr/bin/env tsx
/**
 * Smoke: the order-detail page no longer flashes a scary "Order not found"
 * at a user who just posted (Ken #16). Anchor 2026-07-08.
 *
 * A freshly-posted order is likely still indexing, so the page shows a
 * reassuring "still posting" state and auto-retries before ever saying
 * not-found; a manual "Check again" is offered; and the not-found copy is
 * reworded to be reassuring. All strings exist in every locale.
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
check('retry window comfortably exceeds block+indexer lag (~24s)', /ORDER_RETRY_ATTEMPTS = 8/.test(page) && /ORDER_RETRY_INTERVAL_MS = 3000/.test(page));
check('only shows pending (not not_found) while retries remain', /phase = 'pending';[\s\S]{0,120}orderRetryTimer = setTimeout/.test(page));
check('retry timer is cleared on destroy (no dangling timer)', /onDestroy\(\(\) => \{[\s\S]{0,120}clearTimeout\(orderRetryTimer\)/.test(page));
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
// Ken specified this copy verbatim. The page a user hits seconds after paying a
// listing fee must say WAIT, not GONE — an earlier rewrite of mine fixed the
// tone ("We couldn't find this order") while keeping the "it's missing" meaning.
check(
	'EN not-found title is Ken\'s exact "Order is loading"',
	en.not_found_title === 'Order is loading'
);
check(
	'EN not-found body is Ken\'s exact wording',
	en.not_found_body ===
		'This order is being posted by the blockchain and may take a minute for it to appear.'
);
check('the copy never leads with "doesn\'t exist"', !en.not_found_body.startsWith('This order doesn'));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} order-detail-posting-retry scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} order-detail-posting-retry checks FAILED`);
	process.exit(1);
}
