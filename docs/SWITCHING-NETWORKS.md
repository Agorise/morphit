# Switching networks: testnet, staging, and going live

Plain-language walkthrough for two scenarios:

1. **"I want to test before launching."**  Stand up a
   throwaway Morphit instance to shake out bugs without
   polluting your eventual production account's reputation.
2. **"I'm ready to go live."**  Wipe the staging instance
   and switch to your real production account on Blurt
   mainnet.

Designed for a working sysadmin who is comfortable with
`systemctl`, `psql`, and editing config files — but isn't
expected to know anything about Blurt internals.  If you've
never run Morphit before, read
[`docs/RUN-A-MORPHIT-NODE.md`](RUN-A-MORPHIT-NODE.md) first
for the bigger picture.

---

## What you're going to do — staging on Blurt mainnet

The recommended pre-launch testing pattern is **staging on
mainnet**: a second Morphit instance pointing at the same
Blurt chain you'll launch on, but with:

- A separate Blurt account (e.g. `acmecorp-staging` if your
  production account will be `acmecorp`)
- A separate Postgres database (`morphit_staging` next to
  `morphit_indexer`)
- A separate config directory (`/opt/morphit-staging/` next
  to `/opt/morphit/`)
- A small budget of real BLURT (~50 BLURT, ≈$5) for test
  ops (listing fees, chat fees, etc.)

This is what every running Blurt-adjacent project does for
staging.  The staging traffic doesn't pollute your eventual
production account's reputation history because they're
different accounts on the same chain.

**What this catches before launch:**
- Postgres permission setup and role creation
- systemd unit configuration and reboot survival
- nginx / TLS / reverse-proxy config (or Caddy if you chose it)
- The wizard end-to-end (`morphit-ops init`)
- Backup-and-restore loop (test the restore!)
- Federation discovery (other Morphit operators see your
  staging instance via on-chain `morphit_operator_register_v1`)
- `morphit-ops edit` workflow for post-launch tunables

**What it costs:**  ~30 minutes of operator time + ~$5 of
BLURT.  Test ops on mainnet cost real BLURT but small enough
to be a non-event for a serious operator.

The "going live" workflow then drops the staging DB, creates
a fresh production DB, and re-runs the wizard with
production credentials.  Same chain, so no chain-id change
is needed; the wizard ships mainnet chain_id by default.

> [!NOTE]
> A community-maintained Blurt testnet exists at
> `https://testnet-rpc.beblurt.com`, but Morphit currently
> can't talk to it without code changes (mainnet asset
> symbol and address prefix are hardcoded in ~7 places).
> See the appendix at the bottom of this doc for the full
> story.  For pre-launch testing, staging-on-mainnet
> covers everything you actually need.

---

## Procedure 1: Stand up a staging instance

Roughly 30 minutes of operator time.

### Step 1.1 — Create a separate Blurt account for staging

You need a Blurt account that's distinct from your eventual
production account.  Naming convention: if your production
account will be `acmecorp`, name your staging account
`acmecorp-staging` or `acmecorp-test`.

Go to any Blurt frontend (blurt.blog, beblurt.com) and create
the account.  Save the master password.  Generate the four
keys (owner, active, posting, memo) — Morphit uses the active
key to broadcast ops.

Send the new account ~50 BLURT for test ops.  Listing fees,
chat fees, etc. will be charged against this balance.

### Step 1.2 — Create a separate Postgres database for staging

On the box that will run the staging Morphit:

```sh
sudo -u postgres psql -c "CREATE ROLE morphit_staging LOGIN PASSWORD 'pick-a-strong-one';"
sudo -u postgres psql -c "CREATE DATABASE morphit_staging OWNER morphit_staging ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0;"
```

This is identical to the production setup but with `_staging`
suffix on both the role and the database.

### Step 1.3 — Run the wizard with --out pointing at a staging directory

The wizard generates `morphit.config.env` and `morphit.env`
in the repo root by default.  Use `--out` to put them
somewhere else so production config isn't overwritten:

```sh
mkdir -p /opt/morphit-staging
cd /opt/morphit
npm exec --workspace apps/ops-cli morphit-ops -- init --out /opt/morphit-staging
```

When the wizard asks:
- **Database URL:** use the staging connection string
  (`postgres://morphit_staging:PASSWORD@localhost/morphit_staging`)
- **Relay account:** the staging account from Step 1.1
- **Posting key:** the staging account's active key (paste it
  in; the wizard will encrypt it)
- **Origin URL:** if you haven't decided on the staging URL
  yet, leave this blank; you can set it via `morphit-ops edit`
  later

The wizard ships **mainnet chain_id** as the default.  This
is correct for staging-on-mainnet — staging instances point
at the same chain as production, just with a different
account and database.

### Step 1.4 — Run the indexer + relay against the staging config

Two ways:

**A. Test it interactively first** (good for the first run):

```sh
cd /opt/morphit
set -a; . /opt/morphit-staging/morphit.env; set +a
npm start --workspace apps/indexer
```

In another terminal:

```sh
cd /opt/morphit
set -a; . /opt/morphit-staging/morphit.env; set +a
npm start --workspace apps/relay
```

You should see the indexer log "starting" with the
chain_id_prefix matching mainnet, then "block X applied"
messages every few seconds.

**B. Set up systemd units for staging** (once you're happy
the manual run works):

Copy `ops/systemd/morphit-indexer.service` to
`/etc/systemd/system/morphit-staging-indexer.service` and
edit:
- Change the `Description=` to reference staging
- Change `EnvironmentFile=` to point at
  `/opt/morphit-staging/morphit.env`
- Change `WorkingDirectory=` if you want logs separated

Same for the relay unit.  `systemctl daemon-reload` and start.

### Step 1.5 — Use the staging instance

Hit your staging origin in a browser, post a few test orders,
exchange chat messages with another account you control,
verify reputation flow.  Watch
`journalctl -u morphit-staging-indexer -f` for any errors.

When you find bugs (you will), fix them in the codebase, then
on the staging box: `git pull`, run migrations, restart
services.  Same workflow as production maintenance.

### Step 1.6 — Move on when you're satisfied

Staging gives you a real-data sandbox.  Use it until you've
seen:
- Account creation works end-to-end
- Order posting + listing fee verification works
- Chat between two accounts works
- Feedback flow works
- Backups run successfully (test the restore!)
- Operator-config edits via `morphit-ops edit` work

Once that list is green, you're ready for the production
launch.

---

## Procedure 2: Going live (wipe staging, switch to mainnet for real)

This is the procedure for **destroying the staging database
and starting fresh with a production account on mainnet**.
Roughly 15 minutes if you've already done Procedure 1.

> [!CAUTION]
> This procedure DESTROYS the staging database.  Anything in
> it — chat history, indexer state, queued relay transfers
> for the staging account — is gone.  This is the intended
> behavior for going live.  If you have anything in staging
> you want to keep, back it up to a separate file BEFORE
> running these commands.

### Step 2.1 — Stop the staging services

```sh
sudo systemctl stop morphit-staging-indexer
sudo systemctl stop morphit-staging-relay
```

If you ran the services manually instead of via systemd, just
Ctrl+C the running processes.

### Step 2.2 — Decide: same machine or new machine?

Two paths from here.

**Path A: Repurpose the staging box for production.**  Keep
the same hardware, drop the staging DB, create a fresh
production DB on the same Postgres, re-run the wizard with
production credentials, install production systemd units.

**Path B: Leave staging running on its current box, deploy
production on a new box.**  Useful if you want to keep
running staging in parallel for ongoing testing post-launch.

**Path A is fine for solo operators.**  **Path B is right if
you're going to run a real federation node and want to keep
testing in parallel.**  The doc continues with Path A; for
Path B, just do a fresh `morphit-ops init` on the new box
without any of the wipe steps below.

### Step 2.3 — Drop the staging database

```sh
sudo -u postgres psql -c "DROP DATABASE morphit_staging;"
sudo -u postgres psql -c "DROP ROLE morphit_staging;"
```

This is the destructive step.  You're explicitly removing the
staging DB.  Postgres will refuse the DROP if there are still
active connections — in that case, double-check the services
in Step 2.1 are stopped, then retry.

### Step 2.4 — Create the production database

If you haven't already created the production role + DB
during planning, do it now:

```sh
sudo -u postgres psql -c "CREATE ROLE morphit_indexer LOGIN PASSWORD 'PRODUCTION-PASSWORD-HERE';"
sudo -u postgres psql -c "CREATE DATABASE morphit_indexer OWNER morphit_indexer ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0;"
```

Use a different password than staging.  Save it in your
secrets manager (or wherever your operations runbook says to
keep production credentials).

### Step 2.5 — Move the staging config aside (don't delete it yet)

```sh
mv /opt/morphit-staging /opt/morphit-staging.archived-$(date -u +%Y%m%d)
```

This preserves the config + keystore for one rollback turn,
just in case.  You can delete it permanently after a week of
stable production.

### Step 2.6 — Re-run the wizard with production values

```sh
cd /opt/morphit
npm exec --workspace apps/ops-cli morphit-ops -- init
```

(No `--out` flag — this writes to the repo root, which is the
default production path.)

When the wizard asks:
- **Database URL:** the production connection string
  (`postgres://morphit_indexer:PRODUCTION-PASSWORD-HERE@localhost/morphit_indexer`)
- **Relay account:** your real production Blurt account
- **Posting key:** the production account's active key
- **Origin URL:** your real public URL
- (everything else: actual production values)

The wizard writes mainnet chain_id automatically.  No special
action needed — staging-on-mainnet and production-on-mainnet
both pin to the same chain_id, so this just works.

### Step 2.7 — Install production systemd units

If you used the staging-suffixed unit names earlier, swap to
the regular ones now:

```sh
sudo systemctl disable morphit-staging-indexer morphit-staging-relay
sudo cp /opt/morphit/ops/systemd/morphit-indexer.service /etc/systemd/system/
sudo cp /opt/morphit/ops/systemd/morphit-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-indexer
sudo systemctl enable --now morphit-relay
```

(Edit the unit files first to point `EnvironmentFile=` at the
real morphit.env path if you're using a non-default
location.)

### Step 2.8 — Watch the first sync happen

```sh
sudo journalctl -u morphit-indexer -f
```

You should see:
- A `starting` line with chain_id_prefix matching mainnet
- A `migrations_applied` line (the schema is built fresh on
  the empty production DB)
- Block-applied messages catching up to chain head

The first-run catch-up scans Blurt history for any
`morphit_*` ops on accounts your indexer cares about.  On a
fresh-launch instance with no existing Morphit history, this
finishes in seconds.

### Step 2.9 — Smoke-test the production deployment

From a browser pointed at your production origin:
- Hit the homepage; it should load
- Check `/instances` shows your origin in the federation
  directory (this can take up to 10 minutes for federation
  probes from other operators to update)
- Sign up with a fresh test account and post an order
- Verify the order appears in the public orderbook

If anything breaks, check `journalctl` for the relevant
service.  Common first-time issues:
- **Origin URL mismatch:** your reverse proxy and
  `MORPHIT_INSTANCE_ORIGIN` must agree, or the federation
  directory will reject the operator-register op
- **Insufficient relay BLURT:** see
  [`OPERATIONS.md §1`](OPERATIONS.md) for the auto-top-up
  setup
- **Migration failure:** rare, but check the schema-vN.sql
  files in `apps/indexer/src/db/` are all present in the
  deployed checkout

### Step 2.10 — You're live

The federation will discover your instance within ~10 minutes
via the operator-register op.  At that point users on other
Morphit instances will see yours in their `/instances`
directory and can pick it for chat or trading.

After a week of stable production, delete the archived
staging config:

```sh
sudo rm -rf /opt/morphit-staging.archived-*
```

And you're done.

---

## Quick reference: the difference between staging and production

|                              | Staging                                   | Production                                |
|---|---|---|
| Blurt account                | `you-staging`                             | `you`                                     |
| Postgres role + database     | `morphit_staging` / `morphit_staging`     | `morphit_indexer` / `morphit_indexer`     |
| Repo config files at         | `/opt/morphit-staging/morphit*.env`       | `/opt/morphit/morphit*.env`               |
| systemd units                | `morphit-staging-{indexer,relay}.service` | `morphit-{indexer,relay}.service`         |
| Origin URL                   | something throwaway (e.g. staging subdomain) | your real URL                             |
| Federation directory listing | hidden (no operator-register op)          | public (operator-register op broadcast)   |
| Chain                        | Blurt mainnet                             | Blurt mainnet (same)                      |
| Chain ID                     | same as production                        | same as staging                           |

The chain is the same.  Everything else is isolated.

## What about the frontend?

The frontend (apps/web) builds against `DEFAULT_RPC_ENDPOINTS`
in `apps/web/src/lib/net/config.ts`, which is a hardcoded
list of Blurt mainnet RPC nodes.  Users can override
per-browser via Settings → Endpoints.

For staging-on-mainnet, no change is needed — the frontend
hits the same mainnet RPCs as the indexer, and the indexer's
own data is still isolated to your staging DB.

(For testnet, the frontend would also need code changes —
see the appendix at the bottom.)

## What about backup + rollback?

Backups belong on a different schedule and survive the
testnet-to-mainnet switch unchanged — see
[`OPERATIONS.md`](OPERATIONS.md) §1 for the canonical backup
procedure.

If launch goes wrong and you need to rollback to staging:
1. Stop production services
2. Restore the staging DB from your archived backup
3. Move `morphit-staging.archived-*` back to `morphit-staging/`
4. Re-enable the staging systemd units

In practice nobody does this — by the time you're at Step 2.7
you've already validated the deployment in Procedure 1.  But
the fact that you CAN rollback is what makes the wipe step in
2.3 feel safe.

## Common questions

**Q: Can I just edit `MORPHIT_INDEXER_CHAIN_ID` in
`morphit.env` instead of wiping the DB?**

No.  The indexer pins chain_id at first run and refuses to
boot on mismatch — exactly so you can't accidentally cross-
contaminate.  The only correct way to "switch chains" is to
wipe the DB and start over.  This is a feature, not a
limitation.

**Q: Do I need a separate frontend deployment for staging?**

Only if you want a separate URL.  The frontend bundle is
stateless — it doesn't know whether the indexer it's talking
to has staging or production data.  Many operators run a
single frontend bundle and serve it from both staging and
production origins.

**Q: My staging instance broke and I don't want to debug it.
Can I just blow it away?**

Yes — repeat Procedure 2 substituting `morphit_staging` for
`morphit_indexer` in Step 2.3, then re-run Procedure 1 from
the top.  Staging is meant to be cheap to recreate.

**Q: Will my staging account's reputation carry over to
production?**

No, because they're different accounts.  Reputation in
Morphit is per-Blurt-account, and your staging account
(`you-staging`) and production account (`you`) are entirely
unrelated identities to the chain.  This is the right
property — staging traffic SHOULD NOT pollute production
reputation.

**Q: I'm seeing "chain_id mismatch" errors at boot.  What
does that mean?**

This is the indexer refusing to boot because the chain_id in
your `morphit.env` doesn't match the chain_id recorded in the
indexer_state table.  Either (a) you're trying to switch
chains without wiping the DB — see "Q: Can I just edit
MORPHIT_INDEXER_CHAIN_ID" above; or (b) you typoed the value
in your env file.  Fix the typo or wipe the DB; restart.

---

## Appendix: alternatives to staging-on-mainnet

Three other options exist.  None of them are recommended for
pre-launch testing today, but they're documented here so you
know the landscape.

### A community-maintained Blurt testnet does exist

Hosted by @nalexadre (the same operator who maintains
[BeBlurt](https://beblurt.com) and the
[blurt-nodes-checker](https://gitlab.com/beblurt/blurt-nodes-checker)
library Morphit cites in `OPERATIONS.md §22`).  Documented
in this 2023 blog post:
[Blurt Blockchain Testnet with Nexus](https://beblurt.com/@nalexadre/blurt-blockchain-testnet-with-nexus-1690926923012).

**Testnet access details:**

| Field            | Value                                                                |
|---|---|
| RPC endpoint     | `https://testnet-rpc.beblurt.com`                                    |
| Chain ID         | `1df54a5cc86f7c7efee2402e1304df6eae24eb8766a63c0546c1b2511cf5eba6`    |
| Address prefix   | `TST` (mainnet uses `BLT`)                                           |
| Asset symbol     | `TESTS` (mainnet uses `BLURT`)                                       |
| Companion CLI    | [blurt-tools-cmd](https://gitlab.com/beblurt/blurt-tools-cmd) (GPLv3) |

The endpoint is live (`curl https://testnet-rpc.beblurt.com/`
returns `{"status":"OK"}`).

**Why Morphit can't use it today:** Morphit's codebase hard-
codes the mainnet address prefix (`BLT`) and asset symbol
(`BLURT`) in ~7 places — pubkey validators, fee-amount
regexes, frontend chain-verify, and the dblurt Client
constructor's address-prefix arg.  Pointing the indexer at
`testnet-rpc.beblurt.com` today produces validation failures
on every chain op it tries to apply.

Making Morphit testnet-aware is a tracked item in
`docs/REVISIT-LIST.md` Section D — estimated ~2-3 hours of
careful work plus smoke regression — but **no operator
currently needs it before launch**, so it's deferred.

**If you just want to explore the testnet directly without
Morphit on top:** the `blurt-tools-cmd` CLI from the same
author talks to `testnet-rpc.beblurt.com` out of the box and
is the canonical way to send TESTS, create testnet accounts,
and exercise basic chain ops.  Useful for sysadmins who want
to understand Blurt at the chain level without spending real
BLURT.  Not connected to Morphit in any way; purely a Blurt
chain explorer/wallet.

### Self-hosted Blurt testnet via Docker

Run `blurtd` locally in test mode (see Blurt's witness
documentation for the Docker recipe) and point your tools at
`http://localhost:8091`.  Same Morphit code-change blocker
as the public testnet; useful only if you're hacking on
Blurt protocol internals, not for app-layer testing.

### Mock chain via smoke tests only

Don't actually connect to a chain.  Validate the deployment
using just the bundled smoke tests:

```sh
cd /opt/morphit
bash scripts/run-smokes.sh
```

The smoke suite covers 1179+ scenarios end-to-end without
touching the real network.  This validates that your build,
schema migrations, and operator-config plumbing are all
working — but doesn't exercise live RPC behavior.  Use it as
a pre-deploy sanity check, not as a substitute for actual
staging.

---

## See also

- [`docs/RUN-A-MORPHIT-NODE.md`](RUN-A-MORPHIT-NODE.md) — full
  first-time deployment walkthrough.
- [`docs/OPERATIONS.md`](OPERATIONS.md) — operator runbook
  (backups, top-ups, RPC list updates, etc.).
- [`apps/indexer/README.md`](../apps/indexer/README.md) —
  indexer-specific operational notes.
- `ops/env/indexer.env.example` — full annotated env file
  with every available knob documented.
