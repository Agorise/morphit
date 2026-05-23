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
import { stripMarkdown } from './stripMarkdown';
import type { FaqEntry } from '$utils/faqIndex';

/**
 * Organization schema — the "this is us" anchor for SERP knowledge panels.
 * Morphit is a collective with no employees or HQ; we emit the minimum
 * honest set of fields.
 */
export function organizationSchema(
	siteName: string,
	tagline: string,
	locale?: string
): Record<string, unknown> {
	const out: Record<string, unknown> = {
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
	// cp119-A5: emit inLanguage when caller passes a locale.  Optional
	// for back-compat with old call sites; new callers pass it so
	// Google can disambiguate translated copies of this Organization
	// node across hreflang variants.
	if (locale) out.inLanguage = locale;
	return out;
}

/**
 * WebSite schema. Primary value is the `SearchAction` which unlocks
 * the sitelinks-search-box in Google SERPs — when a user Googles
 * "morphit", the results include a box that searches our FAQ directly.
 */
export function websiteSchema(siteName: string, locale?: string): Record<string, unknown> {
	const out: Record<string, unknown> = {
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
	// cp119-A5: emit inLanguage when caller passes a locale.
	if (locale) out.inLanguage = locale;
	return out;
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
	description: string,
	locale?: string
): Record<string, unknown> {
	const out: Record<string, unknown> = {
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
		// cp119-A7: softwareVersion lives in MORPHIT_SOFTWARE_VERSION
		// constant below.  Update there on each pre-launch/launch/major
		// release.  Avoids the drift risk of hardcoding 'beta' here when
		// the project actually ships a numbered release.
		softwareVersion: MORPHIT_SOFTWARE_VERSION,
		// AGPL-3.0 source link is the most actionable provenance signal
		// Google's rich results can attach to the listing.
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
	// cp119-A5: emit inLanguage when caller passes a locale.
	if (locale) out.inLanguage = locale;
	return out;
}

/**
 * cp119-A7 — single source of truth for the SoftwareApplication
 * `softwareVersion` field.  Update this constant on each pre-launch
 * milestone or launch event.
 *
 * Pre-launch (current): 'beta'.
 * At launch: bump to '1.0' (or whatever the launch version is).
 * Subsequent: bump on each numbered release.
 *
 * Read by softwareApplicationSchema().  Memory rule "no hardcoded
 * figures that change over time" applies — but the right fix for
 * a version-string is a labeled constant in one place, not a
 * dynamic lookup (a build-time JSON.parse of package.json would
 * couple the SEO surface to packaging metadata that has its own
 * versioning lifecycle).  When Ken bumps this string, the SEO
 * surface bumps with it.
 */
export const MORPHIT_SOFTWARE_VERSION = 'beta';

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
			// cp119-A1: question text is plain in source today, but
			// strip defensively so future markdown additions can't
			// leak literal asterisks into SERP results.
			name: stripMarkdown(entry.question),
			acceptedAnswer: {
				'@type': 'Answer',
				// cp119-A1: 77 of 128 FAQ entries contain light
				// markdown (`**bold**`, backticks, `\n\n`, bullets).
				// Strip before feeding to JSON-LD so Google's
				// FAQ rich-snippet renders clean plaintext.
				text: stripMarkdown(entry.answer)
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
