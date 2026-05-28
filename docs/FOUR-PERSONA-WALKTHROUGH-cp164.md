# Four-persona walkthrough — cp164

Re-walk of the four standing personas against every checkpoint that
landed since the last full walkthrough at cp148: cp149 through cp163.
That is fifteen checkpoints worth of surface change, including the
operator install-fragility class (cp161/cp162) which fundamentally
reshaped Sally-operator's first-run flow — so this walkthrough centers
on her.

The four personas (unchanged from cp148):

- **Bob** — multi-login Blurt user (existing Blurt account, lives in
  the chat + orderbook + reputation surface).
- **Sally-user** — no crypto experience, the onboarding path.
- **Sally-operator** — runs a Morphit node, from any `.md` documentation,
  every CLI/screen/button, launch → week 1.
- **Charlie** — AI agent using the MCP server.

Material checkpoints since cp148 (the ones that touch persona-observable
surface; others are below-the-persona-line):

- **cp149** — mcp-server read-only invariant smoke (Charlie)
- **cp151** — F-mcp-5 response body cap (Charlie)
- **cp154** — F-mcp-1 SSRF defense via `@morphit/net-defense` (Charlie)
- **cp156** — F-mcp-7 root-shell `?then=` support (Charlie + Bob/Sally
  who reach the shell from MCP URLs)
- **cp157** — apps/relay focused audit (no surface change)
- **cp159** — apps/indexer focused audit + new `priceFetchUtil` body
  cap (background; doesn't change persona-observable behavior)
- **cp160** — remaining-workspace audit sweep + doc cleanups
- **cp161** — operator install fix (Sally-operator: tsx→prod-dep,
  Ansible verify task, docs at three entry points)
- **cp162** — ops-cli compiled build (Sally-operator: bin is now a
  launcher shim, compiled `dist/main.js`, fundamentally different
  install/run flow)
- **cp163** — public-surface content pass (everyone: comparison-image
  reward-claim rewording, new `how_to_stake_blurt` FAQ across 10
  locales, Blurt-casing sweep)

---

## Persona 1 — Bob (multi-login Blurt user)

Bob's flow is largely unchanged from cp148.  No code path Bob actually
touches was rewritten in cp149–163.  The changes that surface for him:

### cp163 — FAQ wording + new entry

The casing sweep changed "BLURT" to "Blurt" throughout the FAQ subtree
(1,489 occurrences in 10 locales).  Bob's reads in the FAQ now look
right: prose says "Blurt" (the brand/chain), abbreviation contexts
("Blurt Power (BP)", "BP") preserved.

The new `how_to_stake_blurt` entry slots into cluster 4 right after
`blurt_benefits` — natural reading flow for a Blurt user who clicks
through "what is Blurt" → "what does it get me" → "how do I earn from
it."

### cp140-era assets still present

`ASSET_TICKERS` retains the full 16 tradable assets (BTC, XMR, BLURT,
USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP).
Bob's orderbook filters and balance-card ticker labels still work; the
cp163 casing sweep was scoped to the three content surfaces (FAQ /
brag list / comparison image) and did NOT touch `ASSET_TICKERS` or
UI ticker labels.

### cp159 indexer price-feed audit

Internal hardening only.  The composite chain (Klingex + Coingecko +
morphit-native + static floor) that produces the prices Bob sees is
unchanged in semantics — cp159 added a shared `priceFetchUtil` body cap
to harden the *fetch path*, not the prices themselves.

### Bob's standing functionality verified

The automated `persona-walkthrough-smoke` (170 scenarios) covers his
high-traffic touchpoints.  Run this checkpoint: **170/170 pass**.

✓ **Bob's walkthrough: zero regressions; cp163 FAQ wording change
surfaces naturally; cp159 price hardening is below his persona line.**

---

## Persona 2 — Sally-user (no crypto experience)

Sally's flow is largely unchanged.  cp163 directly improves her
onboarding experience:

### cp163 — comparison image she sees before signing up

The pre-signup comparison image (morphit-comparison.png, hot-linkable
from blog posts) now shows the rewards rows as user-positive claims:

- "All users earn financial rewards on trading milestones"
- "Instance operators earn 90% of Blurt-paid listing fees"
- "All users earn ~2% interest on staked Blurt"

The previous wording ("Loyalty milestones and trader achievements",
"Operator earns ~2% on idle treasury while users trade") read as
operator-skewed; the new wording correctly emphasizes that the
financial rewards accrue to users.  Accuracy: the 90% is for
**Blurt-paid listing fees**, not "all trading fees" — Morphit is
non-custodial P2P, there is no per-trade fee.

### cp163 — staking FAQ for first-time stakers

`how_to_stake_blurt` (added to all 10 locales) walks her through power-
up via BlurtWallet.com — the lowest-friction path she could take.  The
entry mentions APR explicitly so users searching "APR" find it
(added during this cp164 walkthrough — the original draft only said
"interest a year").

### cp163 — Blurt casing in her reads

The FAQ subtree consistently uses "Blurt" in prose.  "BLURT Power
(BP)" reads as "Blurt Power (BP)" everywhere.  She'll never see a
weird mixed-case "Blurt" in one sentence and "BLURT" in the next.

### Sally-user's standing functionality verified

The `sally-walkthrough-smoke` (22 scenarios) covers her onboarding
touchpoints.  Run this checkpoint: **22/22 pass**.

✓ **Sally-user's walkthrough: cp163 directly improves what she reads
before signing up; comparison-image claims now lead with user-positive
framing; staking FAQ closes the "how do I earn from BP?" question
discoverably.**

---

## Persona 3 — Sally-operator (CENTERPIECE)

Sally-operator's surface changed the most.  cp161 + cp162 fundamentally
reshaped how she installs and runs `morphit-ops`.  The walk below
exercises every step she takes from a fresh clone through week-1
operations.

### S-OP-1: fresh-clone install (manual path)

She follows `docs/RUN-A-MORPHIT-NODE.md`:

```
git clone …morphit
cd ~/morphit
npm install
npm run build --workspaces --if-present
```

**Found and fixed during this walkthrough:** the manual install
block at line 731-735 previously read `npm run build` (no
`--workspaces --if-present`).  There is no root `build` script — that
command fails with "missing script: build."  Sally would have hit
"why won't the build run?" on a fresh install.  Replaced with the
correct cross-workspace form (same command Ansible runs), so the
manual and automated paths produce identical artifacts.  The
explanatory paragraph below the block was also updated to describe
what each workspace produces (web build, ops-cli compiled bundle,
mcp-server build) — since the new command actually does all three.

She now sees: web app built, ops-cli compiled to `dist/main.js`,
mcp-server compiled to `dist/main.js`.  Total install + build: ~5–10
minutes ("make tea," the doc says).

### S-OP-2: first `npx morphit-ops init`

After cp162, the published `bin` is a launcher shim
(`apps/ops-cli/bin/morphit-ops.mjs`) that:

- Runs `dist/main.js` under plain `node` when present (compiled, fast,
  no tsx) — Sally's path after the build.
- Falls back to running `src/main.ts` via tsx if dist is absent —
  Sally's path if she skipped the build.

Verified in walkthrough:

- Path A (dist present, after `npm run build`): exit 0, prints
  the usage banner.
- Path B (dist absent, build skipped): exit 0, prints the usage banner
  via the tsx fallback.

Either way `npx morphit-ops init` works.  The cp162 launcher shim
is what makes the cp161 install failure unable to silently regress.

### S-OP-3: the "command not found" trap

If Sally runs `npx morphit-ops --help` from outside the repo or before
`npm install`, npx falls through to the public registry and she sees:

```
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/morphit-ops
```

Documented defense (verified during walkthrough):

- The inline note where she first reaches for the command (now at
  ~line 1246 of RUN-A-MORPHIT-NODE.md) leads with the **verified**
  primary cause (run from outside the repo, or `npm install` not run
  yet).  cp161-verify already corrected §12 to lead with this cause,
  but the inline note at the first-invocation site still emphasized
  "git pull without npm install" — corrected during this walkthrough
  to match.
- OPERATIONS.md §33 and RUN-A-MORPHIT-NODE.md §12 both have the full
  troubleshooting block, both ordered: directory cause first, stale-
  symlink-from-pull cause second.
- `ops/ansible/morphit-sysadmin-handoff.txt` carries the same
  troubleshooting for the Ansible operator path.

### S-OP-4: Ansible path (alternative to manual)

She runs the playbook.  cp161/cp162 changes she would observe:

- `clone_and_build.yml` now builds ops-cli via `--workspaces
  --if-present` (the comment correctly describes this; cp161
  corrected the misleading "ops-cli has no build script" comment).
- The post-install verify task uses
  `npm exec --offline --workspace apps/ops-cli morphit-ops -- --help`
  — cp161-verify replaced the weaker `npx --no-install` (which still
  does a registry lookup, not truly offline) with the genuinely-
  offline form (`ENOTCACHED`).
- If anything is wrong, the play fails LOUDLY at deploy time, not
  silently leaving her with a broken CLI to discover at first use.

### S-OP-5: week-1 operations

She runs the standard week-1 subcommands.  All resolve under the
shim regardless of whether she built the compiled bundle:

- `morphit-ops init` (first-time setup wizard) ✓
- `morphit-ops register` (publish operator registration on-chain) ✓
- `morphit-ops edit` (re-prompt origin / alt-DNS / SEO) ✓
- `morphit-ops status` (operator dashboard) ✓
- `morphit-ops drain-queue` (list pending relay transfers) ✓
- `morphit-ops payment-method` (manage instance-specific payment
  methods, ADR-0021) ✓
- `morphit-ops upgrade` (cp160 + cp161 hardened the upgrade fetch
  path; available as `--check-only`, `--yes`, `--json` flavors) ✓

`morphit-ops init --check-only` produces a clean actionable system-
check report and exits gracefully (the cp161-verify hardening
verified this; nothing in cp162 changed it).

### S-OP-6: the install-invariants + compiled-bundle smokes

The two smokes from cp161/cp162 lock the install contract so this
class of failure can't silently regress:

- `install-invariants-smoke`: 9 scenarios.  Tamper-tested in cp161-
  verify (reverting tsx→devDep + verify→npx --no-install fires the
  right 2 scenarios).  Updated in cp162 for the shim model.
- `compiled-bundle-smoke`: 6 scenarios.  Builds dist + verifies it
  runs under plain node + single-node-shebang regression guard.
  Tamper-tested in cp162 (the double-shebang bug I actually hit
  during the build).

### Sally-operator's standing functionality verified

- All 9 install-invariants scenarios pass.
- All 6 compiled-bundle scenarios pass.
- The manual flow: install → build → init → register → status all
  work end-to-end in the sandbox.
- The Ansible flow: build task + verify task wired correctly per
  ansible-structural-smoke (69/69 checks).

**Findings this walkthrough caught (now fixed):**

1. Manual install block told her to run `npm run build` at root, which
   fails (no root build script).  Replaced with the correct
   `npm run build --workspaces --if-present`.
2. Inline command-not-found note at her first ops-cli invocation
   still led with "git pull without npm install" as the primary
   cause; corrected to lead with the verified primary cause
   (running from outside the repo).

✓ **Sally-operator's walkthrough: the cp161/cp162 install-fragility
class is verifiably closed end-to-end across both the manual and
Ansible paths; two additional doc footguns found and fixed during
this walk.**

---

## Persona 4 — Charlie (AI agent via MCP)

Charlie's surface changed materially in cp149–cp156.  All changes
are hardening; none change the tool surface he sees.

### cp149 — read-only-by-construction invariant

`scripts/mcp-server-read-only-invariant-smoke.ts` proves the MCP
server cannot mutate state by construction:

- No signing/mutation primitives imported anywhere in
  `apps/mcp-server/src/`.
- No mutation-API symbols from `@morphit/{indexer,relay}-client`.
- No raw `fetch()` calls outside indexerClient.ts (all network calls
  routed through `fetchJson` which has the body cap, SSRF defense,
  etc.).

3/3 scenarios pass.  Charlie's tools are read-only by construction,
not just by policy.

### cp151 — F-mcp-5 fetch body cap

`fetchJson` enforces a maximum response body size, so a misbehaving
or compromised upstream cannot OOM the MCP server.  Body-cap smoke
present and green; smoke scenario covers truncation behavior.

### cp154 — F-mcp-1 SSRF defense

The federation probe was lifted into `@morphit/net-defense`, a shared
package that blocks SSRF against private / loopback / link-local /
metadata-service IPs before any fetch.  Used by both mcp-server (for
cross-instance probes) and ops-cli (for the upgrade-fetch path,
cp160's F-opscli-1).

### cp156 — F-mcp-7 root shell `?then=` support

When MCP tools return URLs like `${base}/?then=/faq`, the root shell
honors the redirect.  Charlie sees URLs like
`https://morphit.io/?then=/faq` and can hand them to a user; the
user's browser lands on the right page even if they're not logged in.

### cp162 build also produces mcp-server dist

When Sally-operator runs `npm run build --workspaces --if-present`,
the mcp-server `dist/main.js` is built alongside ops-cli's.  Charlie's
bin (`morphit-mcp` → `dist/main.js`) is therefore always present
after a normal install.

### Charlie's standing functionality verified

- `mcp-server-read-only-invariant-smoke`: 3/3
- `fetchjson-body-cap-smoke`: passes in battery
- `mcp-server-smoke`: passes in battery
- `private-instance-policy-smoke`: passes in battery
- `node apps/mcp-server/dist/main.js --help`: exit 0

✓ **Charlie's walkthrough: cp149-156 hardening completed without
changing his tool surface; the MCP server is more defended than it
was at cp148 and still does exactly what he expects.**

---

## Cross-persona infrastructure verified

These touch all four personas indirectly:

- **Triple-pulse smoke battery:** 6261/6261/6261, 0 failures, stable
  at cp163.
- **TypeScript:** 0 errors × 12 projects.
- **i18n locale parity:** 10/10 locales × 3097 keys.
- **All FAQ smokes:** themed-section / search-grandma-coverage /
  jsonld-no-markdown / per-tradable-asset-parity — all green.
- **Comparison + mediakit freshness:** both regenerated, both green.

---

## Walkthrough findings summary

Two real doc footguns caught during this walk (both Sally-operator
related, both fixed):

1. **RUN-A-MORPHIT-NODE.md line 734:** manual install instructed
   `npm run build` at the repo root.  No root build script exists →
   "missing script" error.  **Fix:** replaced with
   `npm run build --workspaces --if-present` + explanatory paragraph
   updated to describe what each workspace produces.

2. **RUN-A-MORPHIT-NODE.md line ~1246 (inline at first morphit-ops
   invocation):** the inline command-not-found note still led with
   "git pull without npm install."  cp161-verify already corrected
   §12 to lead with the verified primary cause (directory) but
   missed this inline note.  **Fix:** rewrote to match the §12
   cause-ordering.

One small enhancement caught:

3. **Staking FAQ APR keyword:** the `how_to_stake_blurt` entry said
   "2% interest a year" but didn't use "APR."  A user searching
   specifically for "APR" wouldn't match this entry.  **Fix:** added
   "(APR)" parenthetically in all 10 locales.

Net effect on Sally-operator's experience: tomorrow's install is now
covered against one more documented failure mode (the missing-root-
build-script error) that the cp161/cp162 work hadn't surfaced because
the existing chats focused on the Ansible path and the cp162
launcher-shim semantics, not on the manual `npm run build` step.
