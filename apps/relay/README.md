# Morphit relay

A small Node.js service that pays Blurt account-creation fees on
behalf of new Morphit users, without ever holding user private keys.

- **Phase:** 3a
- **Design doc:** [`../../docs/PHASE-3a-DESIGN.md`](../../docs/PHASE-3a-DESIGN.md)
- **Security model:**
  [`../../docs/adr/0002-live-keys-policy.md`](../../docs/adr/0002-live-keys-policy.md)
- **Deployment target:** a single VPS, typically behind nginx, running
  the `morphit-relay` Blurt account.

## What it does

One job, three HTTP endpoints:

- `GET /v1/health` — liveness / readiness. Returns JSON with status,
  version, uptime, and (in verbose mode) the relay's BLURT balance.
- `POST /v1/account/availability` — quick yes/no on whether a Blurt
  account name is taken, combining a structural-rule check with a
  chain lookup.
- `POST /v1/account/create` — accepts an unsigned
  `account_create` op body from the client, validates rigorously,
  signs with the relay's active key, pays the chain's live
  `account_creation_fee` (~100 BLURT) from the relay's liquid
  balance, broadcasts, then sends the new account 2 BLURT so it can
  pay its first operation fees — ~102 BLURT per signup. (Blurt
  disabled account-creation tokens at HF2; there is no fee-free path.)

The user's private keys never reach the relay. The client ships only
the four public keys that will govern their new account; the relay
signs the creation op with its own active key and pays the fee in
BLURT.

## Stack

- **Node.js 22 or newer** (the guided install sets it up; `engines` in package.json)
- **TypeScript** — matches the frontend
- **[@beblurt/dblurt](https://www.npmjs.com/package/@beblurt/dblurt)** —
  the same Blurt library the Morphit frontend uses. Promise-based,
  TypeScript-native, documents every op we need.
- **[Hono](https://hono.dev/)** — tiny HTTP router, ~3 transitive
  deps. Smaller attack surface than Express.
- **[zod](https://zod.dev/)** — runtime schema validation.
- **[tsx](https://tsx.is/)** — production TS runtime (esbuild-powered).
  No separate build step.

## Build locally

Requires Node.js 22 or newer. Install from the repo root (the relay
depends on workspace packages such as `@morphit/rpc-pool`):

    npm install          # at the repo root
    cd apps/relay
    # Generate a throwaway test WIF to satisfy startup validation.
    # In production this holds the REAL morphit-relay active key.
    echo "5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe" > /tmp/test.key
    chmod 0400 /tmp/test.key
    export MORPHIT_RELAY_ACCOUNT=morphit-relay
    export MORPHIT_RELAY_ACTIVE_KEY_FILE=/tmp/test.key
    export MORPHIT_RELAY_ALLOWED_ORIGINS=http://localhost:5173
    npm run dev

Hit the health endpoint:

    curl -s http://127.0.0.1:8080/v1/health | jq .

Run tests:

    npm test

Type-check without running:

    npm run typecheck

## Deploy

The relay is not deployed on its own. The guided install
(`sudo bash morphit-setup.sh` → *Full guided install*, see
[`docs/RUN-A-MORPHIT-NODE.md`](../../docs/RUN-A-MORPHIT-NODE.md)) or the
Ansible playbook ([`ops/ansible/`](../../ops/ansible/README.md)) installs it
with the rest of the node:

- code in `/opt/morphit/apps/relay`, run by `morphit-relay.service`
  ([`ops/systemd/morphit-relay.service`](../../ops/systemd/morphit-relay.service))
  from TypeScript source via the workspace's `tsx`;
- settings in `/etc/morphit/relay.env` (plus `/opt/morphit/morphit.env` and
  `morphit.config.env`); the unit reads these files itself, so a systemd
  `Environment=` override does **not** win over a value set in them — edit
  the file and `sudo systemctl restart morphit-relay`;
- the active key as an encrypted keystore — the file
  `MORPHIT_RELAY_ACTIVE_KEY_FILE` names (`/etc/morphit/relay.keystore` on a
  guided/Ansible install; `apps/relay/keystore.json` after a hand-run
  `init`) — unlocked at boot from a systemd-encrypted credential, never a
  plaintext WIF on disk;
- state in `/var/lib/morphit-relay` (the signup kill-switch file and the
  persisted daily-ceiling count).

Every setting is documented in [`ops/env/relay.env.example`](../../ops/env/relay.env.example)
and `docs/OPERATIONS.md`.

## Error codes worth knowing (`POST /v1/account/create`)

| `code` | Meaning |
| --- | --- |
| `signups_disabled` (503) | Signups are paused: `/var/lib/morphit-relay/SIGNUPS_DISABLED` exists, or `MORPHIT_RELAY_SIGNUP_ENABLED=false` |
| `daily_ceiling_reached` (503) | Today's `MORPHIT_RELAY_SIGNUP_DAILY_CEILING` is used up (resets at UTC midnight; survives restarts) |
| `relay_out_of_funds` (503) | The relay can't cover the live fee + 3 BLURT, or its last balance poll is over 90 s old |
| `relay_fee_spike` (503) | The chain's live `account_creation_fee` is more than 1.5× `MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT`; nothing is broadcast or spent until you confirm the new fee and set it |
| `broadcast_outcome_unknown` (503) | No node confirmed the transaction and the chain can't yet say whether it landed; counted as spent, never re-signed. A retry with the same name is safe: the relay checks the chain first and answers success (`note: "already_created"`) if the account exists with the caller's owner key, or 409 `already_registered` if it exists with another; the per-IP slot is held 30 min so the retry isn't refused for spacing |

A success may carry `note: "recovered_after_lost_reply"` (the account landed
although the node's reply was lost) or `note: "already_created"`.

Verbose `/v1/health` also reports `transfer_queue: { unsettled, escalated }`
for the payout queue (welcome bonus, dust, BP): non-zero `escalated` means a
payout could not be settled from the account history and needs a manual
check (see OPERATIONS.md §5).

## Observability

- **Logs:** `sudo journalctl -u morphit-relay -f`
- **Status:** `sudo systemctl status morphit-relay`
- **Restart:** `sudo systemctl restart morphit-relay`
- **Disable temporarily:** `sudo systemctl stop morphit-relay`

## Troubleshooting

| Symptom                                                                  | Cause                                         | Fix                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------- |
| `config error: MORPHIT_RELAY_ACTIVE_KEY_FILE "..." has permissions 0640` | Key file readable by group                    | `sudo chmod 0600` the file named in `MORPHIT_RELAY_ACTIVE_KEY_FILE` |
| `config error: MORPHIT_RELAY_ACTIVE_KEY_FILE "...": no such file`        | Typo in env or file not created yet           | `grep MORPHIT_RELAY_ACTIVE_KEY_FILE /opt/morphit/morphit.env`                     |
| Relay starts but `/` returns 404                                         | Expected — only `/v1/*` paths are served      | Use `/v1/health`                                     |
| CORS error in browser console                                            | Origin not in `MORPHIT_RELAY_ALLOWED_ORIGINS` | Edit env, `sudo systemctl restart morphit-relay`     |
| 502 from nginx                                                           | Relay not running                             | `sudo systemctl status morphit-relay`, check journal |
| `relay_out_of_funds` returned to clients                                 | Relay's BLURT balance is low                  | Transfer liquid BLURT to your relay account          |

## Updating the relay

The relay is updated with the rest of the node — on the server:

    sudo morphit-ops upgrade

It backs up, installs the new release, restarts the services and rolls back
on failure (see [`docs/UPGRADING.md`](../../docs/UPGRADING.md)).

## Rotating the relay's active key

Quarterly or on suspicion of compromise, on the server:

1. Generate a new key pair offline and set it as the relay account's
   active authority with an `account_update` op (signed with the account's
   owner or current active key, from your own computer — not the server).
2. `sudo morphit-ops edit-active-key` — replaces the saved keystore with the
   new key (it asks whether to keep a backup of the old one) and tells you
   to restart the relay.
3. `sudo systemctl restart morphit-relay`.

Full procedure, including the "wrong key was installed" case:
[`docs/RECOVERING-FROM-WRONG-RELAY-KEY.md`](../../docs/RECOVERING-FROM-WRONG-RELAY-KEY.md).
