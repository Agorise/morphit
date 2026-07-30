#!/usr/bin/env tsx
/**
 * Smoke: the login-pairing /wait SSE stream sends keep-alive pings. Anchor cp295.
 *
 * THE BUG THIS GUARDS. The QR-pair desktop screen showed a 5-minute
 * countdown but the QR died at ~60s with "This code expired". Cause:
 * an un-scanned pairing waits up to PID_TTL_MAX_MS (5 min) sending NO
 * bytes, so a reverse proxy (BunkerWeb / nginx default
 * `proxy_read_timeout` 60s) closes the idle connection; the client
 * reads the closed EventSource as expiry. The fix emits an SSE comment
 * every PAIRING_KEEPALIVE_INTERVAL_MS so the connection survives the
 * full window — mirroring the orderbook/chat stream keep-alive.
 *
 * RULE: the /wait handler must keep the connection alive. This smoke
 * fails if the keep-alive constant or the interval+ping disappears.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Delete the PAIRING_KEEPALIVE_INTERVAL_MS constant → fails.
 *   - Remove the keepalive setInterval / stream.write(': keepalive') → fails.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '..', 'src', 'api', 'loginPairing.ts');
const src = readFileSync(FILE, 'utf-8');

let pass = 0;
let fail = 0;
const check = (cond: boolean, label: string): void => {
	if (cond) {
		console.log(`  ✓ ${label}`);
		pass++;
	} else {
		console.error(`  ✗ ${label}`);
		fail++;
	}
};

// 1. The cadence constant exists and is comfortably under a 60s proxy idle timeout.
const m = src.match(/PAIRING_KEEPALIVE_INTERVAL_MS\s*=\s*([\d_]+)/);
check(m !== null, 'PAIRING_KEEPALIVE_INTERVAL_MS constant is defined');
if (m) {
	const ms = Number(m[1].replace(/_/g, ''));
	check(ms > 0 && ms < 60_000, `keep-alive interval (${ms}ms) is under the 60s proxy idle timeout`);
}

// 2. The /wait stream actually arms a keep-alive interval and writes a ping.
check(
	/setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*?stream\.write\(\s*['"]: keepalive/.test(src),
	'/wait stream arms a setInterval that writes an SSE keep-alive comment'
);

// 3. The interval is cleared so it can't outlive the stream.
check(/clearInterval\(keepalive\)/.test(src), 'keep-alive interval is cleared (finally)');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log(`✓ all ${pass} scenarios passed`);
