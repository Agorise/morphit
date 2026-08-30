/**
 * apps/indexer/src/db/snapshotOplogVerify.ts  (cp767)
 *
 * Tier-2 snapshot hardening — the PURE core.
 *
 * A federated snapshot is already signed (@morphit) + sha256-gated (three-way) +
 * tail-re-verified. This adds one more, cheap layer against the residual threat
 * of a snapshot signed by a COMPROMISED publisher key: spot-check that the
 * snapshot's source-of-truth op log (`ops`) actually matches the CHAIN. Every
 * derived view (orderbook, profiles, reputation) is produced from that op log by
 * this same code, so if a representative SAMPLE of recorded ops is genuinely on
 * the chain at the recorded position, the derived state is trustworthy; if any
 * sampled op is absent/altered, the snapshot fabricated data → quarantine.
 *
 * This file is PURE (no DB, no network): the sampling + the position-based match
 * are unit-tested. The runner (snapshot-verify-oplog.ts) supplies the DB rows +
 * the fetched blocks. Fails CLOSED: an ambiguous match is a MISMATCH.
 */

/** A recorded op from the snapshot's `ops` table, with just what we need to
 *  locate + match it against the chain. */
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
 * as a custom_json with the same op id, signed (posting auth) by the same
 * account, and — when the stored op has a permlink — carrying that same permlink?
 * Pure + fail-closed: anything missing/ambiguous is a MISMATCH.
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

	const auths = Array.isArray(body.required_posting_auths) ? body.required_posting_auths : [];
	if (!auths.includes(stored.signer)) {
		return { ok: false, reason: `signer '${stored.signer}' not in the on-chain op's posting auths` };
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

/**
 * Pick up to `k` refs to verify, spread across the block range so a tamperer
 * can't hide fabrication in a corner: sort by block, always include the newest
 * few (most likely to back LIVE orders), then evenly sample the rest. Rows that
 * carry a permlink are preferred (strongest discriminator). Pure + deterministic.
 */
export function pickVerificationSample(rows: readonly StoredOpRef[], k: number): StoredOpRef[] {
	if (k <= 0 || rows.length === 0) return [];
	if (rows.length <= k) return [...rows];

	// Prefer permlink-bearing rows, but never exclude the plain ones entirely.
	const byBlockAsc = [...rows].sort((a, b) => a.blockNum - b.blockNum);
	const chosen = new Map<string, StoredOpRef>();
	const key = (r: StoredOpRef): string => `${r.blockNum}:${r.trxInBlock}:${r.opInTrx}`;

	// 1) Always take the newest few (up to a quarter of k) — the live-order tail.
	const newestCount = Math.max(1, Math.floor(k / 4));
	for (let i = byBlockAsc.length - 1; i >= 0 && chosen.size < newestCount; i--) {
		chosen.set(key(byBlockAsc[i]!), byBlockAsc[i]!);
	}
	// 2) Evenly sample the whole range for the remainder, permlink rows first.
	const remaining = k - chosen.size;
	if (remaining > 0) {
		const permlinkRows = byBlockAsc.filter((r) => r.permlink !== null);
		const pool = permlinkRows.length >= remaining ? permlinkRows : byBlockAsc;
		const step = pool.length / remaining;
		for (let i = 0; i < remaining; i++) {
			const idx = Math.min(pool.length - 1, Math.floor(i * step));
			const r = pool[idx]!;
			if (!chosen.has(key(r))) chosen.set(key(r), r);
		}
	}
	// 3) Backfill if dedup left us short.
	for (let i = 0; i < byBlockAsc.length && chosen.size < k; i++) {
		chosen.set(key(byBlockAsc[i]!), byBlockAsc[i]!);
	}
	return [...chosen.values()].sort((a, b) => a.blockNum - b.blockNum);
}
