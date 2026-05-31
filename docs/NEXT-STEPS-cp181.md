# Where Morphit goes next — post-cp181 review

**Written:** 2026-05-30 (cp181, fresh-session deep review of the cp180 handoff tarball).
**Audience:** the next session and the incoming sysadmin.
**TL;DR:** the repo is launch-ready by every gate that can be checked in this
environment. There are no open code defects. Every remaining standing item is
*externally* blocked — it needs real Blurt chain access, a deployment host, or
an independent reviewer — and none of it blocks launch. This review made three
small "handoff-hygiene" fixes (below) and nothing else needed fixing.

---

## 1. Health snapshot (this review)

Re-verified directly this session:

- **TypeScript / Svelte:** `workspace-typecheck-smoke` is the authoritative gate
  — 8/8 compile-clean (`tsc --noEmit` across the seven TS projects + `svelte-check`
  on `apps/web`). `apps/web` svelte-check is **0 errors / 0 warnings**.
- **From-source build** (the path a sysadmin actually runs): `apps/ops-cli`
  builds to a single-shebang esbuild **ESM** bundle with the `createRequire`
  banner intact (the cp178 ship-blocker fix), and `apps/mcp-server` builds clean
  via `tsc`. `compiled-bundle-smoke` 7/7, `mcp-server-smoke` 8/8 after build.
- **Smoke suite:** every runnable smoke passes. The **one** smoke that cannot run
  in this sandbox is `vitest-must-pass-smoke`, and only because it needs the
  native `better-sqlite3` build, which can't compile here (the sandbox can't
  fetch Node headers). This is an environment limit, **not** a code defect — it
  matches the repo's own recorded "265/266". See §4.1 for how to close it.

No gate regressed. No locale-parity gap. No stale-claim drift beyond what cp179
and cp180 already swept.

## 2. What this review changed (cp181 — handoff hygiene only)

All three are internal plumbing / docs (logged in `REVISIT-LIST.md` + `TARBALL.md`,
intentionally **not** the brag list). All verified, no regressions.

1. **`scripts/package-files-exist-smoke.ts`** — its first invariant hard-failed on
   a *fresh extract* because the `dist/` build outputs for `apps/mcp-server` and
   `apps/ops-cli` aren't present until the operator builds — i.e. it failed on the
   exact state a sysadmin receives at handoff, while invariant 2 already treated
   `dist/` as "buildable but not yet built". Gave invariant 1 the same carve-out
   (a `files` entry that is a `dist/` output is accepted when the workspace has a
   `build` script). Negative-tested: a missing `LICENSE` still fails (the
   F-mcp-30 protection is preserved). Now 3/3 both pre- and post-build.
2. **`apps/ops-cli/scripts/build.mjs`** — an operator's first `npm run build`
   printed five scary `▲ WARNING Unrecognized target environment "ES2023"` lines.
   These are harmless (esbuild reads the TS `target` from tsconfig but ignores it
   because the build pins `target:'node22'`), but they look like a real problem on
   a first run. Silenced exactly that message id via `logOverride`. Behaviour- and
   byte-neutral; `tsc` remains the authoritative tsconfig validator.
3. **`README.md` "Running an instance"** — the quick-start jumped from `npm ci`
   straight to `npx morphit-ops init` with no build step, so anyone following only
   the README left the web app unbuilt (nginx serves nothing). Inserted the build
   step (`npm run build --workspaces --if-present`, now step 4 of 7), matching the
   authoritative `docs/RUN-A-MORPHIT-NODE.md`.

## 3. The open backlog — and why none of it blocks launch

Everything below is tracked in `REVISIT-LIST.md`; this is the honest summary.

- **noble-signer cutover (`docs/adr/0046-elliptic-signing-migration.md`).** The
  `@noble/secp256k1` Blurt signer is already *wired and flag-gated* behind
  `SIGNER_BACKEND` (default still `dblurt`). The in-sandbox half is proven: a
  noble-signed transaction recovers to the correct public key over real tx digests
  (graphene chains verify by key-recovery, so byte-identical equivalence with
  dblurt's elliptic output is explicitly *not* the invariant). The cutover gate is
  one real Blurt chain broadcast of each op-class to confirm acceptance end-to-end
  — and the sandbox has no chain. Until then, `elliptic` stays in-tree (transitive
  via dblurt) and its `CVE-2025-14505` is documented accepted-risk in
  `SECURITY.md`. **Explicitly not a pre-launch blocker.** Also worth watching:
  dblurt upstream shipping a noble-based signer would be lower-effort than
  maintaining the flag path.
- **Deployment-gated audit batch (`docs/AUDIT-ITEMS-95-110.md`)** and the pending
  **independent third-party security review (`docs/AUDIT-OUTSIDE-SCOPE.md`)**.
  These need a staging deploy and an external reviewer respectively. Honest launch
  line, already adopted in the docs: *"extensively self-audited; independent review
  pending."*
- **Infra standup — Ansible VM + Forgejo runner.** The `ops/ansible/` role and its
  `ansible-structural-smoke` are written and pass statically (69/69), but they need
  a real host to exercise end-to-end. The Forgejo runner is also what runs the full
  `scripts/run-smokes.sh` including the `better-sqlite3`-backed vitest the sandbox
  can't — so this item and §4.1 are the same standup.
- **`matrix-bot-sdk` transport swap — deliberately deferred.** The bot is
  send-only, binds loopback for its health check, and ingests no inbound Matrix
  events, so the `request`-chain advisories are below the threat bar and the
  upstream pin is unfixable. Revisit *only if* the bot ever grows an inbound /
  command surface.

## 4. Recommended sequencing

In priority order:

### 4.1 Run the full suite on a built tree (highest value, unblocks the most)
Stand up the Forgejo runner — or any box where the `better-sqlite3` native module
compiles — and run `bash scripts/run-smokes.sh` triple-pulse, **including**
`vitest-must-pass-smoke`. That is the single check this sandbox cannot exercise,
so it's the last verification gap before launch. (CI run #492 is precedent for the
runner catching things a sandbox misses — it surfaced the cp176 regex / brag-budget
/ locale-line issues.)

### 4.2 noble cutover when chain access exists
Follow ADR-0046: set `SIGNER_BACKEND=noble`, broadcast one of each op-class against
the real chain, confirm acceptance, then promote noble to default and drop
`elliptic`. Alternatively, adopt a dblurt noble release if one lands first.

### 4.3 Stand up the parked infra
Provision the Ansible VM and exercise the `ops/ansible/` role end-to-end on a real
host (it's only ever been validated statically). This is the same standup as 4.1.

### 4.4 Walk the launch docs
With 4.1 green and an independent review underway, walk
`docs/PRE-LAUNCH-CHECKLIST.md` (805 lines) → `docs/LAUNCH-DAY.md` (470 lines).

## 5. What this review did *not* find (so the next person doesn't re-hunt)

No code defects. No gate regressions. No locale-parity gaps. No stale-claim or
terminology drift beyond what cp179/cp180 already corrected (Mana-vs-RC, the
Blurt account regex, the Forgejo-only and Matrix MXID-vs-room invariants all
hold). The three cp181 fixes were the only actionable items, and all three were
handoff hygiene — the things a fresh operator trips over on first contact, not
correctness bugs.
