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

- `docker-compose.yml` — pinned BunkerWeb + scheduler images, with
  a dedicated `bunkerweb_net` Docker network whose CIDR is fixed
  at `172.20.0.0/16` so the relay's `MORPHIT_RELAY_TRUSTED_PROXY_IPS`
  can be hard-coded without re-inspecting after rebuilds.
- `bunkerweb.env.example` — environment variables with sensible
  defaults: OWASP CRS paranoia level 3, anti-`Referer: none` rule
  on `/v1/relay/account/invite` (§38.6 item d), ASN-block stubs
  for cheap-VPS providers (§38.6 item c, commented in; uncomment
  to activate), Real-IP forwarding wired for the relay's
  trusted-proxy chain.
- This README.

## Quick start

```sh
# 1. Copy this directory's contents to a deploy location.
sudo mkdir -p /etc/bunkerweb
sudo cp ops/bunkerweb/docker-compose.yml /etc/bunkerweb/
sudo cp ops/bunkerweb/bunkerweb.env.example /etc/bunkerweb/bunkerweb.env

# 2. Edit the env file — set SERVER_NAME, the operator-tunable
#    values flagged with DUMMY-VALUE, and any ASN/country blocks
#    you want active from the start.
sudoedit /etc/bunkerweb/bunkerweb.env

# 3. Ensure /etc/letsencrypt/ has a cert for SERVER_NAME (per
#    OPERATIONS.md §35).  BunkerWeb mounts this read-only.
sudo certbot certonly --standalone -d <your-morphit-domain>

# 4. Ensure morphit relay + indexer are running on the host
#    (NOT in this compose — see "Why morphit isn't in this
#    compose" below) and bound to 127.0.0.1.

# 5. CRITICAL: set MORPHIT_RELAY_TRUSTED_PROXY_IPS in
#    /etc/morphit/relay.env to the Docker network CIDR
#    (172.20.0.0/16 by default in this compose):
sudoedit /etc/morphit/relay.env
#   Add:  MORPHIT_RELAY_TRUSTED_PROXY_IPS=172.20.0.0/16
sudo systemctl restart morphit-relay

# 6. Bring BunkerWeb up.
cd /etc/bunkerweb && sudo docker compose up -d

# 7. Verify.
sudo docker compose logs --tail 50
curl -v https://<your-morphit-domain>/v1/instance
```

## Why morphit isn't in this compose

`docs/OPERATIONS.md` §33 documents Docker as an OPTIONAL deployment
path for the morphit services themselves.  The canonical path is
bare-metal systemd (`ops/systemd/*.service`).  This compose
deliberately includes ONLY BunkerWeb so:

- Operators get BunkerWeb's value (WAF, OWASP CRS, real-IP) without
  having to commit to Dockerizing morphit.
- The `*_FILE` env-var-from-secret pattern in §33 isn't yet
  implemented in the indexer/relay config loaders (audit caveat
  2026-05-06), so Dockerized morphit currently has to inline
  credentials in `DATABASE_URL` anyway.
- Backup paths stay simple (Postgres on the host, not in a
  container volume that needs separate handling).

BunkerWeb reaches the host-resident relay + indexer via
`host.docker.internal:<port>` (Linux: `host-gateway`).  The compose
sets this up automatically.

## Trusted-proxy CIDR — the critical setting

The relay only trusts `X-Forwarded-For` from IPs in
`MORPHIT_RELAY_TRUSTED_PROXY_IPS`.  Behind this BunkerWeb compose,
that value MUST be `172.20.0.0/16` (or whatever CIDR you change
the `bunkerweb_net` network to use).

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
- `LIMIT_REQ_RATE` — defaults to 60r/m on `/v1/`.  Tune for your
  traffic.

## What the Ansible playbook does

The `morphit-ansible` playbook's `bunkerweb` role deploys this
directory verbatim to the target host and brings the compose up.
If you're using the playbook, you don't `cp` this directory
manually; the playbook handles it.  If you're not using the
playbook, follow the Quick Start above.
