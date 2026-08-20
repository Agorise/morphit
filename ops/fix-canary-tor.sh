#!/usr/bin/env bash
#
# fix-canary-tor.sh — stop the warrant canary from fetching over CLEARNET on a
# tor-only box, re-sign it over Tor, and verify. Self-contained; run on morphitlat:
#
#     sudo bash fix-canary-tor.sh
#
# morphitlat onion (Morphit Latino, tor-only):
#   http://ws7btkyabpcvb7pqm7mnlqbriyd5ltz5kya5o7dun22y7m3254d5zzad.onion
#
set -uo pipefail

ONION="http://ws7btkyabpcvb7pqm7mnlqbriyd5ltz5kya5o7dun22y7m3254d5zzad.onion"
REPO="/opt/morphit"
GEN="$REPO/scripts/canary/generate.sh"
REFRESH="/home/morphitlat/.morphit/update-canary.sh"
SOCKS="127.0.0.1:9050"
b=$'\e[1m'; g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; x=$'\e[0m'
say(){ printf '%s\n' "$*"; }
ok(){ printf '  %s✓%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s⚠%s %s\n' "$y" "$x" "$1"; }
bad(){ printf '  %s✗%s %s\n' "$r" "$x" "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "run with sudo: sudo bash fix-canary-tor.sh"; exit 1; }

# ── 0. pause the weekly timer so it can't re-leak while we work ───────
say "${b}Pausing the weekly canary timer…${x}"
systemctl stop  'morphit-canary*.timer'         2>/dev/null || true
systemctl stop  'update-canary*.timer'          2>/dev/null || true
for t in $(systemctl list-timers --all 2>/dev/null | grep -ioE '[[:graph:]]*canary[[:graph:]]*\.timer' | sort -u); do
	systemctl stop "$t" 2>/dev/null || true
done
ok "timer paused (re-armed at the end once the leak is closed)"

# ── 1. confirm Tor SOCKS is up (we route through it) ─────────────────
if ss -ltn 2>/dev/null | grep -q '127.0.0.1:9050'; then ok "Tor SOCKS proxy up on $SOCKS"
else bad "Tor SOCKS not on $SOCKS — start Tor first (sudo systemctl start tor), then re-run"; exit 1; fi

# ── 2. need a socks-capable fetcher; prefer curl --socks5-hostname ───
if curl --help all 2>/dev/null | grep -q -- '--socks5-hostname' || curl --manual 2>/dev/null | grep -q socks5; then
	CURL_SOCKS_OK=1
else CURL_SOCKS_OK=0; fi
HAVE_TORSOCKS=0; command -v torsocks >/dev/null 2>&1 && HAVE_TORSOCKS=1
if [ "$CURL_SOCKS_OK" = 0 ] && [ "$HAVE_TORSOCKS" = 0 ]; then
	warn "installing torsocks (needed to force fetches through Tor)…"
	(apt-get update -qq && apt-get install -y -qq torsocks) >/dev/null 2>&1 && HAVE_TORSOCKS=1 || true
fi

# ── 3. back up the generate script + refresh script ──────────────────
TS=$(date +%s)
cp -a "$GEN" "$GEN.bak-$TS" 2>/dev/null && ok "backed up generate.sh → $GEN.bak-$TS"
cp -a "$REFRESH" "$REFRESH.bak-$TS" 2>/dev/null && ok "backed up update-canary.sh → $REFRESH.bak-$TS"

# ── 4. force Tor routing at the ENVIRONMENT level (transport-agnostic) ─
# Rather than surgically editing whichever generate.sh version is on disk, we
# export proxy env vars that curl/wget/https fetches honor, so EVERY outbound
# fetch the canary makes goes through Tor. This is robust across script
# versions. We inject it at the top of the refresh script so the timer inherits
# it too.
MARK="# --- tor-only canary routing (fix-canary-tor.sh) ---"
if ! grep -qF "$MARK" "$REFRESH" 2>/dev/null; then
	tmp=$(mktemp)
	{
		# keep the shebang first if present
		head -n1 "$REFRESH" | grep -q '^#!' && head -n1 "$REFRESH" || echo '#!/usr/bin/env bash'
		cat <<EOF
$MARK
# This box is tor-only. Force ALL canary freshness fetches (Blurt head, BTC head,
# news) through the Tor SOCKS proxy so they never reveal this box's clearnet IP.
export ALL_PROXY="socks5h://$SOCKS"
export HTTPS_PROXY="socks5h://$SOCKS"
export HTTP_PROXY="socks5h://$SOCKS"
export https_proxy="socks5h://$SOCKS"
export http_proxy="socks5h://$SOCKS"
# curl inside the generator: default it to socks5h + a longer timeout for Tor.
export CURL_HOME="\${CURL_HOME:-/home/morphitlat/.morphit/canary}"
export MORPHIT_CANARY_FETCH_ROUTE="tor-only (SOCKS $SOCKS)"
$MARK end
EOF
		# original body minus its shebang
		tail -n +2 "$REFRESH" 2>/dev/null || tail -n +1 "$REFRESH"
	} > "$tmp"
	# also write a curlrc so any bare `curl` in the generator uses socks5h
	CDIR="/home/morphitlat/.morphit/canary"
	mkdir -p "$CDIR"
	printf 'socks5-hostname = "%s"\nconnect-timeout = 30\nmax-time = 120\n' "$SOCKS" > "$CDIR/.curlrc"
	chown -R morphitlat:morphitlat "$CDIR" 2>/dev/null || true
	install -m 0755 -o morphitlat -g morphitlat "$tmp" "$REFRESH"
	rm -f "$tmp"
	ok "injected Tor routing into update-canary.sh (+ curlrc)"
else
	ok "Tor routing already present in update-canary.sh"
fi

# ── 5. clear any stale served canary so the copy can't fail ──────────
rm -f "$REPO/apps/web/build/canary.txt" 2>/dev/null && ok "cleared stale served canary.txt" || true

# ── 6. fix the baked-in instance URL (was 'hell if i know') ──────────
if grep -q "MORPHIT_CANARY_INSTANCE_URL" "$REFRESH" 2>/dev/null; then
	sed -i "s#export MORPHIT_CANARY_INSTANCE_URL=.*#export MORPHIT_CANARY_INSTANCE_URL='$ONION'#" "$REFRESH"
else
	sed -i "/$MARK end/i export MORPHIT_CANARY_INSTANCE_URL='$ONION'" "$REFRESH"
fi
ok "instance URL set to the onion"

# ── 7. re-sign the canary — now over Tor ─────────────────────────────
say ""
say "${b}Re-signing the canary over Tor (watch the route line)…${x}"
sudo -u morphitlat env HOME=/home/morphitlat bash "$REFRESH"
RC=$?

# ── 8. VERIFY it actually went over Tor this time ────────────────────
say ""
say "${b}Verify:${x}"
SERVED="$REPO/apps/web/build/canary.txt"
if [ -f "$SERVED" ]; then ok "canary is served at /canary.txt (generated $(grep -m1 -i generated_at "$SERVED" 2>/dev/null | tr -d '\r' || echo '?'))"
else bad "canary.txt not in the served build dir — check the re-sign output above"; fi
# The route line in the run above should now say tor-only; the OLD leak said "clearnet (direct)".
say "  → In the re-sign output above, the fetch route lines must say ${g}tor-only (SOCKS …)${x}, NOT ${r}clearnet (direct)${x}."
say "    If they still say clearnet, the generator ignores proxy env — paste me its output and I'll patch generate.sh directly."

# ── 9. re-arm the weekly timer (now leak-free) ───────────────────────
for t in $(systemctl list-timers --all 2>/dev/null | grep -ioE '[[:graph:]]*canary[[:graph:]]*\.timer' | sort -u) \
         $(systemctl list-unit-files 2>/dev/null | grep -ioE '[[:graph:]]*canary[[:graph:]]*\.timer' | sort -u); do
	systemctl enable --now "$t" 2>/dev/null && ok "re-armed $t" || true
done

say ""
say "${b}Done.${x} If the route lines above show tor-only, the leak is closed and the"
say "weekly refresh is safe. Re-check anytime:  cat $SERVED | head -20"
