#!/usr/bin/env tsx
/**
 * Structural smoke for cp129 Defense F — cross-instance peer price
 * monitor (peerPriceMonitor.ts).
 *
 * What this verifies (without spinning up Postgres or real federation
 * peers — those are integration concerns):
 *
 *   1. Module exports the public surface area we expect.
 *   2. Sane numeric defaults (threshold, window, sustained, cooldown,
 *      min observations, retention).
 *   3. `median()` pure-function correctness: empty rejected, odd-length
 *      picks middle, even-length averages two middles, sorted/unsorted
 *      input produces same result.
 *   4. `disagreementExceedsThreshold` correctness: identity (0%), at
 *      threshold, well above, well below, edge cases (zero peer
 *      median rejected to avoid div-by-zero).
 *   5. `shouldFireAlert` correctness: not-sustained-yet, exactly-at-
 *      sustained, cooldown-active, cooldown-elapsed, never-fired.
 *   6. Doc comment manifest — verify the file's source still mentions
 *      Defense F + median-not-mean + ≥3 peers + same-denomination
 *      filter (regression prevention for the design rationale).
 */

import {
	PEER_DISAGREEMENT_THRESHOLD,
	PEER_DISAGREEMENT_WINDOW_HOURS,
	PEER_DISAGREEMENT_SUSTAINED_HOURS,
	PEER_ALERT_COOLDOWN_HOURS,
	PEER_MIN_OBSERVATIONS,
	PEER_SAMPLE_INTERVAL_MINUTES,
	PEER_OBSERVATION_RETENTION_DAYS,
	PEER_FETCH_TIMEOUT_MS,
	median,
	disagreementExceedsThreshold,
	shouldFireAlert,
	runPeerPriceSampleCycle,
	startPeerPriceMonitor,
	pruneOldObservations,
	fetchPeerReceipt,
	_resetPeerPriceMonitorState
} from '../src/indexer/price/peerPriceMonitor';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MODULE_PATH = join(__dirname, '..', 'src', 'indexer', 'price', 'peerPriceMonitor.ts');

let pass = 0;
let fail = 0;

function scenario(name: string, fn: () => void | Promise<void>): void {
	try {
		const result = fn();
		if (result instanceof Promise) {
			result
				.then(() => {
					console.log(`  ✓ ${name}`);
					pass++;
				})
				.catch((err) => {
					console.log(`  ✗ ${name}: ${err}`);
					fail++;
				});
		} else {
			console.log(`  ✓ ${name}`);
			pass++;
		}
	} catch (err) {
		console.log(`  ✗ ${name}: ${err}`);
		fail++;
	}
}

function assertEq<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
	}
}

console.log('\n── peer-price-monitor structural smoke (cp129 Defense F) ──\n');

// ─── PPM-1: public surface area ──
scenario('PPM-1: module exports all expected symbols', () => {
	const allFns = [
		median,
		disagreementExceedsThreshold,
		shouldFireAlert,
		runPeerPriceSampleCycle,
		startPeerPriceMonitor,
		pruneOldObservations,
		fetchPeerReceipt,
		_resetPeerPriceMonitorState
	];
	for (const fn of allFns) {
		if (typeof fn !== 'function') {
			throw new Error('expected function export');
		}
	}
});

// ─── PPM-2: sane numeric defaults ──
scenario('PPM-2: PEER_DISAGREEMENT_THRESHOLD is 0.25 (25%)', () => {
	assertEq(PEER_DISAGREEMENT_THRESHOLD, 0.25, 'threshold');
});

scenario('PPM-2: PEER_DISAGREEMENT_WINDOW_HOURS is 4', () => {
	assertEq(PEER_DISAGREEMENT_WINDOW_HOURS, 4, 'window hours');
});

scenario('PPM-2: PEER_DISAGREEMENT_SUSTAINED_HOURS is 4', () => {
	assertEq(PEER_DISAGREEMENT_SUSTAINED_HOURS, 4, 'sustained hours');
});

scenario('PPM-2: PEER_ALERT_COOLDOWN_HOURS is 24', () => {
	assertEq(PEER_ALERT_COOLDOWN_HOURS, 24, 'cooldown hours');
});

scenario('PPM-2: PEER_MIN_OBSERVATIONS is 3 (sybil resistance floor)', () => {
	assertEq(PEER_MIN_OBSERVATIONS, 3, 'min observations');
});

scenario('PPM-2: PEER_SAMPLE_INTERVAL_MINUTES is 30', () => {
	assertEq(PEER_SAMPLE_INTERVAL_MINUTES, 30, 'sample interval');
});

scenario('PPM-2: PEER_OBSERVATION_RETENTION_DAYS is 7', () => {
	assertEq(PEER_OBSERVATION_RETENTION_DAYS, 7, 'retention days');
});

scenario('PPM-2: PEER_FETCH_TIMEOUT_MS is positive and ≤30s', () => {
	if (!(PEER_FETCH_TIMEOUT_MS > 0 && PEER_FETCH_TIMEOUT_MS <= 30_000)) {
		throw new Error(`bad timeout: ${PEER_FETCH_TIMEOUT_MS}`);
	}
});

// ─── PPM-3: median() correctness ──
scenario('PPM-3: median rejects empty array', () => {
	try {
		median([]);
		throw new Error('expected throw on empty');
	} catch (err) {
		if (!(err instanceof Error) || !err.message.includes('empty')) throw err;
	}
});

scenario('PPM-3: median of [1] is 1', () => {
	assertEq(median([1]), 1, 'single');
});

scenario('PPM-3: median of [1,2,3] is 2', () => {
	assertEq(median([1, 2, 3]), 2, 'odd middle');
});

scenario('PPM-3: median of [1,2,3,4] is 2.5 (even-length average)', () => {
	assertEq(median([1, 2, 3, 4]), 2.5, 'even mid avg');
});

scenario('PPM-3: median is sort-invariant', () => {
	const a = median([5, 1, 3, 2, 4]);
	const b = median([1, 2, 3, 4, 5]);
	assertEq(a, b, 'sort invariance');
});

scenario('PPM-3: median resists single outlier (sybil-resistance property)', () => {
	// A malicious peer feeding 10x the real price.  Median should
	// still pick the middle of 5 → 3, not be moved by the outlier.
	const result = median([1, 2, 3, 4, 1000]);
	assertEq(result, 3, 'outlier-resistant median');
});

// ─── PPM-4: disagreementExceedsThreshold() correctness ──
scenario('PPM-4: identity (price == peer) → false', () => {
	assertEq(disagreementExceedsThreshold(0.002, 0.002, 0.25), false, 'identity');
});

scenario('PPM-4: 10% deviation, 25% threshold → false', () => {
	// my=0.0022, peer=0.002 → 10% deviation, under 25%
	assertEq(disagreementExceedsThreshold(0.0022, 0.002, 0.25), false, '10pct under 25pct');
});

scenario('PPM-4: 30% deviation, 25% threshold → true', () => {
	// my=0.0026, peer=0.002 → 30% deviation, over 25%
	assertEq(disagreementExceedsThreshold(0.0026, 0.002, 0.25), true, '30pct over 25pct');
});

scenario('PPM-4: detects deviation in BOTH directions (my > peer)', () => {
	assertEq(disagreementExceedsThreshold(0.003, 0.002, 0.25), true, 'my-above');
});

scenario('PPM-4: detects deviation in BOTH directions (my < peer)', () => {
	assertEq(disagreementExceedsThreshold(0.001, 0.002, 0.25), true, 'my-below');
});

scenario('PPM-4: zero peer median rejected (no div-by-zero, returns false)', () => {
	assertEq(disagreementExceedsThreshold(0.005, 0, 0.25), false, 'zero peer');
});

scenario('PPM-4: negative peer median rejected', () => {
	assertEq(disagreementExceedsThreshold(0.005, -0.001, 0.25), false, 'negative peer');
});

// ─── PPM-5: shouldFireAlert() correctness ──
scenario('PPM-5: never-disagreed (aboveThresholdSince=null) → false', () => {
	const now = new Date('2026-05-23T12:00:00Z');
	assertEq(shouldFireAlert(null, now, null, 4, 24), false, 'never disagreed');
});

scenario('PPM-5: just-disagreed-now (not-yet-sustained) → false', () => {
	const now = new Date('2026-05-23T12:00:00Z');
	const aboveThresholdSince = new Date('2026-05-23T11:55:00Z'); // 5 min ago
	assertEq(shouldFireAlert(aboveThresholdSince, now, null, 4, 24), false, 'too fresh');
});

scenario('PPM-5: exactly sustained-hours elapsed → true', () => {
	const now = new Date('2026-05-23T12:00:00Z');
	const aboveThresholdSince = new Date('2026-05-23T08:00:00Z'); // 4 hours ago
	assertEq(
		shouldFireAlert(aboveThresholdSince, now, null, 4, 24),
		true,
		'at exact threshold'
	);
});

scenario('PPM-5: sustained but recently alerted (cooldown) → false', () => {
	const now = new Date('2026-05-23T12:00:00Z');
	const aboveThresholdSince = new Date('2026-05-23T06:00:00Z'); // 6h ago
	const lastAlertAt = new Date('2026-05-23T10:00:00Z'); // 2h ago, < 24h cooldown
	assertEq(
		shouldFireAlert(aboveThresholdSince, now, lastAlertAt, 4, 24),
		false,
		'cooldown active'
	);
});

scenario('PPM-5: sustained + cooldown elapsed → true', () => {
	const now = new Date('2026-05-24T12:00:00Z');
	const aboveThresholdSince = new Date('2026-05-23T06:00:00Z'); // 30h ago
	const lastAlertAt = new Date('2026-05-23T11:00:00Z'); // 25h ago, > 24h cooldown
	assertEq(
		shouldFireAlert(aboveThresholdSince, now, lastAlertAt, 4, 24),
		true,
		'cooldown elapsed'
	);
});

// ─── PPM-6: doc-comment defense manifest ──
scenario('PPM-6: module source still documents the design pillars', () => {
	const src = readFileSync(MODULE_PATH, 'utf-8');
	const markers = [
		'Defense F',
		'median', // median-not-mean reasoning
		'≥3 peers', // sybil-resistance floor
		'Same-denomination filter', // exclude EUR peer when I'm USD
		'self-sovereign' // architectural premise
	];
	for (const m of markers) {
		if (!src.includes(m)) {
			throw new Error(`missing marker: ${m}`);
		}
	}
});

// ─── PPM-7: cp139-F-2 SSRF defense via fetchJson ──
// Pre-cp139-F-2, fetchPeerReceipt called bare fetch() and lacked
// the DNS-rebinding closure / redirect:manual / body-cap defenses
// that federationProbe.fetchJson() has.  This batch pins:
//   (a) the helper now routes through fetchJson (source sentinel)
//   (b) the import is wired
//   (c) attacker-controlled peerOrigin pointing at a literal
//       private host is rejected by fetchJson's layer-2 denylist
//       before any network call fires.
scenario(
	'PPM-7-1: fetchPeerReceipt routes through fetchJson (source sentinel)',
	() => {
		const src = readFileSync(MODULE_PATH, 'utf-8');
		if (!src.includes(`from '$indexer/federationProbe'`)) {
			throw new Error('expected $indexer/federationProbe import');
		}
		if (!src.includes('fetchJson<PeerReceiptResponse>(')) {
			throw new Error('expected fetchJson<PeerReceiptResponse> call');
		}
	}
);

scenario('PPM-7-2: fetchPeerReceipt no longer calls bare fetch()', () => {
	const src = readFileSync(MODULE_PATH, 'utf-8');
	// Look for the old smell.  The string `await fetch(` should
	// NOT appear in this module — every outbound HTTP call must
	// go through fetchJson.  This sentinel catches a regression
	// that re-introduces a bare fetch() (e.g. for a future second
	// endpoint).
	if (src.match(/\bawait\s+fetch\s*\(/)) {
		throw new Error('regression: bare fetch() in peerPriceMonitor');
	}
});

scenario(
	'PPM-7-3: cp139-F-2 design-rationale marker present in source',
	() => {
		const src = readFileSync(MODULE_PATH, 'utf-8');
		const markers = [
			'cp139-F-2', // explicit finding reference
			'DNS-rebinding', // the hardening this closes
			'six-layer' // points at federationProbe.fetchJson's defense stack
		];
		for (const m of markers) {
			if (!src.includes(m)) {
				throw new Error(`missing marker: ${m}`);
			}
		}
	}
);

scenario(
	'PPM-7-4: localhost peerOrigin rejected by fetchJson layer 2',
	async () => {
		// fetchJson rejects literal-private hostnames before any
		// network resolution.  We pass localhost as the peer origin
		// and expect fetchPeerReceipt to swallow the error and
		// return null — caller (sample-cycle loop) interprets null
		// as "skip this peer."
		const result = await fetchPeerReceipt(
			'https://localhost:8443',
			'BLURT',
			'USD'
		);
		assertEq(result, null, 'expected null for localhost origin');
	}
);

scenario(
	'PPM-7-5: 127.0.0.1 peerOrigin rejected by fetchJson layer 2',
	async () => {
		const result = await fetchPeerReceipt(
			'https://127.0.0.1:8443',
			'BLURT',
			'USD'
		);
		assertEq(result, null, 'expected null for 127.0.0.1 origin');
	}
);

scenario(
	'PPM-7-6: 169.254.169.254 (AWS metadata) peerOrigin rejected',
	async () => {
		const result = await fetchPeerReceipt(
			'https://169.254.169.254',
			'BLURT',
			'USD'
		);
		assertEq(result, null, 'expected null for AWS metadata origin');
	}
);

scenario(
	'PPM-7-7: http:// peerOrigin rejected by fetchJson layer 1',
	async () => {
		// Layer 1: HTTPS protocol enforcement.  An attacker who
		// chain-registered an http:// origin (rejected at intake,
		// but defense-in-depth) reaches the fetch layer and is
		// rejected again.
		const result = await fetchPeerReceipt(
			'http://example.com',
			'BLURT',
			'USD'
		);
		assertEq(result, null, 'expected null for http:// origin');
	}
);

scenario(
	'PPM-7-8: ::1 IPv6 loopback peerOrigin rejected',
	async () => {
		const result = await fetchPeerReceipt(
			'https://[::1]',
			'BLURT',
			'USD'
		);
		assertEq(result, null, 'expected null for IPv6 loopback');
	}
);

scenario(
	'PPM-7-9: .local TLD peerOrigin rejected',
	async () => {
		const result = await fetchPeerReceipt(
			'https://printer.local',
			'BLURT',
			'USD'
		);
		assertEq(result, null, 'expected null for .local TLD');
	}
);

// ─── PPM-10: fan-out-all architecture guard (cp167 decision lock) ──
//
// peerPriceMonitor MUST query every healthy peer and collect all
// observations (the median + disagreement signal depend on it).  It
// must NOT be "migrated" to @morphit/rpc-pool's quorumCall, which
// early-returns on partial consensus and would silently defeat the
// disagreement alert.  This sentinel fails if a future refactor
// swaps the fan-out for the pool, forcing a re-read of the in-source
// rationale (and this comment) before regressing the alert.
scenario('PPM-10: fan-out uses Promise.allSettled over peers', () => {
	const src = readFileSync(MODULE_PATH, 'utf8');
	if (!/Promise\.allSettled\s*\(/.test(src)) {
		throw new Error(
			'peerPriceMonitor no longer fans out via Promise.allSettled — ' +
				'the median/disagreement alert needs EVERY peer observation. ' +
				'See the cp167 design-decision comment before changing this.'
		);
	}
});

scenario('PPM-10: peer fan-out is NOT migrated to rpc-pool quorumCall', () => {
	const src = readFileSync(MODULE_PATH, 'utf8');
	// quorumCall early-returns on N-agreement among INTERCHANGEABLE
	// endpoints; peers are distinct federation members, not
	// interchangeable.  Match an actual IMPORT of the pool or a real
	// quorumCall INVOCATION — not the bare word, which legitimately
	// appears in the in-source rationale explaining why it's avoided.
	const importsPool = /\bfrom\s+['"]@morphit\/rpc-pool['"]/.test(src);
	const callsQuorum = /\bquorumCall\s*[(<]/.test(src);
	if (importsPool || callsQuorum) {
		throw new Error(
			'peerPriceMonitor imports @morphit/rpc-pool or invokes quorumCall — ' +
				'this defeats the disagreement alert (early-return on partial ' +
				'consensus drops peer observations). cp167 decided against this.'
		);
	}
});

// Settle async scenarios + report
await new Promise((r) => setTimeout(r, 50));

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
