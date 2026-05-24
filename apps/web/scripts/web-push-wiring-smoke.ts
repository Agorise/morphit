#!/usr/bin/env tsx
/**
 * web-push-wiring-smoke — verify every Web Push component is in
 * place and references its siblings as expected.
 *
 * Part 122 cp13.  This is a static-grep smoke: it doesn't spin
 * up a real push service, but it pins the wiring discipline —
 * every component referenced by another component must exist
 * with the expected anchor.
 *
 * The discipline catches the regression that triggered Ken's
 * WTF in cp11: a FAQ claim ("push notifications work") with no
 * corresponding code.  This smoke is the per-checkpoint trip wire
 * specifically for the Web Push subsystem.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
		fileContains('apps/indexer/src/db/schema.sql', '-- v33 / Part 122 cp13')
});
results.push({
	name: 'Schema v33 — push_pending queue table',
	ok: fileContains('apps/indexer/src/db/schema.sql', 'CREATE TABLE IF NOT EXISTS push_pending')
});
results.push({
	name: 'Schema head version is bumped past v33 (where push_pending landed)',
	ok: (() => {
		// cp13 added push_pending at schema v33; the sentinel
		// pinned the pin literally as 'SCHEMA_HEAD_VERSION = 33'.
		// cp131 generalized: schema head can grow past 33 freely,
		// the cp13 invariant is "push_pending must be at or below
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

// ─── 9. Locale parity — all 10 locales have the push UI keys ─
const LOCALES = ['en', 'es', 'fr', 'de', 'it', 'pl', 'ru', 'fa', 'zh-CN', 'zh-HK'];
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
	name: 'all 10 locales define push UI strings',
	ok: missing.length === 0,
	detail: missing.length === 0 ? undefined : `Missing: [${missing.join(', ')}]`
});

// ─── 10. Indexer enqueues push_pending for feedback + chat ──
results.push({
	name: 'Indexer feedback handler enqueues push_pending',
	ok: fileContains(
		'apps/indexer/src/indexer/handlers/feedback.ts',
		'INSERT INTO push_pending'
	)
});
results.push({
	name: 'Indexer chat handler enqueues push_pending',
	ok: fileContains(
		'apps/indexer/src/indexer/handlers/chat.ts',
		'INSERT INTO push_pending'
	)
});
results.push({
	name: 'Chat enqueue routes order-permlink messages under category=order',
	ok:
		fileContains(
			'apps/indexer/src/indexer/handlers/chat.ts',
			'isOrderSignal'
		) &&
		fileContains(
			'apps/indexer/src/indexer/handlers/chat.ts',
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

// ─── 13. Part 122 cp14 — posting-key signature verification ────
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
		// cp131 refactored the literal `morphit:push:subscribe:`
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
	name: 'cp14 — chat handler uses pushLocalize',
	ok: fileContains(
		'apps/indexer/src/indexer/handlers/chat.ts',
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

// ─── cp131 MED-009 — unsubscribe signature + rate limit ──
// Pre-cp131 the unsubscribe endpoint had no sig check and no
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
