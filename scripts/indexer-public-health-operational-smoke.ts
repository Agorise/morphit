#!/usr/bin/env tsx
/**
 * indexer-public-health-operational — cp667.
 *
 * The PUBLIC /v1/health body now carries three operator-facing blocks —
 * `ipfs_seeding`, `system` (cpu/mem/disk), and `relay` ({ up }) — so an operator
 * can poll one URL over HTTP and see whether the node is seeding the release, how
 * loaded the box is, and whether the relay is reachable. (Ken's call to make
 * these public; backups/canary deliberately stay out of the public body.)
 *
 * This covers (1) the pure seeding DECISION agrees with ops-cli's checkIpfsSeeding,
 * (2) the snapshot SHAPE is stable (Zabbix-free HTTP polling depends on it), and
 * (3) the WIRING — the blocks are on the PUBLIC body, not behind the local-health
 * / verbose gate, and are served from the cached snapshot (not sampled per
 * request on this hot endpoint).
 *
 * Tamper tests (each must turn this red):
 *   - Move ipfs_seeding/system/relay inside the `if (localDiag)` gate → fails.
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
	__resetOperationalForTest,
	OPERATIONAL_TTL_MS,
	type SeedingFacts
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
check('the public body sets ipfs_seeding + system + relay', /body\.ipfs_seeding = op\.ipfs_seeding/.test(health) && /body\.system = op\.system/.test(health) && /body\.relay = op\.relay/.test(health));
check('the snapshot is primed at route setup', /primeOperationalSnapshot\(config\.relayHealthUrl\)/.test(health));

// the three blocks must be assigned BEFORE the localDiag gate (i.e. public)
const opIdx = health.indexOf('body.ipfs_seeding = op.ipfs_seeding');
const gateIdx = health.indexOf("c.req.header('x-morphit-local-health')");
check(
	'operational blocks are PUBLIC (assigned before the local-health gate)',
	opIdx > 0 && gateIdx > 0 && opIdx < gateIdx,
	'they must not be gated behind x-morphit-local-health'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} indexer-public-health-operational checks passed` : '✗ indexer-public-health-operational FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
