/**
 * libsodium-not-in-baseline-closure-smoke.ts
 *
 * Byte-budget invariant (cp267 — memory Priority #4, TINY FOOTPRINT):
 *
 *   libsodium-wrappers-sumo is ~1 MB (the WASM is inlined into the JS,
 *   no separate .wasm). It must NEVER appear in the STATIC import
 *   closure of the shared layouts, because everything in a layout's
 *   closure is `<link rel="modulepreload">`-ed on EVERY page (home,
 *   orderbook, …) — including pages that never touch crypto.
 *
 *   Before cp267 it WAS in the baseline. `[lang]/+layout.svelte` reached
 *   it two ways:
 *     1. → $stores/identity → $crypto/keystore + $crypto/keygen, which
 *        did `import sodium from 'libsodium-wrappers-sumo'` at top level.
 *     2. → $lib/trades/tradeEventListener → $lib/chat/crypto (same
 *        static libsodium import).
 *   Measured per-page baseline was 59 chunks / 1358 KB, of which 1040 KB
 *   was libsodium. cp267 fixed it:
 *     - keygen.ts + keystore.ts now `import { sodium } from './sodium'`,
 *       a lazy holder populated by a DYNAMIC `import()` inside
 *       ensureSodium(). The sodium.* call sites are byte-for-byte
 *       unchanged (ESM live binding).
 *     - tradeEventListener.ts dynamically `import()`s chat/crypto inside
 *       its event handler instead of importing it statically.
 *   Baseline dropped to 357 KB; libsodium is now a lazy chunk that loads
 *   only when crypto actually runs (unlock / onboarding "Create" / chat /
 *   import).
 *
 * This smoke walks the layout STATIC import graph as text (no build, no
 * runtime, no transpile) and FAILS if libsodium re-enters it — e.g.
 * someone adds a component to +layout that statically pulls a crypto
 * module, or reverts keygen/keystore to a static libsodium import. It
 * also pins the specific mechanisms so a regression yields a precise
 * message rather than a mysterious +1 MB.
 *
 * OUT OF SCOPE: route-specific closures (chat, onboarding/import,
 * settings/yubikey) MAY still statically pull libsodium — that is "what
 * those pages legitimately need". This smoke guards only the every-page
 * BASELINE (the shared layouts).
 *
 * Runner cwd is apps/web (see scripts/run-smokes.sh), so all paths are
 * relative to apps/web.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LIB = 'libsodium-wrappers-sumo';

// Mirror of svelte.config.js → kit.alias. Kept small + local on
// purpose; if an alias is renamed there, the closure walk simply won't
// resolve through it and the (still-correct) baseline measurement in
// the build remains the backstop.
const ALIAS: Record<string, string> = {
	$lib: 'src/lib',
	$components: 'src/lib/components',
	$crypto: 'src/lib/crypto',
	$i18n: 'src/lib/i18n',
	$stores: 'src/lib/stores',
	$utils: 'src/lib/utils',
	$net: 'src/lib/net',
	$blurt: 'src/lib/blurt',
	$indexer: 'src/lib/indexer',
	$seo: 'src/lib/seo',
	$prices: 'src/lib/prices'
};

function resolveSpec(spec: string, fromFile: string): string | null {
	let base: string | null = null;
	if (spec.startsWith('$')) {
		const seg = spec.split('/');
		const a = ALIAS[seg[0]];
		if (!a) return null;
		base = join(a, ...seg.slice(1));
	} else if (spec.startsWith('.')) {
		base = join(dirname(fromFile), spec);
	} else {
		return null; // bare node_modules specifier — not a source file we walk
	}
	for (const ext of ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js']) {
		const f = base + ext;
		if (existsSync(f) && statSync(f).isFile()) return f;
	}
	return null;
}

/**
 * Static `import ... from '...'`, side-effect `import '...'`, and
 * `export ... from '...'` specifiers. EXCLUDES `import type` (erased at
 * build) and dynamic `import(...)` (the whole point — those don't pull
 * the module into the static closure).
 */
function staticImportSpecs(file: string): string[] {
	let src = readFileSync(file, 'utf8');
	// strip block + line comments so commented-out imports don't count
	src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	const specs: string[] = [];
	// `import\s+` requires whitespace after `import`, so `import(` (dynamic)
	// never matches.
	const reImport = /^\s*import\s+(?:type\s+)?(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
	let m: RegExpExecArray | null;
	while ((m = reImport.exec(src))) {
		const line = src.slice(m.index, reImport.lastIndex);
		if (/^\s*import\s+type\b/.test(line)) continue;
		specs.push(m[1]);
	}
	const reExport = /^\s*export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/gm;
	while ((m = reExport.exec(src))) specs.push(m[1]);
	return specs;
}

/** If libsodium is reachable via static imports from `entry`, returns
 *  the import chain (entry → … → importer); otherwise null. */
function findLibsodiumChain(entry: string): string[] | null {
	const seen = new Set<string>();
	const parent: Record<string, string> = {};
	let hit: string | null = null;
	(function walk(file: string) {
		if (hit || seen.has(file)) return;
		seen.add(file);
		let specs: string[];
		try {
			specs = staticImportSpecs(file);
		} catch {
			return;
		}
		for (const s of specs) {
			if (s === LIB) {
				hit = file;
				return;
			}
			const r = resolveSpec(s, file);
			if (!r) continue;
			if (!parent[r]) parent[r] = file;
			walk(r);
		}
	})(entry);
	if (!hit) return null;
	const chain = [hit];
	let c: string = hit;
	while (parent[c] && chain.length < 40) {
		chain.push(parent[c]);
		c = parent[c];
	}
	return chain.reverse();
}

const failures: string[] = [];
let scenarios = 0;

// (1)(2) The shared layouts' static closures must NOT reach libsodium.
for (const layout of ['src/routes/[lang]/+layout.svelte', 'src/routes/+layout.svelte']) {
	scenarios++;
	if (!existsSync(layout)) {
		failures.push(`layout not found: ${layout}`);
		continue;
	}
	const chain = findLibsodiumChain(layout);
	if (chain) {
		failures.push(
			`${LIB} is in the STATIC import closure of ${layout} → it would modulepreload on EVERY page.\n` +
				`      chain: ${chain.join('\n             -> ')}\n` +
				`      Fix: lazy-load libsodium via $crypto/sodium inside the crypto module, or dynamically import() the offending module.`
		);
	}
}

// (3) The lazy loader must use a DYNAMIC import (not static).
{
	scenarios++;
	const f = 'src/lib/crypto/sodium.ts';
	if (!existsSync(f)) {
		failures.push(`${f} missing — it is the single lazy libsodium loader.`);
	} else {
		const src = readFileSync(f, 'utf8');
		const hasDynamic = new RegExp(`import\\(\\s*['"]${LIB}['"]`).test(src);
		const hasStatic = new RegExp(`^\\s*import\\s+[^;]*\\sfrom\\s+['"]${LIB}['"]`, 'm').test(src);
		if (!hasDynamic) failures.push(`${f} must load ${LIB} via a dynamic import() (lazy).`);
		if (hasStatic)
			failures.push(`${f} must NOT statically import ${LIB} — that defeats the lazy load.`);
	}
}

// (4)(5) keygen/keystore must route through ./sodium, never a direct
// static libsodium import.
for (const f of ['src/lib/crypto/keygen.ts', 'src/lib/crypto/keystore.ts']) {
	scenarios++;
	if (!existsSync(f)) {
		failures.push(`${f} missing`);
		continue;
	}
	const src = readFileSync(f, 'utf8');
	if (new RegExp(`^\\s*import\\s+[^;]*\\sfrom\\s+['"]${LIB}['"]`, 'm').test(src)) {
		failures.push(
			`${f} statically imports ${LIB} — it must \`import { sodium } from './sodium'\` instead (cp267).`
		);
	}
}

// (6) tradeEventListener runs from +layout, so it must dynamically
// import chat/crypto (which pulls libsodium), never statically.
{
	scenarios++;
	const f = 'src/lib/trades/tradeEventListener.ts';
	if (!existsSync(f)) {
		failures.push(`${f} missing`);
	} else {
		const specs = staticImportSpecs(f);
		if (specs.some((s) => s === '$lib/chat/crypto' || /(^|\/)chat\/crypto$/.test(s))) {
			failures.push(
				`${f} statically imports chat/crypto — it must dynamically import() it; it runs from +layout, so a static import drags libsodium into the every-page baseline.`
			);
		}
	}
}

if (failures.length) {
	console.error('✗ libsodium-not-in-baseline-closure-smoke FAILED:');
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}

console.log(
	`✓ all ${scenarios} byte-budget invariants hold: libsodium stays out of the every-page baseline closure (lazy via $crypto/sodium; chat/crypto dynamically imported in tradeEventListener)`
);
