#!/usr/bin/env tsx
/**
 * Morphit — RPC User-Agent smoke.
 *
 * Ken's sysadmin runs a public Blurt RPC node and asked us to stop looking like
 * an anonymous bot: Node's built-in fetch sends `user-agent: node` (verified on
 * Node 22, NOT the `node-fetch/1.0` he guessed), which every unnamed Node
 * service sends and which trips bot-traps — it names a runtime, not an
 * application, and leaves an operator nobody to contact. So every outbound
 * request names Morphit and carries a contact URL.
 *
 * HISTORY: the indexer once installed a GLOBAL fetch wrapper to reach dblurt,
 * whose ClientOptions had no header field. dblurt 0.17.0 added a native
 * `userAgent` option, so the wrapper was RETIRED and every call site names
 * itself. This smoke guards both that the named call sites keep their UA AND
 * (the regression guard, check 8) that no raw `fetch(` anywhere in the indexer
 * is left anonymous — the CI-time replacement for the wrapper's runtime
 * catch-all. The relay talks to nodes only through dblurt, so it identifies
 * itself purely via that native option (checks 13–14).
 *
 * Two things regress silently:
 *   1. The version must come from INDEXER_VERSION / the relay VERSION. A
 *      hardcoded "1.7.x" would sail past version-consistency-smoke and announce
 *      a stale version to every node operator forever.
 *   2. A NEW raw fetch added without a UA would be anonymous — check 8 fails it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string): string =>
	s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) { pass++; console.log(`  \u2713 ${name}`); }
	else { fail++; console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const ua = strip(read('apps/indexer/src/blurt/userAgent.ts'));
const main = strip(read('apps/indexer/src/main.ts'));
const client = strip(read('apps/indexer/src/blurt/client.ts'));
const health = strip(read('apps/indexer/src/api/health.ts'));
const rpcHealth = strip(read('apps/indexer/src/api/rpcHealth.ts'));
const relayUa = strip(read('apps/relay/src/blurt/userAgent.ts'));
const relayClient = strip(read('apps/relay/src/blurt/client.ts'));
const relayHealth = strip(read('apps/relay/src/api/health.ts'));

check(
	'1 the indexer User-Agent names Morphit and carries a contact URL',
	/return `Morphit\/\$\{version\} \(\+\$\{CONTACT_URL\}\)`;/.test(ua),
	'"+contact" is the part that makes it useful — an operator needs somewhere to shout'
);
check(
	'2 the contact is the project source, not a personal address',
	/const CONTACT_URL = 'https:\/\/git\.agorise\.net\/agorise\/morphit';/.test(ua),
	'Morphit is federated — node operator and instance operator are rarely the same person'
);
check(
	'3 the UA string carries no hardcoded version literal',
	!/Morphit\/1\.[0-9]+\.[0-9]+/.test(ua),
	'a hardcoded version would dodge the 19-touchpoint smoke and announce a stale version forever'
);
check(
	'4 INDEXER_VERSION is exported (single source of truth)',
	/export const INDEXER_VERSION = '[0-9]+\.[0-9]+\.[0-9]+';/.test(health)
);
check(
	'5 the global-fetch wrapper is RETIRED (not defined in userAgent.ts, not called in main)',
	!/installMorphitUserAgent/.test(ua) &&
		!/installMorphitUserAgent/.test(main) &&
		!/globalThis\.fetch\s*=/.test(ua),
	'dblurt native userAgent + explicit headers replaced it; check 8 is the CI guard that took over'
);
check(
	'6 the rpcHealth probe names itself (the last indexer fetch that lacked a UA)',
	/'user-agent': morphitUserAgent\(INDEXER_VERSION\)/.test(rpcHealth),
	'a 403 from a bot-trap is otherwise indistinguishable from a real node outage'
);
check(
	'7 the federation + signup-anomaly probes still name themselves',
	/'user-agent': 'morphit-indexer\/federation-probe'/.test(
		strip(read('apps/indexer/src/indexer/federationProbe.ts'))
	) &&
		/'user-agent': 'morphit-indexer\/signup-anomaly-probe'/.test(
			strip(read('apps/indexer/src/indexer/signupAnomalyProbe.ts'))
		)
);

// ── Check 8: regression guard — no raw fetch() in the indexer is anonymous ──
const rawFetchRe = /(?<![.\w])fetch\(/;
const uaMarkerRe = /user-agent|priceUpstreamHeaders|morphitUserAgent/i;
const anonymous: string[] = [];
function walk(dir: string): void {
	for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		const rel = join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules') continue;
			walk(rel);
		} else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
			const src = strip(read(rel));
			if (rawFetchRe.test(src) && !uaMarkerRe.test(src)) anonymous.push(rel);
		}
	}
}
walk('apps/indexer/src');
check(
	'8 no raw fetch() in the indexer is anonymous (the CI guard that replaced the wrapper)',
	anonymous.length === 0,
	anonymous.length ? `anonymous raw fetch (no UA marker) in: ${anonymous.join(', ')}` : ''
);

check(
	'9 the direct batch fetch names itself explicitly',
	/'user-agent': morphitUserAgent\(INDEXER_VERSION\)/.test(client),
	'this call site is ours; it keeps working now that the global wrapper is gone'
);
check(
	'10 the shared price/fx header helper sets a user-agent',
	/user-agent/i.test(strip(read('apps/indexer/src/indexer/price/priceFetchUtil.ts'))),
	'priceUpstreamHeaders() is what the price + fx fetchers use to name themselves'
);
check(
	'11 the web app does NOT import a UA module',
	!/userAgent/.test(strip(read('apps/web/src/lib/blurt/client.ts'))),
	'changing a browser User-Agent is impossible and a fingerprinting risk'
);
check(
	'12 the indexer dblurt Client passes the native userAgent option (0.17.0)',
	/new Client\(url, \{ timeout: 10_000, userAgent: morphitUserAgent\(INDEXER_VERSION\) \}\)/.test(client),
	'dblurt native userAgent means dblurt traffic identifies itself without the wrapper'
);
check(
	'13 the relay dblurt Client passes the native userAgent option',
	/new Client\(url, \{ timeout: 10_000, userAgent: morphitUserAgent\(VERSION\) \}\)/.test(relayClient),
	'the relay was anonymous before this; its only outbound RPC is the dblurt Client'
);
check(
	'14 the relay UA names Morphit + contact URL, version from the exported relay VERSION',
	/return `Morphit\/\$\{version\} \(\+\$\{CONTACT_URL\}\)`;/.test(relayUa) &&
		/const CONTACT_URL = 'https:\/\/git\.agorise\.net\/agorise\/morphit';/.test(relayUa) &&
		!/Morphit\/1\.[0-9]+\.[0-9]+/.test(relayUa) &&
		/export const VERSION = '[0-9]+\.[0-9]+\.[0-9]+';/.test(relayHealth),
	'same shape as the indexer so an operator allowlist matching Morphit/ catches both'
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} rpc-user-agent checks passed`);
else { console.error(`\u2717 ${fail} of ${pass + fail} rpc-user-agent checks FAILED`); process.exit(1); }
