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
  signs with the relay's active key, pays the chain's BLURT fee,
  and broadcasts.

The user's private keys never reach the relay. The client ships only
the four public keys that will govern their new account; the relay
signs the creation op with its own active key and pays the fee in
BLURT.

## Stack

- **Node.js 24 LTS** (get from [nodejs.org](https://nodejs.org/en/download))
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

Requires Node.js 24 or newer.

    cd apps/relay
    npm install
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

## Deploy to VPS

### 1. DNS record

Add an **A record** (or AAAA for IPv6) pointing `relay.morphit.io`
at the VPS's public IP. Most registrars have a web UI; the exact
steps depend on your DNS provider, but the record is typically:

| Field     | Value                  |
| --------- | ---------------------- |
| Type      | A                      |
| Host/Name | relay                  |
| Value     | `<your VPS public IP>` |
| TTL       | 3600 (default is fine) |

Propagation is usually under 5 minutes; occasionally up to an hour.
Check with `dig relay.morphit.io` from any shell.

### 2. Install Node.js 24 on the VPS

On Ubuntu / Debian, use NodeSource's apt repo for the latest LTS:

    ssh your-vps
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
    node --version    # should be v24.x
    npm --version

### 3. VPS prep — one-time

    sudo useradd --system --home /opt/morphit-relay --shell /usr/sbin/nologin morphit-relay
    sudo mkdir -p /opt/morphit-relay /etc/morphit/keys
    sudo chown morphit-relay:morphit-relay /opt/morphit-relay

### 4. Install the active key

On a secure machine (**not** the VPS unless you trust its disk
encryption + physical access controls), export `morphit-relay`'s
**active** private key in WIF format (starts with `5...`).

    # Transfer with scp, not email or chat.
    scp relay-active.key your-vps:/tmp/relay-active.key
    ssh your-vps '
        sudo mv /tmp/relay-active.key /etc/morphit/keys/relay-active.key
        sudo chown morphit-relay:morphit-relay /etc/morphit/keys/relay-active.key
        sudo chmod 0400 /etc/morphit/keys/relay-active.key
    '

The relay refuses to start if this file has any group or other
permission bits set.

### 5. Install the env file

    scp ops/env/relay.env.example your-vps:/tmp/relay.env
    ssh your-vps '
        sudo mv /tmp/relay.env /etc/morphit/relay.env
        sudoedit /etc/morphit/relay.env
        # edit the file, save
        sudo chown morphit-relay:morphit-relay /etc/morphit/relay.env
        sudo chmod 0600 /etc/morphit/relay.env
    '

### 6. Install the relay source + dependencies

    # From your dev machine. Copy the relay source.
    rsync -a --exclude node_modules apps/relay/ your-vps:/tmp/morphit-relay/
    ssh your-vps '
        sudo rsync -a --chown=morphit-relay:morphit-relay /tmp/morphit-relay/ /opt/morphit-relay/
        sudo -u morphit-relay bash -c "cd /opt/morphit-relay && npm ci --omit=dev"
        rm -rf /tmp/morphit-relay
    '

`npm ci` installs exactly what `package-lock.json` specifies,
nothing more. `--omit=dev` skips test-only dependencies. The
node_modules directory ends up inside /opt/morphit-relay/,
owned by the service user.

### 7. Install the systemd unit

    scp ops/systemd/morphit-relay.service your-vps:/tmp/
    ssh your-vps '
        sudo install -m 0644 -o root -g root /tmp/morphit-relay.service /etc/systemd/system/
        sudo systemctl daemon-reload
        sudo systemctl enable morphit-relay
        sudo systemctl start  morphit-relay
        sudo systemctl status morphit-relay
    '

`systemctl status` should show `active (running)`. Follow logs with:

    sudo journalctl -u morphit-relay -f

### 8. Install the nginx vhost

    scp ops/nginx/relay.conf your-vps:/tmp/
    ssh your-vps '
        sudo mv /tmp/relay.conf /etc/nginx/sites-available/relay.morphit.io.conf
        sudo ln -s /etc/nginx/sites-available/relay.morphit.io.conf /etc/nginx/sites-enabled/
        sudo nginx -t && sudo systemctl reload nginx
    '

### 9. Provision the TLS cert

Once DNS has propagated (step 1) and nginx is reloaded with the
HTTP-only stub, certbot can fetch a Let's Encrypt cert:

    ssh your-vps 'sudo certbot --nginx -d relay.morphit.io'

Verify:

    curl -v https://relay.morphit.io/v1/health

### 10. Smoke test from the frontend

Point a dev build of `apps/web` at the staging relay origin:

    # apps/web/.env.local (or similar)
    PUBLIC_MORPHIT_RELAY_ORIGIN=https://relay.morphit.io

Then run `npm run dev` in `apps/web` and open the registration
flow — the browser's dev-tools network tab shows the relay calls
succeeding.

## Observability

- **Logs:** `sudo journalctl -u morphit-relay -f`
- **Status:** `sudo systemctl status morphit-relay`
- **Restart:** `sudo systemctl restart morphit-relay`
- **Disable temporarily:** `sudo systemctl stop morphit-relay`

## Troubleshooting

| Symptom                                                                  | Cause                                         | Fix                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------- |
| `config error: MORPHIT_RELAY_ACTIVE_KEY_FILE "..." has permissions 0640` | Key file readable by group                    | `sudo chmod 0400 /etc/morphit/keys/relay-active.key` |
| `config error: MORPHIT_RELAY_ACTIVE_KEY_FILE "...": no such file`        | Typo in env or file not created yet           | `sudo ls -la /etc/morphit/keys/`                     |
| Relay starts but `/` returns 404                                         | Expected — only `/v1/*` paths are served      | Use `/v1/health`                                     |
| CORS error in browser console                                            | Origin not in `MORPHIT_RELAY_ALLOWED_ORIGINS` | Edit env, `sudo systemctl restart morphit-relay`     |
| 502 from nginx                                                           | Relay not running                             | `sudo systemctl status morphit-relay`, check journal |
| `relay_out_of_funds` returned to clients                                 | Relay's BLURT balance is low                  | Transfer BLURT to the morphit-relay account          |

## Updating the relay

When a new release ships:

    # Build fresh on your dev machine.
    rsync -a --exclude node_modules apps/relay/ your-vps:/tmp/morphit-relay/
    ssh your-vps '
        sudo systemctl stop morphit-relay
        sudo rsync -a --chown=morphit-relay:morphit-relay /tmp/morphit-relay/ /opt/morphit-relay/
        sudo -u morphit-relay bash -c "cd /opt/morphit-relay && npm ci --omit=dev"
        sudo systemctl start morphit-relay
    '

There's a ~2-second gap when the old process is down and the new one
is starting. Nginx surfaces this as `502 Bad Gateway` for in-flight
requests during that window; the Morphit frontend retries
automatically so legitimate users experience at most a small delay.

## Rotating the relay's active key

Quarterly or on suspicion of compromise:

1. Generate a new active key pair (on a cold/air-gapped machine,
   using `@beblurt/dblurt`'s `PrivateKey.fromSeed()` or an offline
   tool).
2. Broadcast an `account_update` op from the current active key,
   setting the new pubkey as the active authority.
3. Replace `/etc/morphit/keys/relay-active.key` with the new WIF.
4. `sudo systemctl restart morphit-relay`.
5. Securely destroy the old key.

An ADR for the full key-rotation procedure lands in Phase 4 (item
#P2-14 on the carry-forward list).
