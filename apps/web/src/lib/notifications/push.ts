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
import { liveIdentity } from '$lib/stores/identity';
import { PrivateKey, cryptoUtils } from '@beblurt/dblurt';

export type PushPrivacyMode = 'standard' | 'self_hosted';

export type SubscribeError =
	| 'push_disabled'
	| 'permission_denied'
	| 'not_supported'
	| 'unreachable'
	| 'no_vapid_key'
	| 'subscribe_failed'
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
		res = await fetch(url, { method: 'GET' });
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

/** Sign the canonical "morphit:push:subscribe:..." string with
 *  the user's posting key.  Throws SubscribeError when the
 *  session is locked or signing fails.  Part 122 cp14.
 *
 *  The signature is what the relay's posting-key signature
 *  verifier expects: a BLURT-prefix base58 string produced by
 *  dblurt's Signature.toString().
 */
async function signSubscribe(
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
	const canonical = `morphit:push:subscribe:${account}:${bytesToHex(endpointHashBytes)}:${timestamp}`;
	const messageHashBytes = await sha256(canonical);

	// dblurt's PrivateKey/Sign API takes Buffer in TS types but
	// accepts any Uint8Array at runtime.  Mirrors the pattern at
	// apps/web/src/lib/blurt/sign.ts.
	const messageBuf = messageHashBytes as unknown as Buffer;
	const privKey = new PrivateKey(live.posting.privateKey as unknown as Buffer);
	const sig = privKey.sign(messageBuf);
	if (!cryptoUtils.isCanonicalSignature(sig.data)) {
		// dblurt usually retries-until-canonical, but be defensive.
		throw 'subscribe_failed' satisfies SubscribeError;
	}
	return sig.toString();
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
	} catch {
		throw 'subscribe_failed' satisfies SubscribeError;
	}

	let sub: PushSubscription;
	try {
		sub = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(vapidKey)
		});
	} catch {
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
		res = await fetch(url, {
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
		try {
			await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ account, endpoint })
			});
		} catch {
			// Non-fatal — the relay's auto-cleanup on 410 Gone
			// handles forgotten unsubscribes within a few delivery
			// attempts.
		}
	}

	return { status: 'unsubscribed' };
}
