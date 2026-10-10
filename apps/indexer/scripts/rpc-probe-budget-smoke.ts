/**
 * rpc-probe-budget-smoke (v1.21.5)
 *
 * The stats page's "RPC endpoints" card shows the pool's passive snapshot,
 * then asks the indexer for a fresh active probe (`/v1/rpc-endpoints?probe=1`)
 * and repaints with it. The indexer answers only once the slowest node has
 * answered or timed out — and a node that misses is tried twice, with up to
 * 20 s per try for an I2P node.
 *
 * The browser waited the ordinary 8 s indexer budget for that answer. So
 * whenever one hidden node was slow or down, the browser gave up first, and
 * the card stayed on the passive snapshot: "Probing…" for every hidden node
 * (the pool seldom calls them, so it has no latency for them) and stale
 * figures for the clearnet nodes the pool had not used lately — the report
 * that the card "is not showing accurate connection info anymore".
 *
 * Held here, across the two apps and the reverse proxy:
 *   1. the browser's wait for the probe covers the indexer's worst case;
 *   2. the browser really uses that budget for the probe, and only the probe;
 *   3. the reverse proxy in front of /v1/ does not cut the answer off first
 *      (nginx's default proxy_read_timeout is 60 s; neither shipped /v1/
 *      location sets a shorter one).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROBE_WORST_CASE_MS } from '../src/api/rpcHealth.ts';
import {
	RPC_PROBE_SERVER_WORST_MS,
	INDEXER_TIMEOUT_CLEARNET_MS,
	rpcProbeTimeoutMs,
	indexerTimeoutMs
} from '../../web/src/lib/net/transportBudget.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (cond) pass++;
	else fail++;
}

// ── 1. the budgets ──────────────────────────────────────────────────────────
check(
	`the indexer's worst case is what its timeouts add up to (2 × (20 s I2P + 1.2 s proxy check) = 42.4 s; got ${PROBE_WORST_CASE_MS} ms)`,
	PROBE_WORST_CASE_MS === 42_400
);
check(
	`the browser allows the indexer at least its worst case (${RPC_PROBE_SERVER_WORST_MS} ≥ ${PROBE_WORST_CASE_MS})`,
	RPC_PROBE_SERVER_WORST_MS >= PROBE_WORST_CASE_MS
);
check(
	'the probe budget is the API budget plus the indexer’s probing time (clearnet page)',
	rpcProbeTimeoutMs('') === indexerTimeoutMs('') + RPC_PROBE_SERVER_WORST_MS &&
		rpcProbeTimeoutMs('') > INDEXER_TIMEOUT_CLEARNET_MS + PROBE_WORST_CASE_MS - 1
);
check(
	'a hidden target gets the hidden API budget on top',
	rpcProbeTimeoutMs('http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion') >
		rpcProbeTimeoutMs('')
);

// ── 2. the client uses it, for the probe only ───────────────────────────────
{
	const client = read('apps/web/src/lib/indexer/client.ts');
	const fn = client.slice(client.indexOf('export function getRpcEndpoints('));
	const body = fn.slice(0, fn.indexOf('\n}\n'));
	check(
		'getRpcEndpoints passes rpcProbeTimeoutMs as minTimeoutMs on the ?probe=1 call',
		/'\/v1\/rpc-endpoints\?probe=1',\s*\{[^}]*minTimeoutMs:\s*rpcProbeTimeoutMs\(/.test(body)
	);
	check(
		'the passive snapshot keeps the ordinary budget (no minTimeoutMs on it)',
		/request<RpcEndpointsResponse>\('\/v1\/rpc-endpoints',\s*\{\s*signal:\s*opts\?\.signal\s*\}\)/.test(
			body
		)
	);
	check(
		'request() honours minTimeoutMs (never shorter than the default)',
		/Math\.max\(indexerTimeoutMs\(MORPHIT_INDEXER_ORIGIN\), init\.minTimeoutMs \?\? 0\)/.test(
			client
		)
	);
}

// ── 3. the reverse proxy does not cut it off ────────────────────────────────
const NGINX_DEFAULT_READ_MS = 60_000;
for (const conf of ['ops/nginx/web.conf', 'ops/bunkerweb/frontend/nginx.conf']) {
	const src = read(conf);
	const at = src.indexOf('location /v1/ {');
	const block = at < 0 ? '' : src.slice(at, src.indexOf('\n    }', at));
	const m = /proxy_read_timeout\s+(\d+)(s|m)?;/.exec(block);
	const readMs = m ? Number(m[1]) * (m[2] === 'm' ? 60_000 : 1000) : NGINX_DEFAULT_READ_MS;
	check(`${conf}: the /v1/ location exists`, at >= 0);
	check(
		`${conf}: /v1/ read timeout (${readMs} ms) outlasts the indexer's worst case (${PROBE_WORST_CASE_MS} ms)`,
		readMs > PROBE_WORST_CASE_MS
	);
}

if (fail === 0) console.log(`✓ all ${pass} rpc-probe-budget scenarios passed`);
else {
	console.error(`✗ ${fail} of ${pass + fail} rpc-probe-budget checks FAILED`);
	process.exit(1);
}
