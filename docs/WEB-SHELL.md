# The web shell (`apps/web/src/app.html`)

`app.html` is the SvelteKit HTML template. Its `<head>` is emitted
**verbatim on every page**, so it is deliberately kept lean — no
multi-line explanatory comments, because those would ship to every
visitor on every route and inflate the document. This file is where
that rationale lives instead. (Svelte component comments, by contrast,
are stripped at build time — `preserveComments` is false by default —
so `.svelte` files may comment freely.)

If you change `app.html`, update this doc to match.

## Dark mode

The site is dark-mode-only by design. `<html class="dark">` makes
Tailwind's `dark:*` variants fire unconditionally; `<meta
name="color-scheme" content="dark">` tells the user agent not to
auto-adapt form controls or scrollbars to a light theme. The light
Tailwind variants remain in the CSS as an inert fallback should the
site ever offer a user-toggleable light theme.

## Title / description / SEO — per route, not in the shell

`app.html` intentionally sets **no** default `<title>` or `<meta
name="description">`. Title, description, canonical, hreflang,
OpenGraph, Twitter Card, and JSON-LD are emitted per route via the
`<Head />` component in each page, rendered into `%sveltekit.head%`.
SvelteKit always renders a route before committing the HTML, so a page
is never served without its localized SEO copy. The hreflang set (one
`<link rel="alternate">` per supported locale) and the JSON-LD block
are intentional multilingual-SEO surface, not bloat — do not strip
them to "save weight."

## Icons (three assets, distinct purposes)

- `favicon.svg` — transparent background, mark only. Browser
  tab/bookmark icon. Reads on both light and dark tab bars because the
  gradient mark has its own color identity.
- `app-icon.svg` — dark (ink-950) background, mark centered. Default
  PWA icon for OS app launchers, and the `apple-touch-icon` (an iOS
  home-screen shortcut needs a non-transparent square).
- `app-icon-maskable.svg` — same dark canvas as `app-icon`, but the
  mark fits inside the inner 40% safe radius so Android adaptive-icon
  masks (circle, squircle, teardrop) never crop it.

The wordmark is intentionally **not** used for any of these — it is for
the in-app top-left header and footer only.

## iOS / PWA install hints

iOS Safari needs these to treat the site as a real PWA on Share → Add
to Home Screen:

- `apple-mobile-web-app-capable: yes` — launch standalone (no browser
  chrome). Without it, the home-screen icon opens a regular Safari tab.
- `apple-mobile-web-app-status-bar-style: black-translucent` — matches
  the dark theme; the status bar overlays the app's top edge instead of
  stealing ~44pt of layout.
- `apple-mobile-web-app-title: Morphit` — shorter label under the
  home-screen icon.
- `mobile-web-app-capable: yes` — the standardized successor of the
  apple-prefixed capability; emitted alongside it for forward
  compatibility (Android Chrome reads the standard one, iOS Safari
  still primarily reads the apple-prefixed).

iOS 16.4+ fully supports the PWA install flow including service workers
and Web Share Target. Older iOS versions still install the icon and
load the page; they just lack the full PWA feature set.

## Font preload

Two `<link rel="preload" as="font">` entries for the self-hosted Nunito
subset (latin 400 + 700, woff2, `crossorigin="anonymous"`) so first
paint doesn't wait on a font round-trip.

## Preflight locale hint (the inline `<script>`)

A tiny synchronous script runs before body paint. It reads the
`?lang=<code>` query parameter (if present), validates it against the
supported-locale whitelist, and sets
`document.documentElement.lang` / `dir` so:

- screen readers announce the correct language,
- crawlers that don't run JS see the right `lang` attribute when
  indexing with `Accept-Language` headers,
- the later `svelte-i18n` `init()` in `hooks.client.ts` picks up the
  same value and serves the correct translations.

It is best-effort: with no `lang` param it leaves the default `<html
lang="en">` intact and lets i18n resolve from `navigator.languages`.
The whitelist array in the script **must stay in sync with
`SUPPORTED_LOCALES`**.

## No-JavaScript notice (`<noscript>`)

A styled banner explaining that browsing (orders, profiles, feedback)
works without JavaScript by design, but trading (creating orders,
chatting, signing feedback) needs JS because all cryptography happens
in the browser — Morphit never sees user keys, and running JS on the
server would mean holding them. This is intentional UX, kept inline so
it renders with zero JS.

## Service-worker registration

Registration is handled by SvelteKit's built-in auto-register
(`svelte.config.js` → `kit.serviceWorker.register: true`), which
injects a small inline script at build time that registers
`/service-worker.js` (compiled from `apps/web/src/service-worker.ts`)
on `load`.

Do **not** manually register a different SW URL in `app.html`: it would
race with SvelteKit's and silently replace it (same scope `/`, last
register wins). That was the Part 122 / cp81 bug — a separate `/sw.js`
was registered manually and superseded the SvelteKit SW, breaking push
notifications (fixed in cp81-D22). `UpdateBanner.svelte` picks up the
registration via `navigator.serviceWorker.getRegistration()`
asynchronously and watches for `updatefound`. See
[`SERVICE-WORKER-CACHING-DESIGN.md`](./SERVICE-WORKER-CACHING-DESIGN.md)
for the full design.
