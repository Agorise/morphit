/**
 * Morphit relay — Web Push subscribe/unsubscribe endpoints.
 *
 *   POST /v1/push/subscribe   — register a browser subscription
 *   POST /v1/push/unsubscribe — remove a subscription
 *
 * Authentication evolution:
 *
 *   cp13 (historical): no cryptographic proof of account
 *     ownership on either endpoint, only per-IP rate limit on
 *     subscribe.  Rationale leaned on (a) the push endpoint URL
 *     being unforwardable, (b) push payloads only summarizing
 *     PUBLIC chain events, (c) chat content never appearing in
 *     pushes (E2EE on chain).
 *
 *   cp14 (subscribe-side): posting-key signature added to
 *     subscribe.  Closes "an attacker subscribes my account to
 *     their own device" (which would have leaked nothing
 *     non-public, but is still tidier closed than open).
 *     Signed canonical message:
 *       morphit:push:subscribe:<account>:<endpoint_sha256>:<timestamp>
 *
 *   cp131 MED-009 (unsubscribe-side, this checkpoint):
 *     symmetric posting-key signature added to unsubscribe.
 *     Closes the real risk that motivates the work — an
 *     attacker with a DB-leaked (account, endpoint) list
 *     could mass-fire unsubscribes and DoS notifications
 *     federation-wide.  Also adds a per-IP rate limit on
 *     unsubscribe; pre-cp131 unsubscribe was unlimited on the
 *     reasoning that users should always be able to remove a
 *     subscription, but a generous cap doesn't impede legit
 *     users while shutting down enumeration.
 *
 *     Signed canonical message — distinct ACTION keyword
 *     prevents subscribe↔unsubscribe signature replay:
 *       morphit:push:unsubscribe:<account>:<endpoint_sha256>:<timestamp>
 *
 * Privacy: no IP logging on subscribe; user-agent capped at 200
 * chars at the storage layer; subscription endpoint never logged
 * in full (prefix only).
 *
 * When VAPID env vars aren't set, both endpoints return 503
 * push_disabled — the client falls back to in-tab channels.
 */

import type { Hono, Context } from 'hono';
import { z } from 'zod';

import type { Limiter } from '../middleware/ratelimit.ts';
import type { PushSubscriptionStore, PushPrivacyMode } from '../policy/pushSubscriptions.ts';
import type { BlurtClient } from '../blurt/client.ts';
import { verifyPushSubscribeSignature, verifyPushUnsubscribeSignature } from '../policy/pushSubscribeSig.ts';
import { clientIp, canonicalBucketKey } from '../middleware/ip.ts';
import { logger } from '$log';

const log = logger('relay-push-api');

// ─── Schemas ──────────────────────────────────────────────────────

/** Loose Blurt account name regex.  Mirrors the one in
 *  queue/drainer.ts — same dotted-segment rules. */
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** Caps on the freeform fields to bound row size + bound abuse.
 *  Endpoint URLs are typically <500 chars; we allow up to 2 KB
 *  to be conservative.  p256dh and auth are fixed-length encoded
 *  blobs (32 bytes ⇒ 44 base64url chars; 16 bytes ⇒ 24 chars). */
const MAX_ENDPOINT_LEN = 2048;
const MAX_KEY_LEN = 256;

const subscribeBody = z
	.object({
		account: z.string().regex(ACCOUNT_NAME_RE, 'invalid account name'),
		subscription: z
			.object({
				endpoint: z.string().url().max(MAX_ENDPOINT_LEN),
				keys: z
					.object({
						p256dh: z.string().min(20).max(MAX_KEY_LEN),
						auth: z.string().min(10).max(MAX_KEY_LEN)
					})
					.strict()
			})
			.strict(),
		privacy_mode: z.enum(['standard', 'self_hosted']),
		user_agent: z.string().max(400).optional(),
		// Part 122 cp14 — posting-key signature over the canonical
		// message `morphit:push:subscribe:<account>:<endpoint_sha256>:<timestamp>`.
		// Both fields are required when the relay was constructed
		// with requireSignedSubscribe=true; ignored otherwise
		// (kept on the wire for forward-compat).
		signature: z.string().min(40).max(200).optional(),
		timestamp: z.number().int().positive().optional(),
		// Part 122 cp14 — client locale ('en', 'es', 'fr', ...).
		// Stored on the subscription so the indexer can pick the
		// right localized strings at push-pending enqueue time.
		// Optional; defaults to 'en' when missing.
		locale: z.string().min(2).max(10).optional()
	})
	.strict();

const unsubscribeBody = z
	.object({
		account: z.string().regex(ACCOUNT_NAME_RE, 'invalid account name'),
		endpoint: z.string().url().max(MAX_ENDPOINT_LEN),
		// cp131 MED-009 — posting-key signature over the
		// canonical message
		// `morphit:push:unsubscribe:<account>:<endpoint_sha256>:<timestamp>`.
		// Both fields are required when the relay was
		// constructed with requireSignedUnsubscribe=true;
		// optional otherwise (signatures still verified when
		// present but their absence isn't rejected).
		signature: z.string().min(40).max(200).optional(),
		timestamp: z.number().int().positive().optional()
	})
	.strict();

// ─── Endpoint class ──────────────────────────────────────────────

export class PushEndpoints {
	constructor(
		/** Whether the VAPID env vars are set.  When false, both
		 *  endpoints respond 503 push_disabled. */
		private readonly pushEnabled: boolean,
		/** VAPID public key — returned in a GET helper so the
		 *  client knows what applicationServerKey to pass to
		 *  pushManager.subscribe(). */
		private readonly vapidPublicKey: string | undefined,
		/** Per-IP rate limiter for subscribe.  Generous since
		 *  legitimate clients only subscribe once per device per
		 *  session, but bounds DB-flood abuse. */
		private readonly subscribeLimiter: Limiter,
		/** cp131 MED-009 — per-IP rate limiter for unsubscribe.
		 *  Pre-cp131 unsubscribe was unlimited on the rationale
		 *  that "users should always be able to remove a
		 *  subscription," but that left a DoS vector: anyone
		 *  who knew or guessed (account, endpoint) pairs could
		 *  mass-fire deletes.  A generous per-IP cap (same
		 *  shape as subscribeLimiter) doesn't break legitimate
		 *  clients — one user unsubscribes one device at a
		 *  time — and shuts down enumeration-class abuse. */
		private readonly unsubscribeLimiter: Limiter,
		private readonly store: PushSubscriptionStore,
		/** Used to fetch the subscribing account's posting public
		 *  key for signature verification (cp14 / cp131). */
		private readonly blurt: BlurtClient,
		/** When true, every /v1/push/subscribe MUST carry a valid
		 *  posting-key signature over the canonical message.
		 *  When false (cp13-compat mode), rate-limited-only;
		 *  signatures still verified when present but their
		 *  absence isn't rejected.  Operators turn this off only
		 *  to support legacy clients during a roll-forward. */
		private readonly requireSignedSubscribe: boolean,
		/** cp131 MED-009 — same posture for unsubscribe.  Same
		 *  toggle semantics as requireSignedSubscribe: when
		 *  true, signature required; when false, signature is
		 *  verified IF present but its absence is not a
		 *  rejection.  Operators who set requireSignedSubscribe
		 *  should also set this; the pair is symmetric. */
		private readonly requireSignedUnsubscribe: boolean
	) {}

	register(app: Hono): void {
		app.get('/v1/push/vapid-public-key', (c) => this.getVapidKey(c));
		app.post('/v1/push/subscribe', (c) => this.subscribe(c));
		app.post('/v1/push/unsubscribe', (c) => this.unsubscribe(c));
	}

	/** Returns the operator's VAPID public key (or 503 if push
	 *  disabled).  The client passes this to
	 *  pushManager.subscribe()'s applicationServerKey.  Safe to
	 *  expose publicly — VAPID public keys are designed to be. */
	private getVapidKey(c: Context): Response {
		if (!this.pushEnabled || !this.vapidPublicKey) {
			return c.json({ status: 'push_disabled' }, 503);
		}
		return c.json({ vapid_public_key: this.vapidPublicKey });
	}

	private async subscribe(c: Context): Promise<Response> {
		if (!this.pushEnabled) {
			return c.json({ status: 'push_disabled' }, 503);
		}

		// Rate limit: per-IP, bounded.
		const ip = clientIp(c);
		const key = canonicalBucketKey(ip);
		if (!this.subscribeLimiter.allow(key)) {
			return c.json({ status: 'rate_limited' }, 429);
		}

		// Parse + validate.
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ status: 'malformed_request' }, 400);
		}
		const parsed = subscribeBody.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{
					status: 'bad_request',
					issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message }))
				},
				400
			);
		}
		const input = parsed.data;

		// Posting-key signature verification (cp14).  When the
		// operator runs in require-signed mode, both fields must
		// be present and valid.  When in legacy compat mode, we
		// still verify when present (so early-adopter clients
		// get the upgraded auth) but accept absent.
		const hasSigFields =
			typeof input.signature === 'string' && typeof input.timestamp === 'number';
		if (this.requireSignedSubscribe && !hasSigFields) {
			return c.json({ status: 'signature_required' }, 401);
		}
		if (hasSigFields) {
			const sigResult = await verifyPushSubscribeSignature(
				this.blurt,
				{
					account: input.account,
					endpoint: input.subscription.endpoint,
					timestamp: input.timestamp!,
					signatureHex: input.signature!
				},
				Math.floor(Date.now() / 1000)
			);
			if (!sigResult.ok) {
				log.warn('subscribe_sig_rejected', {
					account: input.account,
					reason: sigResult.reason
				});
				return c.json({ status: 'signature_invalid', reason: sigResult.reason }, 401);
			}
		}

		try {
			const row = await this.store.upsert({
				account: input.account,
				endpoint: input.subscription.endpoint,
				p256dh: input.subscription.keys.p256dh,
				auth: input.subscription.keys.auth,
				userAgent: input.user_agent ?? null,
				privacyMode: input.privacy_mode as PushPrivacyMode,
				locale: input.locale ?? 'en'
			});
			return c.json({
				status: 'subscribed',
				created_at: row.createdAt.toISOString(),
				privacy_mode: row.privacyMode
			});
		} catch (err) {
			log.error('subscribe_failed', { account: input.account }, err as Error);
			return c.json({ status: 'internal' }, 500);
		}
	}

	private async unsubscribe(c: Context): Promise<Response> {
		if (!this.pushEnabled) {
			return c.json({ status: 'push_disabled' }, 503);
		}

		// cp131 MED-009 — per-IP rate limit on unsubscribe.
		// Pre-cp131 this was deliberately UN-limited on the
		// "users should always be able to remove a
		// subscription" reasoning, but that argument breaks
		// down when the attacker isn't the legitimate user:
		// a DB-leaked (account, endpoint) list could be
		// mass-deleted with no friction.  Returning 429
		// when an attacker hammers the endpoint doesn't
		// stop a single legitimate user from clicking
		// "unsubscribe" on their own device — they're not
		// going to hit the cap.
		const ip = clientIp(c);
		const key = canonicalBucketKey(ip);
		if (!this.unsubscribeLimiter.allow(key)) {
			return c.json({ status: 'rate_limited' }, 429);
		}

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ status: 'malformed_request' }, 400);
		}
		const parsed = unsubscribeBody.safeParse(body);
		if (!parsed.success) {
			return c.json({ status: 'bad_request' }, 400);
		}
		const input = parsed.data;

		// cp131 MED-009 — posting-key signature gate.  Same
		// shape as subscribe's cp14 gate: when configured to
		// require signatures, reject unsigned requests with
		// 401.  When configured permissive (signatures
		// optional), still verify any provided signature so
		// a client that opts in to signing isn't worse off
		// than one that doesn't.
		const hasSigFields =
			typeof input.signature === 'string' && typeof input.timestamp === 'number';
		if (this.requireSignedUnsubscribe && !hasSigFields) {
			return c.json({ status: 'signature_required' }, 401);
		}
		if (hasSigFields) {
			const sigResult = await verifyPushUnsubscribeSignature(
				this.blurt,
				{
					account: input.account,
					endpoint: input.endpoint,
					timestamp: input.timestamp!,
					signatureHex: input.signature!
				},
				Math.floor(Date.now() / 1000)
			);
			if (!sigResult.ok) {
				log.warn('unsubscribe_sig_rejected', {
					account: input.account,
					reason: sigResult.reason
				});
				return c.json(
					{ status: 'signature_invalid', reason: sigResult.reason },
					401
				);
			}
		}

		try {
			await this.store.delete(input.account, input.endpoint);
			return c.json({ status: 'unsubscribed' });
		} catch (err) {
			log.error('unsubscribe_failed', { account: input.account }, err as Error);
			return c.json({ status: 'internal' }, 500);
		}
	}
}
