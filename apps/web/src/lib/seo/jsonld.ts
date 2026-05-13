/**
 * Morphit — JSON-LD structured data builders.
 *
 * Returns plain objects that `<Head />` serializes into
 * <script type="application/ld+json">. We keep the surface minimal
 * per ADR-0003: two schemas with measurable SERP impact (Organization
 * + FAQPage) and a WebSite node so Google's sitelinks search box
 * (which searches our FAQ) works.
 *
 * Reference: https://developers.google.com/search/docs/appearance/structured-data
 */

import { CANONICAL_ORIGIN } from './urls';
import type { FaqEntry } from '$utils/faqIndex';

/**
 * Organization schema — the "this is us" anchor for SERP knowledge panels.
 * Morphit is a collective with no employees or HQ; we emit the minimum
 * honest set of fields.
 */
export function organizationSchema(siteName: string, tagline: string): Record<string, unknown> {
	return {
		'@context': 'https://schema.org',
		'@type': 'Organization',
		'@id': `${CANONICAL_ORIGIN}/#organization`,
		name: siteName,
		url: CANONICAL_ORIGIN,
		description: tagline,
		sameAs: [
			// Populated in Phase 3+ as the Blurt community accounts
			// and mirrors come online. Intentionally empty for now
			// rather than listing placeholders that could be stale.
		],
		logo: {
			'@type': 'ImageObject',
			url: `${CANONICAL_ORIGIN}/brand/morphit-mark.svg`,
			width: 512,
			height: 512
		}
	};
}

/**
 * WebSite schema. Primary value is the `SearchAction` which unlocks
 * the sitelinks-search-box in Google SERPs — when a user Googles
 * "morphit", the results include a box that searches our FAQ directly.
 */
export function websiteSchema(siteName: string): Record<string, unknown> {
	return {
		'@context': 'https://schema.org',
		'@type': 'WebSite',
		'@id': `${CANONICAL_ORIGIN}/#website`,
		name: siteName,
		url: CANONICAL_ORIGIN,
		potentialAction: {
			'@type': 'SearchAction',
			target: {
				'@type': 'EntryPoint',
				urlTemplate: `${CANONICAL_ORIGIN}/faq?q={search_term_string}`
			},
			'query-input': 'required name=search_term_string'
		}
	};
}

/**
 * FAQPage schema. This is the SERP rich-snippet lever — Google displays
 * FAQ entries directly in search results when the page marks them up
 * with FAQPage. Every entry becomes a `Question` with an `acceptedAnswer`.
 *
 * Google's guidelines require:
 *   - Only user-facing FAQs (not support forums; ours are).
 *   - Each question must appear exactly once (our FAQ is keyed by a
 *     unique string, so this is automatic).
 *   - Answers must be the full answer the user sees — no partial or
 *     teaser text.
 */
export function faqPageSchema(entries: FaqEntry[]): Record<string, unknown> {
	return {
		'@context': 'https://schema.org',
		'@type': 'FAQPage',
		'@id': `${CANONICAL_ORIGIN}/faq#faqpage`,
		mainEntity: entries.map((entry) => ({
			'@type': 'Question',
			name: entry.question,
			acceptedAnswer: {
				'@type': 'Answer',
				text: entry.answer
			}
		}))
	};
}
