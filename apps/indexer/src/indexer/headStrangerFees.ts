/**
 * Stranger fees seen at the chain HEAD (v1.21.14 full chat audit, S-H3).
 *
 * WHY. A first contact without an order needs the stranger fee. The sender
 * pays it, then writes. The durable handler records the fee only once its
 * block is irreversible, 45-63 s later, and until then the fast-notify gate
 * had nothing to go on: the paid "new chatroom request" reached the
 * recipient's inbox and their phone only at durable time — exactly the
 * message the fee exists to let through.
 *
 * WHAT. The head tailer hands every head-block `morphit_stranger_fee_v1` op
 * here. It is recognised only when:
 *   - the transaction is signed by the payer's ACTIVE authority (a transfer
 *     needs it), checked against keys two RPC operators agree on — a head
 *     block is one endpoint's word, and its signatures are the part that
 *     endpoint cannot forge;
 *   - the durable handler's own check (`evaluateStrangerFee`) passes on it:
 *     same quote, same legs, same memo.
 * Then (payer → recipient) is remembered IN MEMORY for FEE_SEEN_TTL_MS, which
 * comfortably covers the durable lag. Nothing is written: the durable handler
 * remains the only writer of `stranger_fees`.
 *
 * Bounded: FEE_SEEN_MAX pairs, and at most ACTIVE_READS_PER_MIN quorum reads a
 * minute (a fee op costs its payer real BLURT, so this is a ceiling, not a
 * budget anyone reaches).
 */

import type { BlockTransaction } from '$blurt/client';
import type { Queryable } from '$indexer/strangerFeePricing';
import { evaluateStrangerFee } from '$indexer/handlers/strangerFee';
import { STRANGER_FEE_WINDOW_MINUTES } from '$indexer/strangerFeePricing';

export const FEE_SEEN_TTL_MS = 15 * 60 * 1000;
export const FEE_SEEN_MAX = 5_000;
export const ACTIVE_READS_PER_MIN = 30;

const seen = new Map<string, number>();
const readTimes: number[] = [];
/** payer → the fee ops of theirs seen at the head (block time, ms), so the
 *  price escalation counts fees the durable table does not hold yet. One the
 *  head found invalid is taken out again; one whose outcome is unknown stays
 *  (counted: the head is then stricter, never looser, than the durable path). */
const headFeeTimes = new Map<string, HeadFeeEntry[]>();
/** A head fee op: its block time (ms), block and transaction (v1.21.14 review
 *  A, F5: the block says whether the durable table holds it already, the
 *  transaction that it is the same fee seen again). */
interface HeadFeeEntry {
	readonly t: number;
	readonly blockNum: number;
	readonly trxId: string;
}
const ESCALATION_WINDOW_MS = STRANGER_FEE_WINDOW_MINUTES * 60_000;

const pairKey = (payer: string, recipient: string): string => `${payer}\u0000${recipient}`;

/** Has `payer` paid a valid stranger fee for `recipient`, seen at the head? */
export function hasHeadStrangerFee(
	payer: string,
	recipient: string,
	now: number = Date.now()
): boolean {
	const at = seen.get(pairKey(payer, recipient));
	if (at === undefined) return false;
	if (now - at > FEE_SEEN_TTL_MS) {
		seen.delete(pairKey(payer, recipient));
		return false;
	}
	return true;
}

type FeeListener = (payer: string, recipient: string) => void;
const listeners = new Set<FeeListener>();

/** Called each time a fee is recognised (parkedFirstContacts.ts releases the
 *  messages that reached this instance before their fee did). */
export function onHeadStrangerFee(listener: FeeListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function remember(payer: string, recipient: string, now: number): void {
	const k = pairKey(payer, recipient);
	seen.delete(k);
	seen.set(k, now);
	while (seen.size > FEE_SEEN_MAX) {
		const oldest = seen.keys().next().value;
		if (oldest === undefined) break;
		seen.delete(oldest);
	}
	for (const l of Array.from(listeners)) {
		try {
			l(payer, recipient);
		} catch {
			// A listener never breaks recognition.
		}
	}
}

/** Test seam. */
export function _resetHeadStrangerFeesForTest(): void {
	seen.clear();
	readTimes.length = 0;
	headFeeTimes.clear();
}

/** Record a head fee op of `payer`; return how many OTHER ones of theirs fall
 *  in the escalation window before it and are NOT in the durable table yet
 *  (blocks after `durableBlock`; review A, F5 — counting one that had become
 *  durable counted it twice, and a correctly paid fee was refused at the head),
 *  and the entry (to take out again if this one turns out invalid). Bounded
 *  per payer. */
function priorHeadFees(
	payer: string,
	blockMs: number,
	blockNum: number,
	trxId: string,
	durableBlock: number | null
): { prior: number; entry: HeadFeeEntry } {
	const list = (headFeeTimes.get(payer) ?? []).filter(
		(e) => e.t > blockMs - ESCALATION_WINDOW_MS - 60_000 && e.t <= blockMs + 60_000
	);
	const prior = list.filter(
		(e) =>
			e.t > blockMs - ESCALATION_WINDOW_MS &&
			e.t <= blockMs &&
			(trxId === '' || e.trxId !== trxId) &&
			(durableBlock === null || e.blockNum > durableBlock)
	).length;
	const seenBefore = trxId !== '' ? list.find((e) => e.trxId === trxId) : undefined;
	const entry = seenBefore ?? { t: blockMs, blockNum, trxId };
	if (seenBefore === undefined) list.push(entry);
	if (headFeeTimes.size > FEE_SEEN_MAX && !headFeeTimes.has(payer)) {
		const oldest = headFeeTimes.keys().next().value;
		if (oldest !== undefined) headFeeTimes.delete(oldest);
	}
	headFeeTimes.set(payer, list.slice(-64));
	return { prior, entry };
}

/** The last block the durable path applied, or null when unknown. */
async function durableCursor(db: Queryable): Promise<number | null> {
	try {
		const r = await db.query<{ n: string }>(
			'SELECT last_applied_block::text AS n FROM indexer_state WHERE id = 1',
			[]
		);
		const n = Number(r.rows[0]?.n);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

/** Does the transaction carry the fee's transfer from `payer` to the fee
 *  account, with a stranger memo? Checked before anything else (review A, F8):
 *  a fee-shaped op without one cannot pass, and must not cost a query. */
function hasFeeTransfer(trx: BlockTransaction, payer: string, feeRecipient: string): boolean {
	for (const op of (trx.operations ?? []) as unknown[]) {
		if (!Array.isArray(op) || op[0] !== 'transfer') continue;
		const t = op[1] as { from?: unknown; to?: unknown; memo?: unknown } | undefined;
		if (
			t?.from === payer &&
			t?.to === feeRecipient &&
			typeof t.memo === 'string' &&
			t.memo.startsWith('morphit-stranger:')
		)
			return true;
	}
	return false;
}

function forgetHeadFee(payer: string, entry: HeadFeeEntry): void {
	const list = headFeeTimes.get(payer);
	if (list === undefined) return;
	const i = list.indexOf(entry);
	if (i >= 0) list.splice(i, 1);
}

/** Is this op shaped like a stranger-fee op (worth queueing for
 *  noteHeadStrangerFee)? A cheap test the tailer runs on every head op. */
export function looksLikeStrangerFeeOp(op: unknown): boolean {
	return (
		Array.isArray(op) &&
		op[0] === 'custom_json' &&
		(op[1] as { id?: unknown } | undefined)?.id === 'morphit_stranger_fee_v1'
	);
}

/** Does `trx` carry a signature by `account`'s ACTIVE authority, as two RPC
 *  operators agree it stands? Injected; main.ts wires a quorum read. */
export type ActiveSignerCheck = (trx: BlockTransaction, account: string) => Promise<boolean>;

function readAllowed(now: number): boolean {
	while (readTimes.length > 0 && (readTimes[0] ?? 0) <= now - 60_000) readTimes.shift();
	if (readTimes.length >= ACTIVE_READS_PER_MIN) return false;
	readTimes.push(now);
	return true;
}

export interface HeadFeeContext {
	readonly blockNum: number;
	readonly blockTime: Date;
	readonly feeRecipient: string;
	readonly feeTolerance: number;
	/** The transaction's id (recomputed from its content). */
	readonly trxId?: string;
	/** The first block of the tailer's current unbroken run (0: unknown). A fee
	 *  is not recognised while blocks between the durable cursor and this one
	 *  are unseen by both (review A, F5: after a restart, an earlier fee there
	 *  was counted nowhere, so an underpaid one was announced). */
	readonly coveredFrom?: number;
}

/**
 * Look at one head-block op. Recognises a valid stranger fee and remembers it;
 * anything else — a different op, a bad signature, a fee the durable handler
 * would refuse, a database error — is ignored. Never throws.
 */
export async function noteHeadStrangerFee(
	db: Queryable,
	trx: BlockTransaction,
	op: readonly [string, unknown],
	ctx: HeadFeeContext,
	signedByActive: ActiveSignerCheck,
	now: number = Date.now()
): Promise<boolean> {
	try {
		const [name, body] = op;
		if (name !== 'custom_json' || typeof body !== 'object' || body === null) return false;
		const b = body as { id?: unknown; json?: unknown; required_auths?: unknown };
		if (b.id !== 'morphit_stranger_fee_v1' || typeof b.json !== 'string') return false;
		const auths = Array.isArray(b.required_auths) ? b.required_auths : [];
		const payer = auths.length === 1 && typeof auths[0] === 'string' ? auths[0] : null;
		if (payer === null) return false;
		let payload: unknown;
		try {
			payload = JSON.parse(b.json);
		} catch {
			return false;
		}
		const recipient =
			typeof payload === 'object' && payload !== null
				? (payload as { recipient?: unknown }).recipient
				: undefined;
		if (typeof recipient !== 'string') return false;
		if (hasHeadStrangerFee(payer, recipient, now)) return true;
		if (!hasFeeTransfer(trx, payer, ctx.feeRecipient)) return false;
		const durable = await durableCursor(db);
		const from = ctx.coveredFrom ?? 0;
		if (durable !== null && from > 0 && from > durable + 1) return false;
		// The escalation counts this payer's OTHER head fees too: the durable
		// table does not hold them yet, and a quote that missed them would be
		// lower than the durable handler's — a fee the head accepted and the
		// chain's indexers then refuse. Counting one twice (it became durable
		// meanwhile) only makes the head stricter; the durable path decides.
		const { prior: extraRecentFees, entry } = priorHeadFees(
			payer,
			ctx.blockTime.getTime(),
			ctx.blockNum,
			ctx.trxId ?? '',
			durable
		);
		const verdict = await evaluateStrangerFee(db, {
			signer: payer,
			payload,
			siblingOps: trx.operations as never,
			blockNum: ctx.blockNum,
			blockTime: ctx.blockTime,
			feeRecipient: ctx.feeRecipient,
			feeTolerance: ctx.feeTolerance,
			extraRecentFees
		});
		if (!verdict.ok) {
			forgetHeadFee(payer, entry);
			return false;
		}
		if (!readAllowed(now)) return false;
		if (!(await signedByActive(trx, payer))) {
			forgetHeadFee(payer, entry);
			return false;
		}
		remember(payer, recipient, now);
		return true;
	} catch {
		return false;
	}
}
