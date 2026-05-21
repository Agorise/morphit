# Service worker — design note

**Status:** shipped (canonical SW is `apps/web/src/service-worker.ts`, registered automatically by SvelteKit's `serviceWorker: { register: true }`)
**Last updated:** 2026-05-21 (cp81-D22)

## History

| When | What |
|---|---|
| 2026-04-22 | First SW: `apps/web/static/sw.js`, hybrid cache-first/network-first, manually registered from `app.html` on `window.load`. Pure caching. |
| Part 122 cp13 | Web Push wired through full stack. Push + notificationclick handlers added to a NEW SW: `apps/web/src/service-worker.ts`, which uses SvelteKit's auto-register. Aggressive precache-everything design with pinned-version security model. The OLD `static/sw.js` was NOT removed at the time — both files coexisted. |
| Part 122 cp81-D22 | **Bug found and fixed.** The two SWs were both being registered with scope `/`. Per spec, the second `register()` call at the same scope supersedes the first. `app.html`'s manual `register('/sw.js')` ran later in document order than SvelteKit's auto-injected `register('/service-worker.js')`, so the legacy static SW (without push handler) was the one actually running in production — push notifications were silently broken despite the wiring being correct end-to-end.  Fix: removed manual registration from `app.html`, deleted `static/sw.js`, added cp81-O27 smoke to prevent regression, added clickPath origin validation against operator-payload phishing primitive. |

## Current design (cp81+)

**Canonical SW:** `apps/web/src/service-worker.ts`, compiled to `/service-worker.js` by SvelteKit's build pipeline.

**Registration:** SvelteKit auto-registers via `svelte.config.js → kit.serviceWorker.register: true`. No manual `register()` calls anywhere in the app source.

**Caching:** Aggressive precache-everything. At install, `cache.addAll([...build, ...files, ...prerendered])` snapshots the entire build output into a versioned cache. Precached assets are served cache-only; non-precached same-origin GETs go network-first with a 503 fallback for offline. This gives total origin-decoupling after install — a compromised origin can't replace the user's installed bundle silently.

**Update policy:** Pin-on-install, opt-in upgrade. New SW versions wait until the user clicks "Update now" in `UpdateBanner.svelte`, which sends `{ type: 'APPLY_UPDATE' }` → SW calls `skipWaiting()` → page reloads.

**Push notifications:** `push` handler decrypts/parses the payload and calls `showNotification()`. `notificationclick` resolves the clickPath through `sanitizeClickPath()` (extracted to `$lib/notifications/sanitizeClickPath`), which rejects anything not resolving to the SW's own `http(s)` origin. Without this gate, an operator-controlled relay could phish users via `clickPath: '//evil.com/'`.

**Bypass:** `isCacheable()` filters out non-GET, cross-origin, and `/service-worker.js` itself before any cache interaction.

## What this doc replaces

The original hybrid hand-rolled SW (Option 2 of the original recommendation) was workable but smaller in scope. The Part 122 cp13 push integration pushed us toward a more ambitious precache-everything design (closer to the original Option 3 spirit but extended to JS/CSS/HTML, not just static images). The cp81-D22 cleanup consolidates on the new design and removes the leftover code from the prior one.

## What ships today

```
apps/web/src/service-worker.ts                     ← THE SW
apps/web/src/lib/notifications/sanitizeClickPath.ts ← clickPath gate
apps/web/scripts/service-worker-single-registration-smoke.ts  ← cp81-O27
apps/web/scripts/web-push-wiring-smoke.ts          ← end-to-end push wiring
```

## What does NOT ship anymore

```
apps/web/static/sw.js          ← deleted in cp81-D22a
manual SW register in app.html ← removed in cp81-D22a
```

The smoke `service-worker-single-registration-smoke.ts` enforces that neither comes back.

## Original problem (kept for reference)


Mobile users on slow or metered connections reload Morphit pages and
re-download the same SVG icons, font files, and small static assets on
every navigation. A typical Morphit page hits:

- Brand logo SVG (3KB)
- 6 alt-network icons (Tor, Lokinet, I2P, Nostr, Blurt + icon-BTC/XMR/BLURT for order context) — ~1-3KB each
- Favicon set (multiple sizes, cached by browser but inconsistent)
- Heart identicon SVGs (generated client-side from user pubkeys, but
  the generator code itself loads)

None of this is cryptographic material and none of it changes between
builds on a single release. Caching these is a pure win.

## The existing code

Morphit already ships a service worker — `UpdateBanner.svelte` references
it via `navigator.serviceWorker.getRegistration()` and the banner polls
for new builds. So the registration path exists. The question is only
what the service worker actually does.

## Approach options

### Option 1: Workbox

The standard approach. Pull in `workbox-precaching` + `workbox-routing`
+ `workbox-strategies`. Precache all static assets at install, serve
cache-first for images.

- **Pros**: Battle-tested, well-documented, handles edge cases.
- **Cons**: Adds ~50KB gzipped to the service worker. For a project
  whose entire web bundle is small and whose users include those on
  slow connections, this is a meaningful increase in first-install cost.
  Also another dependency to audit.

### Option 2: Hand-rolled cache-first SW

Write ~80 lines of service worker code: install handler precaches a
fixed list of `/icons/*.svg` and `/fonts/*.woff2` at a versioned cache
name; fetch handler does cache-first for same-origin static paths,
network-first for everything else.

- **Pros**: Minimal code, no dependency. Easy to audit. Cache-invalidation
  is explicit (version the cache name on every release via `verify.json`
  hash).
- **Cons**: We own all the bugs.

### Option 3: Build-time inlining (no SW needed)

Convert all small SVGs (< 4KB) into inline components in the Svelte
source. At build time they become inline strings in the bundle. No
network request at all for those assets — they ship with the HTML.

- **Pros**: Zero runtime cache, zero cache-invalidation problem, works
  in Tor Browser at every security level including the one that
  disables service workers.
- **Cons**: Can't re-use the same asset across pages without paying for
  it multiple times in every page's JS bundle. SVGs outside the critical
  path still benefit from caching. Doesn't help fonts at all.

## Recommendation

**Hybrid: Option 3 (inline) for alt-network + brand icons, Option 2
(hand-rolled SW) for fonts + heart-identicon generator + anything else
> 4KB.**

Reasoning:

- The 6 alt-network icons are already inline SVGs inside
  `AltNetworkIcon.svelte`. They ship with the component's JS chunk.
  No additional work needed; we already get Option 3's benefits for
  these.
- The brand logo and identicons generate data URIs client-side from
  bytes, so they're already not a network request.
- The fonts (`/static/fonts/Typo_Round_*.woff2`) ARE separate network
  requests and they're relatively large (100KB+). These genuinely
  benefit from Option 2.
- App store icons (the upcoming feature) are only shown on download-
  related pages; they don't need aggressive caching.

## Implementation plan for the hand-rolled SW

1. **New file**: `apps/web/static/sw.js` (served at `/sw.js`).
2. **Cache name**: `morphit-static-v{hash}` where `{hash}` comes from
   `verify.json`'s aggregate hash. A new release invalidates the cache
   automatically because the hash changes.
3. **Precache list**: read from `/verify.json`'s hash_manifest at install
   time. Filter to extensions `.woff2`, `.svg`, `.png`, `.webp`. Cache
   only files < 100KB. This is self-configuring — no hard-coded paths.
4. **Fetch handler**: cache-first for `/fonts/*` and `/icons/*`;
   network-falling-back-to-cache for everything else. Bypass SW entirely
   for `/v1/*` API routes (runtime data, must be fresh) and `/rss/*`.
5. **Old-cache cleanup**: on activate, delete any `morphit-static-v*`
   cache whose version doesn't match the current one.
6. **Registration**: already handled in app.html (if the SW file
   exists). Just add the SW file — registration is automatic.

## Tor Browser compat

Tor Browser at high security level disables service workers. Our SW must
not be a hard dependency — existing code already handles the absent-SW
case gracefully (UpdateBanner silently skips). Fonts will load uncached
on Tor, which is the correct behavior there (Tor Browser already fights
font fingerprinting by limiting font exposure).

## Decision needed from you

1. Approve the hybrid approach (no Workbox).
2. Confirm "cache files < 100KB" is a reasonable cutoff.
3. Confirm we should skip caching for `/v1/*` API routes (runtime data).

Once approved, this is ~half a day of work.
