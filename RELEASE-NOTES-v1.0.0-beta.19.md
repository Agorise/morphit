# Morphit v1.0.0-beta.19

A performance, privacy, and polish release. The biggest change is invisible: the
app no longer loads its ~1 MB cryptography library until you actually need it —
creating an account, signing in, or opening an encrypted chat — so first visits
to the home page, the order book, and trader profiles are now markedly lighter.
The app also stops quietly pinging every Blurt node the moment it loads, and it
now talks *directly* only to the Blurt nodes that work correctly in a browser —
both make the site quieter on the network and steadier in use. On top of that:
primary buttons across the site now share one brand color, the onboarding wizard
opens each step at the top, and the "a new version is available" banner no longer
reappears in a loop.

For operators: there's nothing to do beyond deploying this build. The browser's
default direct-to-Blurt node list narrowed to the three nodes that serve correct
CORS headers, but all six remain in your server-side config and CSP, so failover
is unchanged.

## Improved

- **Pages load faster — the cryptography library is now fetched only when it's
  used.** Morphit's signing/encryption library (libsodium) is about a megabyte,
  and it was being pulled into the very first page load on *every* page,
  including ones that never touch your keys (the home page, the order book, a
  trader's profile). It now loads the first time you actually do something
  cryptographic — create an account, sign in, open an encrypted chat, import a
  key — and not before. If you're just browsing offers, that megabyte never
  downloads. Nothing about the security changes: the same library does the same
  work the moment a key is involved; it simply isn't fetched until then.
- **The app no longer probes every Blurt node the moment it opens.** Previously,
  opening the site kicked off background "are you alive?" requests to every
  Blurt RPC node in the pool, so the mere act of loading a page produced a
  fan-out of connections before you'd done anything. The client now reaches a
  node only when it has a real request to make, and learns which nodes are
  fastest from real traffic. Less noise on the network, and a smaller footprint
  for simply visiting.
- **Steadier direct connections to Blurt.** The set of Blurt nodes the browser
  talks to *directly* is now limited to the three that return correct
  cross-origin (CORS) headers, so the browser no longer spends attempts on nodes
  it can't actually read from. The full set of nodes still backs the indexer and
  relay on the server side (where CORS doesn't apply), so there's no loss of
  redundancy — this only stops the browser from trying nodes a browser can't use
  anyway.
- **One consistent button color across the whole site.** Primary action buttons
  — the header *Start* button and every filled call-to-action — now use a single
  deepened brand teal (chosen so white text clears the WCAG AA contrast bar)
  instead of a mix of greens, so the interface reads as one coherent set.

## Fixed

- **The "a new version is available" banner no longer loops.** The small banner
  that appears when a new build has been deployed could, in some navigation
  patterns, re-fire repeatedly — popping back up after you'd dismissed it. It now
  attaches its update listeners once per service-worker registration and reloads
  at most once, so it shows up a single time and stays gone after you dismiss it.
- **The onboarding wizard now opens each step at the top.** When the
  create-account flow advanced from one step to the next, it could leave you
  scrolled partway down the previous step. Each step now jumps to its own
  heading, so you always start reading from the top.

## Under the hood

- libsodium now sits behind a lazy accessor (`$lib/crypto/sodium`): a single
  module-level `sodium` binding populated by a dynamic
  `import('libsodium-wrappers-sumo')` the first time `ensureSodium()` is awaited.
  Every async crypto entry point (keygen, keystore, WIF import, desktop pairing,
  backup codes, YubiKey wrap) awaits it first; the handful of synchronous
  `sodium.*` uses are all on paths that can only run after an async load has
  already happened. A new `libsodium-not-in-baseline-closure-smoke` asserts the
  ~1 MB chunk stays out of the every-page module-preload closure, and the chat
  crypto is reached via a dynamic `import('$lib/chat/crypto')` in the trade event
  listener so it never anchors into the baseline either.
- The endpoint rotator no longer calls `warmup()` eagerly on construction. The
  method remains available for explicit opt-in, but the default path probes
  endpoints only on real demand, and the in-app endpoint list
  (`EndpointList.svelte`) wires deliberate probing only where a human is actually
  looking at node health.
- The frontend default Blurt RPC pool (`config.ts` `DEFAULT_RPC_ENDPOINTS`) is
  now a curated subset — the three browser-CORS-clean nodes
  (`rpc.drakernoise.com`, `rpc.blurt.blog`, `blurt-rpc.saboin.com`). The full
  six-node canonical set still lives in `@morphit/operator-config`
  `DEFAULT_BLURT_RPC_ENDPOINTS` (indexer + relay), both env examples, and the
  four-surface CSP `connect-src`. `rpc-endpoint-canon-smoke` now checks the
  frontend list is a non-empty subset (no stray nodes, at least two for
  failover, all HTTPS) while still pinning the server-side env examples to the
  full set.
- Dependency-audit review: the `npm audit` gate gained documented allowlist
  entries for three dev-only advisories nested under `vite` (a dev-server
  path-traversal and two Windows-specific issues in `vite`/`launch-editor`) and
  the `form-data` CRLF advisory reached only through the matrix-bot's transitive
  `request` dependency. None reach production — operators serve prebuilt static
  assets with no Vite dev server running, and the matrix-bot makes only outbound,
  operator-configured homeserver calls with field names it constructs itself. No
  `npm audit fix`, no lockfile rewrite; the lockfile stays the tested source of
  truth.
- The press/media kit (`morphit-mediakit.zip`) was regenerated for the new brand
  color (the palette grew from six entries to seven), with the build script's
  palette guard and the README color-standards table updated to match.
