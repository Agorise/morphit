#!/usr/bin/env bash
# Morphit — generate a VAPID keypair for Web Push notifications.
#
# Web Push uses VAPID (RFC 8292) so the push service (FCM /
# Mozilla autopush / Apple APNS) knows which server is the
# legitimate sender for a given subscription.  The operator
# generates their keypair ONCE; subsequent restarts reuse the
# same keys.  Changing the public key invalidates ALL existing
# subscriptions on this instance — users would have to
# re-subscribe.  Treat the private key like any other secret.
#
# Output: prints three lines to add to your operator config
# (typically /etc/morphit/relay.env or the systemd unit's
# Environment= lines).
#
# Usage:
#   bash scripts/generate-vapid-keys.sh
#
# Requirements: node + the relay's node_modules (`npm install` in
# apps/relay first).  Run from the repo root.

set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$repo/node_modules/web-push" ] && [ ! -d "$repo/apps/relay/node_modules/web-push" ]; then
	echo "ERROR: web-push not installed.  Run from the repo root:" >&2
	echo "  npm install" >&2
	exit 1
fi

cd "$repo"

# web-push ships a `generate-vapid-keys` CLI; we call its
# library form for a tighter, scriptable output.
node -e "
const webpush = require('web-push');
const k = webpush.generateVAPIDKeys();
console.log('# Add these to your relay config (e.g. /etc/morphit/relay.env).');
console.log('# The subject MUST be a mailto: or https:// URL identifying you.');
console.log('# Generated: ' + new Date().toISOString());
console.log('');
console.log('MORPHIT_RELAY_VAPID_PUBLIC_KEY=' + k.publicKey);
console.log('MORPHIT_RELAY_VAPID_PRIVATE_KEY=' + k.privateKey);
console.log('MORPHIT_RELAY_VAPID_SUBJECT=mailto:operator@example.com  # ← change me');
"
