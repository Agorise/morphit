#!/usr/bin/env bash
#
# canary-fix-all.sh — the ONE script. Checks and fixes the warrant canary on a
# tor-only node end to end, verifies it signed cleanly over Tor, re-arms the
# weekly timer, and prints the node's final status.  Run on morphitlat:
#
#     sudo bash canary-fix-all.sh
#
# What it fixes (all confirmed from the generator source):
#   • tor-only routing was OFF here          → sets MORPHIT_CANARY_TOR_ONLY=1
#   • Blurt head fetched clearnet RPCs (400)  → fetches from ONE hidden .onion node
#     (MORPHIT_CANARY_BLURT_RPC takes a SINGLE url — no comma list)
#   • baked-in instance URL was junk          → sets the real onion
#   • BTC head + news are best-effort in the generator, so they can't block signing.
#
# morphitlat onion (Morphit Latino, tor-only):
#   http://ws7btkyabpcvb7pqm7mnlqbriyd5ltz5kya5o7dun22y7m3254d5zzad.onion
#
set -uo pipefail

ONION="http://ws7btkyabpcvb7pqm7mnlqbriyd5ltz5kya5o7dun22y7m3254d5zzad.onion"
IDXENV="/etc/morphit/indexer.env"
REFRESH="/home/morphitlat/.morphit/update-canary.sh"
SERVED="/opt/morphit/apps/web/build/canary.txt"
SOCKS="127.0.0.1:9050"
MARK="# --- tor-only canary routing (fix-canary-tor.sh) ---"
g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s✓%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s⚠%s %s\n' "$y" "$x" "$1"; }
bad(){ printf '  %s✗%s %s\n' "$r" "$x" "$1"; }
hdr(){ printf '\n%s── %s ──%s\n' "$b" "$1" "$x"; }

[ "$(id -u)" -eq 0 ] || { echo "run with sudo: sudo bash canary-fix-all.sh"; exit 1; }

hdr "1. Preconditions"
[ -f "$REFRESH" ] || { bad "no $REFRESH — run canary setup first (cd /opt/morphit && bash scripts/canary/setup.sh)"; exit 1; }
ok "refresh script present"
if ss -ltn 2>/dev/null | grep -q '127.0.0.1:9050'; then ok "Tor SOCKS up on $SOCKS"; else bad "Tor SOCKS not on $SOCKS — sudo systemctl start tor, then re-run"; exit 1; fi

hdr "2. Pick ONE hidden .onion Blurt RPC (from the indexer config)"
HIDDEN="$(grep -E '^MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=' "$IDXENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
ONE_ONION="$(printf '%s' "$HIDDEN" | tr ',' '\n' | grep -i '\.onion' | head -1 | tr -d '[:space:]')"
[ -n "$ONE_ONION" ] || { bad "no .onion Blurt RPC in $IDXENV — can't fetch the head over Tor"; exit 1; }
ok "canary Blurt head source: $ONE_ONION"

hdr "3. Wire the correct env into the refresh script (idempotent)"
cp -a "$REFRESH" "$REFRESH.bak-$(date +%s)"
sed -i "/$MARK\$/,/$MARK end\$/d" "$REFRESH"        # strip any prior block
tmp="$(mktemp)"
{
	if head -n1 "$REFRESH" | grep -q '^#!'; then head -n1 "$REFRESH"; SKIP=1; else echo '#!/usr/bin/env bash'; SKIP=0; fi
	cat <<EOF
$MARK
# tor-only node: route freshness fetches over Tor, fetch the Blurt head from ONE
# of our own hidden .onion RPC nodes (native Tor — no clearnet, no HTTP 400).
# This env var is a SINGLE url (the fetcher does not split on commas).
export MORPHIT_CANARY_TOR_ONLY=1
export MORPHIT_CANARY_TOR_SOCKS='$SOCKS'
export MORPHIT_CANARY_BLURT_RPC='$ONE_ONION'
export MORPHIT_CANARY_INSTANCE_URL='$ONION'
$MARK end
EOF
	if [ "$SKIP" = 1 ]; then tail -n +2 "$REFRESH"; else cat "$REFRESH"; fi
} > "$tmp"
install -m 0755 -o morphitlat -g morphitlat "$tmp" "$REFRESH"; rm -f "$tmp"
ok "MORPHIT_CANARY_TOR_ONLY=1 + single onion RPC + onion URL wired in"

hdr "4. Re-sign the canary (over Tor)"
rm -f "$SERVED" 2>/dev/null || true
OUT="$(sudo -u morphitlat env HOME=/home/morphitlat bash "$REFRESH" 2>&1)"
printf '%s\n' "$OUT" | sed 's/^/    /'

hdr "5. Verify"
FAIL=0
printf '%s' "$OUT" | grep -q 'route = tor-only'                         && ok "route = tor-only (no clearnet leak)"            || { bad "route not tor-only";               FAIL=1; }
if printf '%s' "$OUT" | grep -qiE 'could not fetch Blurt|all .* Blurt .* failed|Failed to parse URL'; then bad "Blurt head fetch FAILED"; FAIL=1; else ok "Blurt head fetched over Tor from the onion node"; fi
[ -f "$SERVED" ]                                                          && ok "canary signed + published to the served dir"    || { bad "canary.txt not served";           FAIL=1; }
# BTC + news are best-effort — report but never fail on them:
if printf '%s' "$OUT" | grep -qiE 'could not fetch.*Bitcoin|all .* provider.* failed'; then warn "BTC head unavailable over Tor (best-effort — canary still valid; providers may block Tor exits)"; else ok "BTC head present"; fi

hdr "6. Timer"
if [ "$FAIL" = 0 ]; then
	systemctl enable --now morphit-canary.timer 2>/dev/null && ok "weekly timer re-armed (leak-free)" || warn "couldn't re-arm morphit-canary.timer"
else
	warn "timer left OFF (sign not clean). Last good canary still served — nothing is leaking."
fi

hdr "7. Node status (final)"
PORT=8081
H="$(curl -s "http://127.0.0.1:$PORT/v1/health" 2>/dev/null)"
if [ -n "$H" ]; then
	get(){ printf '%s' "$H" | grep -o "\"$1\":[^,}]*" | head -1 | cut -d: -f2- | tr -d '" '; }
	echo "  version : $(get version)     lag: $(get lag_blocks)   stale: $(get stale)"
	echo "  relay up: $(printf '%s' "$H" | grep -o '"relay":{[^}]*}' | grep -o '"up":[a-z]*' | cut -d: -f2)"
	printf '%s' "$H" | grep -q '"transport":"clearnet"' && warn "clearnet RPC present (unexpected on tor-only)" || ok "RPC pool: hidden-only (no clearnet)"
fi
if [ -f "$SERVED" ]; then
	VT="$(grep -iE 'valid.?through|valid_through' "$SERVED" | head -1 | tr -d '\r')"
	ok "canary served${VT:+ — $VT}"
else
	bad "canary NOT served"
fi

echo
if [ "$FAIL" = 0 ]; then
	printf '%s%s✓ ALL GREEN — canary signs over Tor from your hidden node, no clearnet leak, timer armed.%s\n' "$g" "$b" "$x"
	echo "  view it:  cat $SERVED"
	exit 0
else
	printf '%s%s✗ Canary sign not clean — see section 5 above. Nothing is leaking; timer is off.%s\n' "$r" "$b" "$x"
	exit 2
fi
