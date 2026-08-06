#!/usr/bin/env tsx
/**
 * apps/web/scripts/faq-glossary-terms-smoke.ts  (2026-07-19, Ken)
 *
 * FAQ answers now auto-link technical acronyms to the glossary: the first
 * STANDALONE occurrence of each term renders as a <Term> (dotted underline that
 * DISAPPEARS on hover, tooltip = the localized `glossary.<key>.body`, deep-link
 * to /glossary#<key>). This pins:
 *   - the 12 acronyms map to lowercase glossary keys
 *   - every key has a localized title (the acronym) + short body in ALL 10 locales
 *   - the splitter links standalone terms, skips markup-adjacent + compound ones,
 *     is first-occurrence-only, and round-trips the exact answer text
 *   - FaqSearch renders segments through <Term ... hideUnderlineOnHover>
 *   - the /glossary page lists all 12 terms
 *   - <Term> supports hideUnderlineOnHover (underline goes transparent on hover)
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFaqAnswerForGlossary, FAQ_GLOSSARY_TERMS } from '../src/lib/faq/glossaryTerms.ts';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const LOCALES_DIR = resolve(SRC, 'lib', 'i18n', 'locales');
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
const EXPECTED_TERMS = ['ECIES', 'X25519', 'ECDH', 'AEAD', 'ENS', 'IPFS', 'TLS', 'DNS', 'P2P', 'PWA', 'MCP', 'RSS'];

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
const read = (p: string) => readFileSync(p, 'utf8');

// ── 1. The term map ──────────────────────────────────────────────────
{
	const keys = Object.keys(FAQ_GLOSSARY_TERMS);
	if (EXPECTED_TERMS.every((t) => keys.includes(t)) && keys.length === EXPECTED_TERMS.length)
		ok(`all 12 acronyms present in FAQ_GLOSSARY_TERMS`);
	else bad(`term map mismatch`, keys.join(', '));
	if (EXPECTED_TERMS.every((t) => FAQ_GLOSSARY_TERMS[t] === t.toLowerCase()))
		ok(`each acronym maps to its lowercase glossary key`);
	else bad(`a term does not map to its lowercase key`);
}

// ── 2. Localized glossary entries in all 10 locales ──────────────────
for (const loc of LOCALES) {
	const g = JSON.parse(read(resolve(LOCALES_DIR, `${loc}.json`))).glossary ?? {};
	const missing: string[] = [];
	const badTitle: string[] = [];
	const tooLong: string[] = [];
	for (const term of EXPECTED_TERMS) {
		const key = term.toLowerCase();
		const e = g[key];
		if (!e || typeof e.title !== 'string' || typeof e.body !== 'string' || !e.body.trim())
			missing.push(key);
		else {
			if (e.title !== term) badTitle.push(key); // acronym titles are NOT translated
			if (e.body.length > 400) tooLong.push(key); // must fit a tooltip
		}
	}
	if (missing.length === 0) ok(`${loc}: all 12 glossary terms have title + body`);
	else bad(`${loc}: missing glossary entries`, missing.join(', '));
	if (badTitle.length === 0) ok(`${loc}: every acronym title is the acronym itself`);
	else bad(`${loc}: title mistranslated`, badTitle.join(', '));
	if (tooLong.length === 0) ok(`${loc}: every definition is short enough for a tooltip`);
	else bad(`${loc}: definition too long for a tooltip`, tooLong.join(', '));
}

// ── 3. Splitter behaviour ────────────────────────────────────────────
const concat = (s: string) =>
	splitFaqAnswerForGlossary(s)
		.map((x) => x.text)
		.join('');
const termSegs = (s: string) => splitFaqAnswerForGlossary(s).filter((x) => x.kind === 'term');

{
	// Round-trip on real answers (no text added/lost — pre-line safety).
	const faq = JSON.parse(read(resolve(LOCALES_DIR, 'en.json'))).faq?.entries ?? {};
	const sample = ['chat_privacy', 'vs_others', 'public_api', 'who_runs_it'].filter((k) => faq[k]?.a);
	const broken = sample.filter((k) => concat(faq[k].a) !== faq[k].a);
	if (broken.length === 0) ok(`splitter round-trips real answers exactly (${sample.length} checked)`);
	else bad(`splitter changed the text of`, broken.join(', '));
}
{
	const segs = termSegs('Chat uses ECIES over X25519 today.');
	if (segs.length === 2 && segs[0].kind === 'term' && segs[0].text === 'ECIES' && segs[1].text === 'X25519')
		ok(`standalone acronyms are linked (ECIES + X25519)`);
	else bad(`standalone linking wrong`, JSON.stringify(segs));
}
{
	// Markup-adjacent + compound must NOT link (real corpus case: **RSS-driven**).
	const cases: [string, string][] = [
		['A **RSS-driven** dashboard.', 'RSS in bold+compound'],
		['Use `TLS` everywhere.', 'TLS in code span'],
		['A P2P-only network.', 'P2P compound'],
		['See [DNS](https://x.io) docs.', 'DNS in a link']
	];
	const leaked = cases.filter(([s]) => termSegs(s).length > 0).map(([, why]) => why);
	if (leaked.length === 0) ok(`markup-adjacent + compound occurrences are NOT linked`);
	else bad(`wrongly linked`, leaked.join(', '));
}
{
	const segs = termSegs('ECIES is used; the ECIES key rotates.');
	if (segs.length === 1) ok(`only the first occurrence of a term is linked`);
	else bad(`expected 1 ECIES term seg, got ${segs.length}`);
}
{
	const empty = splitFaqAnswerForGlossary('');
	const none = splitFaqAnswerForGlossary('no acronyms here at all');
	if (empty.length === 1 && empty[0].kind === 'text' && none.length === 1 && none[0].kind === 'text')
		ok(`empty + term-free answers yield a single text segment`);
	else bad(`degenerate cases wrong`);
}

// ── 4. FaqSearch wiring ──────────────────────────────────────────────
{
	const fs = read(resolve(SRC, 'lib', 'components', 'FaqSearch.svelte'));
	if (/splitFaqAnswerForGlossary\(entry\.answer\)/.test(fs)) ok(`FaqSearch renders answers via the glossary splitter`);
	else bad(`FaqSearch does not use splitFaqAnswerForGlossary`);
	if (/<Term key=\{seg\.key\} hideUnderlineOnHover>\{seg\.text\}<\/Term>/.test(fs))
		ok(`FaqSearch renders term segments as <Term hideUnderlineOnHover>`);
	else bad(`FaqSearch term rendering missing/incorrect`);
	// Text runs still go through the markdown renderer.
	if (/\{@html renderFaqInline\(seg\.text, lp\)\}/.test(fs)) ok(`text runs still render inline markdown`);
	else bad(`text runs no longer use renderFaqInline`);
}

// ── 5. /glossary page lists the new terms ────────────────────────────
{
	const gp = read(resolve(SRC, 'routes', '[lang]', 'glossary', '+page.svelte'));
	const missing = EXPECTED_TERMS.map((t) => t.toLowerCase()).filter((k) => !new RegExp(`'${k}'`).test(gp));
	if (missing.length === 0) ok(`/glossary page lists all 12 acronym terms`);
	else bad(`/glossary page missing terms`, missing.join(', '));
}

// ── 6. Term supports the disappear-on-hover variant ──────────────────
{
	const term = read(resolve(SRC, 'lib', 'components', 'Term.svelte'));
	if (/hideUnderlineOnHover\?: boolean/.test(term) && /hideUnderlineOnHover = false/.test(term))
		ok(`Term declares the hideUnderlineOnHover prop (default false)`);
	else bad(`Term missing hideUnderlineOnHover prop`);
	if (/hideUnderlineOnHover[\s\S]{0,40}hover:border-transparent/.test(term))
		ok(`hideUnderlineOnHover makes the dotted underline go transparent on hover`);
	else bad(`hideUnderlineOnHover does not clear the underline on hover`);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 faq-glossary-terms smoke FAILED');
	process.exit(1);
}
console.log('\u2713 FAQ acronyms auto-link to a localized glossary; splitter safe; /glossary + Term wired');
console.log(`\u2713 all ${pass} faq-glossary-terms scenarios passed`);
