/**
 * Morphit — restricted markdown parser for user-authored order `terms`.
 *
 * cp406 (Ken): the Terms field supports a DELIBERATELY SMALL markdown subset —
 * headings, bold, italics, unordered/ordered lists, horizontal rules, and line
 * feeds. Nothing else (no raw HTML, no images beyond the existing Blurt-image
 * link carve-out, no tables, no blockquotes, no code fences).
 *
 * ─── Security ────────────────────────────────────────────────────────────
 * `terms` is the highest-risk free-text input in the app: attacker-authored,
 * shown to every viewer of an order page. This module NEVER produces HTML.  It
 * parses the text into a plain structured tree (headings / paragraphs / lists /
 * hr, each with inline runs of text / bold / italic / Blurt-image-link) that
 * TermsText.svelte renders through Svelte's normal escaping — so there is NO
 * `{@html}` sink anywhere and no way for markup in `terms` to become live DOM.
 * The only href produced is the already-validated `safeBlurtImageUrl`.
 *
 * The parser is pure + total (never throws) and is regression-locked by
 * apps/web/scripts/terms-markdown-smoke.ts.  For the compact card preview use
 * stripMarkdown() instead (single plain line).
 */

import { linkifyBlurtImageSegments, safeBlurtImageUrl } from '$lib/utils/blurtImageLink';

export type TermsInline =
	| { t: 'text'; v: string }
	| { t: 'bold'; v: string }
	| { t: 'italic'; v: string }
	| { t: 'link'; v: string; href: string };

export type TermsBlock =
	| { type: 'heading'; level: 1 | 2 | 3; runs: TermsInline[] }
	| { type: 'paragraph'; runs: TermsInline[] }
	| { type: 'ul'; items: TermsInline[][] }
	| { type: 'ol'; items: TermsInline[][] }
	| { type: 'hr' };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+\.\s+(.*)$/;

/** Split a run of text into bold / italic / plain runs.  `**x**` → bold,
 *  `*x*` → italic.  Emphasis never spans a newline (so a lone `*` on its own
 *  line — or a multiplication sign in prose — can't accidentally open a span
 *  across lines). Unmatched markers stay literal. */
function parseEmphasis(text: string): TermsInline[] {
	const runs: TermsInline[] = [];
	const re = /\*\*([^*]+)\*\*|\*([^*\n]+)\*/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) runs.push({ t: 'text', v: text.slice(last, m.index) });
		if (m[1] !== undefined) runs.push({ t: 'bold', v: m[1] });
		else runs.push({ t: 'italic', v: m[2] ?? '' });
		last = re.lastIndex;
	}
	if (last < text.length) runs.push({ t: 'text', v: text.slice(last) });
	return runs.length > 0 ? runs : [{ t: 'text', v: text }];
}

/** Parse a line/run of inline content: Blurt-image links first (they must stay
 *  verbatim, never emphasis-parsed), then bold/italic on the remaining text. */
function parseInline(text: string): TermsInline[] {
	const runs: TermsInline[] = [];
	for (const seg of linkifyBlurtImageSegments(text)) {
		if (seg.link) {
			const href = safeBlurtImageUrl(seg.value);
			if (href) {
				runs.push({ t: 'link', v: seg.value, href });
				continue;
			}
			// Not a safe URL after all (shouldn't happen for a link segment) —
			// fall through and treat it as ordinary text.
		}
		runs.push(...parseEmphasis(seg.value));
	}
	return runs;
}

/**
 * Parse restricted-markdown `terms` into a structured block tree.  Pure,
 * total, and safe on any input. Consecutive non-blank text lines collapse into
 * one paragraph (newlines preserved inside it); a blank line starts a new
 * block.
 */
export function parseTermsMarkdown(input: string | null | undefined): TermsBlock[] {
	const src = (input ?? '').replace(/\r\n?/g, '\n');
	const lines = src.split('\n');
	const blocks: TermsBlock[] = [];
	let paragraph: string[] = [];

	function flushParagraph(): void {
		if (paragraph.length === 0) return;
		const text = paragraph.join('\n').replace(/[ \t]+$/gm, '');
		blocks.push({ type: 'paragraph', runs: parseInline(text) });
		paragraph = [];
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';

		if (line.trim() === '') {
			flushParagraph();
			continue;
		}

		const hr = HR_RE.test(line);
		if (hr) {
			flushParagraph();
			blocks.push({ type: 'hr' });
			continue;
		}

		const heading = HEADING_RE.exec(line);
		if (heading) {
			flushParagraph();
			const level = Math.min((heading[1] ?? '').length, 3) as 1 | 2 | 3;
			blocks.push({ type: 'heading', level, runs: parseInline((heading[2] ?? '').trim()) });
			continue;
		}

		if (UL_RE.test(line)) {
			flushParagraph();
			const items: TermsInline[][] = [];
			while (i < lines.length) {
				const m = UL_RE.exec(lines[i] ?? '');
				if (!m) break;
				items.push(parseInline((m[1] ?? '').trim()));
				i++;
			}
			i--; // step back; outer loop will advance
			blocks.push({ type: 'ul', items });
			continue;
		}

		if (OL_RE.test(line)) {
			flushParagraph();
			const items: TermsInline[][] = [];
			while (i < lines.length) {
				const m = OL_RE.exec(lines[i] ?? '');
				if (!m) break;
				items.push(parseInline((m[1] ?? '').trim()));
				i++;
			}
			i--;
			blocks.push({ type: 'ol', items });
			continue;
		}

		paragraph.push(line);
	}
	flushParagraph();
	return blocks;
}
