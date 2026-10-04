/**
 * personal-name-deny-smoke.
 *
 * The public tree (shipped source, tests, scripts, ops and docs: everything
 * but private/ and build output, see lib/public-tree-scan.ts) must not carry:
 *   - any term of the maintainer's private term list (private/deny-terms.json,
 *     never published, not even hashed). Some terms may appear in the files
 *     the list names for them. Without the list (a public clone) this check is
 *     skipped and the run says so;
 *   - an AI assistant credited or addressed ("Claude", "Anthropic"). Naming
 *     the AI product Morphit integrates with (the MCP client "Claude Desktop"
 *     and its config path, crawler user agents, a list of agents) is fine.
 *     This check always runs.
 *
 *   tsx scripts/personal-name-deny-smoke.ts
 *   MORPHIT_NAME_SCAN_ROOT=<other tree> tsx scripts/personal-name-deny-smoke.ts
 *   MORPHIT_DENY_TERMS=<file> …   (a term list other than private/deny-terms.json)
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	NO_DENY_TERMS,
	loadDenyTerms,
	looksBinary,
	normWord,
	publicTextFiles,
	words
} from './lib/public-tree-scan';

const REPO = join(__dirname, '..');
const ROOT = resolve(process.env.MORPHIT_NAME_SCAN_ROOT ?? REPO);
const SELF = 'scripts/personal-name-deny-smoke.ts';

const TERMS = loadDenyTerms(REPO);
const WORDS = new Map(TERMS?.words.map((w, i) => [w, `private term (words #${i + 1})`]) ?? []);
/** Words allowed only in the files the list names for them. */
const ALLOWED_IN = new Map(
	TERMS?.allowedIn.map((a, i) => [
		a.word,
		{ what: `private term (allowedIn #${i + 1})`, files: a.files }
	]) ?? []
);
const CASED = new Map(
	TERMS?.wordsCased.map((w, i) => [w, `private term (wordsCased #${i + 1})`]) ?? []
);
const HOSTS = new Map(TERMS?.hosts.map((w, i) => [w, `private term (hosts #${i + 1})`]) ?? []);
const ADDRESSES = new Map(
	TERMS?.addresses.map((w, i) => [w, `private term (addresses #${i + 1})`]) ?? []
);
const HOST = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi;
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;

const AI_VENDOR = /\bAnthropic\b/i;
const AI_NAME = /\bClaude\b/i;
/** Where an AI product is named as a product Morphit works with. */
const AI_PRODUCT_CONTEXT =
	/Claude[ -]?(?:Desktop|Bot|Web)\b|Application Support\/Claude\/|%APPDATA%\\Claude\\|ChatGPT|Grok|Cursor|Cline|Perplexity/;

const wordHit = (word: string, rel: string): string | undefined => {
	const n = normWord(word);
	const allowed = ALLOWED_IN.get(n);
	return WORDS.get(n) ?? (allowed && !allowed.files.has(rel) ? allowed.what : undefined);
};

const files = publicTextFiles(ROOT, new Set([SELF]));
const hits: string[] = [];
for (const rel of files) {
	for (const w of words(rel)) {
		const what = wordHit(w, rel);
		if (what) hits.push(`${rel}: ${what} in the file name`);
	}
	const buf = readFileSync(join(ROOT, rel));
	if (looksBinary(buf)) continue;
	buf
		.toString('utf8')
		.split('\n')
		.forEach((line, i) => {
			const at = `${rel}:${i + 1}`;
			const seen = new Set<string>();
			const note = (what: string | undefined): void => {
				if (what && !seen.has(what)) {
					seen.add(what);
					hits.push(`${at}: ${what}`);
				}
			};
			if (TERMS) {
				for (const w of words(line)) note(wordHit(w, rel));
				// Whole words only: a cased term inside a camelCase word is another word.
				for (const m of line.matchAll(/[\p{L}\p{N}]+/gu)) note(CASED.get(m[0]));
				for (const m of line.matchAll(HOST)) note(HOSTS.get(m[0].toLowerCase()));
				for (const m of line.matchAll(IPV4)) note(ADDRESSES.get(m[0]));
			}
			if (AI_VENDOR.test(line) || (AI_NAME.test(line) && !AI_PRODUCT_CONTEXT.test(line)))
				hits.push(`${at}: an AI assistant credited or addressed`);
		});
}

if (files.length < 1000) {
	console.log(`✗ scanned only ${files.length} files under ${ROOT} — wrong root?`);
	process.exit(1);
}
if (!TERMS) console.log(NO_DENY_TERMS);
if (hits.length > 0) {
	for (const h of hits.slice(0, 200)) console.log(`  ✗ ${h}`);
	if (hits.length > 200) console.log(`  … and ${hits.length - 200} more`);
	console.log(`✗ ${hits.length} personal-term or AI-credit line(s) in ${files.length} files`);
	process.exit(1);
}
console.log(
	TERMS
		? `✓ all ${files.length} files free of the private terms and AI credits`
		: `✓ all ${files.length} files free of AI credits (private terms not checked)`
);
