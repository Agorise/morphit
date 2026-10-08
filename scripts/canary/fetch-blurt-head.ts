/**
 * scripts/canary/fetch-blurt-head.ts
 *
 * CLI used by generate.sh to fetch the Blurt chain head for the warrant
 * canary, hopping across the canonical DEFAULT_BLURT_RPC_ENDPOINTS rotator
 * list until one node answers. Previously the canary pinned a single node
 * and a 526 from that one witness stalled the whole refresh; now a dead node
 * is skipped exactly as the app's own RPC pool skips it.
 *
 * The endpoint list is imported from @morphit/operator-config — the SAME
 * single source of truth release-broadcast.ts uses — so adding or removing a
 * node happens in one place and every component (app, indexer, release
 * tooling, and now the canary) follows.
 *
 * Contract:
 *   stdout — on success, exactly ONE tab-separated line:
 *              <head_block_number>\t<head_block_id>\t<time>
 *            (time is the raw chain time; generate.sh appends "Z")
 *   stderr — progress + which node answered (kept off stdout so the line
 *            stays clean and machine-parseable)
 *   exit   — 0 on success, 1 if EVERY endpoint failed
 */
import {
	DEFAULT_BLURT_RPC_ENDPOINTS,
	DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS
} from '@morphit/operator-config';
import { canaryIsTorOnly, installTorDispatcherIfTorOnly } from './torSocksDispatcher.js';
import {
	type BlurtHead,
	canaryDefaultNodes,
	fetchBlurtHeadWithFailover,
	parseHead,
	resolveCanaryNodes
} from './blurtHeadFailover.js';

/** Per-node timeout. Matches the old `curl --max-time 15`. */
const TIMEOUT_MS = 15_000;

/** Live single-node fetch: POST get_dynamic_global_properties, parse+validate,
 *  or return null on ANY failure so the walk moves to the next node. */
async function fetchOneLive(url: string): Promise<BlurtHead | null> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'condenser_api.get_dynamic_global_properties',
				params: [],
				id: 1
			}),
			signal: ctrl.signal
		});
		if (!resp.ok) {
			process.stderr.write(`canary:   ${url} -> HTTP ${resp.status}\n`);
			return null;
		}
		const data = (await resp.json()) as { result?: unknown };
		const head = parseHead(data?.result);
		if (!head) {
			process.stderr.write(`canary:   ${url} -> malformed / empty result\n`);
			return null;
		}
		return head;
	} catch (err) {
		// undici reports every connection failure as "fetch failed" and keeps the
		// real reason (refused, TLS, proxy) in `cause`; show both.
		const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
		const msg =
			err instanceof Error
				? cause instanceof Error && cause.message !== err.message
					? `${err.message} (${cause.message})`
					: err.message
				: String(err);
		process.stderr.write(`canary:   ${url} -> ${msg}\n`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function main(): Promise<void> {
	// on a tor-only node, pin every fetch to the Tor SOCKS proxy so the
	// clearnet RPC read reaches its endpoint through a Tor exit (hiding the
	// node's real IP) instead of leaking it. No-op on clearnet. Fail-closed: if
	// Tor is down the fetch errors and the failover exits 1 (a stale canary must
	// not publish) — it never falls back to a direct clearnet connection.
	const route = installTorDispatcherIfTorOnly();
	process.stderr.write(`canary: chain-head fetch route = ${route}\n`);
	// Override (comma list) PREFERRED-FIRST, then the default list — which on a
	// tor-only node is every default hidden .onion, never clearnet (D12).
	const nodes = resolveCanaryNodes(
		process.env.MORPHIT_CANARY_BLURT_RPC,
		canaryDefaultNodes(
			canaryIsTorOnly(),
			DEFAULT_BLURT_RPC_ENDPOINTS,
			DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS
		)
	);
	process.stderr.write(
		`canary: fetching Blurt chain head (failover across ${nodes.length} node(s))...\n`
	);
	const got = await fetchBlurtHeadWithFailover(nodes, fetchOneLive);
	if (!got) {
		process.stderr.write(
			`canary: all ${nodes.length} Blurt RPC endpoint(s) failed — could not fetch chain head\n`
		);
		process.exit(1);
	}
	process.stderr.write(`canary: got head ${got.head.head_block_number} from ${got.url}\n`);
	// Exit once the line is out: a connection still open (a node that never
	// answered for an earlier attempt) must not keep this process — and
	// generate.sh, which waits for it — alive.
	process.stdout.write(
		`${got.head.head_block_number}\t${got.head.head_block_id}\t${got.head.time}\n`,
		() => process.exit(0)
	);
}

void main();
