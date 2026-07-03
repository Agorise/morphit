/**
 * Morphit — markdown-to-plaintext helper for JSON-LD.
 *
 * cp119-A1: FAQ entries in i18n files use light markdown
 * (`**bold**`, backticks, paragraph `\n\n`, bullet `\n • `, and
 * occasional `[link](url)`) so the rendered HTML reads well.
 * Feeding those raw strings into `faqPageSchema()` is wrong:
 * Google's FAQ rich-snippet renders `acceptedAnswer.text` as
 * plain text, so users see literal `**asterisks**` and
 * backticks in their search results.
 *
 * This module strips light markdown into clean plaintext for
 * machine-readable contexts (JSON-LD, OG description, twitter
 * card text).  The human-facing rendering still uses the raw
 * i18n source — only the SERP-bound text gets stripped.
 *
 * Scope: SAFE strip of the patterns actually used in Morphit's
 * FAQ content as of cp117 (cataloged at cp119-A1 audit).  Not
 * a CommonMark parser; deliberately conservative.  If a new
 * markdown construct lands in FAQ copy, add a case here +
 * a fixture to the smoke.
 */

/**
 * Convert light markdown to plaintext.  Idempotent (calling
 * twice produces the same result as calling once).  Safe to
 * call on any string; non-markdown content passes through
 * unchanged.
 */
export function stripMarkdown(input: string): string {
	if (!input) return '';
	let s = input;

	// Protect inline-code content first so its literal characters — e.g. the
	// `*` wildcard in `/v1/*` — are never treated as emphasis. Stashed as the
	// inner text (backticks dropped) and restored after emphasis stripping.
	const code: string[] = [];
	s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
		code.push(c);
		return `\u0000C${code.length - 1}\u0000`;
	});

	// cp406 — order `terms` may use headings and horizontal rules (the FAQ does
	// not, so these are no-ops there). Drop whole horizontal-rule lines, and
	// strip leading heading markers (`#`…`######`) keeping the heading text.
	// Done before emphasis stripping so an hr like `***` isn't mistaken for
	// bold/italic.
	s = s.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');
	s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');

	// Strip `[link text](url)` → "link text (url)".  Keeping the
	// URL in parens preserves accessibility info for users who
	// can't click (which describes every SERP rich-snippet —
	// search results are inert text).
	s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

	// Strip `**bold**` and `__bold__` → "bold".
	s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
	s = s.replace(/__([^_]+)__/g, '$1');

	// Strip `*italic*` → "italic" (single-asterisk emphasis).  The content
	// excludes `/` so a bare API-path wildcard (e.g. `/v1/*` … `/v2/*`, once
	// its code span has been unwrapped) can never be mistaken for an italic
	// span — this also keeps the function idempotent on its own output.  Code
	// spans (the legitimate home of `*`) are already stashed out of reach.
	s = s.replace(/\*([^*\n/]+)\*/g, '$1');

	// Restore the stashed inline-code text (plain, backticks already dropped).
	s = s.replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => code[Number(i)] ?? '');

	// Bullet-list normalization: "\n • item" → ". item" so the
	// list reads as a flowing sentence stream.  Plaintext FAQ
	// answers don't have visual bullet structure to preserve.
	s = s.replace(/\n\s*•\s+/g, '. ');
	s = s.replace(/\n\s*-\s+/g, '. ');

	// Paragraph collapse: "\n\n" → " " (single space).  JSON-LD
	// is a single field; multi-paragraph structure isn't
	// preserved.  Collapse to a sentence-flow.
	s = s.replace(/\n\n+/g, ' ');

	// Single newline → space (sentence flow, not visual break).
	s = s.replace(/\n/g, ' ');

	// Collapse runs of whitespace.
	s = s.replace(/[ \t]+/g, ' ');

	return s.trim();
}
