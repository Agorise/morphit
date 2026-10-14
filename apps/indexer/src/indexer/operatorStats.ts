/**
 * Morphit indexer — every operator's orders and earnings, for /v1/operators
 * (v1.21.8).
 *
 * WHY A TABLE. The figures scan every recorded fee payment. Computed on a
 * request (the first v1.21.8 draft) the scan ran on the API's pool, whose
 * statements stop after 5 s — the page would have answered 500 once the
 * payments grew — and every cache miss started another scan. Here the poller
 * computes them in the background, one pass at a time, into `operator_stats`;
 * /v1/operators reads that small table. A local cache of chain-derived data:
 * never exported in a snapshot, recomputed after a restore.
 *
 * WHAT THE FIGURES ARE (api/operators.ts documents them for readers too):
 *
 *  - orders: the orders carrying the operator's tag whose fee this node holds
 *    as paid ('verified', or 'verified_by_attestation') — any fee method, a
 *    free first buy included — whatever the order's status now. This is THIS
 *    node's judgement: a node that does not list an asset does not index its
 *    orders, BTC/XMR payments are confirmed by each node's own explorers, and
 *    an operator's own node also accepts fees paid to its own fees account
 *    before it registered that account. So nodes can differ a little.
 *  - earned (milliBLURT): the BLURT that reached the operator's fees account in
 *    Morphit fee payments (fee_payments / fee_payment_legs). From chain data
 *    only, so every node computes the same figure:
 *      * a payment counts only when the treasury got its 10 % of all its legs
 *        (less the split tolerance — the check every fee handler makes);
 *      * a leg is credited to the operator whose registered fees account it
 *        went to AS OF ITS BLOCK (operator_fee_recipients: the latest
 *        registration before the block; for a block before the operator's
 *        first registration, the first account it registered — the legacy
 *        grace of feeRecipients.graceRecipientAt — and then only for a
 *        payment that names the operator);
 *      * two operators that registered the same account: the one the payment
 *        names, else the one that registered it first (chain order);
 *      * a leg its payer sent to itself never counts (a fee paid from an
 *        operator's fees account goes wholly to the treasury);
 *      * a leg to the canonical treasury only when the whole fee went there
 *        AND the payment names an operator whose fees account IS the treasury;
 *      * a featured-slot bid names no operator: the tag of the featured
 *        order's own order op — the bidder's first order op with that
 *        permlink that is a well-formed order (validateOrderPayload: the
 *        checks that depend on the op alone). From the event log, not this
 *        node's orders table, which a node that does not list the asset never
 *        filled; an earlier malformed op with the same permlink names nobody.
 */
import type { Database } from '$db/pool';
import { CANONICAL_TREASURY } from '../config/canonicalTreasury';
import { FEE_TREASURY_SHARE_BLURT } from '@morphit/asset-registry';
import { FEE_SPLIT_TOLERANCE } from '$indexer/fee';
import { validateOrderPayload } from '$indexer/handlers/order';
import { logger } from '$log';
import type pg from 'pg';

const log = logger('operatorStats');

/** The treasury's share every fee must carry for its legs to count, in
 *  millionths: the same 10 % (less the split tolerance) every fee handler
 *  requires (canonicalShareOk). */
export const TREASURY_SHARE_PPM = Math.round(
	FEE_TREASURY_SHARE_BLURT * (1 - FEE_SPLIT_TOLERANCE) * 1_000_000
);

/** Fee statuses that mean "this node holds the fee as paid". */
export const PAID_FEE_STATUSES: readonly string[] = ['verified', 'verified_by_attestation'];

/**
 * Every operator's figures (see the module doc). $1 the canonical treasury
 * account, $2 TREASURY_SHARE_PPM, $3 PAID_FEE_STATUSES, $4–$6 featureTags().
 */
export const OPERATOR_STATS_SQL = `
WITH iv AS (
	-- Each fees-account registration as a block interval (lo, hi]: from its
	-- block (exclusive) to the next registration's block (inclusive). The first
	-- one also covers every earlier block (legacy grace); grace_to is the last
	-- block it covers only by that grace.
	SELECT account, fee_recipient,
	       CASE WHEN row_number() OVER w = 1 THEN effective_block END AS grace_to,
	       CASE WHEN row_number() OVER w = 1 THEN NULL ELSE effective_block END AS lo,
	       lead(effective_block) OVER w AS hi
	  FROM operator_fee_recipients
	WINDOW w AS (PARTITION BY account ORDER BY effective_block, trx_in_block, op_in_trx)
),
first_reg AS (
	-- When each operator FIRST registered each account (the tie-break between
	-- two operators that registered the same one).
	SELECT DISTINCT ON (account, fee_recipient)
	       account, fee_recipient, effective_block, trx_in_block, op_in_trx
	  FROM operator_fee_recipients
	 ORDER BY account, fee_recipient, effective_block, trx_in_block, op_in_trx
),
ftag AS (
	-- Each featured order's tag (featureTags): $4 bidder, $5 permlink, $6 tag.
	SELECT * FROM unnest($4::text[], $5::text[], $6::text[]) AS f(payer, ref, tag)
),
pay AS (
	SELECT p.block_num, p.trx_in_block, p.op_in_trx, p.payer,
	       CASE WHEN p.kind = 'feature' THEN
	            (SELECT ftag.tag FROM ftag WHERE ftag.payer = p.payer AND ftag.ref = p.ref)
	            ELSE p.operator_tag END AS tag,
	       bool_and(l.recipient = $1) AS all_treasury,
	       -- BLURT sent round in a circle pays the treasury nothing: a fee's
	       -- legs count only when the treasury got its share of all of them.
	       COALESCE(sum(l.amount_milli) FILTER (WHERE l.recipient = $1), 0)::numeric * 1000000
	         >= sum(l.amount_milli)::numeric * $2::numeric AS share_ok
	  FROM fee_payments p
	  JOIN fee_payment_legs l
	    ON l.block_num = p.block_num AND l.trx_in_block = p.trx_in_block
	   AND l.op_in_trx = p.op_in_trx
	 GROUP BY p.block_num, p.trx_in_block, p.op_in_trx, p.operator_tag, p.kind, p.payer, p.ref
),
credited AS (
	SELECT DISTINCT ON (l.block_num, l.trx_in_block, l.leg_op_in_trx)
	       op.account, l.amount_milli
	  FROM fee_payment_legs l
	  JOIN pay
	    ON pay.block_num = l.block_num AND pay.trx_in_block = l.trx_in_block
	   AND pay.op_in_trx = l.op_in_trx
	  JOIN iv
	    ON iv.fee_recipient = l.recipient
	   AND (iv.lo IS NULL OR l.block_num > iv.lo)
	   AND (iv.hi IS NULL OR l.block_num <= iv.hi)
	  JOIN operators op ON op.account = iv.account
	  JOIN first_reg fr ON fr.account = iv.account AND fr.fee_recipient = iv.fee_recipient
	 WHERE pay.share_ok
	   -- BLURT a fees account sends itself reached it from nobody.
	   AND l.recipient <> pay.payer
	   AND (l.recipient <> $1 OR (pay.all_treasury AND op.tag = pay.tag))
	   -- Before an operator first registered an account, a payment to it is
	   -- that operator's only when it names that operator: registering an
	   -- account later claims nothing paid to it by anyone else's users.
	   AND (iv.grace_to IS NULL OR l.block_num > iv.grace_to OR op.tag = pay.tag)
	 ORDER BY l.block_num, l.trx_in_block, l.leg_op_in_trx,
	          (op.tag IS NOT DISTINCT FROM pay.tag) DESC,
	          fr.effective_block, fr.trx_in_block, fr.op_in_trx, op.account
),
earned AS (
	SELECT account, sum(amount_milli) AS milli FROM credited GROUP BY account
),
counted AS (
	SELECT operator_tag AS tag, count(*) AS n
	  FROM orders
	 WHERE operator_tag IS NOT NULL AND fee_status = ANY($3::text[])
	 GROUP BY operator_tag
)
SELECT o.account, COALESCE(c.n, 0) AS orders, COALESCE(e.milli, 0) AS earned_milli
  FROM operators o
  LEFT JOIN earned e ON e.account = o.account
  LEFT JOIN counted c ON c.tag = o.tag`;

/**
 * The tag each featured-slot bid is credited by: for every (bidder, permlink)
 * a bid paid for, the operator_tag of the bidder's first order op with that
 * permlink that is a well-formed order — the op that made the order on any
 * node that lists its asset. Checked in code (validateOrderPayload), so an
 * earlier malformed op with the same permlink, refused on every node, names
 * nobody. Returned as the three parallel arrays OPERATOR_STATS_SQL takes.
 */
export async function featureTags(
	client: Pick<pg.PoolClient, 'query'>
): Promise<[string[], string[], (string | null)[]]> {
	const r = await client.query<{ signer: string; ref: string; payload: unknown; block_time: Date }>(
		`SELECT o.signer, f.ref, o.payload, o.block_time
		   FROM (SELECT DISTINCT payer, ref FROM fee_payments WHERE kind = 'feature') f
		   JOIN ops o
		     ON o.signer = f.payer AND o.op_id = 'morphit_order_v1'
		    AND jsonb_typeof(o.payload) = 'object' AND o.payload->>'permlink' = f.ref
		  ORDER BY o.block_num, o.trx_in_block, o.op_in_trx`
	);
	const found = new Map<string, [string, string, string | null]>();
	for (const row of r.rows) {
		const key = JSON.stringify([row.signer, row.ref]);
		if (found.has(key)) continue;
		if ('reason' in validateOrderPayload(row.payload, new Date(row.block_time))) continue;
		const raw = (row.payload as Record<string, unknown>).operator_tag;
		found.set(key, [row.signer, row.ref, typeof raw === 'string' ? raw : null]);
	}
	const rows = [...found.values()];
	return [rows.map((x) => x[0]), rows.map((x) => x[1]), rows.map((x) => x[2])];
}

/** Recompute `operator_stats` in one transaction (readers see the old figures
 *  or the new ones, never a half). Throws on a database error. */
export async function refreshOperatorStats(db: Pick<Database, 'withTx'>): Promise<number> {
	return db.withTx(async (client) => {
		const [payers, refs, tags] = await featureTags(client);
		await client.query('DELETE FROM operator_stats');
		const r = await client.query(
			`INSERT INTO operator_stats (account, orders, earned_milli, computed_at)
			 SELECT account, orders, earned_milli, NOW() FROM (${OPERATOR_STATS_SQL}) s`,
			[CANONICAL_TREASURY.blurt, TREASURY_SHARE_PPM, PAID_FEE_STATUSES, payers, refs, tags]
		);
		return r.rowCount ?? 0;
	});
}

/** Recompute at least this often (orders change state without a new fee
 *  payment: BTC/XMR confirmations, attestations, re-checks). */
export const STATS_REFRESH_MS = 10 * 60_000;
/** …and this soon after a new fee payment, registration or operator. */
export const STATS_CHANGED_REFRESH_MS = 60_000;

export interface OperatorStatsRefresherDeps {
	readonly db: Pick<Database, 'query' | 'withTx'>;
	readonly now?: () => number;
}

/**
 * Started from the poller loop; never throws and never holds the loop: a pass
 * runs in the background, one at a time — at once, then STATS_CHANGED_REFRESH_MS
 * after a pass when fee payments, registrations or operators changed, and
 * STATS_REFRESH_MS otherwise.
 */
export class OperatorStatsRefresher {
	private lastCheckAt = Number.NEGATIVE_INFINITY;
	private lastRefreshAt = Number.NEGATIVE_INFINITY;
	private lastSignature: string | null = null;
	private pass: Promise<void> | null = null;

	constructor(private readonly deps: OperatorStatsRefresherDeps) {}

	async maybeRun(): Promise<void> {
		if (this.pass !== null) return;
		const clock = this.deps.now ?? Date.now;
		if (clock() - this.lastCheckAt < STATS_CHANGED_REFRESH_MS) return;
		this.lastCheckAt = clock();
		this.pass = (async () => {
			try {
				const sig = await this.signature();
				if (sig === this.lastSignature && clock() - this.lastRefreshAt < STATS_REFRESH_MS) return;
				const t0 = clock();
				const n = await refreshOperatorStats(this.deps.db);
				this.lastSignature = sig;
				this.lastRefreshAt = clock();
				log.info('operator_stats_refreshed', { operators: n, ms: this.lastRefreshAt - t0 });
			} catch (err) {
				// Tried again STATS_CHANGED_REFRESH_MS later; readers keep the
				// figures of the last good pass.
				log.error('operator_stats_failed', {}, err instanceof Error ? err : undefined);
			} finally {
				this.lastCheckAt = clock();
				this.pass = null;
			}
		})();
	}

	/** Resolves when the pass out now (if any) has finished (shutdown, tests). */
	whenIdle(): Promise<void> {
		return this.pass ?? Promise.resolve();
	}

	private async signature(): Promise<string> {
		const r = await this.deps.db.query<{ s: string }>(
			`SELECT concat_ws(':',
			        (SELECT count(*) FROM fee_payments),
			        (SELECT count(*) FROM operator_fee_recipients),
			        (SELECT count(*) FROM operators)) AS s`
		);
		return r.rows[0]?.s ?? '';
	}
}
