/**
 * Morphit relay — keep the RPC pool in step with the on-chain RPC directory
 * (v1.20.0 fix wave, D12).
 *
 * The indexer persists the latest trusted `morphit_rpc_v1` directory (signed
 * by @morphit, pubkey-pinned — see apps/indexer/src/indexer/handlers/
 * rpcDirectory.ts) in the `rpc_directory` table of the shared database. The
 * relay used to read it ONCE, at boot: a node @morphit published afterwards
 * reached the indexer at once but the relay — the component that BROADCASTS —
 * only at its next restart. This re-reads it on a timer and merges anything
 * new (existing endpoints keep their health; merging is idempotent). Nodes are
 * never removed here: a node that goes down is routed around by the pool.
 *
 * Best-effort: on a split deployment (no such table) or a DB hiccup the read
 * fails quietly and the relay keeps the endpoints it has.
 */
export interface RpcDirectoryDb {
	query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}
type DirRow = { endpoints: string[] | null; node_names: unknown };
export interface RpcDirectoryTarget {
	mergeRpcEndpoints(
		urls: readonly string[],
		operators?: Readonly<Record<string, string>>
	): string[];
}

/** Read the directory once and merge it. Returns the newly-added URLs. */
export async function syncRpcDirectory(
	db: RpcDirectoryDb,
	target: RpcDirectoryTarget
): Promise<string[]> {
	let rows: DirRow[];
	try {
		rows = (await db.query(`SELECT endpoints, node_names FROM rpc_directory WHERE id = 1`))
			.rows as DirRow[];
	} catch {
		try {
			// Pre-v55 databases have no node_names column.
			rows = (
				await db.query(`SELECT endpoints, NULL AS node_names FROM rpc_directory WHERE id = 1`)
			).rows as DirRow[];
		} catch {
			return [];
		}
	}
	const endpoints = (rows[0]?.endpoints ?? []).filter(
		(u): u is string => typeof u === 'string' && u !== ''
	);
	if (endpoints.length === 0) return [];
	const names = rows[0]?.node_names;
	const operators: Record<string, string> = {};
	if (names !== null && typeof names === 'object') {
		for (const [url, name] of Object.entries(names as Record<string, unknown>)) {
			if (typeof name === 'string' && name !== '') operators[url] = name;
		}
	}
	return target.mergeRpcEndpoints(endpoints, operators);
}

/** Default refresh cadence: the directory changes rarely; ten minutes is
 *  prompt without being a load. */
export const RPC_DIRECTORY_SYNC_INTERVAL_MS = 10 * 60_000;

/** Sync now, then every `intervalMs`. `onAdded` is told about new URLs. */
export function startRpcDirectorySync(
	db: RpcDirectoryDb,
	target: RpcDirectoryTarget,
	onAdded: (added: string[]) => void,
	intervalMs: number = RPC_DIRECTORY_SYNC_INTERVAL_MS
): { readonly first: Promise<void>; stop(): void } {
	const run = async (): Promise<void> => {
		const added = await syncRpcDirectory(db, target).catch(() => [] as string[]);
		if (added.length > 0) onAdded(added);
	};
	const first = run();
	const timer = setInterval(() => void run(), intervalMs);
	timer.unref?.();
	return { first, stop: () => clearInterval(timer) };
}
