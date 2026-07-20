/**
 * order-detail-expired-ui-smoke (cp438)
 *
 * The order-detail page (`[permlink]`) trusted the order's STORED status,
 * which the indexer keeps at 'live' until a sweep (expiry is enforced at query
 * time via expires_at ≤ now — see orderExpiry.ts). So an order the public
 * orderbook had already dropped still rendered on its own URL with a green
 * "Live" pill, a broken "Expires in Expiring now" pill, and a "Cancel this
 * order" button — none of which make sense once expired.
 *
 * This pins the fix: the page reads EFFECTIVE status (via the shared
 * orderExpiry helpers + a live nowMs ticker), so an expired order shows the
 * "Expired" pill, hides the expires-in countdown, and offers Re-list instead
 * of Cancel. The Re-list prefill is built by the SHARED builder that
 * /my/orders also uses — the two must not drift.
 *
 * Static source scan (the page pulls $-aliases the bare runner can't resolve).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const detail = readFileSync(
	join(webRoot, 'src/routes/[lang]/[x+40][account=account]/[permlink=permlink]/+page.svelte'),
	'utf8'
);
const myOrders = readFileSync(
	join(webRoot, 'src/routes/[lang]/my/orders/+page.svelte'),
	'utf8'
);
const relistMod = readFileSync(join(webRoot, 'src/lib/orders/relist.ts'), 'utf8');
const enLocale = JSON.parse(readFileSync(join(webRoot, 'src/lib/i18n/locales/en.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${label}`);
	} else {
		failed++;
		console.log(`  \u2717 ${label}`);
	}
}

console.log('\norder-detail-expired-ui smoke:\n');

// ─── the detail page reasons about EFFECTIVE status, not stored status ──────
check(
	'detail page imports the shared expiry helpers (isOrderExpired/isOrderLive)',
	/import\s*\{[^}]*isOrderExpired[^}]*isOrderLive[^}]*\}\s*from\s*'\$lib\/orders\/orderExpiry'/.test(
		detail
	)
);
check(
	'detail page has a live nowMs ticker (so status flips at the expiry moment)',
	/let nowMs = \$state\(Date\.now\(\)\)/.test(detail) &&
		/setInterval\(\s*\(\)\s*=>\s*\{\s*nowMs = Date\.now\(\)/.test(detail)
);
check(
	'the status pill reads effectiveStatus(order), not the raw stored status',
	/statusChipClasses\(effectiveStatus\(order\)\)/.test(detail) &&
		/statusLabel\(effectiveStatus\(order\)\)/.test(detail) &&
		/function effectiveStatus\(o: OrderRecord\)/.test(detail) &&
		/isOrderExpired\(o, nowMs\) \? 'expired' : o\.status/.test(detail)
);
check(
	'the "expires in" pill is gated on isOrderLive (hidden once expired — kills "Expires in Expiring now")',
	/\{#if isOrderLive\(order, nowMs\) && order\.expires_at\}/.test(detail)
);
check(
	'no raw `order.status === \'live\'` gates remain (all use the effective helpers)',
	!/order\.status === 'live'/.test(detail)
);

// ─── owner actions: Cancel while live, Re-list once expired OR cancelled ─────
check(
	'owner-actions card shows for live OR expired OR cancelled',
	/\{#if isOwner && \(isOrderLive\(order, nowMs\) \|\| isOrderExpired\(order, nowMs\) \|\| order\.status === 'cancelled'\)\}/.test(
		detail
	)
);
check(
	'expired-or-cancelled branch offers Re-list (action_relist), not Cancel',
	/\{#if isOrderExpired\(order, nowMs\) \|\| order\.status === 'cancelled'\}[\s\S]*?action_relist[\s\S]*?\{:else if withinEditWindow/.test(
		detail
	)
);
check(
	'Re-list uses the shared prefill builder + key (no inline duplication)',
	/import\s*\{[^}]*buildRelistPrefill[^}]*RELIST_PREFILL_KEY[^}]*\}\s*from\s*'\$lib\/orders\/relist'/.test(
		detail
	) && /safeSession\.set\(RELIST_PREFILL_KEY, JSON\.stringify\(buildRelistPrefill\(order\)\)\)/.test(detail)
);

// ─── /my/orders re-lists via the SAME shared builder (no drift) ─────────────
check(
	'/my/orders re-lists via the shared buildRelistPrefill (extracted, not inline)',
	/import\s*\{[^}]*buildRelistPrefill[^}]*\}\s*from\s*'\$lib\/orders\/relist'/.test(myOrders) &&
		/buildRelistPrefill\(o\)/.test(myOrders) &&
		// the old ~50-line inline price_model mapping is gone from /my/orders
		!/if \(obj\.kind === 'spread' && typeof obj\.percent === 'number'\)/.test(myOrders)
);

// ─── the shared module is well-formed ───────────────────────────────────────
check(
	'relist module exports buildRelistPrefill + RELIST_PREFILL_KEY',
	/export function buildRelistPrefill\(o: OrderRecord\): RelistPrefill/.test(relistMod) &&
		/export const RELIST_PREFILL_KEY = 'morphit\.post\.prefill'/.test(relistMod)
);
check(
	'relist prefill defaults a FRESH 30-day expiry + reason:relist (never re-signs the old order)',
	/expiresDays: 30/.test(relistMod) && /reason: 'relist'/.test(relistMod)
);

// ─── the reused i18n key exists in every locale ─────────────────────────────
check(
	'en carries my_orders.order.action_relist (reused for the detail-page Re-list)',
	typeof enLocale?.my_orders?.order?.action_relist === 'string' &&
		enLocale.my_orders.order.action_relist.length > 0
);

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} order-detail-expired-ui scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
