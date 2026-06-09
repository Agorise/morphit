/**
 * RssFeedPicker wiring smoke.
 *
 * The 3-format RSS feature (RSS 2.0 / Atom / JSON) is offered on
 * three surfaces — the footer worldwide feed, the per-asset
 * orderbook feed, and the per-trader profile feed — all via one
 * shared RssFeedPicker component. This smoke pins that wiring so a
 * future refactor can't silently drop a surface, break a base
 * path, or leave a copied-toast i18n key dangling:
 *
 *   1. each surface imports AND uses <RssFeedPicker base=...>
 *      with the correct feed base path (no .xml suffix — the
 *      picker appends the extension per chosen format),
 *   2. the picker references all eight rss.* i18n keys,
 *   3. those keys exist with full parity across all 10 locales,
 *   4. (cp229) Head.svelte emits all three feed MIME types and the
 *      home + orderbook pages advertise all three formats via
 *      <link rel="alternate"> auto-discovery.
 *
 * Usage (from apps/web):
 *   tsx scripts/rss-feed-picker-wiring-smoke.ts
 */
import fs from 'node:fs';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function read(path: string): string {
	return fs.readFileSync(path, 'utf-8');
}

// Derive the locale set from the files on disk rather than hardcoding
// it — keeps a single source of truth (locale-source-of-truth-smoke
// forbids inlining the canonical locale list) and auto-tracks any
// locale added later.
const LOCALES_DIR = 'src/lib/i18n/locales';
const LOCALES = fs
	.readdirSync(LOCALES_DIR)
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.replace(/\.json$/, ''))
	.sort();
const RSS_KEYS = [
	'choose_format',
	'format_rss2',
	'format_atom',
	'format_json',
	'copied_rss2',
	'copied_atom',
	'copied_json',
	'copy_failed'
];

const PICKER = 'src/lib/components/RssFeedPicker.svelte';

// Surface file + the base path string we expect to see passed to the picker.
const SURFACES: { file: string; baseNeedle: string; label: string }[] = [
	{
		file: 'src/routes/[lang]/+layout.svelte',
		baseNeedle: 'base="/rss/orderbook"',
		label: 'footer worldwide feed'
	},
	{
		file: 'src/routes/[lang]/orderbook/+page.svelte',
		baseNeedle: '/rss/orderbook/by-asset/',
		label: 'per-asset orderbook feed'
	},
	{
		file: 'src/routes/[lang]/[x+40][account=account]/+page.svelte',
		baseNeedle: '/rss/orderbook/by-account/@',
		label: 'per-trader profile feed'
	}
];

console.log('\n── RssFeedPicker wiring ────────────────────────────');

for (const s of SURFACES) {
	scenario(`${s.label}: imports + uses RssFeedPicker with correct base`, () => {
		const src = read(s.file);
		if (!src.includes("import RssFeedPicker from '$components/RssFeedPicker.svelte'")) {
			throw new Error(`${s.file}: missing RssFeedPicker import`);
		}
		if (!src.includes('<RssFeedPicker')) {
			throw new Error(`${s.file}: RssFeedPicker not used`);
		}
		if (!src.includes(s.baseNeedle)) {
			throw new Error(`${s.file}: expected base path containing ${JSON.stringify(s.baseNeedle)}`);
		}
		// Must NOT hand the picker an extension — it appends .xml/.atom/.json itself.
		if (/base=\{?[`"'][^`"']*\.(xml|atom|json)[`"']/.test(src)) {
			throw new Error(`${s.file}: picker base must not include a file extension`);
		}
	});
}

scenario('RssFeedPicker references all 8 rss.* keys', () => {
	const src = read(PICKER);
	for (const k of RSS_KEYS) {
		if (!src.includes(`rss.${k}`)) {
			throw new Error(`picker does not reference rss.${k}`);
		}
	}
});

scenario('all 8 rss.* keys exist with full parity across 10 locales', () => {
	for (const lang of LOCALES) {
		const data = JSON.parse(read(`src/lib/i18n/locales/${lang}.json`)) as {
			rss?: Record<string, string>;
		};
		const rss = data.rss;
		if (!rss) throw new Error(`${lang}: missing top-level "rss" namespace`);
		for (const k of RSS_KEYS) {
			if (typeof rss[k] !== 'string' || rss[k]!.length === 0) {
				throw new Error(`${lang}: rss.${k} missing or empty`);
			}
		}
		const extra = Object.keys(rss).filter((k) => !RSS_KEYS.includes(k));
		if (extra.length > 0) {
			throw new Error(`${lang}: unexpected rss keys ${JSON.stringify(extra)}`);
		}
	}
});

scenario('format-name keys are the same proper nouns in every locale', () => {
	// RSS 2.0 / Atom / JSON are proper nouns — identical everywhere.
	const expect: Record<string, string> = {
		format_rss2: 'RSS 2.0',
		format_atom: 'Atom',
		format_json: 'JSON'
	};
	for (const lang of LOCALES) {
		const rss = (JSON.parse(read(`src/lib/i18n/locales/${lang}.json`)) as { rss: Record<string, string> })
			.rss;
		for (const [k, v] of Object.entries(expect)) {
			if (rss[k] !== v) throw new Error(`${lang}: rss.${k} should be ${JSON.stringify(v)}, got ${JSON.stringify(rss[k])}`);
		}
	}
});

// ── Head <link rel="alternate"> auto-discovery (cp229) ──────────────
// Separate from the on-page RssFeedPicker: feed readers and SEO
// crawlers probe <head> for rel="alternate" links.  Head.svelte
// emits one per entry in its `feeds` prop.  The picker surfaces all
// three formats interactively; the <head> must advertise all three
// statically too, or a reader landing on the page only auto-discovers
// RSS and misses Atom / JSON.  Pin both the Head emission and the
// call sites so a refactor can't silently drop a format.
const HEAD = 'src/lib/components/Head.svelte';
const HEAD_PAGES: { file: string; label: string }[] = [
	{ file: 'src/routes/[lang]/+page.svelte', label: 'homepage' },
	{ file: 'src/routes/[lang]/orderbook/+page.svelte', label: 'orderbook page' }
];

scenario('Head.svelte advertises all 3 feed MIME types', () => {
	const src = read(HEAD);
	// type union accepts json
	if (!/type\?:\s*'rss'\s*\|\s*'atom'\s*\|\s*'json'/.test(src)) {
		throw new Error("Head.svelte feeds type union must include 'json'");
	}
	// emission maps each format to the Content-Type the indexer serves
	for (const mime of ['application/rss+xml', 'application/atom+xml', 'application/feed+json']) {
		if (!src.includes(mime)) {
			throw new Error(`Head.svelte does not emit ${mime}`);
		}
	}
});

for (const p of HEAD_PAGES) {
	scenario(`${p.label}: <Head> advertises all 3 feed formats`, () => {
		const src = read(p.file);
		if (!src.includes('feeds={[')) {
			throw new Error(`${p.file}: no feeds={[…]} passed to <Head>`);
		}
		// RSS (default type — no explicit type needed), Atom, JSON.
		if (!src.includes('/rss/orderbook.xml')) {
			throw new Error(`${p.file}: missing RSS feed (/rss/orderbook.xml)`);
		}
		if (!(src.includes('/rss/orderbook.atom') && src.includes("type: 'atom'"))) {
			throw new Error(`${p.file}: missing Atom feed (/rss/orderbook.atom, type: 'atom')`);
		}
		if (!(src.includes('/rss/orderbook.json') && src.includes("type: 'json'"))) {
			throw new Error(`${p.file}: missing JSON Feed (/rss/orderbook.json, type: 'json')`);
		}
	});
}

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
