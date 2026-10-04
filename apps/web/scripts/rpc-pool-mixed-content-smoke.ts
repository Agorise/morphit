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
 * NOTHING ELSE (no clearnet fallback can be allowed to leak).
 *
 * A pool is only as good as what the page's Content-Security-Policy lets it
 * reach: scenario 6 intersects each origin's pool with the connect-src the
 * frontend nginx serves for that host, and requires every node the release
 * check may ask (the first MAX_NODES_PER_CHECK) to be allowed. A plain-http
 * clearnet page used to get the .onion nodes first, which its CSP blocks, so
 * the check reached no node at all and remembered the failure for 24 h.
 *
 * This EXECUTES `selectRpcPool` against each origin shape rather than reading
 * the source for a pattern.
 */

import {
	DEFAULT_HIDDEN_RPC_ENDPOINTS,
	DEFAULT_I2P_RPC_ENDPOINTS,
	DEFAULT_RPC_ENDPOINTS,
	SERVER_ONLY_CANONICAL_RPC_ENDPOINTS
} from '../src/lib/net/config';
import { selectRpcPool } from '../src/lib/net/endpoints';
import { MAX_NODES_PER_CHECK } from '../src/lib/net/releaseVerifyCore';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const hidden = new Set([...DEFAULT_HIDDEN_RPC_ENDPOINTS, ...DEFAULT_I2P_RPC_ENDPOINTS]);
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

// ── 2b. Each hidden network gets ITS OWN nodes ───────────────────────
// An I2P proxy cannot route .onion and Tor cannot route .b32.i2p, so an .i2p
// page handed the onion list can never complete the release check (it used to
// fail on every load). Each hidden origin gets the full node list of its own
// network.
{
	const i2p = selectRpcPool({
		protocol: 'http:',
		hostname: 'x7abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr.b32.i2p'
	});
	if (
		i2p.length === DEFAULT_I2P_RPC_ENDPOINTS.length &&
		i2p.every((u) => new URL(u).hostname.endsWith('.b32.i2p'))
	)
		ok(`.i2p origin — all ${i2p.length} .b32.i2p nodes and nothing else`);
	else
		bad('.i2p origin — pool is not exactly the .b32.i2p nodes', i2p.join(', ') || '(empty pool)');
	const onion = selectRpcPool({ protocol: 'http:', hostname: 'x.onion' });
	if (
		onion.length === DEFAULT_HIDDEN_RPC_ENDPOINTS.length &&
		onion.every((u) => new URL(u).hostname.endsWith('.onion'))
	)
		ok(`.onion origin — all ${onion.length} .onion nodes and nothing else`);
	else
		bad('.onion origin — pool is not exactly the .onion nodes', onion.join(', ') || '(empty pool)');
}

// ── 3. Plain-http clearnet origin: the clearnet nodes, like https ────
// Its CSP (the default host's) allows only those; a hidden node there would be
// blocked before any connection.
{
	const pool = selectRpcPool({ protocol: 'http:', hostname: 'morphit.lan' });
	if (pool.length > 0 && pool.every((u) => clearnet.has(u)))
		ok('http:// clearnet origin gets the clearnet nodes only (what its CSP allows)');
	else bad('http:// clearnet origin got nodes its CSP blocks', pool.join(', '));
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
		selectRpcPool({ protocol: 'http:', hostname: 'x.b32.i2p' }),
		selectRpcPool(null)
	];
	const leaked = everyPool.flat().filter((u) => SERVER_ONLY_CANONICAL_RPC_ENDPOINTS.includes(u));
	if (leaked.length === 0) ok('no server-only (CORS-less) node appears in any browser pool');
	else bad('a server-only node leaked into a browser pool', [...new Set(leaked)].join(', '));
}

// ── 6. Every node the release check may ask is allowed by that page's CSP ──
// The connect-src of each `map $host $morphit_csp` value the frontend nginx
// serves, intersected with the pool selectRpcPool gives that kind of host.
{
	const nginx = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'..',
			'..',
			'..',
			'ops',
			'bunkerweb',
			'frontend',
			'nginx.conf'
		),
		'utf8'
	);
	const map = /map \$host \$morphit_csp \{([\s\S]*?)\n\}/.exec(nginx)?.[1] ?? '';
	const cspFor = (selector: string): string[] => {
		const line = map.split('\n').find((l) => l.trim().startsWith(selector));
		const csp = /"([^"]*)"/.exec(line ?? '')?.[1] ?? '';
		const connect = csp.split(';').find((d) => d.trim().startsWith('connect-src')) ?? '';
		return connect.trim().split(/\s+/).slice(1);
	};
	const cases: Array<[string, { protocol: string; hostname: string }, string]> = [
		['https clearnet', { protocol: 'https:', hostname: 'morphit.io' }, 'default'],
		['plain-http clearnet', { protocol: 'http:', hostname: 'morphit.lan' }, 'default'],
		['.onion', { protocol: 'http:', hostname: 'x.onion' }, '~*\\.onion$'],
		['.i2p', { protocol: 'http:', hostname: 'x.b32.i2p' }, '~*\\.i2p$']
	];
	for (const [label, origin, selector] of cases) {
		const allowed = cspFor(selector);
		const asked = selectRpcPool(origin).slice(0, MAX_NODES_PER_CHECK);
		const blocked = asked.filter((u) => !allowed.includes(new URL(u).origin));
		if (allowed.length > 1 && asked.length > 0 && blocked.length === 0)
			ok(
				`${label} — the ${asked.length} node(s) the release check may ask are all allowed by its CSP`
			);
		else
			bad(
				`${label} — the release check would ask node(s) its CSP blocks`,
				blocked.join(', ') || `(no connect-src found for ${selector})`
			);
	}
}

console.log('');
console.log('─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} rpc-pool-mixed-content scenarios passed`);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
