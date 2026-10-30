/**
 * The fee numbers every indexer judges a fee by, from the consensus
 * activation time (consensusActivation.ts, by the op's BLOCK time).
 *
 * What was wrong: inputs to a fee verdict were this node's own, not the
 * chain's, so two indexers fed the same blocks could store different verdicts:
 *   - the tolerance band (MORPHIT_INDEXER_FEE_TOLERANCE, default 0.001; an
 *     operator may set it up to 0.5): stranger fees and feature bids accepted
 *     within it, and the listing fee within max(it, FEE_PRICE_TOLERANCE);
 *   - the BLURT listing-fee base: the poller's current treasury snapshot (the
 *     newest release this node has seen, cached 30 s), not the pin in force at
 *     the order's block — a rebuild or catch-up after a re-pin judged old
 *     orders by the new base — and, with no pin, this node's env value
 *     (MORPHIT_INDEXER_FEE_BASE_BLURT);
 *   - the BTC / XMR fee amount: the same current snapshot, and whether this
 *     node checks that method at all;
 *   - the featured-slot price (MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR).
 * (Who may be paid the owner leg is the same kind of input: feeRecipients.ts.)
 *
 * From the activation time:
 *   - the tolerance is FEDERATION_FEE_TOLERANCE, the shipped default; the
 *     listing-fee band is therefore max(0.001, FEE_PRICE_TOLERANCE) = 0.15,
 *     exactly what a default node already used;
 *   - the BLURT base is the one pinned by the newest valid release broadcast in
 *     an EARLIER block (a release takes effect from the next block, like the
 *     BTC xpub and XMR primary-address pins), and FEDERATION_BLURT_BASE, the
 *     shipped default, when that release pins none;
 *   - the BTC / XMR amount is the one that same release pins; with none pinned
 *     the order handler refuses the order on every node alike;
 *   - the featured-slot price is FEDERATION_FEATURE_FEE_BLURT_PER_HOUR.
 * Before the activation time every caller keeps exactly its old inputs, so
 * history keeps the verdicts every node already recorded.
 *
 * Intake (the order, stranger-fee and feature-bid handlers, the head tailer)
 * and every re-derivation (blurtFeeReverify, externalFeeRecheck,
 * reconcileUpgrade) read the numbers here, so they reach the same verdict
 * whenever they run.
 */

import { consensusV2Active } from '$indexer/consensusActivation';

/** Minimal query surface (PoolClient inside a handler, Database outside). */
interface Queryable {
	query<R extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<import('pg').QueryResult<R>>;
}

/** The fee tolerance every indexer applies from the activation time: the
 *  shipped default of MORPHIT_INDEXER_FEE_TOLERANCE (config/index.ts). */
export const FEDERATION_FEE_TOLERANCE = 0.001;

/** The BLURT listing-fee base when no release pins one, from the activation
 *  time: the shipped default of MORPHIT_INDEXER_FEE_BASE_BLURT (config/index.ts),
 *  the canonical floor the release ceremony pins. */
export const FEDERATION_BLURT_BASE = 125;

/** The featured-slot price, BLURT per hour, from the activation time: the
 *  shipped default of MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR
 *  (config/index.ts). */
export const FEDERATION_FEATURE_FEE_BLURT_PER_HOUR = 50;

/** The featured-slot price for a bid in a block stamped `blockTime`: this
 *  node's setting before the activation time, the federation's from it. */
export function featureFeeBlurtPerHourAt(blockTime: Date, nodePrice: number): number {
	return consensusV2Active(blockTime) ? FEDERATION_FEATURE_FEE_BLURT_PER_HOUR : nodePrice;
}

/** The tolerance for a fee in a block stamped `blockTime`: this node's setting
 *  before the activation time, the federation's from it. */
export function feeToleranceAt(blockTime: Date, nodeTolerance: number): number {
	return consensusV2Active(blockTime) ? FEDERATION_FEE_TOLERANCE : nodeTolerance;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The treasury block of the newest valid release broadcast in a block before
 *  `blockNum` — the pin in force for an op in `blockNum` — or null. Chain data
 *  only (the same query as btcPinAt and xmrPrimaryAt). */
export async function treasuryPinAt(db: Queryable, blockNum: number): Promise<unknown> {
	const res = await db.query<{ treasury: unknown }>(
		`SELECT treasury FROM releases
		  WHERE valid = true AND treasury IS NOT NULL AND source_block_num < $1
		  ORDER BY source_block_num DESC, id DESC
		  LIMIT 1`,
		[blockNum]
	);
	return res.rows[0]?.treasury ?? null;
}

/** The BLURT base a treasury block pins, or null. */
export function blurtBaseOf(treasury: unknown): number | null {
	if (!isPlainObject(treasury) || !isPlainObject(treasury.blurt)) return null;
	const base = treasury.blurt.base;
	return typeof base === 'number' && Number.isFinite(base) && base > 0 ? base : null;
}

/** The BTC satoshis / XMR piconero a treasury block pins, or undefined. */
export function externalFeeAmountOf(
	treasury: unknown,
	method: 'btc' | 'xmr'
): number | bigint | undefined {
	if (!isPlainObject(treasury)) return undefined;
	if (method === 'btc') {
		const b = treasury.btc;
		if (!isPlainObject(b)) return undefined;
		const s = b.satoshis;
		return typeof s === 'number' && Number.isSafeInteger(s) && s > 0 ? s : undefined;
	}
	const x = treasury.xmr;
	if (!isPlainObject(x)) return undefined;
	const p = x.piconero;
	if (typeof p !== 'string' || !/^[0-9]{1,30}$/.test(p)) return undefined;
	const v = BigInt(p);
	return v > 0n ? v : undefined;
}

/** What a BLURT listing fee is judged by (fee.ts listingFeeStatus). */
export interface ListingFeeInputs {
	readonly baseBlurt: number;
	readonly feeTolerance: number;
}

/**
 * The listing-fee base and tolerance for an order op at `at`. Before the
 * activation time: `legacy()`, each caller's old inputs. From it: the base
 * pinned in force at the block (FEDERATION_BLURT_BASE when none) and
 * FEDERATION_FEE_TOLERANCE.
 */
export async function listingFeeInputsAt(
	db: Queryable,
	at: { readonly blockNum: number; readonly blockTime: Date },
	legacy: () => ListingFeeInputs | Promise<ListingFeeInputs>
): Promise<ListingFeeInputs> {
	if (!consensusV2Active(at.blockTime)) return legacy();
	return {
		baseBlurt: blurtBaseOf(await treasuryPinAt(db, at.blockNum)) ?? FEDERATION_BLURT_BASE,
		feeTolerance: FEDERATION_FEE_TOLERANCE
	};
}
