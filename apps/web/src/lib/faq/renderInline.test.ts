/**
 * FAQ answers render the same with and without the glossary terms.
 *
 * FaqSearch cuts each answer into text runs and glossary terms (<Term>) and
 * renders every text run with renderFaqInline on its own. A term inside a
 * `**bold**` (or `*em*`, a `code` span, a [link](…)) used to cut the markup in
 * two, so neither half matched and the reader saw the raw asterisks
 * (help_make_unstoppable: "**Point an ENS .eth name at your site**", v1.21.6).
 * keepMarkdownWhole puts such a term back into its text run.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepMarkdownWhole, renderFaqInline } from './renderInline';
import { splitFaqAnswerForGlossary } from './glossaryTerms';

const LOCALES = join(__dirname, '..', 'i18n', 'locales');

/** The answer as FaqSearch paints it: term segments as plain text. */
function painted(answer: string): string {
	return keepMarkdownWhole(splitFaqAnswerForGlossary(answer))
		.map((s) => (s.kind === 'term' ? s.text : renderFaqInline(s.text)))
		.join('');
}

describe('keepMarkdownWhole', () => {
	it('a term inside bold / em / code / link stays inside it; one outside stays a term', () => {
		const a = 'Use **an ENS name** or *IPFS*; `ENS` [see IPFS](/x). Then ENS again.';
		const segs = keepMarkdownWhole([
			{ kind: 'text', text: 'Use **an ' },
			{ kind: 'term', key: 'ens', text: 'ENS' },
			{ kind: 'text', text: ' name** or *' },
			{ kind: 'term', key: 'ipfs', text: 'IPFS' },
			{ kind: 'text', text: '*; `ENS` [see IPFS](/x). Then ' },
			{ kind: 'term', key: 'ens2', text: 'ENS' },
			{ kind: 'text', text: ' again.' }
		]);
		expect(segs.map((s) => s.text).join('')).toBe(a);
		expect(segs.flatMap((s) => (s.kind === 'term' ? [s.key] : []))).toEqual(['ens2']);
		expect(segs.filter((s) => s.kind === 'text')).toHaveLength(2);
	});

	it('every FAQ answer in every locale renders as it would without glossary terms', () => {
		const broken: string[] = [];
		for (const file of readdirSync(LOCALES).filter((f) => f.endsWith('.json'))) {
			const entries = JSON.parse(readFileSync(join(LOCALES, file), 'utf8')).faq.entries as Record<
				string,
				{ a: string }
			>;
			for (const [key, { a }] of Object.entries(entries)) {
				if (painted(a) !== renderFaqInline(a)) broken.push(`${file} ${key}`);
			}
		}
		expect(broken).toEqual([]);
	});
});

describe('renderFaqInline links', () => {
	it('never turns `//host` or `/\\host` into a link (another site, without rel="noopener")', () => {
		for (const md of ['[x](//evil.example/a)', '[x](/\\evil.example)']) {
			for (const html of [renderFaqInline(md), renderFaqInline(md, (p) => `/en${p}`)]) {
				expect(html).not.toMatch(/<a /);
			}
		}
		expect(renderFaqInline('[x](/my/orders)', (p) => `/en${p}`)).toContain('href="/en/my/orders"');
	});
});

describe('renderFaqInline links — control characters', () => {
	it('a path whose slashes are split by a tab or line break (browsers drop those) is no link', () => {
		for (const md of [
			'[x](/\t/evil.example/a)',
			'[x](/\r/evil.example/a)',
			'[x](/\t\\evil.example)'
		]) {
			for (const html of [renderFaqInline(md), renderFaqInline(md, (p) => `/en${p}`)]) {
				expect(html).not.toMatch(/<a /);
			}
		}
	});
});
