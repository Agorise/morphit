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
	resolveRelayHealthUrl,
	summarizeHealth,
	parsePriceFeed,
	parsePriceFeedsHealth,
	parseFastPath,
	FASTPATH_HEALTHY_LAG_BLOCKS,
	classifyHealthResult,
	bridgeGatewayHosts,
	candidateHealthUrls,
	hasExplicitTarget,
	checkCanary,
	bytesToGB,
	clampPct,
	cpuTimesTotals,
	cpuBusyPct,
	parseMeminfo,
	readSystemResources,
	DEFAULT_INDEXER_HOST,
	DEFAULT_INDEXER_PORT,
	DEFAULT_RELAY_PORT
} from '../src/commands/health.ts';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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
		version: '1.0.0-beta.24',
		indexed_block: 1000,
		chain_head_block: 1002,
		lag_blocks: 2,
		uptime_sec: 3661,
		rpc_endpoints_healthy: 3,
		rpc_endpoints_total: 4,
		web_push: true,
		blurt_balance: '9000.000 BLURT',
		price_feed: {
			enabled: true,
			blurt_fiat: 0.0013,
			denomination_fiat: 'USD',
			source: 'coingecko',
			stale: false
		}
	});
	expect(
		'HV-3a full healthy body parsed',
		full.synced &&
			full.status === 'ok' &&
			full.version === '1.0.0-beta.24' &&
			full.indexedBlock === 1000 &&
			full.chainHeadBlock === 1002 &&
			full.lagBlocks === 2 &&
			full.uptimeSec === 3661 &&
			full.rpcHealthy === 3 &&
			full.rpcTotal === 4 &&
			full.webPush === true &&
			full.relayBalance === '9000.000 BLURT' &&
			full.priceFeed !== null &&
			full.priceFeed.enabled &&
			full.priceFeed.blurtFiat === 0.0013 &&
			full.priceFeed.source === 'coingecko' &&
			!full.priceFeed.stale &&
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
			missing.webPush === null &&
			missing.relayBalance === null &&
			missing.priceFeed === null &&
			!missing.rpcAllDown &&
			missing.synced,
		JSON.stringify(missing)
	);
	const lowBal = summarizeHealth({ blurt_balance: '5.000 BLURT' });
	expect(
		'HV-3h relay balance parsed from health body',
		lowBal.relayBalance === '5.000 BLURT'
	);
	expect(
		'HV-3g non-object body tolerated',
		summarizeHealth(null).status === 'unknown' && summarizeHealth(42).synced
	);
	// cp365 — parsePriceFeed: tolerant of every shape the indexer (or an
	// older build) might send for the non-verbose `price_feed`.
	const pfOn = parsePriceFeed({
		enabled: true,
		blurt_fiat: 0.0013,
		denomination_fiat: 'USD',
		source: 'coingecko',
		stale: false
	});
	expect(
		'HV-3i parsePriceFeed: live feed parsed',
		pfOn !== null &&
			pfOn.enabled &&
			pfOn.blurtFiat === 0.0013 &&
			pfOn.denomination === 'USD' &&
			pfOn.source === 'coingecko' &&
			!pfOn.stale,
		JSON.stringify(pfOn)
	);
	const pfOff = parsePriceFeed({ enabled: false });
	expect(
		'HV-3j parsePriceFeed: disabled feed → enabled:false, no price',
		pfOff !== null && !pfOff.enabled && pfOff.blurtFiat === null && pfOff.stale === false
	);
	const pfStale = parsePriceFeed({ enabled: true, blurt_fiat: 0.0015, source: 'static_floor', stale: true });
	expect(
		'HV-3k parsePriceFeed: stale upstream flagged',
		pfStale !== null && pfStale.enabled && pfStale.stale && pfStale.source === 'static_floor'
	);
	expect(
		'HV-3l parsePriceFeed: absent/non-object → null (pre-field indexer, relay health)',
		parsePriceFeed(undefined) === null &&
			parsePriceFeed(null) === null &&
			parsePriceFeed(42) === null &&
			parsePriceFeed({ enabled: 'yes' }) === null
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
		'HV-4g all RPC down → unknown sync state, exit 1, message notes RPC unreachable',
		behindRpc.kind === 'unknown' &&
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

// ─── HV-6: bridge-gateway auto-probe (the #13 fix) ──────────────────
{
	// bridgeGatewayHosts: non-internal IPv4 only (the docker bridge
	// gateway), skipping loopback + IPv6 + internal interfaces.
	const fakeIfaces = {
		lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
		eth0: [{ address: '203.0.113.7', family: 'IPv4', internal: false }],
		docker0: [
			{ address: '172.18.0.1', family: 'IPv4', internal: false },
			{ address: 'fe80::1', family: 'IPv6', internal: false }
		]
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const hosts = bridgeGatewayHosts(fakeIfaces as any);
	expect(
		'HV-6a bridgeGatewayHosts: non-internal IPv4 only (incl. docker bridge)',
		hosts.includes('172.18.0.1') &&
			hosts.includes('203.0.113.7') &&
			!hosts.includes('127.0.0.1') &&
			!hosts.includes('fe80::1')
	);

	// candidateHealthUrls: primary first, then gateways at the port; deduped.
	const urls = candidateHealthUrls(
		'http://127.0.0.1:8081/v1/health',
		false,
		'8081',
		['172.18.0.1', '127.0.0.1']
	);
	expect(
		'HV-6b candidateHealthUrls: primary first, bridge gateways appended, deduped',
		urls[0] === 'http://127.0.0.1:8081/v1/health' &&
			urls.includes('http://172.18.0.1:8081/v1/health') &&
			urls.length === 2
	);

	// explicit target → no fallbacks (respect the operator's --url/--host).
	const explicitUrls = candidateHealthUrls(
		'http://10.0.0.5:8081/v1/health',
		true,
		'8081',
		['172.18.0.1']
	);
	expect(
		'HV-6c candidateHealthUrls: explicit target skips auto-probe',
		explicitUrls.length === 1 && explicitUrls[0] === 'http://10.0.0.5:8081/v1/health'
	);

	expect('HV-6d hasExplicitTarget: --url set → true', hasExplicitTarget({ url: 'http://x:8081' }, {}) === true);
	expect(
		'HV-6e hasExplicitTarget: MORPHIT_INDEXER_LISTEN_HOST set → true',
		hasExplicitTarget({}, { MORPHIT_INDEXER_LISTEN_HOST: '172.18.0.1' }) === true
	);
	expect('HV-6f hasExplicitTarget: nothing set → false', hasExplicitTarget({}, {}) === false);
}

// ─── HV-7: relay URL resolution ─────────────────────────────────────
{
	expect(
		'HV-7a resolveRelayHealthUrl: defaults to loopback:8080',
		resolveRelayHealthUrl({}) === `http://${DEFAULT_INDEXER_HOST}:${DEFAULT_RELAY_PORT}/v1/health`
	);
	expect(
		'HV-7b resolveRelayHealthUrl: honors MORPHIT_RELAY_LISTEN_HOST/_PORT',
		resolveRelayHealthUrl({ MORPHIT_RELAY_LISTEN_HOST: '172.18.0.1', MORPHIT_RELAY_LISTEN_PORT: '9090' }) ===
			'http://172.18.0.1:9090/v1/health'
	);
}

// ─── HV-8: canary freshness ─────────────────────────────────────────
{
	const dir = mkdtempSync(join(tmpdir(), 'canary-smoke-'));
	const now = new Date('2026-06-11T00:00:00Z');
	try {
		const fresh = join(dir, 'fresh.txt');
		writeFileSync(fresh, 'Generated: 2026-06-13T03:14:00Z\nValid through: 2026-06-20T03:14:00Z\n');
		const f = checkCanary(fresh, now);
		expect(
			'HV-8a checkCanary: comfortable future "Valid through" → fresh',
			f.state === 'fresh' && f.validThrough === '2026-06-20T03:14:00Z'
		);

		const stale = join(dir, 'stale.txt');
		writeFileSync(stale, 'Generated: 2026-05-25T03:14:00Z\nValid through: 2026-06-01T03:14:00Z\n');
		expect('HV-8b checkCanary: past "Valid through" → overdue', checkCanary(stale, now).state === 'overdue');

		expect('HV-8c checkCanary: missing file → missing', checkCanary(join(dir, 'nope.txt'), now).state === 'missing');

		const tmpl = join(dir, 'tmpl.txt');
		writeFileSync(tmpl, 'Generated: {{GENERATED_AT_ISO}}\nValid through: {{VALID_THROUGH_ISO}}\n');
		expect('HV-8d checkCanary: un-substituted template → unparsable', checkCanary(tmpl, now).state === 'unparsable');

		// cp442 — the generator now writes Ken's sitewide stamp
		// ("15 June, 2026 @ 03:14:00 UTC"). `new Date(str)` on a non-ISO string is
		// implementation-defined, so health parses it explicitly. If that ever
		// regresses, a perfectly good canary reports as `unparsable` and the
		// operator goes hunting for a problem that doesn't exist.
		const humanFresh = join(dir, 'human-fresh.txt');
		writeFileSync(
			humanFresh,
			'Generated: 8 June, 2026 @ 03:14:00 UTC\nValid through: 20 June, 2026 @ 03:14:00 UTC\n'
		);
		expect(
			'HV-8e checkCanary: human stamp, comfortable deadline → fresh',
			checkCanary(humanFresh, now).state === 'fresh'
		);

		const humanStale = join(dir, 'human-stale.txt');
		writeFileSync(
			humanStale,
			'Generated: 25 May, 2026 @ 03:14:00 UTC\nValid through: 1 June, 2026 @ 03:14:00 UTC\n'
		);
		expect(
			'HV-8f checkCanary: human stamp, past deadline → overdue',
			checkCanary(humanStale, now).state === 'overdue'
		);

		// A local-time-looking stamp must NOT be silently accepted (it would skew
		// the staleness window by the operator's UTC offset).
		const ambiguous = join(dir, 'ambiguous.txt');
		writeFileSync(ambiguous, 'Generated: 2026-06-08 03:14:00\nValid through: 2026-06-15 03:14:00\n');
		expect(
			'HV-8g checkCanary: ambiguous local-time stamp → unparsable, not guessed',
			checkCanary(ambiguous, now).state === 'unparsable'
		);

		const badMonth = join(dir, 'bad-month.txt');
		writeFileSync(badMonth, 'Generated: 8 June, 2026 @ 03:14:00 UTC\nValid through: 15 Junius, 2026 @ 03:14:00 UTC\n');
		expect(
			'HV-8h checkCanary: bogus month → unparsable, not treated as fresh',
			checkCanary(badMonth, now).state === 'unparsable'
		);

		// cp622 — still valid but LOW on remaining validity → stale (aging): the
		// weekly refresh has likely stalled, so warn WHILE it's still valid rather
		// than waiting for it to expire and readers to see a false tamper signal.
		const staleAging = join(dir, 'stale-aging.txt');
		writeFileSync(staleAging, 'Generated: 2026-05-31T00:00:00Z\nValid through: 2026-06-14T00:00:00Z\n');
		const sa = checkCanary(staleAging, now);
		expect(
			'HV-8i checkCanary: valid but < 5 days left → stale (aging)',
			sa.state === 'stale' && /expires in 3 days/.test(sa.detail) && /update-canary/.test(sa.detail)
		);

		const humanStaleAging = join(dir, 'human-stale-aging.txt');
		writeFileSync(
			humanStaleAging,
			'Generated: 31 May, 2026 @ 00:00:00 UTC\nValid through: 14 June, 2026 @ 00:00:00 UTC\n'
		);
		expect(
			'HV-8j checkCanary: human stamp, low validity → stale',
			checkCanary(humanStaleAging, now).state === 'stale'
		);

		// Just OUTSIDE the window (6 days left) stays fresh — the warning must not
		// over-fire during normal weekly operation.
		const barelyFresh = join(dir, 'barely-fresh.txt');
		writeFileSync(barelyFresh, 'Generated: 2026-06-10T00:00:00Z\nValid through: 2026-06-17T00:00:00Z\n');
		expect(
			'HV-8k checkCanary: 6 days left (> 5-day window) → still fresh',
			checkCanary(barelyFresh, now).state === 'fresh'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── HV-9: parsePriceFeedsHealth (cp372 multi-source feed health;
//          cp381 top-level operator-only block + per-source price) ───
{
	// cp381: the parser now takes the top-level `price_feeds` block
	// directly (it moved out of the gated `diagnostics`), and each
	// crypto source row carries the price it reported.
	const block = {
		fx: {
			enabled: true,
			source: 'frankfurter+er_api',
			stale: false,
			live_currency_count: 44,
			outlier_rejected: true,
			contributing: 2,
			sources: [
				{ name: 'frankfurter', ok: true, last_ok_age_s: 12, price: null },
				{ name: 'er_api', ok: true, last_ok_age_s: 12, price: null },
				{ name: 'currency_api', ok: false, last_ok_age_s: 600, price: null }
			]
		},
		crypto: {
			BLURT: { source: 'external_avg', stale: false, outlier_rejected: false, sources: [
				{ name: 'coingecko', ok: true, last_ok_age_s: 30, price: 0.0013047 },
				{ name: 'coinpaprika', ok: true, last_ok_age_s: 30, price: 0.00130526 }
			] },
			BTC: { source: 'external_avg', stale: false, outlier_rejected: true, sources: [
				{ name: 'coingecko', ok: true, last_ok_age_s: 30, price: 67000 },
				{ name: 'kraken', ok: false, last_ok_age_s: null, price: null }
			] },
			XMR: { source: 'morphit_native', stale: true, outlier_rejected: false, sources: [
				{ name: 'coingecko', ok: false, last_ok_age_s: 9000, price: null }
			] }
		}
	};
	const p = parsePriceFeedsHealth(block);
	expect('HV-9a price_feeds parsed', p !== null && p.fxEnabled === true);
	if (p) {
		expect('HV-9b 4 feeds in FX,BLURT,BTC,XMR order', p.feeds.length === 4 && p.feeds[0]!.label.startsWith('FX') && p.feeds[1]!.label === 'BLURT' && p.feeds[2]!.label === 'BTC' && p.feeds[3]!.label === 'XMR');
		const fx = p.feeds[0]!;
		expect('HV-9c FX up/total counted (2/3)', fx.up === 2 && fx.total === 3);
		expect('HV-9d FX outlier flag carried', fx.outlierRejected === true);
		expect('HV-9d2 FX tagged not-crypto', fx.isCrypto === false);
		const blurt = p.feeds.find((f) => f.label === 'BLURT')!;
		expect('HV-9d3 BLURT tagged crypto + per-source price carried', blurt.isCrypto === true && blurt.sources.find((s) => s.name === 'coinpaprika')!.price === 0.00130526);
		const btc = p.feeds.find((f) => f.label === 'BTC')!;
		expect('HV-9e BTC down source counted (1/2)', btc.up === 1 && btc.total === 2);
		expect('HV-9e2 BTC down source price null', btc.sources.find((s) => s.name === 'kraken')!.price === null);
		const xmr = p.feeds.find((f) => f.label === 'XMR')!;
		expect('HV-9f XMR stale + native source', xmr.stale === true && xmr.source === 'morphit_native');
	}
	expect('HV-9g absent block → null', parsePriceFeedsHealth(undefined) === null && parsePriceFeedsHealth(null) === null);
	expect('HV-9h block without fx/crypto → null', parsePriceFeedsHealth({ explorers: [] }) === null);
	// FX disabled + no crypto → null (nothing to show).
	expect('HV-9i fx disabled + empty crypto → null', parsePriceFeedsHealth({ fx: { enabled: false }, crypto: {} }) === null);
	// FX disabled but crypto present → parses crypto, fxEnabled false.
	const cryptoOnly = parsePriceFeedsHealth({ fx: { enabled: false }, crypto: { BTC: { source: 'external_avg', stale: false, outlier_rejected: false, sources: [{ name: 'coingecko', ok: true, last_ok_age_s: 5, price: 67000 }] } } });
	expect('HV-9j fx off + crypto present → crypto rendered, fxEnabled false', cryptoOnly !== null && cryptoOnly.fxEnabled === false && cryptoOnly.feeds.length === 1);
	// Malformed source rows are skipped, not crashed.
	const messy = parsePriceFeedsHealth({ fx: { enabled: false }, crypto: { BTC: { source: 'external_avg', stale: false, outlier_rejected: false, sources: [null, { ok: true }, { name: 'coingecko', ok: true, last_ok_age_s: 5, price: 67000 }] } } });
	expect('HV-9k malformed source rows skipped (only valid named one kept)', messy !== null && messy.feeds[0]!.total === 1);
}

// ── HV-10: system-resource pure helpers (CPU / memory / disk math) ──
{
	// bytesToGB — 1 GiB → 1.0, rounds to one decimal, 0 → 0.
	expect('HV-10a bytesToGB(1 GiB) === 1', bytesToGB(1024 * 1024 * 1024) === 1);
	expect('HV-10b bytesToGB rounds to 1 decimal', bytesToGB(1.55 * 1024 ** 3) === 1.6);
	expect('HV-10c bytesToGB(0) === 0', bytesToGB(0) === 0);

	// clampPct — integer 0..100, NaN-safe.
	expect('HV-10d clampPct(-5) === 0', clampPct(-5) === 0);
	expect('HV-10e clampPct(150) === 100', clampPct(150) === 100);
	expect('HV-10f clampPct(49.6) rounds to 50', clampPct(49.6) === 50);
	expect('HV-10g clampPct(NaN) === 0', clampPct(NaN) === 0);

	// cpuTimesTotals — aggregate idle + total jiffies across cores.
	const totals = cpuTimesTotals([
		{ times: { user: 10, nice: 0, sys: 5, idle: 80, irq: 5 } },
		{ times: { user: 20, nice: 0, sys: 10, idle: 60, irq: 10 } }
	]);
	expect('HV-10h cpuTimesTotals sums idle', totals.idle === 140);
	expect('HV-10i cpuTimesTotals sums total', totals.total === 200);

	// cpuBusyPct — busy fraction between two snapshots.
	expect(
		'HV-10j cpuBusyPct 50% busy',
		cpuBusyPct({ idle: 100, total: 200 }, { idle: 150, total: 300 }) === 50
	);
	expect(
		'HV-10k cpuBusyPct zero delta → null',
		cpuBusyPct({ idle: 100, total: 200 }, { idle: 100, total: 200 }) === null
	);
	expect(
		'HV-10l cpuBusyPct fully busy (no idle gain)',
		cpuBusyPct({ idle: 100, total: 200 }, { idle: 100, total: 400 }) === 100
	);

	// parseMeminfo — MemTotal/MemAvailable kB → bytes; null on missing.
	const mi = parseMeminfo('MemTotal:        4096 kB\nMemFree: 512 kB\nMemAvailable:    1024 kB\n');
	expect(
		'HV-10m parseMeminfo total/avail → bytes',
		mi !== null && mi.totalBytes === 4096 * 1024 && mi.availBytes === 1024 * 1024
	);
	expect('HV-10n parseMeminfo garbage → null', parseMeminfo('not meminfo') === null);
	expect(
		'HV-10o parseMeminfo missing MemAvailable → null',
		parseMeminfo('MemTotal: 4096 kB\nMemFree: 512 kB\n') === null
	);
}

// ── HV-11: readSystemResources shape (impure; samples THIS host) ──
{
	const sys = await readSystemResources();
	const keys = [
		'cpuPct',
		'memUsedGB',
		'memTotalGB',
		'memPct',
		'diskUsedGB',
		'diskAvailGB',
		'diskTotalGB',
		'diskPct'
	];
	const pctOk = (v: number | null) => v === null || (v >= 0 && v <= 100);
	const gbOk = (v: number | null) => v === null || v >= 0;
	expect('HV-11a readSystemResources returns all 8 keys', keys.every((k) => k in sys));
	expect('HV-11b cpuPct in 0..100 or null', pctOk(sys.cpuPct));
	expect('HV-11c memPct in 0..100 or null', pctOk(sys.memPct));
	expect('HV-11d diskPct in 0..100 or null', pctOk(sys.diskPct));
	expect('HV-11e memTotalGB ≥ 0 or null', gbOk(sys.memTotalGB));
	expect('HV-11f diskTotalGB ≥ 0 or null', gbOk(sys.diskTotalGB));
	// Memory has an os.totalmem() fallback that never throws, so on any
	// real host memTotalGB must resolve to a positive number.
	expect(
		'HV-11g memTotalGB is a positive number on this host',
		typeof sys.memTotalGB === 'number' && (sys.memTotalGB as number) > 0
	);
}

// ── HV-12: head-block fast-path status (v1.7.0, ADR-0051) ──
{
	// parseFastPath — tolerant parse of the operator-only top-level `fastpath`
	// block (camelCase keys, forwarded verbatim from the indexer's
	// HeadTailerStatus).
	//
	// v1.7.0 — the `enabled` cases here are GONE with the field. They asserted a
	// value that could only ever be true, so HV-12b ("disabled parsed") was
	// pinning a state no deployment could reach. What replaced them is the
	// property that can actually vary and that an operator actually needs:
	// whether the tailer is keeping up with the chain head.
	const on = parseFastPath({
		running: true,
		scannedHead: 59500000,
		emitted: 42,
		lastError: null,
		lastErrorAt: null
	});
	expect(
		'HV-12a fastpath running parsed',
		on !== null && on.running && on.scannedHead === 59500000 && on.emitted === 42
	);
	const starting = parseFastPath({ running: false, scannedHead: 0, emitted: 0, lastError: null });
	expect('HV-12b not-yet-tailing parsed', starting !== null && !starting.running);
	expect(
		'HV-12c absent/null block → null',
		parseFastPath(undefined) === null && parseFastPath(null) === null
	);
	const err = parseFastPath({ running: false, lastError: 'rpc getBlock 502' });
	expect(
		'HV-12d lastError surfaced, missing numeric fields → null (tolerant)',
		err !== null && err.lastError === 'rpc getBlock 502' && err.scannedHead === null && err.emitted === null
	);
	expect(
		'HV-12e non-object → null',
		parseFastPath(42) === null && parseFastPath('on') === null
	);
	// The threshold the renderer judges "keeping up" by must stay tight enough to
	// mean something: blocks are ~3s and the scanner polls every ~2s, so a
	// tailer more than a few blocks back is not delivering the ≤6s the fast path
	// exists for. A large value here would let a broken tailer read as healthy.
	expect(
		'HV-12f healthy-lag threshold is tight (<= 6 blocks ≈ 18s)',
		FASTPATH_HEALTHY_LAG_BLOCKS > 0 && FASTPATH_HEALTHY_LAG_BLOCKS <= 6
	);

	// Render source-assertion: the node-health view prints a "Fast path:" line.
	//
	// v1.7.0 — the old assertions pinned an on/off/disabled line ("messages
	// appear once irreversible"). Those states no longer exist (ADR-0051), and a
	// smoke that still demanded them would have forced the dead branch to stay.
	// What's pinned now is that the line reports LAG: a tailer that is running
	// but far behind head is broken, and the old line called that one "on".
	const healthSrc = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'health.ts'),
		'utf-8'
	);
	expect('HV-12g render has a "Fast path:" label', healthSrc.includes('Fast path:'));
	expect(
		'HV-12h render reports lag against head, not an on/off boolean',
		healthSrc.includes('behind head') && healthSrc.includes('FASTPATH_HEALTHY_LAG_BLOCKS')
	);
	expect(
		'HV-12i render still shows a delivered count + keeping-up state',
		healthSrc.includes('delivered') && healthSrc.includes('keeping up')
	);
	expect(
		'HV-12j render has the older-build fallback',
		healthSrc.includes('Fast path:     status unavailable (older indexer build)')
	);
	expect(
		'HV-12k render no longer offers a disabled state',
		!healthSrc.includes('messages appear once irreversible')
	);

	// Indexer-side: `fastpath` must be in the OPERATOR-ONLY top-level block (the
	// `localDiag` / X-Morphit-Local-Health gate the ops-cli uses) — NOT only in
	// the ?verbose=1 diagnostics block, or the node-health view (which doesn't
	// send verbose=1) would never see it.
	const idxHealthSrc = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'indexer', 'src', 'api', 'health.ts'),
		'utf-8'
	);
	const localDiagIdx = idxHealthSrc.indexOf('if (localDiag) {');
	const fastPathIdx = idxHealthSrc.indexOf('body.fastpath');
	const verboseIdx = idxHealthSrc.indexOf('if (verbose) {');
	expect('HV-12l indexer emits body.fastpath', fastPathIdx >= 0);
	expect(
		'HV-12m fastpath is inside the localDiag (operator-only) block, before the verbose block',
		localDiagIdx >= 0 && fastPathIdx > localDiagIdx && (verboseIdx < 0 || fastPathIdx < verboseIdx)
	);
}

console.log('');
if (fail > 0) {
	console.log('\u2717 health-view smoke FAILED');
	process.exit(1);
}
console.log('\u2713 morphit-ops health resolves its URL, classifies sync state, and exits 0/1/2 correctly');
console.log(`\u2713 all ${pass} health-view scenarios passed`);
