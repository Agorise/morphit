#!/usr/bin/env tsx
/**
 * Morphit — RPC User-Agent smoke (v1.7.7, t.txt #3).
 *
 * Ken's sysadmin runs a public Blurt RPC node and asked us to stop looking like
 * an anonymous bot. We were sending `user-agent: node` — verified against Node
 * 22, NOT the `node-fetch/1.0` he guessed — which is what every unnamed Node
 * service on the internet sends. It names a runtime, not an application, and
 * leaves an operator nobody to contact when our traffic misbehaves.
 *
 * Two things here are easy to regress silently:
 *   1. The wrapper must be installed BEFORE any RPC client is built. dblurt
 *      captures nothing at construction, but the batch fetch and price feed fire
 *      early — a wrapper installed after them tags nothing and no test notices.
 *   2. The version must come from INDEXER_VERSION. Hardcoding "1.7.5" in the UA
 *      string would sail past the version-consistency smoke (which pins the 19
 *      known touchpoints) and we would announce a stale version to every node
 *      operator on the network, forever.
 */
import { readFileSync } from 'node:fs';
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

check(
	'1 the User-Agent names Morphit and carries a contact URL',
	/return `Morphit\/\$\{version\} \(\+\$\{CONTACT_URL\}\)`;/.test(ua),
	'"+contact" is the part that makes it useful — an operator needs somewhere to shout'
);
check(
	'2 the contact is the project source, not a personal address',
	/const CONTACT_URL = 'https:\/\/git\.agorise\.net\/agorise\/morphit';/.test(ua),
	'Morphit is federated — the node operator and the instance operator are rarely the same person'
);
check(
	'3 the version comes from INDEXER_VERSION, never a literal',
	/installMorphitUserAgent\(INDEXER_VERSION\)/.test(main) &&
		!/Morphit\/1\.[0-9]+\.[0-9]+/.test(ua),
	'a hardcoded version here would dodge the 19-touchpoint smoke and announce a stale version forever'
);
check(
	'4 INDEXER_VERSION is exported (single source of truth)',
	/export const INDEXER_VERSION = '[0-9]+\.[0-9]+\.[0-9]+';/.test(health)
);
check(
	'5 the wrapper is installed at the TOP of main(), before any RPC client',
	/async function main\(\): Promise<void> \{\s*installMorphitUserAgent\(INDEXER_VERSION\);/.test(main),
	'dblurt captures nothing at construction, but the batch fetch and price feed fire early'
);
check(
	'6 it only ever ADDS a header — a caller that named itself keeps its name',
	/if \(!headers\.has\('user-agent'\)\) headers\.set\('user-agent', ua\);/.test(ua),
	'morphit-indexer/federation-probe is more useful in a node operator s log than a generic line'
);
check(
	'7 …and the existing probes still name themselves',
	/'user-agent': 'morphit-indexer\/federation-probe'/.test(
		strip(read('apps/indexer/src/indexer/federationProbe.ts'))
	) &&
		/'user-agent': 'morphit-indexer\/signup-anomaly-probe'/.test(
			strip(read('apps/indexer/src/indexer/signupAnomalyProbe.ts'))
		)
);
check(
	'8 a Request object keeps its own headers (merge, not overwrite)',
	/if \(input instanceof Request && init\?\.headers === undefined\) \{/.test(ua),
	'passing our Headers via init would silently drop the Request s own'
);
check(
	'9 the direct batch fetch names itself explicitly',
	/'user-agent': morphitUserAgent\(INDEXER_VERSION\)/.test(client),
	'this call site is ours; it should keep working if the global wrapper is ever moved or dropped'
);
check(
	'10 the wrapper is idempotent',
	/if \(installed\) return;\s*installed = true;/.test(ua)
);
check(
	'11 the web app does NOT import it',
	!/userAgent/.test(strip(read('apps/web/src/lib/blurt/client.ts'))),
	'changing a browser User-Agent is impossible and would be a fingerprinting risk'
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} rpc-user-agent checks passed`);
else { console.error(`\u2717 ${fail} of ${pass + fail} rpc-user-agent checks FAILED`); process.exit(1); }
