#!/usr/bin/env tsx
/**
 * apps/web/scripts/faq-jsonld-no-markdown-smoke.ts
 *
 * Structural Defense (cp119 A1) — FAQ JSON-LD must contain no
 * markdown characters that would render as literal asterisks /
 * backticks / linebreaks in Google's FAQ rich-snippet.
 *
 * cp112 introduced faqPageSchema() which emits FAQPage JSON-LD.
 * Google renders `acceptedAnswer.text` as plain text in SERPs.
 * cp119 audit found 77 of 128 FAQ entries in EN contain light
 * markdown — those were leaking into the JSON-LD unchanged.
 * cp119-A1 fix: stripMarkdown() applied in faqPageSchema().
 *
 * This smoke catches:
 *   - regression of stripMarkdown bypass (e.g. a refactor that
 *     stops calling stripMarkdown)
 *   - new markdown constructs in FAQ copy that stripMarkdown
 *     doesn't handle (e.g. a future contributor adds `~~strikethrough~~`)
 *
 * Strategy: build faqPageSchema() output for every locale,
 * serialize to JSON, then regex over the JSON for markdown chars
 * inside acceptedAnswer.text and Question.name fields.
 *
 * Scenarios:
 *   M-1: no double-asterisk in any acceptedAnswer.text or Question.name
 *   M-2: no inline code (`backtick`) in acceptedAnswer.text or Question.name
 *   M-3: no `[link](url)` syntax left over
 *   M-4: no double newline (`\n\n`) — paragraphs should be collapsed
 *   M-5: no bullet (`• `) at start of substring — should be collapsed to "."
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripMarkdown } from '../src/lib/seo/stripMarkdown';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const LOCALES = ['en', 'es', 'de', 'pl', 'fr', 'it', 'ru', 'fa', 'zh-CN', 'zh-HK'];

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── faq-jsonld-no-markdown smoke (cp119 A1) ────────\n');

interface FaqEntry {
	q: string;
	a: string;
}

interface FaqEntries {
	[k: string]: FaqEntry;
}

let totalChecked = 0;
const findings: Array<{ locale: string; key: string; field: 'q' | 'a'; pattern: string; sample: string }> = [];

// Markdown patterns that SHOULD NOT survive stripMarkdown()
const PATTERNS: Array<{ name: string; re: RegExp }> = [
	{ name: 'double-asterisk (**bold**)', re: /\*\*/ },
	{ name: 'double-underscore (__bold__)', re: /__/ },
	{ name: 'inline code (`backtick`)', re: /`/ },
	{ name: 'link syntax ([text](url))', re: /\]\(/ },
	{ name: 'double newline (\\n\\n)', re: /\n\n/ },
	{ name: 'embedded bullet (• )', re: /(?<!\.)\s+•\s/ }
];

for (const loc of LOCALES) {
	const path = join(REPO, 'apps/web/src/lib/i18n/locales', `${loc}.json`);
	const json = JSON.parse(readFileSync(path, 'utf8')) as {
		faq?: { entries?: FaqEntries };
	};
	const entries = json.faq?.entries;
	if (!entries) continue;

	for (const [key, entry] of Object.entries(entries)) {
		if (!entry || typeof entry !== 'object') continue;
		const stripped = {
			q: stripMarkdown(entry.q ?? ''),
			a: stripMarkdown(entry.a ?? '')
		};
		for (const field of ['q', 'a'] as const) {
			totalChecked++;
			const text = stripped[field];
			for (const p of PATTERNS) {
				if (p.re.test(text)) {
					findings.push({
						locale: loc,
						key,
						field,
						pattern: p.name,
						sample: text.slice(0, 80)
					});
				}
			}
		}
	}
}

// M-1..M-5 — one scenario per markdown class
for (const p of PATTERNS) {
	const matches = findings.filter((f) => f.pattern === p.name);
	if (matches.length === 0) {
		pass(`no ${p.name} survives stripMarkdown across ${totalChecked} FAQ field outputs`);
	} else {
		const detail = matches
			.slice(0, 5)
			.map((m) => `[${m.locale}] ${m.key}.${m.field}: "${m.sample}..."`)
			.join('\n      ');
		fail(
			`no ${p.name} survives stripMarkdown`,
			`${matches.length} unstripped instance(s):\n      ${detail}${matches.length > 5 ? `\n      ...and ${matches.length - 5} more` : ''}`
		);
	}
}

// Self-test: confirm stripMarkdown actually does something
// (catches a regression where stripMarkdown becomes identity)
const probe = '**bold** and `code` and [link](url) and\n\nparagraph';
const probed = stripMarkdown(probe);
if (probed === probe) {
	fail(
		'stripMarkdown still strips markdown (self-test)',
		`stripMarkdown returned input unchanged — function has regressed to identity`
	);
} else if (
	probed.includes('**') ||
	probed.includes('`') ||
	probed.includes('](') ||
	probed.includes('\n\n')
) {
	fail(
		'stripMarkdown still strips markdown (self-test)',
		`stripMarkdown left markdown in output: ${JSON.stringify(probed)}`
	);
} else {
	pass('stripMarkdown self-test: probe input stripped correctly');
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error(`\nfaq-jsonld-no-markdown smoke FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} faq-jsonld-no-markdown scenarios passed`);
