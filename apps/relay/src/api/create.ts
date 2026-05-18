/**
 * Morphit relay — account creation endpoint.
 *
 * Second half of the two-step signup protocol. Accepts an
 * invite token (see policy/inviteToken.ts) and an unsigned
 * account-creation op body, validates, wraps in a transaction
 * signed with the relay's own active key, and broadcasts as a
 * fee-free `create_claimed_account` consuming one pre-minted ACT
 * from the relay's pool (the chain's BLURT fee was paid earlier
 * at ACT-minting time via the weekly `claim_account` ceremony —
 * see ADR-0010 §4 and docs/OPERATIONS.md §2).  Returns the chain's
 * confirmation.
 *
 * Anti-abuse checks, in order:
 *   1. Kill-switch (MORPHIT_RELAY_SIGNUP_ENABLED).
 *   2. Global daily ceiling (caps worst-case drain).
 *   3. Per-IP spacing via allowWithSpacing (≥N minutes
 *      between this IP's signups, in addition to the daily
 *      cap).
 *   4. Invite token verification (server-side HMAC signature,
 *      non-expired, IP-bound, single-use).
 *   5. Shape/name/pubkey validation.
 *   6. Dedup check for accidental double-submit.
 *   7. Availability check against the chain.
 *   8. Broadcast the signed op.
 *   9. On success: consume the invite (marks it used), record
 *      against the global ceiling.
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

import type { BlurtClient } from '../blurt/client.ts';
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
 *  json_metadata) that the relay will broadcast as a fee-free
 *  `create_claimed_account` (NOT classical `account_create` — the
 *  ACT-pool model means the relay consumes a pre-minted token at
 *  this point, not BLURT).  `invite_token` is the signed invite
 *  obtained from the /v1/account/invite endpoint. */
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
interface DedupeEntry {
	fingerprint: string;
	expiresAt: number;
}

export class CreateEndpoint {
	private readonly dedupe: DedupeEntry[] = [];
	private readonly dedupeWindowMs = 60_000;

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
			return await this.handleWithReservation(c, () => {
				reservationFinalized = true;
			});
		} finally {
			if (!reservationFinalized) {
				this.ceiling.releaseReservation();
			}
		}
	}

	/** Inner handle body — called within a reservation-tracking
	 *  try/finally in handle().  Calls finalize() exactly once on
	 *  the success path so the outer finally knows not to release. */
	private async handleWithReservation(c: Context, finalize: () => void): Promise<Response> {
		const ip = clientIp(c);
		// Rate-limit bucket key: collapse IPv6 /64 and IPv4 /24
		// prefixes into single buckets so an attacker with a
		// /64 prefix budget (2^64 source addrs) doesn't trivially
		// bypass per-IP limits.  See `canonicalBucketKey` doc for
		// the privacy/legitimate-NAT-user tradeoff rationale.
		const bucketKey = canonicalBucketKey(ip);
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
		// Per-IP daily cap WITH spacing: "≤N per day AND the
		// most recent one was ≥M minutes ago."  PEEK-only here —
		// the daily cap (default 2/day) and 60-min spacing are
		// painful for legitimate users iterating through username
		// candidates that turn out to be already-registered on
		// Blurt.  We commit a slot only when the chain actually
		// accepts the account creation (success path) or returns
		// duplicate-after-retry (chain confirmed our prior
		// broadcast).  TOCTOU `already_registered` and pre-broadcast
		// rejections (validation, out-of-funds, name-taken) do NOT
		// commit, so a user finding their preferred username can
		// keep trying until they hit one that's free.
		const dailyDecision = this.dailyLimiter.peekWithSpacing(
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
		let existing;
		try {
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
		// If broadcast fails partway (e.g. timeout with chain accepting
		// the tx), we don't want a legitimate retry to create a second
		// account. Dedupe expires after one minute, which is shorter
		// than Blurt's transaction expiration window, so a successful
		// chain record always outlives the dedupe entry.
		this.dedupe.push({
			fingerprint,
			expiresAt: Date.now() + this.dedupeWindowMs
		});

		// ── Sign + broadcast ─────────────────────────────────────────
		// Per ADR-0010 §4: the relay consumes a pre-minted ACT
		// (via create_claimed_account) rather than paying the
		// inline account_creation_fee.  ACTs are minted in the
		// weekly mint-acts.ts ceremony.
		try {
			const confirmation = await this.blurt.broadcastAccountCreate({
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

			// ── Post-broadcast bookkeeping ───────────────────────────
			// The chain confirmed the account, so: (1) mark the
			// invite consumed so it can't be replayed, (2) tick the
			// global ceiling counter so we track total signups
			// against the daily cap, (3) commit the per-IP burst +
			// daily rate-limiter slots — these were peeked at the
			// top of the handler and only get committed here, so
			// users who iterate through several already-taken
			// usernames don't burn quota on the failed lookups.
			// Failures here can't undo the chain record, so we do
			// them defensively and log but don't fail the response.
			try {
				this.inviteTokens.consume(invitePayload);
			} catch (consumeErr) {
				log.error('invite_consume_failed', { account: name }, consumeErr);
			}
			try {
				// Hourly burst limiter was consumed at handler entry
				// (every attempt costs the burst slot).  The daily
				// limiter was peeked at handler entry; commit it now
				// that the chain has accepted our broadcast — see
				// peek-vs-commit rationale at the top of the handler.
				this.dailyLimiter.commit(bucketKey);
			} catch (limErr) {
				log.error('limiter_commit_failed', { account: name }, limErr);
			}
			try {
				this.ceiling.recordSuccess();
				// Mark the reservation finalized so the outer
				// finally won't ALSO call releaseReservation() and
				// double-decrement.  recordSuccess() already
				// decremented reservedCount internally.
				finalize();
			} catch (ceilErr) {
				log.error('ceiling_record_failed', { account: name }, ceilErr);
				// recordSuccess threw — defensive: if it threw
				// AFTER the internal decrement, we'd double-release
				// in the finally; if it threw BEFORE, the finally's
				// release is correct.  We can't tell from here.
				// recordSuccess as written above doesn't throw on
				// any normal path (saveToDisk catches its own
				// errors), so this catch is for unexpected JS-level
				// errors — accept the small accounting risk over
				// the larger risk of leaking the chain-success.
				// Mark finalized to err on the side of NOT
				// double-releasing: the broadcast already happened,
				// so the count needs to reflect that.  Worst case
				// we leak one slot for the day.
				finalize();
			}

			// ── ADR-0010 §2 step 4: 1 BLURT signup dust ──────────────
			// Send a small dust balance so the fresh account can pay
			// chain bandwidth for its first few ops (post a Morphit
			// order, submit feedback, etc.). Failure here is
			// non-fatal — the account already exists on-chain; Blurt
			// gives new accounts enough RC for a handful of ops even
			// without a BLURT balance, and the low-balance auto-
			// refill (ADR-0010 §3) will catch this account on its
			// next tick. We log and return success regardless.
			try {
				await this.blurt.broadcastTransfer({
					from: this.cfg.relayAccount,
					fromActiveWif: this.cfg.relayActiveKeyWif,
					to: name,
					amountBlurt: 1,
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
				trx_id: confirmation.id
			});
		} catch (err) {
			const rawMsg = err instanceof Error ? err.message : String(err);
			const lower = rawMsg.toLowerCase();

			// Duplicate-transaction path — the failure mode that arises
			// when callWithRotation retried after a transport timeout but
			// the FIRST broadcast actually landed.  The chain rejects the
			// retry with a "duplicate transaction" / "already in blockchain"
			// error.  This means our account WAS created; the right
			// response is to surface the success rather than mislead the
			// user with a generic broadcast_failed.
			//
			// The signed trx_id is deterministic from the signed bytes,
			// so even though we don't have it directly from the failed
			// broadcast, we can verify by looking up the new account on-
			// chain — if it exists with the keys we just signed for,
			// the prior broadcast succeeded.
			if (
				lower.includes('duplicate transaction') ||
				lower.includes('already in blockchain') ||
				lower.includes('tx_duplicate') ||
				lower.includes('tapos_check.cpp')
			) {
				try {
					const onChain = await this.blurt.getAccount(name);
					if (onChain) {
						// Account exists.  Return a success-shaped response.
						// We don't have the original trx_id from the lost
						// broadcast response; the frontend treats trx_id
						// as opaque so an empty string is acceptable.  Log
						// at info level so the operator can see retry-
						// after-success events in their access log.
						//
						// This is a successful signup (the chain accepted
						// our broadcast), so commit the per-IP limiter
						// slots that were peeked at handler entry.  See
						// the matching block in the success path above
						// for rationale.
						try {
							this.dailyLimiter.commit(bucketKey);
						} catch (limErr) {
							log.error('limiter_commit_failed_dup_retry', { account: name }, limErr);
						}
						return c.json({
							status: 'broadcast',
							block_num: 0,
							trx_id: '',
							note: 'duplicate_after_retry'
						});
					}
				} catch {
					// Account-lookup failed too — fall through to the
					// generic error below.  The user can retry with the
					// same fingerprint within the dedupe window.
				}
			}

			// Map chain-level errors to stable response codes. The chain
			// may also reject a name we passed availability on if another
			// actor claimed it between our pre-check and broadcast
			// (TOCTOU). Surface the same 'already_registered' code so
			// the user experience is consistent with the pre-check path.
			if (
				lower.includes('already_registered') ||
				lower.includes('already exists') ||
				lower.includes('account_already_exists')
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
			// All other failure paths: clear the dedupe entry so
			// legitimate retries within the 60-second window aren't
			// blocked (Finding N6).  The chain enforces account-name
			// uniqueness, so even if a retry submits the same
			// (name, keys), the second create will be rejected at
			// the chain level if the first actually landed.
			this.removeDedupeEntry(fingerprint);

			// Out-of-ACTs path. The chain returns a "pending_claimed_accounts"
			// error (or "insufficient" in some node implementations) when
			// the relay's claimed-account pool is exhausted.  Operators
			// refill via the weekly mint-acts.ts ceremony.  Surface a
			// stable code so the frontend can show "signups paused
			// while the operator refills" rather than a generic
			// chain-rejected message.
			if (lower.includes('pending_claimed_accounts') || lower.includes('insufficient')) {
				return c.json(
					{
						status: 'rejected',
						code: 'relay_out_of_funds',
						message:
							'The relay is temporarily unable to fund new accounts. ' +
							'The operator needs to mint more Account Creation Tokens.'
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
