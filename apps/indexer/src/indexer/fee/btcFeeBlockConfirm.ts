/**
 * Morphit indexer — confirm, before applying a block, that the transactions
 * which move the fee-address numbering (or the treasury pin) are REALLY in it
 * (v1.20.0, MK-H2 / V3-6), and since v1.21.14 the chat and inbox ops too
 * (CHAT_TRUST_OP_IDS, full chat audit S-H2).
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
 * NEVER SINGLE-SOURCE when the pool has two operators or more — except a block
 * whose only such ops are chat and inbox ops, after CHAT_QUORUM_WAIT_MS. One reachable
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

/**
 * How long a block whose ONLY such ops are chat and inbox ops waits for two
 * operators before it is applied on the word of the one that serves it
 * (logged as an error). Anyone can put a chat op in any block, so without a
 * bound a Tor or I2P outage of all but one operator would stop the indexing
 * of everything — orders, fees, trades — at the first block carrying one
 * (independent review of the audit fixes, finding 4). A chat op still carries
 * its account's signature; what the wait protects against is a lone node
 * serving a signed transaction that never made it into a block, which needs
 * that node to be the only one answering for this long. Blocks with release,
 * RPC-directory or numbered BTC order ops are never applied single-source.
 */
export const CHAT_QUORUM_WAIT_MS = 10 * 60 * 1000;

/**
 * The wait above is ONE budget per outage, not one per block (v1.21.14 review
 * A, F1). The poller applies blocks one after another, so a wait per chat block
 * cost N × 10 minutes for N chat blocks, and every order, trade and bid behind
 * them waited too: a node reaching one operator out of several fell further
 * behind every hour, without limit. Now, once a chat-only block has waited
 * CHAT_QUORUM_WAIT_MS and no two operators have agreed since, later chat-only
 * blocks are applied at once (each logged), and the pool is asked again at
 * most every OUTAGE_REPROBE_MS — not once per block, which would cost a read
 * timeout per block. The first quorum that answers ends the outage, and the
 * next unconfirmed chat block waits again. A process restart starts a new
 * outage (one more wait). Release, RPC-directory and numbered BTC blocks are
 * untouched: never single-source.
 */
export const OUTAGE_REPROBE_MS = 60 * 1000;

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

/**
 * The chat and inbox ops (v1.21.14 full chat audit, S-H2). The durable path
 * stores each of them as written BY THE ACCOUNT THE OP NAMES, and none of their
 * handlers can check that: a chat op's signature proves its key signed it, not
 * that it was ever in a block (see the header), and a key at a past block is
 * only as good as this node's own key history. So one hostile pool node could
 * serve a block carrying a message "from" anyone — permanent history, a forged
 * reply that opens the stranger-fee gate, a replaced chat key (a reader in the
 * middle), a forged block-list entry, a forged paid fee. Each is applied only
 * when two operators serve the same transaction at its position, like the
 * official ops.
 */
export const CHAT_TRUST_OP_IDS: ReadonlySet<string> = new Set([
	'morphit_chat_v1',
	'morphit_chat_read_v1',
	'morphit_chat_folders_v1',
	'morphit_chat_identity_v1',
	'morphit_stranger_fee_v1',
	'morphit_block_v1'
]);

/** Positions of transactions carrying a release or rpc-directory op (the
 *  official ops), of those carrying an address-mode BTC order op, and of those
 *  carrying a chat or inbox op. */
function relevantPositions(block: BlockHeader): {
	release: number[];
	btcOrder: number[];
	chat: number[];
} {
	const release: number[] = [];
	const btcOrder: number[] = [];
	const chat: number[] = [];
	const trxs = (block.transactions ?? []) as unknown as Trx[];
	trxs.forEach((t, i) => {
		let rel = false;
		let btc = false;
		let cht = false;
		for (const op of Array.isArray(t?.operations) ? t.operations : []) {
			if (!Array.isArray(op) || op[0] !== 'custom_json') continue;
			const body = op[1] as { id?: unknown; json?: unknown } | undefined;
			if (body?.id === 'morphit_release_v1' || body?.id === 'morphit_rpc_v1') rel = true;
			if (body?.id === 'morphit_order_v1' && addressModePermlink(parseJson(body.json)) !== null)
				btc = true;
			if (typeof body?.id === 'string' && CHAT_TRUST_OP_IDS.has(body.id)) cht = true;
		}
		if (rel) release.push(i);
		if (btc) btcOrder.push(i);
		if (cht) chat.push(i);
	});
	return { release, btcOrder, chat };
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
/** block → when this process first failed to confirm it (ms). */
const firstUnconfirmedAt = new Map<number, number>();
/** block → content two operators proved is NOT the chain's (positionsKey). */
const forgedSeen = new Map<number, Set<string>>();
/** When the current run of failed quorum reads began (null: none failing). */
let outageSince: number | null = null;
/** When the pool was last asked while the outage's wait is spent. */
let lastOutageProbeAt = 0;

/**
 * Quorum reads asked AHEAD of applying (v1.21.14 review A, F2). The poller
 * applies a window of blocks one after another, and each chat block's
 * second-operator read waited inside that loop: one round trip per block
 * (about a second over a hidden-service RPC), so a node catching up — or a
 * junk chat op in every block — crawled at a block per round trip. The poller
 * now hands each fetched window here first; the reads run PREFETCH_IN_FLIGHT
 * at a time, and confirmFeeRelevantTransactions uses the answer for the same
 * block and positions instead of asking again. Not while an outage's wait is
 * spent (OUTAGE_REPROBE_MS keeps those reads rare), and not for blocks with
 * an address-mode BTC order (whether they count depends on the pin in force).
 */
export const PREFETCH_IN_FLIGHT = 8;
const PREFETCH_MAX = 200;
const prefetched = new Map<
	number,
	{ readonly sig: string; readonly result: Promise<{ key: string } | null> }
>();

export function prefetchBlockConfirmations(
	blurt: BlurtClient,
	firstBlockNum: number,
	blocks: readonly (BlockHeader | null | undefined)[],
	nowMs: number = Date.now()
): void {
	if (outageSince !== null && nowMs - outageSince >= CHAT_QUORUM_WAIT_MS) return;
	let operators = 0;
	try {
		operators = blurt.operatorCount();
	} catch {
		return;
	}
	if (operators < 2) return;
	const jobs: { n: number; positions: number[]; resolve: (v: { key: string } | null) => void }[] =
		[];
	blocks.forEach((b, i) => {
		if (!b) return;
		const n = firstBlockNum + i;
		if (prefetched.has(n)) return;
		const { release, btcOrder, chat } = relevantPositions(b);
		if (btcOrder.length > 0) return;
		const positions = [...new Set([...release, ...chat])].sort((x, y) => x - y);
		if (positions.length === 0) return;
		let resolve: (v: { key: string } | null) => void = () => undefined;
		const result = new Promise<{ key: string } | null>((r) => (resolve = r));
		prefetched.set(n, { sig: positions.join(','), result });
		jobs.push({ n, positions, resolve });
	});
	while (prefetched.size > PREFETCH_MAX) {
		const oldest = prefetched.keys().next().value;
		if (oldest === undefined) break;
		prefetched.delete(oldest);
	}
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < jobs.length) {
			const j = jobs[next++];
			if (j === undefined) break;
			try {
				j.resolve(
					await blurt.condenserAgreed<BlockHeader>(
						'get_block',
						[j.n],
						(b) => (b && Array.isArray(b.transactions) ? positionsKey(b, j.positions) : null),
						2
					)
				);
			} catch {
				j.resolve(null);
			}
		}
	};
	for (let w = 0; w < Math.min(PREFETCH_IN_FLIGHT, jobs.length); w++) void worker();
}

/**
 * Throws BlockNotConfirmedError when the block must not be applied yet.
 * Returns what was done, for logs and tests.
 */
export async function confirmFeeRelevantTransactions(
	client: pg.PoolClient,
	blurt: BlurtClient,
	blockNum: number,
	block: BlockHeader,
	nowMs: number = Date.now()
): Promise<'none' | 'confirmed' | 'single_source'> {
	const { release, btcOrder, chat } = relevantPositions(block);
	let positions = [...new Set([...release, ...chat])];
	/** Numbered BTC order positions that matter here (an xpub pin in force). */
	let numbered: number[] = [];
	if (btcOrder.length > 0) {
		const pin = await btcPinAt(client, blockNum);
		if (pin?.xpub !== undefined) {
			numbered = btcOrder;
			positions = [...new Set([...positions, ...btcOrder])];
		}
	}
	positions.sort((a, b) => a - b);
	if (positions.length === 0) return 'none';

	let operators = 0;
	try {
		operators = blurt.operatorCount();
	} catch {
		operators = 0;
	}
	// Chat-only: no release or RPC-directory op, and no transaction that ALSO
	// carries a numbered BTC order (one transaction can hold both — independent
	// review 2, finding 7).
	const onlyChat =
		release.length === 0 && positions.every((i) => chat.includes(i) && !numbered.includes(i));
	if (operators < 2) {
		// Said once per block that moves money or the pool; a chat block on a
		// one-operator pool is the ordinary case there and is not repeated in the
		// log at message rate.
		if (!onlyChat) log.warn('fee_relevant_block_single_source', { block: blockNum, operators });
		return 'single_source';
	}
	let local: string;
	try {
		local = positionsKey(block, positions);
	} catch {
		// Content no honest node serves (it cannot even be keyed): fetch again.
		throw new BlockNotConfirmedError(blockNum, 'served content cannot be compared');
	}
	// Asked ahead for this very block and these positions (review A, F2).
	const pre = prefetched.get(blockNum);
	prefetched.delete(blockNum);
	const preResult = pre !== undefined && pre.sig === positions.join(',') ? pre.result : undefined;
	// The outage's wait is spent (see OUTAGE_REPROBE_MS): a chat-only block is
	// applied at once, and the pool is asked again only once a minute.
	const outageSpent =
		onlyChat &&
		outageSince !== null &&
		nowMs - outageSince >= CHAT_QUORUM_WAIT_MS &&
		!forgedSeen.get(blockNum)?.has(local);
	if (preResult === undefined && outageSpent && nowMs - lastOutageProbeAt < OUTAGE_REPROBE_MS) {
		log.error('chat_block_single_source_after_wait', { block: blockNum, attempts: 0 });
		return 'single_source';
	}
	if (outageSpent && preResult === undefined) lastOutageProbeAt = nowMs;
	let agreed: { key: string } | null = null;
	try {
		agreed =
			preResult !== undefined
				? await preResult
				: await blurt.condenserAgreed<BlockHeader>(
						'get_block',
						[blockNum],
						(b) => (b && Array.isArray(b.transactions) ? positionsKey(b, positions) : null),
						2
					);
	} catch {
		agreed = null;
	}
	// Two operators answered alike: whatever their answer, the outage is over.
	if (agreed !== null) outageSince = null;
	if (agreed !== null && agreed.key === local) {
		attempts.delete(blockNum);
		firstUnconfirmedAt.delete(blockNum);
		return 'confirmed';
	}
	if (agreed !== null) {
		// Operators (counted by node name) agree on DIFFERENT content: the block we hold is
		// not the chain's. Never applied, however many times it comes back.
		log.error('fee_relevant_block_forged', { block: blockNum });
		// Remembered: this content is never applied on one operator's word later.
		if (forgedSeen.size > 100) forgedSeen.clear();
		const set = forgedSeen.get(blockNum) ?? new Set<string>();
		set.add(local);
		forgedSeen.set(blockNum, set);
		throw new BlockNotConfirmedError(
			blockNum,
			'content differs from what operators (counted by node name) serve'
		);
	}
	const n = (attempts.get(blockNum) ?? 0) + 1;
	attempts.set(blockNum, n);
	if (attempts.size > 100) attempts.clear();
	if (firstUnconfirmedAt.size > 100) firstUnconfirmedAt.clear();
	const first = firstUnconfirmedAt.get(blockNum) ?? nowMs;
	firstUnconfirmedAt.set(blockNum, first);
	if (outageSince === null) outageSince = first;
	if (
		onlyChat &&
		nowMs - outageSince >= CHAT_QUORUM_WAIT_MS &&
		!forgedSeen.get(blockNum)?.has(local)
	) {
		attempts.delete(blockNum);
		firstUnconfirmedAt.delete(blockNum);
		log.error('chat_block_single_source_after_wait', { block: blockNum, attempts: n });
		return 'single_source';
	}
	if (n % MAX_UNCONFIRMED_ATTEMPTS === 0) {
		log.error('fee_relevant_block_unconfirmed', { block: blockNum, attempts: n });
	}
	throw new BlockNotConfirmedError(blockNum, 'no two operators agreed yet');
}

/** Test seam: forget every attempt, outage and forged-content memory. */
export function _resetBlockConfirmForTest(): void {
	attempts.clear();
	firstUnconfirmedAt.clear();
	forgedSeen.clear();
	outageSince = null;
	lastOutageProbeAt = 0;
	prefetched.clear();
}
