/**
 * Morphit indexer — which accounts may receive the OWNER leg of a BLURT fee
 * (v1.20.0, G1: cross-instance BLURT fees).
 *
 * THE MODEL. A BLURT fee (listing, stranger DM) is paid at payment time as two
 * transfers sharing one memo: 90 % to the fee account of the instance the user
 * posted through, 10 % to the canonical treasury (@morphit-fees). An instance
 * that never set a fees account pays 100 % to the treasury (resolveFeeRecipient's
 * fallback), which verifies everywhere as a single canonical leg.
 *
 * WHAT WAS WRONG. Every indexer counted the 90 % leg only when it went to ITS OWN
 * MORPHIT_INDEXER_FEE_RECIPIENT. An order posted through instance B (legs to
 * @b-fees + @morphit-fees) was therefore `underpaid` — hidden — on every other
 * instance, and a first-contact DM from a B user was dropped on the recipient's
 * instance.
 *
 * THE RULE (deterministic: a pure function of chain data up to the op's block).
 * The allowed owner recipients of a fee op at block N are
 *     { this indexer's own recipient }
 *   ∪ { the fee_recipient registered, as of block N, by the operator that OWNS
 *       the op's `operator_tag` }
 * where the second set is non-empty only when
 *   - the tag belongs to a registered, active operator (tags are first-come and
 *     immutable, so the tag names exactly one account);
 *   - that operator's latest `fee_recipient` row is from a block STRICTLY BEFORE
 *     N (strict so the answer never depends on the order ops of one block are
 *     processed in).
 * The chain is the only list: every operator that published a fees account in
 * its registration (the same registrations the /operators page shows) is
 * accepted, with no maintainer list and no extra step for a new instance.
 *
 * WHAT THAT ALLOWS, ON PURPOSE. Registration is free, so a user can register an
 * "operator" whose fees account is their own second account and get the 90 %
 * leg of their own fees back. That is what running an instance already gives
 * anyone, costs nobody but the fee itself, and leaks nothing. The canonical
 * 10 % leg stays mandatory everywhere (canonicalShareOk is unchanged), so no
 * rule here can cut the treasury out.
 *
 * A transfer to any OTHER account (a decoy) is still ignored: only the tag's
 * owner can be paid the owner leg, and only when the op names that tag.
 */

import type pg from 'pg';

/** The project-canonical Blurt account-name regex (byte-identical to every
 *  other account-name regex in the tree). */
export const FEE_RECIPIENT_ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** Same shape the order handler accepts for `operator_tag`. */
const OPERATOR_TAG_RE = /^[a-z0-9._-]{1,64}$/;

/** Minimal query surface (a PoolClient or the Database wrapper both fit). */
export interface Queryable {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/** The `operator_tag` of a payload if it is a well-formed tag, else null. */
export function operatorTagOf(payload: unknown): string | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const raw = (payload as Record<string, unknown>).operator_tag;
	return typeof raw === 'string' && OPERATOR_TAG_RE.test(raw) ? raw : null;
}

/**
 * The fee_recipient the operator owning `tag` had registered as of block
 * `blockNum`, if that operator may receive owner legs at that block (see the
 * module doc), else null.
 */
export async function taggedOperatorRecipientAt(
	client: Queryable,
	tag: string | null,
	blockNum: number
): Promise<string | null> {
	if (tag === null || !OPERATOR_TAG_RE.test(tag)) return null;
	const res = await client.query<{ fee_recipient: string }>(
		`SELECT r.fee_recipient
		   FROM operators o
		   JOIN LATERAL (
		        SELECT f.fee_recipient
		          FROM operator_fee_recipients f
		         WHERE f.account = o.account AND f.effective_block < $2
		         ORDER BY f.effective_block DESC, f.trx_in_block DESC, f.op_in_trx DESC
		         LIMIT 1) r ON TRUE
		  WHERE o.tag = $1 AND o.is_active = TRUE`,
		[tag, blockNum]
	);
	return res.rows[0]?.fee_recipient ?? null;
}

/**
 * The accounts whose transfers count as the OWNER leg of a fee op at
 * `blockNum`: this indexer's own recipient, plus the tagged operator's
 * registered recipient when the module-doc rule allows it.
 */
export async function ownerRecipientsFor(
	client: Queryable,
	ownRecipient: string,
	payload: unknown,
	blockNum: number
): Promise<readonly string[]> {
	const tagged = await taggedOperatorRecipientAt(client, operatorTagOf(payload), blockNum);
	return tagged !== null && tagged !== ownRecipient ? [ownRecipient, tagged] : [ownRecipient];
}

/**
 * Record an accepted registration's fee_recipient in the append-only history.
 * One row per accepted register op that carries the field (not only on a
 * change), keyed by the op's position, so a node that indexed the op live and a
 * node that back-filled it from the event log hold the SAME rows. A second
 * register op by the same account in the SAME transaction overwrites the first
 * (the later op wins, as it does for the operators row).
 */
export async function recordFeeRecipient(
	client: Queryable,
	row: {
		account: string;
		feeRecipient: string;
		blockNum: number;
		trxId: string;
		trxInBlock: number;
		opInTrx: number;
	}
): Promise<void> {
	await client.query(
		`INSERT INTO operator_fee_recipients
		   (account, fee_recipient, effective_block, effective_trx, trx_in_block, op_in_trx)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (account, effective_block, effective_trx) DO UPDATE
		   SET fee_recipient = EXCLUDED.fee_recipient, op_in_trx = EXCLUDED.op_in_trx
		 WHERE EXCLUDED.op_in_trx >= operator_fee_recipients.op_in_trx`,
		[row.account, row.feeRecipient, row.blockNum, row.trxId, row.trxInBlock, row.opInTrx]
	);
}

/**
 * LEGACY GRACE (v1.20.0, G1) — the fees account an op of `account`'s operator
 * at block `blockNum` is judged against when the op is older than the block
 * from which the strict rule above accepts that operator (its first
 * registration block + 1): the account the operator had registered before
 * that block, or — for an op older than its first registration — the FIRST
 * account it registered. An order that paid an account the operator used
 * before it ever registered one (and changed away from) does not match, and
 * stays unaccepted, by design: nothing on chain ties that account to the
 * operator.
 */
export async function graceRecipientAt(
	client: Queryable,
	account: string,
	blockNum: number | string
): Promise<string | null> {
	const r = await client.query<{ fee_recipient: string }>(
		`SELECT fee_recipient FROM (
		    (SELECT fee_recipient, 0 AS pri FROM operator_fee_recipients
		      WHERE account = $1 AND effective_block < $2::bigint
		      ORDER BY effective_block DESC, trx_in_block DESC, op_in_trx DESC LIMIT 1)
		    UNION ALL
		    (SELECT fee_recipient, 1 AS pri FROM operator_fee_recipients
		      WHERE account = $1
		      ORDER BY effective_block ASC, trx_in_block ASC, op_in_trx ASC LIMIT 1)) x
		  ORDER BY pri LIMIT 1`,
		[account, String(blockNum)]
	);
	return r.rows[0]?.fee_recipient ?? null;
}

/** What /v1/instance and `morphit-ops status` report about this instance's
 *  own fees account (see instanceFeeRecipientStatus). */
export interface InstanceFeeRecipientStatus {
	/** True when the resolved recipient IS the canonical treasury (one 100 %
	 *  leg, verifies everywhere, nothing to register), or it equals the
	 *  fee_recipient the account owning this instance's operator tag has
	 *  registered on chain — which is also what makes other upgraded
	 *  instances accept the owner leg of fees paid through this one. */
	readonly registered: boolean;
}

/** Compute InstanceFeeRecipientStatus for `feeRecipient` (the resolved
 *  MORPHIT_INDEXER_FEE_RECIPIENT) and `operatorTag` (this instance's tag). */
export async function instanceFeeRecipientStatus(
	client: Queryable,
	feeRecipient: string,
	operatorTag: string | undefined,
	canonicalTreasury: string
): Promise<InstanceFeeRecipientStatus> {
	if (feeRecipient === canonicalTreasury) return { registered: true };
	if (operatorTag === undefined || !OPERATOR_TAG_RE.test(operatorTag)) {
		return { registered: false };
	}
	const res = await client.query<{ fee_recipient: string | null }>(
		`SELECT r.fee_recipient
		   FROM operators o
		   LEFT JOIN LATERAL (
		        SELECT f.fee_recipient
		          FROM operator_fee_recipients f
		         WHERE f.account = o.account
		         ORDER BY f.effective_block DESC, f.trx_in_block DESC, f.op_in_trx DESC
		         LIMIT 1) r ON TRUE
		  WHERE o.tag = $1 AND o.is_active = TRUE`,
		[operatorTag]
	);
	const row = res.rows[0];
	return { registered: row !== undefined && row.fee_recipient === feeRecipient };
}

/**
 * A cached, never-throwing reader of instanceFeeRecipientStatus for the public
 * /v1/instance route: at most one DB query per `ttlMs`, concurrent callers
 * share it, and a failed query answers the last known value (null before the
 * first success — "could not tell", which callers must not report as "not
 * registered").
 */
export function cachedInstanceFeeRecipientStatus(
	db: Queryable,
	feeRecipient: string,
	operatorTag: string | undefined,
	canonicalTreasury: string,
	ttlMs = 30_000,
	now: () => number = Date.now
): () => Promise<InstanceFeeRecipientStatus | null> {
	let last: InstanceFeeRecipientStatus | null = null;
	let lastAt = Number.NEGATIVE_INFINITY;
	let inFlight: Promise<InstanceFeeRecipientStatus | null> | null = null;
	return () => {
		if (now() - lastAt < ttlMs) return Promise.resolve(last);
		if (inFlight !== null) return inFlight;
		inFlight = instanceFeeRecipientStatus(db, feeRecipient, operatorTag, canonicalTreasury)
			.then((s) => {
				last = s;
				lastAt = now();
				return s;
			})
			.catch(() => last)
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};
}
