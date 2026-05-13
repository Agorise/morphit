# ADR-0003: SEO and crawler policy

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** project maintainer

## Context

Morphit is built for privacy-minded users, but the marketplace only works
if people can find it. Word-of-mouth and Blurt-community backlinks drive
some traffic, but organic search is the main acquisition channel for most
non-technical users — exactly the audience most underserved by existing
P2P crypto markets since LocalBitcoins and LocalMonero shut down.

At the same time, Morphit has anti-commitments that are unusual in
SEO practice:

- **No user tracking.** Google Analytics, Meta Pixel, Hotjar, Clarity —
  all forbidden. Any SEO plan that relies on engagement signals
  originating from tracking scripts is unavailable to us.
- **No content farming.** We don't publish SEO-bait blog posts.
  What we have is the landing page, the FAQ, and a few reference
  routes. That's it.
- **No per-user personalization.** Every user sees the same rendered
  HTML for the same path. This actually *helps* SEO (clean, static
  pages are easy to crawl) but it means no dynamic recommendations or
  "trending" tricks.
- **Privacy-focused users may visit via Tor Browser or with
  JS disabled.** The first-paint HTML must be genuinely useful with
  zero JavaScript.

The question is what SEO investment makes sense given these constraints.

## Decision

Implement **classical, fully on-page SEO** — everything a well-indexed
2010-era documentation site would do, and nothing more:

1. Per-route `<title>` + `<meta name="description">`, localized in
   every supported language.
2. Open Graph + Twitter Card metadata with a branded hero image.
3. A static `robots.txt` that allows all crawlers, and a static
   `sitemap.xml` generated at build time with `hreflang` alternates
   for all 10 languages (the ADR was originally written when the
   supported set was 8; zh-CN and zh-HK were added later).
4. JSON-LD structured data:
   - `Organization` schema on the home page (WebSite + Organization).
   - `FAQPage` schema on `/faq`, with every entry expressed as a
     `Question` node. This is the lever that gets Google to show FAQ
     entries as rich snippets in search results — direct, measurable
     value for the "how do I buy Monero with cash" query class.
5. Canonical URLs on every page, so `morphit.io/faq?q=foo&lang=es`
   canonicalizes cleanly against `morphit.io/faq` (FAQ query-string
   params are presentation, not new pages).
6. `<link rel="alternate" hreflang="x">` on every localized page
   pointing at the same path in every other locale.
7. Semantic HTML — one `<h1>` per page, proper `<header>`/`<main>`/
   `<nav>`/`<footer>`, descriptive link text, no "click here".
8. Accurate `lang` attribute on `<html>` matching the active locale,
   kept in sync on locale switch (already done in `setLocale`; the
   static SSG render also needs to emit `en` as the default).

**What we do NOT do:**

- No dynamically rendered / JS-required SEO content. Crawlers that run
  JS (Googlebot, Bingbot, DuckDuckGo) will see the same content
  non-JS crawlers see, because our SSG output is complete HTML.
- No `ai.txt`, no special robots rules, no scraper-class allowlists or
  denylists. Our content is public, our license is AGPL-3, anyone can
  quote us. Playing gatekeeper games with downstream consumers
  achieves nothing and costs legitimacy with readers who consume
  through aggregators. The robots policy is uniformly permissive
  for everyone.
- No keyword stuffing. Meta descriptions are written as sentences a
  human would read, with relevant phrases woven in naturally.
- No schema markup for orders or trades. The on-chain data lives on
  Blurt; indexing it into Google's knowledge graph isn't useful and
  raises trade-privacy issues (see ADR-0002 corollary: everything on
  chain is public, but *surfacing* it through mainstream search is a
  separate choice we decline to make in Phase 2).

## Target keyword clusters

Meta descriptions are written around, but do not stuff, these clusters
(validated informally as high-intent for the Morphit value proposition):

- `peer-to-peer bitcoin exchange no kyc`
- `non-custodial monero trading` / `buy monero with cash`
- `private crypto marketplace` / `decentralized fiat to bitcoin`
- `localbitcoins alternative` / `localmonero alternative` /
  `haveno alternative`
- `censorship-resistant bitcoin exchange`
- `sell bitcoin without ID` / `sell monero anonymously`

These drive the copy in meta descriptions and OG tags. None appear as
invisible keyword dumps in the body — they all appear in natural prose
on the home page or relevant FAQ entry.

## Alternatives considered

- **Paid search / display ads.** Rejected — no budget and no
  tracking means we can't attribute, and ads on privacy-focused
  products attract exactly the wrong attention from ad networks.
- **Build an SEO content blog.** Rejected for Phase 2 — scope
  creep; content marketing is a full project of its own and
  the existing FAQ covers most high-intent queries.
- **Aggressive JSON-LD** (BreadcrumbList, Article schema on every
  page, etc.). Rejected as diminishing returns. FAQPage and
  Organization are the two that produce visible SERP changes; the
  rest is noise.
- **Serve a `/llms.txt` manifest.** Considered; the standard is
  emerging but not widely respected. If it becomes a real signal
  later, adding it is a one-file change. Not in Phase 2.
- **Opt out of automated scrapers via robots.txt.** Rejected — see
  "What we do NOT do" above.

## Consequences

### Positive

- FAQ entries become eligible for rich-snippet display in Google
  SERPs. For long-tail queries ("how do I sell monero without kyc"),
  this can put a Morphit answer directly in the results page.
- Crawlers get complete, localized content with correct language
  signals. Spanish-speaking users searching in Spanish find the
  Spanish version; German speakers find the German version.
- The site scores well on Lighthouse / PageSpeed Insights /
  accessibility audits, which indirectly helps ranking and directly
  helps non-SEO readers.

### Negative

- More HTML per page (meta tags, JSON-LD, hreflang). Maybe +3–5 KB
  per page before compression. Brotli crushes this to near-zero.
- Every new localized route needs its SEO copy in every locale
  alongside the UI copy. Disciplined but not hard.

### Follow-up work

- Phase 3: add `Article` schema to any per-indexer RSS output.
- Phase 5: consider `/llms.txt` if the standard gains adoption.
- Whenever we add a new route, the PR template must include the
  "SEO copy updated in all locales" checkbox.

## References

- Google FAQPage structured data docs:
  https://developers.google.com/search/docs/appearance/structured-data/faqpage
- Web.dev SEO checklist:
  https://web.dev/learn/seo
- `hreflang` spec:
  https://developers.google.com/search/docs/specialty/international/localized-versions
