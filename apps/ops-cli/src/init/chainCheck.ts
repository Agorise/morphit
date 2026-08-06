/**
 * Morphit ops CLI — Blurt chain account lookup.
 *
 * Single-purpose: during the wizard, when the operator types
 * their relay account name, look it up on-chain to confirm it
 * exists and report the current balance.  Catches typos
 * before they cause confusing errors at relay startup.
 *
 * Tries multiple public RPC endpoints; first response wins.
 * 5-second hard timeout per endpoint.  Returns null on
 * "account doesn't exist" (Blurt returns an empty array, not
 * an error).  Throws on network/RPC failure so the caller
 * can decide whether to abort or let the operator proceed.
 */

import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';

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
 *  null on "no such account", throws on transport failure. */
export async function lookupBlurtAccount(
	accountName: string,
	endpoints: readonly string[] = DEFAULT_BLURT_RPC_ENDPOINTS
): Promise<AccountInfo | null> {
	let lastError: unknown = null;
	for (const endpoint of endpoints) {
		try {
			const result = await callRpc(endpoint, 'condenser_api.get_accounts', [[accountName]]);
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
		} catch (err) {
			lastError = err;
			continue;
		}
	}
	throw new Error(
		`Could not reach any Blurt RPC endpoint.  Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
	);
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
// ever stalls). Reuses the same `callRpc` primitive the account lookup
// uses — one RPC code path in ops-cli.

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
			lines.push(`  DEAD ${r.url}  (${r.error})`);
		}
	}
	if (summary.total === 0) {
		lines.push('No RPC endpoints are configured to probe.');
	} else if (summary.healthy === 0) {
		lines.push(
			`All ${summary.total} RPC endpoints are unreachable. The node CANNOT sync or ` +
				`broadcast until at least one works — fix the endpoint list and re-check.`
		);
	} else if (summary.healthy < summary.total) {
		lines.push(
			`${summary.healthy} of ${summary.total} RPC endpoints reachable. The node will ` +
				`work, but redundancy is reduced — consider replacing the dead one(s).`
		);
	} else {
		lines.push(`All ${summary.total} RPC endpoints reachable.`);
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
	if (!/^[a-z0-9-]+$/.test(name)) {
		return {
			ok: false,
			message: 'Only lowercase letters, numbers, and dashes are allowed.'
		};
	}
	if (name.includes('--')) {
		return {
			ok: false,
			message: 'No consecutive dashes.'
		};
	}
	if (name.endsWith('-')) {
		return {
			ok: false,
			message: 'Cannot end with a dash.'
		};
	}
	return { ok: true };
}
