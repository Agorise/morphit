/**
 * Morphit — safe inline-markdown renderer for FAQ answers.
 *
 * FAQ copy in the i18n files uses light *inline* markdown — `**bold**`,
 * `*italic*`, `` `code` ``, and the occasional `[text](url)` — authored so the
 * rendered answer reads well (this is the same source that `stripMarkdown()`
 * cleans for the JSON-LD / SERP path). The visible FAQ answer, however, was
 * printed as plain text, so readers saw literal asterisks and backticks. This
 * renders those inline markers as real HTML while leaving block structure
 * (newlines, `• ` bullets) to the element's `white-space: pre-line`.
 *
 * SAFETY: the input is escaped FIRST, then only our own fixed tag set is
 * injected — `<strong>`, `<em>`, `<code>`, and `<a>` whose href is restricted
 * to http(s)/mailto/relative. Code spans and links are stashed behind
 * placeholders so emphasis parsing can't reach inside them. The FAQ copy is
 * trusted (our own i18n), but escape-first keeps this safe regardless.
 */

import type { FaqAnswerSegment } from './glossaryTerms';

const ESCAPE: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ESCAPE[c] ?? c);
}

/** Allow only safe href schemes; null means "not safe, leave as text". */
function safeHref(url: string): string | null {
	const u = url.trim();
	// Browsers drop tabs and line breaks inside a URL, so `/<TAB>/host` would
	// pass the `//host` check below and still lead to another site.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(u)) return null;
	if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u) || u.startsWith('#')) return u;
	// A path, but not `//host` or `/\host`: browsers read both as another site,
	// and a path link gets no rel="noopener".
	if (u.startsWith('/') && !/^\/[/\\]/.test(u)) return u;
	return null;
}

const SENTINEL = '\u0000';

/**
 * Render light inline markdown to safe HTML. Newlines are preserved verbatim
 * (the caller renders with `white-space: pre-line`). Pure + idempotent-safe on
 * already-escaped text.
 */
export function renderFaqInline(input: string, localizeHref?: (path: string) => string): string {
	if (!input) return '';

	// 1. Escape everything first. From here we only ADD known-safe tags.
	let s = escapeHtml(input);

	// 2. Stash code spans + links behind sentinels so emphasis parsing can't
	//    reach inside them and so their markup survives untouched.
	const slots: string[] = [];
	const stash = (html: string): string => {
		slots.push(html);
		return `${SENTINEL}${slots.length - 1}${SENTINEL}`;
	};

	// `code` — content is already HTML-escaped.
	s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(`<code>${code}</code>`));

	// [text](url) — text + url arrive HTML-escaped; validate the raw URL.
	s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (whole: string, text: string, url: string) => {
		const raw = url.replace(/&amp;/g, '&');
		const href = safeHref(raw);
		if (href === null) return whole; // leave unsafe/odd links as literal text
		const internal = href.startsWith('/') || href.startsWith('#');
		// locale-prefix path-internal links (e.g. `/my/wallet` →
		// `/{lang}/my/wallet`) via the caller's localizer so an in-app link
		// in an answer lands on the right per-locale route. `#hash` links and
		// external URLs pass through unchanged; safeHref already validated the
		// path, so the localizer only ever sees a known-safe `/…` string.
		const finalHref = href.startsWith('/') && localizeHref ? localizeHref(href) : href;
		const rel = internal ? '' : ' target="_blank" rel="noopener noreferrer"';
		return stash(`<a href="${escapeHtml(finalHref)}" class="underline hover:no-underline"${rel}>${text}</a>`);
	});

	// 3. Emphasis on the remaining (sentinel-protected) text. Bold before
	//    italic so `**x**` isn't mis-read as two italics.
	s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
	s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
	s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

	// 4. Restore the stashed code/link HTML.
	s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? '');

	return s;
}

/** The inline-markdown spans renderFaqInline draws as one element, in the
 *  order it finds them: `code`, [text](url), **bold**, __bold__, *em*. */
const MARKDOWN_SPANS = [
	/`[^`\n]+`/g,
	/\[[^\]\n]+\]\([^)\n]+\)/g,
	/\*\*[^*\n]+\*\*/g,
	/__[^_\n]+__/g,
	/\*[^*\n]+\*/g
];

/**
 * FaqSearch renders an answer as text runs (each through renderFaqInline on
 * its own) and glossary terms (<Term>). A term that sits inside a markdown
 * span would cut that span in two, and neither half would render: the reader
 * would see the raw `**`. Such a term goes back into its text run (it is then
 * plain text inside the bold, link or code); every other term stays.
 */
export function keepMarkdownWhole(segs: readonly FaqAnswerSegment[]): FaqAnswerSegment[] {
	// In renderFaqInline's order: a span already found is masked, so a later
	// pattern cannot match inside it or across it.
	let text = segs.map((s) => s.text).join('');
	const spans: [number, number][] = [];
	for (const re of MARKDOWN_SPANS) {
		for (const m of text.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
		text = text.replace(re, (m) => SENTINEL.repeat(m.length));
	}
	const out: FaqAnswerSegment[] = [];
	let at = 0;
	for (const seg of segs) {
		const start = at;
		at += seg.text.length;
		const inSpan = seg.kind === 'term' && spans.some(([a, b]) => a < at && start < b);
		const prev = out[out.length - 1];
		if (seg.kind === 'term' && !inSpan) out.push(seg);
		else if (prev !== undefined && prev.kind === 'text')
			out[out.length - 1] = { kind: 'text', text: prev.text + seg.text };
		else out.push({ kind: 'text', text: seg.text });
	}
	return out;
}
