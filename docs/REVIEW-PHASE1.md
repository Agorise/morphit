# Phase 1 — four-perspective review

Date: 2026-04-17
Scope: everything in `/apps/web`, `/docs`, `/scripts`, `/.forgejo/` as of
the close of Phase 1.

> **2026-05-11 forward note (Part 120 audit):** This is a
> dated Phase 1 review snapshot.  Several specifics in the
> findings list are now historical: the relay shipped as a
> **Node.js/TypeScript** service (not Go); the order
> replace-window was amended from **3 minutes to 15 minutes**
> in ADR-0001's 2026-05-07 amendment.  Use ARCHITECTURE.md
> and the latest ADRs in `docs/adr/` for current behavior.

Reviewed under four lenses:
1. **Architect** — does the structure support Phases 2–5?
2. **Comprehension** — can a new contributor navigate the repo?
3. **UX** — will a non-technical user trade successfully?
4. **Adversarial** — what would an attacker or a malicious operator do?

---

## 1. Architect

### Strong

- **Layering is clean.** Routes are thin; all logic lives in `$lib`. The
  crypto module has a hard key-handling contract documented in-file.
- **No premature services.** Phase 1 ships only what it can actually test
  locally. Indexer/relay/payment-watcher are specced in
  `docs/ARCHITECTURE.md` but not scaffolded — good, because designing their
  API against a speculative frontend tends to produce the wrong API.
- **SSG + CSR + No-JS read paths are compatible.** `+layout.ts` sets
  `prerender = true; ssr = true`, so every route emits static HTML, and JS
  progressively enhances. Phase 3 can add `export const csr = true`
  selectively if any page becomes SPA-heavy.
- **Alias setup (`$lib`, `$crypto`, `$i18n`, `$utils`, `$components`)**
  keeps future imports short and rename-safe.
- **Keystore versioning (`v: 1`)** means Phase 2+ can rotate crypto
  primitives without breaking existing users' backups.
- **CSP is already `'self'`-only.** Tightening later is easy; loosening
  never happens.

### Weak / open items (acceptable to defer)

- **Stores folder is empty.** Phase 2 will add `$stores/identity.ts` for
  the in-memory live identity (decrypted keystore during an active session).
  Leaving it empty for now is fine — premature store is worse than none.
- **Service worker is a stub.** Caches the shell; does not yet handle
  background-sync for pending signed ops. Explicitly deferred to Phase 5.
- **Mnemonic uses a 64-word placeholder list.** Every identity the user
  generates in Phase 1 will be re-generable only from the exact same
  placeholder list. Phase 2 must swap in BIP-39 English + locale-matched
  wordlists, and the migration must be able to re-derive from an old
  placeholder seed. Filed as **carry-forward item #1**.
- **Blurt RPC pool isn't wired up.** No `$lib/blurt/` yet. Phase 2.

### Carry-forward items

1. **Replace placeholder mnemonic with BIP-39.** Any Phase-1 seed is
   ephemeral; document this in Phase 2 release notes so early testers
   regenerate.
2. **Add `$stores/identity.ts` with a Writable<Identity | null>** that the
   Phase-1 onboarding flow will populate (today it wipes immediately).
3. **`+layout.svelte` needs a `beforeNavigate` hook** in Phase 2 to warn
   users before they discard an unsaved onboarding session.

Verdict: **architecture supports all downstream phases.** No re-do needed.

---

## 2. Comprehension

### Strong

- `README.md` shows the tree, the principles, and how to run `npm dev` in
  five lines. A new contributor lands on their feet.
- `docs/PLAN.md` is the single source of truth for scope. Anything not in
  it is a bug in the plan, not a bug in the code.
- `docs/ARCHITECTURE.md` has ASCII diagrams, not just prose — a contributor
  can print it and sketch changes.
- `docs/SECURITY.md` is specific: what's in the threat model, what's out.
  The key-handling contract is four questions, not a chapter.
- Every file under `apps/web/src/lib/crypto/` has a security header
  explaining its invariants.
- Locales are flat JSON, not a library-specific format. Anyone who can
  edit JSON can translate.
- **Decentralization story is surfaced to users, not hidden in code.** The
  `run_your_own` FAQ entry pitches operators concretely (front-end mirror,
  indexer, relay, payment watcher), and `rss_feeds` shows the filtering
  power non-obviously available to power users. Both translated across
  all 7 locales.

### Weak / open items

- **No `CONTRIBUTING.md` yet.** Forgejo users benefit from one. Short is
  fine: how to run locally, how to run tests, how to propose an ADR. Filed
  as **carry-forward item #4.**
- **No `docs/adr/` directory.** PLAN.md says changes need an ADR; let's
  pre-create the folder with a `0000-template.md` in Phase 2.
- **Svelte 5 runes (`$state`, `$derived`, `$effect`) may surprise
  Svelte-4-era contributors.** Phase 2 should add a short
  `CONTRIBUTING.md` section linking to the Svelte 5 docs.

### Carry-forward items

4. Add `CONTRIBUTING.md`, `docs/adr/0000-template.md`, and a brief
   Svelte-5 pointer in Phase 2.

Verdict: **comprehension is solid.** The codebase doesn't punish someone
reading it for the first time.

---

## 3. UX

### Strong

- **Five-second comprehension on the home page.** Hero headline, one
  sentence of body, two CTAs. Four value props fit above the fold on
  desktop and in one scroll on mobile.
- **44px minimum touch targets everywhere.** `.btn` sets `min-height: 44px`.
- **Focus rings are thick (2px), brand-colored, visible on every tab
  target** — no `outline: none` anywhere.
- **Language switch is instant and persistent.** `localStorage` with a
  graceful Privacy-Mode fallback.
- **FAQ search is forgiving.** Case-insensitive, accent-stripped, matches
  substrings AND tokens, handles CJK characters individually.
- **Tooltips deep-link to FAQ.** Clicking the `?` next to "Non-custodial"
  goes to `/faq#what_is_morphit` and auto-scrolls + expands.
- **Onboarding backup flow can't be skipped.** The Continue button is
  disabled until both checkboxes are ticked.
- **Seed is hidden by default.** User has to click "Show recovery seed"
  — so shoulder-surfing requires an extra action.
- **No-JS path works for browsing.** The `<noscript>` banner explains
  honestly *why* JS is needed for trading.
- **Dark mode is automatic** via `prefers-color-scheme`.
- **`prefers-reduced-motion` is honored** globally in `app.css`.

### Weak / open items

- **Nunito fonts aren't shipped yet.** `/static/fonts/README.md` tells
  operators what to drop in, but until they do, the site falls back to
  `system-ui`. Grandma will still read the text, so not blocking; but the
  typography on the demo will look generic until the fonts arrive.
  → Document at first deploy.
- **The onboarding seed display uses the 64-word placeholder list.** Some
  words repeat. This is visually alarming ("why does my seed have 'abandon'
  three times?"). Phase 2's BIP-39 swap fixes it; meanwhile, the
  placeholder note in `keygen.ts` calls it out in the source.
- **No "copy seed" button.** Intentional — we want the user to write it
  down, not paste it. But there's also no "print" helper. Consider in
  Phase 3.
- **No confirm-seed step.** Some wallets make you re-type 3 of the 12
  words before continuing. Not shipped in Phase 1; would be a nice
  safety-check add in Phase 2 when BIP-39 is in.

### Carry-forward items

5. Phase 2 adds a "type words 3, 7, 11 to confirm" step before
   finalizing account creation.
6. Phase 2 adds a print-friendly seed view for users who want a paper
   backup without trusting the printer driver.

Verdict: **grandma can complete onboarding today.** The two rough edges
(placeholder wordlist, optional confirm step) are bounded and tracked.

---

## 4. Adversarial

### What I tried to break

#### a. Exfiltrate a user's private key

- **CSP** blocks all non-`'self'` `connect-src`, `script-src`, `style-src`,
  `img-src` (except `data:` for identicons), and `font-src`. A malicious
  third-party CDN cannot be loaded.
- **Zero `fetch`/`XHR` in the crypto path.** `keygen.ts` and `keystore.ts`
  never call any network API.
- **Identity wiped immediately in Phase-1 onboarding** (`wipeIdentity()`
  after completion). Phase 2 will keep it in memory, but only while the
  tab is open.
- **Downloaded keyfile goes to the user's Downloads folder via a blob
  URL**; no server round-trip.
- The encrypted keystore format (`v: 1` + Argon2id + XSalsa20-Poly1305)
  is standard libsodium; not a bespoke construction.

→ No attack path found within the in-scope threat model.

#### b. Downgrade / tamper with the crypto

- The `v: 1` in the keystore envelope means Phase 2 can upgrade without
  breaking existing users. A downgrade requires modifying ciphertext *and*
  the version field, which breaks Poly1305's authentication — detected.
- **Argon2id parameter bug found and fixed during review.** Original code
  read `sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE` at module-import time,
  before `sodium.ready` resolved, so it silently fell back to `2` /
  `67108864` (the `??` fallbacks). This would have worked, but not with
  the libsodium-recommended values. Now resolved inside `argonParams()`
  after `await ensureSodium()`.
- Per-role domain separation: an attacker who somehow extracted the
  `posting` key cannot derive `owner` — different BLAKE2b domain tags.

#### c. Phish the user

- Vanity `.onion`/`.loki`/`.b32.i2p` addresses (Phase 5) make clone sites
  harder. For clearnet, the operator should publish the exact domain and
  a SHA-256 hash of the root HTML on a pinned Blurt post.
- SRI and reproducible builds (Phase 5) let a savvy user verify what they
  loaded. Ordinary users rely on PWA-cache continuity: once installed,
  they're loading *their* copy, not whatever the server happens to be
  serving today.

#### d. Malicious operator

- We (the Morphit operator) run the relay and indexer. We CAN:
  - refuse to broadcast a user's signed op (they failover to another
    relay, listed client-side in Phase 2);
  - serve a filtered orderbook (peer gossip and RSS consumption route
    around us);
  - serve malicious JS (PWA cache + SRI + community frontend mirrors
    detect and resist this).
- We CAN'T:
  - forge a user op (no signing keys)
  - read a user chat (no symmetric keys)
  - steal funds (we never custody them)

#### e. Malicious counterparty

- Out of scope for Phase 1 (orderbook isn't live yet). Phase 3 ships the
  reputation display, account-age surfacing, and self-trade detection.
- Phase 1 home page and FAQ set the correct expectation early: **Morphit
  is a bulletin board, check the person's reputation before trading.**

#### f. Supply-chain attack on dependencies

- `package.json` pins exact minor versions of security-critical deps
  (`libsodium-wrappers-sumo@^0.7.15`, `svelte-i18n@^4.0.1`). Phase 5 moves
  to exact pinning via `package-lock.json` committed + CI enforcement.
- No analytics packages, no adtech packages, no error-reporting packages.
  Dep surface is small by construction.

### Carry-forward items

7. **Phase 5 must enforce a locked `package-lock.json`** in CI (exact
   SHA-verified), not just `^` ranges.
8. Phase 5 ships a PGP-signed release manifest on Blurt so ordinary users
   have a trust anchor outside any single host.
9. Phase 3 must surface "account created today" prominently on profiles
   — anti-sybil depends on that being visible.

Verdict: **Phase 1 doesn't open new attack surface.** The one genuine bug
caught in this review (Argon2id parameters) was fixed before sign-off.

---

## Summary & Phase 2 backlog

Status column updated 2026-04-17 after Phase 2 sign-off. "closed" = the item
shipped in the Phase 2 tarball. "deferred" = intentionally moved to a later
phase after reconsideration. "still open" = remains for the phase originally
assigned.

| # | Item | Phase | Severity | Status (post-Phase-2) |
|---|------|-------|----------|-----------------------|
| 1 | Replace placeholder mnemonic with BIP-39 | 2 | High (UX + seed portability) | **closed** — `@scure/bip39`, canonical English wordlist |
| 2 | `$stores/identity.ts` for live decrypted identity | 2 | High (feature prereq) | **closed** |
| 3 | `beforeNavigate` guard on onboarding | 2 | Medium | **closed** |
| 4 | `CONTRIBUTING.md` + `docs/adr/` template | 2 | Low | **closed** |
| 5 | Confirm 3 random seed words before finalize | 2 | Medium (UX safety) | **closed** |
| 6 | Print-friendly seed view | 3 | Low | still open |
| 7 | Locked `package-lock.json` + SHA verification | 5 | High (supply chain) | still open |
| 8 | PGP-signed release manifest on Blurt | 5 | High (phishing resistance) | still open |
| 9 | Prominent account-age display on profiles | 3 | High (sybil safety) | still open |
| 10 | Indexer RSS endpoint must honor every filter promised in the `rss_feeds` FAQ entry: `pair`, `side`, `location` (incl. `any`), `method`, `min_rep`, `min_age`, `max_deviation` | 3 | High (copy is a contract) | still open |
| 11 | Publish a concrete self-hosting guide (`docs/self-hosting/{frontend,indexer,relay,payment-watcher}.md`) — the `run_your_own` FAQ promises "the README walks you through it in minutes" | 3–5 | High (decentralization pitch is only as credible as the docs) | still open |
| 12 | Implement `morphit_order_replace_v1` op + indexer rule: accept only when (same author) AND (original still `open`) AND (≤3 min since original). Document the op schema in `docs/adr/0001-order-replacement.md`. | 3 | High (the on-chain truth the FAQ now promises) | still open; ADR 0001 published |
| 13 | Implement `morphit_profile_v1` op + `$stores/identity.ts` wiring so Settings actually signs and broadcasts the display name instead of only persisting to localStorage. Until then, display names are device-local only. | 2 | High (user expectation mismatch otherwise) | **closed** — broadcast path implemented; requires registered Blurt account to actually send (see P2-1 in REVIEW-PHASE2.md) |
| 14 | Show the `IdentityLabel` component (name + BLT fingerprint of the posting key) everywhere a user appears: order cards, chat bubbles, feedback rows, profile headers. Phase 1 ships the component; Phase 3/4 use it. | 3–4 | Medium (consistency + anti-spoofing) | still open |
| 15 | Add `/vs` or `/comparison` route that expands the `vs_others` FAQ answer into a proper side-by-side table (Morphit / LocalBitcoins / LocalMonero / Haveno / Retoswap) with checkmarks. Strongest form of the comparison pitch. | 3+ | Low (FAQ covers it; this is polish) | still open |
| 16 | WhaleVault + Gravity browser-extension integration — signing path that delegates to the user's extension so active/owner keys never touch Morphit's memory at all (strictly stronger than the JIT-unlock fallback). Fallback to password-unlock keystore remains for users without an extension. | 4 | High (matches standard Blurt UX; raises the security floor) | still open |
| 17 | Posting relay must expose a `create_account_v1` endpoint: accept an owner-signed `account_create` op from the user, pay the Blurt RC cost, broadcast it. Relay never sees the user's keys; the user signs locally with their owner key (via `useOwnerKey`). | 2 | High (prerequisite for first-time account creation) | **deferred to Phase 3** — relay is a separate Go service; frontend-only Phase 2 can't ship it. Placeholder `morphit-relay-unregistered` in `$net/config.ts` until the real account and service exist. |
| 18 | BLURT listing-fee path: wire `useActiveKey()` into the order-posting flow. Phase 3's order-post UI prompts for the user's keystore password, signs the Blurt `transfer` op JIT, and broadcasts via the payment relay. BTC/XMR paths sign nothing Blurt-side. | 3 | High (fee path depends on JIT unlock being wired up) | still open — no orders yet to wire up against |
| 19 | Phase 2 threat-model addition: the JIT-unlock pattern reduces exposure but a malicious extension/tampered page in the same origin *could* observe the password at the prompt and then call `useActiveKey` themselves. Mitigation: WhaleVault/Gravity integration (item 16) which moves signing outside the page origin. Documented in SECURITY.md as a known v1 limitation. | 4 | Medium (design-level defense-in-depth) | ADR 0002 published; SECURITY.md entry added in Phase 2 |
| 20 | **Endpoint-rotation client** (`$lib/net/endpoints.ts`) — Phase 2's counterpart to the service-worker precache. Seeded with a list of community indexers (clearnet, .onion, .loki, .b32.i2p). Refreshes from the Blurt release-discovery op. Picks a working endpoint on boot; fails over if the selected one errors. User can pin/unpin endpoints from Settings. | 2 | High (the "no runtime dependency on morphit.io" promise depends on this) | **closed** — initial pool hardcoded; chain-based refresh deferred to Phase 3 alongside the release-discovery op |
| 21 | **Update UI**: a non-intrusive banner ("New version available — Review changes") that calls the service worker's `CHECK_UPDATE`/`APPLY_UPDATE` protocol after user consent. Phase 1 ships the SW-side plumbing; the banner is Phase 2/3. | 2–3 | Medium (otherwise users never get updates post-install) | **closed** |
| 22 | **Keccak-256 checksum validation for XMR addresses.** Phase 1 rejects XMR inputs by prefix+length+alphabet, which catches typos and wrong-chain pastes with very high probability but not all bit-flips. Phase 5 bundles a tiny Keccak-256 (monero-javascript's is ~2KB minified) for full checksum verification. | 5 | Medium (defense-in-depth; current checks are strong enough for product launch) | still open |
| 23 | **APK / F-Droid / Flatpak build pipeline.** Capacitor or Tauri-Mobile shell around the existing SvelteKit bundle. Signed with a release key whose fingerprint is pinned in the Blurt release-discovery op. F-Droid listing with reproducible-build metadata. Completes the story of "install a Morphit client without ever touching morphit.io". | 5 | High (credibility of the unstoppability claim) | still open |
| 24 | **Settings → forget remembered addresses.** The UI path to call `forgetAll()` — a single button per currency + a "Forget everything" option. Phase 1 ships the data-layer function; the button is Phase 2/3. | 2–3 | Low (nicety, not required for correctness) | **closed** |

No blockers for Phase 2. **Phase 1 signs off.**

---

## Revision log

- 2026-04-17 — Blurt core dev confirmed: `custom_json` ops are immutable at
  the protocol level; only `comment` ops are editable. Plan v1.3 updated:
  "15-min edit window" → **3-min replace window via layer-2 op**. The
  3-minute figure replaces 15 not just because of the immutability fix but
  also because the original 15-minute figure was a latent attack vector
  for bait-and-switch. All 7 locales updated; new `morphit_order_replace_v1`
  op specced for Phase 3.
- 2026-04-17 — Added display-name feature: `profile.ts` with anti-spoofing
  validation (control chars, zero-width, bidi overrides); `IdentityLabel`
  component rendering `Name (BLT7gHu8mn…A9bb)` where the fingerprint is
  the user's **posting** public key (the one that signs their Morphit
  activity). Users are now always identified by their truncated posting
  key, with the name as a mutable human label. A hover tooltip and copy
  button reveal the full key for verification.
- 2026-04-17 — Added `vs_others` FAQ entry across all 7 locales: honest
  comparison against LocalBitcoins, LocalMonero, Haveno, and Retoswap on
  arbitration, escrow, PFS, and decentralization.
- 2026-04-17 — **Origin decoupling, Phase-1 piece.** Service worker
  rewritten to precache every asset SvelteKit emits (`build + files +
  prerendered` from the `$service-worker` module), serving them cache-
  only to eliminate the origin dependency after install. Update policy
  changed to pin-on-install with `APPLY_UPDATE` message for user-
  consented upgrades. `svelte.config.js` now auto-registers the worker.
  This is the Phase-1 foundation for running Morphit entirely from
  hidden-network mirrors post-install; the endpoint-rotation client
  (Phase 2) and the APK distribution (Phase 5) finish the story.
- 2026-04-17 — **Receiving-address validation + reuse protection.**
  New `addressValidation.ts` (pure-TS Base58Check + Bech32 / Bech32m +
  Monero base58 alphabet + length + prefix checks; no runtime deps).
  `CryptoAddressInput.svelte` with rotating placeholder, live validation,
  blur-time errors, type-badge, and amber soft-warning on BTC reuse.
  `addressMemory.ts` tracks reused addresses via SHA-256 hashes in
  localStorage — never plaintext. XMR policy: subaddresses only (prefix
  8), standard and integrated addresses hard-blocked with specific error
  messages. BTC policy: all mainnet formats accepted, reuse is a soft
  warning the user can override. All strings translated across 7
  locales; new FAQ entry `why_fresh_addresses` explains the why.
- 2026-04-17 — **Key-handling policy hardened.** Running sessions now hold
  posting + memo private keys only; owner + active live exclusively in the
  encrypted keystore. `keygen.ts` rewritten with two distinct types —
  `FullIdentity` (transient, persistence-only) and `LiveIdentity` (session,
  posting + memo only). `toLiveIdentity()` zeroes owner/active privates on
  strip. `keystore.ts` added `useActiveKey()` and `useOwnerKey()` —
  callback-based just-in-time unlock with `finally`-guaranteed wipe on
  success or exception. Fingerprint format fixed to `BLT` + 6 head + 4
  tail. Onboarding + import routes migrated; tests expanded to verify the
  invariant at every layer (live-only after strip, JIT wipe on success,
  JIT wipe on exception, JIT refusal on wrong password).
