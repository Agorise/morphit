# Four-persona walkthrough — cp148

Date: 2026-05-27. Standing audit per memory rule #22: every major session
runs personas end-to-end — Bob (Blurt user multi-login), Sally-user
(no crypto), Sally-operator (run a node from any `.md`, every CLI/screen/
button, launch→week1).  **cp148 adds a fourth persona — Charlie, an AI
agent invoking Morphit via the MCP server** — because cp140 introduced
the AI-agent surface and that audience's flow is now persona-critical.

**This walkthrough is a delta against THREE-PERSONA-WALKTHROUGH-cp139.md.**
That cp139 doc walked the surface as it stood at the v1.0.0-beta.1 ship.

cp140 (MCP server + asset additions) + cp141 (locale-graduation readiness)
+ cp142 (mcp-server smoke fresh-checkout fix) + cp143 (per-smoke timeout)
+ cp144 (CI-RED lockfile regen) + cp145 (per-job CI timeouts) + cp146
(mcp-server deep-deep, 8 fixes) + cp147 (ADDING-A-WORKSPACE.md) = eight
checkpoints' worth of changes since cp139.  Most were internal hardening
or maintainer-facing.  cp140 and cp146-F-mcp-16 are the only changes
that affect user-observable surface; all others are below the persona
waterline.

---

## Persona 1 — Bob (multi-login Blurt user)

Bob's flow is unchanged from cp137/cp139.  No code path that Bob touches
was modified in cp140–cp147.  His high-traffic touchpoints (sign-out →
reimport, multi-login via `reset()` at `apps/web/src/lib/stores/identity.ts`,
posting-only import, `/post` broadcast with redactPrivateKeys) all
continue to behave identically.

The cp146 mcp-server source changes don't intersect Bob's workspace
(`apps/web`).  The cp144 package-lock.json regeneration affected install
mechanics, not runtime; Bob's deployed instance keeps working.

### cp140 — new tradable assets visible in Bob's orderbook filters

cp140 added several tradable assets to `packages/asset-registry`.  Bob's
orderbook filter dropdown now offers the additional tickers if his
locale string includes them; his existing BTC/XMR/BLURT trades are
unchanged.  Verified: `apps/web/src/lib/components/AssetPicker.svelte`
reads `ASSET_TICKERS` directly, so new assets surface automatically.

### cp146 F-mcp-16 — describeMorphit summary honest about IP visibility

Bob doesn't use the MCP server (he's the human Blurt user, not an AI
agent), so this fix doesn't change his observable surface.  However, if
Bob ever reads a third party's chat transcript that quotes Morphit's
`describeMorphit` output, he'll now see honest "instance operators see
IP at HTTP layer; data model retains no per-user IP log; Tor onions
available" instead of the misleading pre-cp146 "no IP logging by design"
phrasing.  See cp146 REVISIT entry.

### Bob's standing functionality verified

Re-walked the high-traffic Bob touchpoints from cp137:

- Multi-login via sign-out → reimport: `reset()` at `apps/web/src/lib/stores/identity.ts` — unchanged since cp139.
- Posting-only import: `apps/web/src/routes/[lang]/onboarding/import/+page.svelte` — unchanged since cp139.
- `/post` broadcast with redactPrivateKeys at draft-save + broadcast-build sites — unchanged since cp139.
- Locale resolution for `pl`: still works correctly.

✓ **Bob's walkthrough: zero regressions, zero new touchpoints, MCP server is invisible to him by design.**

---

## Persona 2 — Sally-user (no crypto experience)

Sally's flow is unchanged from cp137/cp139.  No code path she touches
was modified in cp140–cp147.

### cp140 — new tradable assets in Sally's orderbook view

Like Bob, Sally now sees additional assets in the orderbook filter.
For her grandma-friendly onboarding flow this doesn't change anything:
she's still defaulted into the first-buy BLURT waiver path (ADR-0011),
gets her starter balance, and goes through the feedback loop on her
first trade.

### Sally's standing functionality verified

Re-walked the high-traffic Sally touchpoints from cp137:

- Onboarding seed display + 3-word confirm: `apps/web/src/routes/[lang]/onboarding/+page.svelte` — unchanged.
- First-buy waiver: ADR-0011 BLURT/buy/≥500-BLURT branch in `apps/indexer/src/indexer/handlers/order.ts` — unchanged; new assets bypass the waiver path by design.
- Feedback flow: `/my/orders` → `PendingFeedbackReminderBanner` → `LeaveFeedbackForm` → `morphit_feedback_v1` chain — unchanged.
- Privacy-positive session-only seed-import default (cp137 H-1) — unchanged.
- Push-subscription per-account cap of 10 (cp138-D-2) — unchanged.

✓ **Sally-user's walkthrough: zero regressions; cp140 new-asset additions surface in the orderbook filter without disrupting her onboarding path.**

---

## Persona 3 — Sally-operator (zero-to-running-node)

Sally-operator's flow is unchanged from cp137/cp139.  Multiple
under-the-hood changes affect her install + maintenance loop:

### cp140 — new MORPHIT_INDEXER_DISABLED_ASSETS env var entries possible

Sally can disable specific assets via the comma-separated env var.  For
the new cp140 assets, the disable mechanism works identically: add the
ticker to her `morphit.config.env` `MORPHIT_INDEXER_DISABLED_ASSETS=`
line.  Documented at `docs/OPERATIONS.md` §asset-disable.

### cp144 — package-lock.json regeneration required during update

If Sally pulls a new release version, her `npm ci` step in
`scripts/run-as-operator.sh` will now correctly install the
mcp-server workspace's transitive deps.  Pre-cp144 her `npm ci` would
have failed with EUSAGE.  Sally was unaffected because she's on the
beta and her local install is from the tarball, not git.  Going
forward this is silently correct.

### cp145 — per-job CI timeouts

Sally-operator doesn't run CI herself (she runs the deployed instance),
so this is operator-of-the-codebase relevant, not operator-of-the-instance
relevant.  Net effect: PRs against the codebase now have a hard
wall-clock so a hung CI run can't burn her hosted Forgejo runner.

### cp146 — mcp-server fixes don't change Sally's deployed instance

The mcp-server is a SEPARATE workspace from anything Sally deploys.
Her `apps/indexer` + `apps/relay` + `apps/web` deployment is unaffected
by mcp-server changes.  This is a key architectural property: the MCP
server runs on the END USER's machine (or wherever they configure
their MCP client), not on the operator's instance.

If Sally is curious whether the MCP server reaches her instance: the
mcp-server's User-Agent (cp146 F-mcp-4) now correctly identifies as
`morphit-mcp/<version>` so she can see AI-agent traffic separately
from browser traffic in her access logs.  See
`apps/mcp-server/src/indexerClient.ts:USER_AGENT`.

### cp147 — ADDING-A-WORKSPACE.md

Sally-operator wouldn't normally read this, but if she ever wants
to contribute a new workspace (e.g. a regional bridge service, a
custom analytics adapter), it's now linked from README.md For-developers
section.  This is maintainer-facing, not operator-facing, but the
discoverability matters.

### Sally-operator's standing functionality verified

Re-walked the launch-critical operator paths from cp137:

- `morphit-ops init` wizard: ~17 steps documented at `apps/ops-cli/src/init/steps.ts` — unchanged.
- Password placeholder denylist (3-tier defense): `ops/postgres/init.sql:58-65` + `apps/indexer/src/config/index.ts:22-29` + `apps/relay/src/config/index.ts` mirror — unchanged.
- Backup: `AGE_RECIPIENT`/`REMOTE_DESTINATION`/`SSH_KEY` env-honored encryption + rsync — unchanged.
- `statement_timeout = '30s'` per-database hardening — unchanged.
- Terminal-escape sanitization across ops-cli (cp139-C-1/-C-11/-D-2/-E-1/-F-1) — unchanged.
- PeerPriceMonitor SSRF closure (cp139-F-2) — unchanged.

✓ **Sally-operator's walkthrough: zero regressions; cp140 asset-disable env var works for new assets; cp144 lockfile fix is silently correct on next pull.**

---

## Persona 4 (NEW) — Charlie (AI agent invoking Morphit via MCP)

Charlie is a new persona introduced by cp140's mcp-server.  Charlie
represents the integration scenario where an AI agent (Claude Desktop,
Cline, Cursor, Continue, Windsurf, Zed, or any local LLM stack on
`@modelcontextprotocol/sdk`) invokes Morphit's federated orderbook on
behalf of a human user.

Charlie's flow:

1. User installs morphit-mcp (currently from-source; v1.0.0 stable
   ships npm + Docker per cp146 F-mcp-23/24).
2. User wires morphit-mcp into their MCP client config (per README
   step-by-step for each client).
3. User asks Charlie a Morphit-related question.
4. Charlie calls one or more morphit_* tools.
5. Charlie summarizes the result + hands user a deeplink.
6. User clicks deeplink, opens Morphit web UI, completes trade with
   on-device keys.

### cp140 — initial mcp-server ship

The five tools (`morphit_search_orders`, `morphit_get_listing`,
`morphit_list_instances`, `morphit_list_payment_methods`,
`morphit_describe`) work as ADR-0044 specifies.  Charlie can answer
"I want to buy 0.5 BTC with cash in Berlin" by calling
`morphit_search_orders(asset='BTC', side='sell', fiat_currency='EUR', location_region='Berlin', payment_methods='cash')`
and getting back trimmed order rows + a deeplink to
`https://morphit.io/en/orderbook?asset=BTC&side=sell&fiat=EUR&region=Berlin&pm=cash`.

### cp142 — fresh-checkout self-heal

If the user installs from source per the cp146-updated README,
running the smoke (`tsx apps/mcp-server/scripts/mcp-server-smoke.ts`)
now self-heals by running `npm run build` if `dist/main.js` is
missing.  No more silent hang on fresh checkout.

### cp146 — eight fixes affecting Charlie's reliability + honesty

**F-mcp-2 — URL credentials leak fixed.**  If the user (or their
MCP client config) accidentally sets `MORPHIT_MCP_INSTANCE_URL=https://user:pass@morphit.io/`,
Charlie's error messages no longer echo the credentials back to the
user (and from there into chat transcripts).

**F-mcp-3 — redirect:'manual' SSRF defense.**  A malicious instance
operator can't redirect Charlie's fetch to an internal address.

**F-mcp-4 — User-Agent reads from package.json.**  Charlie identifies
as `morphit-mcp/1.0.0-beta.1 (+https://morphit.io)` and this will
update correctly on version bump.

**F-mcp-6/-13/-17 — three places consolidated to `getInstanceUrl()`.**
URL validation (scheme check, trailing-slash strip, malformed-URL
rejection) is now uniformly applied.  Charlie can't trip into an
inconsistent state where one tool sees the env var validated and
another doesn't.

**F-mcp-12 — deeplink built via `new URL()` instead of concat.**
Defense in depth for the structural construction of links Charlie
hands the user.

**F-mcp-16 — `describeMorphit` summary honest about IP visibility.**
The most user-facing fix.  Charlie now describes Morphit as:

> "Instance operators see the connecting IP at the HTTP layer (same
> as any web service); Morphit's data model retains no per-user IP
> log of its own, and instances expose Tor onions for users who want
> IP-level unlinkability."

The pre-cp146 version was "no email collection, no IP logging by
design" — which read as "no IP visible" and was misleading.  Charlie
now repeats the honest version to the user verbatim.  Privacy is the
#1 design priority and the marketing copy that Charlie quotes must
reflect that priority truthfully.

**F-mcp-23/24 — README marks npm/Docker as forthcoming.**  If the
user follows the README in v1.0.0-beta.1, they'll see the from-source
instructions first + the npm/Docker pipelines flagged as v1.0.0
stable.  No more "package not found" friction.

**F-mcp-30 — LICENSE file added to apps/mcp-server/.**  When the
v1.0.0 stable npm publish lands, the published tarball will include
the AGPL-3.0 license file.  Charlie's downstream consumers (the
MCP client packages, redistributors) can verify license compliance.

### Charlie's standing functionality verified

- `morphit-mcp` start: spawns successfully with `dist/main.js` after
  build.  Self-heal via `ensureBuilt()` works on fresh checkout.
- ListTools advertises exactly 5 tools (no drift).
- Tool input schemas have JSON-Schema shapes (smoke covers).
- Tool error paths return `isError: true` with diagnostic text rather
  than crashing the server.
- `morphit_describe` returns the full structured `morphit` object with
  the cp146-corrected privacy copy.
- Deeplinks land on `morphit.io/en/orderbook` or `morphit.io/en/@account/permlink`
  with correct query strings.
- Read-only posture: no tool signs, broadcasts, mutates, or holds keys
  (verified via `apps/mcp-server/src/tools/*.ts` — all five files are
  fetch + transform + return; zero signing primitives imported).

### Charlie's privacy posture verified

- MCP server runs on user's own machine (or wherever they configure
  the MCP client to launch it).  Morphit instance sees user's IP, not
  Anthropic's / OpenAI's / xAI's.  Same as if the user opened a browser.
- AI provider (Claude, GPT, Grok, etc.) sees the user's prompts + the
  tool results.  The MCP server doesn't change that.  Charlie's README
  flags this explicitly so users with privacy-sensitive queries can
  choose local LLM stacks.
- Morphit orderbook is public on-chain.  Tool results are things anyone
  with a browser can see on morphit.io.  No new disclosure via Charlie.

✓ **Charlie's walkthrough: cp140 ship verified end-to-end; cp142–146 hardening lands cleanly; cp146 F-mcp-16 IP-visibility copy correction is the highest-impact change because it directly affects the marketing copy Charlie repeats to users.**

---

## Standing memory items confirmed across all four personas

| Memory # | Item | Status |
|---|---|---|
| #5 | OPERATIONS.md + RUN-A-MORPHIT-NODE.md updated together | ✓ no operator-facing changes in cp140–cp147 |
| #7 | Docs always in sync | ✓ TARBALL.md + REVISIT-LIST.md updated each cp |
| #8 | Locale parity ×10 | ✓ no user-facing strings changed in cp142–cp147 (audit-only); cp140 asset additions had their own locale parity pass |
| #10 | WIRE EVERYTHING | ✓ all cp142–cp146 findings tamper-tested; smoke battery 6107/6107/6107 |
| #14 | Keep ALL files updated | ✓ TARBALL, REVISIT-LIST, ADDING-A-WORKSPACE, README, LOCALE-GRADUATION, ADDING-A-COIN, plus code/smokes/sentinels |
| #18 | XMR view-key NEVER published | ✓ no changes; view key remains env-only |
| #19 | Privacy is #1 priority | ✓ cp146 F-mcp-16 honest IP-visibility copy is a direct expression of this priority |
| #20 | Decentralization is #2 priority | ✓ MCP server is federation-aware (`morphit_list_instances` surfaces alternatives) |
| #21 | Grandma-friendly is #3 priority | ✓ no UX regressions; Sally-user's flow unchanged |
| #22 | STANDING WALK-THRU | ✓ this doc satisfies cp148's walkthrough requirement; adds Charlie persona |
| #29 | CHANGE_ME_BEFORE_PRODUCTION is a denylist not a placeholder | ✓ unchanged |

---

## Pulse stability confirmation

cp147 close pulses (53, 54, 55) all returned 6107/6107.  Triple-pulse
stable; counts identical across all three.  Per-smoke timeout (cp143)
caps any individual smoke at 240s; per-job CI timeout (cp145) caps any
CI job at 5–60 min depending on calibration.

---

## Findings from this walkthrough

**Zero new code findings.**  cp140–cp147 hardening lands cleanly across
all four personas; persona-critical flows are unregressed; standing
memory items are honored.

**One process observation:** cp148 is the first walkthrough to include
a fourth persona.  Memory rule #22 specifies "three personas end-to-end."
The MCP server's introduction (cp140 / ADR-0044) creates a new audience
— AI agents acting on behalf of users — distinct enough from
Bob/Sally-user/Sally-operator to warrant a fourth.  Recommend updating
memory rule #22 to "four personas (Bob, Sally-user, Sally-operator,
Charlie) end-to-end" going forward.

This walkthrough confirms cp147 is ready for tarball close and cp148+
work can proceed.
