/**
 * broadcast-chain-proxy-rate-limit-smoke (cp347)
 *
 * Deep-deep finding (cp347): the cp344 forwarding proxies /v1/chain (block
 * explorer + ref-block properties) and /v1/broadcast (the write proxy) each
 * forward ONE upstream Blurt RPC call per request, yet were mounted WITHOUT the
 * per-IP rate-limit tier that every other upstream-touching proxy (/v1/account,
 * /v1/profiles, /v1/release, …) carries — so an unauthenticated flood could
 * amplify load onto the operator's RPC pool. Fixed by wrapping both in a Hono
 * sub-app with rateLimit('resource', …).
 *
 * This smoke pins that fix so the gap can't silently reopen: it fails if either
 * route reverts to a bare `app.route('/v1/<x>', <route>(blurt))` mount, and it
 * confirms both carry the 'resource' tier (mirroring /v1/account).
 *
 * Static source scan of main.ts.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf8');

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${label}`);
	} else {
		failed++;
		console.log(`  \u2717 ${label}`);
	}
}

console.log('\nbroadcast-chain-proxy-rate-limit smoke:\n');

// 1. Neither forwarding proxy is mounted bare (un-rate-limited).
check(
	'/v1/chain is NOT mounted bare (no un-rate-limited app.route)',
	!/app\.route\(\s*'\/v1\/chain'\s*,\s*chainExplorerRoute\(/.test(main)
);
check(
	'/v1/broadcast is NOT mounted bare (no un-rate-limited app.route)',
	!/app\.route\(\s*'\/v1\/broadcast'\s*,\s*broadcastRoute\(/.test(main)
);

// 2. Both are wrapped in a sub-app carrying the 'resource' rate-limit tier.
check(
	"/v1/chain sub-app carries rateLimit('resource', …)",
	/chainApp\.use\('\*',\s*rateLimit\('resource',\s*config\.resourceRatePerMin\)\)/.test(main) &&
		/app\.route\('\/v1\/chain',\s*chainApp\)/.test(main)
);
check(
	"/v1/broadcast sub-app carries rateLimit('resource', …)",
	/broadcastApp\.use\('\*',\s*rateLimit\('resource',\s*config\.resourceRatePerMin\)\)/.test(main) &&
		/app\.route\('\/v1\/broadcast',\s*broadcastApp\)/.test(main)
);

// 3. Sanity: the sibling pattern they mirror (/v1/account) is still rate-limited.
check(
	"/v1/account still carries rateLimit('resource', …) (the mirrored pattern)",
	/accountApp\.use\('\*',\s*rateLimit\('resource',\s*config\.resourceRatePerMin\)\)/.test(main)
);

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} broadcast-chain-proxy-rate-limit scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
