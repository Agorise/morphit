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
 *   3. those keys exist with full parity across all 10 locales.
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

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
