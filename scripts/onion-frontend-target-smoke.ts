#!/usr/bin/env tsx
/**
 * onion-frontend-target — cp695.
 *
 * The Tor .onion and I2P .b32.i2p addresses must reach the FRONTEND (the nginx
 * that serves the site + fans out /v1 -> indexer, /relay -> relay), not the bare
 * relay on 8080 (which 404s the site and /v1/instance). They can't route through
 * BunkerWeb (it force-redirects http->https, which Tor/I2P can't follow), so the
 * frontend is published on a host loopback port and the hidden services target
 * it.
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

console.log('\n── onion-frontend-target (cp695) ──────────────────────\n');
const gv = read('ops/ansible/group_vars/all.yml');
check('a shared onion/i2p frontend port var exists', /morphit_onion_frontend_port:\s*\d+/.test(gv));
check(
	'Tor no longer targets the relay port 8080 (it 404d the site)',
	!/morphit_tor_local_port:\s*8080\b/.test(gv) && /morphit_tor_local_port:\s*8090/.test(gv)
);
check(
	'I2P no longer targets the relay port 8080',
	!/morphit_i2pd_local_port:\s*8080\b/.test(gv) && /morphit_i2pd_local_port:\s*8090/.test(gv)
);
const dc = read('ops/ansible/roles/bunkerweb/templates/docker-compose.yml.j2');
check(
	'the frontend container publishes a host LOOPBACK port for the hidden services',
	/127\.0\.0\.1:\{\{ morphit_onion_frontend_port[^}]*\}\}:80/.test(dc)
);
// the tor/i2pd defaults must not silently fall back to 8080 either
check(
	'tor + i2pd role defaults also point at the fan-out (not 8080)',
	!/morphit_tor_local_port:\s*8080\b/.test(read('ops/ansible/roles/tor/defaults/main.yml')) &&
		!/morphit_i2pd_local_port:\s*8080\b/.test(read('ops/ansible/roles/i2pd/defaults/main.yml'))
);
console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} onion-frontend-target checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
