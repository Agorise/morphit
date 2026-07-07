/**
 * Morphit client — Web Push subscribe / unsubscribe.
 *
 * Talks to the operator's relay over the same `/v1/...` API that
 * the rest of the app uses.  Three responsibilities:
 *
 *   1. `subscribe(account, privacyMode)` — request browser
 *      permission (if not yet granted), call pushManager.subscribe
 *      with the operator's VAPID public key, and register the
 *      resulting subscription with the relay.
 *
 *   2. `unsubscribe(account)` — unregister the current browser
 *      subscription with both the push service and the relay.
 *
 *   3. `currentSubscription()` — read-only inspection of the
 *      browser's existing subscription (if any) for the
 *      "manage my devices" UI.
 *
 * Failure modes:
 *   - `push_disabled` — operator hasn't set VAPID env vars.
 *     Client falls back to in-tab channels.
 *   - `permission_denied` — user clicked "Block" in the browser
 *     permission prompt.  We don't re-ask.
 *   - `not_supported` — old browser without Notification or
 *     PushManager APIs.  Surface a friendly error.
 *   - `unreachable` — relay not responding.  Retry on the next
 *     user-driven subscribe attempt.
 *
 * Privacy: this module never logs the subscription endpoint or
 * any payload content.  It does pass the user-agent string to the
 * relay (so the UI's device list can show "Firefox on Linux"); the
 * relay truncates that to 200 chars at the storage layer.
 */

import { get } from 'svelte/store';
import { MORPHIT_RELAY_ORIGIN, resolveOrigin } from '$net/config';
import { fetchWithTimeout } from '$net/fetchWithTimeout';
import { liveIdentity } from '$lib/stores/identity';
// cp165 byte budget: dblurt's PrivateKey + cryptoUtils are only
// used inside `signSubscribe`/`signUnsubscribe`, which only fire
// when the user toggles a notification preference.  Importing
// dblurt statically here pulled the 2 MB chunk into
// settings/+page.svelte's first-paint graph via NotificationSettings
// → push.ts.  Switching to dynamic import: the chunk loads only on
// the first signed subscribe/unsubscribe action.
//
// import { PrivateKey, cryptoUtils } from '@beblurt/dblurt';

export type PushPrivacyMode = 'standard' | 'self_hosted';

export type SubscribeError =
	| 'push_disabled'
	| 'permission_denied'
	| 'not_supported'
	| 'unreachable'
	| 'no_vapid_key'
	| 'subscribe_failed'
	| 'push_service_unavailable'
	| 'signature_required'
	| 'signature_invalid'
	| 'locked_session'
	| 'internal';

export interface SubscribeSuccess {
	readonly status: 'subscribed';
	readonly privacyMode: PushPrivacyMode;
	readonly createdAt: string;
}

export interface UnsubscribeSuccess {
	readonly status: 'unsubscribed';
}

/** Returns true iff the running browser has both the Notification
 *  API and a service worker registration with PushManager.  Many
 *  environments (older browsers, in-app webviews) lack one or
 *  the other; we surface that as `not_supported`. */
export function isPushSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		'Notification' in window &&
		'serviceWorker' in navigator &&
		'PushManager' in window
	);
}

/** Read-only inspection of the browser's current subscription.
 *  Returns null when no subscription exists, when the SW isn't
 *  registered yet, or when push is unsupported. */
export async function currentSubscription(): Promise<PushSubscription | null> {
	if (!isPushSupported()) return null;
	try {
		const reg = await navigator.serviceWorker.ready;
		return await reg.pushManager.getSubscription();
	} catch {
		return null;
	}
}

/** Fetch the operator's VAPID public key.  Cached for the page
 *  lifetime — operators don't rotate keys at runtime.  Throws
 *  `push_disabled` if the relay returns 503. */
let cachedVapidKey: string | null = null;
async function getVapidPublicKey(): Promise<string> {
	if (cachedVapidKey !== null) return cachedVapidKey;
	const url = `${resolveOrigin(MORPHIT_RELAY_ORIGIN)}/v1/push/vapid-public-key`;
	let res: Response;
	try {
		res = await fetchWithTimeout(url, { method: 'GET' });
	} catch {
		throw 'unreachable' satisfies SubscribeError;
	}
	if (res.status === 503) throw 'push_disabled' satisfies SubscribeError;
	if (!res.ok) throw 'no_vapid_key' satisfies SubscribeError;
	const body = (await res.json().catch(() => ({}))) as {
		vapid_public_key?: string;
	};
	if (!body.vapid_public_key) throw 'no_vapid_key' satisfies SubscribeError;
	cachedVapidKey = body.vapid_public_key;
	return cachedVapidKey;
}

/** True when an existing push subscription was created with the same
 *  VAPID applicationServerKey as `key`. Lets subscribe() reuse the
 *  browser's existing subscription instead of tripping the
 *  InvalidStateError that pushManager.subscribe() throws when the key
 *  differs. `options.applicationServerKey` is an ArrayBuffer (or null on
 *  browsers that don't expose it — treated as "unknown / can't match"). */
function sameApplicationServerKey(sub: PushSubscription, key: Uint8Array): boolean {
	const existing = sub.options?.applicationServerKey;
	if (!existing) return false;
	const a = new Uint8Array(existing);
	if (a.length !== key.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== key[i]) return false;
	return true;
}

/** Convert a base64url VAPID public key into the Uint8Array that
 *  pushManager.subscribe expects as `applicationServerKey`. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(base64);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
	return out;
}

/** Hex-encode a Uint8Array.  Pure, no deps. */
function bytesToHex(bytes: Uint8Array): string {
	const hex: string[] = [];
	for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
	return hex.join('');
}

/** SHA-256 → 32-byte hash.  Uses Web Crypto, available in every
 *  modern browser and the only digest used by this module. */
async function sha256(input: string): Promise<Uint8Array> {
	const enc = new TextEncoder().encode(input);
	const buf = await crypto.subtle.digest('SHA-256', enc);
	return new Uint8Array(buf);
}

/** Sign the canonical "morphit:push:<action>:..." string with
 *  the user's posting key.  Throws SubscribeError when the
 *  session is locked or signing fails.  cp14 (subscribe) +
 *  cp131 MED-009 (unsubscribe).
 *
 *  The signature is what the relay's user-posting-key signature
 *  verifier expects: a BLURT-prefix base58 string produced by
 *  dblurt's Signature.toString().  The relay holds an active
 *  key (not a posting key) — this signature is the USER's
 *  posting-key signature on their own subscribe request, which
 *  the relay verifies against the on-chain posting authority.
 *
 *  ACTION is part of the canonical message so a captured
 *  subscribe signature cannot be replayed as an unsubscribe
 *  (or vice-versa).
 */
async function signPushAction(
	action: 'subscribe' | 'unsubscribe',
	account: string,
	endpoint: string,
	timestamp: number
): Promise<string> {
	const live = get(liveIdentity);
	if (!live) {
		throw 'locked_session' satisfies SubscribeError;
	}
	// Canonical message must match the server-side reconstruction
	// in apps/relay/src/policy/pushSubscribeSig.ts verbatim.
	const endpointHashBytes = await sha256(endpoint);
	const canonical = `morphit:push:${action}:${account}:${bytesToHex(endpointHashBytes)}:${timestamp}`;
	const messageHashBytes = await sha256(canonical);

	// dblurt's PrivateKey/Sign API takes Buffer in TS types but
	// accepts any Uint8Array at runtime.  Mirrors the pattern at
	// apps/web/src/lib/blurt/sign.ts.
	// cp165: dynamic-imported to keep dblurt out of the first-paint
	// settings-page chunk graph (the only consumer of this module).
	const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');
	const messageBuf = messageHashBytes as unknown as Buffer;
	const privKey = new PrivateKey(live.posting.privateKey as unknown as Buffer);
	const sig = privKey.sign(messageBuf);
	if (!cryptoUtils.isCanonicalSignature(sig.data)) {
		// dblurt usually retries-until-canonical, but be defensive.
		throw 'subscribe_failed' satisfies SubscribeError;
	}
	return sig.toString();
}

/** cp14 — sign a subscribe request. */
async function signSubscribe(
	account: string,
	endpoint: string,
	timestamp: number
): Promise<string> {
	return signPushAction('subscribe', account, endpoint, timestamp);
}

/** cp131 MED-009 — sign an unsubscribe request.  Same shape
 *  as signSubscribe but binds the signature to the
 *  unsubscribe action so it can't be replayed against
 *  subscribe (or vice-versa). */
async function signUnsubscribe(
	account: string,
	endpoint: string,
	timestamp: number
): Promise<string> {
	return signPushAction('unsubscribe', account, endpoint, timestamp);
}

/** Subscribe the current browser to push notifications for
 *  `account`.  This is the one-shot user-triggered flow:
 *    1. Verify support and unlocked session
 *    2. Request permission (at the point of relevance)
 *    3. Get VAPID key from relay
 *    4. Call pushManager.subscribe with applicationServerKey
 *    5. Sign the canonical message with the posting key
 *    6. POST the subscription + signature to /v1/push/subscribe
 *
 *  Idempotent — re-subscribing yields the same browser subscription
 *  object (the push service is asked once) and the relay's upsert
 *  refreshes the row. */
export async function subscribe(
	account: string,
	privacyMode: PushPrivacyMode = 'standard'
): Promise<SubscribeSuccess> {
	if (!isPushSupported()) throw 'not_supported' satisfies SubscribeError;

	// Permission flow.  We ask at the point of relevance — caller
	// only invokes this in response to an explicit user gesture
	// ("Enable push notifications" button click), so the prompt
	// arrives with context.
	let permission = Notification.permission;
	if (permission === 'default') {
		permission = await Notification.requestPermission();
	}
	if (permission !== 'granted') {
		throw 'permission_denied' satisfies SubscribeError;
	}

	const vapidKey = await getVapidPublicKey();

	let reg: ServiceWorkerRegistration;
	try {
		reg = await navigator.serviceWorker.ready;
	} catch (err) {
		console.warn(
			'[push] service worker not ready:',
			err instanceof Error ? `${err.name}: ${err.message}` : err
		);
		throw 'subscribe_failed' satisfies SubscribeError;
	}

	const appServerKey = urlBase64ToUint8Array(vapidKey);

	let sub: PushSubscription;
	try {
		// A browser allows only ONE push subscription per service-worker
		// registration. Calling pushManager.subscribe() while a
		// subscription already exists with a DIFFERENT applicationServerKey
		// throws InvalidStateError — which is exactly what makes "Enable
		// push" fail on every click after a half-finished prior attempt or
		// a VAPID-key rotation (the stale subscription never gets cleared,
		// so each retry hits the same error). So: reuse the existing
		// subscription when its key still matches, otherwise drop it and
		// create a fresh one.
		const existing = await reg.pushManager.getSubscription();
		if (existing && sameApplicationServerKey(existing, appServerKey)) {
			sub = existing;
		} else {
			if (existing) await existing.unsubscribe().catch(() => undefined);
			sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: appServerKey as BufferSource
			});
		}
	} catch (err) {
		// Surface the underlying reason — pushManager.subscribe() throws a
		// DOMException whose name/message is the only clue to WHY it failed
		// (e.g. "AbortError: Registration failed - push service error" when
		// the push service is unreachable/blocked or the applicationServerKey
		// is malformed; "InvalidStateError" for a stale subscription;
		// "NotAllowedError" for a permission problem). Without logging it the
		// failure collapses to an undiagnosable "subscribe_failed".
		console.warn(
			'[push] pushManager.subscribe failed:',
			err instanceof Error ? `${err.name}: ${err.message}` : err
		);
		// cp407 — the browser could not register with its push service. This
		// is a BROWSER/PLATFORM limitation, not a Morphit fault: common in
		// privacy-hardened / de-googled browsers where Google's FCM push
		// service is disabled or unreachable, or on networks that block it.
		// Give it a distinct code so the UI can reassure the user that the
		// in-tab notification channels still work (push is only for when the
		// tab is fully closed) instead of a generic "try again".
		if (
			err instanceof DOMException &&
			(err.name === 'AbortError' || /push service/i.test(err.message))
		) {
			throw 'push_service_unavailable' satisfies SubscribeError;
		}
		throw 'subscribe_failed' satisfies SubscribeError;
	}

	const subJson = sub.toJSON();
	if (!subJson.endpoint || !subJson.keys?.p256dh || !subJson.keys?.auth) {
		// pushManager.subscribe returned a malformed subscription —
		// shouldn't happen on a conformant browser.
		throw 'subscribe_failed' satisfies SubscribeError;
	}

	// Part 122 cp14 — sign the canonical message with the user's
	// posting key.  When the session is locked, signSubscribe
	// throws 'locked_session' and we bail before talking to the
	// relay (the UI surfaces a "please unlock" message).
	const timestamp = Math.floor(Date.now() / 1000);
	const signatureHex = await signSubscribe(account, subJson.endpoint, timestamp);

	// Locale: pick the user's preferred i18n tag if svelte-i18n is
	// running and exposes it; otherwise fall back to navigator's
	// preferred language; otherwise 'en'.  The relay validates
	// against its known-locale list and falls back to 'en' on its
	// side too.
	let locale = 'en';
	if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
		locale = navigator.language;
	}

	const url = `${resolveOrigin(MORPHIT_RELAY_ORIGIN)}/v1/push/subscribe`;
	let res: Response;
	try {
		res = await fetchWithTimeout(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				account,
				subscription: {
					endpoint: subJson.endpoint,
					keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth }
				},
				privacy_mode: privacyMode,
				user_agent:
					typeof navigator !== 'undefined' && navigator.userAgent
						? navigator.userAgent
						: undefined,
				signature: signatureHex,
				timestamp,
				locale
			})
		});
	} catch {
		throw 'unreachable' satisfies SubscribeError;
	}

	if (res.status === 503) throw 'push_disabled' satisfies SubscribeError;
	if (res.status === 401) {
		const body = (await res.json().catch(() => ({}))) as { status?: string };
		throw (body.status === 'signature_required'
			? ('signature_required' as SubscribeError)
			: ('signature_invalid' as SubscribeError));
	}
	if (res.status === 429) throw 'subscribe_failed' satisfies SubscribeError;

	const body = (await res.json().catch(() => ({}))) as {
		status?: string;
		created_at?: string;
		privacy_mode?: string;
	};

	if (!res.ok || body.status !== 'subscribed') {
		throw 'subscribe_failed' satisfies SubscribeError;
	}

	return {
		status: 'subscribed',
		privacyMode: (body.privacy_mode as PushPrivacyMode) ?? privacyMode,
		createdAt: body.created_at ?? new Date().toISOString()
	};
}

/** Unsubscribe the current browser from push for `account`.  Two
 *  steps: tell the push service (so it stops accepting pushes for
 *  this subscription) AND tell the relay (so it removes the DB
 *  row).  Either step failing is non-fatal — the other handles
 *  the cleanup eventually. */
export async function unsubscribe(account: string): Promise<UnsubscribeSuccess> {
	if (!isPushSupported()) throw 'not_supported' satisfies SubscribeError;

	const existing = await currentSubscription();
	const endpoint = existing?.endpoint;

	// 1. Browser-side unsubscribe.  If no existing subscription,
	//    skip — the relay-side cleanup still runs.
	if (existing) {
		try {
			await existing.unsubscribe();
		} catch {
			// Non-fatal — the push service may have already cleaned
			// up the subscription, or the SW is unregistered.
		}
	}

	// 2. Relay-side delete.  Only if we have an endpoint to tell
	//    the relay about; otherwise there's nothing to delete.
	if (endpoint) {
		const url = `${resolveOrigin(MORPHIT_RELAY_ORIGIN)}/v1/push/unsubscribe`;
		// cp131 MED-009 — sign the unsubscribe just like
		// subscribe.  When the session is locked we can't
		// sign; fall back to an unsigned request (the relay
		// will accept it in cp13-compat mode, reject it
		// otherwise — either way the browser-side
		// existing.unsubscribe() above already cut off
		// future deliveries).  ACTION-binding in the
		// canonical message prevents subscribe↔unsubscribe
		// signature replay.
		const timestamp = Math.floor(Date.now() / 1000);
		let signatureHex: string | undefined;
		try {
			signatureHex = await signUnsubscribe(account, endpoint, timestamp);
		} catch {
			// 'locked_session' or signing failure — proceed
			// unsigned.  The relay-side gate decides.
			signatureHex = undefined;
		}
		try {
			await fetchWithTimeout(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					signatureHex !== undefined
						? { account, endpoint, signature: signatureHex, timestamp }
						: { account, endpoint }
				)
			});
		} catch {
			// Non-fatal — the relay's auto-cleanup on 410 Gone
			// handles forgotten unsubscribes within a few delivery
			// attempts.
		}
	}

	return { status: 'unsubscribed' };
}
