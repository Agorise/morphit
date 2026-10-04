#!/usr/bin/env tsx
/**
 * indexer-public-health-operational.
 *
 * /v1/health carries three operator-facing blocks — `ipfs_seeding`, `system`
 * (cpu/mem/disk), and `relay` ({ up }) — served from a cached snapshot. The
 * public body is coarse: the seeding state and whether the relay answers.
 * The seeding detail and the host's resource figures need x-morphit-local-health
 * (the operator's own poll); backups/canary stay out of the body entirely.
 *
 * This covers (1) the pure seeding DECISION agrees with ops-cli's checkIpfsSeeding,
 * (2) the snapshot SHAPE is stable (HTTP polling depends on it), and (3) the
 * WIRING — what is public and what is local, served from the cached snapshot
 * (not sampled per request on this hot endpoint).
 *
 * Tamper tests (each must turn this red):
 *   - Move `body.system = op.system` out of the `if (localDiag)` gate → fails.
 *   - Serve the full seeding block publicly → fails.
 *   - Drop the getOperationalSnapshot call → fails.
 *   - Sample CPU/systemctl/relay per request instead of caching → (perf) the
 *     stale-while-revalidate contract check fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	decideSeeding,
	getOperationalSnapshot,
	primeOperationalSnapshot,
	mergeOperationalSnapshot,
	__resetOperationalForTest,
	OPERATIONAL_TTL_MS,
	type SeedingFacts,
	type OperationalSnapshot
} from '../apps/indexer/src/api/operationalHealth.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── indexer-public-health-operational (cp667) ──────────\n');

// ── seeding decision (mirrors ops-cli checkIpfsSeeding) ──────────
const mk = (o: Partial<SeedingFacts>): SeedingFacts => ({
	daemon: 'active',
	pinTimer: 'active',
	rebroadcastTimer: 'active',
	pinFailed: false,
	rebroadcastFailed: false,
	...o
});
check('nothing installed → not-configured', decideSeeding(mk({ daemon: 'not-installed', pinTimer: 'not-installed', rebroadcastTimer: 'not-installed' })).state === 'not-configured');
check('all unknown → unknown', decideSeeding(mk({ daemon: 'unknown', pinTimer: 'unknown', rebroadcastTimer: 'unknown' })).state === 'unknown');
check('daemon down → down', decideSeeding(mk({ daemon: 'inactive' })).state === 'down');
check('a timer inactive → degraded', decideSeeding(mk({ pinTimer: 'inactive' })).state === 'degraded');
check('last rebroadcast failed → degraded', decideSeeding(mk({ rebroadcastFailed: true })).state === 'degraded');
check('all active, no failures → ok', decideSeeding(mk({})).state === 'ok');

// ── one failing block must NOT blank the others (merge resilience) ──
const populated: OperationalSnapshot = {
	ipfs_seeding: { state: 'ok', detail: 'seeding' },
	system: { cpu_pct: 12, mem_pct: 40, mem_used_gb: 6, mem_total_gb: 15, disk_pct: 20, disk_used_gb: 90, disk_total_gb: 460, disk_avail_gb: 360 },
	relay: { up: true, hidden_only: null }
};
{
	// relay probe failed this pass (null) → relay keeps prev true, others update.
	const merged = mergeOperationalSnapshot(populated, {
		ipfs_seeding: { state: 'degraded', detail: 'x' },
		system: { cpu_pct: 5, mem_pct: 41, mem_used_gb: 6, mem_total_gb: 15, disk_pct: 21, disk_used_gb: 91, disk_total_gb: 460, disk_avail_gb: 359 },
		relay: null
	});
	check('a failed relay block keeps its previous value', merged.relay.up === true);
	check('the other blocks still update when relay fails', merged.ipfs_seeding.state === 'degraded' && merged.system.cpu_pct === 5);
}
{
	// systemctl block failed → ipfs keeps prev; system + relay still refresh.
	const merged = mergeOperationalSnapshot(populated, { ipfs_seeding: null, system: { cpu_pct: 9, mem_pct: 42, mem_used_gb: 6, mem_total_gb: 15, disk_pct: 22, disk_used_gb: 92, disk_total_gb: 460, disk_avail_gb: 358 }, relay: { up: false, hidden_only: null } });
	check('a failed seeding block keeps its previous value', merged.ipfs_seeding.state === 'ok');
	check('system + relay still refresh when seeding fails', merged.system.cpu_pct === 9 && merged.relay.up === false);
}
{
	// ALL blocks failed → whole snapshot unchanged (never blanks to defaults).
	const merged = mergeOperationalSnapshot(populated, { ipfs_seeding: null, system: null, relay: null });
	check('all-fail keeps the entire previous snapshot (never blanks to null/false)', merged.relay.up === true && merged.system.cpu_pct === 12 && merged.ipfs_seeding.state === 'ok');
}

// ── snapshot SHAPE (public JSON contract) ────────────────────────
__resetOperationalForTest();
const snap = getOperationalSnapshot('', 0); // synchronous, returns default before first refresh
check('snapshot has ipfs_seeding.state + detail', typeof snap.ipfs_seeding.state === 'string' && typeof snap.ipfs_seeding.detail === 'string');
check(
	'snapshot.system carries cpu/mem/disk pct AND gb figures',
	'cpu_pct' in snap.system &&
		'mem_pct' in snap.system &&
		'mem_used_gb' in snap.system &&
		'mem_total_gb' in snap.system &&
		'disk_pct' in snap.system &&
		'disk_used_gb' in snap.system &&
		'disk_total_gb' in snap.system &&
		'disk_avail_gb' in snap.system
);
check('snapshot.relay is { up: boolean }', typeof snap.relay.up === 'boolean');
check('TTL is a sane positive number', OPERATIONAL_TTL_MS > 0 && OPERATIONAL_TTL_MS <= 60_000);

// stale-while-revalidate: reading synchronously never throws / never blocks
let threw = false;
try {
	primeOperationalSnapshot('');
	getOperationalSnapshot('', Date.now());
} catch {
	threw = true;
}
check('reading the snapshot never throws', !threw);

// ── WIRING: on the PUBLIC body, not behind the gate ──────────────
const health = read('apps/indexer/src/api/health.ts');
check('health imports the operational snapshot', /getOperationalSnapshot|primeOperationalSnapshot/.test(health));
// the public body is coarse — the seeding state and whether the relay
// answers. The seeding detail and the host's cpu/mem/disk figures are served
// only with x-morphit-local-health.
check('the public body sets the seeding state and relay.up', /body\.ipfs_seeding = localDiag \? op\.ipfs_seeding : \{ state: op\.ipfs_seeding\.state \}/.test(health) && /body\.relay = \{ up: op\.relay\.up \}/.test(health));
// v1.18.0 (F32): the snapshot also carries the relay's hidden_only for the
// clearnet gate. It is not a public health field; the body copies `up` alone.
check('the relay\'s hidden_only is NOT served on the public health body', !/body\.[\w.]+\s*=[^;]*hidden_only/.test(health));
check('the snapshot is primed at route setup', /primeOperationalSnapshot\(config\.relayHealthUrl\)/.test(health));

// the host figures are assigned INSIDE the local-health gate
const gateIdx = health.indexOf("c.req.header('x-morphit-local-health')");
const localIdx = health.indexOf('if (localDiag) {', gateIdx);
const sysIdx = health.indexOf('body.system = op.system');
const closeIdx = localIdx > 0 ? health.indexOf('\n\t\t}', localIdx) : -1;
check(
	'the host cpu/mem/disk figures are LOCAL only (inside the local-health gate)',
	gateIdx > 0 && localIdx > gateIdx && sysIdx > localIdx && sysIdx < closeIdx,
	'they must not reach the public body'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} indexer-public-health-operational checks passed` : '✗ indexer-public-health-operational FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
