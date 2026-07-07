/**
 * endpoint-error-classify-smoke (cp346; repurposed cp408)
 *
 * Two guards:
 *
 * 1. PRIVACY (#1) — the settings RPC-endpoints card NEVER contacts a Blurt RPC
 *    node directly. Node latency/health shown on the card comes ONLY from the
 *    indexer (GET /v1/rpc-endpoints), which measures the pool server-side. The
 *    browser-side probe (`warmup()`) has been removed entirely. This locks that
 *    in so a future edit can't silently re-introduce a browser→node ping that
 *    would leak the user's IP to third-party node operators.
 *
 * 2. The rotator still classifies WHY a REAL RPC call failed (HTTP / timeout /
 *    network) for its own diagnostics — that machinery (used by call()/
 *    callMany()) is unchanged.
 *
 * Static source scan (endpoints.ts pulls $app/environment, unresolvable in the
 * smoke runner, so we assert on source rather than importing).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const read = (p: string): string => readFileSync(join(webRoot, p), 'utf8');

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

console.log('\nendpoint-error-classify smoke:\n');

const endpoints = read('src/lib/net/endpoints.ts');
const list = read('src/lib/components/EndpointList.svelte');

// ─── 1. PRIVACY: the browser never probes RPC nodes ─────────────────────────
check(
	'the browser-side probe warmup() has been REMOVED from the rotator',
	!/\basync\s+warmup\s*\(/.test(endpoints) && !/\.warmup\s*\(/.test(endpoints)
);
check(
	'EndpointList does NOT call the rotator to probe nodes (no getRotator / warmup)',
	!/getRotator/.test(list) && !/warmup/.test(list)
);
check(
	'EndpointList makes NO direct fetch to a node (no fetch( / EndpointRotator use)',
	!/\bfetch\s*\(/.test(list) && !/EndpointRotator/.test(list)
);
check(
	'EndpointList shows node health from the INDEXER (getRpcEndpoints → loadHealth)',
	/import \{ getRpcEndpoints \}/.test(list) &&
		/function loadHealth/.test(list) &&
		/getRpcEndpoints\(\)/.test(list)
);
check(
	'healthStatus derives cooling-down / unreachable / latency from indexer health',
	/function healthStatus/.test(list) &&
		/cooldown_ms > 0/.test(list) &&
		/settings\.endpoints\.cooling_down/.test(list) &&
		/consecutive_failures > 0/.test(list) &&
		/settings\.endpoints\.unreachable/.test(list) &&
		/latency_ms/.test(list)
);
check(
	'the pool list renders indexer-derived status per node, informational-only (cp410 — no custom-endpoint management)',
	/healthStatus\(h\)/.test(list) &&
		/sortedEndpoints/.test(list) &&
		!/saveEndpoints|resetEndpoints|refreshRotator|addEndpoint|removeEndpoint/.test(list)
);
check(
	'the refresh button re-fetches the indexer (not a browser probe)',
	/onclick=\{\(\) => void loadHealth\(\)\}/.test(list)
);

// ─── 2. The rotator still classifies REAL-call failures ─────────────────────
check(
	'EndpointStat carries lastErrorKind',
	/lastErrorKind:\s*'http'\s*\|\s*'timeout'\s*\|\s*'network'\s*\|\s*null/.test(endpoints)
);
check('classifyEndpointError is exported', /export function classifyEndpointError\(/.test(endpoints));
check(
	"classify maps AbortError / timeout to kind 'timeout'",
	/AbortError'|timed out|timeout|aborted/.test(endpoints) &&
		/kind:\s*'timeout',\s*code:\s*null/.test(endpoints)
);
check(
	"classify falls back to kind 'network' (DNS/offline/TLS/CORS — indistinguishable)",
	/return\s*\{\s*kind:\s*'network',\s*code:\s*null\s*\}/.test(endpoints)
);
check(
	'the REAL-call path (call/callMany) classifies failures via classifyEndpointError',
	/const cls = classifyEndpointError\(/.test(endpoints)
);

// ─── i18n keys the card still uses exist in en ──────────────────────────────
const en = JSON.parse(read('src/lib/i18n/locales/en.json')) as {
	settings: { endpoints: Record<string, string> };
};
check(
	'en has settings.endpoints.unreachable + cooling_down + probing',
	typeof en.settings.endpoints.unreachable === 'string' &&
		typeof en.settings.endpoints.cooling_down === 'string' &&
		typeof en.settings.endpoints.probing === 'string'
);

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} endpoint-error-classify scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
