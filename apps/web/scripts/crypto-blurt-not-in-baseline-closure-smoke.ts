/**
 * crypto-blurt-not-in-baseline-closure-smoke.ts
 *
 * Byte-budget invariant (cp271 — memory Priority #4, TINY FOOTPRINT),
 * sibling to libsodium-not-in-baseline-closure-smoke.ts.
 *
 *   Three heavy things must NEVER appear in the STATIC import closure of
 *   the shared layouts (everything a layout statically imports is
 *   `<link rel="modulepreload">`-ed on EVERY page — home, orderbook, …):
 *
 *     1. @noble/secp256k1 + @scure/bip39  (~19 KB gzip combined)
 *        Elliptic-curve signing + mnemonic seed. keygen.ts imports them
 *        statically (it legitimately needs them for the sign/derive
 *        functions), and the baseline used to reach keygen two ways:
 *          • $stores/identity → keygen (toLiveIdentity/wipeLiveIdentity)
 *          • $stores/identity → $crypto/keystore → keygen
 *            (ensureSodium/Identity/KeyRole/KEY_ROLES)
 *        cp271 moved those bip39/secp-free symbols into $crypto/identity-
 *        core; identity store + keystore import from there now, so the
 *        baseline no longer reaches keygen and its elliptic crypto.
 *
 *     2. The Blurt client ($blurt/client / src/lib/blurt/client.ts,
 *        ~12.6 KB gzip with dblurt). The baseline reached it via
 *        $stores/release → $net/releaseFetch → $blurt/client. cp271 made
 *        the release store dynamically import() releaseFetch +
 *        releaseHashCheck inside initRelease() (which runs in the layout's
 *        onMount, not at first paint), so the client is a lazy chunk.
 *
 *   Measured home-page baseline: 64 chunks / 135 KB gzip → 60 / 111 KB.
 *
 * This smoke walks the layout STATIC import graph as text (no build, no
 * runtime, no transpile) and FAILS if any of the three re-enter it, plus
 * pins the specific cp271 mechanisms so a regression yields a precise
 * message rather than a mysterious +N KB.
 *
 * OUT OF SCOPE: route-specific closures (onboarding/import/settings,
 * chat, explorer) MAY statically pull keygen / the Blurt client — that is
 * what those pages legitimately need. This smoke guards only the
 * every-page BASELINE (the shared layouts).
 *
 * Runner cwd is apps/web (see scripts/run-smokes.sh).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Bare npm specifiers banned from the baseline closure.
const BANNED_BARE = ['@noble/secp256k1', '@scure/bip39', '@scure/bip39/wordlists/english'];
// Source modules banned from the baseline closure (resolved absolute).
const BANNED_FILE = resolve('src/lib/blurt/client.ts');

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
 * build) and dynamic `import(...)`.
 */
function staticImportSpecs(file: string): string[] {
	let src = readFileSync(file, 'utf8');
	src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	const specs: string[] = [];
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

/** If a banned bare specifier or banned file is reachable via static
 *  imports from `entry`, returns the import chain (entry → … → hit);
 *  otherwise null. */
function findBaselineLeak(entry: string): { what: string; chain: string[] } | null {
	const seen = new Set<string>();
	const parent: Record<string, string> = {};
	let hit: { what: string; file: string } | null = null;
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
			if (BANNED_BARE.includes(s)) {
				hit = { what: s, file };
				return;
			}
			const r = resolveSpec(s, file);
			if (!r) continue;
			if (resolve(r) === BANNED_FILE) {
				hit = { what: '$blurt/client', file: r };
				if (!parent[r]) parent[r] = file;
				// fall through to build chain to r
				const chain0 = [r];
				let c0: string = r;
				while (parent[c0] && chain0.length < 40) {
					chain0.push(parent[c0]);
					c0 = parent[c0];
				}
				hit = { what: '$blurt/client', file: r };
				(hit as unknown as { chain: string[] }).chain = chain0.reverse();
				return;
			}
			if (!parent[r]) parent[r] = file;
			walk(r);
		}
	})(entry);
	if (!hit) return null;
	const preChain = (hit as unknown as { chain?: string[] }).chain;
	if (preChain) return { what: hit.what, chain: preChain };
	const chain = [hit.file];
	let c: string = hit.file;
	while (parent[c] && chain.length < 40) {
		chain.push(parent[c]);
		c = parent[c];
	}
	return { what: hit.what, chain: chain.reverse() };
}

const failures: string[] = [];
let scenarios = 0;

// (1)(2) The shared layouts' static closures must NOT reach secp256k1 /
// bip39 / the Blurt client.
for (const layout of ['src/routes/[lang]/+layout.svelte', 'src/routes/+layout.svelte']) {
	scenarios++;
	if (!existsSync(layout)) {
		failures.push(`layout not found: ${layout}`);
		continue;
	}
	const leak = findBaselineLeak(layout);
	if (leak) {
		failures.push(
			`${leak.what} is in the STATIC import closure of ${layout} → it would modulepreload on EVERY page.\n` +
				`      chain: ${leak.chain.join('\n             -> ')}\n` +
				`      Fix (cp271): keep the baseline importing $crypto/identity-core (not keygen) and dynamically import() the Blurt-client / releaseFetch paths.`
		);
	}
}

// (3) identity-core is the lightweight module — it must NOT statically
// import bip39/secp256k1 (that would re-introduce the leak it exists to
// prevent), and it must not import keygen (cycle + bloat).
{
	scenarios++;
	const f = 'src/lib/crypto/identity-core.ts';
	if (!existsSync(f)) {
		failures.push(`${f} missing — it is the bip39/secp-free identity core that keeps the baseline lean (cp271).`);
	} else {
		const specs = staticImportSpecs(f);
		for (const bad of [...BANNED_BARE, '$crypto/keygen', './keygen']) {
			if (specs.includes(bad)) {
				failures.push(`${f} statically imports ${bad} — it must stay bip39/secp/keygen-free (cp271).`);
			}
		}
	}
}

// (4) The two baseline importers must route through identity-core, NEVER
// keygen (that is the cp271 redirect that removed secp256k1/bip39 from
// the baseline).
for (const f of ['src/lib/stores/identity.ts', 'src/lib/crypto/keystore.ts']) {
	scenarios++;
	if (!existsSync(f)) {
		failures.push(`${f} missing`);
		continue;
	}
	const specs = staticImportSpecs(f);
	if (specs.includes('$crypto/keygen') || specs.includes('./keygen')) {
		failures.push(
			`${f} statically imports keygen — it must import the lightweight $crypto/identity-core instead, or keygen's static bip39+secp256k1 re-enter the every-page baseline (cp271).`
		);
	}
}

// (5) The release store must NOT statically (value-)import releaseFetch /
// releaseHashCheck — both pull $blurt/client. They are dynamically
// imported inside initRelease() (onMount). `import type` is fine (erased).
{
	scenarios++;
	const f = 'src/lib/stores/release.ts';
	if (!existsSync(f)) {
		failures.push(`${f} missing`);
	} else {
		const specs = staticImportSpecs(f); // excludes import type
		for (const bad of ['$net/releaseFetch', '$net/releaseHashCheck']) {
			if (specs.includes(bad)) {
				failures.push(
					`${f} statically (value-)imports ${bad} — it pulls the Blurt client; import it dynamically inside initRelease() and keep only \`import type\` static (cp271).`
				);
			}
		}
		const hasDynFetch = /import\(\s*['"]\$net\/releaseFetch['"]/.test(readFileSync(f, 'utf8'));
		if (!hasDynFetch) {
			failures.push(`${f} must dynamically import('$net/releaseFetch') inside initRelease() (cp271).`);
		}
	}
}

// (6) AvatarMenu (rendered in the layout) must NOT statically import the
// sign-out/lock cleanup (explicitLock pulls chat/trade verifiers incl.
// condenser_api.get_transaction). It is dynamically imported in
// confirmLock() (an explicit user action, never first paint).
{
	scenarios++;
	const f = 'src/lib/components/AvatarMenu.svelte';
	if (!existsSync(f)) {
		failures.push(`${f} missing`);
	} else {
		const specs = staticImportSpecs(f);
		if (specs.some((s) => s === '$lib/chat/explicitLock' || /(^|\/)chat\/explicitLock$/.test(s))) {
			failures.push(
				`${f} statically imports $lib/chat/explicitLock — it pulls chat/trade cleanup (pubPin/tradeStatus/blurtVerify) onto the every-page baseline; dynamically import() it inside confirmLock() (cp271).`
			);
		}
	}
}

if (failures.length) {
	console.error('✗ crypto-blurt-not-in-baseline-closure-smoke FAILED:');
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}

console.log(
	`✓ all ${scenarios} byte-budget invariants hold: secp256k1/bip39 + the Blurt client stay out of the every-page baseline closure (identity-core split; releaseFetch/explicitLock dynamically imported)`
);
