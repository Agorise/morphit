#!/bin/sh
# certbot manual-cleanup-hook (written by Morphit): removes the check file
# from BunkerWeb's Let's Encrypt folder again.
set -u
case "${CERTBOT_TOKEN:-}" in '' | *[!A-Za-z0-9_-]*) exit 0 ;; esac
edge=$(docker ps --filter label=bunkerweb.type=bunkerweb --format '{{.Names}}' | head -1)
[ -n "$edge" ] || edge=bunkerweb
docker exec "$edge" rm -f "/var/tmp/bunkerweb/lets-encrypt/.well-known/acme-challenge/$CERTBOT_TOKEN" || true
