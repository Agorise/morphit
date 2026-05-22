/**
 * Morphit — JSON-LD structured data builders.
 *
 * Returns plain objects that `<Head />` serializes into
 * <script type="application/ld+json">.  Per ADR-0003, every schema
 * we emit is one that has measurable SERP impact:
 *
 *   - Organization        — SERP knowledge panel anchor
 *   - WebSite             — unlocks sitelinks search box
 *   - SoftwareApplication — installation rich result for the PWA
 *   - FAQPage             — FAQ rich snippets (collapsed Q&A in SERP)
 *   - BreadcrumbList      — breadcrumb display in SERP for sub-pages
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
			// cp112 audit fix (A4): point at /app-icon.svg which IS
			// 512×512 (viewBox 0 0 512 512), not the brand mark which
			// is 41×26 with viewBox 0 0 10.889 7.049 — declaring 512×512
			// for a non-square asset would make Google fetch the SVG,
			// see the mismatch, and likely reject the logo for SERP
			// knowledge-panel use.  app-icon.svg's identity mark is
			// the same wordless logo (same colors, same shape), just
			// laid out on a square canvas, so visual identity is
			// preserved.
			'@type': 'ImageObject',
			url: `${CANONICAL_ORIGIN}/app-icon.svg`,
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
 * SoftwareApplication schema (cp112).  Morphit is a Progressive Web App
 * in the FinanceApplication category, free to use, AGPL-3.0 source.
 * Google's installation-rich-result UI shows price/category/operating
 * system for software-marked pages — relevant for "morphit" / "p2p
 * crypto marketplace" / "no kyc crypto" queries.
 *
 * We DO NOT emit aggregateRating — Morphit has no review aggregation
 * surface and faking ratings violates Google's structured-data
 * spam policy.  The omission is intentional.
 */
export function softwareApplicationSchema(
	siteName: string,
	description: string
): Record<string, unknown> {
	return {
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		'@id': `${CANONICAL_ORIGIN}/#software`,
		name: siteName,
		description,
		// FinanceApplication is Schema.org's specific subtype for
		// trading / wallet / payment apps.  More specific than the
		// generic "WebApplication" Google falls back to.
		applicationCategory: 'FinanceApplication',
		applicationSubCategory: 'CryptocurrencyTrading',
		// PWA: works in any modern browser; no native install required.
		operatingSystem: 'Web',
		url: CANONICAL_ORIGIN,
		// Morphit itself is free; users pay only on-chain network fees +
		// optional listing fees that go to the operator.  Schema.org's
		// `offers` with `price: '0'` is the canonical way to signal this.
		offers: {
			'@type': 'Offer',
			price: '0',
			priceCurrency: 'USD'
		},
		// AGPL-3.0 source link is the most actionable provenance signal
		// Google's rich results can attach to the listing.
		softwareVersion: 'beta',
		license: 'https://www.gnu.org/licenses/agpl-3.0.html',
		// Publisher uses an @id pointer to the Organization node so the
		// two schemas link in Google's structured-data graph.
		publisher: {
			'@id': `${CANONICAL_ORIGIN}/#organization`
		},
		// Browser requirements — modern evergreen browser with JS.  No
		// version pin (Morphit runs on whatever the user has).
		browserRequirements: 'JavaScript enabled, modern web browser'
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

/**
 * BreadcrumbList schema (cp112).  Google uses BreadcrumbList to show
 * crumb navigation in SERPs (e.g. "morphit.io › privacy › Bitcoin"
 * instead of just the URL).  Big legibility lift for sub-pages.
 *
 * Caller passes an ordered list of (name, url) pairs starting with
 * the root.  We omit the implicit "Home" item — Google's docs say
 * the breadcrumb chain should start from the closest meaningful
 * ancestor, not always Home.  Callers wanting Home prepend it.
 *
 * `url` strings should be canonical, locale-prefixed forms (e.g.
 * `https://morphit.io/en/privacy/btc`).
 */
export interface BreadcrumbItem {
	name: string;
	url: string;
}

export function breadcrumbListSchema(items: BreadcrumbItem[]): Record<string, unknown> {
	return {
		'@context': 'https://schema.org',
		'@type': 'BreadcrumbList',
		itemListElement: items.map((it, idx) => ({
			'@type': 'ListItem',
			position: idx + 1,
			name: it.name,
			item: it.url
		}))
	};
}
