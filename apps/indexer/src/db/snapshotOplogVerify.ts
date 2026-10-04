/**
 * apps/indexer/src/db/snapshotOplogVerify.ts
 *
 * Tier-2 snapshot hardening — the PURE core.
 *
 * A federated snapshot is already signed (@morphit) + sha256-gated (three-way) +
 * tail-re-verified. This adds one more, cheap layer against the residual threat
 * of a snapshot signed by a COMPROMISED publisher key: spot-check that the
 * snapshot's source-of-truth op log (`ops`) actually matches the CHAIN, and that
 * sampled rows of the derived tables have a source there: an `orders` row its
 * creating op, an `accounts` row its creating chain op.
 *
 * It is a SPOT CHECK. The sample is drawn with a CSPRNG over the whole range
 * (plus the newest ops, where a forged live listing pays off), so a forger
 * cannot know where it looks; but a forgery confined to a few rows still
 * passes with high probability. A pass lowers the odds of fabricated data, it
 * does not prove its absence. Any sampled mismatch → quarantine.
 *
 * This file is PURE (no DB, no network; randomness is injected): unit-tested by
 * scripts/snapshot-oplog-verify-smoke.ts. The runner (snapshot-verify-oplog.ts)
 * supplies the DB rows, the fetched blocks and node:crypto's randomInt. Fails
 * CLOSED: an ambiguous match is a MISMATCH.
 */

/** A recorded op from the snapshot's `ops` table, with just what we need to
 *  locate + match it against the chain. */
import { ACTIVE_AUTH_OP_IDS, extractSigner } from '$blurt/verify';

export interface StoredOpRef {
	readonly blockNum: number;
	readonly trxInBlock: number;
	readonly opInTrx: number;
	readonly signer: string;
	readonly opId: string;
	/** payload->>'permlink' when present (order/content ops); null otherwise.
	 *  When present it is the STRONGEST discriminator — a fabricated order can't
	 *  point at a real on-chain op carrying its own permlink. */
	readonly permlink: string | null;
}

/** Minimal shape of a chain block (matches BlurtClient.getBlock output). */
export interface BlockLike {
	readonly transactions?: ReadonlyArray<{
		readonly operations?: ReadonlyArray<readonly [string, unknown] | undefined>;
	}>;
}

export interface OpMatchResult {
	readonly ok: boolean;
	readonly reason?: string;
}

/**
 * Does `block` contain `stored` at its recorded (trxInBlock, opInTrx) position,
 * as a custom_json with the same op id, signed by the same account under the
 * DISPATCHER'S OWN signer rule, and — when the stored op has a permlink —
 * carrying that same permlink? Pure + fail-closed: anything missing/ambiguous is
 * a MISMATCH.
 *
 * The signer rule is `extractSigner` itself (v1.20.0, V3-7). This used to check
 * `required_posting_auths` only — but BLURT-paid orders, feature bids and
 * stranger fees are signed with ACTIVE authority (`required_auths`), so every
 * honest snapshot holding one was declared a mismatch and QUARANTINED. The
 * applied rows this samples are exactly the ones extractSigner accepted, so the
 * same function is the only rule that can agree with them.
 */
export function verifyStoredOpAgainstBlock(stored: StoredOpRef, block: BlockLike | null): OpMatchResult {
	if (!block || !Array.isArray(block.transactions)) return { ok: false, reason: 'block missing or has no transactions' };
	const trx = block.transactions[stored.trxInBlock];
	if (!trx || !Array.isArray(trx.operations)) return { ok: false, reason: 'no transaction at recorded position' };
	const op = trx.operations[stored.opInTrx];
	if (!op || !Array.isArray(op) || op.length < 2) return { ok: false, reason: 'no operation at recorded position' };
	const [opName, opBody] = op;
	if (opName !== 'custom_json') return { ok: false, reason: `op at position is '${String(opName)}', not custom_json` };
	if (!opBody || typeof opBody !== 'object') return { ok: false, reason: 'custom_json body malformed' };
	const body = opBody as Record<string, unknown>;
	if (body.id !== stored.opId) return { ok: false, reason: `op id mismatch (chain '${String(body.id)}' ≠ recorded '${stored.opId}')` };

	// An absent auth list is an empty one — exactly how the dispatcher reads the
	// op (collectMorphitOps) before it calls extractSigner.
	const signer = extractSigner(
		{
			required_auths: Array.isArray(body.required_auths) ? (body.required_auths as string[]) : [],
			required_posting_auths: Array.isArray(body.required_posting_auths)
				? (body.required_posting_auths as string[])
				: [],
			id: stored.opId,
			json: typeof body.json === 'string' ? body.json : ''
		},
		ACTIVE_AUTH_OP_IDS.has(stored.opId)
	);
	if (!signer.ok) {
		return { ok: false, reason: `the on-chain op has no signer the dispatcher accepts (${signer.reason})` };
	}
	if (signer.signer !== stored.signer) {
		return {
			ok: false,
			reason: `signer mismatch (chain '${signer.signer}' ≠ recorded '${stored.signer}')`
		};
	}

	if (stored.permlink !== null) {
		if (typeof body.json !== 'string') return { ok: false, reason: 'on-chain op has no json to match permlink against' };
		let parsed: unknown;
		try {
			parsed = JSON.parse(body.json);
		} catch {
			return { ok: false, reason: 'on-chain op json did not parse' };
		}
		const chainPermlink =
			parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).permlink : undefined;
		if (chainPermlink !== stored.permlink) {
			return { ok: false, reason: `permlink mismatch (chain '${String(chainPermlink)}' ≠ recorded '${stored.permlink}')` };
		}
	}
	return { ok: true };
}

/** A uniform random integer in [0, maxExclusive). The runner passes
 *  node:crypto's randomInt: the sample must not be predictable, or a forger
 *  simply fabricates where the sampler never looks. */
export type RandomInt = (maxExclusive: number) => number;

/** `k` distinct indices in [0, n), uniformly at random (Floyd's algorithm),
 *  ascending. PURE given `randomInt`. */
export function randomDistinctIndices(n: number, k: number, randomInt: RandomInt): number[] {
	const want = Math.max(0, Math.min(Math.floor(k), Math.floor(n)));
	const chosen = new Set<number>();
	for (let j = n - want; j < n; j++) {
		const t = randomInt(j + 1);
		chosen.add(chosen.has(t) ? j : t);
	}
	return [...chosen].sort((a, b) => a - b);
}

/** `n` random block heights in [minBlock, maxBlock] (repeats allowed — the
 *  runner takes the first applied op at or after each). PURE given `randomInt`. */
export function pickBlockTargets(
	minBlock: number,
	maxBlock: number,
	n: number,
	randomInt: RandomInt
): number[] {
	if (n <= 0 || maxBlock < minBlock) return [];
	const span = maxBlock - minBlock + 1;
	return Array.from({ length: n }, () => minBlock + randomInt(span)).sort((a, b) => a - b);
}

/** How many sampled ops the newest-first part takes: a quarter of the sample
 *  (at least one) — the live-order tail, where a forgery pays off. */
export function newestShare(samples: number): number {
	return Math.max(1, Math.floor(samples / 4));
}

/** Account-creating ops, as the dispatcher records them into `accounts`. */
const ACCOUNT_CREATE_OPS = new Set([
	'account_create',
	'account_create_with_delegation',
	'create_claimed_account'
]);

/**
 * Was account `name` created in `block` — an account-creating op naming it,
 * in the transaction whose id is `createdTrxId` when the block lists its
 * transaction ids? PURE, fail-closed.
 */
export function verifyAccountCreatedInBlock(
	name: string,
	createdTrxId: string,
	block: (BlockLike & { readonly transaction_ids?: readonly string[] }) | null
): OpMatchResult {
	if (!block || !Array.isArray(block.transactions)) return { ok: false, reason: 'block missing or has no transactions' };
	for (let ti = 0; ti < block.transactions.length; ti++) {
		const ops = block.transactions[ti]?.operations;
		if (!Array.isArray(ops)) continue;
		for (const op of ops) {
			if (!Array.isArray(op) || !ACCOUNT_CREATE_OPS.has(String(op[0]))) continue;
			const body = op[1] as { new_account_name?: unknown } | undefined;
			if (body?.new_account_name !== name) continue;
			const ids = block.transaction_ids;
			if (Array.isArray(ids) && ids[ti] !== undefined && ids[ti] !== createdTrxId) {
				return { ok: false, reason: `created in transaction ${ids[ti]}, recorded ${createdTrxId}` };
			}
			return { ok: true };
		}
	}
	return { ok: false, reason: 'no account-creating op for this name in its recorded block' };
}

/** Below this share of the sample actually checked against the chain (the
 *  rest unreachable), a run proves too little to call the snapshot verified. */
export const MIN_VERIFIED_FRACTION = 0.8;

export type OplogVerdict = 'verified' | 'quarantine' | 'inconclusive';

/** Fail closed: any mismatch quarantines; too little checked is inconclusive. */
export function oplogVerdict(c: {
	readonly sampled: number;
	readonly verified: number;
	readonly failures: number;
}): OplogVerdict {
	if (c.failures > 0) return 'quarantine';
	if (c.sampled === 0 || c.verified < Math.ceil(c.sampled * MIN_VERIFIED_FRACTION)) return 'inconclusive';
	return 'verified';
}
