#!/usr/bin/env tsx
/**
 * relay-health-probe — cp696.
 *
 * The indexer's /v1/health reports relay.up by probing the co-located relay's
 * /v1/health. That URL (MORPHIT_INDEXER_RELAY_HEALTH_URL) defaulted to '' and
 * was never set in the install env, so probeRelay short-circuited to up:false on
 * EVERY node — reporting the relay down while it was healthy. Guards that the URL
 * has a real default and the ansible env sets it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
	if (c) { console.log(`  ✓ ${n}`); pass++; }
	else { console.log(`  ✗ ${n}${d ? `: ${d}` : ''}`); fail++; }
};

console.log('\n── relay-health-probe (cp696) ─────────────────────────\n');
const cfg = read('apps/indexer/src/config/index.ts');
const m = cfg.match(/MORPHIT_INDEXER_RELAY_HEALTH_URL:\s*z\.string\(\)\.default\('([^']*)'\)/);
check('MORPHIT_INDEXER_RELAY_HEALTH_URL has a NON-EMPTY default (empty = never probes → always up:false)', !!m && m[1].length > 0, m ? `default is '${m[1]}'` : 'not found');
check('the default points at the relay /v1/health on loopback', !!m && /^http:\/\/127\.0\.0\.1:\d+\/v1\/health$/.test(m[1]));
const env = read('ops/ansible/roles/morphit/templates/indexer.env.j2');
check('the ansible indexer env sets the relay health URL (with the relay port var)', /MORPHIT_INDEXER_RELAY_HEALTH_URL=http:\/\/127\.0\.0\.1:\{\{ morphit_relay_bind_port[^}]*\}\}\/v1\/health/.test(env));
// guard the short-circuit intent: an empty url still yields false (correct), a real one gets probed
const oh = read('apps/indexer/src/api/operationalHealth.ts');
check('probeRelay still treats an empty url as down (no false-positive when truly unconfigured)', /if \(url\.length === 0\) return false/.test(oh));
console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} relay-health-probe checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
