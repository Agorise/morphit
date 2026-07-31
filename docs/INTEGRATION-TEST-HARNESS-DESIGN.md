# Integration test harness — design

**Status:** Design accepted 2026-04-23. ✅ **Implemented since** —
the integration suite lives at `apps/indexer/test/integration/`
(signals, feedback-suppression, loyalty, migrations, and more).
The decisions + sketch below are the design record for it.

This document records the four operator decisions made during
the REVISIT §A walkthrough on 2026-04-23 and sketches the
implementation shape for the next session that builds it. The
decisions below are ratified; the sketch is a starting point
that the implementation session can refine without re-asking
any of the questions at the top.

## Background

Morphit today has two test tiers:

- **Unit tests** — pure-function tests against mocked inputs.
  Fast, no external dependencies, run on every commit.
- **Integration tests against Postgres** — real-database
  fixtures exercising SQL semantics (BYTEA handling, CHECK
  constraints, ON CONFLICT, etc.). Require Docker locally;
  covered in `apps/indexer/test/integration/`.

What's missing is a **full-chain end-to-end tier**: post a
signed op via the relay → indexer observes the block → API
serves the derived state. This would catch:

- Broken serialization / wire-format drift
- Savepoint / dispatcher bugs that only surface on real chain
  ops
- RPC-client regressions against live Blurt node behavior
- Timing / reorg edge cases unit tests can't reach

The questions below were blocked on operator judgment about
CI cost, chain availability, and secret management. All four
are now decided.

## Decisions

### Q1 — Where do tests post to?

**Decided:** Both, via different invocation paths.

- **Local developer runs:** target a local Blurt instance
  that the test harness spins up (Docker container running
  `blurt-node` in seed-node + witness mode with a single
  signer). Developers running `npm run test:integration:e2e`
  get a reliable, reproducible chain every time. No
  dependency on network reachability or shared-testnet
  state.
- **CI nightly runs:** target the live Blurt testnet. Real
  chain behavior, real reorgs, real latency. Catches drift
  that a local instance would miss (RPC API changes,
  witness behavior changes, non-deterministic ordering).

Local runs are invoked explicitly; CI runs are scheduled.
The test suite itself is **target-agnostic**: it reads chain
and RPC endpoints from env vars and exercises the same
assertions against either.

**Implementation note:** the local Blurt Docker image spec
should be pinned by digest, not `:latest`, so developer
runs don't drift under us.

### Q2 — How is the chain seeded?

**Decided:** Known-good block export, restored before each run.

Rebuilding chain state from genesis per test takes minutes
and adds non-determinism. Instead:

1. Maintain a reference chain export at
   `test/fixtures/blurt-chain-seed.bin` (or similar). This
   is the state snapshot every integration run starts from.
2. Before each run, the harness restores the seed to the
   target chain (local Docker via volume replace; testnet via
   `import_block_log` or equivalent).
3. Tests post new ops **on top of** the seed state. Tests
   never assert on pre-seed block heights — only on deltas
   they produce themselves.
4. The seed export is regenerated periodically (monthly? on
   Blurt protocol bumps?) and committed to git-lfs or a
   dedicated fixture store.

**Implementation note:** the seed should include:
- At least one pre-registered operator account
- At least two funded user accounts with posting + active
  keys known to the harness
- A few example `morphit_order_v1` ops already in chain
  history (so queries that expect existing orders have
  something to find)
- A non-zero block height (so block-height comparisons
  exercise the same branch logic as production)

### Q3 — CI cadence?

**Decided:** Unit tests per-PR; integration tests nightly.

- **Every pull request:** unit tests + Postgres-integration
  tests run on the PR branch. Fast feedback (~minutes), no
  external dependencies, runs cheap.
- **Nightly:** full end-to-end harness runs against Blurt
  testnet. Results post to a dashboard (or a Forgejo
  issue-bot, or wherever the operator wants notifications).
  Failures get investigated in a triage turn, not blocking
  any specific PR.
- **On demand:** PR authors can trigger the full harness
  against their branch via a `[run-e2e]` commit tag or
  manual workflow dispatch, for PRs that obviously touch
  chain-adjacent code.

**Rationale:** PR-per-push integration runs against Blurt
testnet would be expensive (testnet fee exposure) and slow
(chain confirmations take ~3s each; a 20-op test is a minute
of real time). Nightly strikes the right balance: production
drift gets caught within 24h without blocking dev velocity.

### Q4 — Secret management?

**Decided:** Encrypted repo secret (GitHub/Forgejo Actions
secrets API).

The CI runner needs:
- **Funded testnet posting key** for the harness's signer
  accounts (to post test ops)
- **Testnet RPC URL** (the Blurt testnet node the harness
  talks to)
- Optionally, **backup RPC URLs** in a comma-separated
  env var for fallback

These go in the CI platform's encrypted secret store
(`MORPHIT_TEST_POSTING_KEY`, `MORPHIT_TEST_RPC_URL`,
etc.). The CI workflow reads them at job start. They are
never logged, never committed, and a maintainer can rotate
them without code changes.

**Security note:** the funded testnet key is a posting key,
not an active or owner key. Maximum blast radius if leaked
is: an attacker posts junk ops from the test account. Since
it's a testnet account, there's no real-money risk. The
key should still be rotated periodically as hygiene.

**For operator runs that want full-chain tests locally:**
document the env var names alongside the e2e harness scripts
(under `docs/INTEGRATION-TEST-HARNESS-DESIGN.md` itself or a
dedicated CONTRIBUTING-E2E.md once the harness lands) so
developers can wire their own testnet key if they want.
Most developers will use the local Docker path (Q1) instead
and never touch testnet keys.

## Harness contract

Rough shape of what an e2e test looks like. The
implementation session can reshape this; what matters is
tests are target-agnostic and self-contained.

```ts
// Shape (not final API) — target decided by
// env var MORPHIT_E2E_TARGET = 'local' | 'testnet'
describe.skipIf(!E2E_ENABLED)('order flow — e2e', () => {
  let fx: E2EFixture;

  beforeAll(async () => {
    fx = await setupE2E(); // restore seed, start indexer
  });
  afterAll(async () => {
    await fx.teardown();
  });
  beforeEach(async () => {
    await fx.resetDerivedState(); // indexer DB, not the chain
  });

  it('posted order appears on /v1/orderbook within 2 blocks', async () => {
    const signer = fx.accounts.alice;
    const orderOp = buildOrderOp({
      /* test payload */
    });
    const { trxId, blockNum } = await fx.post(signer, orderOp);
    await fx.waitForIndexer(blockNum);
    const result = await fx.indexerGet('/v1/orderbook');
    expect(result.orders.some((o) => o.trx_id === trxId)).toBe(true);
  });
});
```

Key properties:
- `setupE2E()` uses `MORPHIT_E2E_TARGET` to pick local vs testnet.
- `fx.post(signer, op)` returns after the op is in a finalized
  block. Handles sig + broadcast + wait.
- `fx.waitForIndexer(blockNum)` blocks until indexer has
  processed `blockNum`. Polls `/v1/health` with a reasonable
  timeout.
- `resetDerivedState()` truncates indexer tables but **does
  not touch the chain** — the chain is append-only and
  restore-only; tests share the seed and build from it.

## CI workflow sketch

Rough shape for `.github/workflows/integration-e2e.yml` (or
Forgejo equivalent):

```yaml
name: integration-e2e
on:
  schedule:
    - cron: '0 6 * * *' # daily 06:00 UTC
  workflow_dispatch: {} # manual trigger
jobs:
  e2e:
    runs-on: ubuntu-latest
    env:
      MORPHIT_E2E_TARGET: testnet
      MORPHIT_TEST_POSTING_KEY: ${{ secrets.MORPHIT_TEST_POSTING_KEY }}
      MORPHIT_TEST_RPC_URL: ${{ secrets.MORPHIT_TEST_RPC_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run build --workspaces --if-present
      - name: Restore seed state on testnet
        run: npm run test:e2e:seed-restore
      - name: Run e2e suite
        run: npm run test:e2e
      - name: Notify on failure
        if: failure()
        run: npm run test:e2e:notify-failure
```

## Open sub-questions (deferred to implementation session)

These are implementation details that don't need ratification
now — the person writing the code can make reasonable calls.

- What Docker image for the local Blurt node? (Pin digest;
  which Blurt release?)
- Seed export format — raw block_log file, JSON snapshot, or
  custom?
- How does `waitForIndexer` check? `/v1/health?head_block>=N`
  or polling a count?
- Failure notification target — Forgejo issue, Matrix webhook,
  email, all of the above?
- Seed regeneration cadence — monthly, on-demand when Blurt
  protocol bumps, or tagged to releases?
- Retry / flakiness handling — how many retries on transient
  RPC failures before marking a test red?

## References

- `apps/indexer/test/integration/` — existing SQL-integration
  pattern; e2e harness reuses the `describe.skipIf(!ENABLED)`
  guard pattern so running locally without the harness
  available is a no-op rather than a failure.
- `docs/OPERATIONS.md §14` — deployment topology and
  forwarded-address handling (relevant when the e2e runner
  fronts local services with nginx).
- `docs/PHASE-5-BACKLOG.md` item 7 — original scope request
  that this design resolves.
- REVISIT-LIST.md §A entry "Integration test harness" — cross-
  reference.
