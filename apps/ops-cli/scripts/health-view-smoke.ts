/**
 * health-view-smoke (beta11 item 2).
 *
 * Unit-tests the PURE cores of `morphit-ops health` — the live indexer
 * health view that talks to the indexer's own /v1/health HTTP endpoint
 * (so it needs NO config file + NO DB, and can't EACCES as a non-root
 * user the way the `status` dashboard can):
 *
 *   - ensureHealthPath: append /v1/health to a bare origin, leave an
 *     explicit path alone, pass an unparseable string through.
 *   - resolveHealthUrl: the flag/env precedence ladder, entirely from
 *     flags + env (no file access), so it can never hit a permission
 *     error on a root-owned config.
 *   - summarizeHealth: tolerant parsing of the /v1/health body (missing
 *     fields → null; stale/degraded → not synced; the "all RPC down"
 *     signal).
 *   - classifyHealthResult: fetch-result → outcome + EXIT CODE (0 synced,
 *     1 reachable-but-behind, 2 can't-reach / wrong-thing-answered).
 *
 * Plus structural wiring assertions on main.ts: `health` dispatches in
 * the pre-DB group, and url/host/port are value-taking flags. The actual
 * HTTP GET runs against a live indexer and isn't exercised here.
 */

import {
	ensureHealthPath,
	resolveHealthUrl,
	summarizeHealth,
	classifyHealthResult,
	DEFAULT_INDEXER_HOST,
	DEFAULT_INDEXER_PORT
} from '../src/commands/health.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};
const expect = (n: string, c: boolean, d = '') => (c ? ok(n) : bad(n, d));

// ─── HV-1: ensureHealthPath ─────────────────────────────────────────
expect(
	'HV-1a bare origin gets /v1/health appended',
	ensureHealthPath('http://127.0.0.1:8081') === 'http://127.0.0.1:8081/v1/health'
);
expect(
	'HV-1b bare https origin gets /v1/health appended',
	ensureHealthPath('https://morphit.io') === 'https://morphit.io/v1/health'
);
expect(
	'HV-1c trailing-slash-only path gets /v1/health',
	ensureHealthPath('http://127.0.0.1:8081/') === 'http://127.0.0.1:8081/v1/health'
);
expect(
	'HV-1d an explicit path is left alone',
	ensureHealthPath('https://morphit.io/custom/health') === 'https://morphit.io/custom/health'
);
expect('HV-1e an unparseable string passes through', ensureHealthPath('not a url') === 'not a url');

// ─── HV-2: resolveHealthUrl precedence ──────────────────────────────
{
	// (1) --url wins over everything, and gets /v1/health appended.
	expect(
		'HV-2a --url beats env + host/port, path appended',
		resolveHealthUrl(
			{ url: 'http://10.0.0.5:9000', host: 'ignored', port: '1' },
			{ MORPHIT_OPS_HEALTH_URL: 'http://env', MORPHIT_INDEXER_LISTEN_HOST: 'envhost' }
		) === 'http://10.0.0.5:9000/v1/health'
	);
	// (2) env URL when no --url.
	expect(
		'HV-2b MORPHIT_OPS_HEALTH_URL used when no --url',
		resolveHealthUrl({}, { MORPHIT_OPS_HEALTH_URL: 'https://morphit.io/v1/health' }) ===
			'https://morphit.io/v1/health'
	);
	// (3) --host/--port beat env host/port.
	expect(
		'HV-2c --host/--port beat env host/port',
		resolveHealthUrl(
			{ host: '192.168.1.9', port: '7000' },
			{ MORPHIT_INDEXER_LISTEN_HOST: 'envhost', MORPHIT_INDEXER_LISTEN_PORT: '1234' }
		) === 'http://192.168.1.9:7000/v1/health'
	);
	// (4) env host/port when no flags.
	expect(
		'HV-2d env host/port when no flags',
		resolveHealthUrl(
			{},
			{ MORPHIT_INDEXER_LISTEN_HOST: '172.20.0.3', MORPHIT_INDEXER_LISTEN_PORT: '8081' }
		) === 'http://172.20.0.3:8081/v1/health'
	);
	// (5) canonical loopback default when nothing is set.
	expect(
		'HV-2e default 127.0.0.1:8081 when nothing set',
		resolveHealthUrl({}, {}) === `http://${DEFAULT_INDEXER_HOST}:${DEFAULT_INDEXER_PORT}/v1/health`
	);
	// whitespace-only values fall through to the next source / default.
	expect(
		'HV-2f whitespace --url is ignored (falls through to default)',
		resolveHealthUrl({ url: '   ' }, {}) === 'http://127.0.0.1:8081/v1/health'
	);
	expect(
		'HV-2g whitespace host falls back to the default host',
		resolveHealthUrl({ host: '   ', port: '9' }, {}) === 'http://127.0.0.1:9/v1/health'
	);
}

// ─── HV-3: summarizeHealth ──────────────────────────────────────────
{
	const full = summarizeHealth({
		stale: false,
		status: 'ok',
		version: '1.0.0-beta.11',
		indexed_block: 1000,
		chain_head_block: 1002,
		lag_blocks: 2,
		uptime_sec: 3661,
		rpc_endpoints_healthy: 3,
		rpc_endpoints_total: 4
	});
	expect(
		'HV-3a full healthy body parsed',
		full.synced &&
			full.status === 'ok' &&
			full.version === '1.0.0-beta.11' &&
			full.indexedBlock === 1000 &&
			full.chainHeadBlock === 1002 &&
			full.lagBlocks === 2 &&
			full.uptimeSec === 3661 &&
			full.rpcHealthy === 3 &&
			full.rpcTotal === 4 &&
			!full.rpcAllDown,
		JSON.stringify(full)
	);
	expect('HV-3b stale:true → not synced', !summarizeHealth({ stale: true }).synced);
	expect("HV-3c status 'degraded' → not synced", !summarizeHealth({ status: 'degraded' }).synced);
	const allDown = summarizeHealth({ rpc_endpoints_healthy: 0, rpc_endpoints_total: 4 });
	expect('HV-3d rpcAllDown true when 0/total reachable', allDown.rpcAllDown);
	const someUp = summarizeHealth({ rpc_endpoints_healthy: 1, rpc_endpoints_total: 4 });
	expect('HV-3e rpcAllDown false when some reachable', !someUp.rpcAllDown);
	const missing = summarizeHealth({});
	expect(
		'HV-3f missing fields become null (no crash), synced defaults true',
		missing.indexedBlock === null &&
			missing.chainHeadBlock === null &&
			missing.lagBlocks === null &&
			missing.uptimeSec === null &&
			missing.rpcHealthy === null &&
			missing.rpcTotal === null &&
			!missing.rpcAllDown &&
			missing.synced,
		JSON.stringify(missing)
	);
	expect(
		'HV-3g non-object body tolerated',
		summarizeHealth(null).status === 'unknown' && summarizeHealth(42).synced
	);
}

// ─── HV-4: classifyHealthResult → outcome + exit code ───────────────
{
	const unreachable = classifyHealthResult({
		fetchError: 'ECONNREFUSED',
		httpStatus: null,
		jsonOk: false,
		body: null
	});
	expect(
		'HV-4a fetch error → unreachable, exit 2',
		unreachable.kind === 'unreachable' && unreachable.exitCode === 2 && unreachable.summary === null
	);

	const http404 = classifyHealthResult({ fetchError: null, httpStatus: 404, jsonOk: false, body: null });
	expect('HV-4b HTTP 404 → http-error, exit 2', http404.kind === 'http-error' && http404.exitCode === 2);

	const http500 = classifyHealthResult({ fetchError: null, httpStatus: 500, jsonOk: false, body: null });
	expect('HV-4c HTTP 500 → http-error, exit 2', http500.kind === 'http-error' && http500.exitCode === 2);

	const notJson = classifyHealthResult({ fetchError: null, httpStatus: 200, jsonOk: false, body: null });
	expect(
		'HV-4d 200 but non-JSON (proxy HTML) → not-indexer, exit 2',
		notJson.kind === 'not-indexer' && notJson.exitCode === 2
	);

	const synced = classifyHealthResult({
		fetchError: null,
		httpStatus: 200,
		jsonOk: true,
		body: { stale: false, indexed_block: 10, chain_head_block: 10, lag_blocks: 0 }
	});
	expect(
		'HV-4e synced body → synced, exit 0, summary present',
		synced.kind === 'synced' && synced.exitCode === 0 && synced.summary !== null && synced.summary.synced
	);

	const behind = classifyHealthResult({
		fetchError: null,
		httpStatus: 200,
		jsonOk: true,
		body: { stale: true, indexed_block: 5, chain_head_block: 10, lag_blocks: 5 }
	});
	expect(
		'HV-4f behind body → behind, exit 1',
		behind.kind === 'behind' && behind.exitCode === 1 && behind.summary !== null && !behind.summary.synced
	);

	const behindRpc = classifyHealthResult({
		fetchError: null,
		httpStatus: 200,
		jsonOk: true,
		body: { stale: true, rpc_endpoints_healthy: 0, rpc_endpoints_total: 4 }
	});
	expect(
		'HV-4g behind + all RPC down → behind exit 1, message blames RPC',
		behindRpc.kind === 'behind' &&
			behindRpc.exitCode === 1 &&
			/RPC/.test(behindRpc.message) &&
			behindRpc.summary !== null &&
			behindRpc.summary.rpcAllDown
	);

	// A 2xx other than 200 (e.g. 204) with JSON should still classify as
	// synced/behind, not http-error — the guard is <200 || >=300.
	const http204 = classifyHealthResult({
		fetchError: null,
		httpStatus: 299,
		jsonOk: true,
		body: { stale: false }
	});
	expect('HV-4h 2xx boundary (299) with JSON is not an http-error', http204.kind === 'synced');
}

// ─── HV-5: structural wiring in main.ts ─────────────────────────────
{
	const main = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts'),
		'utf8'
	);
	expect('HV-5a main imports runHealth', /import \{ runHealth \} from '\.\/commands\/health\.ts'/.test(main));
	expect("HV-5b main dispatches the 'health' subcommand", /args\.subcommand === 'health'/.test(main));
	expect('HV-5c the health dispatch calls runHealth', /return await runHealth\(\{/.test(main));
	expect(
		'HV-5d url/host/port are value-taking flags',
		/VALUE_FLAGS = new Set\(\[[^\]]*'url'[^\]]*'port'[^\]]*'host'[^\]]*\]\)/.test(main)
	);
	// health must dispatch BEFORE config/DB load (so it can't EACCES). We
	// assert the health dispatch appears before the "Now load config" marker.
	const healthIdx = main.indexOf("args.subcommand === 'health'");
	const loadIdx = main.indexOf('Now load config');
	expect(
		'HV-5e health dispatches in the pre-config/DB group',
		healthIdx !== -1 && loadIdx !== -1 && healthIdx < loadIdx,
		`healthIdx=${healthIdx} loadIdx=${loadIdx}`
	);
	// help text advertises the command + the endpoint.
	expect('HV-5f help text documents `health` and /v1/health', /health \[--url=URL\]/.test(main) || /\/v1\/health/.test(main));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 health-view smoke FAILED');
	process.exit(1);
}
console.log('\u2713 morphit-ops health resolves its URL, classifies sync state, and exits 0/1/2 correctly');
console.log(`\u2713 all ${pass} health-view scenarios passed`);
