/**
 * Morphit — payment-methods search helper (Batch L).
 *
 * Pure: takes the list of entries (canonical + instance
 * additions, merged by the caller), a query string, an optional
 * asset-exclusion filter, and a description-lookup callback.
 * Returns the filtered list with relevance scoring.
 *
 * Search semantics:
 *
 *   • Whitespace-trimmed, case-folded query.
 *   • Empty query returns all entries (no filtering).
 *   • Query is split on whitespace into terms; ALL terms must
 *     match SOMEWHERE in (name + description) for the entry to
 *     be included (AND semantics across terms).
 *   • Per-term match is substring (case-folded), no fuzziness —
 *     fuzzy matching on a finite curated list creates more
 *     surprise than help.
 *   • Score: name-match counts more than description-match
 *     (3× weight).  Multiple matches in one field don't multiply.
 *
 * Asset-exclusion filter:
 *
 *   • If `excludeForAsset` is set (e.g. 'BTC' when the order's
 *     traded asset is BTC), entries with `assetExclusion ===
 *     excludeForAsset` are dropped.  Used by the picker to
 *     prevent "buy BTC with BTC."
 *
 * The description lookup is a callback so this module can stay
 * pure and avoid importing svelte-i18n.  Callers pass
 * `(key) => $_(\`payment_method.${key}.description\`)` from
 * Svelte components, or a plain map for smokes.
 */

import type { PaymentMethodEntry } from './registry';
import type { AssetTicker } from '@morphit/asset-registry';

export interface SearchOptions {
	readonly excludeForAsset?: AssetTicker;
}

export interface SearchResult {
	readonly entry: PaymentMethodEntry;
	readonly score: number;
}

/** Case-fold + diacritic strip.  Diacritic strip uses NFD +
 *  combining-mark removal — handles "Café" → "cafe" without
 *  importing a normalization library. */
function fold(s: string): string {
	if (typeof s !== 'string') return '';
	return s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();
}

/** Split query into non-empty terms.  Whitespace separator. */
function tokenize(q: string): string[] {
	return fold(q)
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

/** Filter + score entries against the query.  Returns sorted
 *  newest-first by score, with ties broken by alphabetical
 *  name order (stable for picker UX).
 *
 *  The description-lookup callback can return null/undefined for
 *  entries with no description (instance additions might omit
 *  description) — those entries are still searchable by name.
 */
export function searchPaymentMethods(
	entries: readonly PaymentMethodEntry[],
	query: string,
	lookupDescription: (key: string) => string | null | undefined,
	opts: SearchOptions = {}
): SearchResult[] {
	const filtered = opts.excludeForAsset
		? entries.filter((e) => e.assetExclusion !== opts.excludeForAsset)
		: entries.slice();

	const terms = tokenize(query);
	if (terms.length === 0) {
		// No query → all entries pass with score 0.  Caller
		// renders in their natural (alphabetical) order.
		return filtered.map((entry) => ({ entry, score: 0 }));
	}

	const out: SearchResult[] = [];
	for (const entry of filtered) {
		const nameFolded = fold(entry.name);
		const descFolded = fold(lookupDescription(entry.key) ?? '');

		let score = 0;
		let allMatched = true;
		for (const term of terms) {
			const inName = nameFolded.includes(term);
			const inDesc = descFolded.includes(term);
			if (!inName && !inDesc) {
				allMatched = false;
				break;
			}
			// Name match is 3× weight of description match.
			// Multiple matches in one field don't compound — first
			// hit awards the score for that field per term.
			if (inName) score += 3;
			else score += 1;
		}
		if (allMatched) out.push({ entry, score });
	}

	// Sort: highest score first, ties alphabetical.
	out.sort((a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		return a.entry.name.localeCompare(b.entry.name);
	});
	return out;
}
