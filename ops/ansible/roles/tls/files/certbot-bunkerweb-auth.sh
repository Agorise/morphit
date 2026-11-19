#!/bin/sh
# certbot manual-auth-hook (written by Morphit): BunkerWeb answers
# /.well-known/acme-challenge/ itself, from its own folder inside its
# container, so Let's Encrypt's check file is put there.
set -eu
case "${CERTBOT_TOKEN:-}" in '' | *[!A-Za-z0-9_-]*) echo "unexpected token" >&2; exit 1 ;; esac
edge=$(docker ps --filter label=bunkerweb.type=bunkerweb --format '{{.Names}}' | head -1)
[ -n "$edge" ] || edge=bunkerweb
printf '%s' "$CERTBOT_VALIDATION" | docker exec -i "$edge" sh -c 'mkdir -p "$1" && cat > "$1/$2"' _ /var/tmp/bunkerweb/lets-encrypt/.well-known/acme-challenge "$CERTBOT_TOKEN"
