/**
 * box-identity-statement-smoke.
 *
 * No public file may tie a person to a named instance box, or put a named
 * instance box on one line with a word from the maintainer's private term
 * list (private/deny-terms.json, boxLineWords). Without that list (a public
 * clone) the second check is skipped and the run says so.
 *
 * Scans every text file of the public tree (lib/public-tree-scan.ts: no
 * node_modules, build output or private/), release notes and docs included.
 *
 *   tsx scripts/box-identity-statement-smoke.ts            (this tree)
 *   MORPHIT_SCAN_ROOT=<other tree> tsx scripts/…           (another tree)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	NO_DENY_TERMS,
	loadDenyTerms,
	looksBinary,
	normWord,
	publicTextFiles
} from './lib/public-tree-scan';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(process.env.MORPHIT_SCAN_ROOT ?? REPO);
const TEXT =
	/\.(?:ts|mts|mjs|js|cjs|svelte|sh|ya?ml|j2|json|md|txt|conf|service|timer|env|example|py)$/;
const SELF = 'scripts/box-identity-statement-smoke.ts';

const RULES: Array<[string, RegExp]> = [
	[
		'a person tied to a named instance box',
		/\b[A-Z][a-z]+\/morphit(?:ir|lat)\b|\bmaintainer(?:\/|\s+)morphit(?:ir|lat)\b/
	]
];
const NAMED_BOX = /\bmorphit(?:ir|lat)\b/i;
/** Words (normalised) from the private term list. */
const TERMS = loadDenyTerms(REPO);
const BOX_LINE_WORDS = new Set(TERMS?.boxLineWords ?? []);
const boxLineHasPrivateWord = (line: string): boolean =>
	NAMED_BOX.test(line) &&
	[...line.matchAll(/\p{L}+/gu)].some((m) => BOX_LINE_WORDS.has(normWord(m[0])));

const hits: string[] = [];
let scanned = 0;
for (const rel of publicTextFiles(ROOT, new Set([SELF]))) {
	if (!TEXT.test(rel)) continue;
	const buf = readFileSync(join(ROOT, rel));
	if (looksBinary(buf)) continue;
	scanned++;
	buf
		.toString('utf8')
		.split('\n')
		.forEach((line, i) => {
			for (const [what, re] of RULES) if (re.test(line)) hits.push(`${rel}:${i + 1}: ${what}`);
			if (boxLineHasPrivateWord(line))
				hits.push(`${rel}:${i + 1}: a named instance box on one line with a private term`);
		});
}

if (scanned < 100) {
	console.log(`✗ scanned only ${scanned} files under ${ROOT} — wrong root?`);
	process.exit(1);
}
if (!TERMS) console.log(NO_DENY_TERMS);
if (hits.length > 0) {
	for (const h of hits) console.log(`  ✗ ${h}`);
	console.log(`✗ ${hits.length} box-identity statement(s) in shipped files`);
	process.exit(1);
}
console.log(`✓ all ${scanned} scanned files are free of box-identity statements`);
