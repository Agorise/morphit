#!/usr/bin/env tsx
/**
 * Smoke: forbidden-character policy consistency across handlers.
 *
 * The injection-resistant character policy (reject/strip control,
 * bidi-override, isolate, zero-width, line/paragraph-separator, and
 * invisible word-joiner/math codepoints) is DELIBERATELY duplicated
 * per handler — the handlers are self-contained on purpose, so each
 * carries its own copy rather than importing a shared constant.
 *
 * The cost of that decision is drift: before cp232 the copies had
 * silently diverged into three variants (the most-exposed user-facing
 * reject regexes were missing U+2028/U+2029 and U+2060-U+2064, which
 * operatorPaymentMethod and operatorBlock partially had). This smoke
 * is the enforcement that keeps them in lockstep from now on: if
 * anyone edits one copy and forgets the others, this fails.
 *
 * It also pins the DELIBERATE exclusions: the bidi MARKS U+200E (LRM),
 * U+200F (RLM), and U+061C (ALM) must NOT be blocked — Morphit ships a
 * Farsi locale and RTL users legitimately use these to fix mixed-
 * direction rendering. Only the dangerous OVERRIDE (U+202A-202E) and
 * ISOLATE (U+2066-2069) bidi chars are blocked.
 *
 * Pure source-text + behavioural assertions; no DB, no chain.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const handlersDir = join(here, '..', 'src', 'indexer', 'handlers');

/** The canonical regex literal every reject/strip policy must use. */
const CANONICAL_LITERAL = String.raw`/[\u0000-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/`;

/** Handlers whose policy is a REJECT regex (no flags), `= CANONICAL;`. */
const REJECT_FILES = [
	'order.ts',
	'orderReplace.ts',
	'feedback.ts',
	'feedbackResponse.ts',
	'profile.ts',
	'operatorRegister.ts'
];

/** operatorBlock keeps a Set (its sanitize loop strips C0/C1, so those
 *  are NOT in the Set); it must hold every OTHER dangerous codepoint. */
const OPERATOR_BLOCK_REQUIRED_CODEPOINTS = [
	0x200b, 0x200c, 0x200d, // zero-width
	0x2028, 0x2029, // line/paragraph separators
	0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner + invisible math
	0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi overrides
	0x2066, 0x2067, 0x2068, 0x2069, // bidi isolates
	0xfeff // BOM / ZWNBSP
];

let passed = 0;
let failed = 0;
const fail = (m: string): void => {
	console.error('  \u2717 ' + m);
	failed++;
};
const ok = (): void => {
	passed++;
};

const read = (f: string): string => readFileSync(join(handlersDir, f), 'utf8');

// 1. Every reject handler carries the canonical literal, no flags.
for (const f of REJECT_FILES) {
	const src = read(f);
	if (src.includes(CANONICAL_LITERAL + ';')) ok();
	else fail(`${f}: forbidden-char reject regex is missing or has drifted from canonical`);
}

// 2. operatorPaymentMethod strips with the canonical literal + global flag.
{
	const src = read('operatorPaymentMethod.ts');
	if (src.includes(CANONICAL_LITERAL + 'g;')) ok();
	else fail('operatorPaymentMethod.ts: strip regex is missing /g or has drifted from canonical');
}

// 3. operatorBlock's Set holds every non-C0/C1 dangerous codepoint.
{
	const src = read('operatorBlock.ts');
	const m = src.match(/FORBIDDEN_REASON_CODEPOINTS\s*=\s*new Set<number>\(\[([\s\S]*?)\]\)/);
	if (!m) {
		fail('operatorBlock.ts: FORBIDDEN_REASON_CODEPOINTS set not found');
	} else {
		const have = new Set<number>();
		for (const hit of m[1].toLowerCase().matchAll(/0x([0-9a-f]+)/g)) {
			have.add(parseInt(hit[1], 16));
		}
		const missing = OPERATOR_BLOCK_REQUIRED_CODEPOINTS.filter((cp) => !have.has(cp));
		if (missing.length === 0) ok();
		else fail(`operatorBlock.ts: Set missing ${missing.map((c) => '0x' + c.toString(16)).join(', ')}`);
	}
}

// 4. Behavioural sanity on the canonical class itself.
{
	const re = new RegExp(CANONICAL_LITERAL.slice(1, -1)); // strip the bounding slashes

	// 4a. MUST block every dangerous representative codepoint.
	const mustBlock = [
		0x0000, 0x001f, 0x007f, 0x009f, 0x200b, 0x2028, 0x2029, 0x2060, 0x2064, 0x202a,
		0x202e, 0x2066, 0x2069, 0xfeff
	];
	for (const cp of mustBlock) {
		if (re.test(String.fromCodePoint(cp))) ok();
		else fail(`canonical class fails to block U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
	}

	// 4b. MUST NOT block legitimate RTL bidi marks (Farsi/Arabic/Hebrew) or ordinary text.
	const mustAllow: Record<string, string> = {
		'U+200C ZWNJ': '\u200c',
		'U+200D ZWJ': '\u200d',
		'U+200E LRM': '\u200e',
		'U+200F RLM': '\u200f',
		'U+061C ALM': '\u061c',
		'Latin A': 'A',
		'Hebrew alef': '\u05d0',
		'Arabic alef': '\u0627'
	};
	for (const [name, ch] of Object.entries(mustAllow)) {
		if (!re.test(ch)) ok();
		else fail(`canonical class wrongly blocks ${name} — RTL users need this`);
	}
}

const total = passed + failed;
console.log('\u2500'.repeat(54));
if (failed === 0) {
	console.log(`\u2713 all ${total} forbidden-char-consistency scenarios passed`);
} else {
	console.log(`\u2717 ${failed}/${total} forbidden-char-consistency scenarios failed`);
	process.exit(1);
}
