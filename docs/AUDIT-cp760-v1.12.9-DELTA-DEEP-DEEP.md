# Morphit — cp760 DELTA deep-deep (v1.12.8 → pending v1.12.9 bundle)

Status legend: ⬜ not started · 🔄 in progress · ✅ CLEAR · ⚠️ finding open · 🟢 finding fixed

**Scope.** A delta deep-deep over the staged v1.12.9 surface only — cp752
(`.shipped` verify.json exclusion), cp754 (canary auto-restore on upgrade),
cp755 (tor-only = hidden-only indexer RPC), cp756 (VAPID subject tor-only
derivation), the onion-wrap UI, cp757/758 (docs), and cp759 (the smoke fixed
this session). Each code change black-hatted across injection, authz, privacy,
input-validation, DoS/rate-limit, data-integrity, error-handling, races,
resource-leaks, i18n, backward-compat, and a11y. The bundle's THEME is the
tor-only clearnet-IP-non-leak invariant, so the audit extended one hop into the
adjacent outbound-fetch surfaces that share that invariant.

**Gate state at audit time.** workspace-typecheck 27/27 · web svelte-check 0/0 ·
vitest (web 1127 / relay 250 / ops-cli 40 / indexer 714) all green · full
run-smokes battery 19,593/19,593 after cp759 · version-consistency 20/20 (1.12.8)
· i18n 10 locales × 3447 keys. ansible-lint NOT run here (unavailable in the
review sandbox — must run in the cut env).

---

## Delta surface — CLEAR

### cp752 — `.shipped` excluded from verify.json hashing ✅ CLEAR
`scripts/build-verify-json.mjs` skips `rel === 'verify.json' || rel === '.shipped'`.
The exclusion is EXACT-MATCH on the two top-level entries only: `verify.json`
(can't hash its own content) and the inert `.shipped` build marker (zero-content
signal touched by release.yml, never a served/executed asset, not in the SvelteKit
manifest). A `foo/.shipped` or `.shipped.js` would still be hashed (rel differs),
so no served/executable asset can escape the manifest by name. The determinism
rationale holds — excluding the marker makes every instance's manifest
byte-identical regardless of deploy path, which is exactly what the federated
build-integrity banner needs. No hashing blind spot; tamper anchor intact.

### cp754 — canary auto-restore on upgrade ✅ CLEAR
`apps/ops-cli/src/commands/upgrade.ts` (§9b1). Every child process uses the
array-args `spawnSync` form (`systemctl cat`, `systemctl start`, `getent`,
`sudo -n -u … bash`) — no shell string interpolation, so no command injection
even though this runs as root at upgrade time. Privilege handling is correct:
the system unit is started at root scope; the home-dir fallback DROPS to the
non-root owner via `sudo -n -u <user>` (never runs the operator's script as
root). All three child calls are timeout-bounded (10s/180s/90s → no hang;
`sudo -n` and `GPG_TTY=''` prevent interactive stalls). Failures degrade
gracefully to the reminder via the `canaryAutoRefreshed` flag. `hadCanary`
gates the whole block so a canary is never laid on a box that never served one.

### cp755 — tor-only = hidden-only indexer RPC ✅ CLEAR
Three legs verified coherent: (a) `apps/indexer/src/config/index.ts` refine
relaxed to `arr.every(https)` — empty clearnet allowed, https-if-present, and a
clearnet http:// can't sneak in via the separate hidden knob (host refine
enforces `.onion`/`.i2p`); (b) `apps/indexer/src/blurt/client.ts` enforces the
"≥1 source" invariant over the COMBINED local+clearnet+hidden pool (throws only
if all three empty), so a tor-only node with empty clearnet + baked hidden set is
valid; (c) `ops/ansible/roles/morphit/templates/indexer.env.j2` empties
`MORPHIT_INDEXER_RPC_ENDPOINTS` ONLY under `morphit_tor_only | default(false)`
— a clearnet node's list is untouched. Pool order local→clearnet→hidden. Clean.

### cp756 — VAPID subject tor-only-aware ✅ CLEAR
`ops/ansible/group_vars/all.yml`: clearnet → `https://{{ morphit_domain }}`
(unchanged); tor-only → a `mailto:` from the contact URL when it matches
`^(?i)mailto:.+`, else EMPTY (push cleanly disabled by the relay's
`isValidVapidSubject`, not the old domain-less `https://` that crash-looped).
Combined with the v1.12.5 relay guards, an invalid/empty subject disables push
without crashing. No behavior change on clearnet.

### onion-wrap UI ✅ CLEAR
`about-this-instance/+page.svelte` origin cell gained `break-all`. `origin` is
`window.location.host` (browser-controlled, not user input); Svelte auto-escapes
the `{origin || '—'}` interpolation. Purely visual; no injection surface.

### cp757 / cp758 — docs ✅ CLEAR
OPERATIONS.md §42.0 + RUN-A-MORPHIT-NODE.md notes and grandma pass.
public-doc-drift-smoke 32/32; no dangling refs.

### cp759 — mcp-webpush smoke assertion (fixed this session) 🟢
The stale single-line-quoted assertion was replaced with a block-scalar capture
that verifies BOTH the clearnet origin-derivation AND the `morphit_tor_only`
conditional. 53/53. (Detail in REVISIT-LIST.md pending-bundle list.)

---

## 🟢 FINDING F-1 (FIXED, cp761) — tor-only warrant-canary refresh leaked the node's clearnet IP (privacy / metadata-leak, HIGH)

**This is the same exposure cp755 was created to eliminate, on an unaddressed
outbound path.** cp755 stopped the indexer from reading clearnet RPC on a
tor-only node (which leaked its real IP to those RPC operators — "the exposure
tor-only exists to avoid"). The weekly warrant-canary refresh makes the same
class of direct clearnet fetches, and they were not addressed.

**Evidence.** On a tor-only node the canary refresh (`scripts/canary/generate.sh`,
run by the system `morphit-canary.service`, weekly + `OnBootSec=3min`) performs
three outbound fetches with no Tor routing:

1. **Blurt chain-head** — `scripts/canary/fetch-blurt-head.ts` resolves endpoints
   from `DEFAULT_BLURT_RPC_ENDPOINTS` (@morphit/operator-config, **clearnet**).
   No SOCKS dispatcher is installed in this standalone script.
2. **Bitcoin head** — `scripts/canary/fetch-btc-head.ts` hits clearnet Esplora
   explorers. No SOCKS.
3. **News entropy** — a plain `curl -fsSL` loop over hard-coded clearnet RSS
   feeds (`generate.sh`: BBC, The Guardian, NPR, Al Jazeera, NYT + the default
   Cointelegraph). No `--proxy`; the fallback list runs even if the operator
   pins a `.onion` `MORPHIT_CANARY_NEWS_RSS` (fallbacks are unconditional after
   the operator feed fails).

**Why it's a real leak, not a theoretical one:**
- There is **no transparent OS-level Tor redirect** in the tor/morphit Ansible
  roles (no `TransPort`/iptables `REDIRECT`/`9040`). cp755's very existence — an
  app-layer fix for the indexer's clearnet reads — proves outbound clearnet goes
  direct; a transparent redirect would have caught the indexer too.
- The indexer reaches hidden endpoints via an **app-layer undici dispatcher**
  (`hiddenServiceDispatcher.ts`, `makeSocks5Connector`, Tor 9050 / i2p 4444).
  The canary helpers are separate Node scripts that never install that
  dispatcher, and the news `curl` is a shell subprocess entirely outside Node.
- The canary units carry no `Environment=` proxy, and `generate.sh` has zero
  tor/proxy/tor-only/socks/onion awareness (grep-confirmed).

**Consequence.** Every ~week (and minutes after every boot) a tor-only node
reveals its real clearnet IP to Blurt RPC operators, Bitcoin explorers, and
5–6 news organizations — correlating the .onion service to a clearnet IP. For an
operator who went tor-only *specifically because their network is hostile* (the
morphitlat/Telmex case in the handoff), this defeats the purpose.

**Sharper still:** the canary helpers can't reach hidden endpoints at all today
(no SOCKS routing → an `.onion` override URL won't even resolve). So on tor-only
the canary's only *functioning* path is clearnet — it either **leaks** (clearnet
egress available) or **fails to publish** (clearnet blocked). The "route over Tor
in tor-only mode" intent noted in the handoff was never implemented.

**Recommended remediation (ready to apply, pending one policy decision):**
1. Give `generate.sh` tor-only awareness — e.g. a `MORPHIT_CANARY_TOR_ONLY=1`
   env set by the install (or derive it: `MORPHIT_CANARY_INSTANCE_ORIGIN` host
   ends in `.onion`/`.i2p`).
2. When tor-only, route the news `curl` through Tor with
   `--proxy socks5h://127.0.0.1:9050` (**`socks5h`**, not `socks5`, so DNS is
   resolved proxy-side — a `socks5` scheme would still leak DNS).
3. Give the two Node helpers a SOCKS dispatcher on tor-only — reuse
   `makeSocks5Connector` / `buildHiddenSubDispatchers` from the indexer as a
   shared helper, and default the Blurt-head endpoint set to
   `DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS` (already exported by operator-config)
   for the .onion chain-head; keep clearnet for non-tor-only.
4. Tamper-tested smoke: assert that on tor-only the news fetch carries a
   `socks5h` proxy arg, the helpers install a SOCKS dispatcher, and clearnet
   nodes are unchanged.

**Policy decision for Ken (fail-open vs fail-closed):** on a tor-only node, if
the Tor SOCKS proxy is down at refresh time, should the canary (a) **fail-closed**
— skip publishing rather than fall back to clearnet (never leak, but the canary
can go stale) — or (b) **degrade** the individual proof (as the BTC head already
does) while never touching clearnet? I did NOT implement this unilaterally: the
warrant canary is a legally/politically load-bearing artifact and its
publish-vs-leak behavior is a policy choice, not a mechanical fix. Flagging for
your call; remediation is otherwise ready.

### FIX APPLIED — cp761
Implemented, following the EXISTING per-proof degradation philosophy (which
resolves the fail-open/closed question by precedent) with a fail-safe posture:
**on tor-only every fetch is pinned to the Tor SOCKS proxy with NO clearnet
fallback**, so a down proxy degrades/blocks the canary but can never leak.

- **`scripts/canary/torSocksDispatcher.ts`** (new) — a small, dependency-free
  SOCKS5 connector (`node:net` + undici `Agent`), kept self-contained so the
  operator-auditable canary scripts don't reach into the indexer's internals.
  `installTorDispatcherIfTorOnly()` pins undici's global dispatcher to
  `MORPHIT_CANARY_TOR_SOCKS` (default 127.0.0.1:9050) when
  `MORPHIT_CANARY_TOR_ONLY=1`; **no-op on clearnet** (byte-identical). CONNECT
  uses ATYP=domain so the proxy resolves DNS — no DNS leak.
- **`fetch-blurt-head.ts` / `fetch-btc-head.ts`** — call the installer before
  fetching. The Blurt head stays fatal-on-total-failure (fail-closed for the
  primary proof — a stale canary must not publish); the BTC head still degrades.
- **`generate.sh`** — derives tor-only (explicit `MORPHIT_CANARY_TOR_ONLY` wins,
  else a `.onion`/`.i2p` origin), exports the two env vars for the Node helpers,
  and routes the news `curl` through `socks5h://` on tor-only (empty proxy args
  on clearnet → byte-identical). `.i2p`-only reach is out of scope (Tor is
  installed by default on tor-only nodes, so SOCKS hides the IP for both).
- **Smoke:** `scripts/canary-tor-only-routing-smoke.ts` (27 checks, registered)
  — SOCKS5 wire bytes, installer no-op-on-clearnet vs tor-route, generate.sh
  detection/exports/`socks5h` proxying, and both helpers installing the
  dispatcher. All gate-adjacent canary smokes re-run green.
- **⚠ NOT sandbox-testable end-to-end** (no live Tor daemon here — same class as
  cp750). Validation: on a real tor-only box, run the canary and confirm the
  stderr `route = tor-only (SOCKS …)` lines and that the fetches succeed via Tor
  (or fail-closed if Tor is stopped) — never a direct clearnet connection.

---

## Battery
Full run-smokes battery re-run this session in small chunks (8 chunks of 80):
**19,646 scenarios passed, 0 runners failed.** Per-chunk: 2397 / 4295 / 4902 /
1893 / 1787 / 2032 / 1271 / 1069 — no failures in any chunk. (This is the
post-cp759 tree; the only battery failure this session was the stale
mcp-webpush assertion, fixed in cp759.)
