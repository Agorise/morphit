#!/usr/bin/env bash
#
# snapshot-autopublish.sh — the job the morphit-snapshot-publish.timer
# runs on a CAUGHT-UP publishing node (morphit.io / morphitlat). Keeps a fresh
# federated indexer snapshot pinned + anchored so new nodes fast-sync in minutes.
#
# Pipeline (each step fails closed; nothing is published from a behind/broken DB):
#   1. GUARD  — only proceed if the indexer is caught up (sync.behind == false)
#               and /v1/health is reachable. A stale/behind snapshot is worse
#               than none, so we simply skip this run and try again next timer.
#   2. EXPORT — snapshot-export.ts → morphit-indexer-snapshot-<block>-<date>.tar.gz
#   3. PIN    — pin-indexer-snapshot.sh → CID + always-newest IPNS + payload json
#   4. ANCHOR — MANUAL, on the laptop: the payload is emitted and the exact
#               broadcast command logged. Nodes accept an indexer_snapshot_v1
#               only when @morphit's ONE posting key signed it (there is no
#               "second" or "dedicated" key — adding one to the account would
#               make every later release fail verification), and that key never
#               lives on a server. A key file at
#               MORPHIT_SNAPSHOT_SIGNING_KEY_FILE (root 0600, the WIF only)
#               would put it here and make this step broadcast by itself:
#               don't create one.
#   5. ROTATE — keep the last KEEP exported tarballs in MORPHIT_SNAPSHOT_OUT.
#               (Superseded snapshot CIDs, and the copy each run stages inside
#               the IPFS repo for `ipfs add --nocopy`, are let go by
#               ops/ipfs/morphit-ipfs-gc.sh — weekly timer + every upgrade,
#               v1.20.0 C16 — which keeps the anchored snapshot, every newer one
#               and two older ones.)
#
# Config (env, e.g. /etc/morphit/snapshot-publish.env):
#   MORPHIT_REPO_PATH          (default /opt/morphit)
#   MORPHIT_INDEXER_ENV        (default /etc/morphit/indexer.env)
#   MORPHIT_HEALTH_URL         (default: the INDEXER's /v1/health, from its
#                               MORPHIT_INDEXER_LISTEN_HOST/PORT in the indexer
#                               env; 127.0.0.1:8081 when unset)
#   MORPHIT_SNAPSHOT_OUT       (default /opt/morphit/snapshots)
#   MORPHIT_SNAPSHOT_KEEP      (default 3)
#   MORPHIT_SNAPSHOT_FORGEJO_URL   (optional https mirror recorded in the op)
#   MORPHIT_SNAPSHOT_SIGNING_KEY_FILE (default /etc/morphit/snapshot-signing.wif;
#                               leave it absent: anchoring is done on the laptop)
#
set -uo pipefail
REPO="${MORPHIT_REPO_PATH:-/opt/morphit}"
INDEXER_ENV="${MORPHIT_INDEXER_ENV:-/etc/morphit/indexer.env}"
# The indexer's health, not the relay's (v1.20.0, C4). The default used to be
# :8080 — the RELAY — whose /v1/health has no `sync` block, so the caught-up
# guard below read "not behind" every time and published from a lagging DB.
_idx_env_val() { sed -n "s/^[[:space:]]*$1=//p" "$INDEXER_ENV" 2>/dev/null | tail -1 | tr -d "\"' \t\r"; }
_IDX_HOST="$(_idx_env_val MORPHIT_INDEXER_LISTEN_HOST)"
case "$_IDX_HOST" in '' | 0.0.0.0 | '::' | '[::]') _IDX_HOST=127.0.0.1 ;; esac
_IDX_PORT="$(_idx_env_val MORPHIT_INDEXER_LISTEN_PORT)"
HEALTH_URL="${MORPHIT_HEALTH_URL:-http://${_IDX_HOST}:${_IDX_PORT:-8081}/v1/health}"
OUT="${MORPHIT_SNAPSHOT_OUT:-/opt/morphit/snapshots}"
KEEP="${MORPHIT_SNAPSHOT_KEEP:-3}"
TSX="$REPO/node_modules/.bin/tsx"
TSCFG="$REPO/tsconfig.smoke.json"
log(){ printf '[snapshot-autopublish] %s\n' "$1"; }
die(){ printf '[snapshot-autopublish] ERROR: %s\n' "$1" >&2; exit 1; }
skip(){ log "SKIP: $1"; exit 0; } # a skip is not a failure — try again next timer

[ -d "$REPO" ] || die "repo not found at $REPO (set MORPHIT_REPO_PATH)"
[ -x "$TSX" ] || die "tsx not found at $TSX — is the repo installed?"
[ -r "$INDEXER_ENV" ] || die "indexer env not readable at $INDEXER_ENV"
command -v python3 >/dev/null 2>&1 || die "python3 is required"

# ── 1. GUARD: caught up + healthy ──────────────────────────────────
log "checking sync state at $HEALTH_URL …"
HEALTH="$(curl -fsS --max-time 15 "$HEALTH_URL" 2>/dev/null)" || skip "indexer /v1/health not reachable"
# Only the indexer's body proves "caught up": it must carry `indexed_block` and a
# `sync` object whose `behind` is exactly false. Anything else — another
# service's health, an older indexer, a stale flag — is not proof, so skip.
BEHIND="$(printf '%s' "$HEALTH" | python3 -c 'import json,sys
try:
    h=json.load(sys.stdin)
except Exception:
    print("err"); sys.exit(0)
s=h.get("sync")
if "indexed_block" not in h or not isinstance(s, dict) or "behind" not in s:
    print("nosync"); sys.exit(0)
print("false" if s.get("behind") is False and not h.get("stale") else "true")' 2>/dev/null)"
case "$BEHIND" in
	false)  log "indexer is caught up — proceeding" ;;
	true)   skip "indexer is still catching up (sync.behind or stale) — not publishing a partial snapshot" ;;
	nosync) skip "$HEALTH_URL is not the indexer's health (no sync state) — set MORPHIT_HEALTH_URL in /etc/morphit/snapshot-publish.env" ;;
	*)      skip "could not read sync state from $HEALTH_URL" ;;
esac

# Load the indexer env (INERTLY — never source; values may contain spaces).
export MORPHIT_INDEXER_DATABASE_URL="$(sed -n 's/^MORPHIT_INDEXER_DATABASE_URL=//p' "$INDEXER_ENV" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
[ -n "${MORPHIT_INDEXER_DATABASE_URL:-}" ] || die "MORPHIT_INDEXER_DATABASE_URL not found in $INDEXER_ENV"
# Bring the rest of the indexer env in the same inert way for loadConfig().
set -a
# shellcheck disable=SC1090
while IFS='=' read -r k v; do case "$k" in MORPHIT_*) export "$k"="$(printf '%s' "$v" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")";; esac; done < "$INDEXER_ENV"
set +a

mkdir -p "$OUT"

# ── 2. EXPORT ──────────────────────────────────────────────────────
log "exporting indexer snapshot → $OUT …"
# Keep stderr. It used to be sent to /dev/null so only the tarball path landed on
# stdout — which meant a failed export reported nothing but "snapshot-export
# failed", with the actual cause discarded. Capture stderr to a file, echo it on
# failure, and still take the path from the last stdout line.
EXPORT_ERR="$(mktemp)"
TARBALL="$(cd "$REPO" && "$TSX" --tsconfig "$TSCFG" apps/indexer/scripts/snapshot-export.ts --out "$OUT" 2>"$EXPORT_ERR" | tail -1)" || {
	log "snapshot-export failed; its output was:"
	sed 's/^/    /' "$EXPORT_ERR" >&2 || true
	rm -f "$EXPORT_ERR"
	die "snapshot-export failed"
}
rm -f "$EXPORT_ERR"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "snapshot-export did not produce a tarball"
# Log the size on EVERY run. The snapshot is tiny today (~600 kB), which is what
# makes it cheap for every instance in the federation to mirror. It grows with
# orders, chat and reputation rows, though, and the mirroring model only stays
# comfortable into the tens of MB — so the number belongs in the journal where
# the trend is visible long before it becomes a problem.
SNAP_BYTES="$(stat -c %s "$TARBALL" 2>/dev/null || echo 0)"
log "exported: $TARBALL ($((SNAP_BYTES / 1024)) kB)"
if [ "$SNAP_BYTES" -gt 52428800 ]; then
	log "NOTE: this snapshot is over 50 MB. Still workable, but every mirroring"
	log "  instance now fetches that much per refresh — worth reviewing cadence or"
	log "  an orderbook-only variant before it grows much further."
fi

# ── 3. PIN ─────────────────────────────────────────────────────────
log "pinning to kubo + publishing IPNS …"
PIN_ENV=()
[ -n "${MORPHIT_SNAPSHOT_FORGEJO_URL:-}" ] && PIN_ENV+=("FORGEJO_URL=$MORPHIT_SNAPSHOT_FORGEJO_URL")
# Capture stdout so we can read the payload path the pin script TELLS us, while
# still showing the operator its progress output (which goes to stderr).
# Stream pin's output AND keep a copy. The previous form captured stdout into a
# variable that was only printed on SUCCESS — so when pin failed, everything it
# had said (including WHY) was discarded, leaving nothing in the journal but
# "pin-indexer-snapshot failed". tee gives the operator the live output; the log
# file gives us the payload locator. PIPESTATUS[0] is pin's exit code, not tee's.
PIN_LOG="$(mktemp)"
env "${PIN_ENV[@]}" bash "$REPO/ops/pin-indexer-snapshot.sh" "$TARBALL" 2>&1 | tee "$PIN_LOG"
PIN_RC="${PIPESTATUS[0]}"
PIN_OUT="$(cat "$PIN_LOG")"
rm -f "$PIN_LOG"
[ "$PIN_RC" -eq 0 ] || die "pin-indexer-snapshot failed (exit $PIN_RC) — see its output above"
# pin-indexer-snapshot.sh knows the exact path it wrote and prints it on a line
# with a stable prefix, so read that. The previous version scanned the whole
# filesystem (`find / -maxdepth 6`) for a freshly-modified payload json — slow on
# a real box, and liable to pick up an unrelated file from an earlier run.
PAYLOAD="$(printf '%s' "$PIN_OUT" | sed -n 's/^MORPHIT_SNAPSHOT_PAYLOAD=//p' | tail -1)"
if [ -z "$PAYLOAD" ] || [ ! -f "$PAYLOAD" ]; then
	# FALLBACK: an older pin script (or one whose stdout was swallowed) emits no
	# locator. Look only where it actually writes, newest first — never a whole-
	# filesystem scan.
	log "pin script emitted no payload locator — falling back to a scoped search."
	PAYLOAD="$(find /var/lib/ipfs /opt/morphit -name 'indexer-snapshot-payload-*.json' 2>/dev/null | xargs -r ls -1t 2>/dev/null | head -1)"
fi
[ -n "$PAYLOAD" ] && [ -f "$PAYLOAD" ] || die "could not locate the emitted payload json"
log "payload: $PAYLOAD"

# ── 4. ANCHOR (optional auto-broadcast) ────────────────────────────
KEY_FILE="${MORPHIT_SNAPSHOT_SIGNING_KEY_FILE:-/etc/morphit/snapshot-signing.wif}"
if [ -r "$KEY_FILE" ]; then
	log "$KEY_FILE exists — that puts @morphit's posting key on a server; anchoring belongs on the laptop. Broadcasting anyway …"
	( cd "$REPO" && "$TSX" --tsconfig "$TSCFG" apps/indexer/scripts/indexer-snapshot-broadcast.ts "$PAYLOAD" \
		--broadcast --yes --key-file "$KEY_FILE" ) \
		|| die "auto-broadcast failed"
	log "✓ anchored on-chain"
else
	log "snapshot pinned but NOT anchored (anchoring is done on the laptop)."
	log "  broadcast manually from your laptop (prompts for the @morphit POSTING WIF):"
	log "    scp -O root@<this-node>:$PAYLOAD .      (-O: hardened boxes turn SFTP off)"
	log "    node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/indexer/scripts/indexer-snapshot-broadcast.ts $(basename "$PAYLOAD")            (dry run: shows the op)"
	log "    node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/indexer/scripts/indexer-snapshot-broadcast.ts $(basename "$PAYLOAD") --broadcast"
fi

# ── 5. ROTATE ──────────────────────────────────────────────────────
log "rotating local snapshots (keep $KEEP) …"
mapfile -t OLD < <(ls -1t "$OUT"/morphit-indexer-snapshot-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
for f in "${OLD[@]:-}"; do [ -n "$f" ] && { rm -f "$f" && log "  removed $f"; }; done

log "done."
