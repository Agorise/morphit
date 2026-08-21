/**
 * Morphit relay — signed invite tokens (two-step signup).
 *
 * Account creation happens in two calls:
 *   1. Client POSTs to /v1/account/invite. If the rate-limit
 *      and abuse checks pass, the relay returns a signed
 *      invite token bound to the client's IP and expiring in
 *      a few minutes.
 *   2. Client POSTs to /v1/account/create with the invite
 *      token in the body. The relay verifies the signature,
 *      non-expiry, and single-use, then processes the signup.
 *
 * Why this design:
 *   - The HMAC secret stays server-only. Unlike a shared
 *     bearer token baked into the frontend bundle, an
 *     attacker who downloads the frontend gets nothing.
 *   - The invite endpoint is where we put the expensive
 *     checks (per-IP rate limit, PoW challenge on 3rd+
 *     attempt). Create endpoint stays focused on signature
 *     verification + chain op.
 *   - Short TTL (10 min default) makes stockpiling
 *     impractical. An attacker who wants to pre-fetch 1000
 *     invites has to do 1000 PoW solutions AND use them all
 *     within the window.
 *   - Binding to IP hash prevents trivial replay across
 *     IP ranges. Combined with the per-IP limiter on the
 *     invite endpoint, this adds up.
 *
 * What this does NOT do:
 *   - Protect against an attacker who BOTH controls many
 *     IPs AND can solve Altcha challenges at scale. If
 *     CAPTCHA-solving farms are in play, the rate-limit +
 *     global ceiling are the effective bounds.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { logger } from '$log';
import { defaultClock, type Clock } from './clock.ts';

const log = logger('invite-token');

/** Decoded invite payload after signature + non-expiry checks.
 *  Exposed so the create endpoint can log/verify fields. */
export interface InvitePayload {
	/** 128-bit hex nonce — used for single-use tracking. */
	nonce: string;
	/** Issued-at epoch ms. */
	iat: number;
	/** Expiry epoch ms. */
	exp: number;
	/** SHA-256 hex of the issuing client's IP. Used to bind
	 *  the invite to the IP so a trivial cross-IP replay is
	 *  blocked. We hash rather than store raw IP so the invite
	 *  doesn't embed PII even in transit. */
	ip_hash: string;
}

export type InviteVerifyResult =
	| { ok: true; payload: InvitePayload }
	| { ok: false; code: 'invite_malformed' }
	| { ok: false; code: 'invite_bad_signature' }
	| { ok: false; code: 'invite_expired' }
	| { ok: false; code: 'invite_ip_mismatch' }
	| { ok: false; code: 'invite_already_used' };

/**
 * Service for issuing + verifying invite tokens. One instance
 * per relay process. The HMAC secret is set at construction;
 * if the caller doesn't provide one, a fresh 32-byte random
 * secret is generated (ephemeral, valid until next restart).
 */
export class InviteTokenService {
	private readonly secret: Buffer;
	private readonly ttlMs: number;
	private readonly clock: Clock;
	/** Nonces of tokens already consumed. Single-use: redeeming
	 *  an invite adds its nonce here. Eviction: any nonce whose
	 *  corresponding token is past its expiry is safe to drop
	 *  (the signature check would reject a replay anyway).
	 *
	 *  We use a Map<nonce, exp> rather than Set<nonce> so the
	 *  janitor can drop expired entries deterministically. */
	private readonly consumedNonces = new Map<string, number>();
	/** F3 — nonces claimed by an in-flight create (tryClaim), value is
	 *  claim time. Cleared by consume()/releaseClaim(); swept after
	 *  CLAIM_TTL_MS so a crashed request never permanently locks an invite. */
	private readonly claimedNonces = new Map<string, number>();
	private janitor: NodeJS.Timeout | null = null;

	constructor(options: { secret?: Buffer | null; ttlMs?: number; clock?: Clock } = {}) {
		if (options.secret) {
			this.secret = options.secret;
			log.info('invite_secret_persistent');
		} else {
			this.secret = randomBytes(32);
			log.warn('invite_secret_ephemeral', {
				note: 'MORPHIT_RELAY_INVITE_HMAC_SECRET not set — using a random per-boot secret. In-flight invites will be invalidated on restart.'
			});
		}
		this.ttlMs = options.ttlMs ?? 10 * 60_000; // 10 minutes
		this.clock = options.clock ?? defaultClock;

		// Sweep consumed nonces whose expiry has passed. Runs at
		// 1/4 the TTL so we clean up promptly without wasted CPU.
		const interval = Math.max(10_000, Math.floor(this.ttlMs / 4));
		this.janitor = setInterval(() => this.sweep(), interval);
		this.janitor.unref?.();
	}

	/**
	 * Issue a new invite for the given IP. The relay should
	 * rate-limit invite issuance before calling this.
	 */
	issue(ip: string): { token: string; expiresAt: Date } {
		const now = this.clock.now();
		const payload: InvitePayload = {
			nonce: randomBytes(16).toString('hex'),
			iat: now,
			exp: now + this.ttlMs,
			ip_hash: this.hashIp(ip)
		};
		const payloadJson = JSON.stringify(payload);
		const payloadB64 = base64urlEncode(Buffer.from(payloadJson, 'utf8'));
		const sig = createHmac('sha256', this.secret).update(payloadB64).digest();
		const sigB64 = base64urlEncode(sig);
		return {
			token: `${payloadB64}.${sigB64}`,
			expiresAt: new Date(payload.exp)
		};
	}

	/**
	 * Verify a token. Does NOT mark it consumed — that's a
	 * separate step so the caller can sequence "verify →
	 * do work → consume" or "verify + consume atomically"
	 * as the workflow demands. The current-session ip is
	 * required so we can check ip_hash.
	 */
	verify(token: string, ip: string): InviteVerifyResult {
		const parts = token.split('.');
		if (parts.length !== 2) {
			return { ok: false, code: 'invite_malformed' };
		}
		const [payloadB64, sigB64] = parts as [string, string];

		// Recompute the signature on the claimed payload bytes
		// and compare. timingSafeEqual guards against timing
		// oracles; length check first so timingSafeEqual never
		// throws on size mismatch.
		const expectedSig = createHmac('sha256', this.secret).update(payloadB64).digest();
		let actualSig: Buffer;
		try {
			actualSig = base64urlDecode(sigB64);
		} catch {
			return { ok: false, code: 'invite_malformed' };
		}
		if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
			return { ok: false, code: 'invite_bad_signature' };
		}

		// Decode payload after signature check (so we don't trust
		// attacker-controlled bytes enough to JSON-parse without
		// auth).
		let payload: InvitePayload;
		try {
			const json = base64urlDecode(payloadB64).toString('utf8');
			const parsed = JSON.parse(json) as unknown;
			if (!isInvitePayload(parsed)) {
				return { ok: false, code: 'invite_malformed' };
			}
			payload = parsed;
		} catch {
			return { ok: false, code: 'invite_malformed' };
		}

		const now = this.clock.now();
		if (payload.exp <= now) {
			return { ok: false, code: 'invite_expired' };
		}
		if (payload.ip_hash !== this.hashIp(ip)) {
			return { ok: false, code: 'invite_ip_mismatch' };
		}
		if (this.consumedNonces.has(payload.nonce)) {
			return { ok: false, code: 'invite_already_used' };
		}
		// F3 — reject a nonce that is CLAIMED (verified by a concurrent
		// request that is mid-broadcast). Without this, two requests
		// presenting the same still-valid invite both pass verify() before
		// either consumes, yielding two accounts — and two ~102 BLURT spends
		// — from one invite. The authoritative gate is tryClaim() just before
		// broadcast; this early check simply rejects the loser sooner.
		if (this.claimedNonces.has(payload.nonce)) {
			return { ok: false, code: 'invite_already_used' };
		}

		return { ok: true, payload };
	}

	/**
	 * F3 — atomically claim a verified nonce for the duration of a
	 * broadcast. Synchronous (no await), so between a request's claim
	 * and its next `await` no other request can run: a concurrent
	 * request presenting the same nonce sees it claimed and is rejected.
	 * Returns false if the nonce is already consumed or claimed.
	 *
	 * Sequence: verify() → tryClaim() → broadcast →
	 *   success: consume()  (claim → consumed, permanent)
	 *   failure: releaseClaim()  (claim freed, invite retryable)
	 * A crashed request that neither consumes nor releases is swept
	 * after CLAIM_TTL_MS so an invite is never permanently locked.
	 */
	tryClaim(payload: InvitePayload): boolean {
		if (this.consumedNonces.has(payload.nonce)) return false;
		if (this.claimedNonces.has(payload.nonce)) return false;
		this.claimedNonces.set(payload.nonce, this.clock.now());
		return true;
	}

	/** F3 — release a claim taken by tryClaim() (broadcast failed;
	 *  the invite stays usable for an immediate retry). */
	releaseClaim(payload: InvitePayload): void {
		this.claimedNonces.delete(payload.nonce);
	}

	/**
	 * Mark a successfully-verified invite as consumed. Call
	 * this only after the downstream work (account_create
	 * broadcast) has succeeded — so that a failed chain call
	 * doesn't burn the user's invite.
	 *
	 * Future verify() calls with the same nonce will return
	 * `invite_already_used`.
	 */
	consume(payload: InvitePayload): void {
		this.claimedNonces.delete(payload.nonce);
		this.consumedNonces.set(payload.nonce, payload.exp);
	}

	/** Stop the janitor. Call on graceful shutdown. */
	close(): void {
		if (this.janitor) {
			clearInterval(this.janitor);
			this.janitor = null;
		}
	}

	private sweep(): void {
		const now = this.clock.now();
		for (const [nonce, exp] of this.consumedNonces) {
			if (exp <= now) this.consumedNonces.delete(nonce);
		}
		// F3 — free claims from requests that crashed without consuming or
		// releasing. CLAIM_TTL_MS (2 min) comfortably exceeds any broadcast.
		const CLAIM_TTL_MS = 120_000;
		for (const [nonce, claimedAt] of this.claimedNonces) {
			if (claimedAt + CLAIM_TTL_MS <= now) this.claimedNonces.delete(nonce);
		}
	}

	/** HMAC-SHA256 of the IP, keyed with the relay's per-instance
	 *  secret.  Used for the invite's ip_hash field instead of a
	 *  bare SHA-256 because the IPv4 space (2^32) is small enough
	 *  for trivial rainbow-table recovery — bare SHA-256(IP) is
	 *  not an opaque commitment.  The HMAC keeps the attacker
	 *  who only sees invite bytes from recovering the source IP.
	 *  (The relay itself already knows the IP at issue + verify
	 *  time; this is purely about what an off-path observer can
	 *  do with a leaked token.) */
	private hashIp(ip: string): string {
		return createHmac('sha256', this.secret).update(ip).digest('hex');
	}
}

// ─── Helpers (not exported) ─────────────────────────────────────

function isInvitePayload(x: unknown): x is InvitePayload {
	if (typeof x !== 'object' || x === null) return false;
	const o = x as Record<string, unknown>;
	return (
		typeof o.nonce === 'string' &&
		o.nonce.length === 32 &&
		/^[0-9a-f]+$/.test(o.nonce) &&
		typeof o.iat === 'number' &&
		Number.isFinite(o.iat) &&
		typeof o.exp === 'number' &&
		Number.isFinite(o.exp) &&
		o.exp > o.iat &&
		typeof o.ip_hash === 'string' &&
		o.ip_hash.length === 64 &&
		/^[0-9a-f]+$/.test(o.ip_hash)
	);
}

function base64urlEncode(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Buffer {
	// Pad back to multiple of 4 for Buffer.from(base64).
	const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
	return Buffer.from(b64, 'base64');
}
