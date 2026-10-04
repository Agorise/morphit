# ops/test — mutation and execution harnesses

Each harness here breaks one guarded behaviour on purpose and checks that the
test standing behind it notices. A test that has never been seen to fail is not
a test; these make that check repeatable instead of a one-off.

Run them on a development checkout, never on a production node. Most of them
temporarily edit source files and put them back, so do not run two at once and
do not run them while other work is open in the same tree. Each one prints
`✓ … passed` or `✗ N FAILED` and exits non-zero on failure.

## Run by the smoke suite

These are executed by a registered smoke in `scripts/run-smokes.sh`, so CI runs
them on every pass:

| Harness | Run by |
|---|---|
| `alt-address-execution-harness.sh` | `apps/ops-cli/scripts/alt-address-execution-smoke.ts` |
| `canary-prompt-execution-harness.sh` | `apps/ops-cli/scripts/canary-prompt-execution-smoke.ts` |
| `emit-dedup-harness.sh` | `apps/ops-cli/scripts/emit-dedup-execution-smoke.ts` |
| `fast-sync-harness.sh` | `apps/ops-cli/scripts/fast-sync-execution-smoke.ts` |
| `focus-scrim-guard-harness.sh` | `apps/web/scripts/focus-scrim-guard-execution-smoke.ts` |
| `pin-indexer-snapshot-harness.sh` | `apps/ops-cli/scripts/publish-path-execution-smoke.ts` |
| `seed-probe-execution-harness.sh` | `apps/ops-cli/scripts/seed-probe-execution-smoke.ts` |
| `snapshot-mirror-harness.sh` | `apps/ops-cli/scripts/mirror-path-execution-smoke.ts` |
| `systemd-monitor-dedup-harness.sh` | `apps/ops-cli/scripts/monitor-dedup-execution-smoke.ts` |

## Run by hand

These run a whole test file or smoke once per mutation, which is too slow for
every CI pass. Run the ones that cover what you changed before a release, from
the repository root:

| Harness | Run it when you change | Command |
|---|---|---|
| `fast-emit-ledger-harness.sh` | the fast-path emit ledger or the head tailer's skip | `bash ops/test/fast-emit-ledger-harness.sh` |
| `fastchat-client-harness.sh` | the browser side of fast chat (broadcast transport, duplicate handling) | `bash ops/test/fastchat-client-harness.sh` |
| `fastchat-instance-matrix-harness.sh` | fast-chat delivery or the notification gates | `bash ops/test/fastchat-instance-matrix-harness.sh` |
| `fastchat-latency-probe-harness.sh` | `ops/fastchat-latency-probe.sh` | `bash ops/test/fastchat-latency-probe-harness.sh` |
| `fastchat-three-leg-harness.sh` | fast-chat federation between two instances | `bash ops/test/fastchat-three-leg-harness.sh` |
| `fastchat-transport-harness.sh` | which network a chat message goes out over | `bash ops/test/fastchat-transport-harness.sh` |
| `federation-chat-fast-harness.sh` | the federated fast-chat endpoint and its checks | `bash ops/test/federation-chat-fast-harness.sh` |
| `federation-health-summary-harness.sh` | how `morphit-ops health` reads the federation health block | `bash ops/test/federation-health-summary-harness.sh` |
| `posting-key-trust-harness.sh` | posting-key trust or the push queue (needs a scratch Postgres) | `TEST_DATABASE_URL=postgres://… bash ops/test/posting-key-trust-harness.sh` |

`scripts/smoke-registration-integrity-smoke.ts` fails if a harness here is
neither run by a registered smoke nor listed in this file.
