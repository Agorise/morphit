#!/usr/bin/env tsx
/**
 * web-push-wiring-smoke — verify every Web Push component is in
 * place and references its siblings as expected.
 *
 * This is a static-grep smoke: it doesn't spin
 * up a real push service, but it pins the wiring discipline —
 * every component referenced by another component must exist
 * with the expected anchor.
 *
 * The discipline catches the regression that triggered the maintainer's
 * WTF: a FAQ claim ("push notifications work") with no
 * corresponding code.  This smoke is the per-checkpoint trip wire
 * specifically for the Web Push subsystem.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const REPO = join(import.meta.dirname, '..', '..', '..');

interface Check {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}

const results: Check[] = [];

function fileExists(p: string): boolean {
	return existsSync(join(REPO, p));
}

function fileContains(p: string, pattern: RegExp | string): boolean {
	try {
		const text = readFileSync(join(REPO, p), 'utf-8');
		return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
	} catch {
		return false;
	}
}

// ─── 1. VAPID keygen script exists and is executable shell ──
results.push({
	name: 'VAPID keygen script committed',
	ok:
		fileExists('scripts/generate-vapid-keys.sh') &&
		fileContains('scripts/generate-vapid-keys.sh', 'generateVAPIDKeys') &&
		fileContains('scripts/generate-vapid-keys.sh', 'MORPHIT_RELAY_VAPID_PUBLIC_KEY')
});

// ─── 2. Schema migration v33 declares push tables ──────────
results.push({
	name: 'Schema v33 — push_subscriptions table',
	ok:
		fileContains('apps/indexer/src/db/schema.sql', 'CREATE TABLE IF NOT EXISTS push_subscriptions') &&
		fileContains('apps/indexer/src/db/schema.sql', '-- v33 — Web Push subscription storage')
});
results.push({
	name: 'Schema v33 — push_pending queue table',
	ok: fileContains('apps/indexer/src/db/schema.sql', 'CREATE TABLE IF NOT EXISTS push_pending')
});
results.push({
	name: 'Schema head version is bumped past v33 (where push_pending landed)',
	ok: (() => {
		// A later change added push_pending at schema v33; the sentinel
		// pinned the pin literally as 'SCHEMA_HEAD_VERSION = 33'.
		// A later change generalized: schema head can grow past 33 freely,
		// the invariant is "push_pending must be at or below
		// the head."  Parse the value and assert >= 33.
		try {
			const txt = readFileSync(
				join(REPO, 'apps/indexer/scripts/schema-migration-coverage-smoke.ts'),
				'utf-8'
			);
			const m = /SCHEMA_HEAD_VERSION\s*=\s*(\d+)/.exec(txt);
			if (!m) return false;
			const head = parseInt(m[1]!, 10);
			return Number.isFinite(head) && head >= 33;
		} catch {
			return false;
		}
	})()
});

// ─── 3. Relay config exposes VAPID env vars ─────────────────
const RELAY_CONFIG_VARS = [
	'MORPHIT_RELAY_VAPID_PUBLIC_KEY',
	'MORPHIT_RELAY_VAPID_PRIVATE_KEY',
	'MORPHIT_RELAY_VAPID_SUBJECT',
	'MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS',
	'MORPHIT_RELAY_PUSH_BATCH_SIZE',
	'MORPHIT_RELAY_PUSH_MAX_AGE_SECONDS',
	'MORPHIT_RELAY_PUSH_MAX_CONSECUTIVE_FAILURES'
];
for (const v of RELAY_CONFIG_VARS) {
	results.push({
		name: `Relay config — ${v}`,
		ok: fileContains('apps/relay/src/config/index.ts', v)
	});
}
results.push({
	name: 'Config interface declares pushEnabled boolean',
	ok: fileContains('apps/relay/src/config/index.ts', 'readonly pushEnabled: boolean')
});

// ─── 4. Backend services exist with the expected exports ────
results.push({
	name: 'PushSubscriptionStore service committed',
	ok:
		fileExists('apps/relay/src/policy/pushSubscriptions.ts') &&
		fileContains('apps/relay/src/policy/pushSubscriptions.ts', 'export class PushSubscriptionStore')
});
results.push({
	name: 'PushSender service committed',
	ok:
		fileExists('apps/relay/src/policy/pushSender.ts') &&
		fileContains('apps/relay/src/policy/pushSender.ts', 'export class PushSender') &&
		fileContains('apps/relay/src/policy/pushSender.ts', "import webpush from 'web-push'")
});

// ─── 5. HTTP endpoints exist + are mounted ─────────────────
results.push({
	name: 'PushEndpoints API class committed',
	ok:
		fileExists('apps/relay/src/api/push.ts') &&
		fileContains('apps/relay/src/api/push.ts', "app.post('/v1/push/subscribe'") &&
		fileContains('apps/relay/src/api/push.ts', "app.post('/v1/push/unsubscribe'") &&
		fileContains('apps/relay/src/api/push.ts', "app.get('/v1/push/vapid-public-key'")
});
results.push({
	name: 'main.ts wires PushSender + PushEndpoints',
	ok:
		fileContains('apps/relay/src/main.ts', 'new PushSender') &&
		fileContains('apps/relay/src/main.ts', 'new PushEndpoints') &&
		fileContains('apps/relay/src/main.ts', 'pushEndpoints.register(app)') &&
		fileContains('apps/relay/src/main.ts', 'pushSender.start()')
});

// ─── 6. Service worker handles push + notificationclick ─────
results.push({
	name: 'Service worker push handler',
	ok: fileContains('apps/web/src/service-worker.ts', "addEventListener('push'")
});
results.push({
	name: 'Service worker notificationclick handler',
	ok: fileContains('apps/web/src/service-worker.ts', "addEventListener('notificationclick'")
});

// ─── 7. Client subscribe module ────────────────────────────
results.push({
	name: 'Client push module exports subscribe/unsubscribe',
	ok:
		fileExists('apps/web/src/lib/notifications/push.ts') &&
		fileContains('apps/web/src/lib/notifications/push.ts', 'export async function subscribe') &&
		fileContains('apps/web/src/lib/notifications/push.ts', 'export async function unsubscribe') &&
		fileContains('apps/web/src/lib/notifications/push.ts', 'pushManager.subscribe')
});

// ─── 8. NotificationSettings UI wired ──────────────────────
results.push({
	name: 'NotificationSettings UI uses real subscribe (no Coming soon)',
	ok:
		fileContains('apps/web/src/lib/components/NotificationSettings.svelte', 'handlePushSubscribe') &&
		fileContains('apps/web/src/lib/components/NotificationSettings.svelte', 'subscribeToPush') &&
		// "Coming soon" badge should no longer render — but the
		// translation key may still exist in locale files for
		// historical reasons.  Pin on the *active component*.
		!fileContains(
			'apps/web/src/lib/components/NotificationSettings.svelte',
			'settings.notifications.coming_soon'
		)
});

// ─── 9. Locale parity — every supported locale has the push UI keys ─
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
const REQUIRED_KEYS = [
	'push_subscribe',
	'push_subscribing',
	'push_unsubscribe',
	'push_subscribed',
	'push_unsupported',
	'push_error_push_disabled',
	'push_error_permission_denied',
	'push_error_not_supported',
	'push_error_unreachable',
	'push_error_subscribe_failed'
];
const missing: string[] = [];
for (const loc of LOCALES) {
	const p = join(REPO, `apps/web/src/lib/i18n/locales/${loc}.json`);
	if (!existsSync(p)) {
		missing.push(`${loc} (file missing)`);
		continue;
	}
	const data = JSON.parse(readFileSync(p, 'utf-8'));
	const notif = data?.settings?.notifications ?? {};
	for (const k of REQUIRED_KEYS) {
		if (!notif[k]) missing.push(`${loc}: settings.notifications.${k}`);
	}
}
results.push({
	name: `all ${LOCALES.length} locales define push UI strings`,
	ok: missing.length === 0,
	detail: missing.length === 0 ? undefined : `Missing: [${missing.join(', ')}]`
});

// ─── 9b. Every error the settings page can show has words, everywhere ──
// Settings and the chat nudge both render `settings.notifications.push_error_
// <error>` for whatever SubscribeError they hold — the nudge for EVERY code,
// including push_service_unavailable, which Settings swaps for per-browser help.
// A hand-kept list goes stale the day a new error is added (v1.18.0 added
// `push_disabled_hidden_only`), and a missing key renders as the raw key path.
// So the list is read from the union itself, with no exceptions.
{
	const pushSrc = readFileSync(join(REPO, 'apps/web/src/lib/notifications/push.ts'), 'utf-8');
	const union = /export type SubscribeError =((?:\s*\|\s*'[a-z_]+')+);/.exec(pushSrc);
	const errors = union ? [...union[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!) : [];
	const shown = errors;
	const gaps: string[] = [];
	for (const loc of LOCALES) {
		const p = join(REPO, `apps/web/src/lib/i18n/locales/${loc}.json`);
		const notif = existsSync(p)
			? (JSON.parse(readFileSync(p, 'utf-8'))?.settings?.notifications ?? {})
			: {};
		for (const e of shown) if (!notif[`push_error_${e}`]) gaps.push(`${loc}: push_error_${e}`);
	}
	results.push({
		name: `every SubscribeError has a message in all ${LOCALES.length} locales (${shown.length} errors)`,
		// Fewer than ten would mean the union was not found — a check over
		// nothing, which must not read as a pass.
		ok: shown.length >= 10 && gaps.length === 0,
		detail:
			shown.length < 10
				? `read only ${shown.length} errors from the SubscribeError union — the pattern no longer matches it`
				: gaps.length === 0
					? undefined
					: `Missing: [${gaps.join(', ')}]`
	});
}

// ─── 9c. Push off ON PURPOSE (v1.18.0) — the call sites ──
// The behaviour is tested where it lives: the relay's answers and the janitor
// in apps/relay/test/pushOffOnPurpose.test.ts, the janitor's SQL against a real
// Postgres in the indexer's integration suite, the browser's reading in
// pushOffReason.test.ts. What no unit test reaches is the wiring in the two
// entry points, so the call sites are pinned here.
{
	const relayMain = join(REPO, 'apps/relay/src/main.ts');
	const src = readFileSync(relayMain, 'utf-8').replace(/^\s*\/\/.*$/gm, '');
	results.push({
		name: 'relay: with no sender, the push-queue janitor is built and started',
		ok:
			/pushSender\s*\?\s*null\s*:\s*new PushQueueJanitor\(/.test(src) &&
			/else pushJanitor\?\.start\(\);/.test(src)
	});
	results.push({
		name: 'relay: a hidden-only relay tells the browser why push is off',
		ok: /cfg\.hiddenOnly \? 'hidden_only' : null\s*\)/.test(src)
	});
	const settings = readFileSync(
		join(REPO, 'apps/web/src/lib/components/NotificationSettings.svelte'),
		'utf-8'
	).replace(/^\s*\/\/.*$/gm, '');
	results.push({
		name: 'settings: a held subscription is checked against the instance, and cleared when push cannot arrive',
		ok:
			/existing === null \? null : await pushDeliveryUnavailable\(\)/.test(settings) &&
			/if \(unavailable !== null\) \{\s*pushSubscribed = false;\s*pushError = unavailable;/.test(settings)
	});
	// v1.18.0 review (W4): on a hidden-only instance the held subscription is
	// REMOVED, from the browser and the relay — asserted at the call site, inside
	// the hidden-only branch. (That the relay's unsubscribe answers with push off
	// — it used to 503, so the stored link could never be removed — is a
	// behaviour, and is tested where it lives: pushOffOnPurpose.test.ts.)
	results.push({
		name: 'settings: a subscription a hidden-only instance can never serve is removed, not just hidden',
		ok: /unavailable === 'push_disabled_hidden_only' && account\) \{\s*void unsubscribeFromPush\(account\)/.test(
			settings
		)
	});
}

// ─── 10. Indexer enqueues push_pending for feedback + chat ──
// v1.5.5 (t155): the feedback enqueue MOVED out of the handler into the shared
// `feedbackPushEnqueue` module, so the durable path and the new fast-notify path
// use ONE implementation. That matters: the durable feedback push carried no
// dedup key (no source_trx_id), which was harmless only while it was the sole
// path — the moment a second path existed it would have duplicated, exactly the
// bug the maintainer hit on chat. So assert BOTH: the shared module does the insert, and
// the handler still routes through it (a handler that quietly stopped enqueuing
// would leave reviews silently un-notified).
results.push({
	name: 'Indexer feedback push enqueue lives in the shared module',
	ok: fileContains('apps/indexer/src/indexer/feedbackPushEnqueue.ts', 'INSERT INTO push_pending')
});
// THE INSERT IS NOT THE POINT — the dedup clause is, and the check above passes
// just as happily with it deleted. That is not a hypothetical weakness: the
// comment block above describes the duplicate-notification bug in detail, and
// the assertion under it would not have caught the bug coming back. Both
// keyed enqueues are pinned on the clause AND the key, and both are now
// covered at runtime as well (test/integration/{fast,feedback}-notification-
// dedup.test.ts) — this stays as the cheap tripwire that fires in the battery
// without a database.
for (const [label, path] of [
	['feedback', 'apps/indexer/src/indexer/feedbackPushEnqueue.ts'],
	['chat', 'apps/indexer/src/indexer/chatPushEnqueue.ts']
] as const) {
	results.push({
		name: `${label} enqueue keeps its dedup key and ON CONFLICT clause`,
		ok:
			fileContains(path, 'source_trx_id') &&
			fileContains(path, 'ON CONFLICT (account, source_trx_id) WHERE source_trx_id IS NOT NULL')
	});
}
results.push({
	name: 'Indexer feedback handler delegates to the shared enqueue',
	ok: fileContains('apps/indexer/src/indexer/handlers/feedback.ts', 'enqueueFeedbackPush')
});
results.push({
	name: 'Indexer chat push enqueue INSERTs push_pending (shared module)',
	ok:
		fileContains('apps/indexer/src/indexer/chatPushEnqueue.ts', 'INSERT INTO push_pending') &&
		fileContains('apps/indexer/src/indexer/handlers/chat.ts', 'enqueueChatPush(client')
});
results.push({
	name: 'Chat enqueue routes order-permlink messages under category=order',
	ok:
		fileContains(
			'apps/indexer/src/indexer/chatPushEnqueue.ts',
			'isOrderSignal'
		) &&
		fileContains(
			'apps/indexer/src/indexer/chatPushEnqueue.ts',
			"isOrderSignal ? 'order' : 'chat'"
		)
});

// ─── 11. web-push library dep recorded ─────────────────────
results.push({
	name: 'web-push library declared in apps/relay/package.json',
	ok: fileContains('apps/relay/package.json', '"web-push":')
});

// ─── 12. Wiring-completeness smoke promotes push → live ────
results.push({
	name: 'wiring-completeness-smoke promotes notifications-push-web-push to live',
	ok: fileContains(
		'apps/web/scripts/wiring-completeness-smoke.ts',
		"id: 'notifications-push-web-push'"
	) &&
		// status MUST be 'live', not 'deferred'.  Pin by checking
		// that the deferred-reason text is gone — that string only
		// exists in the deferred state.
		!fileContains(
			'apps/web/scripts/wiring-completeness-smoke.ts',
			'Phase 3 Web Push deferred to post-launch'
		)
});

// ─── 13. posting-key signature verification ────
results.push({
	name: 'cp14 — signature verifier module committed',
	ok:
		fileExists('apps/relay/src/policy/pushSubscribeSig.ts') &&
		fileContains(
			'apps/relay/src/policy/pushSubscribeSig.ts',
			'verifyPushSubscribeSignature'
		)
});
results.push({
	name: 'cp14 — subscribe endpoint requires signature when configured',
	ok:
		fileContains('apps/relay/src/api/push.ts', 'requireSignedSubscribe') &&
		fileContains('apps/relay/src/api/push.ts', 'signature_required') &&
		fileContains('apps/relay/src/api/push.ts', 'verifyPushSubscribeSignature')
});
results.push({
	name: 'cp14 — config exposes MORPHIT_RELAY_PUSH_REQUIRE_SIGNED env var',
	ok: fileContains(
		'apps/relay/src/config/index.ts',
		'MORPHIT_RELAY_PUSH_REQUIRE_SIGNED'
	)
});
results.push({
	name: 'cp14 — BlurtClient.AccountInfo exposes posting_pubkey',
	ok: fileContains(
		'apps/relay/src/blurt/client.ts',
		'posting_pubkey: string | undefined'
	)
});
results.push({
	name: 'cp14 — client subscribe signs canonical message',
	ok:
		fileContains('apps/web/src/lib/notifications/push.ts', 'signSubscribe') &&
		// A later change refactored the literal `morphit:push:subscribe:`
		// into the action-templated `morphit:push:${action}:`
		// shared by subscribe + unsubscribe.  Both forms are
		// acceptable evidence the canonical string is built.
		(fileContains(
			'apps/web/src/lib/notifications/push.ts',
			'morphit:push:subscribe'
		) ||
			fileContains(
				'apps/web/src/lib/notifications/push.ts',
				'morphit:push:${action}'
			))
});
results.push({
	name: 'cp14 — push_subscriptions.locale column added in schema',
	ok: fileContains(
		'apps/indexer/src/db/schema.sql',
		'ADD COLUMN IF NOT EXISTS locale'
	)
});
results.push({
	name: 'cp14 — indexer push-localize module committed',
	ok:
		fileExists('apps/indexer/src/indexer/pushLocalize.ts') &&
		fileContains(
			'apps/indexer/src/indexer/pushLocalize.ts',
			'export function localize'
		) &&
		// All 10 locales declared in the table
		fileContains('apps/indexer/src/indexer/pushLocalize.ts', "'zh-HK'") &&
		fileContains('apps/indexer/src/indexer/pushLocalize.ts', "'fa'")
});
results.push({
	name: 'cp14 — feedback handler uses pushLocalize',
	ok: fileContains(
		'apps/indexer/src/indexer/handlers/feedback.ts',
		'pushLocalize'
	)
});
results.push({
	name: 'cp14 — chat push enqueue uses pushLocalize',
	ok: fileContains(
		'apps/indexer/src/indexer/chatPushEnqueue.ts',
		'pushLocalize'
	)
});
results.push({
	name: 'cp14 — locales add the 3 new sig/lock error keys',
	ok: (() => {
		const required = [
			'push_error_signature_required',
			'push_error_signature_invalid',
			'push_error_locked_session'
		];
		for (const loc of LOCALES) {
			const p = join(REPO, `apps/web/src/lib/i18n/locales/${loc}.json`);
			const data = JSON.parse(readFileSync(p, 'utf-8'));
			const notif = data?.settings?.notifications ?? {};
			for (const k of required) if (!notif[k]) return false;
		}
		return true;
	})()
});

// ─── unsubscribe signature + rate limit ──
// Previously, the unsubscribe endpoint had no sig check and no
// rate limit; this smoke pins the symmetric protections so
// the bug class can't return silently.
results.push({
	name: 'cp131 MED-009 — relay exports verifyPushUnsubscribeSignature',
	ok: fileContains(
		'apps/relay/src/policy/pushSubscribeSig.ts',
		'verifyPushUnsubscribeSignature'
	)
});
results.push({
	name: 'cp131 MED-009 — relay push handler imports verifyPushUnsubscribeSignature',
	ok: fileContains(
		'apps/relay/src/api/push.ts',
		'verifyPushUnsubscribeSignature'
	)
});
results.push({
	name: 'cp131 MED-009 — unsubscribe wire body accepts signature + timestamp fields',
	ok:
		fileContains('apps/relay/src/api/push.ts', 'const unsubscribeBody') &&
		(() => {
			// The schema definition must include both `signature`
			// and `timestamp` in the optional fields of
			// unsubscribeBody (not just subscribeBody).
			const txt = readFileSync(
				join(REPO, 'apps/relay/src/api/push.ts'),
				'utf-8'
			);
			const i = txt.indexOf('const unsubscribeBody');
			if (i < 0) return false;
			// Slice from start of unsubscribeBody to the next blank-line
			// separator so we only see the body of that schema.
			const slice = txt.slice(i, i + 1200);
			return slice.includes('signature') && slice.includes('timestamp');
		})()
});
results.push({
	name: 'cp131 MED-009 — relay constructs a per-IP unsubscribeLimiter',
	ok: fileContains('apps/relay/src/main.ts', 'pushUnsubscribeLimiter')
});
results.push({
	name: 'cp131 MED-009 — push handler calls unsubscribeLimiter.allow before the DB delete',
	ok: (() => {
		const txt = readFileSync(
			join(REPO, 'apps/relay/src/api/push.ts'),
			'utf-8'
		);
		const unsubIdx = txt.indexOf('private async unsubscribe');
		const allowIdx = txt.indexOf('unsubscribeLimiter.allow');
		const deleteIdx = txt.indexOf('this.store.delete');
		// All three present, and allow() lands BEFORE the delete
		// inside the unsubscribe handler body.
		return (
			unsubIdx > 0 &&
			allowIdx > unsubIdx &&
			deleteIdx > allowIdx
		);
	})()
});
results.push({
	name: 'cp131 MED-009 — push handler verifies signature before the DB delete (when present)',
	ok: (() => {
		const txt = readFileSync(
			join(REPO, 'apps/relay/src/api/push.ts'),
			'utf-8'
		);
		const unsubIdx = txt.indexOf('private async unsubscribe');
		// Search for the CALL (not the import) by looking
		// after the unsubscribe handler starts.
		const verifyIdx = unsubIdx > 0
			? txt.indexOf('verifyPushUnsubscribeSignature(', unsubIdx)
			: -1;
		const deleteIdx = unsubIdx > 0
			? txt.indexOf('this.store.delete', unsubIdx)
			: -1;
		return unsubIdx > 0 && verifyIdx > unsubIdx && deleteIdx > verifyIdx;
	})()
});
results.push({
	name: 'cp131 MED-009 — client signs unsubscribe POST with signUnsubscribe',
	ok: fileContains(
		'apps/web/src/lib/notifications/push.ts',
		'signUnsubscribe'
	)
});
results.push({
	name: 'cp131 MED-009 — canonical-message-cross-check covers unsubscribe + action-binding replay',
	ok: (() => {
		const p = 'apps/relay/scripts/canonical-message-cross-check-smoke.ts';
		return (
			fileContains(p, 'verifyPushUnsubscribeSignature') &&
			fileContains(
				p,
				'subscribe signature CANNOT be replayed as unsubscribe'
			) &&
			fileContains(
				p,
				'unsubscribe signature CANNOT be replayed as subscribe'
			)
		);
	})()
});

// ─── Report ───────────────────────────────────────────────
console.log(`web-push-wiring smoke: ${results.length} scenarios\n`);
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}`);
	} else {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}
console.log('');
if (failed === 0) {
	console.log(`✓ all ${results.length} Web Push wiring checks hold`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} wiring gaps in the Web Push subsystem`);
	process.exit(1);
}
