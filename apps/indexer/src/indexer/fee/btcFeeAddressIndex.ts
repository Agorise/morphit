/**
 * Morphit indexer — per-order BTC fee address numbering (v1.20.0, MK-H2).
 *
 * THE PROBLEM THIS SOLVES. A BTC listing fee used to be a payment to one
 * shared treasury address, claimed by pasting its txid into the order op.
 * Anyone watching that address could paste a victim's txid into their own
 * order first; the victim's order then showed `reused`. And one shared address
 * made every Morphit user's fee payment sit in one public pile.
 *
 * THE DESIGN. Once a release op pins the treasury's BIP84 account xpub
 * (`treasury.btc.xpub`), every BTC-fee order op WITHOUT a txid gets its own
 * address: receive address n of that xpub, where n counts the earlier such
 * ops under the same xpub, in chain order (block, trx index, op index). A
 * payment to address n can only ever verify the order that owns n, so there is
 * nothing to steal, and the treasury can be watched and swept by any standard
 * wallet (Sparrow / Electrum / Bitcoin Core) holding the same xpub, because
 * the indices are sequential (see `sudo morphit-ops treasury btc` for the gap
 * limit to set).
 *
 * WHY n IS DERIVED FROM THE EVENT LOG, NOT FROM `orders`. Every indexer must
 * reach the same n for the same op, or the browser (which asked its own
 * indexer) and another indexer would watch different addresses. `orders` rows
 * depend on instance-local settings (disabled assets / payment methods) and on
 * the order validator, which changes between versions; a rejected op's writes
 * are rolled back. The `ops` event log instead records EVERY Morphit op with
 * its raw payload, applied or rejected, on every version — including ops an
 * older indexer processed before it knew about this feature. So the numbering
 * is a pure function of the event log plus the pinned releases:
 *
 *   An op takes part iff (FROZEN — never change these rules, or indexers that
 *   numbered under the old rules diverge from ones that number under the new):
 *     - op_id = 'morphit_order_v1', signer extracted by the dispatcher;
 *     - payload.fee_method === 'btc' and payload.external_tx_id is absent/null;
 *     - payload.permlink is a string of 1..32 characters;
 *     - the release pin in force at its block (the newest valid release with a
 *       treasury block in an EARLIER block) carries btc.xpub.
 *   Such an op is REFUSED an address (and its order rejected) when:
 *     - an earlier participating op by the same account used the same permlink
 *       ('btc_fee_permlink_reused'), or
 *     - the same account already made BTC_FEE_ADDRESSES_PER_DAY participating
 *       ops (allocated or refused) in the 24 h of block time before it
 *       ('btc_fee_daily_limit'). Spam can only burn a bounded number of
 *       indices per account, which bounds the gaps a wallet must scan across.
 *   Otherwise it gets index = 1 + the highest index already allocated under the
 *   same xpub (0 for the first).
 *
 * `btc_fee_address_log` is a CACHE of that function, extended lazily in chain
 * order up to the op being handled. It can be truncated at any time and is
 * rebuilt from `ops` on the next BTC-fee order (tested in
 * test/integration/btc-fee-address-index-mk-h2.test.ts). Writes made inside a
 * rejected op's savepoint are rolled back and simply recomputed later.
 *
 * Validation of the rest of the order (validate(), local gates) deliberately
 * does NOT decide whether an index is consumed: an op that passes the frozen
 * rules but fails the order validator burns its index (a gap), on every
 * indexer alike.
 */

import type pg from 'pg';
import { deriveBtcFeeAddress, parseAccountXpub } from '@morphit/release-schema';

/** Most BTC-fee address allocations one account can make per 24 h of block time. */
export const BTC_FEE_ADDRESSES_PER_DAY = 3;

/** The BTC half of the treasury pin in force at a block, as persisted by the
 *  release handler (canonical `xpub…` spelling). */
export interface BtcPin {
	readonly address: string;
	readonly satoshis: number;
	readonly xpub?: string;
}

export interface OpPosition {
	readonly blockNum: number;
	readonly trxInBlock: number;
	readonly opInTrx: number;
}

export type BtcFeeAllocation =
	| {
			readonly kind: 'allocated';
			readonly xpub: string;
			readonly index: number;
			readonly address: string;
	  }
	| {
			readonly kind: 'refused';
			readonly reason: 'btc_fee_permlink_reused' | 'btc_fee_daily_limit';
	  };

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** FROZEN participation rule on the raw payload (see the module header).
 *  Returns the permlink when the op takes part in the numbering, else null. */
export function addressModePermlink(payload: unknown): string | null {
	if (!isPlainObject(payload)) return null;
	if (payload.fee_method !== 'btc') return null;
	if (payload.external_tx_id !== undefined && payload.external_tx_id !== null) return null;
	const p = payload.permlink;
	if (typeof p !== 'string' || p.length < 1 || p.length > 32) return null;
	return p;
}

function btcPinOf(treasury: unknown): BtcPin | null {
	if (!isPlainObject(treasury) || !isPlainObject(treasury.btc)) return null;
	const b = treasury.btc;
	if (typeof b.address !== 'string' || typeof b.satoshis !== 'number') return null;
	if (typeof b.xpub === 'string') {
		// Defence in depth: the release handler only persists a parsed,
		// canonical key, but a hand-edited row must not reach derivation.
		const parsed = parseAccountXpub(b.xpub);
		if (!parsed.ok) return { address: b.address, satoshis: b.satoshis };
		return { address: b.address, satoshis: b.satoshis, xpub: parsed.value.xpub };
	}
	return { address: b.address, satoshis: b.satoshis };
}

/** The BTC treasury pin in force for an op in block `blockNum`: the newest
 *  valid release carrying a treasury block, broadcast in an EARLIER block.
 *  (A release takes effect from the block after it, so an order in the same
 *  block as a release never races it.) Null when no such release exists or it
 *  pins no BTC treasury. Chain data only — every indexer gets the same answer,
 *  unlike the poller's cached "latest" snapshot. */
export async function btcPinAt(client: pg.PoolClient, blockNum: number): Promise<BtcPin | null> {
	const res = await client.query<{ treasury: unknown }>(
		`SELECT treasury FROM releases
		  WHERE valid = true AND treasury IS NOT NULL AND source_block_num < $1
		  ORDER BY source_block_num DESC, id DESC
		  LIMIT 1`,
		[blockNum]
	);
	return res.rows.length > 0 ? btcPinOf(res.rows[0]!.treasury) : null;
}

interface PinEpoch {
	readonly fromBlock: number; // pin applies to blocks > fromBlock
	readonly xpub: string | null;
}

/** All treasury pins in chain order (releases are few — a handful a year). */
async function loadPinEpochs(client: pg.PoolClient): Promise<PinEpoch[]> {
	const res = await client.query<{ source_block_num: string | number; treasury: unknown }>(
		`SELECT source_block_num, treasury FROM releases
		  WHERE valid = true AND treasury IS NOT NULL
		  ORDER BY source_block_num ASC, id ASC`
	);
	return res.rows.map((r) => ({
		fromBlock: Number(r.source_block_num),
		xpub: btcPinOf(r.treasury)?.xpub ?? null
	}));
}

function xpubInForce(epochs: readonly PinEpoch[], blockNum: number): string | null {
	let x: string | null = null;
	for (const e of epochs) {
		if (e.fromBlock < blockNum) x = e.xpub;
		else break;
	}
	return x;
}

/** Decide one participating op against the log so far, write its log row,
 *  and return the verdict. The caller guarantees every earlier participating
 *  op is already in the log. */
async function decideAndRecord(
	client: pg.PoolClient,
	pos: OpPosition,
	blockTime: Date,
	account: string,
	permlink: string,
	xpub: string
): Promise<BtcFeeAllocation> {
	const dup = await client.query(
		`SELECT 1 FROM btc_fee_address_log WHERE account = $1 AND permlink = $2 LIMIT 1`,
		[account, permlink]
	);
	let refused: 'btc_fee_permlink_reused' | 'btc_fee_daily_limit' | null = null;
	if ((dup.rowCount ?? 0) > 0) {
		refused = 'btc_fee_permlink_reused';
	} else {
		const recent = await client.query<{ n: string }>(
			`SELECT COUNT(*)::text AS n FROM btc_fee_address_log
			  WHERE account = $1 AND block_time > $2::timestamptz - INTERVAL '24 hours'`,
			[account, blockTime]
		);
		if (parseInt(recent.rows[0]?.n ?? '0', 10) >= BTC_FEE_ADDRESSES_PER_DAY) {
			refused = 'btc_fee_daily_limit';
		}
	}
	let index: number | null = null;
	if (refused === null) {
		const top = await client.query<{ next: string }>(
			`SELECT (COALESCE(MAX(idx), -1) + 1)::text AS next FROM btc_fee_address_log WHERE xpub = $1`,
			[xpub]
		);
		index = parseInt(top.rows[0]?.next ?? '0', 10);
	}
	await client.query(
		`INSERT INTO btc_fee_address_log
		   (block_num, trx_in_block, op_in_trx, block_time, account, permlink, xpub, idx, refused)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT (block_num, trx_in_block, op_in_trx) DO NOTHING`,
		[pos.blockNum, pos.trxInBlock, pos.opInTrx, blockTime, account, permlink, xpub, index, refused]
	);
	if (refused !== null) return { kind: 'refused', reason: refused };
	return { kind: 'allocated', xpub, index: index!, address: deriveBtcFeeAddress(xpub, index!) };
}

/** Bring the log up to (not including) `upTo` from the event log. */
async function extendLog(client: pg.PoolClient, upTo: OpPosition): Promise<void> {
	const epochs = await loadPinEpochs(client);
	const firstXpubEpoch = epochs.find((e) => e.xpub !== null);
	if (firstXpubEpoch === undefined) return;
	const last = await client.query<{ block_num: string; trx_in_block: number; op_in_trx: number }>(
		`SELECT block_num::text, trx_in_block, op_in_trx FROM btc_fee_address_log
		  ORDER BY block_num DESC, trx_in_block DESC, op_in_trx DESC LIMIT 1`
	);
	const from = last.rows[0];
	const fromBlock = from ? Number(from.block_num) : firstXpubEpoch.fromBlock;
	const fromTrx = from ? from.trx_in_block : 2 ** 31 - 1;
	const fromOp = from ? from.op_in_trx : 2 ** 31 - 1;
	const pending = await client.query<{
		block_num: string;
		trx_in_block: number;
		op_in_trx: number;
		block_time: Date;
		signer: string;
		payload: unknown;
	}>(
		`SELECT block_num::text, trx_in_block, op_in_trx, block_time, signer, payload
		   FROM ops
		  WHERE op_id = 'morphit_order_v1'
		    AND block_num >= $1
		    AND (block_num, trx_in_block, op_in_trx) > ($1, $2, $3)
		    AND (block_num, trx_in_block, op_in_trx) < ($4, $5, $6)
		    AND payload->>'fee_method' = 'btc'
		  ORDER BY block_num ASC, trx_in_block ASC, op_in_trx ASC`,
		[fromBlock, fromTrx, fromOp, upTo.blockNum, upTo.trxInBlock, upTo.opInTrx]
	);
	for (const r of pending.rows) {
		const permlink = addressModePermlink(r.payload);
		if (permlink === null) continue;
		const blockNum = Number(r.block_num);
		const xpub = xpubInForce(epochs, blockNum);
		if (xpub === null) continue;
		await decideAndRecord(
			client,
			{ blockNum, trxInBlock: r.trx_in_block, opInTrx: r.op_in_trx },
			r.block_time,
			r.signer,
			permlink,
			xpub
		);
	}
}

/**
 * The fee address for the op being handled. The caller has already checked
 * that the op takes part (addressModePermlink(payload) !== null) and that the
 * pin in force carries `xpub` (btcPinAt). Extends the log to this op first,
 * then decides it.
 */
export async function allocateBtcFeeAddress(
	client: pg.PoolClient,
	pos: OpPosition,
	blockTime: Date,
	account: string,
	permlink: string,
	xpub: string
): Promise<BtcFeeAllocation> {
	// Already decided (the same op handled twice): return the recorded
	// verdict instead of deciding again — a second decision would see its own
	// row and call it a reused permlink.
	const seen = await client.query<{ xpub: string; idx: number | null; refused: string | null }>(
		`SELECT xpub, idx, refused FROM btc_fee_address_log
		  WHERE block_num = $1 AND trx_in_block = $2 AND op_in_trx = $3`,
		[pos.blockNum, pos.trxInBlock, pos.opInTrx]
	);
	const prior = seen.rows[0];
	if (prior !== undefined) {
		if (prior.idx === null) {
			return {
				kind: 'refused',
				reason:
					prior.refused === 'btc_fee_daily_limit'
						? 'btc_fee_daily_limit'
						: 'btc_fee_permlink_reused'
			};
		}
		return {
			kind: 'allocated',
			xpub: prior.xpub,
			index: prior.idx,
			address: deriveBtcFeeAddress(prior.xpub, prior.idx)
		};
	}
	await extendLog(client, pos);
	return decideAndRecord(client, pos, blockTime, account, permlink, xpub);
}
