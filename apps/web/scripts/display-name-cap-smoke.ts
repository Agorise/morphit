#!/usr/bin/env tsx
/**
 * display-name-cap-smoke (cp404).
 *
 * Ken set the display-name cap to 24 code points. This locks:
 *   - DISPLAY_NAME_MAX_LENGTH === 24,
 *   - validateDisplayName() rejects a 25-codepoint name and accepts 24,
 *   - capDisplayName() truncates legacy over-long names by CODE POINT
 *     (emoji count as one), leaving short names untouched,
 *   - profileProps runs stored display_name through the cap (so every
 *     order card / identity label renders inside the limit),
 *   - the too_long i18n message no longer says "40" in any locale.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	DISPLAY_NAME_MAX_LENGTH,
	capDisplayName,
	validateDisplayName
} from '../src/lib/crypto/profile';
import { extractLabelPropsFromProfile } from '../src/lib/indexer/profileProps';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

// 1. Cap constant.
if (DISPLAY_NAME_MAX_LENGTH === 24) ok('1 DISPLAY_NAME_MAX_LENGTH is 24');
else bad('1 cap constant', String(DISPLAY_NAME_MAX_LENGTH));

// 2. validateDisplayName rejects 25, accepts 24.
{
	const n25 = 'a'.repeat(25);
	const n24 = 'a'.repeat(24);
	const r25 = validateDisplayName(n25);
	const r24 = validateDisplayName(n24);
	if (!r25.ok && r25.reasonKey.includes('too_long')) ok('2 rejects a 25-codepoint name (too_long)');
	else bad('2 should reject 25', JSON.stringify(r25));
	if (r24.ok) ok('2b accepts a 24-codepoint name');
	else bad('2b should accept 24', JSON.stringify(r24));
}

// 3. capDisplayName truncates by code point.
{
	const long = 'x'.repeat(30);
	const capped = capDisplayName(long);
	if ([...capped].length === 24) ok('3 caps a 30-char name to 24 code points');
	else bad('3 cap length', `${[...capped].length}`);
}

// 4. Short names untouched; null/empty → ''.
{
	if (capDisplayName('Alice') === 'Alice') ok('4 leaves a short name untouched');
	else bad('4 short untouched');
	if (capDisplayName(null) === '' && capDisplayName('') === '') ok("4b null/empty → ''");
	else bad('4b empty guard');
}

// 5. Emoji count as one code point (astral pair not double-counted).
{
	// 24 emoji = 24 code points (48 UTF-16 units) — must NOT be truncated.
	const emoji = '\u{1F600}'.repeat(24);
	const capped = capDisplayName(emoji);
	if ([...capped].length === 24) ok('5 24 emoji (48 UTF-16 units) kept whole (code-point aware)');
	else bad('5 emoji cap', `${[...capped].length}`);
	// 30 emoji → truncated to 24.
	if ([...capDisplayName('\u{1F600}'.repeat(30))].length === 24) ok('5b 30 emoji → 24');
	else bad('5b emoji truncate');
}

// 6. profileProps caps a stored over-long display_name.
{
	const props = extractLabelPropsFromProfile({
		display_name: 'z'.repeat(50),
		json_metadata: null
	} as unknown as Parameters<typeof extractLabelPropsFromProfile>[0]);
	if (props.displayName && [...props.displayName].length === 24)
		ok('6 profileProps caps stored display_name to 24');
	else bad('6 profileProps cap', String(props.displayName));
}

// 7. No locale's too_long message still says "40".
{
	const dir = fileURLToPath(new URL('../src/lib/i18n/locales', import.meta.url));
	const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
	const offenders: string[] = [];
	for (const f of files) {
		const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf-8'));
		const msg: string | undefined = j?.profile?.display_name?.errors?.too_long;
		// "40" (ASCII) or "۴۰" (Persian) must be gone.
		if (msg && (msg.includes('40') || msg.includes('\u06F4\u06F0'))) offenders.push(f);
	}
	if (offenders.length === 0) ok(`7 no locale's too_long message says 40 (${files.length} locales)`);
	else bad('7 stale "40" in too_long', offenders.join(', '));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 display-name-cap smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} display-name-cap scenarios passed`);
