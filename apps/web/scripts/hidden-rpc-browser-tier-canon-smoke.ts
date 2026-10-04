/**
 * The browser's hidden RPC tier carries EVERY public .onion node (v1.20.0 fix
 * wave, D12).
 *
 * On a .onion page the app's direct-chain release check uses ONLY
 * DEFAULT_HIDDEN_RPC_ENDPOINTS (selectRpcPool). It listed 2 of the 7 onion
 * nodes (Star, Jade), so with those two down the check failed although five
 * more nodes were up — against the mandate that every RPC feature uses the
 * full node list. The canonical list is @morphit/operator-config's
 * DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS; Tor Browser reaches its .onion half and
 * an I2P proxy its .b32.i2p half. This pins: the browser's .onion tier === the
 * canonical .onion subset and its .b32.i2p tier === the canonical .b32.i2p
 * subset, same order, and each node's two addresses count as one operator.
 *
 * (ops/bunkerweb/frontend/nginx.conf's hidden-origin CSP connect-src must list
 * the same origins; scripts/csp-header-consistency-smoke.ts checks that side.)
 */
import { DEFAULT_HIDDEN_RPC_ENDPOINTS, DEFAULT_I2P_RPC_ENDPOINTS } from '../src/lib/net/config.ts';
import { rpcOperatorOf } from '../src/lib/net/endpoints.ts';
import { DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS } from '../../../packages/operator-config/src/index.ts';

const canonOnions = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter((u) =>
	new URL(u).hostname.endsWith('.onion')
);
const browser = [...DEFAULT_HIDDEN_RPC_ENDPOINTS];
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
	if (ok) console.log(`  ✓ ${name}`);
	else {
		failed++;
		console.log(`  ✗ ${name}\n      ${detail}`);
	}
}
console.log('browser hidden RPC tier canon smoke:\n');
check(
	'the browser tier lists every canonical .onion RPC node, in canonical order',
	JSON.stringify(browser) === JSON.stringify(canonOnions),
	`browser=${browser.length} canonical onions=${canonOnions.length}; missing: ${canonOnions.filter((u) => !browser.includes(u)).join(', ') || '-'}; extra: ${browser.filter((u) => !canonOnions.includes(u)).join(', ') || '-'}`
);
check(
	'the .onion tier holds no .i2p entry',
	browser.every((u) => !new URL(u).hostname.endsWith('.i2p')),
	browser.join(', ')
);
const canonI2p = DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS.filter((u) =>
	new URL(u).hostname.endsWith('.b32.i2p')
);
check(
	'the .b32.i2p tier lists every canonical .b32.i2p RPC node, in canonical order',
	JSON.stringify([...DEFAULT_I2P_RPC_ENDPOINTS]) === JSON.stringify(canonI2p),
	`browser=${DEFAULT_I2P_RPC_ENDPOINTS.length} canonical=${canonI2p.length}`
);
check(
	"each node's .onion and .b32.i2p count as ONE operator (and different nodes as different ones)",
	DEFAULT_HIDDEN_RPC_ENDPOINTS.every(
		(u, i) => rpcOperatorOf(u) === rpcOperatorOf(DEFAULT_I2P_RPC_ENDPOINTS[i]!)
	) &&
		new Set(DEFAULT_HIDDEN_RPC_ENDPOINTS.map(rpcOperatorOf)).size ===
			DEFAULT_HIDDEN_RPC_ENDPOINTS.length,
	DEFAULT_HIDDEN_RPC_ENDPOINTS.map(rpcOperatorOf).join(', ')
);
console.log('');
if (failed > 0) {
	console.log(`✗ ${failed} of 4 browser hidden-tier canon scenarios failed`);
	process.exit(1);
}
console.log('✓ all 4 browser hidden-tier canon scenarios passed');
