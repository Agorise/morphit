#!/usr/bin/env tsx
/**
 * reachability-check — cp694.
 *
 * A home node behind a router can't detect its own inbound reachability (NAT
 * hairpin), so an ISP 80/443 block used to surface only as a stale "Unreachable"
 * federation pill hours later. The post-install self-check probes from an
 * external Tor exit and tells the operator plainly, and points at the .onion
 * (which needs no port-forward) when the clearnet ports are blocked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
	if (c) { console.log(`  ✓ ${n}`); pass++; }
	else { console.log(`  ✗ ${n}${d ? `: ${d}` : ''}`); fail++; }
};

console.log('\n── reachability-check (cp694) ─────────────────────────\n');
check(
	'the reachability self-check script exists',
	existsSync(join(REPO, 'ops/scripts/morphit-reachability-check.sh'))
);
const sh = read('ops/scripts/morphit-reachability-check.sh');
check(
	'it probes from OUTSIDE via the Tor SOCKS proxy (external vantage, no hairpin)',
	/--socks5-hostname/.test(sh) && /127\.0\.0\.1:9050/.test(sh)
);
check(
	'it names the ISP/router 80/443 block as the cause when unreachable',
	/ISP/.test(sh) && /inbound 80\/443/.test(sh)
);
check(
	'it points at the working .onion path (no port-forward needed)',
	/\/var\/lib\/tor/.test(sh) && /http:\/\/\$ONION/.test(sh)
);
const wiz = read('apps/ops-cli/src/init/runAnsibleInstall.ts');
check(
	'the install runs the self-check on home boxes',
	/morphit-reachability-check\.sh/.test(wiz) && /inputs\.mode === 'home'/.test(wiz)
);
console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} reachability-check checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
