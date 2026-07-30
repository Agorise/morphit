/**
 * smoke-tsconfig-alias-parity — cp448.
 *
 * The SvelteKit `$`-aliases are PER-APP.  `$blurt` and `$indexer` name
 * DIFFERENT directories in the web app vs. the indexer:
 *
 *     web     $blurt   → apps/web/src/lib/blurt     (getBlurtClient, sign, apr…)
 *     indexer $blurt   → apps/indexer/src/blurt     (BlurtClient type, verify…)
 *     web     $indexer → apps/web/src/lib/indexer   (getInstance, profileCache…)
 *     indexer $indexer → apps/indexer/src/indexer   (poller, dispatcher…)
 *
 * `scripts/run-smokes.sh` ran EVERY smoke under the repo-root
 * `tsconfig.smoke.json`, whose flat `paths` map can only send `$blurt`/`$indexer`
 * to one place (the indexer).  Under that map, a web smoke that `import()`s a web
 * module using `$blurt/*` silently bound the INDEXER's module — e.g. importing a
 * file that does `import { getBlurtClient } from '$blurt/client'` resolved to the
 * indexer's client.ts (no such export) and died with a confusing error.  Fourteen
 * web source files import `$blurt/*` and survived only because no smoke happened to
 * load them; the workaround was relative imports (`../src/lib/blurt/*`) guarded by
 * ad-hoc greps.  cp448 gives apps/web its own `tsconfig.smoke.json` (resolving the
 * web aliases to WEB) and teaches run-smokes.sh to prefer a workspace-local smoke
 * config; this smoke pins that arrangement so it can't silently regress:
 *
 *   1. FUNCTIONAL, the strongest guard — this file STATICALLY imports through
 *      `$blurt/*` and `$indexer/*`.  Because it runs under apps/web's own smoke
 *      config, those must resolve to WEB.  If someone reverts the web config's
 *      `$blurt`/`$indexer` to the indexer, tsx can't even load this smoke (the
 *      import throws) and run-smokes.sh reports the failure.  The assertions make
 *      the intent explicit: the resolved symbols are WEB's.
 *   2. apps/web/tsconfig.smoke.json exists and its `$`-alias paths MATCH the
 *      runtime aliases in svelte.config.js (Vite's source of truth) — so the smoke
 *      config can never drift from what the app actually resolves at build time.
 *   3. The repo-root tsconfig.smoke.json still maps `$blurt`/`$indexer` to the
 *      INDEXER (matching apps/indexer/tsconfig.json) — proving the two configs are
 *      correctly SEPARATED, not accidentally unified onto one meaning.
 *   4. run-smokes.sh prefers a workspace-local `tsconfig.smoke.json` over the root
 *      one — the routing that makes (1) actually take effect in the battery.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// (1) FUNCTIONAL guard — resolves via apps/web/tsconfig.smoke.json (this smoke's
// own config).  A static import so a broken web config fails to LOAD this file.
import { getBlurtClient } from '$blurt/client';
import { getInstance } from '$indexer/client';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
function read(rel: string): string {
	return readFileSync(join(repo, rel), 'utf8');
}

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failures++;
	}
}

// JSONC → JSON via a string-aware scanner: strips // and /* */ comments while
// preserving anything inside string literals.  A naive regex would corrupt path
// values like "blurt/*" or "src/**/*.ts" (the `/*` inside them is not a comment).
function parseJsonc(text: string): any {
	let out = '';
	let inStr = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const n = text[i + 1];
		if (inStr) {
			out += c;
			if (c === '\\') {
				out += text[++i]; // copy the escaped char verbatim
			} else if (c === '"') {
				inStr = false;
			}
			continue;
		}
		if (c === '"') {
			inStr = true;
			out += c;
			continue;
		}
		if (c === '/' && n === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			out += '\n';
			continue;
		}
		if (c === '/' && n === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
			i++; // skip the closing '/'
			continue;
		}
		out += c;
	}
	return JSON.parse(out);
}
function tsPaths(rel: string): Record<string, string[]> {
	return parseJsonc(read(rel)).compilerOptions?.paths ?? {};
}
// Extract the `alias: { $x: 'path', … }` block from svelte.config.js.
function svelteAliases(): Record<string, string> {
	const src = read('apps/web/svelte.config.js');
	const block = /alias:\s*\{([\s\S]*?)\}/.exec(src);
	const out: Record<string, string> = {};
	if (!block) return out;
	for (const m of block[1].matchAll(/(\$[A-Za-z0-9_]+)\s*:\s*'([^']+)'/g)) {
		out[m[1]] = m[2];
	}
	return out;
}

// ─── 1. FUNCTIONAL: the web aliases resolved to WEB at load time ───────────────
check(
	"`$blurt/client` resolves to WEB's blurt (getBlurtClient is a function)",
	typeof getBlurtClient === 'function',
	`got typeof getBlurtClient = ${typeof getBlurtClient}`
);
check(
	"`$indexer/client` resolves to WEB's indexer (getInstance is a function)",
	typeof getInstance === 'function',
	`got typeof getInstance = ${typeof getInstance}`
);
// Transitive: a real web module that imports `$blurt/*` loads without binding the
// indexer's copy (the exact break cp448 fixes).
let transitiveOk = false;
try {
	await import('../src/lib/chat/chainVerify.ts');
	transitiveOk = true;
} catch (e) {
	transitiveOk = false;
}
check(
	'a web module importing `$blurt/*` (chat/chainVerify.ts) loads under the web config',
	transitiveOk
);

// ─── 2. apps/web/tsconfig.smoke.json matches svelte.config.js aliases ──────────
const webSmoke = tsPaths('apps/web/tsconfig.smoke.json');
const aliases = svelteAliases();
check('apps/web/tsconfig.smoke.json defines a paths block', Object.keys(webSmoke).length > 0);
// Every svelte.config.js alias pointing at src/lib/* must be present, same target,
// with both the bare (`$x`) and wildcard (`$x/*`) forms.
let driftDetail = '';
let allMatch = true;
for (const [alias, aliasPath] of Object.entries(aliases)) {
	if (!aliasPath.startsWith('src/lib/')) continue; // only the src/lib aliases
	const bare = webSmoke[alias];
	const star = webSmoke[`${alias}/*`];
	const bareOk = Array.isArray(bare) && bare[0] === aliasPath;
	const starOk = Array.isArray(star) && star[0] === `${aliasPath}/*`;
	if (!bareOk || !starOk) {
		allMatch = false;
		driftDetail += `${alias}: svelte='${aliasPath}' smoke='${bare?.[0]}'/'${star?.[0]}'  `;
	}
}
check(
	'web smoke config paths match svelte.config.js aliases (no drift)',
	allMatch,
	driftDetail
);
// The two that were the actual bug — spell them out so a regression is unmistakable.
check(
	"web smoke config: `$blurt` → src/lib/blurt (WEB, not the indexer)",
	webSmoke['$blurt/*']?.[0] === 'src/lib/blurt/*'
);
check(
	"web smoke config: `$indexer` → src/lib/indexer (WEB, not the indexer)",
	webSmoke['$indexer/*']?.[0] === 'src/lib/indexer/*'
);

// ─── 3. root tsconfig.smoke.json keeps `$blurt`/`$indexer` → the INDEXER ───────
const rootSmoke = tsPaths('tsconfig.smoke.json');
check(
	"root smoke config: `$blurt` → apps/indexer/src/blurt (separation preserved)",
	rootSmoke['$blurt/*']?.[0] === 'apps/indexer/src/blurt/*'
);
check(
	"root smoke config: `$indexer` → apps/indexer/src/indexer (separation preserved)",
	rootSmoke['$indexer/*']?.[0] === 'apps/indexer/src/indexer/*'
);
// …and that matches the indexer's OWN tsconfig meaning (baseUrl ./src → blurt/*).
const idxPaths = tsPaths('apps/indexer/tsconfig.json');
check(
	"the indexer's own tsconfig maps `$blurt` → blurt/* (what the root smoke mirrors)",
	idxPaths['$blurt/*']?.[0] === 'blurt/*'
);

// ─── 4. run-smokes.sh prefers a workspace-local tsconfig.smoke.json ────────────
const runner = read('scripts/run-smokes.sh');
check(
	'run-smokes.sh prefers $dir/tsconfig.smoke.json when present',
	/if \[ -f "\$repo\/\$dir\/tsconfig\.smoke\.json" \]/.test(runner)
);
check(
	'run-smokes.sh still falls back to the root tsconfig.smoke.json',
	/elif \[ -f "\$repo\/tsconfig\.smoke\.json" \]/.test(runner)
);

// ─── 5. sanity: web source really does import these aliases (smoke stays real) ─
function countAliasImporters(alias: string): number {
	// crude but sufficient: number of web src files whose text imports from $alias/
	try {
		const out = execSync(
			`grep -rl "from '\\${alias}/" ${join(repo, 'apps/web/src')} --include="*.ts" || true`,
			{ encoding: 'utf8' }
		);
		return out.split('\n').filter(Boolean).length;
	} catch {
		return 0;
	}
}
check(
	'web source still imports `$blurt/*` (this guard is protecting real files)',
	countAliasImporters('$blurt') > 0
);

const scenarios = 12;
console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} smoke-tsconfig-alias-parity scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} smoke-tsconfig-alias-parity scenarios failed`);
	process.exit(1);
}
