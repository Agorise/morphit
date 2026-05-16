/**
 * Morphit relay — Web Push subscribe/unsubscribe endpoints.
 *
 *   POST /v1/push/subscribe   — register a browser subscription
 *   POST /v1/push/unsubscribe — remove a subscription
 *
 * Authentication model for cp13:
 *   No cryptographic proof of account ownership.  The endpoint
 *   accepts an account name + a browser-issued subscription
 *   blob and stores them.  Rationale:
 *     (a) The subscription endpoint URL is issued by the push
 *         service (FCM/autopush/APNS) and only that browser/
 *         device can RECEIVE pushes on it — an attacker can't
 *         forward push to an arbitrary URL.
 *     (b) Push payloads summarize PUBLIC chain events (order
 *         posted, order filled, feedback received).  An attacker
 *         "subscribing as alice" learns nothing they can't learn
 *         by watching the chain.
 *     (c) Chat message content is NEVER in the push payload —
 *         we send "you have a new chat message" without quoting
 *         the message (chat is E2EE on chain).
 *     (d) Per-IP rate limit bounds enumeration / DB-flood abuse.
 *   A cp14 follow-on can add posting-key signature verification
 *   for stronger account-binding; the trade-off is documented in
 *   `docs/NOTIFICATIONS-DESIGN.md` Phase 3 update.
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
import { verifyPushSubscribeSignature } from '../policy/pushSubscribeSig.ts';
import { clientIp, canonicalBucketKey } from '../middleware/ip.ts';
import { logger } from '$log';

const log = logger('relay-push-api');

// ─── Schemas ──────────────────────────────────────────────────────

/** Loose Blurt account name regex.  Mirrors the one in
 *  queue/drainer.ts — same dotted-segment rules. */
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

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
		endpoint: z.string().url().max(MAX_ENDPOINT_LEN)
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
		private readonly store: PushSubscriptionStore,
		/** Used to fetch the subscribing account's posting public
		 *  key for signature verification (cp14). */
		private readonly blurt: BlurtClient,
		/** When true, every /v1/push/subscribe MUST carry a valid
		 *  posting-key signature over the canonical message.
		 *  When false (cp13-compat mode), rate-limited-only;
		 *  signatures still verified when present but their
		 *  absence isn't rejected.  Operators turn this off only
		 *  to support legacy clients during a roll-forward. */
		private readonly requireSignedSubscribe: boolean
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

		// No rate limit on unsubscribe — users should always be
		// able to remove a subscription.

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

		try {
			await this.store.delete(input.account, input.endpoint);
			return c.json({ status: 'unsubscribed' });
		} catch (err) {
			log.error('unsubscribe_failed', { account: input.account }, err as Error);
			return c.json({ status: 'internal' }, 500);
		}
	}
}
