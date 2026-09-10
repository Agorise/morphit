/**
 * orderbook-lang-filter-smoke — pins the timeapp language-filter fixes (v1.16.14):
 *   1. resolveOrderbookLangFilter() falls back to EMPTY (all languages), NOT the
 *      UI locale — browsing in Italian must not auto-hide non-Italian orders, and
 *      the hidden filter re-appeared on every refresh.
 *   2. It still honors an explicit saved/chain preference before the empty fallback.
 *   3. The orderbook re-fetch $effect tracks langFilter, so deleting a chip refreshes.
 *   4. The seed uses the new helper (not resolvePreferredLangs' UI-locale fallback).
 * Structural (source-read) because preferredLangs.ts imports the $app alias, which
 * a standalone tsx smoke can't resolve.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const prefSrc = readFileSync(join(root, 'src', 'lib', 'stores', 'preferredLangs.ts'), 'utf8');
const obSrc = readFileSync(join(root, 'src', 'routes', '[lang]', 'orderbook', '+page.svelte'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) pass++;
	else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

const helperM = /export function resolveOrderbookLangFilter\([\s\S]*?\n}/.exec(prefSrc);
const helper = helperM ? helperM[0] : '';
check('resolveOrderbookLangFilter exists', helper.length > 0);
check('honors a saved local preference first', /readLocalPreferredLangs\(\)/.test(helper));
check('honors an on-chain preference next', /clean\(chainLangs\)/.test(helper));
check('final fallback is EMPTY (return []), NOT the UI locale', /return \[\];\s*}$/.test(helper) && !/uiLocale/.test(helper));

const effectM = /Re-fetch when any filter changes[\s\S]{0,400}?scheduleRefetch\(\);/.exec(obSrc);
check('re-fetch effect tracks langFilter (deleting a chip refreshes)', /langFilter/.test(effectM ? effectM[0] : ''));
check('seed uses resolveOrderbookLangFilter (no UI-locale fallback)', /langFilter = resolveOrderbookLangFilter\(/.test(obSrc));

if (fail === 0) {
	console.log(`\u2713 all ${pass} orderbook-lang-filter checks passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} orderbook-lang-filter checks FAILED`);
	process.exit(1);
}
