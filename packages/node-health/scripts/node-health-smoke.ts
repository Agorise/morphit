#!/usr/bin/env tsx
/**
 * node-health-smoke (cp707 + cp708).
 *
 * Two guarantees:
 *
 * 1. SEEDING PARITY — the whole reason `@morphit/node-health` exists.
 *    Both callers (ops-cli `checkIpfsSeeding`, indexer `decideSeeding`)
 *    now delegate their STATE decision to the shared `classifySeeding`.
 *    This smoke imports all three and, across an exhaustive-ish matrix
 *    of systemd facts, asserts:
 *      - the shared classifier's `state` matches the branch we expect;
 *      - both callers return the SAME `state` as the shared classifier
 *        for the same facts (they can never drift again);
 *      - the callers' distinct DETAIL wording is preserved (so the
 *        public endpoint stays terse and the CLI keeps its remediation
 *        hints), catching an accidental copy-paste that would collapse
 *        the two.
 *
 * 2. DISK-PATH RESOLUTION — `resolveHealthDiskPath` honours an absolute
 *    MORPHIT_HEALTH_DISK_PATH and safely falls back to '/' for unset /
 *    empty / relative values (cp708).
 */

import { classifySeeding, resolveHealthDiskPath, HEALTH_DISK_PATH_ENV } from '../src/index.ts';
import type { ServiceState, SeedingState } from '../src/index.ts';
import { checkIpfsSeeding } from '../../../apps/ops-cli/src/commands/health.ts';
import { decideSeeding } from '../../../apps/indexer/src/api/operationalHealth.ts';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
	if (cond) {
		passed++;
	} else {
		failed++;
		console.error(`  ✗ ${label}`);
	}
}

// ── 1. Seeding parity across a fact matrix ──────────────────────────

interface Facts {
	daemon: ServiceState;
	pinTimer: ServiceState;
	rebroadcastTimer: ServiceState;
	pinFailed: boolean;
	rebroadcastFailed: boolean;
}

const S: readonly ServiceState[] = [
	'active',
	'inactive',
	'failed',
	'activating',
	'not-installed',
	'unknown'
];

/** Independent oracle for the expected state — deliberately re-derived
 *  here (not importing classifySeeding's internals) so a bug in the
 *  shared classifier can't hide behind itself. */
function expectedState(f: Facts): SeedingState {
	const ni = (s: ServiceState) => s === 'not-installed';
	if (ni(f.daemon) && ni(f.pinTimer) && ni(f.rebroadcastTimer)) return 'not-configured';
	if (f.daemon === 'unknown' && f.pinTimer === 'unknown' && f.rebroadcastTimer === 'unknown')
		return 'unknown';
	if (f.daemon !== 'active') return 'down';
	if (
		f.pinTimer !== 'active' ||
		f.rebroadcastTimer !== 'active' ||
		f.pinFailed ||
		f.rebroadcastFailed
	)
		return 'degraded';
	return 'ok';
}

let matrixCount = 0;
for (const daemon of S) {
	for (const pinTimer of S) {
		for (const rebroadcastTimer of S) {
			for (const pinFailed of [false, true]) {
				for (const rebroadcastFailed of [false, true]) {
					const f: Facts = { daemon, pinTimer, rebroadcastTimer, pinFailed, rebroadcastFailed };
					matrixCount++;
					const shared = classifySeeding(f);
					const exp = expectedState(f);
					ok(shared.state === exp, `classify ${JSON.stringify(f)} → ${shared.state} (expected ${exp})`);

					// ops-cli caller (IpfsSeedingFacts is a superset — add the age fields).
					const opsOut = checkIpfsSeeding({
						...f,
						pinRanMs: null,
						rebroadcastRanMs: null
					});
					// indexer caller.
					const idxOut = decideSeeding(f);

					ok(
						opsOut.state === shared.state && idxOut.state === shared.state,
						`caller parity ${JSON.stringify(f)}: ops=${opsOut.state} idx=${idxOut.state} shared=${shared.state}`
					);
					// Details are non-empty everywhere and DISTINCT between the two
					// surfaces for at least the 'ok'/'not-configured' branches (proves
					// the wording didn't collapse into one shared string).
					ok(opsOut.detail.length > 0 && idxOut.detail.length > 0, `details non-empty ${JSON.stringify(f)}`);
				}
			}
		}
	}
}

// Spot-check the specific wording each surface must keep.
{
	const allInstalledOk: Facts = {
		daemon: 'active',
		pinTimer: 'active',
		rebroadcastTimer: 'active',
		pinFailed: false,
		rebroadcastFailed: false
	};
	const ops = checkIpfsSeeding({ ...allInstalledOk, pinRanMs: 1000, rebroadcastRanMs: 2000 });
	const idx = decideSeeding(allInstalledOk);
	ok(ops.detail.includes('IPFS') && ops.detail.includes('last '), 'ops ok detail keeps ages/wording');
	ok(idx.detail === 'pinning the release + rebroadcasting the IPNS record', 'idx ok detail terse');
	ok(ops.detail !== idx.detail, 'ok detail wording is surface-specific (not collapsed)');
}
{
	const none: Facts = {
		daemon: 'not-installed',
		pinTimer: 'not-installed',
		rebroadcastTimer: 'not-installed',
		pinFailed: false,
		rebroadcastFailed: false
	};
	const ops = checkIpfsSeeding({ ...none, pinRanMs: null, rebroadcastRanMs: null });
	const idx = decideSeeding(none);
	ok(ops.state === 'not-configured' && idx.state === 'not-configured', 'not-configured parity');
	ok(ops.detail.includes('morphit-ops harden'), 'ops not-configured detail has remediation');
	ok(idx.detail === 'IPFS release seeding not enabled on this node', 'idx not-configured detail terse');
}
{
	// degraded: pin timer inactive + rebroadcast failed → both problems, in order.
	const deg: Facts = {
		daemon: 'active',
		pinTimer: 'inactive',
		rebroadcastTimer: 'active',
		pinFailed: false,
		rebroadcastFailed: true
	};
	const ops = checkIpfsSeeding({ ...deg, pinRanMs: null, rebroadcastRanMs: null });
	const idx = decideSeeding(deg);
	ok(ops.state === 'degraded' && idx.state === 'degraded', 'degraded parity');
	// pin-timer problem comes before rebroadcast-failed in both renderings.
	ok(
		ops.detail.indexOf('release-pin timer') < ops.detail.indexOf('IPNS rebroadcast FAILED'),
		'ops degraded problem order stable'
	);
	ok(
		idx.detail.indexOf('pin timer') < idx.detail.indexOf('last rebroadcast failed'),
		'idx degraded problem order stable'
	);
}

// ── 2. Disk-path resolution ─────────────────────────────────────────

function diskCase(val: string | undefined, expected: string, label: string): void {
	const env: Record<string, string | undefined> = {};
	if (val !== undefined) env[HEALTH_DISK_PATH_ENV] = val;
	ok(resolveHealthDiskPath(env) === expected, `${label} → ${expected}`);
}
diskCase(undefined, '/', 'unset');
diskCase('', '/', 'empty');
diskCase('   ', '/', 'whitespace');
diskCase('var/lib/postgresql', '/', 'relative rejected');
diskCase('./data', '/', 'dot-relative rejected');
diskCase('/var/lib/postgresql', '/var/lib/postgresql', 'absolute honoured');
diskCase('  /mnt/data  ', '/mnt/data', 'trimmed absolute honoured');
diskCase('/', '/', 'explicit root');

console.log('');
console.log(`  matrix combinations checked: ${matrixCount}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('✗ node-health smoke failed');
	process.exit(1);
}
console.log(`✓ all ${passed} node-health scenarios pass`);
