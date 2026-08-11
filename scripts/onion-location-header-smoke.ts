#!/usr/bin/env tsx
/**
 * onion-location-header — cp700.
 *
 * Brave (and other header-only Tor browsers) show the ".onion available" pill
 * ONLY when the clearnet site sends the Onion-Location HTTP HEADER. Morphit
 * historically emitted just the <meta http-equiv="onion-location"> tag, which
 * Tor Browser honours but Brave ignores. We now ALSO emit the HTTP header from
 * BunkerWeb (clearnet-only by construction — the onion bypasses BunkerWeb), so
 * both audiences are covered. Guards the header wiring AND that the meta tag is
 * retained (don't regress Tor Browser).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0, fail = 0;
const check = (n: string, c: boolean): void => {
	if (c) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}`); fail++; }
};

console.log('\n── onion-location-header (cp700) ──────────────────────\n');
const bw = read('ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2');
check('BunkerWeb emits the Onion-Location HTTP header (Brave reads only the header)',
	/CUSTOM_HEADER=Onion-Location:\s*http:\/\/\{\{\s*morphit_instance_tor_address\s*\}\}/.test(bw));
check('the header is gated on the onion actually existing (no empty/garbage header)',
	/\{%\s*if morphit_instance_tor_address[^%]*length > 0\s*%\}/.test(bw));
check('the header is path-preserving ($request_uri → same page on the onion)',
	/CUSTOM_HEADER=Onion-Location:[^\n]*\$request_uri/.test(bw));
// Don't regress Tor Browser: the frontend must still emit the meta tag too.
const head = read('apps/web/src/lib/components/Head.svelte');
check('the frontend STILL emits the <meta http-equiv="onion-location"> tag (Tor Browser)',
	/http-equiv="onion-location"/.test(head));
console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} onion-location-header checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
