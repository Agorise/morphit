/**
 * Morphit — FAQ acronym → glossary auto-linking (2026-07-19, Ken).
 *
 * WHY THIS EXISTS
 * ---------------
 * FAQ answers are rendered as trusted inline-markdown HTML via
 * `renderFaqInline` (a single `{@html …}`), so we can't drop the Svelte
 * `<Term>` glossary component straight into the answer text. Instead we split
 * an answer into an ordered list of segments — plain text runs (each still
 * rendered through `renderFaqInline`) and glossary-term markers (rendered as
 * `<Term>` in the caller) — reconstructing the exact original text with no
 * added or lost whitespace, so the parent's `white-space: pre-line` behaves
 * identically to the un-split version.
 *
 * WHAT GETS LINKED
 * ----------------
 * Only the FIRST *standalone* occurrence of each acronym per answer. Standalone
 * means whole-token AND not adjacent to inline-markdown markers or a hyphen, so
 * we never link a term that is:
 *   - inside emphasis / code / a link  (`**RSS-driven**`, `` `TLS` ``),
 *   - part of a compound word          (`RSS-driven`, `P2P-only`).
 * Those occurrences stay in the text run and render normally. `<Term>` itself
 * further limits the visible dotted-underline cue to the first appearance per
 * route (its `glossarySeen` tracker), so a term used in several answers only
 * cues once per page.
 *
 * The map keys are the acronyms AS WRITTEN in the FAQ copy (uppercase); the
 * values are the lowercase `glossary.<key>` entries added in the locale JSONs.
 */

/** Acronym (as it appears in FAQ copy) → glossary key. */
export const FAQ_GLOSSARY_TERMS: Readonly<Record<string, string>> = {
	ECIES: 'ecies',
	X25519: 'x25519',
	ECDH: 'ecdh',
	AEAD: 'aead',
	ENS: 'ens',
	IPFS: 'ipfs',
	TLS: 'tls',
	DNS: 'dns',
	P2P: 'p2p',
	PWA: 'pwa',
	MCP: 'mcp',
	RSS: 'rss'
};

export type FaqAnswerSegment =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'term'; readonly key: string; readonly text: string };

/**
 * Characters that, immediately before or after a match, mean the term is NOT a
 * standalone word we should link: word characters (part of a larger token),
 * inline-markdown markers (`*`, backtick, `[`/`]`), and the hyphen (compound
 * words). Split into before/after because `[` opens a link and `]` closes one.
 * We avoid a lookbehind (unsupported on older Safari) by capturing the boundary
 * char in group 1 and offsetting the match index past it.
 */
const BEFORE = "[^\\w*`\\[-]";
const AFTER = "[\\w*`\\]-]";

/**
 * Split a FAQ answer into text + glossary-term segments. Pure; returns a single
 * text segment when no term is present. Later occurrences of a term (after its
 * first) stay in the text runs.
 */
export function splitFaqAnswerForGlossary(answer: string): FaqAnswerSegment[] {
	if (!answer) return [{ kind: 'text', text: '' }];

	// First standalone occurrence of each term.
	const hits: { index: number; term: string; key: string }[] = [];
	for (const [term, key] of Object.entries(FAQ_GLOSSARY_TERMS)) {
		// (start | non-boundary char)(TERM)(?! trailing boundary char)
		const re = new RegExp(`(^|${BEFORE})(${escapeRegExp(term)})(?!${AFTER})`);
		const m = re.exec(answer);
		if (m) hits.push({ index: m.index + (m[1] ?? '').length, term, key });
	}
	if (hits.length === 0) return [{ kind: 'text', text: answer }];

	hits.sort((a, b) => a.index - b.index);

	const segs: FaqAnswerSegment[] = [];
	let cursor = 0;
	for (const h of hits) {
		if (h.index < cursor) continue; // defensive: overlaps a prior term
		if (h.index > cursor) segs.push({ kind: 'text', text: answer.slice(cursor, h.index) });
		segs.push({ kind: 'term', key: h.key, text: h.term });
		cursor = h.index + h.term.length;
	}
	if (cursor < answer.length) segs.push({ kind: 'text', text: answer.slice(cursor) });
	return segs;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
