/**
 * Morphit indexer — confirm, before applying a block, that the transactions
 * which move the fee-address numbering (or the treasury pin) are REALLY in it
 * (v1.20.0, MK-H2 / V3-6).
 *
 * THE HOLE. The poller reads each block from ONE RPC endpoint. A hostile or
 * broken endpoint can serve a block with an extra transaction — a BTC-fee
 * order op that was never on chain. The numbering of per-order BTC fee
 * addresses counts such ops from this node's event log, so a single forged
 * block shifts every later address on THIS node, permanently, and its users
 * would be sent to other orders' addresses.
 *
 * WHY NOT "COUNT ONLY OPS WHOSE SIGNATURE VERIFIES". Checked and rejected:
 * a signature proves the account's key signed the transaction, not that the
 * transaction was ever included in a block — an attacker signs an order op
 * with their OWN account's key and never broadcasts it; the hostile endpoint
 * serves it anyway and it verifies. (Keys at a past block are also only as
 * good as this node's own, possibly unconfirmed, key history.) So a signature
 * rule is neither sound nor deterministic.
 *
 * WHAT IS SOUND. Inclusion is what several operators' endpoints agree on. For a
 * block that holds a numbering-relevant op — a morphit_order_v1 op in
 * per-order-address mode (fee_method 'btc', no txid) while an xpub pin is in
 * force, any morphit_release_v1 op (it can move the pin) or any morphit_rpc_v1
 * op (it adds RPC nodes, each a quorum operator) — ask the RPC pool for the
 * same block and require TWO operators (counted by node name) to return exactly the same
 * transaction (id, content and signatures) at each such position as the block
 * being applied. A forged transaction, or a real one served with its
 * signatures stripped, does not survive that; a block that fails is not
 * applied (the error rolls the whole block back and the poller fetches it
 * again, normally from another endpoint).
 *
 * NEVER SINGLE-SOURCE when the pool has two operators or more. One reachable
 * operator out of several (a Tor or I2P blip on the others) is not a quorum:
 * the block waits until two agree, however long that takes — logged as an
 * error every MAX_UNCONFIRMED_ATTEMPTS tries so the operator sees a stall. It
 * used to be applied on one operator's word after a few tries, which is
 * exactly when a hostile node is the only one answering.
 *
 * The agreement is the trusted-read rule (BlurtClient majorityRead): at least
 * two operators agree and they are a majority of those that answered. A lone
 * disagreeing node cannot stall the indexer at every such block, and it
 * cannot confirm a block either. Two operators that agree on DIFFERENT
 * content from the block being applied prove that block is not the chain's.
 *
 * LIMITS, stated. (1) A pool with only ONE operator configured has nothing to
 * compare with and applies such blocks single-source (logged) — its operator
 * already trusts that node with everything; (2) a CENSORED block (a real op
 * withheld) looks like a block without such ops and is not caught here. The
 * browser's cross-check with other instances (btcFeeCrossCheck, V3-5) is the
 * backstop for the BTC numbering.
 */
import type pg from 'pg';

import type { BlockHeader, BlurtClient } from '$blurt/client';
import { logger } from '$log';
import { addressModePermlink, btcPinAt } from '$indexer/fee/btcFeeAddressIndex';

const log = logger('btc-fee-block-confirm');

/** Every this many failed attempts at reaching agreement for one block, the
 *  stall is logged as an error. The block is never applied single-source. */
export const MAX_UNCONFIRMED_ATTEMPTS = 5;

export class BlockNotConfirmedError extends Error {
	constructor(blockNum: number, why: string) {
		super(`block ${blockNum} not confirmed by two RPC operators (${why}); retrying`);
		this.name = 'BlockNotConfirmedError';
	}
}

type Trx = { operations?: unknown[] } & Record<string, unknown>;

function parseJson(s: unknown): unknown {
	if (typeof s !== 'string') return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/** Positions of transactions carrying a release or rpc-directory op (the
 *  official ops), and of those carrying an address-mode BTC order op. */
function relevantPositions(block: BlockHeader): { release: number[]; btcOrder: number[] } {
	const release: number[] = [];
	const btcOrder: number[] = [];
	const trxs = (block.transactions ?? []) as unknown as Trx[];
	trxs.forEach((t, i) => {
		let rel = false;
		let btc = false;
		for (const op of Array.isArray(t?.operations) ? t.operations : []) {
			if (!Array.isArray(op) || op[0] !== 'custom_json') continue;
			const body = op[1] as { id?: unknown; json?: unknown } | undefined;
			if (body?.id === 'morphit_release_v1' || body?.id === 'morphit_rpc_v1') rel = true;
			if (body?.id === 'morphit_order_v1' && addressModePermlink(parseJson(body.json)) !== null)
				btc = true;
		}
		if (rel) release.push(i);
		if (btc) btcOrder.push(i);
	});
	return { release, btcOrder };
}

/** Key-order-independent JSON, so two honest nodes' answers compare equal. */
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	if (v !== null && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(v ?? null);
}

/** What two honest nodes must agree on for the given positions. */
export function positionsKey(block: BlockHeader, positions: readonly number[]): string {
	const ids = (block.transaction_ids ?? []) as readonly string[];
	const trxs = (block.transactions ?? []) as unknown as readonly unknown[];
	return positions.map((i) => `${i}|${ids[i] ?? ''}|${canonical(trxs[i] ?? null)}`).join('\n');
}

const attempts = new Map<number, number>();

/**
 * Throws BlockNotConfirmedError when the block must not be applied yet.
 * Returns what was done, for logs and tests.
 */
export async function confirmFeeRelevantTransactions(
	client: pg.PoolClient,
	blurt: BlurtClient,
	blockNum: number,
	block: BlockHeader
): Promise<'none' | 'confirmed' | 'single_source'> {
	const { release, btcOrder } = relevantPositions(block);
	let positions = release;
	if (btcOrder.length > 0) {
		const pin = await btcPinAt(client, blockNum);
		if (pin?.xpub !== undefined)
			positions = [...new Set([...release, ...btcOrder])].sort((a, b) => a - b);
	}
	if (positions.length === 0) return 'none';

	let operators = 0;
	try {
		operators = blurt.operatorCount();
	} catch {
		operators = 0;
	}
	if (operators < 2) {
		log.warn('fee_relevant_block_single_source', { block: blockNum, operators });
		return 'single_source';
	}
	let local: string;
	try {
		local = positionsKey(block, positions);
	} catch {
		// Content no honest node serves (it cannot even be keyed): fetch again.
		throw new BlockNotConfirmedError(blockNum, 'served content cannot be compared');
	}
	let agreed: { key: string } | null = null;
	try {
		agreed = await blurt.condenserAgreed<BlockHeader>(
			'get_block',
			[blockNum],
			(b) => (b && Array.isArray(b.transactions) ? positionsKey(b, positions) : null),
			2
		);
	} catch {
		agreed = null;
	}
	if (agreed !== null && agreed.key === local) {
		attempts.delete(blockNum);
		return 'confirmed';
	}
	if (agreed !== null) {
		// Operators (counted by node name) agree on DIFFERENT content: the block we hold is
		// not the chain's. Never applied, however many times it comes back.
		log.error('fee_relevant_block_forged', { block: blockNum });
		throw new BlockNotConfirmedError(
			blockNum,
			'content differs from what operators (counted by node name) serve'
		);
	}
	const n = (attempts.get(blockNum) ?? 0) + 1;
	attempts.set(blockNum, n);
	if (attempts.size > 100) attempts.clear();
	if (n % MAX_UNCONFIRMED_ATTEMPTS === 0) {
		log.error('fee_relevant_block_unconfirmed', { block: blockNum, attempts: n });
	}
	throw new BlockNotConfirmedError(blockNum, 'no two operators agreed yet');
}
