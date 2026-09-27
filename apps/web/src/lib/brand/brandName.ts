/**
 * Morphit — per-instance BRAND NAME: pure helpers (no SvelteKit / DOM deps).
 *
 * WHY THIS EXISTS
 *
 * Morphit is the SOFTWARE; every federated instance is a SITE with its own
 * brand ("Vigilante Trading", "Morphit Latino", …). UI copy that names the SITE
 * the visitor is using ("Sign in to Morphit", "Your Morphit password") must show
 * the operator's brand, while copy that names the SOFTWARE / project / federation
 * ("Run a Morphit node", "other Morphit instances", "Morphit is AGPL-3.0") keeps
 * saying Morphit. The locale JSON files mark every SITE mention with the
 * `{brand}` placeholder; every SOFTWARE mention stays the literal word "Morphit".
 *
 * `{brand}` is NOT an ICU argument. It is substituted into the dictionary
 * TEXTUALLY when a locale bundle loads (see $i18n + applyBrandToMessages below),
 * so no call site passes a `brand` value and ICU never sees the token.
 *
 * The frontend build is byte-identical for every operator (the on-chain
 * build-integrity check depends on it), so the operator's brand can never be
 * compiled in. It arrives at runtime:
 *   - prerendered pages: `<html data-brand-name="…">`, written by
 *     `morphit-ops branding apply` (a canonical page carries "Morphit");
 *   - the SPA fallback shell (index.html, which the tamper check covers and
 *     nothing may rewrite): `/brand/brand.json`, fetched before hydration.
 *
 * NO-FLASH / NO-JS: during PRERENDER every brand slot is bracketed by an
 * invisible U+2060 sentinel ("\u2060Morphit\u2060"). A post-build step
 * (scripts/build-brand-slots.mjs) records where every slot sat in
 * `build/.brand-slots.json`, then strips the sentinels — so the canonical HTML
 * is clean, and `morphit-ops branding apply` can later rewrite EXACTLY those
 * slots (never a software mention) with the operator's brand. First paint,
 * no-JS visitors and crawlers all see the right brand, and hydration finds
 * matching text (nothing flips).
 */

export {
	DEFAULT_BRAND_NAME,
	BRAND_PLACEHOLDER_RE,
	BRAND_SLOT_SENTINEL,
	BRAND_NAME_MAX_LENGTH,
	sanitizeBrandName,
	applyBrandToString,
	applyBrandToMessages,
	brandFileSlug,
	type BrandRenderer
} from '@morphit/operator-config/brand';
