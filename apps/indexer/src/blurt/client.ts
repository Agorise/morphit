/**
 * Morphit indexer — Blurt RPC client.
 *
 * Read-only view of the Blurt chain.  Wraps @beblurt/dblurt with
 * latency-aware endpoint selection via `@morphit/rpc-pool`:
 *   - EWMA latency tracking; the fastest known endpoint is tried first
 *   - Exponential cooldown ladder on transport failure (2s → 10s → 60s → 5min)
 *   - Optional adaptive hedging on user-facing calls (off by default for
 *     background poller / drainer to avoid double-loading public RPCs)
 *   - Per-call timeout via AbortSignal — slow nodes can't pin a request
 *     beyond the budget even when the underlying dblurt call hangs
 *   - No private keys, no broadcasting — the indexer never signs
 *
 * cp165: migrated from the bespoke rotation logic (round-robin + raw
 * cooldown) to the shared `@morphit/rpc-pool` package.  The relay's
 * BlurtClient now uses the same primitives, so a future audit only
 * needs to verify one rotation/hedging implementation instead of two.
 *
 * API exposed to the rest of the indexer:
 *   - getDynamicGlobalProperties() — head + irreversible block
 *   - getBlock(n)                  — block being applied
 *   - getAccount(name)             — public-key verification
 *   - getAccounts(names)           — batch lookup
 *   - callCondenser(method, ...)   — escape hatch for new RPCs
 *
 * Hedging policy on this client:
 *   - getAccount: USER-FACING (called during availability check, signup
 *     verification, on-the-wire sig verify) — hedge on
 *   - getAccounts (batch): MIXED — used by the poller for batch sig
 *     verification AND by user-facing handlers; we expose two methods,
 *     one user-facing and one background, to let callers signal intent
 *   - getDynamicGlobalProperties, getBlock: BACKGROUND (poller loop) —
 *     hedge off (don't double-load Blurt public RPCs)
 *   - callCondenser: BACKGROUND by default (safer for new callers);
 *     opt-in to hedging via the `userFacing` option
 */

import { Client } from '@beblurt/dblurt';
import { EndpointPool, isTransportError } from '@morphit/rpc-pool';
import type { Config } from '$config';

/** What the chain reports on every tick. Only the fields we actually
 *  consume are typed; other fields dblurt returns pass through. */
export interface DynamicGlobalProperties {
	readonly head_block_number: number;
	readonly last_irreversible_block_num: number;
	readonly time: string;
	/** Vesting-fund + total-VESTS + supply figures.  Needed to
	 *  convert a VESTS balance to BLURT POWER and to compute the
	 *  vesting APR for the user-facing balance proxy.  Optional
	 *  because the poller's minimal use of DGP (block heights only)
	 *  doesn't require them; the balance endpoint validates their
	 *  presence before relying on them. */
	readonly total_vesting_fund_blurt?: string;
	readonly total_vesting_shares?: string;
	readonly current_supply?: string;
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

/** Blurt ops are heterogeneous — `[op_name, payload]` tuples.  For
 *  the indexer we care about `custom_json` ops with `id` matching
 *  one of OP_IDS.  The dispatcher narrows the shape; here we keep it
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
	 *  "42.500 BLURT".  Present in the RPC response; exposed here
	 *  for callers doing balance-sensitive logic (ADR-0010 §3
	 *  low-balance auto-refill).  Parse with parseBlurtAmount. */
	readonly balance?: string;
	/** Powered-up stake as a VESTS asset string like
	 *  "1000000.000000 VESTS".  Present in the RPC response;
	 *  exposed here for the user-facing balance proxy
	 *  (apps/indexer/src/api/accountBalance.ts), which converts it
	 *  to BLURT POWER via the frontend's vestsToBlurtPower using the
	 *  DGP vesting totals below. */
	readonly vesting_shares?: string;
	/** VESTS delegated TO / OUT FROM this account. Present in the RPC
	 *  response; the balance proxy passes them through so the frontend can
	 *  compute EFFECTIVE vesting (own + received − delegated) — the real
	 *  voting-manabar ceiling. Without these, an account that delegates BP
	 *  out (loyalty grants) has its voting power % understated. */
	readonly received_vesting_shares?: string;
	readonly delegated_vesting_shares?: string;
	/** Voting-mana regen bar.  Present in the RPC response; the
	 *  balance proxy passes it through so the frontend can render a
	 *  mana percentage without the browser ever touching an RPC
	 *  node directly (privacy: third-party nodes never see the
	 *  user's IP or which account they're viewing). */
	readonly voting_manabar?: {
		readonly current_mana: string;
		readonly last_update_time: number;
	};
	/** Legacy voting-power counter (0–10000) + last-vote timestamp.
	 *  The balance proxy passes them through so the frontend can show the
	 *  same "Voting" % as classic Blurt explorers (blocks.blurtwallet.com). */
	readonly voting_power?: number;
	readonly last_vote_time?: string;
	/** cp396 — unclaimed author/curation rewards (claim_reward_balance).
	 *  `reward_blurt_balance` is liquid BLURT ("0.000 BLURT");
	 *  `reward_vesting_balance` is the VESTS the claim op consumes
	 *  ("0.000000 VESTS"); `reward_vesting_blurt` is the chain-provided
	 *  BLURT value of that vesting reward (shown to the user as BP). */
	readonly reward_blurt_balance?: string;
	readonly reward_vesting_balance?: string;
	readonly reward_vesting_blurt?: string;
	/** cp439 — power-down (withdraw_vesting) progress. `vesting_withdraw_rate`
	 *  is the per-week VESTS payout ("0.000000 VESTS" when idle);
	 *  `next_vesting_withdrawal` is the ISO timestamp of the next weekly payout
	 *  (a 1969/1970 epoch sentinel when idle); `to_withdraw` / `withdrawn` are
	 *  raw VESTS×1e6 integers (total scheduled / already paid — string OR number
	 *  depending on the node). The balance proxy forwards them so the wallet can
	 *  show an in-progress power-down (amount left + finish date). */
	readonly vesting_withdraw_rate?: string;
	readonly next_vesting_withdrawal?: string;
	readonly to_withdraw?: string | number;
	readonly withdrawn?: string | number;
}

/** Bridge a dblurt call (no native cancellation) to an AbortSignal.
 *  The dblurt call still runs to completion in the background if the
 *  signal aborts mid-flight; we just stop awaiting it.  Cost: one
 *  abandoned RPC per hedge — same tradeoff hedging already makes
 *  intentionally (the hedge double-fires the request anyway). */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(new Error('aborted'));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			reject(new Error('aborted'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener('abort', onAbort);
				resolve(v);
			},
			(err) => {
				signal.removeEventListener('abort', onAbort);
				reject(err);
			}
		);
	});
}

/** Per-endpoint dblurt Client instance cache.  Building a new Client
 *  per call is cheap but allocates; cache them by URL so the same
 *  Client instance is reused across calls. */
const clientCache = new Map<string, Client>();
function clientFor(url: string): Client {
	let c = clientCache.get(url);
	if (c === undefined) {
		c = new Client(url, { timeout: 10_000 });
		clientCache.set(url, c);
	}
	return c;
}

/** Options shared by the generic RPC caller. `userFacing` opts a READ into
 *  latency hedging (parallel-fire the fastest known nodes, take the winner);
 *  `hedge` is an explicit override that wins over the userFacing default. */
export interface RpcCallOptions {
	userFacing?: boolean;
	hedge?: boolean;
}

/** Resolve the effective hedge flag for an rpc-pool call.
 *
 *  Explicit `hedge` wins; otherwise a user-facing READ hedges and everything
 *  else — background reads, and EVERY write — does not.
 *
 *  WHY THIS IS ITS OWN EXPORTED FUNCTION (cp452): hedging a WRITE parallel-
 *  fires the same signed transaction to a second node, whose
 *  `broadcast_transaction_synchronous` then blocks on the duplicate until the
 *  tx expires (~60s), stalling the send. The broadcast route MUST pass
 *  `hedge:false`, and this mapping MUST honour it over any `userFacing`. Both
 *  are pinned by the broadcast-hedge-off smoke so neither can silently
 *  regress back to a hedged write. */
export function resolveHedge(options: RpcCallOptions): boolean {
	return options.hedge ?? options.userFacing === true;
}

export class BlurtClient {
	private readonly pool: EndpointPool;

	constructor(config: Config) {
		if (config.blurtRpcEndpoints.length === 0) {
			throw new Error('BlurtClient: at least one endpoint required');
		}
		this.pool = new EndpointPool({
			endpoints: [...config.blurtRpcEndpoints]
		});
	}

	/** Expose pool snapshot for /v1/health diagnostics (latency,
	 *  cooldown state, last-success timestamps). */
	endpointSnapshot(): ReturnType<EndpointPool['snapshot']> {
		return this.pool.snapshot();
	}

	/** Current dynamic global properties.  Background call (poller). */
	async getDynamicGlobalProperties(): Promise<DynamicGlobalProperties> {
		return this.pool.call(async (url, signal) => {
			const client = clientFor(url);
			const dgp = (await withSignal(
				client.condenser.getDynamicGlobalProperties(),
				signal
			)) as unknown as DynamicGlobalProperties;
			if (
				typeof dgp.head_block_number !== 'number' ||
				typeof dgp.last_irreversible_block_num !== 'number'
			) {
				throw new Error('getDynamicGlobalProperties returned unexpected shape');
			}
			return dgp;
		});
	}

	/** Fetch a specific block.  Background call (poller). */
	async getBlock(num: number): Promise<BlockHeader | null> {
		return this.pool.call(async (url, signal) => {
			const client = clientFor(url);
			const block = (await withSignal(client.condenser.getBlock(num), signal)) as unknown as
				| BlockHeader
				| null
				| undefined;
			return block ?? null;
		});
	}

	/** Fetch a single account.  Defaults to USER-FACING (hedge on) —
	 *  callers in background paths (chain dispatch, periodic
	 *  scanners) should pass `{userFacing: false}` to avoid double-
	 *  loading public RPCs. */
	async getAccount(
		name: string,
		options: { userFacing?: boolean } = {}
	): Promise<ChainAccount | null> {
		const userFacing = options.userFacing !== false;
		return this.pool.call(
			async (url, signal) => {
				const client = clientFor(url);
				const accounts = (await withSignal(
					client.condenser.getAccounts([name]),
					signal
				)) as readonly ChainAccount[] | null | undefined;
				if (!accounts || accounts.length === 0) return null;
				return accounts[0] ?? null;
			},
			{ hedge: userFacing }
		);
	}

	/** Batch account fetch.  Defaults to USER-FACING; pass
	 *  `{userFacing: false}` for poller / scanner paths. */
	async getAccounts(
		names: readonly string[],
		options: { userFacing?: boolean } = {}
	): Promise<ReadonlyMap<string, ChainAccount>> {
		if (names.length === 0) return new Map();
		const unique = Array.from(new Set(names));
		const userFacing = options.userFacing !== false;
		return this.pool.call(
			async (url, signal) => {
				const client = clientFor(url);
				const list = (await withSignal(
					client.condenser.getAccounts(unique),
					signal
				)) as readonly ChainAccount[] | null | undefined;
				const map = new Map<string, ChainAccount>();
				for (const acc of list ?? []) {
					map.set(acc.name, acc);
				}
				return map;
			},
			{ hedge: userFacing }
		);
	}

	/** Generic condenser-API escape hatch.  Background by default;
	 *  callers can opt into hedging for user-facing READS via `userFacing`.
	 *  WRITES (broadcast) must pass `hedge: false` explicitly: hedging a
	 *  broadcast parallel-fires the SAME signed tx to multiple nodes, and a
	 *  losing node's `broadcast_transaction_synchronous` then blocks on the
	 *  duplicate until the tx expires (~60s) — the exact hang the relay's
	 *  broadcast path forbids with its own `hedge:false`. The explicit
	 *  `hedge` option wins over the `userFacing`-derived default. */
	async callCondenser<T = unknown>(
		method: string,
		params: readonly unknown[] = [],
		options: RpcCallOptions = {}
	): Promise<T> {
		const hedge = resolveHedge(options);
		return this.pool.call(
			async (url, signal) => {
				const client = clientFor(url);
				// dblurt's Client exposes a `call` method for arbitrary
				// RPC invocations.  Argument order: api namespace, method
				// name, params array.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const result = await withSignal(
					(client as any).call('condenser_api', method, params),
					signal
				);
				return result as T;
			},
			{ hedge }
		);
	}
}

/** Re-export for consumers that want to inspect transport errors
 *  without pulling rpc-pool directly. */
export { isTransportError };
