/**
 * highlightMatches — wrap search-token matches in a <mark> for the orderbook's
 * free-text "Order details" filter (cp411). Highlights the word(s) a user is
 * searching inside an order's terms/details preview, mirroring the FAQ search's
 * "show me where it matched" affordance.
 *
 * SECURITY: the returned string is HTML that is SAFE to render with `{@html}`.
 * Every character of the source `text` is HTML-escaped, and the only markup
 * this function ever introduces is `<mark class="…">` with a STATIC class name.
 * Order terms are user-authored and attacker-controllable, so there is no code
 * path that copies raw text into a tag or attribute — adversarial terms cannot
 * inject executable HTML through this helper. The companion smoke
 * (orderbook-terms-highlight-safety-smoke) pins this guarantee.
 *
 * Matching: tokens are matched case-insensitively as plain substrings (each
 * token is regex-escaped first, so `$`, `.`, `(`, a lone `\`, etc. in a token
 * are treated literally). Longer tokens are tried first so a multi-word phrase
 * like "orange trees" is highlighted as one span rather than fragmenting into
 * "orange" + "trees".
 */

const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tailwind classes for the highlight pill — a subtle emerald wash that reads
 *  in dark mode and inherits the surrounding text colour so the label stays
 *  legible. */
const MARK_CLASS = 'rounded bg-morphit-emerald/25 text-inherit';

/**
 * Return `text` as HTML with every occurrence of any token wrapped in a
 * `<mark>`. When `tokens` is empty (or all-whitespace), the text is returned
 * escaped but otherwise untouched.
 */
export function highlightMatches(text: string, tokens: readonly string[]): string {
	const toks = Array.from(new Set(tokens.map((t) => t.trim()).filter((t) => t.length > 0)));
	if (toks.length === 0) return escapeHtml(text);
	// Longest-first so a phrase match beats its constituent words.
	toks.sort((a, b) => b.length - a.length);
	const re = new RegExp(`(${toks.map(escapeRegExp).join('|')})`, 'gi');
	let out = '';
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) out += escapeHtml(text.slice(last, m.index));
		out += `<mark class="${MARK_CLASS}">${escapeHtml(m[0])}</mark>`;
		last = m.index + m[0].length;
		// Belt-and-braces against a zero-length match looping forever (can't
		// happen for non-empty tokens, but keep the invariant explicit).
		if (re.lastIndex === m.index) re.lastIndex += 1;
	}
	if (last < text.length) out += escapeHtml(text.slice(last));
	return out;
}
