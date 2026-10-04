#!/usr/bin/env tsx
/**
 * i18n-never-translate-smoke.
 *
 * Standing translation rule: some words are
 * NEVER translated, transliterated or inflected in any locale:
 *
 *   - agorist / agorists / agorism — translate the rest of the phrase, keep
 *     these words English ("círculos de agorists", not "círculos agoristas");
 *   - the hashtags #agorism #freemarkets #countereconomics;
 *   - Blurt (never "بلرت", "Блерт", …);
 *   - the tokens WIF, BLT, blurtwallet.com and json — when the English string
 *     carries one, every locale's string must carry it too.
 *
 * Nothing guarded this, and the v1.19.0 files had "agoristas / agoristes /
 * Agoristen / agoristi / agorystów / агористов / آگوریست" in 15 strings, "بلرت"
 * in 9 fa strings, and a keyfile error that had dropped the
 * `morphit-keyfile-….json` file name in 9 locales.
 *
 * (Morphit itself is intentionally NOT checked here: fa renders the SITE brand
 * through the `{brand|مورفیت}` default form, so a transliteration there is the
 * designed behaviour — see docs/BRANDING.md.)
 *
 * Usage:
 *   cd apps/web && tsx scripts/i18n-never-translate-smoke.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LOC_DIR = join(import.meta.dirname, '..', 'src/lib/i18n/locales');

function flatten(d: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
	if (typeof d === 'string') {
		out.set(prefix, d);
		return out;
	}
	if (d === null || typeof d !== 'object') return out;
	for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
		flatten(v, prefix ? `${prefix}.${k}` : k, out);
	}
	return out;
}

const files = readdirSync(LOC_DIR)
	.filter((f) => f.endsWith('.json'))
	.sort();
const data = new Map<string, Map<string, string>>();
for (const f of files)
	data.set(f.slice(0, -5), flatten(JSON.parse(readFileSync(join(LOC_DIR, f), 'utf8'))));
const en = data.get('en')!;
const others = [...data.keys()].filter((l) => l !== 'en');

let scenarios = 0;
let failures = 0;
function check(name: string, problems: string[]): void {
	scenarios++;
	if (problems.length === 0) {
		console.log(`  ✓ ${name}`);
		return;
	}
	failures++;
	console.log(`  ✗ ${name} (${problems.length})`);
	for (const p of problems.slice(0, 20)) console.log(`      ${p}`);
	if (problems.length > 20) console.log(`      … and ${problems.length - 20} more`);
}

console.log('\ni18n-never-translate smoke:\n');

// 1. No inflected / translated / transliterated agorism word anywhere.
{
	const ALLOWED = new Set(['agorist', 'agorists', 'agorism', 'agorise', 'agorise’s', "agorise's"]);
	const problems: string[] = [];
	for (const [loc, strings] of data) {
		for (const [key, v] of strings) {
			for (const m of v.matchAll(/agor[iy]s\p{Script=Latin}*|агорис\p{L}*|آگوری\p{L}*/giu)) {
				const w = m[0].toLowerCase();
				if (!ALLOWED.has(w)) problems.push(`${loc} ${key}: "${m[0]}"`);
			}
		}
	}
	check('agorist / agorists / agorism are never inflected, translated or transliterated', problems);
}

// 2. Where English says agorist/agorism, every locale keeps the English word.
{
	const problems: string[] = [];
	for (const [key, ev] of en) {
		const words = new Set((ev.match(/\bagoris(?:ts?|m)\b/gi) ?? []).map((w) => w.toLowerCase()));
		for (const loc of others) {
			const lv = data.get(loc)!.get(key);
			if (lv === undefined) continue;
			for (const w of words) {
				// "agorist" is satisfied by "agorists"; fa may add a native plural suffix.
				const re = new RegExp(`${w.replace(/s$/, '')}`, 'i');
				if (!re.test(lv)) problems.push(`${loc} ${key}: English "${w}" missing`);
			}
		}
	}
	check('every locale keeps the English agorist/agorism word where English has it', problems);
}

// 3. Hashtags survive verbatim, same count.
{
	const problems: string[] = [];
	for (const tag of ['#agorism', '#freemarkets', '#countereconomics']) {
		for (const [key, ev] of en) {
			const n = ev.split(tag).length - 1;
			if (n === 0) continue;
			for (const loc of others) {
				const lv = data.get(loc)!.get(key);
				if (lv !== undefined && lv.split(tag).length - 1 !== n)
					problems.push(`${loc} ${key}: ${tag} ×${lv.split(tag).length - 1}, English ×${n}`);
			}
		}
	}
	check('#agorism / #freemarkets / #countereconomics are kept verbatim in every locale', problems);
}

// 4. Blurt is never transliterated.
{
	const problems: string[] = [];
	const RE = /بلرت|بلورت|Блерт|Блурт|Блёрт|布勒特|布拉特|布鲁特|布魯特/gu;
	for (const [loc, strings] of data)
		for (const [key, v] of strings)
			for (const m of v.matchAll(RE)) problems.push(`${loc} ${key}: "${m[0]}"`);
	check('Blurt is never transliterated', problems);
}

// 5. Technical tokens carried by English are carried by every locale.
{
	const problems: string[] = [];
	const TOKENS: Array<{ name: string; re: RegExp }> = [
		{ name: 'WIF', re: /\bWIF\b/ },
		{ name: 'BLT', re: /\bBLT\b/ },
		{ name: 'blurtwallet.com', re: /blurtwallet\.com/ },
		{ name: 'json', re: /json/i }
	];
	for (const { name, re } of TOKENS) {
		for (const [key, ev] of en) {
			if (!re.test(ev)) continue;
			for (const loc of others) {
				const lv = data.get(loc)!.get(key);
				if (lv !== undefined && !re.test(lv)) problems.push(`${loc} ${key}: "${name}" dropped`);
			}
		}
	}
	check('WIF / BLT / blurtwallet.com / json are kept wherever English has them', problems);
}

console.log('');
if (failures === 0) {
	console.log(`✓ all ${scenarios} i18n-never-translate scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failures} of ${scenarios} i18n-never-translate scenarios failed`);
process.exit(1);
