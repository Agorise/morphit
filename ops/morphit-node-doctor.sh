#!/usr/bin/env bash
#
# morphit-node-doctor.sh — check / fix / verify a Morphit node's chain-read
# privacy and health, with a focus on tor-only boxes.
#
# AUTO-FIXES (safe, idempotent): on a tor-only node, forces the clearnet RPC
# pool empty so chain reads go ONLY over the hidden (Tor/I2P) pool — the cp755
# invariant — and restarts the indexer if that changed anything. Backs up
# indexer.env first.
#
# ONLY REPORTS (needs your judgement, never auto-done): orphaned processes,
# missing warrant canary, absent I2P transport, service/sync status.
#
# Safe to run repeatedly. Run as root:
#     sudo bash ops/morphit-node-doctor.sh
#
set -uo pipefail   # deliberately NOT -e: run every check even if one fails

REPO="${MORPHIT_REPO:-/opt/morphit}"
ENVDIR="${MORPHIT_ENVDIR:-/etc/morphit}"
IDXENV="$ENVDIR/indexer.env"

# ── pretty output + issue tracking ───────────────────────────────────
b=$'\e[1m'; g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; d=$'\e[2m'; x=$'\e[0m'
FIXED=(); MANUAL=(); OKS=0
hdr(){ printf '\n%s── %s ──%s\n' "$b" "$1" "$x"; }
ok(){   printf '  %s✓%s %s\n' "$g" "$x" "$1"; OKS=$((OKS+1)); }
warn(){ printf '  %s⚠%s %s\n' "$y" "$x" "$1"; MANUAL+=("$1"); }
bad(){  printf '  %s✗%s %s\n' "$r" "$x" "$1"; MANUAL+=("$1"); }
fixed(){ printf '  %s✓ FIXED%s %s\n' "$g" "$x" "$1"; FIXED+=("$1"); }
info(){ printf '    %s%s%s\n' "$d" "$1" "$x"; }

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root:  sudo bash $0"; exit 1; fi
if [ ! -f "$IDXENV" ]; then echo "No $IDXENV — is this a Morphit node? (set MORPHIT_ENVDIR if custom)"; exit 1; fi

# ── read the EFFECTIVE env the way the indexer unit does ─────────────
# Distinguishes UNSET (→ built-in clearnet default applies) from EMPTY (→ good).
eval "$(
  set -a
  for f in "$REPO/morphit.env" "$REPO/morphit.config.env" "$IDXENV"; do [ -f "$f" ] && . "$f"; done
  set +a
  printf 'E_ORIGIN=%q\n'  "${MORPHIT_INDEXER_PUBLIC_ORIGIN:-}"
  printf 'E_PORT=%q\n'    "${MORPHIT_INDEXER_LISTEN_PORT:-8081}"
  printf 'E_HIDDEN=%q\n'  "${MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS:-}"
  if [ -z "${MORPHIT_INDEXER_RPC_ENDPOINTS+set}" ]; then printf 'E_RPC_STATE=unset\n'
  else printf 'E_RPC_STATE=set\nE_RPC=%q\n' "$MORPHIT_INDEXER_RPC_ENDPOINTS"; fi
)"
E_RPC="${E_RPC:-}"
PORT="$E_PORT"

# tor-only iff the node's own public origin is a hidden service
TOR_ONLY=0
case "$E_ORIGIN" in *.onion|*.onion:*|*.onion/*|*.i2p|*.i2p:*|*.i2p/*) TOR_ONLY=1;; esac

hdr "Node"
info "install:  $REPO"
info "origin:   ${E_ORIGIN:-(unset)}"
if [ "$TOR_ONLY" -eq 1 ]; then ok "tor-only node (hidden-service origin) — clearnet pool must be EMPTY"
else warn "NOT detected as tor-only (origin isn't .onion/.i2p) — clearnet pool is EXPECTED here; no pool changes will be made"; fi

# ── 1. SERVICES ──────────────────────────────────────────────────────
hdr "Services (systemd)"
for svc in morphit-indexer morphit-relay morphit-mcp; do
  if systemctl list-unit-files "$svc.service" &>/dev/null && systemctl cat "$svc" &>/dev/null; then
    if systemctl is-active --quiet "$svc"; then ok "$svc active"
    else bad "$svc NOT active — start it:  sudo systemctl start $svc"; fi
  else info "$svc not installed (skipped)"; fi
done

# ── 2. ORPHAN PROCESSES (report only) ────────────────────────────────
hdr "Stray / orphaned processes"
orphans=0
declare -A svc_pid=()
for s in morphit-indexer morphit-relay morphit-mcp; do
  p=$(systemctl show -p MainPID --value "$s" 2>/dev/null); [ -n "$p" ] && [ "$p" != "0" ] && svc_pid[$p]=$s
done
while read -r pid; do
  [ -z "$pid" ] && continue
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo "?")
  cg=$(tr '\0' ' ' < "/proc/$pid/cgroup" 2>/dev/null)
  # a legit node process is a service MainPID or lives in a morphit-*.service cgroup
  if [ -n "${svc_pid[$pid]:-}" ] || printf '%s' "$cg" | grep -q 'morphit-.*\.service'; then continue; fi
  case "$cwd" in
    *.bak*|*Downloads*|*/tmp/*) bad "PID $pid runs from $cwd (old/hand-started) — stop it:  sudo kill $pid"; orphans=$((orphans+1));;
    *) warn "PID $pid ($cwd) is a morphit process outside any systemd service — investigate:  ps -o pid,cmd -p $pid"; orphans=$((orphans+1));;
  esac
done < <(pgrep -f 'tsx src/main.ts' 2>/dev/null)
[ "$orphans" -eq 0 ] && ok "no stray indexer/relay/mcp processes (only systemd-managed ones running)"

# ── 3. CLEARNET RPC POOL (auto-fix on tor-only) ──────────────────────
hdr "Clearnet RPC pool (chain-read privacy)"
need_restart=0
if [ "$TOR_ONLY" -eq 1 ]; then
  # Correct state = an explicit empty assignment line. UNSET is WRONG (the code
  # falls back to the built-in clearnet default), and non-empty is WRONG.
  if grep -q '^MORPHIT_INDEXER_RPC_ENDPOINTS=$' "$IDXENV" && [ "$E_RPC_STATE" = "set" ] && [ -z "$E_RPC" ]; then
    ok "clearnet pool already empty (MORPHIT_INDEXER_RPC_ENDPOINTS=)"
  else
    # Guard: never empty clearnet if there's no hidden pool to fall back to.
    if [ -z "$E_HIDDEN" ]; then
      bad "clearnet pool is active BUT the hidden pool is empty too — NOT touching it (would leave no chain source). Set MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS first."
    else
      case "$E_RPC_STATE" in
        unset) info "clearnet endpoints var is UNSET → the built-in clearnet default is active (a leak on a tor-only box)";;
        set)   info "clearnet endpoints var is populated → $E_RPC";;
      esac
      cp -a "$IDXENV" "$IDXENV.bak-$(date +%s)"
      if grep -q '^MORPHIT_INDEXER_RPC_ENDPOINTS=' "$IDXENV"; then
        sed -i 's|^MORPHIT_INDEXER_RPC_ENDPOINTS=.*|MORPHIT_INDEXER_RPC_ENDPOINTS=|' "$IDXENV"
      else
        printf 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n' >> "$IDXENV"
      fi
      fixed "emptied the clearnet pool in $IDXENV (backup saved alongside)"
      need_restart=1
    fi
  fi
else
  case "$E_RPC_STATE" in
    unset) info "clearnet default pool active (expected on a clearnet node)";;
    set)   info "clearnet pool: ${E_RPC:-(empty)}";;
  esac
  ok "not a tor-only node — leaving the clearnet pool as configured"
fi
[ -n "$E_HIDDEN" ] && info "hidden pool: $(printf '%s' "$E_HIDDEN" | awk -F, '{print NF}') endpoint(s) configured"

# ── 4. RESTART (only if we changed something) + VERIFY ───────────────
if [ "$need_restart" -eq 1 ]; then
  hdr "Applying fix"
  systemctl restart morphit-indexer && fixed "restarted morphit-indexer" || bad "restart failed — check: journalctl -u morphit-indexer -n40"
fi

hdr "Verify: live chain-read pool"
RPC_JSON=""
for i in $(seq 1 20); do
  RPC_JSON=$(curl -s "http://127.0.0.1:$PORT/v1/rpc-endpoints" 2>/dev/null)
  [ -n "$RPC_JSON" ] && break; sleep 2
done
if [ -z "$RPC_JSON" ]; then
  warn "indexer API on :$PORT not answering yet — re-run in a minute (it may still be starting)"
else
  nclear=$(printf '%s' "$RPC_JSON" | grep -o '"transport":"clearnet"' | wc -l)
  ntor=$(printf '%s'   "$RPC_JSON" | grep -o '"transport":"tor"'      | wc -l)
  ni2p=$(printf '%s'   "$RPC_JSON" | grep -o '"transport":"i2p"'      | wc -l)
  nlocal=$(printf '%s' "$RPC_JSON" | grep -o '"transport":"local"'    | wc -l)
  info "active pool → clearnet:$nclear tor:$ntor i2p:$ni2p local:$nlocal"
  if [ "$TOR_ONLY" -eq 1 ]; then
    if [ "$nclear" -eq 0 ]; then ok "NO clearnet endpoints in the live pool — chain reads are hidden-only ✔"
    else bad "$nclear clearnet endpoint(s) STILL in the live pool — the process hasn't picked up the change; try: sudo systemctl restart morphit-indexer"; fi
    if [ $((ntor+ni2p+nlocal)) -eq 0 ]; then bad "no hidden/local endpoints active — the indexer has NO reachable chain source; check Tor (:9050) below"; fi
  else
    ok "clearnet pool present (expected on a clearnet node)"
  fi
fi

# ── 5. HIDDEN TRANSPORTS (report) ────────────────────────────────────
hdr "Hidden transports"
if ss -ltn 2>/dev/null | grep -q ':9050 '; then ok "Tor SOCKS proxy up (:9050)"
else bad "Tor SOCKS proxy NOT listening (:9050) — a tor-only node can't reach .onion endpoints without it"; fi
if ss -ltn 2>/dev/null | grep -q ':4444 '; then ok "i2pd HTTP proxy up (:4444) — .b32.i2p endpoints usable"
else info "i2pd HTTP proxy not running (:4444) — .i2p endpoints inactive. Fine for Tor-only; install i2pd only if you want I2P as a fallback transport."; fi

# ── 6. WARRANT CANARY (report) ───────────────────────────────────────
hdr "Warrant canary"
if [ -f "$REPO/apps/web/build/canary.txt" ]; then ok "canary is being served (apps/web/build/canary.txt present)"
else warn "no canary published — set one up (cp763-fixed, tor-safe):  cd $REPO && bash scripts/canary/setup.sh   (pick 'this computer / home hosting')"; fi

# ── 7. SYNC STATUS (report) ──────────────────────────────────────────
hdr "Sync status"
H=$(curl -s "http://127.0.0.1:$PORT/v1/health" 2>/dev/null)
if [ -n "$H" ]; then
  state=$(printf '%s' "$H" | grep -o '"sync_state":"[a-z]*"' | head -1 | cut -d'"' -f4)
  lag=$(printf '%s' "$H" | grep -o '"lag_blocks":[0-9]*' | head -1 | cut -d: -f2)
  case "$state" in
    synced)  ok "indexer synced${lag:+ (lag ${lag} blocks)}";;
    behind)  info "indexer catching up${lag:+ — lag ${lag} blocks} (normal on a fresh/restarted box; re-check later)";;
    *)       info "indexer reachable (state: ${state:-unknown})";;
  esac
else info "health API not answering (see verify step above)"; fi

# ── SUMMARY ──────────────────────────────────────────────────────────
hdr "Summary"
printf '  %s%d checks passed%s\n' "$g" "$OKS" "$x"
if [ "${#FIXED[@]}" -gt 0 ]; then
  printf '  %s%d auto-fixed:%s\n' "$g" "${#FIXED[@]}" "$x"; for f in "${FIXED[@]}"; do printf '     • %s\n' "$f"; done
fi
if [ "${#MANUAL[@]}" -gt 0 ]; then
  printf '  %s%d need your attention:%s\n' "$y" "${#MANUAL[@]}" "$x"; for m in "${MANUAL[@]}"; do printf '     • %s\n' "$m"; done
  echo; echo "  Re-run this script after acting on the above to confirm all green."
  exit 2
fi
echo; echo "  ${g}All clear.${x}"
exit 0
