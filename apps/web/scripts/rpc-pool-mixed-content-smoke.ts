#!/usr/bin/env tsx
/**
 * apps/web/scripts/rpc-pool-mixed-content-smoke.ts
 *
 * An https page must never be handed an http:// endpoint to fetch.
 *
 * THE BUG
 * The browser's Blurt RPC pool put the hidden-service nodes first on EVERY
 * origin, and those nodes are `http://…onion:8091`. From an https instance that
 * is mixed active content: Firefox refuses it before opening a connection, so
 * each visitor took two guaranteed-blocked requests on boot and got a
 * mixed-content error in the console for each, on every page load. The code
 * claimed these "fail fast because a .onion host is not a real DNS name" —
 * the fallback did happen, so nothing looked broken, which is exactly why it
 * survived. Chrome treats `.onion` as potentially-trustworthy and Firefox does
 * not, so the behaviour was never even consistent between browsers.
 *
 * WHAT MUST STAY TRUE
 * Dropping the hidden tier on https must not weaken the Tor/I2P privacy path,
 * which is the point of that tier existing. Scenarios 2 and 3 pin the two
 * origins where it genuinely applies: a hidden origin gets hidden nodes and
 * NOTHING ELSE (no clearnet fallback can be allowed to leak), and a plain-http
 * origin still gets the hidden tier first.
 *
 * This EXECUTES `selectRpcPool` against each origin shape rather than reading
 * the source for a pattern.
 */

import {
	DEFAULT_HIDDEN_RPC_ENDPOINTS,
	DEFAULT_RPC_ENDPOINTS,
	SERVER_ONLY_CANONICAL_RPC_ENDPOINTS
} from '../src/lib/net/config';
import { selectRpcPool } from '../src/lib/net/endpoints';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  ✓ ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  ✗ ${m}`);
	if (d) console.log(`      ${d}`);
};

const isHttp = (u: string) => u.toLowerCase().startsWith('http://');
const hidden = new Set(DEFAULT_HIDDEN_RPC_ENDPOINTS);
const clearnet = new Set(DEFAULT_RPC_ENDPOINTS);

console.log('rpc-pool-mixed-content — an https page gets no http endpoints');
console.log('');

// ── 0. The premise ───────────────────────────────────────────────────
// If the hidden endpoints ever become https, this whole smoke is about a
// problem that no longer exists — and it should say so rather than pass
// silently on assertions that have quietly become vacuous.
{
	if (DEFAULT_HIDDEN_RPC_ENDPOINTS.length > 0)
		ok(`${DEFAULT_HIDDEN_RPC_ENDPOINTS.length} hidden endpoints configured`);
	else bad('no hidden endpoints configured — every scenario below is vacuous', 'check config.ts');

	if (DEFAULT_HIDDEN_RPC_ENDPOINTS.some(isHttp))
		ok('hidden endpoints are http:// — the mixed-content hazard is real, not hypothetical');
	else ok('hidden endpoints are all https:// — the hazard is gone; https may carry them again');
}

// ── 1. HTTPS origin: not one http endpoint ───────────────────────────
{
	for (const host of ['morphit.io', 'morphit.timeapp.foundation', 'vigilante.trading']) {
		const pool = selectRpcPool({ protocol: 'https:', hostname: host });
		const offenders = pool.filter(isHttp);
		if (offenders.length === 0) ok(`https://${host} — pool contains no http:// endpoint`);
		else
			bad(
				`https://${host} — pool still contains ${offenders.length} http:// endpoint(s), ` +
					'every one of which the browser will block as mixed content',
				offenders.join(', ')
			);

		if (pool.length > 0) ok(`https://${host} — pool is not empty (${pool.length} nodes)`);
		else bad(`https://${host} — pool is EMPTY; the release check cannot run at all`);

		if (pool.every((u) => clearnet.has(u)))
			ok(`https://${host} — every node is from the CORS-clean clearnet pool`);
		else
			bad(
				`https://${host} — pool contains a node outside the clearnet canonical set`,
				pool.filter((u) => !clearnet.has(u)).join(', ')
			);
	}
}

// ── 2. Hidden origin: hidden nodes and NOTHING else ──────────────────
// The leak that must never happen. A clearnet fallback here would open a
// connection from a Tor/I2P visitor's browser straight to a clearnet node.
{
	for (const host of [
		'cshiq5xf4kqhcvtvmvhvxwbmvwqxnbqzsvxqz2xq4nfrqgv6cq6vhoad.onion',
		'eanad5snqk3l7xwvpnzcdmxqvhqmqvbvqzqhq3nqvqvqvqvqvqvq.b32.i2p',
		'morphit.i2p'
	]) {
		const pool = selectRpcPool({ protocol: 'http:', hostname: host });
		if (pool.length > 0 && pool.every((u) => hidden.has(u)))
			ok(`${host} — hidden endpoints only, no clearnet tier to leak to`);
		else
			bad(
				`${host} — pool is not hidden-only`,
				pool.filter((u) => !hidden.has(u)).join(', ') || '(empty pool)'
			);
	}
	// Case matters: hostnames arrive however the browser reports them.
	const upper = selectRpcPool({
		protocol: 'http:',
		hostname: 'CSHIQ5XF4KQHCVTVMVHVXWBMVWQXNBQZSVXQZ2XQ4NFRQGV6CQ6VHOAD.ONION'
	});
	if (upper.every((u) => hidden.has(u)) && upper.length > 0)
		ok('an uppercase .ONION hostname is still recognised as a hidden origin');
	else bad('an uppercase .ONION hostname leaked a clearnet tier', upper.join(', '));
}

// ── 3. Plain-http clearnet origin: hidden tier survives ──────────────
// Dropping it here too would be over-correction: an http page may fetch http.
{
	const pool = selectRpcPool({ protocol: 'http:', hostname: 'morphit.io' });
	if (DEFAULT_HIDDEN_RPC_ENDPOINTS.every((u) => pool.includes(u)))
		ok('http:// clearnet origin still gets the hidden tier — no over-correction');
	else bad('the hidden tier was dropped from an http origin, where it is perfectly fetchable');

	const firstClearnet = pool.findIndex((u) => clearnet.has(u));
	const lastHidden = pool.map((u) => hidden.has(u)).lastIndexOf(true);
	if (firstClearnet === -1 || lastHidden < firstClearnet)
		ok('http:// clearnet origin orders every hidden node ahead of every clearnet node');
	else bad('a clearnet node is ordered ahead of a hidden node, defeating privacyFirst');
}

// ── 4. No location at all (SSR / prerender) ──────────────────────────
{
	const pool = selectRpcPool(null);
	if (pool.length > 0 && pool.every((u) => !isHttp(u)))
		ok('no location (SSR/prerender) yields a non-empty pool with no http endpoint');
	else bad('the no-location pool is empty or contains http', pool.join(', '));
}

// ── 5. Server-only nodes never reach the browser ─────────────────────
// They have no usable CORS headers; including one would be a guaranteed
// browser failure dressed up as a node outage.
{
	const everyPool = [
		selectRpcPool({ protocol: 'https:', hostname: 'morphit.io' }),
		selectRpcPool({ protocol: 'http:', hostname: 'morphit.io' }),
		selectRpcPool({ protocol: 'http:', hostname: 'x.onion' }),
		selectRpcPool(null)
	];
	const leaked = everyPool.flat().filter((u) => SERVER_ONLY_CANONICAL_RPC_ENDPOINTS.includes(u));
	if (leaked.length === 0) ok('no server-only (CORS-less) node appears in any browser pool');
	else bad('a server-only node leaked into a browser pool', [...new Set(leaked)].join(', '));
}

console.log('');
console.log('─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} rpc-pool-mixed-content scenarios passed`);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
