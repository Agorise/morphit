#!/usr/bin/env tsx
/**
 * Regression smoke: explorer internal links must be language-prefixed.
 *
 * The `morphitExplorer{Block,Tx,Account}Url()` helpers in
 * `$lib/explorer/urls.ts` return BARE app-relative paths (e.g.
 * `/explorer/block/123`) with NO `/[lang]/` segment — by design, so the
 * locale layer (`lp()` = `localePath(path, currentLang)`) can apply the
 * current language (and its default-locale rules). A bare path routed
 * straight into `href=` or `goto()` does NOT match the `[lang]/explorer/…`
 * routes and 404s.
 *
 * This guards against the beta.28 field bug where "Previous block", the
 * block's tx list, and the tx page's block link used the helper output
 * directly (`href={morphitExplorerBlockUrl(n) ?? '#'}`) and dead-ended on
 * a dark 404. The fix routes every one through `lp(...)`. This smoke fails
 * if any explorer surface ever again feeds a helper result straight into
 * `href=`/`goto()` without `lp()`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

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
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

// Surfaces that link into the explorer with the helper functions.
const SURFACES = [
	'apps/web/src/routes/[lang]/explorer/block/[num=blocknum]/+page.svelte',
	'apps/web/src/routes/[lang]/explorer/tx/[id=trxid]/+page.svelte',
	'apps/web/src/routes/[lang]/explorer/account/[name=account]/+page.svelte',
	'apps/web/src/routes/[lang]/explorer/+page.svelte',
	'apps/web/src/lib/components/ChatMessage.svelte'
];

// The buggy shapes: a helper call sitting DIRECTLY inside href={…} or goto(…).
// (The correct form passes the result through a variable and lp(), so the
//  helper name never appears immediately after `href={` or `goto(`.)
const RAW_HREF = /href=\{\s*morphitExplorer(?:Block|Tx|Account)Url\s*\(/;
const RAW_GOTO = /goto\(\s*morphitExplorer(?:Block|Tx|Account)Url\s*\(/;

console.log('\n── explorer-link-lang-prefix smoke ──────────────────────\n');

for (const rel of SURFACES) {
	scenario(`${rel.split('/').slice(-2).join('/')}: no raw helper in href=/goto( (must use lp)`, () => {
		const src = readFileSync(join(REPO, rel), 'utf8');
		const hit = RAW_HREF.exec(src) ?? RAW_GOTO.exec(src);
		assert(
			hit === null,
			`found a langless explorer link — route the helper through lp(): ${hit ? hit[0] : ''}…`
		);
	});
}

// Contract check: the helpers themselves stay locale-agnostic (bare paths),
// so the lp() layering above is the correct place for the language segment.
scenario('urls.ts helpers return bare /explorer/ paths (locale applied by lp, not the helper)', () => {
	const src = readFileSync(join(REPO, 'apps/web/src/lib/explorer/urls.ts'), 'utf8');
	for (const ret of [
		"return `/explorer/tx/${trxId.toLowerCase()}`;",
		'return `/explorer/account/${account}`;',
		'return `/explorer/block/${blockNumber}`;'
	]) {
		assert(src.includes(ret), `expected bare-path return missing/changed: ${ret}`);
	}
	// And they must NOT have started injecting a language segment themselves.
	assert(
		!/\/explorer\/[^`]*\$\{(?:lang|locale|currentLang)\}/.test(src) &&
			!/return `\/\$\{lang\}\/explorer/.test(src),
		'a helper now injects its own language segment — that double-prefixes once lp() runs'
	);
});

console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
