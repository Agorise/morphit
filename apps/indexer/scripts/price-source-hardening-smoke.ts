#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/price-source-hardening-smoke.ts
 *
 * Combined structural smokes for the three cp127 hardening modules:
 *
 *   - Price-receipt endpoint shape (defense G)
 *   - Drift monitor (defense B)
 *   - Disagreement monitor (defense C)
 *
 * Each subsection pins the contract so silent drift in any of these
 * modules trips a smoke.
 */

import {
	NOT_AN_ORACLE_WARNING
} from '../src/api/priceReceipt';
import {
	DRIFT_HALF_LIFE_HOURS,
	DRIFT_ALERT_THRESHOLD,
	DRIFT_ALERT_SUSTAINED_HOURS
} from '../src/indexer/price/driftMonitor';
import {
	DisagreementMonitor,
	DISAGREEMENT_THRESHOLD,
	DISAGREEMENT_ALERT_SUSTAINED_HOURS,
	startDisagreementMonitor,
	runDisagreementCheckCycle
} from '../src/indexer/price/disagreementMonitor';
import { CompositeCachedPriceSource } from '../src/indexer/price/compositeSource';
import type { BlurtPriceSource } from '../src/indexer/price/source';
import type { Database } from '../src/db/pool';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── price-source-hardening invariants smoke (cp127) ───\n');

// ── Receipt endpoint ─────────────────────────────────────────────

// PR-1 NOT-AN-ORACLE warning text completeness
{
	const required = [
		'NOT-AN-ORACLE',
		'oracle',
		'lending',
		'against',
		'ADR-0039'
	];
	const missing = required.filter((w) => !NOT_AN_ORACLE_WARNING.toLowerCase().includes(w.toLowerCase()));
	if (missing.length === 0) {
		pass('PR-1 NOT-AN-ORACLE warning text names oracle abuse + lending protocols + ADR-0039');
	} else {
		fail('PR-1', `missing keywords: ${missing.join(', ')}`);
	}
}

// PR-2 warning string is long enough to be visibly serious (not "ok, ok, NOT_AN_ORACLE")
{
	if (NOT_AN_ORACLE_WARNING.length >= 200) {
		pass(`PR-2 NOT-AN-ORACLE warning is ${NOT_AN_ORACLE_WARNING.length} chars — long enough to be visibly serious`);
	} else {
		fail('PR-2', `warning too short: ${NOT_AN_ORACLE_WARNING.length} chars`);
	}
}

// PR-3 listing-fee body includes the price_warning field when USD echo is present
{
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'api', 'listingFeeBody.ts'),
		'utf-8'
	);
	if (src.includes('price_warning') && src.includes('NOT-AN-ORACLE')) {
		pass('PR-3 listing-fee body includes NOT-AN-ORACLE price_warning field (defense H)');
	} else {
		fail('PR-3', 'listing-fee body missing price_warning field or NOT-AN-ORACLE text');
	}
}

// ── Drift monitor ────────────────────────────────────────────────

// DR-1 sane defaults
{
	const sane =
		DRIFT_HALF_LIFE_HOURS >= 1 &&
		DRIFT_HALF_LIFE_HOURS <= 168 &&
		DRIFT_ALERT_THRESHOLD > 0 &&
		DRIFT_ALERT_THRESHOLD < 1 &&
		DRIFT_ALERT_SUSTAINED_HOURS >= 1;
	if (sane) {
		pass(
			`DR-1 drift defaults sane: half-life=${DRIFT_HALF_LIFE_HOURS}h, alert=${DRIFT_ALERT_THRESHOLD * 100}%, sustained=${DRIFT_ALERT_SUSTAINED_HOURS}h`
		);
	} else {
		fail('DR-1', 'drift defaults outside sane range');
	}
}

// DR-2 schema migration present
{
	const schemaSrc = readFileSync(
		resolve(__dirname, '..', 'src', 'db', 'schema.sql'),
		'utf-8'
	);
	if (
		schemaSrc.includes('CREATE TABLE IF NOT EXISTS price_drift_baseline') &&
		schemaSrc.includes('baseline_price') &&
		schemaSrc.includes('above_threshold_since')
	) {
		pass('DR-2 price_drift_baseline table migration present in canonical schema');
	} else {
		fail('DR-2', 'schema migration for price_drift_baseline missing or incomplete');
	}
}

// ── Disagreement monitor ─────────────────────────────────────────

// DM-1 sane defaults
{
	const sane =
		DISAGREEMENT_THRESHOLD > 0 &&
		DISAGREEMENT_THRESHOLD < 1 &&
		DISAGREEMENT_ALERT_SUSTAINED_HOURS >= 1;
	if (sane)
		pass(
			`DM-1 disagreement defaults sane: threshold=${DISAGREEMENT_THRESHOLD * 100}%, sustained=${DISAGREEMENT_ALERT_SUSTAINED_HOURS}h`
		);
	else fail('DM-1', 'disagreement defaults outside sane range');
}

// DM-2 monitor behavior: matching prices → inactive
{
	const m = new DisagreementMonitor('BLURT', 'USD');
	const r = m.check({
		externalPrice: 0.002,
		externalSourceName: 'klingex',
		nativePrice: 0.00205, // 2.5% — under threshold
		now: new Date()
	});
	if (r.active === false && r.alert_fired === false) {
		pass('DM-2 matching prices (small deviation) → monitor inactive');
	} else {
		fail('DM-2', `expected inactive, got: ${JSON.stringify(r)}`);
	}
}

// DM-3 monitor behavior: divergent prices → active
{
	const m = new DisagreementMonitor('BLURT', 'USD');
	const r = m.check({
		externalPrice: 0.002,
		externalSourceName: 'klingex',
		nativePrice: 0.003, // 50% — over threshold
		now: new Date()
	});
	if (r.active === true && r.deviation !== null && Math.abs(r.deviation) > 0.25) {
		pass('DM-3 divergent prices (50% deviation) → monitor active');
	} else {
		fail('DM-3', `expected active, got: ${JSON.stringify(r)}`);
	}
}

// DM-4 monitor behavior: alert requires sustained divergence
{
	const m = new DisagreementMonitor('BLURT', 'USD', 0.25, 4);
	const t0 = new Date('2026-05-23T00:00:00Z');
	const t1 = new Date('2026-05-23T01:00:00Z'); // 1h later, under sustained
	const t5 = new Date('2026-05-23T05:00:00Z'); // 5h later, over sustained

	const r1 = m.check({
		externalPrice: 0.002,
		externalSourceName: 'klingex',
		nativePrice: 0.003,
		now: t0
	});
	const r2 = m.check({
		externalPrice: 0.002,
		externalSourceName: 'klingex',
		nativePrice: 0.003,
		now: t1
	});
	const r3 = m.check({
		externalPrice: 0.002,
		externalSourceName: 'klingex',
		nativePrice: 0.003,
		now: t5
	});
	if (
		r1.alert_fired === false &&
		r2.alert_fired === false &&
		r3.alert_fired === true
	) {
		pass('DM-4 alert fires only after sustained divergence (≥ sustainedHours)');
	} else {
		fail('DM-4', `alert sequence wrong: ${r1.alert_fired},${r2.alert_fired},${r3.alert_fired}`);
	}
}

// DM-5 alert rate-limited to once per 24h
{
	const m = new DisagreementMonitor('BLURT', 'USD', 0.25, 4);
	const t0 = new Date('2026-05-23T00:00:00Z');
	const t5 = new Date('2026-05-23T05:00:00Z'); // 5h after start, alert fires
	const t10 = new Date('2026-05-23T10:00:00Z'); // 5h after that, should NOT re-alert
	const t30 = new Date('2026-05-24T06:00:00Z'); // 30h after start, can re-alert

	m.check({
		externalPrice: 0.002,
		externalSourceName: 'klingex',
		nativePrice: 0.003,
		now: t0
	});
	const r1 = m.check({
		externalPrice: 0.002,
		externalSourceName: 'klingex',
		nativePrice: 0.003,
		now: t5
	});
	const r2 = m.check({
		externalPrice: 0.002,
		externalSourceName: 'klingex',
		nativePrice: 0.003,
		now: t10
	});
	const r3 = m.check({
		externalPrice: 0.002,
		externalSourceName: 'klingex',
		nativePrice: 0.003,
		now: t30
	});
	if (
		r1.alert_fired === true &&
		r2.alert_fired === false &&
		r3.alert_fired === true
	) {
		pass('DM-5 alert rate-limited to once per 24h per (asset, fiat)');
	} else {
		fail(
			'DM-5',
			`alert sequence wrong: ${r1.alert_fired},${r2.alert_fired},${r3.alert_fired}`
		);
	}
}

// DM-6 null inputs → inactive (no panic on missing data)
{
	const m = new DisagreementMonitor('BLURT', 'USD');
	const r = m.check({
		externalPrice: null,
		externalSourceName: null,
		nativePrice: 0.002,
		now: new Date()
	});
	if (r.active === false && r.deviation === null) {
		pass('DM-6 null external price → inactive (no false alarm)');
	} else {
		fail('DM-6', `expected inactive, got: ${JSON.stringify(r)}`);
	}
}

// ── Factory + composite wiring ───────────────────────────────────

// FW-1 factory wires morphit_native between coingecko and static floor
{
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'indexer', 'price', 'factory.ts'),
		'utf-8'
	);
	const hasNativeWire = src.includes('morphit_native') && src.includes('createMorphitNativeFetcher');
	// Accept any documenting phrase that confirms ordering: "between
	// coingecko and the static floor" OR "AFTER coingecko" + "BEFORE static floor".
	const lowered = src.toLowerCase();
	const orderingComment =
		(lowered.includes('between coingecko') && lowered.includes('static floor')) ||
		(lowered.includes('after coingecko') && lowered.includes('before static floor'));
	if (hasNativeWire && orderingComment) {
		pass('FW-1 factory wires morphit_native between coingecko and static floor (with documenting comment)');
	} else {
		fail('FW-1', `native wired: ${hasNativeWire}; ordering comment: ${orderingComment}`);
	}
}

// FW-2 config exposes the cp127 env vars
{
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'config', 'index.ts'),
		'utf-8'
	);
	const required = [
		'MORPHIT_INDEXER_PRICE_FEED_NATIVE_ENABLED',
		'MORPHIT_INDEXER_PRICE_PREFER_NATIVE_WHEN_DISAGREEING',
		'MORPHIT_INDEXER_PRICE_FEED_STABLECOIN_KEYS',
		'MORPHIT_INDEXER_PRICE_FEED_NATIVE_PLAUSIBLE_MIN',
		'MORPHIT_INDEXER_PRICE_FEED_NATIVE_PLAUSIBLE_MAX'
	];
	const missing = required.filter((k) => !src.includes(k));
	if (missing.length === 0) {
		pass('FW-2 config exposes all 5 cp127 env vars');
	} else {
		fail('FW-2', `missing env vars: ${missing.join(', ')}`);
	}
}

// FW-3 priceReceipt route mounted in main.ts
{
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'main.ts'),
		'utf-8'
	);
	if (src.includes('priceReceiptRoute') && src.includes("/v1/price")) {
		pass('FW-3 priceReceipt route mounted at /v1/price in main.ts');
	} else {
		fail('FW-3', 'priceReceipt route not properly wired in main.ts');
	}
}

// ─────────────────────────────────────────────────────────────────
// cp233 — defense B + C RUNTIME WIRING.  The contract checks above
// prove the modules behave; these prove they are actually invoked in
// the refresh path / main.ts / health, so a future refactor cannot
// silently unwire them (precisely the failure mode these exist to
// prevent).
// ─────────────────────────────────────────────────────────────────

// BW-1 — compositeSource invokes the drift check after a commit and
// exposes driftStatus().
{
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'indexer', 'price', 'compositeSource.ts'),
		'utf-8'
	);
	if (
		src.includes('updateAndCheckDrift') &&
		src.includes('driftStatus()') &&
		src.includes('this.lastDrift')
	) {
		pass('BW-1 compositeSource calls updateAndCheckDrift + exposes driftStatus()');
	} else {
		fail('BW-1', 'drift hook or driftStatus() accessor missing from compositeSource');
	}
}

// BW-2 — factory passes db + asset + denominationFiat to the source
// (without all three, the drift hook is dormant).
{
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'indexer', 'price', 'factory.ts'),
		'utf-8'
	);
	const m = src.match(/new CompositeCachedPriceSource\(\{[\s\S]*?\}\)/);
	const ctor = m ? m[0] : '';
	if (ctor.includes('db') && ctor.includes('asset:') && ctor.includes('denominationFiat:')) {
		pass('BW-2 factory passes db + asset + denominationFiat into CompositeCachedPriceSource');
	} else {
		fail('BW-2', 'factory no longer wires db/asset/denominationFiat into the source');
	}
}

// BW-3 — /v1/health surfaces the drift block.
{
	const src = readFileSync(resolve(__dirname, '..', 'src', 'api', 'health.ts'), 'utf-8');
	if (src.includes('driftStatus?.()') && src.includes('drift:')) {
		pass('BW-3 /v1/health surfaces the drift block');
	} else {
		fail('BW-3', 'health.ts no longer surfaces drift');
	}
}

// BW-RT — the drift check actually runs on a successful refresh when
// db/asset/fiat are wired, and is dormant (no db touch) when they are
// not.  Catches the hook being removed or the guard inverting.
{
	let queries = 0;
	const fakeDb = {
		query: async () => {
			queries++;
			return { rows: [] };
		}
	} as unknown as Database;
	const wired = new CompositeCachedPriceSource({
		upstreams: [{ name: 'klingex', fetch: async () => 0.005 }],
		staticFloor: 0.002,
		refreshIntervalMs: 60_000,
		setInterval: (() => 0) as unknown as typeof setInterval,
		clearInterval: (() => {}) as unknown as typeof clearInterval,
		db: fakeDb,
		asset: 'BLURT',
		denominationFiat: 'USD'
	});
	await wired.refreshOnce();
	const wiredOk = queries >= 1 && wired.driftStatus() !== null;

	let queries2 = 0;
	const fakeDb2 = {
		query: async () => {
			queries2++;
			return { rows: [] };
		}
	} as unknown as Database;
	void fakeDb2; // referenced for symmetry; unwired source gets no db
	const unwired = new CompositeCachedPriceSource({
		upstreams: [{ name: 'klingex', fetch: async () => 0.005 }],
		staticFloor: 0.002,
		refreshIntervalMs: 60_000,
		setInterval: (() => 0) as unknown as typeof setInterval,
		clearInterval: (() => {}) as unknown as typeof clearInterval
		// deliberately no db/asset/denominationFiat
	});
	await unwired.refreshOnce();
	const unwiredOk = queries2 === 0 && unwired.driftStatus() === null;

	if (wiredOk && unwiredOk) {
		pass('BW-RT drift runs on refresh when wired; dormant (no db touch) when not');
	} else {
		fail(
			'BW-RT',
			`wired(queried=${queries}, status≠null=${wired.driftStatus() !== null}); ` +
				`unwired(queried=${queries2}, status=null=${unwired.driftStatus() === null})`
		);
	}
}

// CW-1 — disagreementMonitor exports the loop machinery + the
// external-source guard constant.
{
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'indexer', 'price', 'disagreementMonitor.ts'),
		'utf-8'
	);
	if (
		src.includes('export function startDisagreementMonitor') &&
		src.includes('export async function runDisagreementCheckCycle') &&
		src.includes('EXTERNAL_MARKET_SOURCES')
	) {
		pass('CW-1 disagreementMonitor exports start + runCycle + EXTERNAL_MARKET_SOURCES');
	} else {
		fail('CW-1', 'C loop machinery missing from disagreementMonitor');
	}
}

// CW-2 — factory builds the monitor + shares one native-fetch
// construction with the composite upstream.
{
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'indexer', 'price', 'factory.ts'),
		'utf-8'
	);
	if (src.includes('export function createDisagreementMonitor') && src.includes('buildMorphitNativeFetch')) {
		pass('CW-2 factory builds the disagreement monitor + shares buildMorphitNativeFetch');
	} else {
		fail('CW-2', 'factory missing createDisagreementMonitor / buildMorphitNativeFetch');
	}
}

// CW-3 — main.ts starts C per-asset, hands monitors to /v1/health,
// and stops them on shutdown.
{
	const src = readFileSync(resolve(__dirname, '..', 'src', 'main.ts'), 'utf-8');
	const hasStart = src.includes('startDisagreementMonitor');
	const hasBuild = src.includes('createDisagreementMonitor');
	const hasRegistry = src.includes('disagreementMonitors');
	const passedToHealth = /healthRoute\([^)]*disagreementMonitors/.test(src);
	const stopsOnShutdown = src.includes('stopDisagreementMonitors');
	if (hasStart && hasBuild && hasRegistry && passedToHealth && stopsOnShutdown) {
		pass('CW-3 main.ts starts C per-asset, passes monitors to /v1/health, stops on shutdown');
	} else {
		fail(
			'CW-3',
			`start=${hasStart} build=${hasBuild} registry=${hasRegistry} health=${passedToHealth} stop=${stopsOnShutdown}`
		);
	}
}

// CW-4 — /v1/health surfaces the disagreement block.
{
	const src = readFileSync(resolve(__dirname, '..', 'src', 'api', 'health.ts'), 'utf-8');
	if (src.includes('disagreementMonitors') && src.includes('disagreement:') && src.includes('lastCheck()')) {
		pass('CW-4 /v1/health surfaces the disagreement block');
	} else {
		fail('CW-4', 'health.ts no longer surfaces disagreement');
	}
}

// Minimal BlurtPriceSource fake for the C cycle runtime tests — only
// currentDetailed() is consulted by runDisagreementCheckCycle.
const fakeSource = (source: string, price: number): BlurtPriceSource => ({
	current: () => price,
	currentDetailed: () => ({ price, source, updated_at: new Date(), stale: false }),
	start: () => {},
	stop: () => {}
});

// CW-RT-1 — cycle reads the external (coingecko) published price and
// the freshly-derived native price; divergence → active.
{
	const monitor = new DisagreementMonitor('BLURT', 'USD');
	const r = await runDisagreementCheckCycle({
		monitor,
		nativeFetch: async () => 0.01,
		priceSource: fakeSource('coingecko', 0.005)
	});
	if (r.active && r.external_source === 'coingecko' && r.external_price === 0.005 && r.native_price === 0.01) {
		pass('CW-RT-1 cycle uses external (coingecko) + native → active on divergence');
	} else {
		fail('CW-RT-1', `expected active w/ coingecko external, got ${JSON.stringify(r)}`);
	}
}

// CW-RT-2 — THE false-alarm guard.  When the composite is serving the
// static floor or the native fallback, there is no external market
// reference, so the cycle must stay inactive even though native vs
// floor is a huge gap.  This is the property EXTERNAL_MARKET_SOURCES
// exists to protect.
{
	const rFloor = await runDisagreementCheckCycle({
		monitor: new DisagreementMonitor('BLURT', 'USD'),
		nativeFetch: async () => 0.01,
		priceSource: fakeSource('static_floor', 0.002)
	});
	const rNative = await runDisagreementCheckCycle({
		monitor: new DisagreementMonitor('BLURT', 'USD'),
		nativeFetch: async () => 0.01,
		priceSource: fakeSource('morphit_native', 0.01)
	});
	if (!rFloor.active && rFloor.external_price === null && !rNative.active && rNative.external_price === null) {
		pass('CW-RT-2 floor/native published source → no external ref → inactive (false-alarm guard)');
	} else {
		fail(
			'CW-RT-2',
			`expected inactive; floor=${JSON.stringify(rFloor)} native=${JSON.stringify(rNative)}`
		);
	}
}

// CW-RT-3 — startDisagreementMonitor schedules at the given interval
// and the returned stop fn clears that handle.
{
	let cleared: unknown = null;
	let intervalArg = -1;
	const stop = startDisagreementMonitor(
		{
			monitor: new DisagreementMonitor('BLURT', 'USD'),
			nativeFetch: async () => null,
			priceSource: fakeSource('coingecko', 0.005),
			setInterval: ((_fn: () => void, ms: number) => {
				intervalArg = ms;
				return 12345 as unknown as ReturnType<typeof setInterval>;
			}) as unknown as typeof setInterval,
			clearInterval: ((h: unknown) => {
				cleared = h;
			}) as unknown as typeof clearInterval
		},
		300_000
	);
	stop();
	if (typeof stop === 'function' && intervalArg === 300_000 && cleared === 12345) {
		pass('CW-RT-3 startDisagreementMonitor schedules at interval + stop() clears the handle');
	} else {
		fail('CW-RT-3', `interval=${intervalArg}, cleared=${String(cleared)}`);
	}
}

// FS-1 — peer monitor (defense F) exposes its latest cycle result via
// the startPeerPriceMonitor callback, so /v1/health can read it.
{
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'indexer', 'price', 'peerPriceMonitor.ts'),
		'utf-8'
	);
	if (src.includes('onResult') && /startPeerPriceMonitor\([\s\S]*?onResult/.test(src)) {
		pass('FS-1 startPeerPriceMonitor exposes its latest cycle via onResult callback');
	} else {
		fail('FS-1', 'peer monitor no longer exposes its cycle result');
	}
}

// FS-2 — main.ts captures peer results + passes them to /v1/health.
{
	const src = readFileSync(resolve(__dirname, '..', 'src', 'main.ts'), 'utf-8');
	const captures = src.includes('peerMonitorResults') && src.includes('peerMonitorResults.set');
	const passedToHealth = /healthRoute\([^)]*peerMonitorResults/.test(src);
	if (captures && passedToHealth) {
		pass('FS-2 main.ts captures peer results + passes them to /v1/health');
	} else {
		fail('FS-2', `captures=${captures} health=${passedToHealth}`);
	}
}

// FS-3 — /v1/health surfaces the peer block; B + C + F all visible.
{
	const src = readFileSync(resolve(__dirname, '..', 'src', 'api', 'health.ts'), 'utf-8');
	if (src.includes('peerMonitorResults') && src.includes('peer:') && src.includes('peer_median')) {
		pass('FS-3 /v1/health surfaces the peer block (drift + disagreement + peer all visible)');
	} else {
		fail('FS-3', 'health.ts no longer surfaces the peer block');
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nprice-source-hardening-smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} price-source-hardening scenarios passed`);
