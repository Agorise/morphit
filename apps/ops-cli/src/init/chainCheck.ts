/**
 * Morphit ops CLI — Blurt chain account lookup.
 *
 * Single-purpose: during the wizard, when the operator types
 * their relay account name, look it up on-chain to confirm it
 * exists and report the current balance.  Catches typos
 * before they cause confusing errors at relay startup.
 *
 * Routed via lib/chainAccess.ts (local indexer first, then the
 * health-ordered pool — see lookupBlurtAccount).  Returns null on
 * "account doesn't exist" (Blurt returns an empty array, not
 * an error).  Throws on network/RPC failure so the caller
 * can decide whether to abort or let the operator proceed.
 */

import { chainRead, type ChainAccessDeps } from '../lib/chainAccess.ts';

export interface AccountInfo {
	readonly name: string;
	readonly balance: string; // e.g. "412.500 BLURT"
	readonly balanceBlurt: number; // parsed numeric value
}

interface BlurtAccountRow {
	name: string;
	balance: string;
}

/** Look up an account by name.  Returns AccountInfo on hit,
 *  null on "no such account", throws on transport failure.
 *
 *  v1.20.0 (D12): reads go through lib/chainAccess.ts — this node's own indexer
 *  first (it holds the full 20-node pool and its learned health); if it does not
 *  answer AND the node is not hidden-only, a health-ordered EndpointPool over
 *  the configured clearnet list (shared health file) — never a fixed-order walk
 *  that always starts on the same node. A HIDDEN-ONLY node never falls back to
 *  clearnet (v1.18.0 deep-deep, H1): if its indexer does not answer this throws,
 *  and every caller already treats that as "unknown". An explicit `endpoints`
 *  list (tests / a wizard probing a candidate list) is used as the pool. */
export async function lookupBlurtAccount(
	accountName: string,
	endpoints?: readonly string[],
	deps: ChainAccessDeps = {}
): Promise<AccountInfo | null> {
	let result: unknown;
	try {
		result = await chainRead<unknown>('get_accounts', [[accountName]], deps, endpoints);
	} catch (err) {
		throw new Error(
			`Could not reach the Blurt network (local indexer or any configured RPC node). Last error: ${err instanceof Error ? err.message : String(err)}`
		);
	}
	return accountInfoFromRows(result, accountName);
}

/** Shape a get_accounts result into AccountInfo (null = no such account). */
function accountInfoFromRows(result: unknown, accountName: string): AccountInfo | null {
	if (!Array.isArray(result) || result.length === 0) return null;
	const first = result[0];
	// cp139-C-2: runtime type guard before the cast.  If a
	// rogue RPC endpoint returns `[null]` (or any non-object)
	// as the first row, `first.balance` would TypeError on
	// the null path.  The catch below would absorb it and
	// fall through to the next endpoint, but a hostile
	// upstream serving all 4 fallbacks the same garbage
	// would yield an opaque "Could not reach any Blurt RPC"
	// error instead of a clean "account doesn't exist"
	// return.  Treat non-object as same-as-empty (account
	// not found).
	if (typeof first !== 'object' || first === null) return null;
	const row = first as BlurtAccountRow;
	const balanceStr = row.balance ?? '0.000 BLURT';
	const m = /^([\d.]+)\s+BLURT$/.exec(balanceStr);
	const balanceBlurt = m !== null ? parseFloat(m[1]!) : 0;
	return {
		name: row.name ?? accountName,
		balance: balanceStr,
		balanceBlurt
	};
}

async function callRpc(
	endpoint: string,
	method: string,
	params: unknown[],
	timeoutMs = 5000
): Promise<unknown> {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method,
				params,
				id: 1
			}),
			signal: controller.signal
		});
		if (!resp.ok) {
			throw new Error(`HTTP ${resp.status} from ${endpoint}`);
		}
		const json = (await resp.json()) as { result?: unknown; error?: unknown };
		if (json.error !== undefined) {
			throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
		}
		return json.result;
	} finally {
		clearTimeout(t);
	}
}

// ─── RPC endpoint validation (beta5 item B) ─────────────────────────
//
// Config-time check that the operator's configured Blurt RPC endpoints
// are actually reachable: each gets a real
// `condenser_api.get_dynamic_global_properties` call (the same read the
// indexer uses to learn chain head), exercising DNS resolution +
// connectivity + a valid chain response. Used by both `morphit-ops
// init` (warn before the operator finishes setup) and `doctor` (catch
// the all-endpoints-dead case that froze a real node's sync, before it
// ever stalls). A probe deliberately asks EACH endpoint directly (that is
// what it measures); ordinary reads go through lib/chainAccess.ts instead.

export interface RpcProbeResult {
	readonly url: string;
	readonly ok: boolean;
	readonly latencyMs: number | null;
	/** head_block_number the endpoint reported, or null on failure. */
	readonly headBlock: number | null;
	/** Human-readable failure reason (DNS/timeout/HTTP/RPC), or null. */
	readonly error: string | null;
}

export interface RpcProbeSummary {
	readonly results: readonly RpcProbeResult[];
	readonly healthy: number;
	readonly total: number;
	/** Highest head_block_number any reachable endpoint reported — the
	 *  chain head, handy for suggesting a fast-forward target. Null when
	 *  no endpoint responded. */
	readonly headBlock: number | null;
}

/** Probe one endpoint with a real get_dynamic_global_properties call.
 *  Never throws — failures come back as `{ ok: false, error }`. */
export async function probeRpcEndpoint(url: string, timeoutMs = 5000): Promise<RpcProbeResult> {
	const start = Date.now();
	try {
		const result = await callRpc(
			url,
			'condenser_api.get_dynamic_global_properties',
			[],
			timeoutMs
		);
		const latencyMs = Date.now() - start;
		const head =
			result !== null && typeof result === 'object' && 'head_block_number' in result
				? (result as { head_block_number?: unknown }).head_block_number
				: undefined;
		if (typeof head !== 'number') {
			return {
				url,
				ok: false,
				latencyMs,
				headBlock: null,
				error: 'reachable but returned an unexpected response (no head_block_number) — not a Blurt RPC node?'
			};
		}
		return { url, ok: true, latencyMs, headBlock: head, error: null };
	} catch (err) {
		return {
			url,
			ok: false,
			latencyMs: null,
			headBlock: null,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

/** Aggregate per-endpoint probe results. PURE — unit-testable. */
export function summarizeProbes(results: readonly RpcProbeResult[]): RpcProbeSummary {
	const healthy = results.filter((r) => r.ok).length;
	const heads = results
		.map((r) => r.headBlock)
		.filter((h): h is number => typeof h === 'number');
	return {
		results,
		healthy,
		total: results.length,
		headBlock: heads.length > 0 ? Math.max(...heads) : null
	};
}

/** Probe every endpoint in parallel and summarise. Never throws. */
export async function probeRpcEndpoints(
	urls: readonly string[],
	timeoutMs = 5000
): Promise<RpcProbeSummary> {
	const results = await Promise.all(urls.map((u) => probeRpcEndpoint(u, timeoutMs)));
	return summarizeProbes(results);
}

/** Render a probe summary as plain text lines (no ANSI) for the caller
 *  to print. PURE — unit-testable. The trailing verdict names the
 *  failure mode an operator most needs to recognise. */
export function formatRpcProbeLines(summary: RpcProbeSummary): string[] {
	const lines: string[] = [];
	for (const r of summary.results) {
		if (r.ok) {
			lines.push(`  OK   ${r.url}  (${r.latencyMs} ms, head ${r.headBlock})`);
		} else {
			// "down now", not "DEAD": a node blipping is NORMAL — the pool routes
			// around it and re-tests it. Alarm language for a routine, self-healing
			// condition is a false alarm (review D12).
			lines.push(`  down now  ${r.url}  (${r.error})`);
		}
	}
	// IMPORTANT: this probe only reaches the CLEARNET endpoints in the config from
	// THIS host. It cannot reach the node's hidden (Tor/I2P) RPC nodes, and the
	// pool automatically picks the fastest reachable node, so a host-side count is
	// never the whole story. The authoritative healthy/total (clearnet + hidden)
	// is the indexer's own /v1/health rpc_endpoints_healthy/total — never conclude
	// "cannot sync/broadcast" from this partial view, and never hand-prune a node.
	if (summary.total === 0) {
		lines.push('No RPC endpoints are configured to probe.');
	} else if (summary.healthy === 0) {
		lines.push(
			`None of the ${summary.total} clearnet RPC endpoints answered this host-side probe. ` +
				`That is not the full picture: this node also uses hidden (Tor/I2P) RPC nodes a host ` +
				`probe cannot reach, and the pool routes around any that are down. Check the ` +
				`authoritative count at the indexer's /v1/health (rpc_endpoints_healthy/total) before ` +
				`concluding anything.`
		);
	} else if (summary.healthy < summary.total) {
		lines.push(
			`${summary.healthy} of ${summary.total} clearnet RPC endpoints answered. Nodes going ` +
				`down for a while is normal — the pool picks the fastest reachable one automatically, ` +
				`so there is nothing to prune by hand. /v1/health shows the full count including hidden nodes.`
		);
	} else {
		lines.push(`All ${summary.total} probed clearnet RPC endpoints answered.`);
	}
	return lines;
}

/** Validate a Blurt account name format.  Same rules as the chain:
 *  3-16 chars, lowercase, alphanumeric + dashes, must start with
 *  a letter, no consecutive dashes. */
export function validateBlurtAccountName(name: string): {
	ok: boolean;
	message?: string;
} {
	if (name.length < 3) {
		return { ok: false, message: 'Too short — minimum 3 characters.' };
	}
	if (name.length > 16) {
		return { ok: false, message: 'Too long — maximum 16 characters.' };
	}
	if (!/^[a-z]/.test(name)) {
		return {
			ok: false,
			message: 'Must start with a lowercase letter.'
		};
	}
	if (!/^[a-z0-9.-]+$/.test(name)) {
		return {
			ok: false,
			message: 'Only lowercase letters, numbers, dashes, and dots are allowed.'
		};
	}
	if (name.includes('--')) {
		return {
			ok: false,
			message: 'No consecutive dashes.'
		};
	}
	if (name.includes('..')) {
		return {
			ok: false,
			message: 'No consecutive dots.'
		};
	}
	if (name.endsWith('-') || name.endsWith('.')) {
		return {
			ok: false,
			message: 'Cannot end with a dash or dot.'
		};
	}
	// Each dot-separated segment must start with a letter (Blurt rule), so a name
	// like "my.relay" is fine but ".relay" or "my.9relay" is not.
	if (!name.split('.').every((seg) => /^[a-z]/.test(seg))) {
		return {
			ok: false,
			message: 'Each part (between dots) must start with a lowercase letter.'
		};
	}
	return { ok: true };
}
