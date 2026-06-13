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
# Output: three env lines to add to your operator config
# (typically /etc/morphit/relay-vapid.env, which the relay unit
# sources automatically, or /etc/morphit/relay.env).
#
# Usage:
#   bash scripts/generate-vapid-keys.sh                      # human-readable
#   bash scripts/generate-vapid-keys.sh --subject <url>      # set the subject
#   bash scripts/generate-vapid-keys.sh --bare --subject <url>   # clean env-only
#
# Flags:
#   --subject <url>   VAPID subject (a mailto: or https:// URL identifying
#                     the operator).  Default is a placeholder.
#   --bare | --env    Emit ONLY a managed header + the three env lines (no
#                     instructional comments, no "change me" hint), so the
#                     output can be redirected straight into an env file.
#                     The install paths use `--bare --subject <origin>`.
#
# Requirements: node + the relay's node_modules (`npm install` in
# the repo root first).  Run from the repo root.

set -eu

SUBJECT=""
BARE=0
while [ $# -gt 0 ]; do
	case "$1" in
		--subject) SUBJECT="${2:-}"; shift 2 ;;
		--subject=*) SUBJECT="${1#--subject=}"; shift ;;
		--bare|--env) BARE=1; shift ;;
		-h|--help) sed -n '2,33p' "$0"; exit 0 ;;
		*) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
	esac
done

repo="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$repo/node_modules/web-push" ] && [ ! -d "$repo/apps/relay/node_modules/web-push" ]; then
	echo "ERROR: web-push not installed.  Run from the repo root:" >&2
	echo "  npm install" >&2
	exit 1
fi

cd "$repo"

# web-push ships a `generate-vapid-keys` CLI; we call its library
# form for a tighter, scriptable output.  SUBJECT + BARE are passed
# via the environment (not string-interpolated) so an exotic subject
# value can't break the node program.
MORPHIT_VAPID_SUBJECT="$SUBJECT" MORPHIT_VAPID_BARE="$BARE" node -e '
const webpush = require("web-push");
const k = webpush.generateVAPIDKeys();
const subject = process.env.MORPHIT_VAPID_SUBJECT || "mailto:operator@example.com";
const bare = process.env.MORPHIT_VAPID_BARE === "1";
const explicitSubject = !!process.env.MORPHIT_VAPID_SUBJECT;
const lines = [];
if (bare) {
  lines.push("# Morphit Web Push VAPID keys — managed (generate-once); do not edit by hand.");
  lines.push("# Generated: " + new Date().toISOString());
} else {
  lines.push("# Add these to your relay config (e.g. /etc/morphit/relay-vapid.env).");
  lines.push("# The subject MUST be a mailto: or https:// URL identifying you.");
  lines.push("# Generated: " + new Date().toISOString());
  lines.push("");
}
lines.push("MORPHIT_RELAY_VAPID_PUBLIC_KEY=" + k.publicKey);
lines.push("MORPHIT_RELAY_VAPID_PRIVATE_KEY=" + k.privateKey);
const hint = (!bare && !explicitSubject) ? "  # \u2190 change me" : "";
lines.push("MORPHIT_RELAY_VAPID_SUBJECT=" + subject + hint);
console.log(lines.join("\n"));
'
