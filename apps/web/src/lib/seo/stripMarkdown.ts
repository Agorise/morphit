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

	// Strip `[link text](url)` → "link text (url)".  Keeping the
	// URL in parens preserves accessibility info for users who
	// can't click (which describes every SERP rich-snippet —
	// search results are inert text).
	s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

	// Strip `**bold**` and `__bold__` → "bold".  Strict: must be
	// double-asterisk on both sides; single-asterisk italic NOT
	// stripped here (single asterisk appears in some non-markdown
	// contexts like math notation; better to leave alone).
	s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
	s = s.replace(/__([^_]+)__/g, '$1');

	// Strip `\`code\`` → "code" (single-backtick inline code).
	// Multi-backtick code fences (```…```) aren't used in FAQ
	// copy; if they appear, this regex leaves them alone (good —
	// caller should flag those, not strip silently).
	s = s.replace(/`([^`]+)`/g, '$1');

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
