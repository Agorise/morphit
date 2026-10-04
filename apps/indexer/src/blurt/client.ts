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
 * migrated from the bespoke rotation logic (round-robin + raw
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

import { hiddenHostNetworkOf } from '@morphit/hidden-transport';
import { guardDblurtClient, guardedRpcFetch } from '@morphit/hidden-transport/rpc-fetch';
import { Client } from '@beblurt/dblurt';
import { morphitUserAgent } from './userAgent';
import { INDEXER_VERSION } from '$api/health';
import { EndpointPool, isTransportError } from '@morphit/rpc-pool';
import { rpcEndpointOperator } from '@morphit/operator-config';
import {
	blockConsistencyKey,
	interpretChainConsistency,
	type ChainConsistencyResult
} from './chainConsistency';
import type { Config } from '$config';
import { logger } from '$log';

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
 *  Only the fields the dispatcher touches are typed here — plus the block
 *  IDENTITY fields (always returned by get_block; the dispatcher ignores them)
 *  the quorum chain-consistency cross-check keys on. */
export interface BlockHeader {
	readonly timestamp: string;
	readonly transactions: readonly BlockTransaction[];
	readonly transaction_ids: readonly string[];
	/** Canonical block hash for this height. Honest nodes on the same chain
	 *  return the SAME value for a given height; a forked/lying node differs. */
	readonly block_id?: string;
	/** Hash of the previous block. Secondary identity signal. */
	readonly previous?: string;
	/** Witness that produced the block. */
	readonly witness?: string;
	/** Merkle root of the block's transactions. */
	readonly transaction_merkle_root?: string;
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
	/** When the chain last applied an account_update to this account (UTC,
	 *  no zone suffix). Trusted reads compare it to tell an answer from a node
	 *  that is behind (VT5-1). */
	readonly last_account_update?: string;
	/** unclaimed author/curation rewards (claim_reward_balance).
	 *  `reward_blurt_balance` is liquid BLURT ("0.000 BLURT");
	 *  `reward_vesting_balance` is the VESTS the claim op consumes
	 *  ("0.000000 VESTS"); `reward_vesting_blurt` is the chain-provided
	 *  BLURT value of that vesting reward (shown to the user as BP). */
	readonly reward_blurt_balance?: string;
	readonly reward_vesting_balance?: string;
	readonly reward_vesting_blurt?: string;
	/** power-down (withdraw_vesting) progress. `vesting_withdraw_rate`
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
/** v1.7.5 — a node told us it does not speak JSON-RPC batch.
 *
 *  A distinct class, not a string match, because this must NOT look like a
 *  transport failure: `isTransportError` matches on message TEXT ('fetch
 *  failed', 'timeout', 'network', 'aborted', …), and a match would rotate the
 *  endpoint and start its cooldown ladder — punishing a perfectly healthy node
 *  for the crime of being an older build. The message below is deliberately
 *  free of every word on that list. */
class BatchUnsupportedError extends Error {
	constructor(url: string) {
		super(`endpoint does not support JSON-RPC batch: ${url}`);
		this.name = 'BatchUnsupportedError';
	}
}

/** v1.7.5 — URLs that answered a JSON-RPC batch with something other
 *  than an array, i.e. nodes that don't speak batch. Process-lifetime memo: a
 *  node's batch support doesn't flip while we're running, and re-probing it on
 *  every catch-up would spend exactly the requests batching exists to save.
 *  Deliberately NOT persisted — a restart re-probes once, which is the cheapest
 *  possible way to notice a node that has since upgraded. */
const batchUnsupported = new Set<string>();

function clientFor(url: string): Client {
	let c = clientCache.get(url);
	if (c === undefined) {
		// dblurt 0.17.0 (v1.8.0 upgrade) added a native `userAgent` ClientOptions
		// field — the reason the old global-fetch wrapper existed. Pass it here so
		// dblurt's own RPC traffic identifies Morphit natively. The startup
		// `installMorphitUserAgent` global wrapper has been RETIRED now that the
		// native UA is confirmed in production node logs and every other call site
		// names itself (rpcHealth got its own header too); `rpc-user-agent-smoke`
		// guards that no raw fetch is left anonymous.
		// The timeout MUST depend on the transport. 10s is right for clearnet and
		// far too short for a hidden service: a fresh .onion or .b32.i2p connection
		// has to build circuits or tunnels first, which routinely takes 30-60s. A
		// zero-clearnet box therefore aborted EVERY standalone chain read at 10s —
		// permanently, not just after a restart — while the long-lived indexer
		// service survived on warm tunnels and continuous retries, which is exactly
		// why this looked like a script bug rather than a timeout.
		const hiddenNet = hiddenHostNetworkOf(new URL(url).hostname);
		const timeoutMs =
			hiddenNet === null ? 10_000 : Number(process.env.MORPHIT_HIDDEN_RPC_TIMEOUT_MS ?? 60_000);
		// Guarded: dblurt followed redirects and read
		// replies whole, so a directory-listed node could bounce our POST to our
		// own loopback or stream memory into us. See rpcFetch.ts.
		c = guardDblurtClient(
			new Client(url, { timeout: timeoutMs, userAgent: morphitUserAgent(INDEXER_VERSION) })
		);
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
 *  WHY THIS IS ITS OWN EXPORTED FUNCTION: hedging a WRITE parallel-
 *  fires the same signed transaction to a second node, whose
 *  `broadcast_transaction_synchronous` then blocks on the duplicate until the
 *  tx expires (~60s), stalling the send. The broadcast route MUST pass
 *  `hedge:false`, and this mapping MUST honour it over any `userFacing`. Both
 *  are pinned by the broadcast-hedge-off smoke so neither can silently
 *  regress back to a hedged write. */
export function resolveHedge(options: RpcCallOptions): boolean {
	return options.hedge ?? options.userFacing === true;
}

/** How many operators a quorum read asks at once.
 *  Enough for two to agree with one to spare; the pool asks the next operator
 *  when one fails or disagrees, so the cap costs no answers. Before this, every
 *  quorum batch went to EVERY endpoint — nine requests for 251 accounts on a
 *  three-node pool, and on the default list twenty. */
export const QUORUM_MAX_OPERATORS = 3;

/** How long an operator that was OUTVOTED on a trusted read is left out of
 *  trusted reads: doubled for each further time in a row, up to the cap; reset
 *  the first time it is in the majority again. Its ordinary reads continue. */
export const QUORUM_DISSENT_COOLDOWN_MS = 10 * 60 * 1000;
export const QUORUM_DISSENT_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000;

/** A trusted read of MUTABLE state (an account's keys, an account's newest
 *  op) asks this many operators before it gives up on a round when they
 *  disagree (VT5-1): a dissent is re-asked of more operators before anything
 *  is decided against it. */
export const QUORUM_WIDEN_TO = 5;

/** A LONE dissent — one operator, never joined by a second — on mutable state
 *  is overruled only after it has stood alone on this many earlier reads AND
 *  this long since the first (VT5-1, VT1-3). Until then it blocks the read:
 *  a node that is behind catches up long before, and an honest node that is
 *  ahead gains a second operator. A dissent backed by two operators is never
 *  overruled by count. */
export const QUORUM_STANDING_READS = 3;
export const QUORUM_STANDING_MS = 10 * 60 * 1000;
/** Bound on remembered lone dissents (one per item, operator and value). */
const QUORUM_STANDING_MAX = 10_000;

/** Trusted-read tuning; tests shorten the standing period. */
export interface QuorumOptions {
	readonly standingReads?: number;
	readonly standingMs?: number;
}

/** One item's value as one operator gave it: what must match, and how new it
 *  is (a time or a block number; null when the answer does not say). */
interface ItemVote {
	readonly key: string;
	readonly fresh: number | null;
}

/** One operator's record of being outvoted on trusted reads. */
export interface QuorumDissent {
	readonly operator: string;
	/** Trusted reads in a row on which it answered against the majority. */
	readonly times: number;
	/** Left out of trusted reads until this time (ms since epoch). */
	readonly until: number;
}

/** Thrown inside a quorum read to skip an operator without counting it as a
 *  transport failure (no cooldown in the pool, no latency sample). */
class SkipOperator extends Error {}

const quorumLog = logger('rpc-quorum');

/** Pool option for a call that only READS chain state: an application error
 *  from one node is not taken as the answer — the next operator is asked, and
 *  the node that erred is parked once another answers (rpc-pool CallOptions
 *  `read`). Without it, one node answering every read with a plausible RPC
 *  error pinned the pool and froze the indexer. */
const READ = { read: true } as const;

export class BlurtClient {
	private readonly pool: EndpointPool;
	private readonly dissent = new Map<string, { times: number; until: number }>();
	/** Lone dissents on mutable state: `item \0 operator \0 key` → how many
	 *  reads it has blocked, since when. */
	private readonly standing = new Map<string, { reads: number; since: number }>();
	private readonly standingReads: number;
	private readonly standingMs: number;

	constructor(config: Config, opts: { readonly quorum?: QuorumOptions } = {}) {
		this.standingReads = opts.quorum?.standingReads ?? QUORUM_STANDING_READS;
		this.standingMs = opts.quorum?.standingMs ?? QUORUM_STANDING_MS;
		// the "at least one chain source" invariant is over the COMBINED
		// pool, not clearnet alone. A tor-only node runs with an EMPTY clearnet
		// pool (blurtRpcEndpoints=[]) and reads the chain purely over hidden/local
		// endpoints — checking blurtRpcEndpoints.length here would wrongly reject
		// that valid configuration. Only a node with NO source at all (all three
		// pools empty) is a real misconfiguration.
		const totalEndpoints =
			(config.localRpcEndpoints?.length ?? 0) +
			config.blurtRpcEndpoints.length +
			(config.hiddenRpcEndpoints?.length ?? 0);
		if (totalEndpoints === 0) {
			throw new Error(
				'BlurtClient: at least one RPC endpoint required (clearnet, hidden, or local)'
			);
		}
		// Local (loopback co-located blurtd) FIRST — it's instant and the read
		// never leaves the box — then clearnet, then hidden-service endpoints
		// (.onion / .b32.i2p) reached via the global routing dispatcher. To the
		// pool they're all just URLs; the quorum trust layer and the Settings
		// card's transport badges span every tier automatically.
		this.pool = new EndpointPool({
			endpoints: [
				...(config.localRpcEndpoints ?? []),
				...config.blurtRpcEndpoints,
				...(config.hiddenRpcEndpoints ?? [])
			],
			// Share what we learn about node health with SHORT-LIVED processes.
			//
			// The long-lived indexer discovers within seconds which of ~20 endpoints
			// are fast and which are down. Every one-shot run (the mirror job,
			// fast-sync, any script) previously started blind and worked through
			// endpoints in CONFIG ORDER, paying a full timeout on whatever happened
			// to be dead first — a wasted minute per run on a hidden endpoint the
			// indexer already knew was down.
			//
			// The point of running many endpoints is to always use the best one
			// available. Hand-pruning a node that blipped is precisely the manual
			// work this pool exists to remove, so the knowledge is shared instead.
			// Fail-open: an unwritable or stale file changes nothing.
			healthStatePath: process.env.MORPHIT_RPC_HEALTH_STATE ?? '/var/lib/morphit/rpc-health.json',
			// a quorum counts OPERATORS, not URLs.
			// Every default hidden node is listed at two addresses; counted per
			// URL, one operator answering on both met a two-endpoint quorum
			// alone.
			operatorOf: (url) => rpcEndpointOperator(url)
		});
	}

	/** Expose pool snapshot for /v1/health diagnostics (latency,
	 *  cooldown state, last-success timestamps). */
	endpointSnapshot(): ReturnType<EndpointPool['snapshot']> {
		return this.pool.snapshot();
	}

	/** Add RPC endpoints to the pool at runtime (idempotent). Used by the
	 *  on-chain RPC-directory consumer to self-populate hidden nodes published by
	 *  @morphit without a restart. Returns the newly-added URLs. */
	mergeRpcEndpoints(
		urls: readonly string[],
		operators?: Readonly<Record<string, string>>
	): string[] {
		// rv2-2: `operators` (url → node name, from the directory) makes a
		// node's .onion and .b32.i2p count as the one operator they are.
		const named: Record<string, string> | undefined =
			operators === undefined
				? undefined
				: Object.fromEntries(
						Object.keys(operators).map((u) => [u, rpcEndpointOperator(u, operators)])
					);
		return this.pool.mergeEndpoints(urls, named);
	}

	/** Distinct operators this node could ask right now. LIVENESS
	 *  ONLY: one blip on the others drops it to 1. Never size a quorum whose
	 *  answer is written down or trusted from it — use trustedQuorumSize(). */
	reachableOperatorCount(): number {
		return this.pool.reachableOperatorCount();
	}

	/** Distinct operators in the pool, whether or not they answered lately. */
	operatorCount(): number {
		return this.pool.operatorCount();
	}

	/**
	 * How many operators (counted by node name) must agree on an answer that is written
	 * down or trusted afterwards: two, whenever the pool has two operators at
	 * all. When fewer are reachable right now the read fails and the caller
	 * tries again later — it never falls back to one operator's word, which is
	 * exactly what a single hostile node answering alone would want. Only a
	 * pool with ONE operator configured is its own quorum: its operator already
	 * trusts that node with everything else.
	 */
	trustedQuorumSize(): number {
		return this.pool.operatorCount() >= 2 ? 2 : 1;
	}

	/**
	 * One condenser read that several operators (counted by node name, see
	 * rpc-pool `operatorOf`) must agree on. `keyOf` reduces an answer to what
	 * must match; returning null means "this answer does not count" (malformed,
	 * or the node does not have it yet). Resolves to the agreed answer, or null
	 * when there is none. Background priority.
	 *
	 * `mutable` for state that changes (an account's newest op): then the
	 * stricter rule of majorityRead applies, and `freshOf` says how new an
	 * answer is (e.g. the block number of what it names), so an answer from a
	 * node that is behind is recognised as older.
	 */
	async condenserAgreed<T>(
		method: string,
		params: readonly unknown[],
		keyOf: (answer: T) => string | null,
		minAgree: number,
		opts: { readonly mutable?: boolean; readonly freshOf?: (answer: T) => number | null } = {}
	): Promise<{ readonly value: T; readonly key: string } | null> {
		const decided = await this.majorityRead<T>(
			async (url, signal) => {
				const client = clientFor(url);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return (await withSignal(
					(client as any).call('condenser_api', method, params),
					signal
				)) as T;
			},
			[`${method}:${JSON.stringify(params)}`],
			(value) => {
				const key = keyOf(value);
				return key === null ? null : { key, fresh: opts.freshOf?.(value) ?? null };
			},
			minAgree,
			opts.mutable === true
		);
		const d = decided?.[0];
		return d === undefined ? null : { value: d.answer, key: d.key };
	}

	/**
	 * The trusted-read rule. Operators are counted by node name (rpc-pool
	 * `operatorOf`), one vote each however many addresses they have; a vote of
	 * null on an item is an abstention. An item needs at least `minAgree`
	 * operators giving the same value AND a strict majority of those that
	 * answered. The result has one entry per item, or is null when any item is
	 * not decided — the caller learns nothing and tries again later.
	 *
	 * IMMUTABLE state (a block by its height): a node that does not have it
	 * abstains, so a different value is simply wrong. The first decision wins
	 * and a dissenter is outvoted (VT1-3).
	 *
	 * MUTABLE state (`mutable`): a node that is behind gives an OLDER value, and
	 * a hostile node can agree with it — a bare majority confirmed a leaked
	 * posting key over its rotation (VT5-1). So:
	 *   - QUORUM_MAX_OPERATORS operators are heard before anything is decided,
	 *     and up to QUORUM_WIDEN_TO while they disagree;
	 *   - a dissent that is provably OLDER (its `fresh` below the majority's)
	 *     is outvoted;
	 *   - a dissent backed by two operators blocks the item;
	 *   - a LONE dissent that is not provably older blocks the item too, until
	 *     it has stood alone on QUORUM_STANDING_READS earlier reads over at
	 *     least QUORUM_STANDING_MS; then it is overruled (one node must not
	 *     block a read forever).
	 *
	 * An operator outvoted as older, or overruled, is left out of trusted reads
	 * for QUORUM_DISSENT_COOLDOWN_MS, doubling; one that was ahead of the
	 * majority is never punished for it. One that agrees again is cleared.
	 * Background priority. Never falls back to fewer operators than `minAgree`.
	 */
	private async majorityRead<A>(
		ask: (url: string, signal: AbortSignal) => Promise<A | null | undefined>,
		items: readonly string[],
		voteOf: (answer: A, index: number) => ItemVote | null,
		minAgree: number,
		mutable: boolean
	): Promise<{ key: string; answer: A }[] | null> {
		const need = Math.max(1, minAgree);
		const now = Date.now();
		const votes: { operator: string; items: (ItemVote | null)[]; answer: A }[] = [];
		const heard = new Set<string>();
		const safeVote = (answer: A, i: number): ItemVote | null => {
			try {
				return voteOf(answer, i);
			} catch {
				return null;
			}
		};

		/** One item, from the votes so far. */
		const judge = (i: number) => {
			const groups = new Map<
				string,
				{ n: number; fresh: number | null; answer: A; ops: string[] }
			>();
			let responders = 0;
			for (const v of votes) {
				const iv = v.items[i];
				if (iv === null || iv === undefined) continue;
				responders++;
				const g = groups.get(iv.key);
				if (g) {
					g.n++;
					g.ops.push(v.operator);
				} else groups.set(iv.key, { n: 1, fresh: iv.fresh, answer: v.answer, ops: [v.operator] });
			}
			let best: [string, { n: number; fresh: number | null; answer: A; ops: string[] }] | undefined;
			for (const e of groups) if (best === undefined || e[1].n > best[1].n) best = e;
			if (best === undefined || best[1].n < need || best[1].n * 2 <= responders) {
				return { decided: false as const, backed: false, lone: [], older: [] };
			}
			const lone: { operator: string; key: string }[] = [];
			const older: string[] = [];
			let backed = false;
			if (mutable) {
				for (const [key, g] of groups) {
					if (key === best[0]) continue;
					if (g.fresh !== null && best[1].fresh !== null && g.fresh < best[1].fresh) {
						older.push(...g.ops);
					} else if (g.n >= 2) backed = true;
					else lone.push({ operator: g.ops[0]!, key });
				}
			}
			return { decided: true as const, key: best[0], answer: best[1].answer, backed, lone, older };
		};
		const allDecidedClean = (): boolean =>
			items.every((_, i) => {
				const j = judge(i);
				return j.decided && !j.backed && j.lone.length === 0;
			});

		/** Hear up to `target` more operators (not heard before, not left out),
		 *  `window` at a time. */
		const collect = async (target: number, window: number, earlyDecide: boolean): Promise<void> => {
			let asked = 0;
			let done = false;
			await this.pool.quorumCall<true>(
				async (url, signal) => {
					const operator = this.pool.operatorOf(url);
					const cooled = this.dissent.get(operator);
					if (done || heard.has(operator) || (cooled !== undefined && cooled.until > now)) {
						throw new SkipOperator();
					}
					if (asked >= target) throw new SkipOperator();
					asked++;
					let answer: A | null | undefined;
					try {
						answer = await ask(url, signal);
					} catch (err) {
						asked--; // a transport failure: another operator may be asked
						throw err;
					}
					if (answer === null || answer === undefined) {
						asked--;
						return null;
					}
					if (done || heard.has(operator)) return null;
					heard.add(operator);
					votes.push({ operator, items: items.map((_, i) => safeVote(answer, i)), answer });
					if (earlyDecide && allDecidedClean()) {
						done = true;
						return true;
					}
					return null;
				},
				{ equivalenceKey: () => 'done', minAgree: 1, maxOperators: Math.max(1, window) }
			);
		};

		if (!mutable) {
			// Ask `need` at a time, more only while undecided; the first decision wins.
			await collect(Number.POSITIVE_INFINITY, Math.min(QUORUM_MAX_OPERATORS, need), true);
		} else {
			const first = Math.max(need, Math.min(QUORUM_MAX_OPERATORS, this.pool.operatorCount()));
			await collect(first, first, false);
			if (!allDecidedClean() && heard.size < QUORUM_WIDEN_TO) {
				const more = QUORUM_WIDEN_TO - heard.size;
				await collect(more, more, false);
			}
		}

		// Decide, applying the standing rule to lone dissents on mutable state.
		const out: { key: string; answer: A }[] = [];
		const coolOlder = new Set<string>();
		const overruled = new Set<string>();
		let complete = true;
		for (let i = 0; i < items.length; i++) {
			const j = judge(i);
			if (!j.decided) {
				complete = false;
				continue;
			}
			for (const op of j.older) coolOlder.add(op);
			let blocked = j.backed;
			for (const d of j.lone) {
				const id = `${items[i]}\u0000${d.operator}\u0000${d.key}`;
				const st = this.standing.get(id);
				if (
					st !== undefined &&
					st.reads >= this.standingReads &&
					now - st.since >= this.standingMs
				) {
					overruled.add(d.operator);
					continue;
				}
				blocked = true;
				if (st === undefined) {
					if (this.standing.size >= QUORUM_STANDING_MAX) {
						this.standing.delete(this.standing.keys().next().value as string);
					}
					this.standing.set(id, { reads: 1, since: now });
				} else st.reads++;
			}
			if (blocked) {
				complete = false;
				continue;
			}
			out.push({ key: j.key, answer: j.answer });
			// Operators that agree on this item are no longer standing against it.
			for (const v of votes) {
				if (v.items[i]?.key !== j.key) continue;
				for (const id of this.standing.keys()) {
					if (id.startsWith(`${items[i]}\u0000${v.operator}\u0000`)) this.standing.delete(id);
				}
			}
		}
		if (!complete) return null;
		this.recordDissent(votes, coolOlder, overruled, items, out);
		return out;
	}

	/** After a decided trusted read: an operator outvoted as older, or
	 *  overruled, is left out of trusted reads (doubling); one that agreed on
	 *  everything is cleared. An operator that was AHEAD is never cooled. */
	private recordDissent<A>(
		votes: readonly { operator: string; items: readonly (ItemVote | null)[] }[],
		older: ReadonlySet<string>,
		overruled: ReadonlySet<string>,
		items: readonly string[],
		decided: readonly { key: string; answer: A }[]
	): void {
		for (const v of votes) {
			const against = items.filter((_, i) => {
				const k = v.items[i]?.key;
				return k !== undefined && k !== decided[i]?.key;
			}).length;
			if (against === 0) {
				this.dissent.delete(v.operator);
				continue;
			}
			if (!older.has(v.operator) && !overruled.has(v.operator)) continue;
			const times = (this.dissent.get(v.operator)?.times ?? 0) + 1;
			const ms = Math.min(
				QUORUM_DISSENT_COOLDOWN_MAX_MS,
				QUORUM_DISSENT_COOLDOWN_MS * 2 ** (times - 1)
			);
			this.dissent.set(v.operator, { times, until: Date.now() + ms });
			quorumLog.warn('rpc_quorum_outvoted', {
				operator: v.operator,
				items_against: against,
				reason: overruled.has(v.operator) ? 'overruled_lone_dissent' : 'older_answer',
				times,
				left_out_ms: ms
			});
		}
	}

	/** Operators currently left out of trusted reads for answering against the
	 *  majority (health / tests). */
	quorumDissent(): QuorumDissent[] {
		const now = Date.now();
		return [...this.dissent]
			.filter(([, d]) => d.until > now)
			.map(([operator, d]) => ({ operator, times: d.times, until: d.until }));
	}

	/** The operator identity a URL's answers are counted under. */
	operatorOf(url: string): string {
		return this.pool.operatorOf(url);
	}

	/** Number of configured RPC endpoints — the catch-up backfill uses this to
	 *  size its concurrent prefetch (one window per endpoint by default) and to
	 *  rotate each window's starting endpoint. */
	endpointCount(): number {
		return this.pool.snapshot().length;
	}

	/** Endpoints currently out of cooldown (usable right now). The flow-backfill
	 *  sizes its concurrency to this so a run adapts as nodes fail/recover. */
	healthyEndpointCount(): number {
		const now = Date.now();
		return Math.max(1, this.pool.snapshot().filter((e) => e.cooldownUntil <= now).length);
	}

	/** Fastest healthy endpoint's EWMA latency (ms), or a conservative default
	 *  when none has been measured yet. Basis for the flow-backfill hedge deadline. */
	fastestLatencyMs(): number {
		const now = Date.now();
		let best = Infinity;
		for (const e of this.pool.snapshot()) {
			if (e.cooldownUntil > now) continue;
			if (e.ewmaLatencyMs !== null && e.ewmaLatencyMs < best) best = e.ewmaLatencyMs;
		}
		return Number.isFinite(best) ? best : 300;
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
		}, READ);
	}

	/** v1.7.5 — fetch a RANGE of blocks in ONE HTTP request, using a
	 *  JSON-RPC 2.0 batch (an array request → an array response).
	 *
	 *  WHY THIS EXISTS: "batch" is the last of the four things the rpc.blurt.blog
	 *  operator asked us for — lower RPS, batch, exponential backoff, add jitter.
	 *  The other three shipped in v1.7.0 (DEFAULT_MAX_REQUESTS_PER_SECOND,
	 *  DEFAULT_*_COOLDOWN_LADDER_MS, DEFAULT_COOLDOWN_JITTER_FRACTION).
	 *
	 *  WHAT IT FIXES: the poller's catch-up walked blocks one HTTP request at a
	 *  time. At the head that's ~1 request per 3 s and nobody notices. After any
	 *  downtime it is thousands of requests fired as fast as pacing allows, from
	 *  every federated instance, at a handful of volunteer-run nodes — which is
	 *  exactly the HTTP 429 the operator complained about. One batch of N blocks
	 *  is 1 request instead of N.
	 *
	 *  NOT ALL NODES SUPPORT IT. Blurt nodes vary, and the tests cannot reach one
	 *  to check (they run offline), so batch support is DISCOVERED, never
	 *  assumed: the first batch to a URL either works or it doesn't, the answer is
	 *  cached per URL, and a node that can't batch silently gets the old
	 *  one-at-a-time path forever. A node that has never been asked is not
	 *  penalised, and a node that says no is not asked twice.
	 *
	 *  Errors are phrased so the pool's own classifiers see them: `isRateLimitError`
	 *  matches /\bhttp 429\b/ on the message, so a batch that gets rate-limited
	 *  rotates and cools down exactly like a single call would.
	 *
	 *  Returns results POSITIONALLY (result[i] ↔ nums[i]). JSON-RPC does not
	 *  promise response order, so responses are matched by `id`, never by index.
	 */
	async getBlocks(
		nums: readonly number[],
		startOffset = 0
	): Promise<ReadonlyArray<BlockHeader | null>> {
		if (nums.length === 0) return [];
		// One block is not a batch; skip the array framing entirely.
		if (nums.length === 1) return [await this.getBlock(nums[0]!, startOffset)];

		try {
			return await this.pool.call(
				async (url, signal) => {
					if (batchUnsupported.has(url)) throw new BatchUnsupportedError(url);

					const body = nums.map((n, i) => ({
						jsonrpc: '2.0' as const,
						id: i,
						method: 'condenser_api.get_block',
						params: [n]
					}));

					let res: Response;
					try {
						// redirects refused, reply capped — the
						// same guard as dblurt's calls; a refusal lands in the catch
						// below as a transport failure, so the pool rotates.
						res = await guardedRpcFetch()(url, {
							method: 'POST',
							// v1.7.7 — name ourselves explicitly rather than lean on the
							// global wrapper in `blurt/userAgent.ts`. The wrapper exists to
							// reach dblurt, which gives us no other way in; this call site is
							// ours, and a request that states its own identity keeps working
							// if the wrapper is ever moved, reordered, or dropped. The
							// wrapper only fills a MISSING user-agent, so this wins here.
							headers: {
								'content-type': 'application/json',
								'user-agent': morphitUserAgent(INDEXER_VERSION)
							},
							body: JSON.stringify(body),
							signal
						});
					} catch (err) {
						// Network-level failure — let the pool rotate + cool down.
						throw new Error(`batch get_block transport failure: ${String(err)}`);
					}

					if (res.status === 429) throw new Error('HTTP 429 (batch get_block)');
					if (!res.ok) {
						// A 4xx here means this node's edge (a WAF/proxy) rejects the
						// JSON-RPC ARRAY framing specifically. Many Blurt nodes return
						// 406 (or 403) to a batch `[...]` POST while serving single calls
						// fine — proven in production: a single get_block returns 200 on
						// every node that 406s the batch. That is a batch-CAPABILITY
						// answer, not a transport failure, so treat it exactly like a node
						// that can't batch: remember it and fall back to the paced
						// one-at-a-time path (which works everywhere), instead of dying on
						// a non-rotatable 4xx. This is the fix for the v1.8.1 firefight:
						// four of the six default nodes 406'd the batch, and because a 4xx
						// is not in the pool's rotate list, one such node leading the pool
						// froze the whole poller (indexed_block stuck, lag climbing).
						// 5xx / 52x stay transport errors so the pool rotates + cools down.
						if (res.status >= 400 && res.status < 500) {
							batchUnsupported.add(url);
							throw new BatchUnsupportedError(url);
						}
						throw new Error(`HTTP ${res.status} (batch get_block)`);
					}

					const json: unknown = await res.json();

					// A node that doesn't do batch answers a single object (often a
					// parse error), not an array. That is a CAPABILITY answer, not a
					// transport failure: remember it, and bail out to the paced
					// fallback WITHOUT cooling the endpoint down for being honest.
					if (!Array.isArray(json)) {
						batchUnsupported.add(url);
						throw new BatchUnsupportedError(url);
					}
					if (json.length !== nums.length) {
						throw new Error(
							`batch get_block returned ${json.length} responses for ${nums.length} requests`
						);
					}

					// Match by id — JSON-RPC explicitly permits any response order.
					const byId = new Map<number, unknown>();
					for (const entry of json as ReadonlyArray<Record<string, unknown>>) {
						const id = entry['id'];
						if (typeof id !== 'number') throw new Error('batch get_block response missing id');
						const error = entry['error'];
						if (error !== undefined && error !== null) {
							throw new Error(`batch get_block rpc error: ${JSON.stringify(error)}`);
						}
						byId.set(id, entry['result']);
					}

					return nums.map((_n, i) => {
						if (!byId.has(i)) throw new Error(`batch get_block missing response for id ${i}`);
						return (byId.get(i) as BlockHeader | null | undefined) ?? null;
					});
				},
				{ startOffset, read: true }
			);
		} catch (err) {
			if (!(err instanceof BatchUnsupportedError)) throw err;

			// ─── PACED fallback ────────────────────────────
			// This walk MUST go back through this.getBlock(), i.e. one
			// pool.call() per block. The obvious shortcut — looping inside the
			// callback above — is a trap that makes this whole task backwards:
			// EndpointPool.attemptSingle awaits pace(ep) ONCE and then invokes
			// the callback, so N requests fired inside a single callback are N
			// requests with NO pacing between them. A node that cannot batch
			// would receive a 20-request BURST where it used to receive 20 paced
			// requests — worse than the behaviour this task exists to fix, and
			// aimed at exactly the older, smaller nodes least able to absorb it.
			//
			// Going through getBlock() costs an endpoint re-selection per block
			// and that is fine: correctness of the request RATE is the entire
			// point, and this path only runs on nodes that already can't batch.
			const out: Array<BlockHeader | null> = [];
			for (const n of nums) out.push(await this.getBlock(n, startOffset));
			return out;
		}
	}

	/** Fetch a specific block.  Background call (poller).  `startOffset` rotates
	 *  the pool's primary endpoint order (concurrent backfill spread); 0 = the
	 *  normal fastest-first behaviour. */
	async getBlock(num: number, startOffset = 0): Promise<BlockHeader | null> {
		return this.pool.call(
			async (url, signal) => {
				const client = clientFor(url);
				const block = (await withSignal(client.condenser.getBlock(num), signal)) as unknown as
					| BlockHeader
					| null
					| undefined;
				return block ?? null;
			},
			{ startOffset, read: true }
		);
	}

	/** Cross-check one block height across endpoints of different operator names
	 *  (operators are counted by node name). Asks several nodes for the SAME
	 *  block and reports whether `minAgree` of them return the same block id.
	 *  Background call. Returns a verdict and never throws on disagreement; the
	 *  only caller (the poller) treats it as an alarm and logs it — it does not
	 *  gate what is indexed. */
	async crossCheckChainConsistency(
		height: number,
		opts: { minAgree?: number; timeoutMs?: number } = {}
	): Promise<ChainConsistencyResult> {
		const minAgree = Math.max(1, opts.minAgree ?? 2);
		const result = await this.pool.quorumCall<BlockHeader>(
			async (url, signal) => {
				const client = clientFor(url);
				const block = (await withSignal(client.condenser.getBlock(height), signal)) as unknown as
					| BlockHeader
					| null
					| undefined;
				// A node that doesn't have the block yet returns null → the pool
				// treats it as a non-answer (not a transport failure, no cooldown).
				return block ?? null;
			},
			{
				equivalenceKey: blockConsistencyKey,
				minAgree,
				maxOperators: Math.max(QUORUM_MAX_OPERATORS, minAgree),
				...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {})
			}
		);
		return interpretChainConsistency(result, minAgree);
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
				const accounts = (await withSignal(client.condenser.getAccounts([name]), signal)) as
					| readonly ChainAccount[]
					| null
					| undefined;
				if (!accounts || accounts.length === 0) return null;
				return accounts[0] ?? null;
			},
			{ hedge: userFacing, read: true }
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
				const list = (await withSignal(client.condenser.getAccounts(unique), signal)) as
					| readonly ChainAccount[]
					| null
					| undefined;
				const map = new Map<string, ChainAccount>();
				for (const acc of list ?? []) {
					map.set(acc.name, acc);
				}
				return map;
			},
			{ hedge: userFacing, read: true }
		);
	}

	/**
	 * Batch account fetch that OPERATORS (counted by node name) must agree on
	 * (v1.18.0 review, D1). Background priority.
	 *
	 * For an answer that is WRITTEN DOWN and trusted afterwards. `getAccounts`
	 * asks one endpoint, which is right for a read used once and wrong for the
	 * posting-key reconcile: its answer becomes a confirmed key the fast path
	 * verifies against with no further check, so a node that is stuck behind —
	 * or hostile, since the pool includes community and on-chain-directory
	 * nodes — could confirm exactly the leaked key the reconcile exists to shut
	 * out, permanently.
	 *
	 * `agreeOn` reduces one endpoint's answer to what must match — here, each
	 * requested account's signing key, with a missing account counted as its
	 * own value so a node that does not know an account yet disagrees rather
	 * than abstains. Each account is decided on its own by the majority of the
	 * operators that answered, at least trustedQuorumSize() of them agreeing —
	 * two whenever the pool has two operators, however many happen to be
	 * reachable right now (see majorityRead). Returns null when some account
	 * could not be decided with the operators available: the caller then
	 * learns nothing and tries again later.
	 */
	async getAccountsAgreed(
		names: readonly string[],
		agreeOn: (account: ChainAccount | undefined) => string
	): Promise<ReadonlyMap<string, ChainAccount> | null> {
		if (names.length === 0) return new Map();
		const unique = Array.from(new Set(names)).sort();
		// rv2-2: distinct OPERATORS, not URLs. The size is fixed by the pool,
		// never by who answered last. VT1-3: decided per account by the
		// majority of the operators that answered (majorityRead), so one node
		// lying about one account neither wins nor voids the batch.
		const decided = await this.majorityRead<Map<string, ChainAccount>>(
			async (url, signal) => {
				const client = clientFor(url);
				const list = (await withSignal(client.condenser.getAccounts(unique), signal)) as
					| readonly ChainAccount[]
					| null
					| undefined;
				if (!Array.isArray(list)) return null;
				const map = new Map<string, ChainAccount>();
				for (const acc of list) if (acc && typeof acc.name === 'string') map.set(acc.name, acc);
				return map;
			},
			unique.map((n) => `account:${n}`),
			(map, i) => {
				// VT5-1: WHEN the chain last changed the account is part of what must
				// match, and says which of two answers is older — a node that has not
				// applied a key rotation names the old key with an older time.
				const acc = map.get(unique[i]!);
				const at = acc?.last_account_update;
				const fresh = typeof at === 'string' ? Date.parse(at.endsWith('Z') ? at : `${at}Z`) : NaN;
				return {
					key: `${agreeOn(acc)}@${typeof at === 'string' ? at : ''}`,
					fresh: Number.isFinite(fresh) ? fresh : null
				};
			},
			this.trustedQuorumSize(),
			true
		);
		if (decided === null) return null;
		const out = new Map<string, ChainAccount>();
		unique.forEach((name, i) => {
			const acc = decided[i]?.answer.get(name);
			if (acc !== undefined) out.set(name, acc);
		});
		return out;
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
			// A broadcast is not a read: the chain's rejection of a transaction
			// is the answer and must come from the first node asked.
			{ hedge, read: !method.startsWith('broadcast_') }
		);
	}
}

/** Re-export for consumers that want to inspect transport errors
 *  without pulling rpc-pool directly. */
export { isTransportError };
