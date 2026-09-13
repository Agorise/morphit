#!/usr/bin/env bash
#
# snapshot-autopublish.sh (cp766) — the job the morphit-snapshot-publish.timer
# runs on a CAUGHT-UP publishing node (morphit.io / morphitlat). Keeps a fresh
# federated indexer snapshot pinned + anchored so new nodes fast-sync in minutes.
#
# Pipeline (each step fails closed; nothing is published from a behind/broken DB):
#   1. GUARD  — only proceed if the indexer is caught up (sync.behind == false)
#               and /v1/health is reachable. A stale/behind snapshot is worse
#               than none, so we simply skip this run and try again next timer.
#   2. EXPORT — snapshot-export.ts → morphit-indexer-snapshot-<block>-<date>.tar.gz
#   3. PIN    — pin-indexer-snapshot.sh → CID + always-newest IPNS + payload json
#   4. ANCHOR — OPTIONAL. If MORPHIT_SNAPSHOT_SIGNING_WIF is set (a DEDICATED
#               posting key for @morphit, never the main release key), broadcast
#               indexer_snapshot_v1 non-interactively. Otherwise emit the payload
#               and log the exact manual broadcast command (safe default — no key
#               on the box).
#   5. ROTATE — keep the last KEEP snapshots on disk; unpin superseded CIDs.
#
# Config (env, e.g. /etc/morphit/snapshot-publish.env):
#   MORPHIT_REPO_PATH          (default /opt/morphit)
#   MORPHIT_INDEXER_ENV        (default /etc/morphit/indexer.env)
#   MORPHIT_HEALTH_URL         (default http://127.0.0.1:8080/v1/health)
#   MORPHIT_SNAPSHOT_OUT       (default /opt/morphit/snapshots)
#   MORPHIT_SNAPSHOT_KEEP      (default 3)
#   MORPHIT_SNAPSHOT_FORGEJO_URL   (optional https mirror recorded in the op)
#   MORPHIT_SNAPSHOT_SIGNING_WIF   (optional; enables step 4 auto-broadcast)
#
set -uo pipefail
REPO="${MORPHIT_REPO_PATH:-/opt/morphit}"
INDEXER_ENV="${MORPHIT_INDEXER_ENV:-/etc/morphit/indexer.env}"
HEALTH_URL="${MORPHIT_HEALTH_URL:-http://127.0.0.1:8080/v1/health}"
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
BEHIND="$(printf '%s' "$HEALTH" | python3 -c 'import json,sys
try:
    h=json.load(sys.stdin)
except Exception:
    print("err"); sys.exit(0)
s=h.get("sync") or {}
print("true" if s.get("behind") else "false")' 2>/dev/null)"
case "$BEHIND" in
	false) log "indexer is caught up — proceeding" ;;
	true)  skip "indexer is still catching up (sync.behind=true) — not publishing a partial snapshot" ;;
	*)     skip "could not read sync state from /v1/health" ;;
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
if [ -n "${MORPHIT_SNAPSHOT_SIGNING_WIF:-}" ]; then
	log "auto-broadcasting indexer_snapshot_v1 (dedicated signing key present) …"
	( cd "$REPO" && MORPHIT_SNAPSHOT_SIGNING_WIF="$MORPHIT_SNAPSHOT_SIGNING_WIF" \
		"$TSX" --tsconfig "$TSCFG" apps/indexer/scripts/indexer-snapshot-broadcast.ts "$PAYLOAD" --yes ) \
		|| die "auto-broadcast failed"
	log "✓ anchored on-chain"
else
	log "no MORPHIT_SNAPSHOT_SIGNING_WIF set — snapshot pinned but NOT anchored."
	log "  broadcast manually from your laptop (prompts for the @morphit POSTING WIF):"
	log "    scp <this-node>:$PAYLOAD ."
	log "    node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/indexer/scripts/indexer-snapshot-broadcast.ts $(basename "$PAYLOAD")"
fi

# ── 5. ROTATE ──────────────────────────────────────────────────────
log "rotating local snapshots (keep $KEEP) …"
mapfile -t OLD < <(ls -1t "$OUT"/morphit-indexer-snapshot-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
for f in "${OLD[@]:-}"; do [ -n "$f" ] && { rm -f "$f" && log "  removed $f"; }; done

log "done."
