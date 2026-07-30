/**
 * scripts/canary/blurtHeadFailover.ts
 *
 * Pure, side-effect-free core for the warrant canary's Blurt chain-head
 * fetch. Kept separate from the CLI entry (fetch-blurt-head.ts) so the
 * failover logic is unit-testable with NO network — the smoke injects a
 * `fetchOne` that fails the first N nodes and asserts the walk hops to the
 * next.
 *
 * cp451 — why this exists: the canary used to POST the chain-head request
 * to a single pinned node (default https://rpc.blurt.blog). When that one
 * witness's TLS cert died the node returned 526 and the ENTIRE canary
 * refresh stopped — even though the app itself has an RPC rotator that
 * would have hopped to the next node instantly. The canary now walks the
 * same canonical DEFAULT_BLURT_RPC_ENDPOINTS list the rest of Morphit uses.
 */

export interface BlurtHead {
	/** Chain head block number (must be a positive finite integer). */
	readonly head_block_number: number;
	/** Chain head block id / hash. */
	readonly head_block_id: string;
	/** Raw chain time as the node reports it (no trailing "Z" — the caller
	 *  appends it, matching the previous curl+jq behaviour). */
	readonly time: string;
}

/**
 * Resolve the ORDERED list of nodes to try.
 *
 * An explicit `MORPHIT_CANARY_BLURT_RPC` override is honoured EXCLUSIVELY —
 * the operator named a specific node on purpose, the same rule
 * release-broadcast.ts applies to its `--node` flag. With no override we
 * walk the full canonical list, which is the failover behaviour we want by
 * default. So: the fix for "one dead node stalls the canary" is simply to
 * leave the override unset, which is the default.
 */
export function resolveCanaryNodes(
	override: string | undefined,
	defaultList: readonly string[]
): string[] {
	const trimmed = override?.trim();
	if (trimmed) return [trimmed];
	return [...defaultList];
}

/**
 * Walk `nodes` in order, returning the first that yields a valid head (and
 * which URL answered), or null when every node failed. `fetchOne` is
 * injected so this is exhaustively testable without a network: it returns a
 * BlurtHead on success or null on any failure (HTTP error, timeout,
 * malformed body).
 */
export async function fetchBlurtHeadWithFailover(
	nodes: readonly string[],
	fetchOne: (url: string) => Promise<BlurtHead | null>
): Promise<{ head: BlurtHead; url: string } | null> {
	for (const url of nodes) {
		const head = await fetchOne(url);
		if (head) return { head, url };
	}
	return null;
}

/**
 * Validate a `condenser_api.get_dynamic_global_properties` result into a
 * BlurtHead, or null if it is missing/malformed. Exported so the live fetch
 * and the smoke share ONE shape check — a node that answers 200 with junk
 * is treated as a failure and the walk moves on.
 */
export function parseHead(result: unknown): BlurtHead | null {
	if (!result || typeof result !== 'object') return null;
	const r = result as Record<string, unknown>;
	const n = r.head_block_number;
	const id = r.head_block_id;
	const time = r.time;
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
	if (typeof id !== 'string' || id.length === 0) return null;
	if (typeof time !== 'string' || time.length === 0) return null;
	return { head_block_number: n, head_block_id: id, time };
}
