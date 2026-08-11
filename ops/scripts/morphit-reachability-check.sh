#!/usr/bin/env bash
# morphit-reachability-check.sh — can the PUBLIC INTERNET reach this node on
# 80/443?  A home box can't answer this by curling its own domain — the router
# won't loop an inside request back to its own public IP (NAT hairpin).  So we
# probe from an EXTERNAL vantage point using the Tor daemon this node already
# runs for its .onion: a Tor exit connects back to the clearnet domain, exactly
# like an outside visitor.  No third-party services, read-only, changes nothing.
#
# Exit status is always 0 (informational).  Usage:
#   morphit-reachability-check.sh [domain] [onion]
set -u

DOMAIN="${1:-}"
ONION="${2:-}"
SOCKS="127.0.0.1:9050"

say(){ printf '%s\n' "$*"; }

# ── detect the domain from the deployed env if not passed ─────────
if [ -z "$DOMAIN" ]; then
	DOMAIN="$(grep -rhoE 'MORPHIT_[A-Z_]*DOMAIN=[^ "'"'"']+' /etc/morphit/*.env /opt/morphit/*.env 2>/dev/null \
		| head -1 | sed -E 's/.*=//')"
fi
# ── detect the .onion if not passed ───────────────────────────────
if [ -z "$ONION" ]; then
	ONION="$(cat /var/lib/tor/*/hostname 2>/dev/null | head -1)"
fi

say ""
say "── Public reachability check ───────────────────────────"
if [ -z "$DOMAIN" ]; then
	say "  Couldn't detect your domain automatically."
	say "  Re-run with it:  bash $0 yourdomain.tld"
	say "────────────────────────────────────────────────────────"
	exit 0
fi
say "  Domain: $DOMAIN"

# 1. is the web stack actually listening on 443 locally?
if ! ss -tlnH 2>/dev/null | grep -qE ':443\b'; then
	say "  ⚠ Nothing is listening on 443 yet — the web stack may still be"
	say "    starting. Re-check in a minute (sudo morphit-ops status)."
	say "────────────────────────────────────────────────────────"
	exit 0
fi
say "  ✓ This box is listening on 80/443."

# 2. is this box even online? A home box installed air-gapped (cable unplugged)
# has no network, so probing reachability is meaningless — and must NEVER report
# "reachable". Check connectivity against Morphit's own federation hub first.
if ! timeout 8 curl -fsS -o /dev/null https://morphit.io/verify.json 2>/dev/null; then
	say ""
	say "  This box has no internet connection right now (an offline / air-gapped"
	say "  install won't have one yet). Reachability can't be checked without a"
	say "  network — re-run this once you're online:"
	say "      bash ops/scripts/morphit-reachability-check.sh"
	if [ -n "$ONION" ]; then
		say ""
		say "  (Your Tor address needs no port-forwarding and will reach the world"
		say "  once Tor finishes connecting:  http://$ONION)"
	fi
	say "────────────────────────────────────────────────────────"
	exit 0
fi

# Capture an HTTP status WITHOUT the classic `|| echo 000` double-append bug:
# curl's -w already prints 000 on a failed connection, so appending another 000
# yields "000000", which is != "000" and then falsely reads as a success.
probe() { # $1 = url
	local c
	c="$(curl --socks5-hostname "$SOCKS" -sk --max-time 30 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)"
	case "$c" in ''|000) printf '000' ;; *) printf '%s' "$c" ;; esac
}

# 3. can we probe from OUTSIDE via Tor?
tor_ok=no
if systemctl is-active --quiet tor 2>/dev/null && ss -tlnH 2>/dev/null | grep -qE '127\.0\.0\.1:9050\b'; then
	tor_ok=yes
fi

if [ "$tor_ok" = yes ]; then
	say ""
	say "  Probing from an external Tor exit (what an outside visitor sees)…"
	code443="$(probe "https://$DOMAIN/v1/health")"
	code80="$(probe "http://$DOMAIN/")"
	say "    inbound 443 (https): $( [ "$code443" != 000 ] && echo "OK (HTTP $code443)" || echo "no answer" )"
	say "    inbound 80  (http):  $( [ "$code80"  != 000 ] && echo "OK (HTTP $code80)"  || echo "no answer" )"

	if [ "$code443" != 000 ]; then
		say ""
		say "  ✓ REACHABLE — the public internet can reach your node on 443."
		say "    Your instance is live to the federation."
		say "────────────────────────────────────────────────────────"
		exit 0
	fi

	say ""
	say "  ✗ NOT REACHABLE from the public internet."
	say "    Your box IS listening, but an outside connection to 80/443 never"
	say "    arrived — the traffic is dropped BEFORE it reaches you. This is a"
	say "    ROUTER/ISP issue, not a Morphit one:"
	say "      • Many home ISPs block inbound 80/443 on residential plans"
	say "        (very common — ask your ISP to open them, or get a business/"
	say "        static-IP plan)."
	say "      • Or your router isn't forwarding 80 + 443 (TCP) to THIS box's"
	say "        LAN IP:  $(hostname -I 2>/dev/null | awk '{print $1}')"
else
	say ""
	say "  Tor's local proxy isn't available, so I can't auto-probe from"
	say "  outside. Test it yourself: on your PHONE with WIFI OFF (cellular),"
	say "  open  https://$DOMAIN/v1/health  — if it times out, your ISP/router"
	say "  is dropping inbound 80/443 (see the notes above)."
fi

# 3. the path that works regardless of any ISP block
if [ -n "$ONION" ]; then
	say ""
	say "  Your Tor address needs NO port-forwarding and reaches the whole"
	say "  world RIGHT NOW, ISP block or not:"
	say "      http://$ONION"
fi
say "────────────────────────────────────────────────────────"
exit 0
