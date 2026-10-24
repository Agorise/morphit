/**
 * scripts/canary/blurtHeadFailover.ts
 *
 * Pure, side-effect-free core for the warrant canary's Blurt chain-head
 * fetch. Kept separate from the CLI entry (fetch-blurt-head.ts) so the
 * failover logic is unit-testable with NO network — the smoke injects a
 * `fetchOne` that fails the first N nodes and asserts the walk hops to the
 * next.
 *
 * why this exists: the canary used to POST the chain-head request
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
	// v1.21.15: these go into a signed canary. A Blurt block id is 20 bytes
	// (40 hex) and its first 4 bytes are the block number, big-endian
	// (block_header::id() in Blurt's libraries/protocol/block.cpp): an id that
	// does not carry this height is not this block's.
	if (typeof id !== 'string' || !/^[0-9a-f]{40}$/.test(id)) return null;
	// (This also keeps the height a whole number below 2^32.)
	if (Number.parseInt(id.slice(0, 8), 16) !== n) return null;
	// The chain's own time format (UTC, whole seconds, no zone suffix).
	if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(time)) return null;
	return { head_block_number: n, head_block_id: id, time };
}

/**
 * Ask every node at once and take the FIRST valid head — the fastest hidden
 * node (v1.21.15). Null when every node failed. `fetchOne` is injected.
 */
export async function fetchBlurtHeadFastest(
	nodes: readonly string[],
	fetchOne: (url: string) => Promise<BlurtHead | null>
): Promise<{ head: BlurtHead; url: string } | null> {
	if (nodes.length === 0) return null;
	return new Promise((resolve) => {
		let pending = nodes.length;
		let done = false;
		for (const url of nodes) {
			fetchOne(url)
				.catch(() => null)
				.then((head) => {
					pending--;
					if (done) return;
					if (head) {
						done = true;
						resolve({ head, url });
					} else if (pending === 0) {
						done = true;
						resolve(null);
					}
				});
		}
	});
}

/** One step of the canary's Blurt head fetch. */
export interface CanaryBlurtPhase {
	readonly mode: 'walk' | 'race';
	readonly nodes: readonly string[];
}

/**
 * The order the canary asks for the Blurt head (v1.21.15):
 *   - a Tor-only node: the override's nodes ALL AT ONCE (the fastest valid
 *     head wins), then — only when none answered — every other default .onion
 *     node all at once (D12: never clearnet; the override keeps priority);
 *   - a clearnet node: the override's nodes, then the clearnet defaults, in
 *     order; only when every one failed, the hidden (.onion / .i2p) defaults
 *     all at once, through the local Tor / i2pd proxy.
 */
export function planCanaryBlurtPhases(opts: {
	readonly override: string | undefined;
	readonly torOnly: boolean;
	readonly clearnet: readonly string[];
	readonly hidden: readonly string[];
}): CanaryBlurtPhase[] {
	if (opts.torOnly) {
		// The override's nodes keep priority (D12: preferred-first): they are asked
		// first, all at once; only when none answers, every other default onion.
		const preferred = resolveCanaryNodes(opts.override, []);
		const asked = new Set(preferred);
		const rest = canaryDefaultNodes(true, opts.clearnet, opts.hidden).filter(
			(u) => !asked.has(u.trim())
		);
		const out: CanaryBlurtPhase[] = [];
		if (preferred.length > 0) out.push({ mode: 'race', nodes: preferred });
		if (rest.length > 0) out.push({ mode: 'race', nodes: rest });
		return out;
	}
	const walk = resolveCanaryNodes(opts.override, opts.clearnet);
	const tried = new Set(walk);
	const race = resolveCanaryNodes(
		undefined,
		opts.hidden.filter((u) => !tried.has(u.trim()))
	);
	const phases: CanaryBlurtPhase[] = [];
	if (walk.length > 0) phases.push({ mode: 'walk', nodes: walk });
	if (race.length > 0) phases.push({ mode: 'race', nodes: race });
	return phases;
}

/** Run the phases in order; the first phase that yields a head wins. */
export async function fetchBlurtHeadPhased(
	phases: readonly CanaryBlurtPhase[],
	fetchOne: (url: string) => Promise<BlurtHead | null>
): Promise<{ head: BlurtHead; url: string } | null> {
	for (const phase of phases) {
		const got =
			phase.mode === 'race'
				? await fetchBlurtHeadFastest(phase.nodes, fetchOne)
				: await fetchBlurtHeadWithFailover(phase.nodes, fetchOne);
		if (got) return got;
	}
	return null;
}
