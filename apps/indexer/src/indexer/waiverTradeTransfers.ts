/**
 * Morphit indexer — the BLURT transfers that can prove a first-buy waiver
 * trade (schema v70).
 *
 * WHY. A newcomer's first order must be a fee-waived BLURT buy
 * (`fee_method = 'waived_first_buy'`). Such an order costs nothing, so a
 * review could not cite it (reviewCitation.ts): any fresh sock could post one
 * and farm reputation with it. The price was that a newcomer's first real
 * trade could never earn either party a review. From the consensus activation
 * time a review may cite a waiver order when the trade is PROVEN on chain: the
 * order was completed naming the other party, and that party sent the order's
 * owner BLURT, from the activation time on. The BLURT leg is the evidence this
 * table keeps.
 *
 * WHAT IS RECORDED. Per (owner, sender), the EARLIEST transfer of at least
 * WAIVER_TRADE_MIN_TRANSFER_BLURT from the sender to an account holding a
 * waiver order posted at or before the transfer's block (from someone else;
 * whatever the memo), in a block stamped at or after the activation time. The
 * citation rule needs one such transfer at or before the review; the earliest
 * is the only one that can ever be that witness — a review earlier than it
 * cannot be helped by a later one — so it is all that is kept. A later
 * transfer of the pair changes nothing; an earlier one replaces the row.
 *
 * ONLY FROM THE ACTIVATION TIME, so every node holds the same rows. A node
 * that replays the chain from genesis applies every block with this code; a
 * node that upgraded before the activation time applied the older blocks
 * with code that recorded nothing. With earliest-per-pair, the first would
 * keep a pre-activation transfer where the second keeps a later one. Recording
 * nothing stamped before the activation time makes the two identical, with no
 * need to read anything older back from the chain. (An older trade counts once
 * the partner sends the owner at least 50 BLURT again from the activation time
 * on.)
 *
 * SAME BLOCK. A transfer counts from the block that posted the order on (even
 * earlier in that block: the post-pass below) up to and including the
 * review's block (even later in it: the pre-pass runs before every op). A
 * review in the very block that posted the order is refused: its block's
 * transfers are recorded only after its ops.
 *
 * WHO RECORDS IT: the dispatcher, for every block it applies — once before the
 * block's ops (owners whose waiver order is older than the block) and once
 * after them when an order op applied in the block (an owner whose waiver
 * order was posted in this very block). Blocks are applied in order, so a
 * replay records exactly the same rows.
 */
import type { ChainOperation } from '$blurt/client';
import type { ChatGateDb } from '$indexer/chatGates';
import { parseBlurtMilli } from '$indexer/fee';
import { consensusV2Active } from '$indexer/consensusActivation';

/** The smallest transfer that proves a waiver trade: 50.000 BLURT.
 *
 *  WHY THIS AMOUNT. The transfer is the counterparty paying the newcomer the
 *  BLURT they bought, and the waiver is only for a buy of at least about one
 *  US dollar (FIRST_ORDER_MIN_USD, checked by the client): several hundred
 *  BLURT at today's price. 50 BLURT (owner's decision, v1.21.17) is
 *  well above what any new account is given for free — the relay sends every
 *  signup 4 BLURT of dust and tops active users up by 1 BLURT at most every 3
 *  days — so two free accounts cannot prove a "trade" with gifted BLURT and
 *  swap 5★ reviews at no outside cost (1 BLURT, the first value, could be
 *  paid out of that dust). It does not try to price collusion beyond that:
 *  two funded friends can move any amount between themselves, and the other
 *  review bars (verified conversation, sock-puppet signals) stand against it.
 *
 *  A consensus value: changing it changes which reviews index, so a change
 *  must take effect at a new activation time. */
export const WAIVER_TRADE_MIN_TRANSFER_BLURT = 50;

/** One BLURT transfer as recorded. `amountMilli` is exact (milliBLURT). */
export interface BlurtTransferLeg {
	readonly trxInBlock: number;
	readonly opInTrx: number;
	readonly trxId: string;
	readonly sender: string;
	readonly recipient: string;
	readonly amountMilli: number;
}

/** The BLURT transfers in one transaction: well-formed `transfer` ops with a
 *  positive BLURT amount. Pure; the caller passes the transaction as it was
 *  applied (pgSafe). */
export function blurtTransfersOfTrx(
	operations: readonly ChainOperation[],
	trxInBlock: number,
	trxId: string
): BlurtTransferLeg[] {
	const out: BlurtTransferLeg[] = [];
	for (let oi = 0; oi < operations.length; oi++) {
		const op = operations[oi];
		if (!Array.isArray(op) || op[0] !== 'transfer') continue;
		const b = op[1] as { from?: unknown; to?: unknown; amount?: unknown };
		if (typeof b.from !== 'string' || typeof b.to !== 'string' || typeof b.amount !== 'string') {
			continue;
		}
		const milli = parseBlurtMilli(b.amount);
		if (milli === null || milli <= 0) continue;
		out.push({
			trxInBlock,
			opInTrx: oi,
			trxId,
			sender: b.from,
			recipient: b.to,
			amountMilli: milli
		});
	}
	return out;
}

/** Every BLURT transfer in a block (as the dispatcher applies it). */
export function blurtTransfersOfBlock(block: {
	readonly transactions: readonly { readonly operations: readonly ChainOperation[] }[];
	readonly transaction_ids: readonly string[];
}): BlurtTransferLeg[] {
	const out: BlurtTransferLeg[] = [];
	for (let ti = 0; ti < block.transactions.length; ti++) {
		const trx = block.transactions[ti];
		if (!trx || !Array.isArray(trx.operations)) continue;
		out.push(...blurtTransfersOfTrx(trx.operations, ti, block.transaction_ids[ti] ?? ''));
	}
	return out;
}

/** milliBLURT as an exact decimal string for a NUMERIC(18,3) column. */
function milliToDecimal(milli: number): string {
	return `${Math.floor(milli / 1000)}.${String(milli % 1000).padStart(3, '0')}`;
}

const MIN_MILLI = WAIVER_TRADE_MIN_TRANSFER_BLURT * 1000;

/** The transfers that can be evidence (from someone else, at least the
 *  minimum), one per (recipient, sender): the earliest in the block. */
export function evidenceCandidates(transfers: readonly BlurtTransferLeg[]): BlurtTransferLeg[] {
	const first = new Map<string, BlurtTransferLeg>();
	for (const t of transfers) {
		if (t.sender === t.recipient || t.amountMilli < MIN_MILLI) continue;
		const k = `${t.recipient}\0${t.sender}`;
		const had = first.get(k);
		if (
			had === undefined ||
			t.trxInBlock < had.trxInBlock ||
			(t.trxInBlock === had.trxInBlock && t.opInTrx < had.opInTrx)
		) {
			first.set(k, t);
		}
	}
	return [...first.values()];
}

/**
 * Record the evidence among the transfers of block `blockNum`: those whose
 * recipient holds a waiver order posted at or before `blockTime`, keeping per
 * (recipient, sender) the earliest on chain. ONE statement (none when nothing
 * qualifies); the order condition is evaluated against the orders as they
 * stand inside the caller's transaction. Idempotent. Returns the rows added or
 * moved earlier.
 */
export async function recordWaiverTradeTransfers(
	client: ChatGateDb,
	args: {
		readonly blockNum: number | string;
		readonly blockTime: Date;
		readonly transfers: readonly BlurtTransferLeg[];
	}
): Promise<number> {
	// Nothing stamped before the activation time (see the file header): a
	// genesis replay and a node upgraded before then must hold the same rows.
	if (!consensusV2Active(args.blockTime)) return 0;
	const t = evidenceCandidates(args.transfers);
	if (t.length === 0) return 0;
	const r = await client.query(
		`INSERT INTO waiver_trade_transfers AS w
		   (recipient, sender, block_num, trx_in_block, op_in_trx, block_time, trx_id, amount_blurt)
		 SELECT v.recipient, v.sender, $1::bigint, v.trx_in_block, v.op_in_trx, $2::timestamptz,
		        v.trx_id, v.amount
		   FROM unnest($3::int[], $4::int[], $5::text[], $6::text[], $7::text[], $8::numeric[])
		        AS v(trx_in_block, op_in_trx, trx_id, sender, recipient, amount)
		  WHERE EXISTS (SELECT 1 FROM orders o
		                 WHERE o.account = v.recipient
		                   AND o.fee_method = 'waived_first_buy'
		                   AND o.created_at <= $2::timestamptz)
		 ON CONFLICT (recipient, sender) DO UPDATE
		    SET block_num = EXCLUDED.block_num, trx_in_block = EXCLUDED.trx_in_block,
		        op_in_trx = EXCLUDED.op_in_trx, block_time = EXCLUDED.block_time,
		        trx_id = EXCLUDED.trx_id, amount_blurt = EXCLUDED.amount_blurt
		  WHERE (EXCLUDED.block_num, EXCLUDED.trx_in_block, EXCLUDED.op_in_trx)
		      < (w.block_num, w.trx_in_block, w.op_in_trx)`,
		[
			String(args.blockNum),
			args.blockTime,
			t.map((x) => x.trxInBlock),
			t.map((x) => x.opInTrx),
			t.map((x) => x.trxId),
			t.map((x) => x.sender),
			t.map((x) => x.recipient),
			t.map((x) => milliToDecimal(x.amountMilli))
		]
	);
	return r.rowCount ?? 0;
}
