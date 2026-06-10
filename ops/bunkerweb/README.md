# ops/bunkerweb — turnkey BunkerWeb deployment for Morphit

This directory ships a tested-shape BunkerWeb configuration for
Morphit operators who want a WAF + reverse proxy in front of
their relay + indexer without rolling their own.

## Why this is here

BunkerWeb is the recommended reverse-proxy + WAF for any
public-facing Morphit instance.  See `docs/OPERATIONS.md` §32 for
the full rationale and architecture options.  This directory is
the **canonical config** that `OPERATIONS.md` §32 references —
extracted into its own directory so operators not using the
Ansible playbook can `cp + edit + docker compose up -d` to get the
same posture.

Same shipping pattern as `ops/nginx/` (canonical nginx vhosts),
`ops/systemd/` (systemd unit files), `ops/postgres/init.sql`
(canonical DB provisioning), `ops/backup/` (backup script + env
template).  Operators are encouraged to use these as their
starting points; the Ansible playbook deploys them verbatim.

## License

BunkerWeb is AGPL-3.0 (https://www.bunkerweb.io/license/), same
as Morphit.  No license conflict.  We ship CONFIG here, not
BunkerWeb source code.

## What's in this directory

- `docker-compose.yml` — pinned BunkerWeb + scheduler images plus a
  `frontend` nginx service, on a dedicated `bunkerweb_net` Docker
  network whose CIDR is fixed at `172.20.0.0/16` so the relay's
  `MORPHIT_RELAY_TRUSTED_PROXY_IPS` can be hard-coded without
  re-inspecting after rebuilds.
- `frontend/` — the build context for the `frontend` nginx container:
  a `Dockerfile` (stock `nginx:alpine`) and `nginx.conf`.  This
  container serves the built SvelteKit static site AND reverse-proxies
  the API paths (`/v1/`, `/relay/`, `/rss/`, and the SSE `.../stream`
  paths) to the relay + indexer on the host.  Its routing mirrors
  `ops/nginx/web.conf` minus the TLS + security headers (BunkerWeb owns
  those).
- `bunkerweb.env.example` — environment variables with sensible
  defaults: a single `REVERSE_PROXY_HOST` pointing BunkerWeb at the
  `frontend` container, OWASP CRS paranoia level 3, anti-`Referer:
  none` rule on `/relay/v1/account/invite` (§38.6 item d), ASN-block
  stubs for cheap-VPS providers (§38.6 item c, commented in; uncomment
  to activate), Real-IP forwarding wired for the relay's trusted-proxy
  chain, and the **security headers** (`CONTENT_SECURITY_POLICY`,
  `REFERRER_POLICY`, `X_FRAME_OPTIONS`, `PERMISSIONS_POLICY`) — BunkerWeb
  owns these since the
  frontend nginx.conf sets none. The CSP mirrors `ops/nginx/web.conf`
  exactly; **leave `CONTENT_SECURITY_POLICY` set**, because BunkerWeb's
  default (`default-src 'self'`) breaks the in-browser WASM crypto. See
  docs/OPERATIONS.md §15.
- This README.

## Topology

```
client ──TLS──> bunkerweb ──> frontend nginx ──> host relay (8080) / indexer (8081)
                (WAF, TLS,     (static build +
                 real-IP)       /v1 /relay /rss /SSE proxy)
```

BunkerWeb is the only public entry point.  It terminates TLS, runs the
WAF + rate limits, sets the real client IP, then proxies **every** path
to the `frontend` container.  The `frontend` nginx serves the SvelteKit
pages and forwards the API paths to the relay + indexer.  Keeping all
the path routing in one nginx (the same shape as the bare-metal
`ops/nginx/web.conf`) is far easier to get right than expressing
static-serving + SPA fallback + per-path proxy + SSE in BunkerWeb env
vars — which is why this directory ships a `frontend` container instead
of pointing BunkerWeb's reverse proxy straight at the services.

## Quick start

```sh
# 1. Copy this directory (INCLUDING the frontend/ build context) to a
#    deploy location.
sudo mkdir -p /etc/bunkerweb
sudo cp -r ops/bunkerweb/frontend /etc/bunkerweb/
sudo cp ops/bunkerweb/docker-compose.yml /etc/bunkerweb/
sudo cp ops/bunkerweb/bunkerweb.env.example /etc/bunkerweb/bunkerweb.env

# 2. Edit the env file — set SERVER_NAME, the operator-tunable
#    values flagged with DUMMY-VALUE, and any ASN/country blocks
#    you want active from the start.
sudoedit /etc/bunkerweb/bunkerweb.env

# 3. Ensure /etc/letsencrypt/ has a cert for SERVER_NAME (per
#    OPERATIONS.md §35).  BunkerWeb mounts this read-only.
sudo certbot certonly --standalone -d <your-morphit-domain>

# 4. Build the web app and ensure morphit relay + indexer are running
#    on the host (NOT in this compose — see "Why the morphit services
#    aren't in this compose" below).  The frontend container mounts the
#    build read-only from /opt/morphit/apps/web/build (edit the path in
#    docker-compose.yml if you cloned morphit elsewhere).
#
#    CRITICAL: the relay + indexer must listen on an address the Docker
#    bridge can reach (NOT 127.0.0.1 only) — bind them to the host's
#    docker-gateway address or 0.0.0.0 and firewall the ports so only
#    the bridge can reach them.  A loopback-only bind is unreachable
#    from the frontend container and every proxied call returns 502.

# 5. CRITICAL: set MORPHIT_RELAY_TRUSTED_PROXY_IPS in
#    /etc/morphit/relay.env to the Docker network CIDR
#    (172.20.0.0/16 by default in this compose — it covers BOTH the
#    BunkerWeb and frontend containers):
sudoedit /etc/morphit/relay.env
#   Add:  MORPHIT_RELAY_TRUSTED_PROXY_IPS=172.20.0.0/16
sudo systemctl restart morphit-relay

# 6. Bring the stack up.  `up -d` builds the frontend image on first
#    run.  After editing frontend/nginx.conf, rebuild it explicitly:
cd /etc/bunkerweb && sudo docker compose up -d
#   (after an nginx.conf change:)  sudo docker compose up -d --build

# 7. Verify — the easy way: a single health check.
npx morphit-ops bunkerweb
#   Reports whether the containers are running + healthy, or what's
#   wrong. (Also in the interactive menu: "Web firewall (BunkerWeb)
#   status".)  Or inspect directly — the site root should serve the
#   app, and the API paths should reach the services:
sudo docker compose logs --tail 50
curl -v https://<your-morphit-domain>/                  # SvelteKit app
curl -v https://<your-morphit-domain>/v1/instance       # indexer JSON
```

## Why the morphit services aren't in this compose

`docs/OPERATIONS.md` §33 documents Docker as an OPTIONAL deployment
path for the morphit services themselves.  The canonical path is
bare-metal systemd (`ops/systemd/*.service`).  This compose
deliberately includes ONLY BunkerWeb + the lightweight `frontend`
nginx (which just serves static files + proxies) so:

- Operators get BunkerWeb's value (WAF, OWASP CRS, real-IP) without
  having to commit to Dockerizing morphit.
- The `*_FILE` env-var-from-secret pattern in §33 isn't yet
  implemented in the indexer/relay config loaders (audit caveat
  2026-05-06), so Dockerized morphit currently has to inline
  credentials in `DATABASE_URL` anyway.
- Backup paths stay simple (Postgres on the host, not in a
  container volume that needs separate handling).

BunkerWeb proxies everything to the `frontend` container, and the
`frontend` nginx reaches the host-resident relay + indexer via
`host.docker.internal:<port>` (Linux: `host-gateway`).  The compose
sets this up automatically.

## Trusted-proxy CIDR — the critical setting

The relay only trusts `X-Forwarded-For` from IPs in
`MORPHIT_RELAY_TRUSTED_PROXY_IPS`.  Behind this BunkerWeb compose,
that value MUST be `172.20.0.0/16` (or whatever CIDR you change
the `bunkerweb_net` network to use).  The relay's immediate peer is
the `frontend` container (requests flow BunkerWeb → frontend →
relay), and BOTH containers live on `172.20.0.0/16`, so that one CIDR
is all the relay needs.  BunkerWeb sets the real client as the
leftmost `X-Forwarded-For` entry and the frontend appends to the
chain, so the relay reads the real client from `XFF[0]`.

**Too narrow:** the relay sees every user as the BunkerWeb
container's IP → one abuser exhausts the daily rate limit for
everyone.

**Too wide** (e.g., `0.0.0.0/0`): anyone can forge
`X-Forwarded-For` → rate limits bypassed entirely.

Verify after deploy by sending a spoofed `X-Forwarded-For` from
an IP that is NOT in the trusted CIDR — the relay should ignore
it.  See `docs/OPERATIONS.md` §37.19 for the concrete curl test.

## Version pinning + drift

BunkerWeb's env-var names change between major versions (1.5.x →
1.6.x is a known transition with renames).  Image tags are pinned
in `docker-compose.yml`.  When upgrading, read the BunkerWeb
release notes for env-var renames and update `bunkerweb.env`
accordingly.  Do NOT upgrade across major versions without
testing in staging.

## Customization that's expected per-deployment

- `SERVER_NAME` — your instance's public domain.
- ASN block list (`BLACKLIST_ASN`) — uncomment and populate based
  on your rejection logs.
- Country block list (`BLACKLIST_COUNTRY`) — empty by default;
  populate only under active attack (§38.6 item b).
- OWASP CRS paranoia level — defaults to 3.  Drop to 2 if you
  see real-user false positives in WAF rejection logs; raise to
  4 only if you can verify it doesn't break legitimate traffic.
- `LIMIT_REQ_RATE_1` — the COARSE edge ceiling on `/v1/`, set to
  `1800r/m`.  This is deliberately well above the indexer's own
  per-endpoint per-IP limits (120 r/m list / 600 r/m single-record,
  which are the real limiter); the WAF value only catches egregious
  abuse.  Do NOT tighten it toward the indexer's numbers: a single
  page load fires many `/v1/*` calls at once, and a tight edge limit
  turns that normal burst into `429`s.  `/relay/` is `120r/m` (the
  relay enforces its own deeper signup ceilings + spacing).
- Bad-behavior bans (`BAD_BEHAVIOR_*`) — by default BunkerWeb counts
  `400 401 403 404 405 429 444` and bans an IP that accumulates too
  many.  Morphit narrows the counted set to `400 401 405 444`,
  because for a SPA + PWA + public read API the excluded codes ban
  real users: `429` is the rate limiter's own response (a normal
  burst), `403` is ALSO what BunkerWeb returns to an already-banned
  IP (so counting it makes a ban self-perpetuate), and `404` is
  normal PWA/SPA asset/manifest/icon probing.  Threshold 50, ban
  3600s.  If you re-add any of the excluded codes, expect ordinary
  visitors to get banned during normal browsing.

## What the Ansible playbook does

The `morphit-ansible` playbook's `bunkerweb` role deploys this
directory verbatim to the target host and brings the compose up.
If you're using the playbook, you don't `cp` this directory
manually; the playbook handles it.  If you're not using the
playbook, follow the Quick Start above.
