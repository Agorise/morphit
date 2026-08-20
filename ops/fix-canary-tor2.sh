#!/usr/bin/env bash
#
# fix-canary-tor2.sh — make the warrant canary sign cleanly on a tor-only node.
# Run on morphitlat:  sudo bash fix-canary-tor2.sh
#
# Root cause (confirmed): the canary generator DOES route over Tor (cp761) but
# two env vars were unset here, so it (a) fetched over clearnet, and (b) when
# forced through Tor, shoved CLEARNET Blurt RPCs through a Tor exit → those RPCs'
# firewalls answered HTTP 400. Fix: turn tor-only ON, and fetch the Blurt head
# from this box's OWN hidden .onion RPC nodes (native Tor, no 400).
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

[ "$(id -u)" -eq 0 ] || { echo "run with sudo: sudo bash fix-canary-tor2.sh"; exit 1; }
[ -f "$REFRESH" ] || { echo "no $REFRESH — run the canary setup first"; exit 1; }

# ── 1. pull THIS box's hidden .onion RPC endpoints from the indexer config ──
HIDDEN="$(grep -E '^MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=' "$IDXENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
ONION_RPCS="$(printf '%s' "$HIDDEN" | tr ',' '\n' | grep -i '\.onion' | paste -sd, -)"
if [ -z "$ONION_RPCS" ]; then
	bad "no .onion RPC endpoints found in $IDXENV (MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS)"
	echo "  This box needs at least one hidden .onion Blurt RPC for the canary to fetch over Tor."
	exit 1
fi
ok "hidden .onion RPCs for the canary: $ONION_RPCS"

# ── 2. rewrite the routing block in update-canary.sh (idempotent) ──────
cp -a "$REFRESH" "$REFRESH.bak-$(date +%s)"
# strip any previous block between the markers
sed -i "/$MARK\$/,/$MARK end\$/d" "$REFRESH"
# rebuild: shebang, our block, then the rest
tmp="$(mktemp)"
{
	if head -n1 "$REFRESH" | grep -q '^#!'; then head -n1 "$REFRESH"; SKIP=1; else echo '#!/usr/bin/env bash'; SKIP=0; fi
	cat <<EOF
$MARK
# morphitlat is tor-only. Route freshness fetches over Tor, and fetch the Blurt
# head from our OWN hidden .onion RPC nodes (native Tor) — NOT clearnet RPCs
# pushed through a Tor exit, which those RPCs' firewalls answer with HTTP 400.
export MORPHIT_CANARY_TOR_ONLY=1
export MORPHIT_CANARY_TOR_SOCKS='$SOCKS'
export MORPHIT_CANARY_BLURT_RPC='$ONION_RPCS'
export MORPHIT_CANARY_INSTANCE_URL='$ONION'
$MARK end
EOF
	if [ "$SKIP" = 1 ]; then tail -n +2 "$REFRESH"; else cat "$REFRESH"; fi
} > "$tmp"
install -m 0755 -o morphitlat -g morphitlat "$tmp" "$REFRESH"; rm -f "$tmp"
ok "wired MORPHIT_CANARY_TOR_ONLY=1 + hidden .onion RPCs into $REFRESH"

# ── 3. clear stale served canary so the copy can't fail, then re-sign ──
rm -f "$SERVED" 2>/dev/null || true
echo
echo "${b}Re-signing over Tor…${x}"
OUT="$(sudo -u morphitlat env HOME=/home/morphitlat bash "$REFRESH" 2>&1)"
echo "$OUT"
echo

# ── 4. verify success ─────────────────────────────────────────────────
FAIL=0
echo "$OUT" | grep -q 'route = tor-only'                       && ok "fetch route = tor-only (no clearnet)"      || { bad "route is NOT tor-only"; FAIL=1; }
echo "$OUT" | grep -qE 'could not fetch|all .* failed'         && { bad "the Blurt head fetch still failed — see output above"; FAIL=1; } || ok "Blurt head fetched successfully over Tor"
[ -f "$SERVED" ]                                               && ok "canary published to the served build dir"  || { bad "canary.txt not served"; FAIL=1; }

# ── 5. re-arm the weekly timer ONLY if the sign was clean ─────────────
echo
if [ "$FAIL" = 0 ]; then
	systemctl enable --now morphit-canary.timer 2>/dev/null && ok "weekly timer re-armed (now leak-free)" || warn "couldn't re-arm morphit-canary.timer — check: systemctl list-unit-files | grep canary"
	echo
	echo "${g}${b}DONE — canary signs over Tor, fetches from your hidden nodes, no clearnet leak.${x}"
	echo "  verify:  cat $SERVED | head -20"
else
	warn "timer left OFF because the sign wasn't clean. Nothing is leaking (last good canary still served)."
	echo "  Paste me the re-sign output above and I'll take the next step."
	exit 2
fi
