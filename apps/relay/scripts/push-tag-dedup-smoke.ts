#!/usr/bin/env tsx
/**
 * push-tag-dedup-smoke (cp450) — an order-signal chat message must produce
 * ONE notification, not two.
 *
 * The recipient of an order-signal message (one that cites an order permlink)
 * gets it via TWO paths when their tab is open-but-unfocused: the in-page
 * trade listener fires an OS notification, and the same message is also
 * enqueued as a category='order' Web Push that the service worker shows.
 * The browser only collapses them if their `tag` strings are byte-identical.
 *
 * Both sides build the tag as `morphit-<category>-<id>`. This smoke pins that
 * the ID halves are ALSO identical for an order signal:
 *   - in-page id  = the trade listener's notificationTag = `morphit-trade-<permlink>`
 *   - Web Push id = push_pending.notification_id (set by chat.ts) = `morphit-trade-<permlink>`
 *     → carried through the sender as the payload eventId
 * so the composed tags match and the notification appears once.
 *
 * Static-source guard (no live browser): if any of these string templates
 * drift, the double-fire silently returns — this trips first.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (p: string): string => {
	try {
		return readFileSync(join(REPO, p), 'utf-8');
	} catch {
		return '';
	}
};

const native = read('apps/web/src/lib/notifications/native.ts');
const sw = read('apps/web/src/service-worker.ts');
const dispatch = read('apps/web/src/lib/trades/listenerDispatch.ts');
const listener = read('apps/web/src/lib/trades/tradeEventListener.ts');
const chat = read('apps/indexer/src/indexer/handlers/chat.ts');
const sender = read('apps/relay/src/policy/pushSender.ts');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
};

// ── both paths build the tag the same way ───────────────────────────
check(
	'in-page native tag = `morphit-${event.category}-${event.id}`',
	/tag:\s*`morphit-\$\{event\.category\}-\$\{event\.id\}`/.test(native)
);
check(
	'service worker tag = `morphit-${category}-${payload.eventId}` (same shape)',
	/`morphit-\$\{category\}-\$\{payload\.eventId\}`/.test(sw)
);

// ── the ID halves match for an order signal ─────────────────────────
check(
	'the trade listener tags an order signal `morphit-trade-${orderPermlink}`',
	/notificationTag = `morphit-trade-\$\{orderPermlink\}`/.test(dispatch)
);
check(
	'the in-page order notify passes that notificationTag as its id, category=order',
	/category: 'order'/.test(listener) && /id: plan\.notify\.notificationTag/.test(listener)
);
check(
	'chat.ts sets push_pending.notification_id = `morphit-trade-${claimedPermlink}` for an order signal',
	/`morphit-trade-\$\{claimedPermlink\}`/.test(chat) &&
		/notification_id/.test(chat) &&
		/isOrderSignal && typeof claimedPermlink === 'string'/.test(chat)
);
check(
	'the sender emits notification_id as the payload eventId (falls back to the row id)',
	/eventId: row\.notification_id \?\? row\.id/.test(sender)
);

// ── composed parity: same permlink → same full tag ──────────────────
const permlink = 'buy-btc-eur-1234';
const inPageTag = `morphit-order-morphit-trade-${permlink}`; // native: morphit-<cat>-<notificationTag>
const swTag = `morphit-order-morphit-trade-${permlink}`; // sw: morphit-<cat>-<notification_id>
check(
	'for the same order permlink the in-page tag and the Web Push tag are identical',
	inPageTag === swTag
);

// ── plain chat keeps its own per-event tag (no bogus collapse) ──────
check(
	'plain (non-order) chat leaves notification_id null → sender uses the row id',
	/: null;/.test(chat) && /const pushNotificationId =/.test(chat)
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} push-tag-dedup scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} push-tag-dedup checks FAILED`);
	process.exit(1);
}
