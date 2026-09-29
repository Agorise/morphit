# morphit-ops

The operator tool for a Morphit instance: guided install, settings,
branding, upgrades, hardening, health, and read-only views into the
indexer + relay database (status, drain queue, signups, abuse signals,
moderation flags). Run it **on the server**, as `sudo morphit-ops …`
(the guided install puts a `morphit-ops` shortcut on the PATH that always
runs the copy in `/opt/morphit`; the instance's settings are readable only
by root). `sudo morphit-ops` with no arguments opens a menu of everything;
`sudo morphit-ops --help` lists every subcommand.

Many subcommands change the server (install, upgrade, harden, edit,
branding, register, block, …); the database views (status, signups,
drain-queue, abuse, failed-broadcasts, loyalty, attestations, flags) only
read.

Don't run `npx morphit-ops` outside the install folder: `npx` then looks the
name up on the public npm registry, which is not where Morphit comes from.

## First-time setup

Use the guided install — `sudo bash morphit-setup.sh` in the extracted
release, choose *Full guided install*
([`docs/RUN-A-MORPHIT-NODE.md`](../../docs/RUN-A-MORPHIT-NODE.md)). It runs
the setup wizard (`init`) for you, writes `morphit.config.env`,
`morphit.env` and the encrypted relay keystore (`apps/relay/keystore.json`,
mode 0600), and installs everything else.

To check only whether this machine's hardware/OS meets the bar:

```sh
sudo morphit-ops init --check-only
```

## Publish your instance to the federation

After your node is up and serving at its public origin, on the server:

```sh
sudo morphit-ops register
```

This posts a `morphit_operator_register_v1` op on the Blurt chain, signed
by your relay account. Within ~10 minutes every Morphit indexer (including
morphit.io and your own) sees it via chain replay, probes your origin, and
lists your instance in its `/instances` directory.

Registration is an update keyed on your relay account: run `register`
again after changing your display name, origin, contact or Tor/I2P
addresses and the new values replace the old ones. Only the **tag** is
permanent once claimed.

## Quick start (after install)

```sh
sudo morphit-ops status
```

It finds the database URL in the instance's own env files; set
`MORPHIT_OPS_DATABASE_URL` only to point it somewhere else.

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

`sudo morphit-ops --help` is the authoritative list. The main ones:

| Subcommand | What it does |
| --- | --- |
| `install` | Guided first-time install |
| `doctor` | Read-only check: will the indexer + relay start with this config? |
| `init [--check-only]` | Setup wizard (run for you by `install`) |
| `edit` | Change settings: origin, alt-network addresses, SEO, fees account, operator tag, RPC endpoints |
| `branding [status\|setup\|apply\|reset]` | Your logo, icons and site name (`docs/BRANDING.md`) |
| `alt-address` | Guided Tor / Lokinet / I2P address setup |
| `register` | Publish (or update) your operator registration on-chain |
| `show-key` | Show the public key your saved active key derives to |
| `edit-active-key` | Rotate the relay account's active key |
| `import-altnet-key` / `export-altnet-key --network=tor\|lokinet\|i2p` | Encrypt / decrypt an alt-network service key |
| `payment-method [add\|remove\|list]` | Instance-specific payment methods |
| `upgrade [--check-only] [--yes] [--json] [--from-file=PATH] [--allow-downgrade]` | Check for and apply a newer release |
| `harden` | Server-hardening wizard |
| `ssl [status\|setup]` | HTTPS certificate status / setup steps |
| `bunkerweb` | BunkerWeb WAF status / install |
| `health [--json]` | Node health: indexer, relay, services, canary |
| `mcp` / `matrix [set <mxid>\|clear\|test]` | MCP server on/off; Matrix alert username |
| `status` | One-screen dashboard: indexer state, drain queue, signups today, moderation flags 24h |
| `drain-queue [--age=DUR]` | Pending relay transfers, oldest first |
| `signups [--since=DUR]` | Accounts created via this relay (default 24h) |
| `abuse [--since=DUR]` | Persistent broadcast failures + new reciprocity/related-account flags |
| `failed-broadcasts [--since=DUR]` | Relay broadcasts that errored |
| `loyalty [--since=DUR]` | Loyalty milestone delegations (default 7d) |
| `attestations` | Orders awaiting fee-attestation verification (BTC/XMR fee path) |
| `flags [--type=reciprocity\|related] [--since=DUR]` | Moderation flags drill-down |
| `moderation` | Review flags, block/unblock accounts (interactive) |
| `block <account> [reason]` / `unblock <account>` | Hide / un-hide an account's listings on this instance |
| `fast-sync [--from-file PATH]` / `fast-forward [BLOCK]` | Restore a federation snapshot / skip ahead |

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
sudo morphit-ops failed-broadcasts --json | jq '.entries | map(select(.error_count >= 5)) | length'

# Recent signups as a CSV-like list
sudo morphit-ops signups --json | jq -r '.entries[] | [.name, .created_block_time] | @tsv'

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

## What it deliberately does not do

- **Live relay controls** (`drain-now`, `pause-signups`, `set-ceiling`,
  `top-up-balance`). These would need a relay admin endpoint. To pause
  signups, on the relay's server: `sudo touch /var/lib/morphit/relay/SIGNUPS_DISABLED`
  (see `docs/INCIDENT-RUNBOOK.md`).
- **Operator monitoring web UI.** We deliberately ship a CLI
  instead — fewer attack surfaces, scriptable, fits the
  operator's SSH-into-the-VPS workflow.
- **Multi-relay views.** The CLI assumes one relay account
  per instance. Operators running multiple relays would
  invoke the CLI multiple times with different
  `MORPHIT_OPS_RELAY_ACCOUNT` values.

## Source

Entry point and argument parser: `src/main.ts`; one file per subcommand in
`src/commands/`; shared helpers in `src/lib/`; the install wizard in
`src/init/`. Tests are in `test/` (vitest) and `scripts/` (smokes).

## License

AGPL-3.0-or-later — same as the rest of Morphit.
