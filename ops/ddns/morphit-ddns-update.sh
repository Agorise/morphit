#!/bin/sh
# morphit-ddns-update.sh — provider-agnostic dynamic-DNS updater.
#
# Pushes THIS box's current public IPv4 to your DNS provider so a home node
# stays reachable at your OWN domain even when your ISP changes your address.
# Runs on a timer (morphit-ddns.timer) + on boot.  You bring a real domain from
# any registrar, and this keeps its A record pointed at you — no free-hostname
# service needed.
#
# Nothing "watches" your IP from the provider's side — this little updater on
# YOUR box notices the change and pushes it to the provider's update URL.
#
# POSIX sh (dash-safe).  Non-fatal + logged: a DNS hiccup must NEVER take the
# node down.  Idempotent: it only calls the provider when the IP actually
# changed since the last successful push.
#
# Config (root-written, 0600 — it holds your provider secret, so keep it 0600):
#   /etc/morphit/ddns.env
#     MORPHIT_DDNS_UPDATE_URL  full provider update URL; the literal token {ip}
#                              is replaced with the detected public IP.  The
#                              provider key/password lives INSIDE this URL
#                              (hence 0600).  The setup step builds it for you
#                              from a short provider menu; examples:
#                                Njalla:    https://njal.la/update/?h=DOMAIN&k=KEY&a={ip}
#                                Namecheap: https://dynamicdns.park-your-domain.com/update?host=HOST&domain=DOMAIN&password=PASS&ip={ip}
#     MORPHIT_DDNS_IP_URL      space-separated list of plain-text "echo my IP"
#                              services, tried in order until one answers
#                              (default: three public ones).  Every run (every
#                              5 minutes by default) asks the first that
#                              answers, so THAT service sees this box's public
#                              address each time — set your own single choice,
#                              or a service you host, to decide who that is.
#     MORPHIT_DDNS_STATE_FILE  caches the last-pushed IP (default
#                              /var/lib/morphit/ddns.last) so an unchanged IP
#                              is a no-op — we never hammer the provider.
set -u

log() { echo "morphit-ddns: $*" >&2; }

# Manual runs (not via systemd) don't inherit the unit's EnvironmentFile, so
# read the operator's persisted config here too — PARSED, not sourced: the
# documented provider URLs contain `&`, which a shell reading the file would
# take as "run in the background", leaving the URL cut short and the updater
# "not configured".  A value already in the environment (the unit's) wins.
DDNS_ENV="${MORPHIT_DDNS_ENV:-/etc/morphit/ddns.env}"
cfg_value() { # cfg_value KEY → the last KEY=value in ddns.env, quotes removed
	sed -n "s/^[[:space:]]*$1=//p" "$DDNS_ENV" 2>/dev/null | tail -n 1 |
		sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
if [ -r "$DDNS_ENV" ]; then
	[ -n "${MORPHIT_DDNS_UPDATE_URL:-}" ] || MORPHIT_DDNS_UPDATE_URL="$(cfg_value MORPHIT_DDNS_UPDATE_URL)"
	[ -n "${MORPHIT_DDNS_IP_URL:-}" ] || MORPHIT_DDNS_IP_URL="$(cfg_value MORPHIT_DDNS_IP_URL)"
	[ -n "${MORPHIT_DDNS_STATE_FILE:-}" ] || MORPHIT_DDNS_STATE_FILE="$(cfg_value MORPHIT_DDNS_STATE_FILE)"
fi

URL_TMPL="${MORPHIT_DDNS_UPDATE_URL:-}"
IP_URLS="${MORPHIT_DDNS_IP_URL:-https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip}"
STATE_FILE="${MORPHIT_DDNS_STATE_FILE:-/var/lib/morphit/ddns.last}"

command -v curl >/dev/null 2>&1 || { log "curl not installed — skipping."; exit 0; }
if [ -z "$URL_TMPL" ]; then
	log "not configured (run 'sudo morphit-ops harden' -> dynamic DNS) — nothing to do."
	exit 0
fi

# 1. Detect current public IPv4 (first service that returns something IPv4-shaped wins).
IP=""
for u in $IP_URLS; do
	CANDIDATE="$(curl -fsS --max-time 15 "$u" 2>/dev/null | tr -d '[:space:]')"
	case "$CANDIDATE" in
		*[!0-9.]*) : ;;                        # contains a non-[digit/dot] char → not a bare IPv4
		*.*.*.*)   IP="$CANDIDATE"; break ;;   # four dot-separated numeric groups
		*)         : ;;
	esac
done
if [ -z "$IP" ]; then
	log "could not determine public IPv4 (all resolvers unreachable?) — will retry next run."
	exit 0
fi

# 2. Skip if unchanged since the last SUCCESSFUL push.
LAST=""
[ -r "$STATE_FILE" ] && LAST="$(cat "$STATE_FILE" 2>/dev/null | tr -d '[:space:]')"
if [ "$IP" = "$LAST" ]; then
	log "IP unchanged ($IP) — no update needed."
	exit 0
fi

# 3. Substitute {ip} and push.  The secret is in the URL, so we do NOT put it on
#    curl's command line (that would show in `ps`): write the URL to a 0600 temp
#    file and let `curl -K` read it from there.
URL="$(printf '%s' "$URL_TMPL" | sed "s|{ip}|$IP|g")"
CFG="$(mktemp 2>/dev/null)" || { log "mktemp failed — skipping."; exit 0; }
chmod 600 "$CFG" 2>/dev/null || true
printf 'url = "%s"\n' "$URL" > "$CFG"

if curl -fsS --max-time 30 -K "$CFG" >/dev/null 2>&1; then
	rm -f "$CFG"
	mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
	printf '%s\n' "$IP" > "$STATE_FILE" 2>/dev/null || true
	log "updated DNS -> $IP."
	exit 0
else
	rm -f "$CFG"
	log "update call failed (provider unreachable / bad key) — will retry next run."
	exit 1
fi
