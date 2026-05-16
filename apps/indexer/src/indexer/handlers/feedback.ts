/**
 * Handler: morphit_feedback_v1
 *
 * Payload shape:
 *   {
 *     "subject": string (account name being reviewed),
 *     "rating": integer 1..5,
 *     "comment"?: string (0..256 code points, no control/bidi/ZWJ),
 *     "order_permlink"?: string (optional link to a specific order)
 *   }
 *
 * Effect: insert a feedback row. Uniqueness is enforced at the DB
 * level: one feedback per (reviewer, subject, order_permlink).
 * Self-reviews (subject == reviewer) are rejected.
 *
 * Comment length limit is 256 code points. Control characters
 * (C0/C1), bidi override marks (U+202A–202E, U+2066–2069), and
 * zero-width joiners (U+200B–200D, U+FEFF) are rejected — same
 * injection-resistant character policy as profile.ts display names.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { logger } from '$log';
import { localize, normalizeLocale } from '$indexer/pushLocalize';

const log = logger('feedback');

// Per Blurt's is_valid_account_name, account names are
// dot-separated multi-segment.  Canonicalized to match
// $api/shared.ts isAccountName — see REVISIT-LIST.md
// "C-19 follow-on consistency pass" for context.
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Max comment length in USER-PERCEIVED characters (code points).
 *  256 chars is the visual budget — feedback lines render as a
 *  compact row, and anything longer turns into a wall of text on
 *  mobile. The chain can carry more, but the user-facing contract
 *  is "one tweet's worth." */
const MAX_COMMENT_CODEPOINTS = 256;

/** Same forbidden-character class as profile.ts display names.
 *  Centralizing would be nicer, but since these handlers are
 *  deliberately self-contained, we accept one copy per use site. */
const FORBIDDEN_COMMENT_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Detect Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: unknown }).code === '23505'
	);
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) return { ok: false, reason: 'payload_not_object' };

	const subject = ctx.payload.subject;
	if (typeof subject !== 'string') return { ok: false, reason: 'subject_not_string' };
	if (!ACCOUNT_NAME_RE.test(subject)) return { ok: false, reason: 'subject_invalid' };
	if (subject === ctx.signer) return { ok: false, reason: 'self_review' };

	const rating = ctx.payload.rating;
	if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
		return { ok: false, reason: 'rating_out_of_range' };
	}

	let comment: string | null = null;
	if (ctx.payload.comment !== undefined && ctx.payload.comment !== null) {
		if (typeof ctx.payload.comment !== 'string') {
			return { ok: false, reason: 'comment_not_string' };
		}
		// O3.3 — NFC-normalize first so the codepoint-count check
		// reflects the user-perceived length.  Without this, a
		// chain-direct submitter can use NFD-decomposed forms to
		// exceed the visual length cap (e.g. 256 NFC chars
		// expressed as ~512 codepoints decomposed).  Low-impact
		// (the attacker only stretches their own comment), but
		// matches the hardening pattern of profile / operatorRegister.
		const normalized = ctx.payload.comment.normalize('NFC');
		// Code-point count (not UTF-16 units) so emoji aren't
		// double-counted. A 256-emoji comment is still 256 "chars"
		// from the user's perspective.
		if ([...normalized].length > MAX_COMMENT_CODEPOINTS) {
			return { ok: false, reason: 'comment_too_long' };
		}
		if (FORBIDDEN_COMMENT_CHARS.test(normalized)) {
			return { ok: false, reason: 'comment_forbidden_char' };
		}
		comment = normalized;
	}

	let orderPermlink: string | null = null;
	if (ctx.payload.order_permlink !== undefined && ctx.payload.order_permlink !== null) {
		if (typeof ctx.payload.order_permlink !== 'string') {
			return { ok: false, reason: 'order_permlink_not_string' };
		}
		// Length-check before regex.  The regex matches arbitrarily
		// long strings; running it on a multi-MB input wastes CPU.
		// Chain caps custom_json size upstream — defense-in-depth.
		if (ctx.payload.order_permlink.length > 32) {
			return { ok: false, reason: 'order_permlink_too_long' };
		}
		if (!PERMLINK_RE.test(ctx.payload.order_permlink)) {
			return { ok: false, reason: 'order_permlink_bad_chars' };
		}
		// Verify the cited order exists, was posted by the subject,
		// AND the listing fee was actually paid (fee_status =
		// 'verified').  Three-prong check:
		//
		// 1. EXISTS — Finding R17.  Without this, an attacker could
		//    spam many feedback rows by citing fake permlinks; each
		//    is unique by (reviewer, subject, order_permlink) so
		//    each becomes a row.
		//
		// 2. account = subject — same Finding R17.  Ties feedback
		//    to an order the subject actually offered, not a
		//    random other user's order.
		//
		// 3. fee_status = 'verified' — Part 113 (reputation audit,
		//    Vector A5/B2).  Pre-Part-113 reality: an attacker
		//    could broadcast a `morphit_order_v1` op with NO fee
		//    transfer (or an underpaid one) and the order would
		//    sit in `orders` with fee_status='missing' or
		//    'underpaid' but still be a valid citation target for
		//    feedback.  Cost of forging a citation target: just
		//    BLURT op-broadcast fees (sub-BLURT).  Cost of a
		//    PROPER citation target: the actual listing fee
		//    (~$0.25 in BLURT/BTC/XMR equivalent).  Requiring
		//    fee_status='verified' shifts the economics so that
		//    every fake-feedback row carries a non-trivial real-
		//    money cost.  ALSO closes the symmetric B2 vector
		//    (retaliatory 1-star citing an unpaid order).
		//
		// Note: we don't verify the reviewer was a counterparty on
		// the trade (impossible — Morphit's trade settlement is
		// off-chain).  This is the "the cited order is real,
		// belongs to the subject, AND the subject paid the
		// listing fee for it" defense, not the "this trade
		// actually happened" defense (which is structurally
		// undecidable on-chain).
		const orderCheck = await client.query(
			`SELECT 1 FROM orders
			  WHERE account = $1
			    AND permlink = $2
			    AND fee_status = 'verified'
			  LIMIT 1`,
			[subject, ctx.payload.order_permlink]
		);
		if (orderCheck.rowCount === 0) {
			return { ok: false, reason: 'order_permlink_not_found_or_unverified' };
		}
		orderPermlink = ctx.payload.order_permlink;
	}

	// ─── ADR-0014 verified-chat badge ────────────────────────────
	// Compute the badge boolean ONCE at intake using ctx.blockTime
	// as the cutoff so replay produces the same result.  Stored
	// directly on the feedback row (feedback.has_verified_chat,
	// schema-v26).  The badge is a UI signal in feedback rendering;
	// the boolean is also useful for aggregate "X% of trader's
	// feedback is verified-chat" computations on the profile page.
	//
	// Criteria (ALL must hold at ctx.blockTime):
	//   1. ≥2 chat_messages from reviewer to subject
	//   2. ≥2 chat_messages from subject to reviewer
	//   3. ≥15 minutes between earliest and latest pair message
	//   4. NO suspicious_reciprocity row for the canonicalized pair
	//
	// Single query because the four checks share scan-of-
	// chat_messages.  Uses chat_pair_idx (the existing
	// (LEAST(sender,recipient), GREATEST(...), created_at) index)
	// to keep this fast even on a chatty pair.
	//
	// Self-feedback already rejected upstream (line ~71); we don't
	// re-check the (reviewer != subject) invariant here.
	const conformance = await client.query<{
		from_reviewer: string;
		from_subject: string;
		span_seconds: string | null;
		has_recip_flag: boolean;
	}>(
		`SELECT
		   COUNT(*) FILTER (WHERE sender = $1 AND recipient = $2)
		     AS from_reviewer,
		   COUNT(*) FILTER (WHERE sender = $2 AND recipient = $1)
		     AS from_subject,
		   EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)))::text
		     AS span_seconds,
		   EXISTS (
		     SELECT 1 FROM suspicious_reciprocity sr
		      WHERE sr.account_a = LEAST($1::text, $2::text)
		        AND sr.account_b = GREATEST($1::text, $2::text)
		   ) AS has_recip_flag
		 FROM chat_messages
		 WHERE (
		         (sender = $1 AND recipient = $2)
		      OR (sender = $2 AND recipient = $1)
		     )
		   AND created_at <= $3`,
		[ctx.signer, subject, ctx.blockTime]
	);
	const c = conformance.rows[0]!;
	const fromReviewer = Number(c.from_reviewer);
	const fromSubject = Number(c.from_subject);
	const spanSec = c.span_seconds === null ? 0 : Number(c.span_seconds);
	const hasRecipFlag = c.has_recip_flag === true;
	const hasVerifiedChat =
		fromReviewer >= 2 &&
		fromSubject >= 2 &&
		Number.isFinite(spanSec) &&
		spanSec >= 15 * 60 &&
		!hasRecipFlag;

	try {
		await client.query(
			`INSERT INTO feedback (
				reviewer, subject, rating, comment, order_permlink,
				created_at, source_trx_id, has_verified_chat
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[
				ctx.signer,
				subject,
				rating,
				comment,
				orderPermlink,
				ctx.blockTime,
				ctx.trxId,
				hasVerifiedChat
			]
		);
	} catch (err) {
		if (isUniqueViolation(err)) {
			// Either the source_trx_id is duplicate (replay) or the
			// (reviewer, subject, order_permlink) triple is duplicate
			// (attempted double-review). Both are rejections, not
			// errors — the event log notes which.
			return { ok: false, reason: 'duplicate_feedback' };
		}
		throw err;
	}

	// ─── Web Push enqueue (Part 122 cp13; localized cp14) ───────
	// Enqueue a push notification for `subject` (the reviewed
	// account).  The relay's push-sender worker picks this up on
	// its next tick and fans out to all of subject's subscribed
	// devices.  Failure here is non-fatal: the feedback itself is
	// already recorded; missing a push notification is a UX
	// degradation, not a data loss.
	//
	// Localization (cp14): pick the recipient's most-recently-
	// subscribed device's locale (we MAX over created_at so a
	// user switching languages gets new notifications in their
	// new language without losing existing subscriptions).  No
	// matching row → 'en'.  See pushLocalize.ts for the
	// translation table.
	try {
		const localeRow = await client.query<{ locale: string }>(
			`SELECT locale FROM push_subscriptions
			  WHERE account = $1
			  ORDER BY created_at DESC
			  LIMIT 1`,
			[subject]
		);
		const locale = normalizeLocale(localeRow.rows[0]?.locale);
		const titleStr = localize(locale, 'feedback_title');
		const bodyStr =
			rating === 1
				? localize(locale, 'feedback_body_one', ctx.signer, String(rating))
				: localize(locale, 'feedback_body_many', ctx.signer, String(rating));
		await client.query(
			`INSERT INTO push_pending
			   (account, category, title, body, click_path, event_at)
			 VALUES ($1, 'feedback', $2, $3, $4, $5)`,
			[
				subject,
				titleStr,
				bodyStr,
				`/profile/${subject}#feedback`,
				ctx.blockTime
			]
		);
	} catch (err) {
		// Non-fatal — log and continue.  The feedback row is
		// already in.  push_pending failure most likely means the
		// table doesn't exist yet (older indexer DB).
		log.warn('push_enqueue_failed', {
			subject,
			err: String((err as Error)?.message ?? err)
		});
	}

	// ─── ADR-0011 §8: delayed welcome bonus ───────────────────────
	// Feedback submission IS the "trade completed" signal — but
	// only when the feedback cites a specific order owned by the
	// subject.  Without that gate, a Sybil pair could sign mutual
	// positive feedback (no order_permlink) and each extract the
	// 10 BLURT + 10 BP bonus.  The signup invite gates and global
	// daily ceiling deter mass signups, and at the current chain
	// account-creation fee (100 BLURT, read dynamically from
	// condenser_api.get_chain_properties by the relay) the per-
	// pair math is net-negative for the attacker — they spend
	// 200 BLURT in chain fees per pair to extract 20 BLURT + 20
	// BP in bonuses.  The chain fee is witness-controlled,
	// though, and could change in the future; tying the bonus
	// to a real order makes the defense hold regardless of where
	// the fee lands.  Defense-in-depth against fee changes,
	// future bonus increases, and griefing.
	//
	// Requiring `order_permlink` ties the bonus trigger to a real
	// order on the index.  The order_permlink check upstream (in
	// the validation block above) verified that the permlink
	// exists AND was posted by the subject; here we require it to
	// be present at all.
	//
	// Feedback without order_permlink still goes through — there
	// are legitimate use cases (chat-only first contact, post-
	// reputation general feedback).  It just doesn't trigger the
	// welcome bonus.  The FAQ for `welcome_bonus` correctly
	// describes the full path: post an order, complete the trade,
	// counterparty signs feedback citing the order.
	//
	// When the subject (the account being reviewed) has never had
	// a trade marked complete AND this feedback cites a real order
	// owned by them, this is their first.  We atomically flip
	// their first_trade_complete_at and queue two transfers for
	// the relay to broadcast: 10 BLURT liquid + 10 BLURT vesting
	// (which powers up as BP in the recipient's account).
	//
	// Atomic guard: INSERT ... ON CONFLICT DO UPDATE ... WHERE
	// first_trade_complete_at IS NULL returns rowCount=1 iff this
	// is the winning claim — either we created a brand-new row
	// (no prior accounts entry) or we updated an existing row
	// whose first_trade_complete_at was NULL.  rowCount=0 means
	// the row already had a non-NULL first_trade_complete_at —
	// queueing another bonus would be double-rewarding, skip.
	//
	// Why upsert (not just UPDATE): some Morphit users have Blurt
	// accounts predating the indexer's startBlock OR created via
	// channels other than Morphit's relay (blurt-cli, other apps,
	// etc.).  They have no accounts row yet.  A bare UPDATE would
	// return rowCount=0 and the bonus would be silently skipped —
	// inconsistent with the FAQ promise that every account
	// completing a first trade gets the bonus, and inconsistent
	// with the order handler's waived_first_buy path which does
	// the same upsert.  Placeholder values for creator/block_num/
	// trx_id match the order handler's pattern; future cleanup
	// could backfill from chain history.
	//
	// Failure isolation: the welcome bonus is a non-consensus,
	// user-benefit concern. A failure here must not poison the
	// feedback op's transaction state. We open a nested savepoint
	// and roll it back on failure — the feedback INSERT above
	// survives because it's outside this savepoint.
	if (orderPermlink === null) {
		// No order cited — feedback row stays committed, but no
		// bonus trigger.  Skip the savepoint dance entirely.
		return { ok: true };
	}
	const bonusSavepoint = 'welcome_bonus_sp';
	await client.query(`SAVEPOINT ${bonusSavepoint}`);
	try {
		// Part 111 — look up the cited order's operator_tag to decide
		// whether THIS instance is the one obligated for the welcome
		// bonus.  If the cited order was attributed to a different
		// operator's instance (or to no operator), THIS indexer still
		// records first_trade_complete_at (global state — kept
		// consistent across the federation so other indexers see the
		// same "this user did their first trade" verdict), but skips
		// the queue insert (only the named operator pays).
		//
		// If the cited order doesn't exist in our orders table at all
		// (e.g. we missed its block, or the order was on a different
		// account), `cited` returns rowCount=0 → treated as "not our
		// instance," no bonus queued.  Conservative.
		const cited = await client.query<{ operator_tag: string | null }>(
			`SELECT operator_tag FROM orders
			  WHERE account = $1 AND permlink = $2`,
			[subject, orderPermlink]
		);
		const citedOperatorTag =
			cited.rowCount && cited.rowCount > 0 ? cited.rows[0]!.operator_tag : null;
		const isOurInstance =
			ctx.config.instanceOperatorTag !== undefined &&
			citedOperatorTag !== null &&
			citedOperatorTag === ctx.config.instanceOperatorTag;

		const claimed = await client.query(
			`INSERT INTO accounts (
				name, creator, created_block_num, created_block_time,
				created_trx_id, first_trade_complete_at
			) VALUES ($1, '', 0, $2, '', $2)
			ON CONFLICT (name) DO UPDATE
				SET first_trade_complete_at = EXCLUDED.first_trade_complete_at
				WHERE accounts.first_trade_complete_at IS NULL
			RETURNING name`,
			[subject, ctx.blockTime]
		);
		if ((claimed.rowCount ?? 0) > 0 && isOurInstance) {
			// Queue the two transfers. Same timestamp for both so
			// an operator reading the queue sees them as a unit.
			//
			// Part 111: gated on isOurInstance — see above.
			await client.query(
				`INSERT INTO relay_pending_transfers
				   (recipient, kind, amount_blurt, reason, created_at)
				 VALUES
				   ($1, 'liquid',  10, 'welcome_bonus_liquid',  $2),
				   ($1, 'vesting', 10, 'welcome_bonus_vesting', $2)`,
				[subject, ctx.blockTime]
			);
		} else if ((claimed.rowCount ?? 0) > 0 && !isOurInstance) {
			// Part 112 hardening — record the skip so operators
			// have an audit trail.  This branch fires when:
			// the user genuinely just completed their first trade
			// (accounts row flipped), AND that trade was attributed
			// to a different operator's instance (or no operator).
			// Welcome bonus belongs to the named operator, not us.
			// All fields are public chain data — no PII.
			log.info('welcome_bonus_skipped_other_instance', {
				reason: citedOperatorTag === null ? 'cited_order_no_tag' : 'cited_order_tag_mismatch',
				subject,
				order_permlink: orderPermlink,
				cited_operator_tag: citedOperatorTag,
				our_tag: ctx.config.instanceOperatorTag ?? null,
				trx_id: ctx.trxId,
				block_num: ctx.blockNum
			});
		}
		await client.query(`RELEASE SAVEPOINT ${bonusSavepoint}`);
	} catch (err) {
		// Roll back just the welcome-bonus work. The feedback INSERT
		// above stays committed in the outer transaction.
		await client.query(`ROLLBACK TO SAVEPOINT ${bonusSavepoint}`);
		log.error('welcome_bonus_trigger_failed', { subject }, err);
	}

	return { ok: true };
};

export default handle;
