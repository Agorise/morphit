/**
 * Clearing-price history smoke.
 *
 * Validates the pure helpers that shape the
 * /v1/orderbook/featured/clearing-price-history endpoint
 * response and parse its `?window=` query param.  The SQL
 * itself isn't exercised here (no Postgres in the smoke
 * harness); an integration test would cover that.  This
 * smoke catches regressions in:
 *
 *   - Query-param validation (allowlist, default fallback)
 *   - Wire-format shaping (NUMERIC → number, NULL → 0,
 *     date → YYYY-MM-DD ISO portion, max_slots constant)
 *   - Edge cases: empty window, dense window, under-filled
 *     days, decimal blurt_per_hour, single-day series
 *
 * Usage:
 *   tsx apps/indexer/scripts/clearing-price-history-smoke.ts
 */

import {
	parseWindowParam,
	shapeClearingResponse,
	type ClearingPriceResponse
} from '../src/api/clearingPriceHistory.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function expect(actual: unknown, expected: unknown, label = ''): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label ? label + ': ' : ''}expected ${e}, got ${a}`);
	}
}

console.log('clearing-price-history smoke:\n');

// ─── parseWindowParam ─────────────────────────────────────

scenario('missing window → 30 (default)', () => {
	expect(parseWindowParam(null), 30);
	expect(parseWindowParam(undefined), 30);
});

scenario("'7' → 7 (allowed)", () => {
	expect(parseWindowParam('7'), 7);
});

scenario("'30' → 30 (allowed)", () => {
	expect(parseWindowParam('30'), 30);
});

scenario("'90' → 90 (allowed)", () => {
	expect(parseWindowParam('90'), 90);
});

scenario("'14' (not in allowlist) → 30 (default)", () => {
	expect(parseWindowParam('14'), 30);
});

scenario("'365' (above max) → 30 (default, query-bounding)", () => {
	expect(parseWindowParam('365'), 30);
});

scenario("'-7' → 30 (defaults — negative not allowed)", () => {
	expect(parseWindowParam('-7'), 30);
});

scenario("'abc' (non-numeric) → 30 (default)", () => {
	expect(parseWindowParam('abc'), 30);
});

scenario("empty string '' → 30 (default)", () => {
	expect(parseWindowParam(''), 30);
});

scenario("'0' → 30 (default — 0-day windows are silly)", () => {
	expect(parseWindowParam('0'), 30);
});

scenario("'7.5' (parseInt drops decimals → 7) → 7", () => {
	// parseInt('7.5', 10) === 7; this is a quirk of parseInt
	// that we accept rather than guard against.  Document it.
	expect(parseWindowParam('7.5'), 7);
});

// ─── shapeClearingResponse: empty + single-row ────────────

scenario('empty rows → empty points array', () => {
	const r = shapeClearingResponse([], 30);
	expect(r.points, []);
	expect(r.window_days, 30);
	expect(r.max_slots, 3);
});

scenario('single day with full slots → clearing price exposed', () => {
	const r = shapeClearingResponse(
		[
			{
				day: new Date('2026-05-01T00:00:00Z'),
				clearing_blurt_per_hour: '12.500',
				active_visible_count: 3
			}
		],
		7
	);
	expect(r.points.length, 1);
	expect(r.points[0]!.day, '2026-05-01');
	expect(r.points[0]!.clearing_blurt_per_hour, 12.5);
	expect(r.points[0]!.active_visible_count, 3);
	expect(r.points[0]!.max_slots, 3);
	expect(r.window_days, 7);
	expect(r.max_slots, 3);
});

// ─── shapeClearingResponse: under-filled days ─────────────

scenario('under-filled day (NULL clearing) → 0 in wire shape', () => {
	const r = shapeClearingResponse(
		[
			{
				day: new Date('2026-05-01T00:00:00Z'),
				clearing_blurt_per_hour: null,
				active_visible_count: 2 // only 2 of 3 slots filled
			}
		],
		7
	);
	expect(r.points[0]!.clearing_blurt_per_hour, 0);
	expect(r.points[0]!.active_visible_count, 2);
});

scenario('completely empty day (no bids) → 0 / 0', () => {
	const r = shapeClearingResponse(
		[
			{
				day: new Date('2026-05-01T00:00:00Z'),
				clearing_blurt_per_hour: null,
				active_visible_count: 0
			}
		],
		7
	);
	expect(r.points[0]!.clearing_blurt_per_hour, 0);
	expect(r.points[0]!.active_visible_count, 0);
});

// ─── Numeric edge cases ───────────────────────────────────

scenario('NUMERIC string with high precision → preserved as number', () => {
	const r = shapeClearingResponse(
		[
			{
				day: new Date('2026-05-01T00:00:00Z'),
				clearing_blurt_per_hour: '0.123456',
				active_visible_count: 3
			}
		],
		7
	);
	expect(r.points[0]!.clearing_blurt_per_hour, 0.123456);
});

scenario('whole-number NUMERIC string → integer-typed number', () => {
	const r = shapeClearingResponse(
		[
			{
				day: new Date('2026-05-01T00:00:00Z'),
				clearing_blurt_per_hour: '100',
				active_visible_count: 3
			}
		],
		7
	);
	expect(r.points[0]!.clearing_blurt_per_hour, 100);
});

// ─── Multi-day series (window-traversal shape) ────────────

scenario('7-day series with mixed under/full days', () => {
	const rows = [
		{
			day: new Date('2026-04-25T00:00:00Z'),
			clearing_blurt_per_hour: '5.000',
			active_visible_count: 3
		},
		{
			day: new Date('2026-04-26T00:00:00Z'),
			clearing_blurt_per_hour: '5.000',
			active_visible_count: 3
		},
		{
			day: new Date('2026-04-27T00:00:00Z'),
			clearing_blurt_per_hour: null,
			active_visible_count: 3
		},
		{
			day: new Date('2026-04-28T00:00:00Z'),
			clearing_blurt_per_hour: null,
			active_visible_count: 0
		},
		{
			day: new Date('2026-04-29T00:00:00Z'),
			clearing_blurt_per_hour: '8.000',
			active_visible_count: 3
		},
		{
			day: new Date('2026-04-30T00:00:00Z'),
			clearing_blurt_per_hour: '12.500',
			active_visible_count: 3
		},
		{
			day: new Date('2026-05-01T00:00:00Z'),
			clearing_blurt_per_hour: '15.000',
			active_visible_count: 3
		}
	];
	const r = shapeClearingResponse(rows, 7);
	expect(r.points.length, 7);
	expect(
		r.points.map((p) => p.clearing_blurt_per_hour),
		[5, 5, 0, 0, 8, 12.5, 15]
	);
	expect(
		r.points.map((p) => p.day),
		[
			'2026-04-25',
			'2026-04-26',
			'2026-04-27',
			'2026-04-28',
			'2026-04-29',
			'2026-04-30',
			'2026-05-01'
		]
	);
});

// ─── Defensive shaping ────────────────────────────────────

scenario('day with timestamp not at midnight UTC still produces YYYY-MM-DD', () => {
	// Postgres ::date casts strip time, but defensive: even if
	// the row arrives with a non-midnight timestamp, the slice
	// pulls the date portion.
	const r = shapeClearingResponse(
		[
			{
				day: new Date('2026-05-01T15:30:45Z'),
				clearing_blurt_per_hour: '1.000',
				active_visible_count: 3
			}
		],
		7
	);
	expect(r.points[0]!.day, '2026-05-01');
});

// ─── Window value pass-through ────────────────────────────

scenario('window_days reflects what was passed in', () => {
	const r1 = shapeClearingResponse([], 7);
	const r2 = shapeClearingResponse([], 30);
	const r3 = shapeClearingResponse([], 90);
	expect(r1.window_days, 7);
	expect(r2.window_days, 30);
	expect(r3.window_days, 90);
});

// ─── max_slots invariant ──────────────────────────────────

scenario('max_slots is constant 3 in both wire shape and per-point', () => {
	const r = shapeClearingResponse(
		[
			{
				day: new Date('2026-05-01T00:00:00Z'),
				clearing_blurt_per_hour: '1.000',
				active_visible_count: 3
			}
		],
		7
	);
	expect(r.max_slots, 3);
	expect(r.points[0]!.max_slots, 3);
});

// ─── Type-narrowing sanity ────────────────────────────────

scenario('shape is well-typed and JSON-serializable', () => {
	const r: ClearingPriceResponse = shapeClearingResponse(
		[
			{
				day: new Date('2026-05-01T00:00:00Z'),
				clearing_blurt_per_hour: '12.500',
				active_visible_count: 3
			}
		],
		7
	);
	const json = JSON.stringify(r);
	const parsed = JSON.parse(json);
	expect(parsed.points[0].day, '2026-05-01');
	expect(parsed.points[0].clearing_blurt_per_hour, 12.5);
	expect(parsed.window_days, 7);
});

console.log(
	`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} scenarios passed`
);
process.exit(failures === 0 ? 0 : 1);
