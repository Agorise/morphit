# AUDIT — v1.12.10 DELTA (deep-deep)

Adversarial self-review of everything changed since the v1.12.9 cut. Scope: cp762–cp768, the two stale-comment fixes, the node-doctor script, and the version bump. Method: re-read each change looking for a way it could leak, corrupt, false-alarm, or regress — not just confirm it does what the commit says.

Battery at time of audit: ~19,700 smoke scenarios / 0 failures; 2,131 vitest unit tests / 0 failing; 27/27 workspace typecheck; version-consistency 20/20; lockfile-sync 4/4; doc-drift 32/32.

---

## cp767 — tor-only clearnet probe exclusion (PRIVACY, highest-risk)

**Change.** The `/v1/rpc-endpoints` route's probe allow-list is now built by `canonicalProbeUrls({ usesClearnet, ... })`, which includes `DEFAULT_BLURT_RPC_ENDPOINTS` only when `usesClearnet` (i.e. `config.blurtRpcEndpoints.length > 0`).

**Why it matters.** The active `?probe=1` path (`probeEndpoints`) fetches every URL in the allow-list directly. Before this, a tor-only node still probed the six clearnet canon nodes → its real IP reached those operators. Same exposure class as cp755/cp761.

**Adversarial review.**
- *Can a tor-only node still reach clearnet by another path?* The two consumers of the allow-list are the active probe (`probeEndpoints`, now clearnet-free on tor-only) and the passive snapshot (`buildRpcEndpointsResponse`, which shows canonical ∩ pool — and cp755 already empties the clearnet pool, so clearnet was already absent there). Both paths are now clearnet-free on tor-only. ✓
- *False signal — is `config.blurtRpcEndpoints.length > 0` the right tor-only test?* A clearnet node's Zod default is the 6 canon (non-empty) → `usesClearnet=true` → unchanged behaviour. cp755 empties the pool on tor-only → `usesClearnet=false` → clearnet excluded. An operator who manually empties the clearnet pool without being "tor-only" is *also* correctly served (they chose not to sync clearnet, so we don't probe it). The gate tracks *actual clearnet use*, which is exactly the privacy-relevant property — stronger than an origin string check. ✓
- *Does it wrongly drop hidden/local endpoints?* No — `hidden`, `local`, `autoLocal` are always included. ✓
- *Privacy regression on the smoke's own assertion?* The pre-existing source-assertion forbade wiring `config.blurtRpcEndpoints` into the route (leaking private upstream URLs). The new code reads only `.length`, never spreads the URLs; the assertion was tightened to `!/\.\.\.config\.blurtRpcEndpoints/` so it still forbids the leak while permitting the length gate. ✓

**Residual risk.** None identified. Live confirmation still worthwhile: on a tor-only box, `/stats` RPC card and `?probe=1` show only Tor/I2P. Smoke-locked (rpc-endpoints-probe 6→10).

---

## cp768 — withhold treasury-mismatch verdict while local indexer is syncing (SECURITY path)

**Change.** `probePool` computes `selfSynced = selfReachableStatus(localLagBlocks) === 'good'` and passes `treasuryForProbe = selfSynced ? canonical : null` into `probeOne`. A null canonical → `treasuryMismatchReason` returns "no mismatch", so the treasury verdict is withheld until synced. Relay-account and response-shape mismatch checks are untouched.

**Why it matters.** A still-syncing node's canonical-treasury baseline (chain-pin > env > default) can be incomplete (pin not yet indexed) → it false-flags a healthy synced peer as fee-redirection "mismatch".

**Adversarial review.**
- *Does this blind the fee-redirection defense?* Only while the LOCAL node is not synced, and only for the treasury check. A synced node (the state that matters — its directory is what users trust) flags redirection exactly as before. A syncing node's directory already shows itself/peers as "syncing" and is inherently less authoritative. The suppression window is bounded by sync completion. This is the correct direction: withhold an accusation you cannot yet substantiate; never suppress one you can. ✓
- *Edge: `localLagBlocks()` returns null (poller not started / head unknown).* `selfReachableStatus(null) === 'good'` → `selfSynced = true` → the check ENGAGES. So an unknown-lag node still runs the treasury check. This is the security-conservative direction (fail toward flagging), consistent with the pre-existing convention that null lag → 'good'. The window is a brief startup moment before the first lag computation, during which the scheduler is not yet probing peers in earnest. Acceptable; noted.
- *Did the two call sites both get the gated value?* Yes — the hidden-service path (`probeOne(inst, treasuryForProbe, hiddenFetch)`) and the clearnet path (`probeOne(inst, treasuryForProbe)`). No third call site. ✓
- *Is `treasuryForProbe` computed once per scan (not per instance)?* Yes — at the top of `probePool`, before the worker pool. The canonical treasury doesn't change mid-scan, so this is correct and avoids re-reading per instance. ✓
- *Relay-account mismatch — should it also be gated?* It compares the peer's self-reported `relay_account` against the locally-recorded `operator_account` (from the peer's registration, which the local node must already have to know the peer). It's far less sync-sensitive than the treasury baseline and is a stronger identity signal; leaving it active is deliberate and safe. ✓

**Residual risk.** The brief null-lag startup window engages the check (conservative). No unsafe suppression. Smoke-locked (treasury-mismatch-probe +3 = 16; federation-probe 25/25 unaffected).

---

## cp766 — /v1/health operational snapshot resilience

**Change.** `refresh()` now samples ipfs / system / relay independently via `Promise.allSettled`; a failed block keeps its previous value (pure `mergeOperationalSnapshot`, never reverts to null/false). A `REFRESH_MAX_INFLIGHT_MS = 30_000` guard prevents a hung refresh from wedging `refreshing = true` forever.

**Adversarial review.**
- *First refresh, a block fails:* `prev` is the DEFAULT_SNAPSHOT, so that one block shows its default while the other two populate; later refreshes retry. Strictly better than the old all-or-nothing (which blanked everything). ✓
- *Overlapping refreshes after the wedge guard fires:* if a refresh hangs past 30s and a second starts, both may eventually assign `cached`. Each assignment is a valid merged snapshot (last-write-wins). No corruption, no partial object. Low-probability, benign. ✓
- *Does `mergeOperationalSnapshot` ever emit a partial/invalid block?* No — each field is either the fresh block (a complete object) or the previous complete block. Never a spread of partial fields. Pure + unit-tested (6 new checks). ✓
- *Could a block that legitimately went bad (relay actually down) be masked by keeping a stale "up"?* Only if the relay probe *throws/rejects* (keeps prev). A relay that is reachable-but-down returns `up:false` (a fulfilled value) and updates normally. A rejection is a probe error, not a "down" signal — keeping the last known value across a transient probe error is the intended stale-while-revalidate behaviour, and the TTL keeps it fresh. Acceptable. ✓

**Residual risk.** Root environmental trigger for the observed freeze on the live 1.12.9 box was not reproduced in-sandbox (samplers are individually defensive), but the fix addresses both plausible causes (a rejecting sampler → allSettled; a wedged flag → the inflight guard). Confirm on the box post-deploy that `/v1/health` populates.

---

## cp764 / cp765 — snapshot bootstrap + chain_snapshot_v1 op (new tooling)

- **cp764 safety core** (`snapshotManifest.ts`): every compatibility rule fails CLOSED — chain-id EXACT match, schema not newer than build, pg not newer than host, format-version guard, malformed-manifest → refuse. The bootstrap additionally gates on `--i-trust-this-source` and refuses to clobber a populated DB. Trust model (same-operator only) is documented in the module and enforced by the acknowledgement flag. Pure verification unit-tested (15 checks); dump/restore is shell-out, untestable in CI → flagged for live run. No path lets an incompatible or unverified snapshot load silently. ✓
- **cp765 op contract** (`chainSnapshotOp.ts`): pure fail-closed validator (CID shape, 64-hex lowercase sha256, positive ints, https-only mirror, 8192-byte custom_json limit, account-name shape). Broadcaster is dry-run by default and validates before touching a key. Points only at the raw, self-verifying block_log (zero-trust); does NOT anchor derived state. Unit-tested (19 checks). ✓

**Residual risk.** Both are publish/consume tooling with no live artifact yet; the on-chain publish and the DB restore need a real run. Neither changes any existing code path.

---

## cp762 / cp763 / comment fixes / node-doctor

- **cp763 (canary permission fix):** staging moved to user-writable `~/.morphit/canary/`; source tree only read for the template; final artifacts still land in the served build dir; `generate.sh` default output path unchanged (backward-compatible with existing refresh scripts). Locked (canary-setup 21→24). ✓
- **cp762 (sync profiler)** and **`ops/morphit-node-doctor.sh`:** diagnostic/operator tooling; the doctor's only auto-fix (empty the clearnet pool on tor-only) backs up first and refuses to act if the hidden pool is also empty (never strands the indexer). Mock-tested for the disk-editing paths. ✓
- **Stale-comment fixes (poller.ts, config):** documentation-only; no behaviour change; no smoke depended on the old text.

---

## Version bump

1.12.9 → 1.12.10 across 15 package.json + lockfile (all entries verified to be Morphit workspace packages, no external dep at 1.12.9) + 3 TS consts (indexer/relay/mcp) + docs/API.md + apps/indexer/README.md + RELEASE-NOTES-v1.12.10.md. Internal deps use `"*"`, so no dependency-pin edits were needed. version-consistency 20/20.

---

## Verdict

The delta is CLEAR. Two minor, documented edges (cp768 null-lag engages the check in the security-conservative direction; cp766 first-refresh shows a failed block's default until a later pass) are acceptable and fail safe. No leak, corruption, unsafe suppression, or regression found. Live confirmations to close post-deploy: cp767 (tor-only shows only hidden in the RPC card), cp766 (/v1/health populates), cp764/cp765 (a real export→bootstrap and a real chain_snapshot_v1 publish). No database migration in this release.
