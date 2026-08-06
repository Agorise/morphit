/**
 * Morphit relay — account-invite endpoint.
 *
 * First half of the two-step signup protocol (see
 * policy/inviteToken.ts for the rationale). This endpoint is
 * where the expensive anti-abuse checks live:
 *
 *   1. Kill-switch — if MORPHIT_RELAY_SIGNUP_ENABLED=false,
 *      return signups_disabled with 503 immediately.
 *   2. Origin allowlist — applied via shared middleware
 *      (same as /v1/account/create).
 *   3. Global daily ceiling pre-check — don't issue invites
 *      the create endpoint will just reject.
 *   4. Per-IP invite-issuance rate limit — tight because
 *      legitimate users rarely need many invites in a day.
 *   5. Altcha proof-of-work challenge — triggered on the
 *      Nth invite per IP per day (configurable; default 3).
 *      The first two invites feel frictionless; the third
 *      adds an invisible ~1s PoW.
 *
 * On success, returns:
 *   { status: 'issued', invite_token: <str>, expires_at: <iso> }
 *
 * On altcha-required:
 *   { status: 'altcha_required', challenge: <AltchaChallenge> }
 *   Client solves and retries with body.altcha_solution set.
 */

import type { Hono, Context } from 'hono';
import { z } from 'zod';

import type { Limiter } from '../middleware/ratelimit.ts';
import type { GlobalDailyCeiling } from '../policy/globalDailyCeiling.ts';
import type { InviteTokenService } from '../policy/inviteToken.ts';
import type { AltchaService, AltchaSolution } from '../policy/altcha.ts';
import type { KillSwitch } from '../policy/killSwitch.ts';
import { clientIp, canonicalBucketKey } from '../middleware/ip.ts';
import { logger } from '$log';

const log = logger('relay-invite');

/** Optional body — if the client is retrying after an altcha
 *  challenge, they include the solved solution here. */
const requestSchema = z
	.object({
		altcha_solution: z
			.object({
				algorithm: z.literal('SHA-256'),
				challenge: z.string(),
				salt: z.string(),
				signature: z.string(),
				number: z.number().int().nonnegative()
			})
			.strict()
			.optional()
	})
	.strict()
	.or(z.object({}).strict()); // empty body also fine

export class InviteEndpoint {
	/** Per-IP count of invites issued today. Resets at UTC
	 *  midnight. Used to decide when to require altcha (after
	 *  the configured trigger threshold).
	 *
	 *  Audit 2026-05 finding 16-B1: bounded to MAX_DAILY_TRACKED_IPS
	 *  to prevent a memory-amplification DoS from a botnet probe
	 *  flooding the endpoint with millions of distinct source IPs
	 *  in a single UTC day.  Any single relay with a sensible
	 *  daily ceiling (typically 25-100 signups/day) will never
	 *  legitimately track more than a few thousand distinct IPs;
	 *  100k is comfortably above that.  When the cap is reached,
	 *  the oldest entry (insertion order) is dropped.  An attacker
	 *  who pushes past the cap loses their accumulated count and
	 *  resets back to "first invite today" — which the altcha gate
	 *  doesn't block.  This is acceptable because the attacker
	 *  already hit the per-IP rate limit (inviteLimiter.allow
	 *  ran first); reaching the cap requires sustained traffic
	 *  AND new source IPs.  The per-IP rate limiter caps each IP's
	 *  request rate; this Map's job is purely altcha-trigger
	 *  bookkeeping. */
	private readonly dailyInviteCounts = new Map<string, number>();
	private dailyInviteCountsDate = utcDateKey();

	/** Defense bound for dailyInviteCounts.  100k entries × ~50
	 *  bytes per Map entry = ~5 MB worst case.  Comfortably below
	 *  any V8 GC pressure threshold and far above any honest
	 *  operator's daily traffic. */
	private static readonly MAX_DAILY_TRACKED_IPS = 100_000;

	constructor(
		private readonly signupEnabled: boolean,
		private readonly ceiling: GlobalDailyCeiling,
		/** Per-IP invite-issuance limiter. Tighter than the
		 *  CREATE limiter because an attacker needs many more
		 *  invites than completed creates, and we want to cut
		 *  off that vector early. */
		private readonly inviteLimiter: Limiter,
		private readonly altchaTriggerCount: number,
		private readonly altcha: AltchaService,
		private readonly inviteTokens: InviteTokenService,
		/** Optional file-based runtime kill switch.  When the
		 *  sentinel file exists, signups are paused without
		 *  needing a relay restart.  Null means the feature is
		 *  not configured (env-var disable still works). */
		private readonly killSwitch: KillSwitch | null = null
	) {}

	register(app: Hono): void {
		app.post('/v1/account/invite', (c) => this.handle(c));
	}

	async handle(c: Context): Promise<Response> {
		// Kill-switch FIRST — cheapest check, operator's lever
		// of last resort. If this is off, we don't want to do any
		// work at all.
		if (!this.signupEnabled) {
			return c.json(
				{
					status: 'rejected',
					code: 'signups_disabled',
					message: 'Account signup is currently unavailable on this relay.'
				},
				503
			);
		}

		// Runtime kill-switch (file-based).  Allows operator to
		// pause signups during incident response without restarting
		// the relay.  Same response code as the env-var disable so
		// clients see one consistent "signups paused" path.
		if (this.killSwitch?.isActive()) {
			return c.json(
				{
					status: 'rejected',
					code: 'signups_disabled',
					message: 'Account signup is currently unavailable on this relay.'
				},
				503
			);
		}

		// Global ceiling pre-check. If we're already at the daily
		// cap, issuing an invite is wasted work — the create
		// endpoint would reject it.
		if (!this.ceiling.canAccept()) {
			return c.json(
				{
					status: 'rejected',
					code: 'daily_ceiling_reached',
					message: 'This relay has reached its daily signup limit. Please try again tomorrow.',
					resets_at: this.ceiling.resetsAt().toISOString()
				},
				503
			);
		}

		const ip = clientIp(c);
		// Rate-limit + per-day counter bucket — collapses IPv6 /64
		// and IPv4 /24 prefixes into a single bucket so an attacker
		// with a /64 prefix budget can't trivially bypass per-IP
		// limits.  Same key is used for IP-binding the invite (see
		// inviteTokens.issue below) so a legitimate user whose
		// dynamic-IPv6 host bits rotate between /invite and /create
		// still verifies — most operating systems rotate IPv6
		// privacy-extension addresses several times per day.
		const bucketKey = canonicalBucketKey(ip);

		// Per-IP rate limit on invite issuance. Tight because
		// the failure mode of a legitimate user is 1-2 invites,
		// not 20.
		if (!this.inviteLimiter.allow(bucketKey)) {
			return c.json(
				{
					status: 'rejected',
					code: 'invite_rate_limited',
					message: 'Too many invite requests from this connection. Try again later.'
				},
				429
			);
		}

		// Audit fix (this turn): read priorToday SYNCHRONOUSLY here,
		// before any await, so concurrent requests from the same IP
		// see distinct priorToday values.  Pre-fix, both requests
		// awaited the body-parse and then both read priorToday=0,
		// both passed the altcha gate, both incremented to 1 — so
		// `altchaTriggerCount=3` could be bypassed for up to
		// `inviteLimiter.max` (e.g. 5) concurrent invites with no PoW.
		// Reading-then-tentatively-reserving before the await closes
		// the race window: the second concurrent request reads
		// priorToday=1, which is what `altchaTriggerCount=3` should
		// allow without altcha; the third reads 2, which should
		// allow without altcha; the fourth reads 3 and IS gated.
		// The reservation is finalized on success; on rejection it
		// is decremented (NOT set back to a pre-read value, because
		// concurrent requests may have moved the counter forward in
		// the meantime — atomic decrement preserves their work).
		this.maybeRollover();
		const priorToday = this.dailyInviteCounts.get(bucketKey) ?? 0;
		// Tentatively reserve a slot.  This must happen synchronously
		// (no await) between the rate-limit check and the body-parse
		// await so concurrent requests interleave in the correct
		// order for the altcha decision.  Enforce MAX_DAILY_TRACKED_IPS
		// here too — same eviction policy as before.
		if (
			!this.dailyInviteCounts.has(bucketKey) &&
			this.dailyInviteCounts.size >= InviteEndpoint.MAX_DAILY_TRACKED_IPS
		) {
			const oldestKey = this.dailyInviteCounts.keys().next().value;
			if (oldestKey !== undefined) {
				this.dailyInviteCounts.delete(oldestKey);
			}
		}
		this.dailyInviteCounts.set(bucketKey, priorToday + 1);
		const altchaRequired = priorToday >= this.altchaTriggerCount - 1;

		// Helper: atomically decrement the reservation we made above
		// when we need to bail out.  Uses get-then-set against the
		// CURRENT value rather than the pre-reservation value, so a
		// concurrent request that incremented after us doesn't get
		// undone.
		const releaseReservation = (): void => {
			const cur = this.dailyInviteCounts.get(bucketKey);
			if (cur !== undefined && cur > 0) {
				this.dailyInviteCounts.set(bucketKey, cur - 1);
			}
		};

		// Parse optional body.
		let body: z.infer<typeof requestSchema>;
		try {
			const raw = await c.req.json().catch(() => ({}));
			const parsed = requestSchema.safeParse(raw);
			if (!parsed.success) {
				releaseReservation();
				return c.json(
					{
						status: 'rejected',
						code: 'malformed_request',
						message: 'Request body, if present, must match the schema.'
					},
					400
				);
			}
			body = parsed.data;
		} catch {
			releaseReservation();
			return c.json(
				{
					status: 'rejected',
					code: 'malformed_request',
					message: 'Request body must be valid JSON (or empty).'
				},
				400
			);
		}

		if (altchaRequired) {
			const solution = 'altcha_solution' in body ? body.altcha_solution : undefined;
			if (!solution) {
				// Issue a fresh challenge and tell the client to solve.
				// Roll back the reservation: the user hasn't completed
				// the invite yet, and forcing them to redo altcha
				// shouldn't also burn one of their daily slots.
				releaseReservation();
				const challenge = this.altcha.issue();
				return c.json({
					status: 'altcha_required',
					challenge
				});
			}
			const verify = this.altcha.verify(solution as AltchaSolution);
			if (!verify.ok) {
				// Roll back: failed altcha shouldn't burn a slot
				// either — same rationale as the missing-solution
				// path above.
				releaseReservation();
				// Issue a fresh challenge on any altcha failure —
				// client can retry with the new one.
				const fresh = this.altcha.issue();
				return c.json(
					{
						status: 'rejected',
						code: verify.code,
						message:
							'Proof-of-work challenge failed. A new challenge has been issued; please solve and retry.',
						challenge: fresh
					},
					400
				);
			}
			// Altcha passed — fall through to issuance.  The
			// tentative reservation we made earlier becomes the
			// real reservation; no further increment needed.
		}

		// All checks passed — the tentative reservation we made
		// before parsing is now finalized; no further increment.
		const { token, expiresAt } = this.inviteTokens.issue(bucketKey);
		log.info('invite_issued', {
			prior_today: priorToday,
			altcha_required: altchaRequired
		});
		return c.json({
			status: 'issued',
			invite_token: token,
			expires_at: expiresAt.toISOString()
		});
	}

	private maybeRollover(): void {
		const today = utcDateKey();
		if (today !== this.dailyInviteCountsDate) {
			this.dailyInviteCountsDate = today;
			this.dailyInviteCounts.clear();
		}
	}
}

function utcDateKey(from: Date = new Date()): string {
	const y = from.getUTCFullYear();
	const m = String(from.getUTCMonth() + 1).padStart(2, '0');
	const d = String(from.getUTCDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}
