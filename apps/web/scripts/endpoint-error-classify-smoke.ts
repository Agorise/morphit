/**
 * endpoint-error-classify-smoke (cp346)
 *
 * Pins the "show WHY an RPC node is failing" wiring on the settings endpoint
 * panel. Before cp346 a non-HTTP failure (timeout / network / CORS) showed only
 * a failure count; now the rotator classifies the error and the panel renders a
 * reason. This guards both halves:
 *   - endpoints.ts: an EndpointStat.lastErrorKind field, a classifyEndpointError
 *     that maps HTTP→'http'(+code), AbortError/timeout→'timeout', else→'network',
 *     and — critically — the warmup() catch (the panel's probe path) capturing
 *     it instead of swallowing the error.
 *   - EndpointList.svelte: statusLabel branching on lastErrorKind to the right
 *     i18n key (timed_out / unreachable / http_error).
 *   - the two new i18n keys exist in en.
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

check('EndpointStat carries lastErrorKind', /lastErrorKind:\s*'http'\s*\|\s*'timeout'\s*\|\s*'network'\s*\|\s*null/.test(endpoints));
check('classifyEndpointError is exported', /export function classifyEndpointError\(/.test(endpoints));
check(
	"classify maps an HTTP status to kind 'http' with its code",
	/\/\^HTTP \(\\d\{3\}\)\\b\//.test(endpoints) && /kind:\s*'http',\s*code:\s*Number\(httpMatch\[1\]\)/.test(endpoints)
);
check(
	"classify maps AbortError / timeout to kind 'timeout'",
	/AbortError'|timed out|timeout|aborted/.test(endpoints) && /kind:\s*'timeout',\s*code:\s*null/.test(endpoints)
);
check(
	"classify falls back to kind 'network' (DNS/offline/TLS/CORS — indistinguishable)",
	/return\s*\{\s*kind:\s*'network',\s*code:\s*null\s*\}/.test(endpoints)
);
check(
	'warmup() (the settings-panel probe path) captures+classifies instead of swallowing the error',
	/async warmup\(\)/.test(endpoints) &&
		/classifyEndpointError\(err instanceof Error/.test(endpoints) &&
		!/}\s*catch\s*\{\s*\n\s*target\.consecutiveFailures\+\+;\s*\n\s*\}/.test(endpoints)
);

// EndpointList renders the reason.
const list = read('src/lib/components/EndpointList.svelte');
check(
	"EndpointList shows 'timed out' for a timeout",
	/lastErrorKind === 'timeout'/.test(list) && /settings\.endpoints\.timed_out/.test(list)
);
check(
	"EndpointList shows 'unreachable' for a network failure",
	/lastErrorKind === 'network'/.test(list) && /settings\.endpoints\.unreachable/.test(list)
);
check(
	"EndpointList still shows the HTTP code for an HTTP failure",
	/lastErrorKind === 'http'/.test(list) && /settings\.endpoints\.http_error/.test(list)
);

// The two new keys exist (parity across locales is enforced by i18n-locale-parity).
const en = JSON.parse(read('src/lib/i18n/locales/en.json')) as {
	settings: { endpoints: Record<string, string> };
};
check(
	'en has settings.endpoints.timed_out + unreachable',
	typeof en.settings.endpoints.timed_out === 'string' &&
		typeof en.settings.endpoints.unreachable === 'string'
);

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} endpoint-error-classify scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
