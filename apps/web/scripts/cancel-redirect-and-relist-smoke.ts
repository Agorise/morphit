#!/usr/bin/env tsx
/**
 * Smoke: cancelling an order takes you somewhere that PROVES it worked, and a
 * cancelled order can be re-listed (Ken, 2026-07-08).
 *
 *  1. Confirming the cancel modal on /@user/permlink used to leave you on the
 *     same page, still looking at the red "Cancel this order" button — nothing
 *     visibly happened. It now navigates to /my/orders, where the order shows
 *     as Cancelled.
 *
 *  2. /my/orders offered "Re-list this order" only for EXPIRED orders. A
 *     cancelled order is just as re-listable — `buildRelistPrefill` already
 *     documented supporting both; only the UI gate was missing.
 *
 * Re-listing never mutates the original: it pre-fills a NEW /post draft with a
 * fresh permlink, expiry and listing fee. The cancelled order stays cancelled
 * on-chain.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');

const detail = readFileSync(
	join(WEB, 'src', 'routes', '[lang]', '[x+40][account=account]', '[permlink=permlink]', '+page.svelte'),
	'utf8'
);
const myOrders = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'my', 'orders', '+page.svelte'), 'utf8');
const relist = readFileSync(join(WEB, 'src', 'lib', 'orders', 'relist.ts'), 'utf8');

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

// ─── 1. cancel → /my/orders ──────────────────────────────────────────
check('confirmCancel navigates to /my/orders after a successful broadcast', /await gotoLocale\('\/my\/orders'\);/.test(detail));
check('it waits for the indexer before landing (no stale "live" flash)', /await new Promise\(\(r\) => setTimeout\(r, 1_500\)\);[\s\S]{0,2000}gotoLocale\('\/my\/orders'\)/.test(detail));
check('the confirm modal is closed before navigating', /\} finally \{[\s\S]{0,60}pendingCancel = false;[\s\S]{0,1400}await gotoLocale\('\/my\/orders'\)/.test(detail));
// A SvelteKit navigation can reject. If gotoLocale sat inside the try, that
// rejection would be caught and rendered as "the broadcast failed" — a lie
// about an order that IS cancelled on chain.
check('navigation is OUTSIDE the try (a rejected goto must not read as a failed cancel)', /\} finally \{[\s\S]{0,120}\}[\s\S]{0,1400}if \(cancelled\) \{[\s\S]{0,80}await gotoLocale\('\/my\/orders'\)/.test(detail));
check('navigation is gated on a proven-successful broadcast', /cancelled = true;/.test(detail) && /if \(cancelled\)/.test(detail));
check('it no longer re-fetches the order it is leaving (no orphan retry timer)', !/await broadcastOrderCancel\([\s\S]{0,600}await loadOrder\(\);/.test(detail));
check('a broadcast failure never navigates (cancelled stays false)', /let cancelled = false;[\s\S]{0,200}await broadcastOrderCancel/.test(detail));
check('a failed cancel still surfaces its error instead of navigating', /cancelError = \$_\('post_order\.broadcast_error\.body_generic'\)/.test(detail));

// ─── 2. re-list a cancelled order ────────────────────────────────────
const cancelledBranch = myOrders.slice(
	myOrders.indexOf("{:else if o.status === 'cancelled'}"),
	myOrders.indexOf('{:else if isExpired(o)}')
);
check('the cancelled branch exists and still shows the Cancelled pill', /action_cancelled/.test(cancelledBranch));
check('the cancelled branch now offers Re-list', /relistOrder\(o\)/.test(cancelledBranch) && /action_relist'/.test(cancelledBranch));
check('the cancelled branch shows the re-list hint', /action_relist_hint/.test(cancelledBranch));
check('expired orders keep their Re-list button', /\{:else if isExpired\(o\)\}[\s\S]{0,600}relistOrder\(o\)/.test(myOrders));
check('re-list is still offered on exactly the two terminal states', (myOrders.match(/relistOrder\(o\)/g) ?? []).length === 2);

// ─── 3. re-listing does not mutate the original ──────────────────────
check('relistOrder only writes a prefill + navigates to /post', /safeSession\.set\(RELIST_PREFILL_KEY[\s\S]{0,120}gotoLocale\('\/post'\)/.test(myOrders));
check('no broadcast/edit happens on re-list', !/relistOrder[\s\S]{0,300}broadcast/i.test(myOrders));
check('the helper documents expired AND cancelled support', /expired\/cancelled|expired, or one[\s\S]{0,40}cancelled/.test(relist));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} cancel-redirect-and-relist scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} cancel-redirect-and-relist checks FAILED`);
	process.exit(1);
}
