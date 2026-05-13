/**
 * Morphit smoke — confusables-table parity (audit 2026-05 finding
 * 8-4).
 *
 * The confusables defense (Unicode skeleton mapping +
 * RESERVED_NAMES) is duplicated between the frontend
 * (apps/web/src/lib/crypto/confusables.ts) and the indexer
 * (apps/indexer/src/indexer/confusables.ts).  The headers on
 * both sides instruct: keep these synchronized.
 *
 * Drift creates a real attack surface: a homograph that
 * matches on one side but not the other lets an attacker pass
 * the more-permissive validator while the stricter one rejects
 * legitimate users.  This smoke asserts byte-equivalent
 * parity on both LETTER_EQUIVS and RESERVED_NAMES_RAW.
 *
 * String-extraction approach (not import) because the two
 * files compile under different tsconfig targets in their
 * respective workspaces.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

const repoRoot = resolve(__dirname, '../../..');
const indexerSrc = readFileSync(
	resolve(repoRoot, 'apps/indexer/src/indexer/confusables.ts'),
	'utf-8'
);
const webSrc = readFileSync(resolve(repoRoot, 'apps/web/src/lib/crypto/confusables.ts'), 'utf-8');

/** Extract LETTER_EQUIVS as a sorted Map of letter -> sorted
 *  codepoint list.  Tolerant of formatting differences
 *  (whitespace, comments, line breaks). */
function extractLetterEquivs(src: string): Map<string, number[]> {
	const m = src.match(/LETTER_EQUIVS[^=]*=\s*\{([\s\S]*?)\n\};/);
	if (!m) throw new Error('LETTER_EQUIVS block not found');
	const body = m[1]!;
	const out = new Map<string, number[]>();
	const letterRe = /([a-z\d-])\s*:\s*\[([\s\S]*?)\]/g;
	for (const lm of body.matchAll(letterRe)) {
		const letter = lm[1]!;
		const contents = lm[2]!;
		const codes = new Set<number>();
		const charRe = /'([^']+)'/g;
		for (const cm of contents.matchAll(charRe)) {
			const s = cm[1]!;
			if (s.startsWith('\\u') && s.length === 6) {
				codes.add(parseInt(s.substring(2), 16));
			} else if (s.length === 1) {
				codes.add(s.charCodeAt(0));
			}
		}
		out.set(
			letter,
			[...codes].sort((a, b) => a - b)
		);
	}
	return out;
}

function extractReservedNames(src: string): string[] {
	const m = src.match(/RESERVED_NAMES_RAW[^=]*=\s*\[([\s\S]*?)\];/);
	if (!m) throw new Error('RESERVED_NAMES_RAW block not found');
	const body = m[1]!;
	const names = new Set<string>();
	for (const cm of body.matchAll(/'([^']+)'/g)) {
		names.add(cm[1]!);
	}
	return [...names].sort();
}

console.log('\n── confusables-table parity smoke ────────────────────────\n');

scenario('LETTER_EQUIVS parity between indexer and web', () => {
	const a = extractLetterEquivs(indexerSrc);
	const b = extractLetterEquivs(webSrc);
	const allKeys = new Set([...a.keys(), ...b.keys()]);
	for (const k of allKeys) {
		const aList = a.get(k) ?? [];
		const bList = b.get(k) ?? [];
		if (aList.length !== bList.length || aList.some((v, i) => v !== bList[i])) {
			throw new Error(
				`drift on letter '${k}':\n  indexer: ${aList.map((c) => c.toString(16)).join(',')}\n  web    : ${bList.map((c) => c.toString(16)).join(',')}`
			);
		}
	}
});

scenario('RESERVED_NAMES_RAW parity between indexer and web', () => {
	const a = extractReservedNames(indexerSrc);
	const b = extractReservedNames(webSrc);
	if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
		throw new Error(
			`reserved-names drift:\n  indexer: ${a.join(', ')}\n  web    : ${b.join(', ')}`
		);
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
