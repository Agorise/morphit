/**
 * Morphit indexer — Blurt RPC client.
 *
 * Read-only view of the Blurt chain. Wraps @beblurt/dblurt with:
 *   - Round-robin endpoint rotation on transport failure
 *   - Exponential cooldown (2s → 10s → 60s → 5min) on unhealthy
 *     endpoints, mirroring the relay (ADR-0006)
 *   - No private keys, no broadcasting — the indexer never signs
 *
 * API exposed to the rest of the indexer:
 *   - getDynamicGlobalProperties() — for head + irreversible block
 *   - getBlock(n)                  — the block we're about to apply
 *   - getAccount(name)             — for public-key verification
 */

import { Client } from '@beblurt/dblurt';
import type { Config } from '$config';

/** What the chain reports on every tick. Only the fields we actually
 *  consume are typed; other fields dblurt returns pass through. */
export interface DynamicGlobalProperties {
	readonly head_block_number: number;
	readonly last_irreversible_block_num: number;
	readonly time: string;
}

/** Minimal shape of a block as returned by `condenser_api.get_block`.
 *  Only the fields the dispatcher touches are typed here. */
export interface BlockHeader {
	readonly timestamp: string;
	readonly transactions: readonly BlockTransaction[];
	readonly transaction_ids: readonly string[];
}

export interface BlockTransaction {
	readonly ref_block_num: number;
	readonly ref_block_prefix: number;
	readonly expiration: string;
	readonly operations: readonly ChainOperation[];
	readonly signatures: readonly string[];
}

/** Blurt ops are heterogeneous — `[op_name, payload]` tuples. For
 *  the indexer we care about `custom_json` ops with `id` matching
 *  one of OP_IDS. The dispatcher narrows the shape; here we keep it
 *  permissive. */
export type ChainOperation = readonly [string, Record<string, unknown>];

/** What `get_account` returns — only the fields we use for signature
 *  verification. */
export interface ChainAccount {
	readonly name: string;
	readonly posting: {
		readonly weight_threshold: number;
		readonly account_auths: readonly (readonly [string, number])[];
		readonly key_auths: readonly (readonly [string, number])[];
	};
	readonly active: ChainAccount['posting'];
	readonly owner: ChainAccount['posting'];
	readonly memo_key: string;
	/** Liquid BLURT balance as a Graphene asset string like
	 *  "42.500 BLURT". Present in the RPC response; exposed here
	 *  for callers doing balance-sensitive logic (ADR-0010 §3
	 *  low-balance auto-refill). Parse with parseBlurtAmount. */
	readonly balance?: string;
}

/** Per-endpoint availability tracking. */
interface EndpointHealth {
	url: string;
	failures: number;
	cooldownUntil: number;
}

const COOLDOWN_LADDER_MS = [2_000, 10_000, 60_000, 300_000] as const;

/** Heuristic — is this error a transport failure (worth rotating off)
 *  or an application-level error from the chain (pass through)? */
function isTransportError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const m = err.message.toLowerCase();
	// dblurt / undici surface these strings on DNS / connection / TLS / timeout.
	if (m.includes('fetch failed')) return true;
	if (m.includes('timeout')) return true;
	if (m.includes('econnrefused')) return true;
	if (m.includes('econnreset')) return true;
	if (m.includes('enotfound')) return true;
	if (m.includes('etimedout')) return true;
	if (m.includes('socket hang up')) return true;
	return false;
}

export class BlurtClient {
	private readonly endpoints: EndpointHealth[];
	private rotationCounter = 0;

	constructor(config: Config) {
		if (config.blurtRpcEndpoints.length === 0) {
			throw new Error('BlurtClient: at least one endpoint required');
		}
		this.endpoints = config.blurtRpcEndpoints.map((url) => ({
			url,
			failures: 0,
			cooldownUntil: 0
		}));
	}

	/** Current dynamic global properties — includes head and
	 *  last-irreversible block numbers. */
	async getDynamicGlobalProperties(): Promise<DynamicGlobalProperties> {
		return this.callWithRotation(async (client) => {
			// dblurt exposes this on the condenser API helper, NOT the
			// database API helper. The casts are lightweight because
			// dblurt's typed return shape is a subset of what the
			// indexer needs to consume.
			const dgp = (await client.condenser.getDynamicGlobalProperties()) as DynamicGlobalProperties;
			// Minimal validation — if these two fields are missing the
			// indexer can't function at all.
			if (
				typeof dgp.head_block_number !== 'number' ||
				typeof dgp.last_irreversible_block_num !== 'number'
			) {
				throw new Error('getDynamicGlobalProperties returned unexpected shape');
			}
			return dgp;
		});
	}

	/** Fetch a specific block by number. Returns null if the node
	 *  hasn't indexed that block yet (newer than head), not an error. */
	async getBlock(num: number): Promise<BlockHeader | null> {
		return this.callWithRotation(async (client) => {
			// dblurt exposes `getBlock` on the condenser API. Nodes that
			// haven't seen that block yet return null.
			// dblurt types this as SignedBlock; we narrow to BlockHeader
			// (a structural subset of the fields the indexer consumes)
			// via an `unknown` step because the two types don't have a
			// declared subtype relationship.
			const block = (await client.condenser.getBlock(num)) as unknown as
				| BlockHeader
				| null
				| undefined;
			return block ?? null;
		});
	}

	/** Fetch a single account by name. Returns null if the name
	 *  doesn't exist on chain (not an error). */
	async getAccount(name: string): Promise<ChainAccount | null> {
		return this.callWithRotation(async (client) => {
			const accounts = (await client.condenser.getAccounts([name])) as
				| readonly ChainAccount[]
				| null
				| undefined;
			if (!accounts || accounts.length === 0) return null;
			return accounts[0] ?? null;
		});
	}

	/** Batch account fetch — useful for verifying a block's signatures
	 *  without N round-trips. */
	async getAccounts(names: readonly string[]): Promise<ReadonlyMap<string, ChainAccount>> {
		if (names.length === 0) return new Map();
		const unique = Array.from(new Set(names));
		return this.callWithRotation(async (client) => {
			const list = (await client.condenser.getAccounts(unique)) as
				| readonly ChainAccount[]
				| null
				| undefined;
			const map = new Map<string, ChainAccount>();
			for (const acc of list ?? []) {
				map.set(acc.name, acc);
			}
			return map;
		});
	}

	/** Generic escape hatch for condenser_api methods the typed
	 *  wrappers above don't cover. Returns the raw response as
	 *  unknown — the caller is responsible for validating shape.
	 *  Used by chainProperties.ts for
	 *  condenser_api.get_chain_properties and reserved for future
	 *  condenser-API additions.
	 *
	 *  Rotates endpoints identically to the typed methods; a
	 *  transport failure on one endpoint moves to the next. */
	async callCondenser<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
		return this.callWithRotation(async (client) => {
			// dblurt's Client exposes a `call` method for arbitrary
			// RPC invocations. Argument order: api namespace, method
			// name, params array.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const result = await (client as any).call('condenser_api', method, params);
			return result as T;
		});
	}

	// ─── Rotation plumbing ──────────────────────────────────────────

	private isAvailable(ep: EndpointHealth): boolean {
		return Date.now() >= ep.cooldownUntil;
	}

	private recordSuccess(ep: EndpointHealth): void {
		ep.failures = 0;
		ep.cooldownUntil = 0;
	}

	private recordFailure(ep: EndpointHealth): void {
		ep.failures += 1;
		const ladderIdx = Math.min(ep.failures - 1, COOLDOWN_LADDER_MS.length - 1);
		ep.cooldownUntil = Date.now() + COOLDOWN_LADDER_MS[ladderIdx]!;
	}

	/** Try endpoints in round-robin order. Skips cooled-down endpoints
	 *  on the first pass; does a last-ditch pass ignoring cooldowns so
	 *  the caller gets a current error rather than a stale one if
	 *  every endpoint is simultaneously in cooldown. */
	private async callWithRotation<T>(fn: (client: Client) => Promise<T>): Promise<T> {
		const start = this.rotationCounter++ % this.endpoints.length;
		let lastError: unknown = null;

		for (let i = 0; i < this.endpoints.length; i++) {
			const ep = this.endpoints[(start + i) % this.endpoints.length]!;
			if (!this.isAvailable(ep)) continue;
			const client = new Client(ep.url, { timeout: 10_000 });
			try {
				const result = await fn(client);
				this.recordSuccess(ep);
				return result;
			} catch (err) {
				if (isTransportError(err)) {
					this.recordFailure(ep);
					lastError = err;
					continue;
				}
				throw err;
			}
		}

		// Last-ditch: retry every endpoint ignoring cooldowns, so the
		// caller gets a fresh error rather than a stale one.
		for (let i = 0; i < this.endpoints.length; i++) {
			const ep = this.endpoints[(start + i) % this.endpoints.length]!;
			const client = new Client(ep.url, { timeout: 10_000 });
			try {
				const result = await fn(client);
				this.recordSuccess(ep);
				return result;
			} catch (err) {
				if (isTransportError(err)) {
					this.recordFailure(ep);
					lastError = err;
					continue;
				}
				throw err;
			}
		}

		throw new Error(
			`all Blurt endpoints unavailable: ${
				lastError instanceof Error ? lastError.message : String(lastError)
			}`
		);
	}
}
