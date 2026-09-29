/**
 * External (BTC/XMR) listing-fee re-check (v1.18.0 deep-deep, H1).
 *
 * What was wrong: a BTC/XMR order was verified exactly once, when its order op
 * was indexed. If the explorers were unreachable (or disagreed) it landed as
 * `pending_external` and NOTHING ever looked at it again — the only way out was
 * the attestation path, which the red team showed could be satisfied by the
 * poster plus one sock for a txid that does not exist. Legitimate payers whose
 * explorers were briefly down were stranded the same way.
 *
 * This job periodically re-runs the SAME verifier the order handler uses on:
 *   - live `pending_external` orders,
 *   - live `verified_by_attestation` orders (attestation is only the fallback
 *     for "the explorers could not answer" — once they can, their answer wins),
 *   - live `missing` orders less than MISSING_RECHECK_HOURS old (a txid that a
 *     quorum of explorers 404'd at intake, e.g. a payment still propagating).
 *
 * The verdict is a pure function of (explorer answer, chain-derived rows):
 *
 *   explorer verified            → 'verified'
 *   explorer underpaid           → 'underpaid'
 *   explorer rejected otherwise  → 'missing'   (e.g. a quorum answered 404)
 *   explorer has no answer       → attestation quorum met  ? 'verified_by_attestation'
 *                                                          : 'pending_external'
 *                                  (a 'missing' row with no answer stays 'missing')
 *
 * so every instance re-checking the same order from the same chain data and the
 * same explorer answers reaches the same status. The attestation quorum is the
 * shared $indexer/fee/attestationQuorum rule, so rows promoted under the old
 * "poster counts" rule are re-derived under the current one.
 *
 * Only `fee_status` (and `updated_at`, so the orderbook-stream fallback poll
 * sees the flip) changes; the order row itself is untouched. `reused` rows are
 * never touched (they carry no external_tx_id).
 *
 * (v1.20.0 fix wave, G3) Fair scheduling. The pass used to take the OLDEST
 * candidates first (ORDER BY created_at ASC), 25 per run with a 30-minute
 * per-order spacing, so it only ever cycled the oldest ~75 rows: ~75 fake
 * orders (a made-up txid costs nothing but Blurt RC) starved every real
 * payer's order forever. A first fix kept the schedule in process memory and
 * still starved a real payer under a steady flood (fresh fakes sorted first)
 * or a 2000-row burst (the real order fell out of the candidate window). Now
 * the whole selection is SQL over persisted state:
 *   - `orders.fee_rechecked_at` (migration v63) records the last check, so
 *     the spacing and the rotation survive restarts and need no candidate
 *     window;
 *   - candidates are taken LONGEST-WAITING first — waiting since the last
 *     check, or since posting if never re-checked — so a fresh fake never
 *     jumps a real order that has been waiting longer;
 *   - each ACCOUNT gets at most PER_ACCOUNT_PER_PASS turns per pass, taken in
 *     rounds (every account's 1st candidate before anyone's 2nd), so one
 *     account's flood can take only its own share;
 *   - at most MISSING_PER_PASS `missing` rows (a quorum of explorers already
 *     said "no such tx") compete per pass, after live-but-unanswered rows of
 *     the same round;
 *   - expired orders are skipped (expiry is read-time; status stays 'live');
 *     `pending_external` rows older than PENDING_RECHECK_DAYS are dropped (a
 *     real payment confirms within hours); attested rows stay in rotation
 *     until they expire, so explorers can still overrule an attestation.
 *
 * (v1.20.0, MK-H2) Per-order BTC fee addresses. Once the treasury xpub is
 * pinned, a BTC order carries no txid: it is posted `awaiting_payment` with
 * its own address (orders.btc_fee_address). This loop is what watches those
 * addresses, through the verifier's checkAddressPayment (the same explorer
 * set and quorum as the txid path; onion explorers on hidden-only nodes):
 *
 *   address paid (confirmed ≥ amount)  → 'verified'
 *   less / nothing confirmed yet       → stays 'awaiting_payment'; the seen
 *                                        confirmed and unconfirmed totals are
 *                                        stored so the payer's page can say
 *                                        "received" / "on its way"
 *   explorers give no answer           → unchanged (never attestation: the
 *                                        address needs none)
 *
 * The amount asked for is the lower of the amount quoted when the order was
 * posted (btc_fee_sats, the pin in force at its block) and today's pin, like
 * G9 below. Awaiting rows share the fair rotation above; they are checked on
 * the normal spacing for PENDING_RECHECK_DAYS, then at most once a day up to
 * AWAITING_RECHECK_DAYS (a late payer is still credited), then no more.
 */

import type { Database } from '$db/pool';
import type { FeeVerifier } from '$indexer/fee/verifier';
import { attestationQuorumMet } from '$indexer/fee/attestationQuorum';
import { xmrBindingOfRow, type XmrBinding } from '$indexer/fee/xmrBinding';
import { logger } from '$log';

const log = logger('fee-recheck');

/** How long after posting a `missing` BTC/XMR order is still re-checked. */
export const MISSING_RECHECK_HOURS = 24;
/** (G3) How long after posting a `pending_external` order is still re-checked. */
export const PENDING_RECHECK_DAYS = 7;
/** (G3) Most re-checks one ACCOUNT's orders get in a single pass. */
export const PER_ACCOUNT_PER_PASS = 3;
/** (G3) Most `missing` rows re-checked in a single pass. */
export const MISSING_PER_PASS = 10;
/** (MK-H2) How long after posting an `awaiting_payment` address is watched. */
export const AWAITING_RECHECK_DAYS = 90;
/** (MK-H2) Spacing between checks of an awaiting address past PENDING_RECHECK_DAYS. */
export const AWAITING_SLOW_SPACING_MS = 24 * 60 * 60 * 1000;
/** Default upper bound on verifier calls per run (explorer rate limits). */
export const DEFAULT_RECHECK_BATCH = 25;
/** How often the poller runs a re-check pass. */
export const RECHECK_INTERVAL_MS = 10 * 60 * 1000;
/** Minimum spacing between two re-checks of the same order. */
export const PER_ORDER_MIN_SPACING_MS = 30 * 60 * 1000;

export interface ExternalFeeRecheckDeps {
	readonly db: Database;
	readonly verifiers: { readonly btc?: FeeVerifier; readonly xmr?: FeeVerifier };
	readonly amounts: { readonly btcSatoshis?: number; readonly xmrPiconero?: bigint };
	/** Reference time for the `missing` window. */
	readonly now: Date;
	/** Max verifier calls this run. */
	readonly limit?: number;

	/** Called for every order whose fee_status changed. */
	readonly onChange?: (orderId: string) => void;
	/** Called for every order actually checked (for spacing bookkeeping). */
	readonly onChecked?: (orderId: string) => void;
}

interface Candidate {
	account: string;
	permlink: string;
	fee_status: string;
	fee_method: 'btc' | 'xmr';
	external_tx_id: string | null;
	tx_proof: string | null;
	/** (MK-H2) Set for per-order-address BTC rows (then external_tx_id is NULL). */
	btc_fee_address: string | null;
	btc_fee_sats: string | null;
	btc_fee_received_sats: string | null;
	btc_fee_unconfirmed_sats: string | null;
	/** (M-X1) XMR: the payer's tx key; null for legacy OutProof rows. */
	xmr_tx_key?: string | null;
	/** (MK-H2) Bound XMR rows: payment ID + integrated address paid. */
	xmr_payment_id?: string | null;
	xmr_fee_address?: string | null;
	/** (G9) The treasury block of the newest valid release at or before the
	 *  order's creation — the pin that was in force when it was posted. */
	pin_at_post?: {
		btc?: { satoshis?: unknown } | null;
		xmr?: { piconero?: unknown } | null;
	} | null;
}

/**
 * (v1.20.0 fix wave, G9) The amount to verify against: the LOWER of today's
 * pin and the pin in force when the order was posted. A payer who paid the
 * quoted amount must not be flipped to `underpaid` because the maintainer
 * re-pinned a higher amount (the coin fell) while the order was still
 * pending. Both pins are chain data, so every instance derives the same
 * value; the lower bound can never be below what the payer was quoted.
 */
function expectedFor(
	row: Candidate,
	current: number | bigint | undefined
): number | bigint | undefined {
	if (current === undefined) return undefined;
	const pin = row.pin_at_post;
	if (row.fee_method === 'btc' && typeof current === 'number') {
		const then = pin?.btc?.satoshis;
		return typeof then === 'number' && Number.isSafeInteger(then) && then > 0 && then < current
			? then
			: current;
	}
	if (row.fee_method === 'xmr' && typeof current === 'bigint') {
		const raw = pin?.xmr?.piconero;
		if (typeof raw === 'string' && /^[0-9]{1,30}$/.test(raw)) {
			const then = BigInt(raw);
			if (then > 0n && then < current) return then;
		}
	}
	return current;
}

type Next = 'verified' | 'underpaid' | 'missing' | 'verified_by_attestation' | 'pending_external';

/** One re-check pass. Never throws for a single order's failure. */
export async function recheckExternalFees(
	deps: ExternalFeeRecheckDeps
): Promise<{ checked: number; changed: number }> {
	const limit = deps.limit ?? DEFAULT_RECHECK_BATCH;
	const missingCutoff = new Date(deps.now.getTime() - MISSING_RECHECK_HOURS * 3600 * 1000);
	const pendingCutoff = new Date(deps.now.getTime() - PENDING_RECHECK_DAYS * 86_400_000);
	const spacingCutoff = new Date(deps.now.getTime() - PER_ORDER_MIN_SPACING_MS);
	// (G3) Fair selection, entirely in SQL over persisted state — see the
	// module header. acct_turn = this row's turn within its account (longest-
	// waiting first); miss_turn = its turn among all `missing` rows.
	const res = await deps.db.query<Candidate>(
		`WITH cand AS (
		   SELECT account, permlink, fee_status, fee_method, external_tx_id, tx_proof,
		          btc_fee_address, btc_fee_sats::text, btc_fee_received_sats::text,
		          btc_fee_unconfirmed_sats::text, xmr_tx_key, xmr_payment_id, xmr_fee_address,
		          created_at, COALESCE(fee_rechecked_at, created_at) AS waiting_since,
		          ROW_NUMBER() OVER (
		            PARTITION BY account
		            ORDER BY COALESCE(fee_rechecked_at, created_at) ASC, permlink ASC
		          ) AS acct_turn,
		          ROW_NUMBER() OVER (
		            PARTITION BY (fee_status = 'missing')
		            ORDER BY COALESCE(fee_rechecked_at, created_at) ASC, account ASC, permlink ASC
		          ) AS miss_turn
		     FROM orders
		    WHERE status = 'live'
		      AND (expires_at IS NULL OR expires_at > $2)
		      AND fee_method IN ('btc', 'xmr')
		      AND external_tx_id IS NOT NULL
		      AND ((fee_status = 'pending_external' AND created_at >= $3)
		           OR fee_status = 'verified_by_attestation'
		           OR (fee_status = 'missing' AND created_at >= $1))
		      AND (fee_rechecked_at IS NULL OR fee_rechecked_at <= $4)
		 )
		 SELECT c.account, c.permlink, c.fee_status, c.fee_method, c.external_tx_id, c.tx_proof,
		        c.btc_fee_address, c.btc_fee_sats, c.btc_fee_received_sats, c.btc_fee_unconfirmed_sats,
		        c.xmr_tx_key, c.xmr_payment_id, c.xmr_fee_address,
		        (SELECT r.treasury FROM releases r
		          WHERE r.valid = true AND r.treasury IS NOT NULL
		            AND r.created_at <= c.created_at
		          ORDER BY r.created_at DESC LIMIT 1) AS pin_at_post
		   FROM cand c
		  WHERE c.acct_turn <= $5
		    AND (c.fee_status <> 'missing' OR c.miss_turn <= $6)
		  ORDER BY c.acct_turn ASC, (c.fee_status = 'missing') ASC, c.waiting_since ASC,
		           c.account ASC, c.permlink ASC
		  LIMIT $7`,
		[
			missingCutoff,
			deps.now,
			pendingCutoff,
			spacingCutoff,
			PER_ACCOUNT_PER_PASS,
			MISSING_PER_PASS,
			// Rows whose method is no longer configured are skipped below, so
			// read a little past the batch.
			limit * 2
		]
	);

	let checked = 0;
	let changed = 0;
	for (const row of res.rows) {
		if (checked >= limit) break;
		const orderId = `${row.account}/${row.permlink}`;
		if (typeof row.external_tx_id !== 'string') continue;
		// (M-X1) An XMR row can only be proven with its tx key; a legacy
		// OutProof row has none and is never asked about (v65 marks those
		// `proof_unsupported`; this is the belt to that brace).
		let xmrBinding: XmrBinding | null = null;
		if (row.fee_method === 'xmr') {
			if (typeof row.xmr_tx_key !== 'string') continue;
			if (typeof row.xmr_payment_id === 'string') {
				xmrBinding =
					typeof row.xmr_fee_address === 'string'
						? xmrBindingOfRow(row.xmr_fee_address, row.xmr_payment_id, row.account, row.permlink)
						: null;
				// A bound row whose binding cannot be rebuilt is never checked
				// unbound (that would re-open the copied-txid hole).
				if (xmrBinding === null) continue;
			}
		}
		const verifier = row.fee_method === 'btc' ? deps.verifiers.btc : deps.verifiers.xmr;
		const expected = expectedFor(
			row,
			row.fee_method === 'btc' ? deps.amounts.btcSatoshis : deps.amounts.xmrPiconero
		);
		// Method no longer configured here: nothing to ask, leave the row as is.
		if (verifier === undefined || expected === undefined || expected === 0 || expected === 0n) {
			continue;
		}
		checked++;
		deps.onChecked?.(orderId);
		try {
			// (G3) Persist the attempt BEFORE asking, so a verifier that throws
			// or hangs still moves this row to the back of the queue. Never
			// touches updated_at (the orderbook stream polls it).
			await deps.db.query(
				`UPDATE orders SET fee_rechecked_at = $3 WHERE account = $1 AND permlink = $2`,
				[row.account, row.permlink, deps.now]
			);
			const result = await verifier.verify({
				feeMethod: row.fee_method,
				expectedAmount: expected,
				externalTxId: row.external_tx_id,
				txProof: row.tx_proof,
				...(row.fee_method === 'xmr' ? { txKey: row.xmr_tx_key ?? null, xmrBinding } : {}),
				permlink: row.permlink,
				signer: row.account
			});
			let next: Next;
			if (result.kind === 'verified') {
				next = 'verified';
			} else if (result.kind === 'rejected') {
				// Same mapping as the order handler at intake.
				next = result.reason.startsWith('underpaid') ? 'underpaid' : 'missing';
			} else if (row.fee_status === 'missing') {
				// No answer now does not overturn an earlier definitive "not found".
				continue;
			} else if (xmrBinding !== null) {
				// (MK-H2) A bound payment is proven by the chain + explorers or
				// not at all: sock-puppet attestations must not stand in for
				// the payment-ID check.
				next = 'pending_external';
			} else {
				next = (await attestationQuorumMet(deps.db, row.account, row.permlink))
					? 'verified_by_attestation'
					: 'pending_external';
			}
			if (next === row.fee_status) continue;
			const upd = await deps.db.query(
				`UPDATE orders SET fee_status = $3, updated_at = NOW()
				  WHERE account = $1 AND permlink = $2 AND fee_status = $4 AND status = 'live'`,
				[row.account, row.permlink, next, row.fee_status]
			);
			if ((upd.rowCount ?? 0) > 0) {
				changed++;
				log.info('fee_status_rechecked', {
					order: orderId,
					from: row.fee_status,
					to: next,
					reason: result.kind === 'verified' ? 'explorer_verified' : result.reason
				});
				deps.onChange?.(orderId);
			}
		} catch (err) {
			log.warn('fee_recheck_failed', { order: orderId }, err);
		}
	}
	// (MK-H2, V3-3) Per-order BTC fee addresses: their own budget.
	const addr = await recheckFeeAddresses(deps);
	return { checked: checked + addr.checked, changed: changed + addr.changed };
}

/** (V3-3) Address checks per pass — separate from the txid budget above. */
export const ADDRESS_CHECKS_PER_PASS = 40;
/** (V3-3) An address where money was seen is looked at again after this. */
export const ADDRESS_ACTIVE_SPACING_MS = 2 * 60 * 1000;
/** (V3-3) Bounds of the back-off for an address with no money seen: half the
 *  order's age at the last look, at least this … */
export const ADDRESS_IDLE_MIN_SPACING_MS = 5 * 60 * 1000;
/** … and at most this (AWAITING_SLOW_SPACING_MS once past PENDING_RECHECK_DAYS). */
export const ADDRESS_IDLE_MAX_SPACING_MS = 12 * 60 * 60 * 1000;
/** (V3-3) "Check my payment now": at most once per order per this long. */
export const FEE_CHECK_NOW_COOLDOWN_MS = 60 * 1000;

interface AddressRow {
	account: string;
	permlink: string;
	fee_status: string;
	btc_fee_address: string;
	btc_fee_sats: string | null;
	btc_fee_received_sats: string | null;
	btc_fee_unconfirmed_sats: string | null;
}

/** What to ask for: the lower of the amount quoted at posting (the pin in
 *  force at the order's block) and today's pin (G9). */
function addressExpected(row: AddressRow, today: number | undefined): number | null {
	const posted = Number(row.btc_fee_sats);
	if (!Number.isSafeInteger(posted) || posted <= 0) return null;
	return typeof today === 'number' && Number.isSafeInteger(today) && today > 0 && today < posted
		? today
		: posted;
}

/** Ask the explorers about one address (the caller has already stamped
 *  fee_rechecked_at) and persist the answer. True when the order flipped to
 *  'verified'. */
async function checkAddressRow(
	deps: Pick<ExternalFeeRecheckDeps, 'db' | 'onChange'>,
	watcher: FeeVerifier,
	row: AddressRow,
	expected: number
): Promise<boolean> {
	const orderId = `${row.account}/${row.permlink}`;
	const seen = await watcher.checkAddressPayment!(row.btc_fee_address, expected);
	if (seen.kind === 'no_answer') return false;
	if (seen.kind === 'paid') {
		const upd = await deps.db.query(
			`UPDATE orders SET fee_status = 'verified', updated_at = NOW(),
			        btc_fee_received_sats = $3, btc_fee_unconfirmed_sats = $4
			  WHERE account = $1 AND permlink = $2
			    AND fee_status = 'awaiting_payment' AND status = 'live'`,
			[row.account, row.permlink, seen.confirmedSats, seen.unconfirmedSats]
		);
		if ((upd.rowCount ?? 0) > 0) {
			log.info('fee_status_rechecked', {
				order: orderId,
				from: row.fee_status,
				to: 'verified',
				reason: 'fee_address_paid'
			});
			deps.onChange?.(orderId);
			return true;
		}
		return false;
	}
	// Not (fully) paid yet: remember what the explorers see — for the payer's
	// page, and for the back-off (money seen → looked at every pass). Not an
	// order change, so updated_at stays.
	if (
		String(seen.confirmedSats) !== row.btc_fee_received_sats ||
		String(seen.unconfirmedSats) !== row.btc_fee_unconfirmed_sats
	) {
		await deps.db.query(
			`UPDATE orders SET btc_fee_received_sats = $3, btc_fee_unconfirmed_sats = $4
			  WHERE account = $1 AND permlink = $2 AND fee_status = 'awaiting_payment'`,
			[row.account, row.permlink, seen.confirmedSats, seen.unconfirmedSats]
		);
	}
	return false;
}

/**
 * (MK-H2, V3-3) One pass over per-order BTC fee addresses, with its own
 * budget (ADDRESS_CHECKS_PER_PASS) so txid re-checks cannot crowd it out.
 *
 * Which addresses are due, all from persisted state (every node, every
 * restart, the same schedule):
 *   - never looked at                        → due (a new order is checked on
 *                                               the next pass);
 *   - money seen last time (confirmed or in
 *     the mempool)                           → due after ADDRESS_ACTIVE_SPACING_MS;
 *   - nothing seen                           → due after half the order's age
 *                                               at that look, clamped to
 *                                               [5 min, 12 h] (24 h past
 *                                               PENDING_RECHECK_DAYS).
 * Order: never looked at (newest first), then money seen, then the rest by
 * newest order — an abandoned order is looked at less and less, and a paying
 * one is not queued behind it. Watched up to AWAITING_RECHECK_DAYS.
 */
export async function recheckFeeAddresses(
	deps: ExternalFeeRecheckDeps
): Promise<{ checked: number; changed: number }> {
	const watcher = deps.verifiers.btc;
	if (watcher?.checkAddressPayment === undefined) return { checked: 0, changed: 0 };
	const now = deps.now;
	const res = await deps.db.query<AddressRow>(
		`SELECT account, permlink, fee_status, btc_fee_address, btc_fee_sats::text,
		        btc_fee_received_sats::text, btc_fee_unconfirmed_sats::text
		   FROM orders
		  WHERE status = 'live'
		    AND (expires_at IS NULL OR expires_at > $1)
		    AND fee_method = 'btc' AND btc_fee_address IS NOT NULL
		    AND fee_status = 'awaiting_payment'
		    AND created_at >= $1::timestamptz - make_interval(days => $2)
		    AND (fee_rechecked_at IS NULL
		         OR (COALESCE(btc_fee_received_sats, 0) + COALESCE(btc_fee_unconfirmed_sats, 0) > 0
		             AND fee_rechecked_at <= $1::timestamptz - make_interval(secs => $3::double precision / 1000))
		         OR fee_rechecked_at <= $1::timestamptz - LEAST(
		              CASE WHEN created_at < $1::timestamptz - make_interval(days => $4)
		                   THEN make_interval(secs => $7::double precision / 1000)
		                   ELSE make_interval(secs => $6::double precision / 1000) END,
		              GREATEST(make_interval(secs => $5::double precision / 1000),
		                       (fee_rechecked_at - created_at) / 2)))
		  ORDER BY (fee_rechecked_at IS NULL) DESC,
		           (COALESCE(btc_fee_received_sats, 0) + COALESCE(btc_fee_unconfirmed_sats, 0) > 0) DESC,
		           created_at DESC, account ASC, permlink ASC
		  LIMIT $8`,
		[
			now,
			AWAITING_RECHECK_DAYS,
			ADDRESS_ACTIVE_SPACING_MS,
			PENDING_RECHECK_DAYS,
			ADDRESS_IDLE_MIN_SPACING_MS,
			ADDRESS_IDLE_MAX_SPACING_MS,
			AWAITING_SLOW_SPACING_MS,
			deps.limit ?? ADDRESS_CHECKS_PER_PASS
		]
	);
	let checked = 0;
	let changed = 0;
	for (const row of res.rows) {
		const expected = addressExpected(row, deps.amounts.btcSatoshis);
		if (expected === null) continue;
		const orderId = `${row.account}/${row.permlink}`;
		checked++;
		deps.onChecked?.(orderId);
		try {
			await deps.db.query(
				`UPDATE orders SET fee_rechecked_at = $3 WHERE account = $1 AND permlink = $2`,
				[row.account, row.permlink, now]
			);
			if (await checkAddressRow(deps, watcher, row, expected)) changed++;
		} catch (err) {
			log.warn('fee_recheck_failed', { order: orderId }, err);
		}
	}
	return { checked, changed };
}

export type FeeCheckNowResult =
	| {
			readonly kind: 'checked';
			readonly fee_status: string;
			readonly received_sats: number;
			readonly unconfirmed_sats: number;
	  }
	| { readonly kind: 'cooldown'; readonly retry_after_ms: number }
	| { readonly kind: 'not_awaiting' }
	| { readonly kind: 'unavailable' };

/**
 * (V3-3) "Check my payment now" for one order with its own fee address: runs
 * the same address check as the pass, at most once per order per
 * FEE_CHECK_NOW_COOLDOWN_MS (the stamp is taken atomically, so two requests
 * racing cannot both ask the explorers). Anyone may ask — the answer is public
 * chain data — but only an awaiting, live, unexpired order is looked at.
 */
export async function checkFeeAddressNow(
	deps: Omit<ExternalFeeRecheckDeps, 'limit'> & {
		readonly account: string;
		readonly permlink: string;
	}
): Promise<FeeCheckNowResult> {
	const now = deps.now;
	const cur = await deps.db.query<AddressRow & { rechecked: Date | null }>(
		`SELECT account, permlink, fee_status, btc_fee_address, btc_fee_sats::text,
		        btc_fee_received_sats::text, btc_fee_unconfirmed_sats::text,
		        fee_rechecked_at AS rechecked
		   FROM orders
		  WHERE account = $1 AND permlink = $2 AND status = 'live'
		    AND (expires_at IS NULL OR expires_at > $3)
		    AND fee_method = 'btc' AND btc_fee_address IS NOT NULL
		    AND fee_status = 'awaiting_payment'`,
		[deps.account, deps.permlink, now]
	);
	const row = cur.rows[0];
	if (row === undefined) return { kind: 'not_awaiting' };
	const watcher = deps.verifiers.btc;
	const expected = addressExpected(row, deps.amounts.btcSatoshis);
	if (watcher?.checkAddressPayment === undefined || expected === null)
		return { kind: 'unavailable' };
	const stamp = await deps.db.query(
		`UPDATE orders SET fee_rechecked_at = $3
		  WHERE account = $1 AND permlink = $2
		    AND (fee_rechecked_at IS NULL
		         OR fee_rechecked_at <= $3::timestamptz - make_interval(secs => $4::double precision / 1000))`,
		[deps.account, deps.permlink, now, FEE_CHECK_NOW_COOLDOWN_MS]
	);
	if ((stamp.rowCount ?? 0) === 0) {
		const since = row.rechecked === null ? 0 : now.getTime() - new Date(row.rechecked).getTime();
		return { kind: 'cooldown', retry_after_ms: Math.max(1_000, FEE_CHECK_NOW_COOLDOWN_MS - since) };
	}
	deps.onChecked?.(`${row.account}/${row.permlink}`);
	await checkAddressRow(deps, watcher, row, expected);
	const after = await deps.db.query<{ fee_status: string; r: string | null; u: string | null }>(
		`SELECT fee_status, btc_fee_received_sats::text AS r, btc_fee_unconfirmed_sats::text AS u
		   FROM orders WHERE account = $1 AND permlink = $2`,
		[deps.account, deps.permlink]
	);
	const a = after.rows[0];
	return {
		kind: 'checked',
		fee_status: a?.fee_status ?? row.fee_status,
		received_sats: Number(a?.r ?? 0),
		unconfirmed_sats: Number(a?.u ?? 0)
	};
}

/** Self-throttling wrapper the poller calls every tick. */
export class ExternalFeeRechecker {
	private lastRunAt = 0;
	private inFlight = false;

	constructor(
		private readonly db: Database,
		private readonly current: () => {
			verifiers: ExternalFeeRecheckDeps['verifiers'];
			amounts: ExternalFeeRecheckDeps['amounts'];
		},
		private readonly onChange: (orderId: string) => void,
		private readonly clock: () => number = () => Date.now()
	) {}

	async maybeRun(): Promise<void> {
		const now = this.clock();
		if (this.inFlight || now - this.lastRunAt < RECHECK_INTERVAL_MS) return;
		this.lastRunAt = now;
		this.inFlight = true;
		try {
			const { verifiers, amounts } = this.current();
			if (verifiers.btc === undefined && verifiers.xmr === undefined) return;
			// Spacing + rotation live in orders.fee_rechecked_at (G3, v63).
			await recheckExternalFees({
				db: this.db,
				verifiers,
				amounts,
				now: new Date(now),
				onChange: this.onChange
			});
		} catch (err) {
			log.warn('fee_recheck_pass_failed', {}, err);
		} finally {
			this.inFlight = false;
		}
	}
}
