/**
 * Morphit relay — account creation endpoint.
 *
 * Second half of the two-step signup protocol. Accepts an
 * invite token (see policy/inviteToken.ts) and an unsigned
 * account-creation op body, validates, wraps in a transaction
 * signed with the relay's own active key, and broadcasts a direct
 * `account_create` op that pays the live `account_creation_fee`
 * (100 BLURT, unchanged for years) INLINE from the relay account's
 * liquid balance, followed by a 2 BLURT signup-dust transfer — so
 * each successful signup spends ~102 liquid BLURT from the relay.
 * (Blurt DISABLED the Account-Creation-Token model — claim_account /
 * create_claimed_account — at HF2, so there are no pre-minted ACTs
 * and creation is NOT fee-free. See ADR-0010 and docs/OPERATIONS.md;
 * the real broadcast is broadcastAccountCreate() below.)  Returns the
 * chain's
 * confirmation.
 *
 * Anti-abuse checks, in order:
 *   1. Kill-switch (MORPHIT_RELAY_SIGNUP_ENABLED).
 *   2. Global daily ceiling (caps worst-case drain; reserved atomically).
 *   3. Per-IP daily cap + spacing via reserveWithSpacing (≥N minutes
 *      between this IP's signups; reserved at entry so concurrent
 *      requests see each other, released on every no-spend path).
 *   4. Invite token verification (server-side HMAC signature,
 *      non-expired, IP-bound, single-use).
 *   5. Shape/name/pubkey validation.
 *   6. Dedup check for accidental double-submit.
 *   7. Availability check against the chain (an account that already
 *      exists with the REQUESTED owner key is this user's own earlier
 *      success, answered as such without spending again).
 *   8. Broadcast the op — refused on a fee spike (>1.5x configured);
 *      signed ONCE, the same bytes offered to every RPC node.
 *   9. When the relay spent (or may have spent — outcome unknown): consume
 *      the invite, count the ceiling and keep the per-IP slot. Otherwise
 *      release all three.
 *
 * Security contract:
 *   - The user's private keys NEVER touch this code. Only their four
 *     new public keys (owner/active/posting/memo) are in the request.
 *   - The relay's active key is read once at startup and held in
 *     process memory. It is never logged, never transmitted, never
 *     returned in responses.
 *   - All input validation happens before any chain call. Malformed
 *     or policy-rejected inputs never reach the signing code path.
 *
 * See docs/PHASE-3a-DESIGN.md for the full design + threat model.
 * See docs/OPERATIONS.md §17-§18 for operator guidance on the
 * signup-drain defenses.
 */

import type { Hono, Context } from 'hono';
import { z } from 'zod';

import {
	AccountTakenError,
	BroadcastNotLandedError,
	BroadcastNotSentError,
	BroadcastOutcomeUnknownError,
	FeeSpikeRefusedError,
	type BlurtClient
} from '../blurt/client.ts';
import type { UnlockedConfig } from '../config/index.ts';
import type { Limiter } from '../middleware/ratelimit.ts';
import type { HealthService } from './health.ts';
import type { GlobalDailyCeiling } from '../policy/globalDailyCeiling.ts';
import type { InviteTokenService } from '../policy/inviteToken.ts';
import type { KillSwitch } from '../policy/killSwitch.ts';
import { validateBlurtName } from '../policy/name.ts';
import {
	classifyHighValueName,
	isHighValueBlocked,
	type HighValuePolicy
} from '../policy/highValueName.ts';
import { SequentialDetector } from '../policy/sequentialDetector.ts';
import { isValidPublicKey } from '../blurt/pubkey.ts';
import { clientIp, canonicalBucketKey } from '../middleware/ip.ts';
import { logger } from '$log';

const log = logger('relay-create');

/** Request body schema.  `op` carries the account-creation field
 *  set (new_account_name + owner/active/posting/memo pubkeys +
 *  json_metadata) that the relay will broadcast as a direct
 *  `account_create` op, paying the live account_creation_fee in
 *  BLURT from the relay account (ACTs were removed at HF2).
 *  `invite_token` is the signed invite obtained from the
 *  /v1/account/invite endpoint. */
const requestSchema = z
	.object({
		invite_token: z.string().min(1).max(4096),
		op: z
			.object({
				new_account_name: z.string().min(1).max(16),
				owner: z
					.object({
						weight_threshold: z.literal(1),
						account_auths: z.array(z.tuple([z.string(), z.number()])).max(0),
						key_auths: z.array(z.tuple([z.string(), z.number()])).length(1)
					})
					.strict(),
				active: z
					.object({
						weight_threshold: z.literal(1),
						account_auths: z.array(z.tuple([z.string(), z.number()])).max(0),
						key_auths: z.array(z.tuple([z.string(), z.number()])).length(1)
					})
					.strict(),
				posting: z
					.object({
						weight_threshold: z.literal(1),
						account_auths: z.array(z.tuple([z.string(), z.number()])).max(0),
						key_auths: z.array(z.tuple([z.string(), z.number()])).length(1)
					})
					.strict(),
				memo_key: z.string().min(1),
				json_metadata: z.string().max(1024)
			})
			.strict()
	})
	.strict();

/** Dedupe set: sha256(name + owner + active + posting + memo)
 *  keys seen in the last minute, to defend against accidental
 *  double-submit from a flaky client network.  A real name-
 *  squatter won't be reusing their own keys + same name, so
 *  this is tight enough to catch network-retry double-creates
 *  while still letting a user who got an error response retry
 *  with a different name (the common case after the chain
 *  reported "already_registered" in the TOCTOU window).
 *
 *  Pre-fix this was keyed on key-fingerprint alone, which
 *  would lock a user out of retrying with a different name for
 *  60 seconds after any error. */
/** Whether the relay spent (or may have spent) on this request, so the
 *  per-IP daily slot reserved at entry must be kept (v1.20.0, D5). */
interface SpendState {
	keepDaily: boolean;
	/** `${name}|${ownerKey}` of this request. */
	heldKey?: string;
	/** Returns this request's per-IP slot (for holdForRetry). */
	heldRelease?: () => void;
	/** This request's rate-limit bucket (a held slot is only for it). */
	bucketKey?: string;
}

/** What handle() learned before reserving anything. */
interface RequestCtx {
	readonly bucketKey: string;
	readonly parsed: z.infer<typeof requestSchema>;
	/** The pre-check's account read: null = absent, undefined = read failed. */
	readonly preExisting: Awaited<ReturnType<BlurtClient['getAccount']>> | undefined;
}

/** How long a per-IP slot kept by a `broadcast_outcome_unknown` attempt waits
 *  for its same-name retry (fix wave 4, A4). */
const HELD_SLOT_TTL_MS = 30 * 60_000;

interface DedupeEntry {
	fingerprint: string;
	expiresAt: number;
}

export class CreateEndpoint {
	private readonly dedupe: DedupeEntry[] = [];
	private readonly dedupeWindowMs = 60_000;
	/** Per-IP slots kept by `broadcast_outcome_unknown` attempts, keyed by
	 *  `${name}|${ownerKey}`, waiting for the same-name retry (A4). */
	private readonly heldAfterUnknown = new Map<
		string,
		{ readonly bucketKey: string; readonly release: () => void; readonly expiresAt: number }
	>();

	private holdForRetry(spend: SpendState): void {
		if (spend.heldKey === undefined || spend.heldRelease === undefined) return;
		const now = Date.now();
		for (const [k, v] of this.heldAfterUnknown) if (v.expiresAt <= now) this.heldAfterUnknown.delete(k);
		if (this.heldAfterUnknown.size >= 10_000) return; // bounded; the slot simply stays counted
		this.heldAfterUnknown.set(spend.heldKey, {
			bucketKey: spend.bucketKey ?? '',
			release: spend.heldRelease,
			expiresAt: now + HELD_SLOT_TTL_MS
		});
	}

	/** Take a held slot for this exact (name, key) from the same IP bucket. */
	private takeHeld(key: string, bucketKey: string): (() => void) | null {
		const h = this.heldAfterUnknown.get(key);
		if (h === undefined || h.expiresAt <= Date.now() || h.bucketKey !== bucketKey) return null;
		this.heldAfterUnknown.delete(key);
		return h.release;
	}

	constructor(
		private readonly cfg: UnlockedConfig,
		private readonly blurt: BlurtClient,
		/** Per-IP burst limiter (e.g. 5/hour). Defense in depth
		 *  alongside the daily limiter below; a single call can
		 *  be rejected by either. */
		private readonly limiter: Limiter,
		/** Per-IP daily limiter (e.g. 2/day). Also enforces a
		 *  minimum gap between successful signups from the same
		 *  IP — see allowWithSpacing. */
		private readonly dailyLimiter: Limiter,
		/** Minimum minutes between this IP's signups. Stacks on
		 *  top of the daily cap. */
		private readonly spacingMinutes: number,
		private readonly health: HealthService,
		private readonly signupEnabled: boolean,
		private readonly ceiling: GlobalDailyCeiling,
		private readonly inviteTokens: InviteTokenService,
		/** Optional file-based runtime kill switch.  When the
		 *  sentinel file exists, signups are paused without
		 *  needing a relay restart.  Null means the feature is
		 *  not configured (env-var disable still works). */
		private readonly killSwitch: KillSwitch | null = null,
		/** Layer 7 — high-value name policy.  When set to
		 *  anything but 'off', names classified as squatter-
		 *  attractive (short, dictionary, brand, numeric) are
		 *  rejected unless the request includes a valid bond
		 *  proof (Layer 9, future). */
		private readonly highValuePolicy: HighValuePolicy = 'strict',
		/** Configurable threshold for "short name" classification.
		 *  Lower = more permissive (allows shorter names). */
		private readonly highValueShortThreshold: number = 4,
		/** Layer 8 — sequential signup detector.  Null disables. */
		private readonly sequentialDetector: SequentialDetector | null = null
	) {}

	register(app: Hono): void {
		app.post('/v1/account/create', (c) => this.handle(c));
	}

	async handle(c: Context): Promise<Response> {
		// Kill-switch FIRST. If the operator has disabled signup,
		// we don't want to do any work at all.
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

		// Runtime kill-switch (file-based).  Same response code as
		// env-var disable.  See KillSwitch class for operator
		// procedure (`touch <data-dir>/SIGNUPS_DISABLED` to pause).
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

		const bucketKey = canonicalBucketKey(clientIp(c));
		// Per-IP burst cap (e.g. 5/hour) — consume on check.
		// This is the cheap limit that bounds the rate of
		// availability+broadcast attempts.  A legitimate user
		// trying to find an unregistered username gets 5 attempts
		// per hour, which is comfortable for finding a name they
		// like.  Consuming on every request (not only successful
		// broadcasts) is what makes this an actual rate limiter
		// against attackers; if we peeked here, an attacker could
		// burst unbounded.
		if (!this.limiter.allow(bucketKey)) {
			return c.json(
				{
					status: 'rejected',
					code: 'rate_limited',
					message: 'Too many account-creation requests from this client. Try again in an hour.'
				},
				429
			);
		}

		// Parse + validate body shape.
		let parsed: z.infer<typeof requestSchema>;
		try {
			const body = await c.req.json();
			const result = requestSchema.safeParse(body);
			if (!result.success) {
				return c.json(
					{
						status: 'rejected',
						code: 'malformed_operation',
						message:
							'Request body must include a properly-shaped `op` with new_account_name and four single-key authorities.'
					},
					400
				);
			}
			parsed = result.data;
		} catch {
			return c.json(
				{
					status: 'rejected',
					code: 'malformed_operation',
					message: 'Request body must be valid JSON.'
				},
				400
			);
		}

		// ── "Already created with YOUR key" — answered FIRST (fix wave 4, A4).
		// After `broadcast_outcome_unknown` the user is told to retry with the
		// same name. That retry must reach this answer, not the per-IP spacing
		// rule (a 60-minute 429 that pushed people to pick ANOTHER name — a
		// second 100 BLURT). Nothing is spent, reserved or counted here; the
		// attempt that created the account did that.
		const preName = parsed.op.new_account_name.trim().toLowerCase();
		const preOwner = parsed.op.owner.key_auths[0]![0];
		let preExisting: Awaited<ReturnType<BlurtClient['getAccount']>> | undefined;
		if (validateBlurtName(preName) === 'ok' && isValidPublicKey(preOwner)) {
			try {
				preExisting = await this.blurt.getAccount(preName);
			} catch {
				preExisting = undefined; // decided below by the normal availability check
			}
			if (preExisting && preExisting.owner_pubkey !== undefined && preExisting.owner_pubkey === preOwner) {
				this.heldAfterUnknown.delete(`${preName}|${preOwner}`);
				log.info('create_already_done', { account: preName });
				return c.json({ status: 'broadcast', block_num: 0, trx_id: '', note: 'already_created' });
			}
		}

		// Global daily ceiling pre-check + atomic reservation.
		// Audit fix (this turn): pre-fix this used canAccept() to
		// gate the pre-check, then a separate recordSuccess() at
		// the very end to count the success.  Concurrent requests
		// from N different IPs could all see canAccept()=true at
		// count=ceiling-1 and all proceed, with the ceiling
		// overshooting by N-1.  tryReserve() is atomic (does the
		// canAccept-then-increment in one synchronous step), so
		// the (N-1)-th concurrent caller hits the cap and gets
		// rejected.  The reservation is finalized by recordSuccess()
		// on the broadcast-success path; the try/finally below
		// auto-releases it on any path that didn't finalize.
		if (!this.ceiling.tryReserve()) {
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

		// Track whether the reservation was finalized via
		// recordSuccess().  If we fall off any other path —
		// rejection, exception, etc. — the finally block will
		// release it.  Keeping this as a let-flag rather than
		// adding releaseReservation() before every `return c.json()`
		// is less error-prone for future edits to this handler.
		let reservationFinalized = false;
		try {
			return await this.handleWithReservation(
				c,
				() => {
					reservationFinalized = true;
				},
				{ bucketKey, parsed, preExisting }
			);
		} finally {
			if (!reservationFinalized) {
				this.ceiling.releaseReservation();
			}
		}
	}

	/** Inner handle body — called within a reservation-tracking
	 *  try/finally in handle().  Calls finalize() exactly once on
	 *  the success path so the outer finally knows not to release. */
	private async handleWithReservation(c: Context, finalize: () => void, ctx: RequestCtx): Promise<Response> {
		const { bucketKey } = ctx;
		// A same-name, same-key retry after `broadcast_outcome_unknown` reuses
		// the per-IP slot that attempt kept (fix wave 4, A4): no new
		// reservation, so the spacing rule cannot refuse it. If this retry ends
		// without spending, that slot is returned.
		const heldKey = `${ctx.parsed.op.new_account_name.trim().toLowerCase()}|${ctx.parsed.op.owner.key_auths[0]![0]}`;
		const held = this.takeHeld(heldKey, bucketKey);
		if (held !== null) {
			const spend: SpendState = { keepDaily: false, heldKey, heldRelease: held, bucketKey };
			try {
				return await this.handleWithDailySlot(c, ctx, finalize, spend);
			} finally {
				if (!spend.keepDaily && !this.heldAfterUnknown.has(heldKey)) held();
			}
		}
		// Per-IP daily cap WITH spacing: "≤N per day AND the
		// most recent one was ≥M minutes ago."  RESERVED here, not peeked
		// (v1.20.0, D5): a peek let N concurrent requests from one bucket all
		// see an empty bucket and all create accounts, beating both the daily
		// cap and the spacing. The reservation is KEPT when the relay spent
		// (the account was created, or may have been) and RELEASED on every
		// no-spend path — a user iterating through taken usernames, a
		// validation reject, a broadcast the chain proved did not land — so
		// legitimate retries still don't burn quota.
		const dailyDecision = this.dailyLimiter.reserveWithSpacing(
			bucketKey,
			this.spacingMinutes * 60_000
		);
		if (!dailyDecision.allowed) {
			if (dailyDecision.reason === 'quota_exhausted') {
				return c.json(
					{
						status: 'rejected',
						code: 'rate_limited_daily',
						message: 'Daily signup limit reached. Try again tomorrow.'
					},
					429
				);
			}
			// Spacing cooldown: tell the user how long to wait.
			const mins = Math.ceil(dailyDecision.retryAfterMs / 60_000);
			return c.json(
				{
					status: 'rejected',
					code: 'spacing_cooldown',
					retry_after_minutes: mins,
					message: `You recently created an account. Please wait ${mins} more minute${mins === 1 ? '' : 's'} before creating another.`
				},
				429
			);
		}
		const spend: SpendState = { keepDaily: false, heldKey, heldRelease: dailyDecision.release, bucketKey };
		try {
			return await this.handleWithDailySlot(c, ctx, finalize, spend);
		} finally {
			if (!spend.keepDaily) dailyDecision.release();
		}
	}

	/** Everything after the per-IP daily slot is reserved. Sets
	 *  `spend.keepDaily` on every path where the relay spent (or may have
	 *  spent) the account_creation_fee, so the caller keeps the slot. */
	private async handleWithDailySlot(
		c: Context,
		ctx: RequestCtx,
		finalize: () => void,
		spend: SpendState
	): Promise<Response> {
		const { bucketKey, parsed } = ctx;
		// Fee spike (D4): the live account_creation_fee is more than 1.5x the
		// configured one. Say so plainly rather than "out of funds".
		if (this.health.liveFeeSpiked?.() === true) {
			return c.json(
				{
					status: 'rejected',
					code: 'relay_fee_spike',
					message: 'Account signup is paused on this relay while the operator reviews a change in the Blurt account fee.'
				},
				503
			);
		}

		// Fast pre-check: if the relay is low on BLURT, reject before
		// doing any other work. The HealthService's background poll
		// keeps this snapshot fresh to within 30 seconds, which is
		// tight enough for this decision (we're rejecting, not spending).
		if (!this.health.canAcceptCreation()) {
			return c.json(
				{
					status: 'rejected',
					code: 'relay_out_of_funds',
					message: 'The relay is temporarily unable to fund new accounts. Please try again later.'
				},
				503
			);
		}

		const op = parsed.op;
		const name = op.new_account_name.trim().toLowerCase();

		// ── Invite token verification ────────────────────────────────
		// Cheap check (pure HMAC + expiry) — do it before any chain
		// call so bad invites don't waste RPC. Verified but NOT
		// consumed yet: consumption happens only after the chain
		// broadcast succeeds, so a failed chain call doesn't burn
		// the user's invite.
		const inviteResult = this.inviteTokens.verify(parsed.invite_token, bucketKey);
		if (!inviteResult.ok) {
			return c.json(
				{
					status: 'rejected',
					code: inviteResult.code,
					message: inviteMessageFor(inviteResult.code)
				},
				inviteResult.code === 'invite_expired' || inviteResult.code === 'invite_already_used'
					? 410
					: 400
			);
		}
		const invitePayload = inviteResult.payload;

		// ── Structural name validation ───────────────────────────────
		const nameReason = validateBlurtName(name);
		if (nameReason !== 'ok') {
			return c.json(
				{
					status: 'rejected',
					code: 'name_not_allowed',
					reason: nameReason,
					message: `Account name rejected: ${nameReason}`
				},
				400
			);
		}

		// ── Layer 7: High-value name policy ──────────────────────────
		// Names that look like obvious squatter targets (short,
		// dictionary brand, all-numeric, numeric suffix) are
		// rejected unless the operator's policy is 'off'.  The
		// relay logs which category triggered so the operator can
		// audit false positives and tune the policy / threshold.
		// See policy/highValueName.ts for the classification rules.
		if (this.highValuePolicy !== 'off') {
			const hvClass = classifyHighValueName(name, {
				shortNameThreshold: this.highValueShortThreshold
			});
			if (hvClass !== null && isHighValueBlocked(hvClass, this.highValuePolicy)) {
				log.info('highvalue_name_rejected', {
					name,
					classification: hvClass,
					policy: this.highValuePolicy
				});
				return c.json(
					{
						status: 'rejected',
						code: 'name_high_value',
						reason: hvClass,
						message:
							'This account name is considered high-value and is not ' +
							'available for relay-funded creation on this instance.  ' +
							'You may register it directly on the chain by paying the ' +
							'creation fee yourself, or contact the operator if you ' +
							'have a legitimate claim to the name.'
					},
					400
				);
			}
		}

		// ── Layer 8: Sequential / similar-pattern detection ──────────
		// Catches automated enumeration: if 2+ recent successful
		// signups from this same IP /24 (or /64 for IPv6) bucket
		// match a sequential pattern with the proposed name, refuse
		// the next one.  See policy/sequentialDetector.ts.
		if (this.sequentialDetector !== null) {
			const seqResult = this.sequentialDetector.check(name, bucketKey);
			if (seqResult.blocked) {
				log.info('sequential_pattern_rejected', {
					name,
					bucketKey,
					reason: seqResult.reason,
					matched: seqResult.matchedPrior
				});
				return c.json(
					{
						status: 'rejected',
						code: 'name_sequential_pattern',
						reason: seqResult.reason,
						message:
							'Recent account creations from this network have followed ' +
							'a sequential pattern that suggests automation.  Try a ' +
							'name that does not follow the same prefix or numbering, ' +
							'or wait an hour and retry.'
					},
					429
				);
			}
		}

		// ── Pubkey validation ────────────────────────────────────────
		const owner = op.owner.key_auths[0]![0];
		const active = op.active.key_auths[0]![0];
		const posting = op.posting.key_auths[0]![0];
		const memo = op.memo_key;

		for (const [role, key] of [
			['owner', owner],
			['active', active],
			['posting', posting],
			['memo', memo]
		] as const) {
			if (!isValidPublicKey(key)) {
				return c.json(
					{
						status: 'rejected',
						code: 'invalid_pubkey',
						reason: role,
						message: `The ${role} public key is not a valid BLT-prefixed key.`
					},
					400
				);
			}
		}

		// Weight must be 1 in all key_auths (zod checked length + shape,
		// but not the weight value; do that here).
		for (const [role, auth] of [
			['owner', op.owner],
			['active', op.active],
			['posting', op.posting]
		] as const) {
			const weight = auth.key_auths[0]![1];
			if (weight !== 1) {
				return c.json(
					{
						status: 'rejected',
						code: 'malformed_operation',
						message: `${role} key_auths weight must be 1 (got ${weight}).`
					},
					400
				);
			}
		}

		// No pubkey duplication across roles. Keys MUST be distinct.
		const keys = [owner, active, posting, memo];
		if (new Set(keys).size !== keys.length) {
			return c.json(
				{
					status: 'rejected',
					code: 'malformed_operation',
					message: 'owner / active / posting / memo pubkeys must all be distinct.'
				},
				400
			);
		}

		// ── Dedupe check ─────────────────────────────────────────────
		// Avoid accidental double-submit from flaky network retries.
		// Composite key on (name, key set) — see DedupeEntry comment
		// for rationale.  Identical retry → blocked.  Same keys but
		// different name (the post-"already_registered" retry case)
		// → allowed.
		const fingerprint = await sha256Hex([name, ...keys].join('|'));
		this.evictStaleDedupe();
		if (this.dedupe.some((e) => e.fingerprint === fingerprint)) {
			return c.json(
				{
					status: 'rejected',
					code: 'duplicate_submission',
					message: 'A very recent submission with these same keys is already in flight.'
				},
				409
			);
		}

		// ── Final chain-availability check ───────────────────────────
		// (Reuses the read made before the limits, when it succeeded.)
		let existing = ctx.preExisting;
		if (existing === undefined) try {
			existing = await this.blurt.getAccount(name);
		} catch (err) {
			return c.json(
				{
					status: 'rejected',
					code: 'chain_unavailable',
					message: 'Unable to reach Blurt to verify availability.'
				},
				503
			);
		}
		if (existing) {
			// v1.20.0 (D2) — the account exists WITH THE OWNER KEY THIS REQUEST
			// ASKS FOR: it is this user's own account, created by an earlier
			// attempt whose answer they never got (a lost reply, a proxy 504).
			// That is their success, not "taken by someone else". Nothing is
			// spent or counted again here — the attempt that created it did that.
			if (existing.owner_pubkey !== undefined && existing.owner_pubkey === owner) {
				log.info('create_already_done', { account: name });
				return c.json({
					status: 'broadcast',
					block_num: 0,
					trx_id: '',
					note: 'already_created'
				});
			}
			return c.json(
				{
					status: 'rejected',
					code: 'already_registered',
					message: `Account '${name}' is already taken.`
				},
				409
			);
		}

		// ── Record dedupe BEFORE broadcasting ────────────────────────
		// A second identical submission while this one is in flight is refused.
		// (Whether the first landed is settled by the chain check above on any
		// later retry, so the dedupe is only about concurrent duplicates.)
		this.dedupe.push({
			fingerprint,
			expiresAt: Date.now() + this.dedupeWindowMs
		});

		// ── Sign + broadcast ─────────────────────────────────────────
		// Blurt disabled the Account-Creation-Token model (claim_account
		// / create_claimed_account) at HF2, so the relay creates the
		// account with a direct `account_create` op, paying the live
		// account_creation_fee inline from its liquid BLURT.
		//
		// F3 — atomically claim the invite for the duration of this
		// broadcast. tryClaim() is synchronous, so between it and the
		// `await` below no other request runs: a concurrent request
		// presenting the SAME still-valid invite is rejected here rather
		// than also creating an account (each account is a ~102 BLURT spend
		// from the relay wallet). Consumed when the relay spent, released on
		// every other path (the finally below) — never left to a timer (D6).
		if (!this.inviteTokens.tryClaim(invitePayload)) {
			return c.json(
				{
					status: 'rejected',
					code: 'invite_already_used',
					message: inviteMessageFor('invite_already_used')
				},
				410
			);
		}
		let inviteSettled = false;
		// The relay spent (or may have spent) the fee: every limit counts it.
		const countSpend = (): void => {
			spend.keepDaily = true;
			try {
				this.inviteTokens.consume(invitePayload);
				inviteSettled = true;
			} catch (consumeErr) {
				log.error('invite_consume_failed', { account: name }, consumeErr);
			}
			try {
				this.ceiling.recordSuccess();
			} catch (ceilErr) {
				// recordSuccess doesn't throw on any normal path (saveToDisk
				// catches its own errors); if it ever does, do NOT also release
				// the reservation — the broadcast happened, so the count must
				// reflect it. Worst case one slot is leaked for the day.
				log.error('ceiling_record_failed', { account: name }, ceilErr);
			}
			finalize();
		};
		try {
			let confirmation;
			try {
				confirmation = await this.blurt.broadcastAccountCreate({
					creator: this.cfg.relayAccount,
					creatorActiveWif: this.cfg.relayActiveKeyWif,
					authorities: {
						newAccountName: name,
						ownerPubkey: owner,
						activePubkey: active,
						postingPubkey: posting,
						memoPubkey: memo,
						jsonMetadata: op.json_metadata
					}
				});
			} catch (err) {
				return this.broadcastFailure(c, err, name, fingerprint, countSpend, spend);
			}

			// ── Post-broadcast bookkeeping ───────────────────────────
			// The chain has the account (confirmed by a node, or — after a
			// lost reply — found on chain with OUR owner key): count it once.
			countSpend();
			if (confirmation.recovered === true) {
				log.info('create_recovered_after_lost_reply', { account: name });
			}

			// ── ADR-0010 §2 step 4: 2 BLURT signup dust ──────────────
			// Send a small dust balance so the fresh account can pay
			// chain bandwidth for its first few ops AND set up its
			// profile (display name, avatar, blurt.media / Nostr links)
			// before the first trade. Sent ONCE: the transfer is signed once
			// and never re-signed (D2); a failure or an unknown outcome is
			// logged and not retried here — the account already exists, and
			// the low-balance auto-refill (ADR-0010 §3) tops it up later.
			// Only when a node ACCEPTED this request's own transaction (fix wave
			// 4): a `recovered` account may have been created by an EARLIER
			// attempt that already sent its dust (a retry whose availability
			// read hit a lagging node lands here), and a second 2 BLURT would
			// be a double payment. The auto-refill tops up a missed dust.
			if (confirmation.recovered !== true) try {
				await this.blurt.broadcastTransfer({
					from: this.cfg.relayAccount,
					fromActiveWif: this.cfg.relayActiveKeyWif,
					to: name,
					amountBlurt: 2,
					memo: 'morphit:signup_dust'
				});
			} catch (dustErr) {
				log.error('signup_dust_failed', { account: name }, dustErr);
			}

			// ── Layer 8 bookkeeping: record this successful signup
			// so the sequential-detector can pattern-match the next
			// one.  Recorded AFTER the chain broadcast succeeds —
			// failed attempts don't pollute the history.
			if (this.sequentialDetector !== null) {
				try {
					this.sequentialDetector.recordSignup(name, bucketKey);
				} catch (seqErr) {
					log.error('sequential_record_failed', { account: name }, seqErr);
				}
			}

			return c.json({
				status: 'broadcast',
				block_num: confirmation.block_num,
				trx_id: confirmation.id,
				...(confirmation.recovered === true ? { note: 'recovered_after_lost_reply' } : {})
			});
		} finally {
			// Every path that did not spend frees the invite for a retry.
			if (!inviteSettled) this.inviteTokens.releaseClaim(invitePayload);
		}
	}

	/** Map a failed broadcastAccountCreate to a response. `countSpend` is
	 *  called when the relay MAY have spent the fee (outcome unknown). */
	private broadcastFailure(
		c: Context,
		err: unknown,
		name: string,
		fingerprint: string,
		countSpend: () => void,
		spend: SpendState
	): Response {
		// Nothing left this process (fee/head read or signing failed).
		if (err instanceof BroadcastNotSentError) {
			this.removeDedupeEntry(fingerprint);
			return c.json(
				{
					status: 'rejected',
					code: 'chain_unavailable',
					message: 'Unable to reach Blurt to create the account. Please try again in a moment.'
				},
				503
			);
		}
		// Two or more RPC operators agree the name exists with another key.
		if (err instanceof AccountTakenError) {
			return c.json(
				{
					status: 'rejected',
					code: 'already_registered',
					message: `Account '${name}' was claimed by someone else in the last moment. Please try a different name.`
				},
				409
			);
		}
		// D4 — live fee spiked above the configured fee: nothing was broadcast.
		if (err instanceof FeeSpikeRefusedError) {
			this.removeDedupeEntry(fingerprint);
			log.error('relay_fee_spike_refused', {
				observed_blurt: err.observedBlurt,
				configured_blurt: err.configuredBlurt,
				hint:
					'The chain account_creation_fee is more than 1.5x MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT. ' +
					'Signups are refused until you confirm the new fee and update that value.'
			});
			return c.json(
				{
					status: 'rejected',
					code: 'relay_fee_spike',
					message: 'Account signup is paused on this relay while the operator reviews a change in the Blurt account fee.'
				},
				503
			);
		}
		// D2 — no node confirmed and the chain could not yet say whether the
		// account exists. It MAY exist, so it is counted as spent (ceiling,
		// per-IP slot, invite) and never re-signed. A retry with the same keys
		// is answered from the chain by the pre-check above.
		if (err instanceof BroadcastOutcomeUnknownError) {
			log.error('create_outcome_unknown', { account: name, trx_id: err.txid }, err);
			countSpend();
			// Hand the kept per-IP slot to the same-name retry (A4).
			this.holdForRetry(spend);
			return c.json(
				{
					status: 'rejected',
					code: 'broadcast_outcome_unknown',
					message:
						'Blurt did not confirm in time whether your account was created. ' +
						'Wait a minute and try again with the same name — if it was created, you will be told so.'
				},
				503
			);
		}
		// D2 / wave 4 — two operators past the signed expiration show no such
		// account: it can never land. Nothing was spent; map the nodes'
		// stated reason (below) and release everything.
		let rawMsg = err instanceof Error ? err.message : String(err);
		if (err instanceof BroadcastNotLandedError) {
			rawMsg = err.cause_;
			if (!/insufficient|public key|invalid_pubkey|invalid_public_key/i.test(rawMsg)) {
				this.removeDedupeEntry(fingerprint);
				return c.json(
					{
						status: 'rejected',
						code: 'broadcast_failed',
						message: 'The Blurt network did not accept the transaction in time. Please try again.'
					},
					502
				);
			}
		}

		const lower = rawMsg.toLowerCase();

		// Map the remaining errors to stable response codes. (After a send,
		// the client only reports a rejection this way once two operators
		// confirmed the transaction can never land — BroadcastNotLandedError
		// above; raw errors here come from before anything was sent.)
		// The chain may also reject a name we passed availability on if another
		// actor claimed it between our pre-check and broadcast
		// (TOCTOU). Surface the same 'already_registered' code so
		// the user experience is consistent with the pre-check path.
		// (Our OWN earlier copy is never reported here: the client
		// resolves "exists with our owner key" as success.)
		if (
			lower.includes('already_registered') ||
			lower.includes('already exists') ||
			lower.includes('account_already_exists') ||
			lower.includes('uniqueness constraint')
		) {
			// Don't clear the dedupe entry — the name is genuinely
			// taken, so a retry with the same (name, keys) would
			// just hit the chain again with the same answer.  The
			// composite-key dedupe (Finding N3) means the user can
			// retry with a DIFFERENT name immediately.
			return c.json(
				{
					status: 'rejected',
					code: 'already_registered',
					message: `Account '${name}' was claimed by someone else in the last moment. Please try a different name.`
				},
				409
			);
		}
		// All other failure paths are chain REJECTIONS of our signed
		// transaction (nothing was spent): clear the dedupe entry so
		// legitimate retries within the 60-second window aren't blocked
		// (Finding N6).
		this.removeDedupeEntry(fingerprint);

		// Relay-out-of-funds path. With account_create the relay pays
		// the account_creation_fee inline, so when its liquid BLURT is
		// too low the chain rejects with an "insufficient balance"
		// error. The create endpoint already pre-gates on balance
		// (canAcceptCreation, above); this branch is belt-and-suspenders
		// for a balance that dipped between the health poll and the
		// broadcast.
		if (lower.includes('insufficient')) {
			return c.json(
				{
					status: 'rejected',
					code: 'relay_out_of_funds',
					message:
						'The relay is temporarily unable to fund new accounts. ' +
						'Please try again later.'
				},
				503
			);
		}
		if (
			lower.includes('invalid_public_key') ||
			lower.includes('invalid_pubkey') ||
			lower.includes('public key')
		) {
			return c.json(
				{
					status: 'rejected',
					code: 'invalid_pubkey',
					message: 'One of the provided public keys was rejected by the chain.'
				},
				400
			);
		}
		// Never echo the full error to the caller — it may contain
		// hex-encoded transaction bytes or other noise.
		return c.json(
			{
				status: 'rejected',
				code: 'broadcast_failed',
				message: 'The chain rejected the transaction.'
			},
			502
		);
	}

	private evictStaleDedupe(): void {
		const now = Date.now();
		let n = 0;
		for (const e of this.dedupe) {
			if (e.expiresAt > now) this.dedupe[n++] = e;
		}
		this.dedupe.length = n;
	}

	/** Drop any dedupe entry matching the given fingerprint.
	 *  Called from broadcast-failure paths so a legitimate retry
	 *  within the 60-second window isn't blocked (Finding N6).
	 *  In-place compaction matches evictStaleDedupe's style and
	 *  keeps the field's `readonly` array reference intact. */
	private removeDedupeEntry(fingerprint: string): void {
		let n = 0;
		for (const e of this.dedupe) {
			if (e.fingerprint !== fingerprint) this.dedupe[n++] = e;
		}
		this.dedupe.length = n;
	}
}

/** SHA-256 hex of a UTF-8 string. Uses Node's Web Crypto API
 *  (available since Node 20). */
async function sha256Hex(s: string): Promise<string> {
	const bytes = new TextEncoder().encode(s);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Maps each InviteTokenService verification failure code to a
 *  stable English message. The frontend localizes by code, so
 *  this is the fallback seen by clients (e.g. curl users) that
 *  don't do i18n mapping themselves. */
function inviteMessageFor(
	code:
		| 'invite_malformed'
		| 'invite_bad_signature'
		| 'invite_expired'
		| 'invite_ip_mismatch'
		| 'invite_already_used'
): string {
	switch (code) {
		case 'invite_malformed':
			return 'Invite token is malformed.';
		case 'invite_bad_signature':
			return 'Invite token signature is invalid.';
		case 'invite_expired':
			return 'Invite token has expired. Please request a new one.';
		case 'invite_ip_mismatch':
			return 'Invite token was issued to a different connection.';
		case 'invite_already_used':
			return 'Invite token has already been used.';
	}
}
