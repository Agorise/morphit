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
starting points.  The Ansible playbook deploys a **templated**
version of this BunkerWeb config (see "What the Ansible playbook
does" below for the small, deliberate differences).

## License

BunkerWeb is AGPL-3.0 (https://www.bunkerweb.io/license/), same
as Morphit.  No license conflict.  We ship CONFIG here, not
BunkerWeb source code.

## What's in this directory

- `docker-compose.yml` — pinned BunkerWeb + scheduler images plus a
  `frontend` nginx service, on a dedicated `bunkerweb_net` Docker
  network whose CIDR is fixed at `172.20.0.0/16` — inside the
  `172.16.0.0/12` Docker pool the relay and indexer trust by default, so
  neither needs a trusted-proxy setting.  A `bw-init` one-shot container runs
  first (as root) to fix `bw-data` + Let's Encrypt cert ownership for
  the image-default UID, then exits — see the compose comments and the
  troubleshooting note in Quick Start step 6.
- `frontend/` — the build context for the `frontend` nginx container:
  a `Dockerfile` (stock `nginx:alpine`) and `nginx.conf`.  This
  container serves the built SvelteKit static site AND reverse-proxies
  the API paths (`/v1/`, `/relay/`, `/rss/`, and the SSE `.../stream`
  paths) to the relay + indexer on the host.  Its routing mirrors
  `ops/nginx/web.conf` minus TLS (BunkerWeb terminates it). It sends the
  security headers itself (CSP, Permissions-Policy, X-Frame-Options,
  nosniff, Referrer-Policy) because Tor/I2P visitors reach it directly,
  without BunkerWeb; on a `.onion`/`.i2p` name its CSP's `connect-src` is
  narrowed to the hidden Blurt RPC nodes. It keeps no access log.
- `bunkerweb.env.example` — environment variables with sensible
  defaults: a single `REVERSE_PROXY_HOST` pointing BunkerWeb at the
  `frontend` container, OWASP CRS paranoia level 3, every BunkerWeb
  feature that contacts a third party or looks up visitors turned off
  (BunkerNet, DNSBL, the black/white/grey lists, anonymous report,
  anti-bot, metrics), Real-IP forwarding wired for the relay's
  trusted-proxy chain, and the **security headers** (`CONTENT_SECURITY_POLICY`,
  `REFERRER_POLICY`, `X_FRAME_OPTIONS`, `PERMISSIONS_POLICY`) for clearnet
  visitors. BunkerWeb keeps the frontend's own values for these headers
  where the frontend sends them (its default `KEEP_UPSTREAM_HEADERS`) —
  that is how the strict "never runs anything" policy on SVG images reaches
  browsers. The CSP mirrors `ops/nginx/web.conf`
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
#    values flagged with DUMMY-VALUE (no country blocks, ever; no ASN
#    blocks: they need the blacklist plugin, which Morphit leaves off).  Then give compose the Docker
#    socket's group:
sudoedit /etc/bunkerweb/bunkerweb.env
echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" | sudo tee /etc/bunkerweb/.env

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

# 5. Trusted proxies: nothing to do.  Since v1.20.0 the relay and the
#    indexer trust forwarded headers from loopback + 172.16.0.0/12
#    (Docker's default bridge pool), which covers this compose's
#    172.20.0.0/16.  Only if you moved bunkerweb_net outside that pool
#    (a 10.x pool, say), set MORPHIT_RELAY_TRUSTED_PROXY_IPS (in
#    /etc/morphit/relay.env) and MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS
#    (in /etc/morphit/indexer.env) to its CIDR and restart both.

# 6. Bring the stack up.  `up -d` builds the frontend image on first
#    run.  After editing frontend/nginx.conf, rebuild it explicitly:
cd /etc/bunkerweb && sudo docker compose up -d
#   (after an nginx.conf change:)  sudo docker compose up -d --build
#
#   The `bw-init` container runs first (as root) and fixes bw-data +
#   Let's Encrypt cert ownership for the image-default UID, then exits
#   — this is why `docker compose ps` shows it "Exited (0)".  That is
#   expected, not a failure.
#
#   TROUBLESHOOTING — if the site serves a self-signed cert, or the
#   scheduler logs "Database is not initialized" in a loop, the perm
#   init didn't take (e.g. you brought the stack up with an older copy
#   of this compose that had no bw-init).  Fix the perms by hand and
#   re-up:
#     sudo docker run --rm --entrypoint sh \
#       -v bunkerweb_bw-data:/data -v /etc/letsencrypt:/etc/letsencrypt \
#       bunkerity/bunkerweb-scheduler:1.5.10 -c \
#       'chown -R 101:101 /data; chgrp -R 101 /etc/letsencrypt/live /etc/letsencrypt/archive; chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive'
#     cd /etc/bunkerweb && sudo docker compose up -d

# 7. Verify — the easy way: a single health check.
sudo morphit-ops bunkerweb
#   Reports whether the containers are running + healthy, or what's
#   wrong. (Also in the interactive menu: "Web firewall (BunkerWeb)
#   status".)  Or inspect directly — the site root should serve the
#   app, and the API paths should reach the services:
sudo docker compose logs --tail 50 bunkerweb-scheduler frontend
#   The `bunkerweb` container itself keeps NO log (privacy: its error, ban
#   and ModSecurity lines name visitors), so `docker compose logs bunkerweb`
#   shows nothing — unless CrowdSec (or another tool) reads its log, in
#   which case it keeps a small `local` log (5 MB × 1) and LOG_FORMAT keeps
#   the address (see the compose comments). To watch it live while
#   debugging, with nothing stored:
#     sudo docker attach --no-stdin --sig-proxy=false bunkerweb
#   (Ctrl-C detaches; the container keeps running.)
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

## Client addresses and trusted proxies

BunkerWeb (`USE_REAL_IP=no`) is the public edge: the address on its socket
IS the visitor, which it passes to the frontend as `X-Real-IP`. It proxies
to the frontend's **edge listener `:8088`** (`REVERSE_PROXY_HOST=http://frontend:8088`).
Only a request arriving on `:8088` from Docker's address pool
(`172.16.0.0/12`) may name the visitor; the frontend then sends that one
address as the only `X-Forwarded-For` entry to the relay and indexer.
Everything else — Tor/I2P through the port published on the host's
`127.0.0.1` (→ `:80`), or another container on the bridge — is keyed on its
own socket address, so a Tor visitor can never inject an `X-Real-IP` and
pick a rate-limit bucket (all Tor/I2P visitors share one). **Never publish
`:8088`, and never point a Tor/I2P proxy at it.** A BunkerWeb still on
`frontend:80` fails safe (every clearnet visitor shares one bucket);
`morphit-ops upgrade` switches it to `:8088` once the frontend serves the
new config, and checks the site still answers.

The relay and the indexer trust forwarded headers from loopback plus
`172.16.0.0/12` by default (v1.20.0), so this compose needs no
`MORPHIT_RELAY_TRUSTED_PROXY_IPS` / `MORPHIT_INDEXER_TRUSTED_PROXY_CIDRS`.
Set them (each REPLACES its default; loopback stays trusted) only for a
proxy outside that pool.

**Too wide** (e.g., `0.0.0.0/0`): anyone can forge
`X-Forwarded-For` → rate limits bypassed entirely.

Verify after deploy by sending a spoofed `X-Forwarded-For` from
an IP that is NOT in the trusted CIDR — the relay should ignore
it.  See `docs/OPERATIONS.md` §37.19 for the concrete curl test.

## What `morphit-ops upgrade` does to these containers

- It finds BunkerWeb by its image (`bunkerity/bunkerweb`, publishing 443),
  never by container name. A plain-nginx edge, several candidates, or a
  container not started by Compose is left alone, with a calm note.
- It recreates only the edge, a BunkerWeb scheduler that reads the same env
  file, and the frontend — `docker compose up -d --no-deps` with every `-f`
  file and the recorded `--env-file`.
- Visitor-address logging: BunkerWeb keeps no Docker log (`logging: driver:
  none`) and its `LOG_FORMAT` names no address — except when CrowdSec reads
  BunkerWeb's log (or that cannot be checked), in which case it keeps a
  `local` 5 MB × 1 Docker log and the address stays in `LOG_FORMAT`, so
  CrowdSec keeps working.
- It switches `REVERSE_PROXY_HOST` from `frontend:80` to `frontend:8088`
  (see "Client addresses and trusted proxies").
- It finishes within 120 s, and if it is stopped mid-change it restores the
  files byte for byte.

## Version pinning + drift

BunkerWeb's env-var names change between major versions (1.5.x →
1.6.x is a known transition with renames).  Image tags are pinned
in `docker-compose.yml`.  When upgrading, read the BunkerWeb
release notes for env-var renames and update `bunkerweb.env`
accordingly.  Do NOT upgrade across major versions without
testing in staging.

## Customization that's expected per-deployment

- `SERVER_NAME` — your instance's public domain.
- IP or network blocks — ASN blocks need BunkerWeb's blacklist plugin,
  which stays off because it looks up the reverse DNS of every visitor.
  Block an address or network with
  `CUSTOM_CONF_SERVER_HTTP_morphit_ip_blocks=deny <address-or-network>; …`
  in `/etc/bunkerweb/bunkerweb.env`, then run
  `sudo docker compose up -d --force-recreate` in the compose directory on
  the server (`OPERATIONS.md` §37.13a). Watch BunkerWeb live with
  `sudo docker attach --no-stdin --sig-proxy=false bunkerweb` (nothing is
  stored).
- No country blocks: `BLACKLIST_COUNTRY` / `WHITELIST_COUNTRY` stay empty on
  every Morphit instance (people behind national firewalls must reach the
  instance they choose); `morphit-ops upgrade` empties any it finds.
- OWASP CRS paranoia level — defaults to 3.  Drop to 2 if you
  see real-user false positives (watch BunkerWeb live as above); raise to
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

The `morphit-ansible` playbook's `bunkerweb` role ships a
**templated** version of this configuration (`docker-compose.yml.j2`
+ `bunkerweb.env.j2` under `ops/ansible/roles/bunkerweb/templates/`),
brings the compose up, and enables it.  If you're using the playbook,
you don't `cp` this directory manually; the playbook handles it.  If
you're not using the playbook, follow the Quick Start above.

**The two carry the same security posture** (the same
WAF/CRS/rate-limit/bad-behavior settings, the same security headers,
and the same list of BunkerWeb features turned OFF because they would
tell a third party about your visitors: BunkerNet, DNSBL, the
black/white/greylist plugins and the anonymous report; antibot off).
In both, the scheduler finds the BunkerWeb instance through the Docker
socket (mounted read-only, with a `group_add` for the socket's group —
the manual compose needs `DOCKER_GID` in `/etc/bunkerweb/.env`: `echo
"DOCKER_GID=$(getent group docker | cut -d: -f3)" | sudo tee
/etc/bunkerweb/.env`) and pushes the configuration over the instance
API; there is no shared-volume coordination. Both mount
`/etc/letsencrypt` into the scheduler and the instance, both run the
`bw-init` one-shot that fixes `bw-data` + certificate ownership, and
both publish the frontend on `127.0.0.1:8090` (where Tor and i2pd
deliver hidden-service visitors). `BUNKERWEB_INSTANCES` is not a
BunkerWeb 1.5.10 setting and appears in neither. A smoke compares the
security-relevant keys of the example env with the template.

