# Per-locale prerendering — design discussion

**Status:** ✅ **SHIPPED in Part 121 cp7 (2026-05-14).**  Route restructure complete; build produces 200 locale-prefixed HTML files (20 routes × 10 locales) + redirect shell.  Helpers shipped in cp6 (2026-05-13); route restructure in cp7 (next day).
**Date:** 2026-04-21 (design); 2026-05-13 (cp6 partial: helpers + smoke + i18n module split); 2026-05-14 (cp7 full: route restructure + redirect shell + 88 link-site sweep + verification)
**Interacts with:** `apps/web/svelte.config.js`
(prerender + adapter-static config + `handleUnseenRoutes:'ignore'`), `apps/web/src/app.html`
(pre-paint locale script), `apps/web/src/hooks.client.ts`
(post-hydration locale sync), all routes (now under `[lang]/`).

## Shipping status

✅ **All Option C scope SHIPPED:**

cp6 (2026-05-13):
- `apps/web/src/lib/i18n/locales.ts` — pure SSoT (zero SvelteKit deps).
- `apps/web/src/lib/i18n/path.ts` — `localePath()`, `stripLocalePrefix()`, `pickLocaleFromAcceptLanguages()`, `isLocalePrefixed()`.
- `apps/web/scripts/i18n-path-helpers-smoke.ts` — 22 scenarios.
- `apps/web/src/lib/auth/pairingPhoneSigner.ts` Buffer-import build blocker fixed.
- `scripts/build-sitemap.mjs` ROUTES re-synced with `routes.ts` (14→17).

cp7 (2026-05-14):
- Physical route move: 24 subdirs + +layout.{svelte,ts} + +page.svelte moved under `[lang]/`.
- `apps/web/src/routes/[lang]/+layout.ts` — `prerender = true`, `ssr = true`, `load({params})` validates lang + calls initI18nFor + waitLocale.
- `apps/web/src/routes/[lang]/+page.ts` — `entries()` enumerating SUPPORTED_LOCALES (must live on +page.ts per SvelteKit).
- Root redirect shell: new `+page.svelte` (pickLocaleFromAcceptLanguages + window.location.replace + noscript meta-refresh fallback to /en + meta robots noindex), `+layout.ts` (prerender=true, ssr=false), `+layout.svelte` (minimal, imports app.css).
- `svelte.config.js` `handleUnseenRoutes:'ignore'` for the 7 dynamic-param routes.
- `Head.svelte` `url.search`/`url.hash` gated behind `building` flag.
- 88 internal link sites wrapped in `localePath()` across 21 page files + 10 components + the layout's navLinks array.
- `LanguageSwitcher.svelte` rewired to `goto(localePath(stripLocalePrefix(currentPath), code))`.
- 6 P121-CP7 persona-walkthrough sentinels (CP7-1..6).
- 11 smoke scripts updated to point at new `[lang]/` paths.
- `href-xss-smoke` whitelisted `lp` / `localePath` + ALLOWLIST entry for `link.href`.

**Verification:**
- `npm run build` produces 200 locale-prefixed HTMLs + redirect shell + degraded.
- Triple-pulse smokes: 2,470 × 3, 0 failures.
- Rendered `de.html` carries `/de/` prefix on all nav + footer + CTAs; 0 bare paths.
- Same symmetry confirmed for `fa.html` (RTL).

⏸ **Follow-on SEO refinements (NOT cp7 scope, not blocking launch):**

- Sitemap hreflang `<xhtml:link rel="alternate">` tags per URL (sitemap.xml already emits 170 indexable URLs but lacks the per-URL alternates block).
- Per-locale RSS feeds at `/<lang>/rss/orderbook.xml` (currently single-locale at `/rss/orderbook.xml`).
- Canonical + hreflang `<head>` tags per page in `[lang]/+layout.svelte` (currently inherits from `Head.svelte`'s existing logic — worth verifying it still emits correctly under the new prefix structure).

---

## The problem

Morphit's frontend is prerendered to static HTML
(`apps/web/src/routes/+layout.ts: prerender = true`).
Every route is baked at build time into a single HTML
file — in English — and shipped via `adapter-static`.

When a non-English user loads the page, the sequence is:

1. Browser downloads the English-prerendered HTML, paints.
2. JS loads, `initI18n()` runs, detects the user's
   preferred locale from `?lang=...` or
   `navigator.languages`.
3. svelte-i18n swaps every `$_('…')` call to the matching
   string for that locale.
4. Page re-renders in the correct language.

The user sees a **flash of English content** between
steps 1 and 4. On a fast device this is ~100ms; on a
slow phone or CGNAT link it's noticeable. A pre-paint
script in `app.html` already sets `<html lang>` and
`dir` correctly so the outer chrome (scrollbar
direction, browser translation UI) is right from frame
zero — but the **text content** of the page is
English until hydration completes.

This is a known architectural issue. The revisit list
has carried "per-locale prerendering" as a pending fix.

---

## The fix, at concept level

Instead of one HTML per route, generate N HTMLs per
route (one per supported locale). At request time,
serve the right one. No client-side string swap needed
— the HTML is already in the user's language.

For Morphit's 10 locales × ~15 routes, that's ~150 HTML
files instead of ~15. Modest footprint (each HTML is
~30KB; the full set is ~5MB, comfortably cacheable).

The interesting design question is **how to route**.

---

## Option A — URL-prefix routing (`/es/orderbook`)

Each locale gets its own URL namespace:

- `/orderbook` → English
- `/es/orderbook` → Spanish
- `/de/orderbook` → German
- …

SvelteKit pattern: a `[lang]` param in the route tree,
or a per-locale `+layout.ts` that sets the locale from
the URL.

**Pros:**
- Shareable locale-specific URLs (Spanish user copies
  `/es/orderbook`, recipient opens it, gets Spanish).
- Search-engine-friendly — Google indexes each locale
  as its own pages.
- Works with pure static hosting — no server
  content-negotiation logic needed.
- Simple mental model.

**Cons:**
- URL structure changes. Every existing link
  (`/orderbook`, `/post`, …) has to be updated or a
  redirect rule added. External links from blurt.blog
  or Matrix messages point at the bare paths, so we
  need `/orderbook` → `/<detect>/orderbook` redirect
  at the root.
- Duplicates our sitemap / RSS URL structures.
- `Share this page` buttons need to emit the
  locale-prefixed URL.

## Option B — Accept-Language content negotiation (nginx)

Single URL structure (`/orderbook`), nginx looks at the
`Accept-Language` header, maps it to one of the 10
locales, serves the right HTML.

**Pros:**
- No URL structure change.
- Existing links keep working.
- The user's browser negotiates automatically — same
  URL yields different content per user.

**Cons:**
- Breaks static hosting. Morphit operators would need
  nginx (or equivalent) with a content-negotiation
  rule — more setup burden than "serve the `build/`
  folder."
- Doesn't play well with caching CDNs — Cloudflare and
  friends cache by URL, not by `Accept-Language`, so a
  user who caches the English version sees English
  forever.
- Share-a-link breaks across locales (Spanish user
  shares `/orderbook`, English recipient opens it,
  gets English — not what was shared).
- Doesn't help users who want to force a locale
  different from their browser default.

## Option C — Two-stage: detection redirect + prefix routing

Combines A and B. Root paths (`/orderbook`) redirect to
the detected-locale prefix (`/es/orderbook`), then the
prefix is the source of truth.

**Pros:**
- First-time visitors get auto-detection.
- Shared links have stable locale.
- Works with static hosting (redirect is a
  `<meta http-equiv="refresh">` + small JS fallback, or
  an nginx rule for operators who have nginx).
- No string-swap FOUC in the locale-prefixed pages —
  they're baked correctly.
- The detection redirect is the ONLY place FOUC can
  occur, and it's instant (same-origin redirect with
  a fresh HTML download that's already correct).

**Cons:**
- Two HTMLs touched per first visit (bare-path +
  locale-prefix). Mitigated by aggressive caching.
- Slightly more complex routing logic than A alone.

---

## Recommendation

**Option C.** It keeps all of A's upsides (shareable
URLs, search-engine friendliness, pure static
hosting) while solving A's "first visit with no prefix"
case gracefully.

The detection redirect is small: a 20-line script in
`app.html` that reads `navigator.languages`, picks the
best-matching SUPPORTED_LOCALE, and does
`window.location.replace('/' + code + window.location.pathname)`.
The prerendered bare-path HTML ships with that script
and no other content — it's a redirect shell, not a
rendered page.

---

## Implementation sketch

### 1. Route tree restructure

Move everything under a `[lang]` param:

```
routes/
  +layout.ts                 ← redirect shell; no prerender
  +page.svelte               ← redirect shell
  [lang]/
    +layout.ts               ← prerender = true; set locale from params
    +layout.svelte           ← existing layout chrome
    +page.svelte             ← existing home
    orderbook/+page.svelte
    faq/+page.svelte
    post/+page.svelte
    …
```

The root `+layout.ts` exports `prerender = false` (or
`'auto'`) and handles the redirect. The `[lang]/` subtree
has `prerender = true` and `entries()` to enumerate all
10 locales.

### 2. Prerender entries

`apps/web/src/routes/[lang]/+layout.ts`:

```ts
import { SUPPORTED_LOCALES } from '$i18n';

export const prerender = true;

export function entries() {
  return SUPPORTED_LOCALES.map((l) => ({ lang: l.code }));
}
```

Each descendant route inherits this, so the build
generates `/en/orderbook`, `/es/orderbook`, … for
every route.

### 3. Set locale from URL param

`apps/web/src/routes/[lang]/+layout.ts`:

```ts
import { waitLocale, locale } from 'svelte-i18n';
import { initI18nFor } from '$i18n';

export async function load({ params }) {
  if (!SUPPORTED_LOCALES.some((l) => l.code === params.lang)) {
    throw error(404);
  }
  await initI18nFor(params.lang);
  await waitLocale(params.lang);
  return { lang: params.lang };
}
```

`initI18nFor(code)` is a new function that sets the
locale before any Svelte rendering happens, so
prerender output is in the right language.

### 4. Detection-redirect shell at root

`apps/web/src/routes/+page.svelte`:

```svelte
<script>
  import { onMount } from 'svelte';
  import { SUPPORTED_LOCALES } from '$i18n';
  onMount(() => {
    const preferred = pickLocale(navigator.languages);
    const path = window.location.pathname === '/'
      ? '/' + preferred
      : '/' + preferred + window.location.pathname;
    window.location.replace(path + window.location.search);
  });

  function pickLocale(accept) {
    for (const a of accept) {
      const short = a.toLowerCase().split('-')[0];
      const match = SUPPORTED_LOCALES.find((l) =>
        l.code === a || l.code.split('-')[0] === short
      );
      if (match) return match.code;
    }
    return 'en';
  }
</script>

<noscript>
  <meta http-equiv="refresh" content="0; url=/en/" />
</noscript>
```

### 5. Internal link updates

Every `<a href="/orderbook">` etc. becomes
`<a href={`/${$page.data.lang}/orderbook`}>`. A
`localePath` helper centralizes this.

Existing `goto('/orderbook')` calls become
`goto(localePath('/orderbook'))`.

### 6. Sitemap + RSS + canonical tags

Update `apps/web/src/routes/sitemap.xml/+server.ts` to
emit 10× entries per route with `<xhtml:link
rel="alternate" hreflang="…">` tags. RSS feed gains
per-locale variants at `/es/rss/orderbook.xml` etc.
Canonical `<link rel="canonical">` in `<head>` points
to the current locale's URL.

### 7. Language picker

A dropdown in the header that navigates to the same
path under a different locale prefix. Already exists
(`LanguagePicker.svelte`) — updated to use
`localePath` and emit locale-prefixed URLs.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Build time 10×'s, local dev becomes slow | Generate only 1 locale (`en`) in dev; full matrix only on production build. Gate via `VITE_LOCALES=en` env. |
| External links to `/orderbook` break | Root `+page.svelte` handles the redirect gracefully. Plus a nginx-config snippet in OPERATIONS.md for operators who prefer header-based routing. |
| Every i18n string needs re-verification at build time | Already run a parity script; gate the build on it. Missing key → build fails, not a runtime mystery. |
| RTL locales (`fa`) need `dir="rtl"` baked into HTML | The `[lang]/+layout.svelte` sets `<svelte:head>` `dir` attribute from `SUPPORTED_LOCALES[params.lang].rtl`. |
| Indexer/relay URLs don't change | They don't — only the frontend restructure. API endpoints stay at `/v1/*`. |

---

## What I'd verify before shipping

1. A working local `npm run build` produces the
   expected 150+ HTML files and they serve correctly
   via `npx serve build/`.
2. `/` loads the redirect shell and correctly detects
   `navigator.languages` → locale prefix.
3. `/es/orderbook` serves Spanish HTML with no English
   FOUC.
4. `/zh-HK/faq` serves Traditional Chinese.
5. `/fa/post` serves Persian RTL with `dir="rtl"` set
   on `<html>` in the prerendered HTML (not just set
   by JS).
6. Language picker works (navigating `/en/faq` → pick
   Spanish → lands on `/es/faq`).
7. RSS feed at `/es/rss/orderbook.xml` renders.
8. Canonical + hreflang tags are correct in `<head>`.

None of these can be verified in the current sandbox
because it lacks a working SvelteKit build pipeline.
The shape of the work is clear; the execution should
happen on a machine with a working `npm run build`.

---

## Estimated scope

- Route tree restructure: ~2 hours
- `initI18nFor(code)` implementation: ~30 min
- Internal link audit (find every `href="/..."`) and
  `localePath()` wrapper: ~2 hours
- Sitemap + RSS per-locale: ~1 hour
- Language picker fix: ~30 min
- Canonical + hreflang in `<head>`: ~30 min
- Local verification + staging test: ~2 hours
- OPERATIONS.md nginx fallback documentation: ~30 min

**Total: one focused day.** No new dependencies, no
schema changes, no translation work (all 10 locales are
already complete — this is purely a rendering-pipeline
fix).

---

## Why this hasn't shipped yet

The work is small but requires a working build
environment to iterate against. The Morphit sandbox
environment this session ran in doesn't run
`npm run build` successfully (missing native deps for
some SvelteKit plugins), so a blind set of edits would
have high risk of a build-breaking typo that I
couldn't detect. Operator with a working checkout can
pick this up and complete it in a day.
