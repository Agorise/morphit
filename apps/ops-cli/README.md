# morphit-ops

Operator command-line tool for a Morphit instance. Read-mostly
view into the indexer + relay shared database: status snapshot,
drain queue depth, recent signups, abuse signals, moderation
flags. Designed to be run on the same VPS that hosts the
indexer and relay, over SSH.

The CLI does NOT mutate state. Everything it shows is sourced
from queries against the same Postgres the indexer and relay
write to; no admin endpoints are involved. This keeps the
attack surface small (read-only Postgres connection is the only
auth the CLI needs).

The `init` subcommand is the exception — it's a first-time
setup wizard that writes `morphit.config.env` and a posting-key
keystore to disk. See "First-time setup" below.

## First-time setup

Run on a fresh checkout to generate your `morphit.config.env`
and active-key keystore:

```sh
cd apps/ops-cli
npx tsx src/main.ts init
```

The wizard:

1. Runs a system check (CPU, RAM, disk, OS version, Postgres
   reachability, outbound HTTPS). Catches issues before you
   commit time to interactive prompts.
2. Walks you through 18 setup steps with ELI5 explanations.
3. Validates each input (Blurt account names checked against
   the chain, database URL parsed, etc.).
4. Shows a review and asks for confirmation.
5. Writes `morphit.config.env` and `apps/relay/keystore.{wif,json}`
   with `0600` permissions.

If you only want to verify your hardware/OS meets the bar
before committing time to setup:

```sh
npx tsx src/main.ts init --check-only
```

`init` works on a fresh checkout where `npm install` hasn't
been run yet — it has no third-party dependencies beyond what
ships in Node.js.

## Publish your instance to the federation

After your indexer + relay + frontend are up and serving
correctly at your public origin, run:

```sh
# Source your wizard-generated env files so register can
# read them:
set -a; . ./morphit.env; . ./morphit.config.env; set +a

npx tsx apps/ops-cli/src/main.ts register
```

This posts a `morphit_operator_register_v1` op on the Blurt
chain. Within ~10 minutes every Morphit indexer (including
morphit.io and your own) will see it via chain replay,
probe your origin to verify it's serving correctly, and add
your instance to their `/instances` directory.

You can verify your registration landed by visiting your
own `/instances` page — you should appear with status
`good` and a "You are here" badge.

The `register` subcommand requires `npm install` to have run
(it dynamically loads `@beblurt/dblurt` for chain
broadcasting).

## Quick start (after init)

```sh
cd apps/ops-cli
npm install
export MORPHIT_OPS_DATABASE_URL=postgres://morphit:secret@localhost:5432/morphit
npx tsx src/main.ts status
```

You should see a multi-section dashboard summarizing indexer
health, drain queue, today's signups, and 24h moderation flags.

## Configuration

The CLI reads its database connection from environment variables.
Only the database URL is required; everything else has a
sensible default.

| Variable                             | Required           | Default         | Notes                                                                 |
| ------------------------------------ | ------------------ | --------------- | --------------------------------------------------------------------- |
| `MORPHIT_OPS_DATABASE_URL`           | Yes (or alt below) | —               | Postgres connection string                                            |
| `MORPHIT_INDEXER_DATABASE_URL`       | Alt                | —               | Falls back to this if MORPHIT_OPS_DATABASE_URL is unset               |
| `DATABASE_URL`                       | Alt                | —               | Final fallback                                                        |
| `MORPHIT_OPS_RELAY_ACCOUNT`          | No                 | `morphit-relay` | Matched against accounts.creator for signup queries                   |
| `MORPHIT_OPS_FEES_ACCOUNT`           | No                 | `morphit-fees`  | Currently informational; used in future subcommands                   |
| `MORPHIT_RELAY_SIGNUP_DAILY_CEILING` | No                 | `50`            | Snapshot of relay's ceiling, used to compute "X / Y" on dashboard     |
| `MORPHIT_OPS_COLOR`                  | No                 | `auto`          | `auto` (TTY-aware), `always`, or `never`. `NO_COLOR` env also honored |

### Threshold tunables

Each metric on the status dashboard maps to a status glyph
(`✓` / `⚠` / `✗`) by comparing its value to a warn/error
threshold pair. Defaults follow the audit-recommended values.
Override any of them via env:

| Env variable                                     | Default     | Maps to                                |
| ------------------------------------------------ | ----------- | -------------------------------------- |
| `MORPHIT_OPS_THRESHOLD_RELAY_BALANCE_WARN`       | `100`       | Warn below this many BLURT             |
| `MORPHIT_OPS_THRESHOLD_RELAY_BALANCE_ERROR`      | `30`        | Error below this many BLURT            |
| `MORPHIT_OPS_THRESHOLD_DRAIN_AGE_WARN_SEC`       | `300` (5m)  | Warn when oldest pending exceeds this  |
| `MORPHIT_OPS_THRESHOLD_DRAIN_AGE_ERROR_SEC`      | `3600` (1h) | Error when oldest pending exceeds this |
| `MORPHIT_OPS_THRESHOLD_INDEXER_LAG_WARN_BLOCKS`  | `5`         | Warn when indexer is N+ blocks behind  |
| `MORPHIT_OPS_THRESHOLD_INDEXER_LAG_ERROR_BLOCKS` | `30`        | Error when indexer is N+ blocks behind |
| `MORPHIT_OPS_THRESHOLD_SIGNUPS_PCT_WARN`         | `80`        | Warn at this % of daily ceiling        |
| `MORPHIT_OPS_THRESHOLD_SIGNUPS_PCT_ERROR`        | `100`       | Error at this % of daily ceiling       |
| `MORPHIT_OPS_THRESHOLD_ABUSE_WARN`               | `10`        | Warn at this many flags in 24h         |
| `MORPHIT_OPS_THRESHOLD_ABUSE_ERROR`              | `50`        | Error at this many flags in 24h        |

## Subcommands

| Subcommand                                          | What it shows                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `init`                                              | First-time setup wizard (run on a fresh install)                                      |
| `register`                                          | Publish operator registration on-chain (Phase D.5)                                    |
| `status`                                            | One-screen dashboard: indexer state, drain queue, signups today, moderation flags 24h |
| `drain-queue [--age=DUR]`                           | Pending relay transfers, oldest first. `--age=1h` shows entries waiting >1h           |
| `signups [--since=DUR]`                             | Accounts created via this relay. Default window: 24h                                  |
| `abuse [--since=DUR]`                               | Combined view: persistent broadcast failures + new reciprocity/related-account flags  |
| `failed-broadcasts [--since=DUR]`                   | Relay broadcasts that errored, with error messages                                    |
| `loyalty [--since=DUR]`                             | Loyalty milestone delegations triggered. Default window: 7d                           |
| `attestations`                                      | Orders awaiting fee-attestation verification (BTC/XMR fee path)                       |
| `flags [--type=reciprocity\|related] [--since=DUR]` | Moderation flags drill-down                                                           |

### Global flags

- `--json` — emit JSON instead of human-formatted output, suitable for piping to `jq`
- `--no-color` — disable ANSI color (also honored: `NO_COLOR` env var)
- `--help`, `-h` — show usage
- `--version`, `-v` — show version

### `init`-specific flags

- `--check-only` — run the system check, print results, and exit (no prompts)
- `--out=PATH` — write `morphit.config.env` to PATH instead of the repo root

### Duration spec (`DUR`)

Number followed by unit: `s` (seconds), `m` (minutes), `h` (hours), `d` (days).
Examples: `30s`, `5m`, `24h`, `7d`. Case-insensitive on the unit;
whitespace between number and unit is tolerated (`5 m` works).

## JSON output

Every subcommand accepts `--json`. Output is a single document
to stdout, suitable for piping. Examples:

```sh
# How many failed broadcasts had errors > 5 minutes ago?
morphit-ops failed-broadcasts --json | jq '.entries | map(select(.error_count >= 5)) | length'

# Recent signups as a CSV-like list
morphit-ops signups --json | jq -r '.entries[] | [.name, .created_block_time] | @tsv'

# Alert if drain queue oldest age > 1 hour
oldest=$(morphit-ops status --json | jq '.drain_queue.oldest_age_sec // 0')
[ "$oldest" -gt 3600 ] && echo "ALERT: drain queue stuck"
```

## Troubleshooting

**"No database URL configured."**
Set `MORPHIT_OPS_DATABASE_URL` to the same connection string the
indexer uses. See your operator config or systemd unit.

**Status shows 0 signups but you know there were some.**
The CLI matches `accounts.creator = MORPHIT_OPS_RELAY_ACCOUNT`.
If your relay's account name isn't `morphit-relay`, set
`MORPHIT_OPS_RELAY_ACCOUNT` to the actual name.

**Failed-broadcasts list is empty but the relay's logs show errors.**
The CLI sees only persisted DB state. In-flight or never-queued
errors (e.g., the relay's active-key unlock failed at startup)
don't appear here. Check the relay's structured logs for those.

**Color is wrong / glyphs are blank.**
Some basic SSH sessions have spotty UTF-8 support. Pass
`--no-color` for ASCII-only output (`[OK]`, `[WARN]`, `[ERR]`).

## What's NOT in v1

The following are deliberately deferred until a follow-up phase:

- **Operations subcommands** (`drain-now`, `pause-signups`,
  `set-ceiling`, `top-up-balance`). These would mutate live
  state and require either a relay HTTP admin endpoint with
  signed-challenge auth, or a coordination mechanism through
  Postgres. v1 is read-only by intent.
- **Operator monitoring web UI.** We deliberately ship a CLI
  instead — fewer attack surfaces, scriptable, fits the
  operator's SSH-into-the-VPS workflow.
- **Multi-relay views.** The CLI assumes one relay account
  per instance. Operators running multiple relays would
  invoke the CLI multiple times with different
  `MORPHIT_OPS_RELAY_ACCOUNT` values.

## Source map

```
src/
├── main.ts                       Entry point + tiny arg parser
├── config.ts                     Env vars + threshold tunables
├── db.ts                         pg.Pool wrapper
├── render/
│   ├── term.ts                   ANSI colors, glyphs, sections
│   └── json.ts                   --json emitter
├── lib/
│   ├── ctx.ts                    Shared CommandCtx type
│   └── time.ts                   Duration/time formatting helpers
└── commands/
    ├── status.ts                 Dashboard
    ├── drainQueue.ts             Pending transfers
    ├── signups.ts                Recent signups
    ├── abuse.ts                  Combined abuse signals
    ├── failedBroadcasts.ts       Errored broadcasts
    ├── loyalty.ts                Milestones
    ├── attestations.ts           Pending fee attestations
    └── flags.ts                  Moderation flags

scripts/
└── ops-cli-smoke.ts              35-scenario smoke runner

test/
└── time.test.ts                  Vitest mirror of the smoke (for when vitest is installed)
```

## License

AGPL-3.0-only — same as the rest of Morphit.
