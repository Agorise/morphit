/**
 * faq-deeplink-smoke — every footer / in-app link that points at a specific
 * FAQ article must reference a REAL FAQ key, and the shared scroll must land
 * reliably (cp343b).
 *
 * Two failure modes this guards:
 *   1. A deep link (`/faq?q=<key>` or `/faq#<key>`) whose <key> is not in
 *      FAQ_KEYS — the deep-link handler can't find an entry, so it silently
 *      falls through to "treat as a search query" and never scrolls/expands.
 *      A renamed or typo'd article key would break the link with no error.
 *   2. The shared scrollToEntry landing SHORT on a long article low on a
 *      freshly-mounted page (the footer "API" → wallet_developer_api bug):
 *      the first smooth scroll fires before layout settles. scrollToEntry now
 *      does a settle-and-correct re-align; this pins that so it can't regress
 *      back to a single best-effort scroll.
 *
 * Usage (from apps/web): tsx scripts/faq-deeplink-smoke.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (...p: string[]): string => readFileSync(join(root, ...p), 'utf-8');

// ── Real FAQ keys ────────────────────────────────────────────────────────────
const idx = read('src', 'lib', 'utils', 'faqIndex.ts');
const m = idx.match(/export const FAQ_KEYS = \[([\s\S]*?)\] as const/);
const FAQ_KEYS = new Set(m ? [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]) : []);

// Structural FAQ anchors / placeholders that are NOT articles (ignore).
//  - faqpage: the JSON-LD FAQPage @id anchor
//  - faq:     a bare /faq link with no article
//  - unknown: the "/faq#unknown-key" no-op example in a code comment
const NON_ARTICLE_ANCHORS = new Set(['faqpage', 'faq', 'unknown']);

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean): void {
	checks++;
	console.log(cond ? `  ✓ ${name}` : `  ✗ ${name}`);
	if (!cond) failures++;
}

check('FAQ_KEYS parsed from faqIndex.ts', FAQ_KEYS.size > 50);

// ── Walk .svelte files and validate every literal FAQ deep-link key ──────────
function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry.startsWith('.')) continue;
			walk(full, out);
		} else if (entry.endsWith('.svelte')) {
			out.push(full);
		}
	}
}
const files: string[] = [];
walk(join(root, 'src', 'routes'), files);
walk(join(root, 'src', 'lib', 'components'), files);

// Two link forms exist in the codebase:
//   A) direct string:         lp('/faq#KEY') / href="/faq?q=KEY"  → "/faq#KEY", "/faq?q=KEY"
//   B) lp() wrapper + suffix:  {lp('/faq')}?q=KEY  (footer API/AGPL) → "/faq')}?q=KEY"
// Form B is the one the footer "API" and "AGPL-3.0" links use, and the one a
// naive /faq(?:\?q=|#) regex misses — so it must be matched explicitly.
const linkPatterns = [
	/\/faq(?:\?q=|#)([a-z0-9_]+)/g,
	/\/faq'\)\}(?:\?q=|#)([a-z0-9_]+)/g
];
const found: { key: string; file: string }[] = [];
for (const f of files) {
	const src = readFileSync(f, 'utf-8');
	const rel = f.replace(root + '/', '');
	for (const re of linkPatterns) {
		for (const mm of src.matchAll(re)) {
			const key = mm[1];
			if (NON_ARTICLE_ANCHORS.has(key)) continue;
			found.push({ key, file: rel });
		}
	}
}
check('found FAQ deep links to validate', found.length > 0);

const broken = found.filter((d) => !FAQ_KEYS.has(d.key));
for (const b of broken) {
	console.log(`      BROKEN: ${b.file} → /faq…${b.key} (not a FAQ key)`);
}
check(
	`all ${found.length} FAQ deep-link keys resolve to a real article`,
	broken.length === 0
);

// Spot-check the two footer links Ken cares about are present + valid.
check(
	'footer API deep link → wallet_developer_api (a real key)',
	found.some((d) => d.key === 'wallet_developer_api') && FAQ_KEYS.has('wallet_developer_api')
);

// ── scrollToEntry must do the settle-and-correct re-align ────────────────────
const faq = read('src', 'lib', 'components', 'FaqSearch.svelte');
check(
	'scrollToEntry re-aligns after a settle timeout (corrective scroll)',
	/setTimeout\([\s\S]*?getBoundingClientRect\(\)\.top[\s\S]*?\}, \d+\)/.test(faq)
);
check(
	"scrollToEntry still lands on card top (block: 'start')",
	/scrollIntoView\(\{[^}]*block:\s*'start'/.test(faq)
);

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} faq-deeplink scenarios passed (${found.length} deep links validated)`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
