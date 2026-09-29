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
 * An `MORPHIT_CANARY_BLURT_RPC` override is honoured PREFERRED-FIRST, NOT
 * exclusively (review D12): the operator's / tor-only auto-pick node(s) are
 * tried first, then the walk FALLS THROUGH to the rest of the canonical list.
 * The override may name several nodes (comma-separated) — on a tor-only node
 * generate.sh passes ALL the hidden .onion RPCs, so one down onion no longer
 * stalls the whole canary refresh (the old code pinned exactly one, exclusively,
 * and a single dead onion let the canary go stale). Deduped, order preserved,
 * blanks dropped.
 */
export function resolveCanaryNodes(
	override: string | undefined,
	defaultList: readonly string[]
): string[] {
	const preferred = (override ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s !== '');
	const seen = new Set<string>();
	const out: string[] = [];
	for (const url of [...preferred, ...defaultList]) {
		const u = url.trim();
		if (u === '' || seen.has(u)) continue;
		seen.add(u);
		out.push(u);
	}
	return out;
}

/**
 * The DEFAULT node list the canary falls through to (D12 contract): on a
 * tor-only node, EVERY .onion in the default hidden Blurt RPC set — never a
 * clearnet node (pushed through a Tor exit their WAFs answer 400/403, and a
 * tor-only node must not rely on clearnet at all); on a clearnet node, the
 * clearnet default list. The override (resolveCanaryNodes) is still tried first.
 */
export function canaryDefaultNodes(
	torOnly: boolean,
	clearnet: readonly string[],
	hidden: readonly string[]
): string[] {
	return torOnly ? hidden.filter((u) => /\.onion(?::\d+)?(?:\/|$)/i.test(u)) : [...clearnet];
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
