#!/usr/bin/env tsx
/**
 * push-category-optin-smoke (cp450 GAP A) — Web Push must obey the
 * per-category Settings toggle, not just the in-page path.
 *
 * The bug: `push_subscriptions` had no per-category state, so the
 * push-sender fanned every chat / order / feedback push out to every
 * subscribed device regardless of the account's toggles — the
 * per-category switch worked tab-open but was ignored tab-closed.
 *
 * This is a static-wiring smoke (no live push service / DB). It pins
 * every link in the chain so the opt-in can't silently rot:
 *
 *   schema/migration → relay store → push-sender → relay endpoint →
 *   client subscribe → client re-sync → Settings UI → chat nudge.
 *
 * A blocklist design is asserted throughout: `muted_categories` names
 * the categories turned OFF; empty = all on = the pre-cp450 behaviour,
 * so existing subscriptions are unaffected until they re-sync.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

function read(p: string): string {
	try {
		return readFileSync(join(REPO, p), 'utf-8');
	} catch {
		return '';
	}
}

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

// ── 1. Schema + migration ───────────────────────────────────────────
const migrations = read('apps/indexer/src/db/migrations.ts');
const schema = read('apps/indexer/src/db/schema.sql');
const coverage = read('apps/indexer/scripts/schema-migration-coverage-smoke.ts');

check(
	'migrations.ts has a v40 migration adding muted_categories',
	/version:\s*40/.test(migrations) &&
		/ADD COLUMN IF NOT EXISTS muted_categories TEXT\[\]/.test(migrations)
);
check(
	'schema.sql declares muted_categories inline on push_subscriptions + a v40 section',
	/muted_categories\s+TEXT\[\]\s+NOT NULL DEFAULT '\{\}'/.test(schema) &&
		/─── v40:.*muted_categories/.test(schema)
);
check(
	'muted_categories defaults to empty (all-on) — backward-compatible for existing rows',
	/muted_categories TEXT\[\] NOT NULL DEFAULT '\{\}'/.test(schema)
);
check(
	'schema-migration coverage pins cover v40 (>= 40)',
	(() => {
		const head = coverage.match(/SCHEMA_HEAD_VERSION = (\d+)/);
		const high = coverage.match(/MIGRATIONS_COVERAGE_HIGH = (\d+)/);
		return (
			head !== null &&
			high !== null &&
			Number(head[1]) >= 40 &&
			Number(high[1]) >= 40
		);
	})()
);

// ── 2. Relay subscription store ─────────────────────────────────────
const store = read('apps/relay/src/policy/pushSubscriptions.ts');

check(
	'PushSubscription carries mutedCategories + RawRow maps muted_categories',
	/readonly mutedCategories: readonly string\[\]/.test(store) &&
		/muted_categories: string\[\]/.test(store) &&
		/mutedCategories: Array\.isArray\(r\.muted_categories\)/.test(store)
);
check(
	'the store validates the client list against a known-category set',
	/KNOWN_PUSH_CATEGORIES/.test(store) &&
		/new Set\(\['order', 'chat', 'feedback'\]\)/.test(store) &&
		/function sanitizeMutedCategories/.test(store)
);
check(
	'upsert persists muted_categories (INSERT column + ON CONFLICT UPDATE)',
	/\(account, endpoint, p256dh, auth, user_agent, privacy_mode, locale, muted_categories\)/.test(
		store
	) &&
		/muted_categories = EXCLUDED\.muted_categories/.test(store)
);
check(
	'listByAccount is category-aware and excludes devices that muted it',
	/async listByAccount\(\s*account: string,\s*category\?: string/.test(store) &&
		/NOT \(\$2 = ANY\(muted_categories\)\)/.test(store)
);

// ── 3. Push-sender applies the filter ───────────────────────────────
const sender = read('apps/relay/src/policy/pushSender.ts');
check(
	'the push-sender passes the pending category to listByAccount',
	/listByAccount\(row\.account, row\.category\)/.test(sender)
);

// ── 4. Relay subscribe endpoint accepts the list ────────────────────
const api = read('apps/relay/src/api/push.ts');
check(
	'the subscribe endpoint accepts + forwards muted_categories',
	/muted_categories: z\.array\(z\.enum\(\['order', 'chat', 'feedback'\]\)\)/.test(api) &&
		/mutedCategories: input\.muted_categories \?\? \[\]/.test(api)
);

// ── 5. Client subscribe sends the list ──────────────────────────────
const push = read('apps/web/src/lib/notifications/push.ts');
check(
	'client subscribe computes + sends muted_categories from prefs',
	/mutedCategoriesFromPrefs\(get\(notificationPrefs\)\)/.test(push) &&
		/muted_categories: mutedCategories/.test(push)
);
check(
	'client exposes resyncPushCategories, gated on an existing subscription',
	/export async function resyncPushCategories/.test(push) &&
		/if \(existing === null\) return;/.test(push)
);

// ── 6. Client prefs: helper + chat default flip ─────────────────────
const prefs = read('apps/web/src/lib/notifications/preferences.ts');
check(
	'preferences exports mutedCategoriesFromPrefs (categories turned OFF)',
	/export function mutedCategoriesFromPrefs/.test(prefs) &&
		/\.filter\(\(c\) => !p\.categories\[c\]\)/.test(prefs)
);
check(
	'chat notifications default ON (so fast-trade pings fire by default)',
	/categories: \{ order: true, chat: true, feedback: true \}/.test(prefs)
);

// ── 7. Settings UI re-syncs on toggle ───────────────────────────────
const settings = read('apps/web/src/lib/components/NotificationSettings.svelte');
check(
	'Settings routes every category toggle through a handler that re-syncs',
	/function handleCategoryToggle/.test(settings) &&
		/void resyncPushCategories\(account, mode\)/.test(settings) &&
		(settings.match(/handleCategoryToggle\('(order|chat|feedback)'/g) ?? []).length === 3 &&
		!/onchange=\{\(e\) => setCategory\(/.test(settings)
);

// ── 8. Chat nudge enables chat BEFORE it subscribes ─────────────────
const nudge = read('apps/web/src/lib/components/ChatNotificationNudge.svelte');
check(
	'the chat nudge sets chat=on BEFORE subscribing (so the muted list is right)',
	/setCategory\('chat', true\);[\s\S]{0,200}await subscribeToPush\(/.test(nudge) &&
		!/await subscribeToPush\([\s\S]{0,200}setCategory\('chat', true\)/.test(nudge)
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} push-category-optin scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} push-category-optin checks FAILED`);
	process.exit(1);
}
