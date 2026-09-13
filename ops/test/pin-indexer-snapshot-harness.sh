#!/usr/bin/env bash
# ops/test/pin-indexer-snapshot-harness.sh — EXECUTE the publish path.
#
# WHY THIS EXISTS
# In one evening the snapshot publish path produced SEVEN production-only
# failures, every one of which a grep-based smoke had cheerfully passed:
#   1. the script shipped mode 0644, so systemd could not exec it at all
#   2. the export's stderr went to /dev/null, hiding the real cause
#   3. rename() across a tmpfs boundary (PrivateTmp) failed with EXDEV
#   4. `sudo` cannot run under NoNewPrivileges=true
#   5. ...and its replacement `runuser` does not set HOME, so kubo looked in
#      /root/.ipfs
#   6. pin's own output was captured into a variable and discarded on failure
#   7. the kubo probe had no retry, so a daemon the script itself had just
#      restarted read as permanently unreachable
#
# Every one is an EXECUTION fault. Reading the file cannot find them; running it
# finds them immediately. This harness runs the real pin script against stub
# `ipfs` and `systemctl` binaries and a real tarball, so the publish path is
# exercised on every battery run instead of on a live server at midnight.
#
# Deliberately hermetic: no daemon, no network, no root, no writes outside a
# temp dir. Stubs are on PATH ahead of anything real.
#
# Usage: bash ops/test/pin-indexer-snapshot-harness.sh
# Exit 0 = the publish path ran end to end and emitted a payload.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PIN="$REPO/ops/pin-indexer-snapshot.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fails=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }

# ── Build a REAL snapshot tarball (manifest v2 + gzipped dump) ────────
SNAP="$WORK/snap"; mkdir -p "$SNAP"
head -c 600000 /dev/urandom | base64 | gzip > "$SNAP/indexer.sql.gz"
DUMP_SHA="$(sha256sum "$SNAP/indexer.sql.gz" | cut -d' ' -f1)"
cat > "$SNAP/manifest.json" <<EOF
{"snapshotFormatVersion":2,"chainId":"cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f",
 "schemaVersion":59,"lastAppliedBlock":63610645,"dumpSha256":"$DUMP_SHA",
 "indexerVersion":"1.17.6","createdAt":"2026-09-13T00:00:00Z","pgMajor":16,"sourceLabel":"harness"}
EOF
TARBALL="$WORK/morphit-indexer-snapshot-63610645-2026-09-13.tar.gz"
tar czf "$TARBALL" -C "$SNAP" manifest.json indexer.sql.gz

# ── Stubs ────────────────────────────────────────────────────────────
BIN="$WORK/bin"; mkdir -p "$BIN"
KUBO_REPO="$WORK/ipfsrepo"; mkdir -p "$KUBO_REPO"

# `ipfs` stub. Records every invocation so we can assert on HOW it was called —
# in particular that IPFS_PATH was passed explicitly rather than inherited.
cat > "$BIN/ipfs" <<'STUB'
#!/usr/bin/env bash
echo "IPFS_PATH=${IPFS_PATH:-UNSET} argv=$*" >> "$HARNESS_LOG"
# Fail the first N probes to simulate a daemon that has just restarted.
if [ "$1" = "id" ]; then
	n=0; [ -f "$HARNESS_PROBE_COUNT" ] && n="$(cat "$HARNESS_PROBE_COUNT")"
	n=$((n+1)); echo "$n" > "$HARNESS_PROBE_COUNT"
	if [ "$n" -le "${HARNESS_PROBE_FAILURES:-0}" ]; then
		echo "Error: api not running" >&2; exit 1
	fi
	echo '{"ID":"12D3KooWHarness"}'; exit 0
fi
case "$*" in
	"config Datastore.Filestore.Enabled"*) echo true ;;
	"config Addresses.Gateway"*) echo "/ip4/0.0.0.0/tcp/8082" ;;
	"add "*|"add") echo "added QmHarnessCIDaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa snapshot" ;;
	"key list") echo "indexer-snapshot" ;;
	"key list "*-l*) echo "k51qzi5uqu5harnessaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa indexer-snapshot" ;;
	"name publish"*) echo "Published to k51qzi5uqu5harness: /ipfs/QmHarnessCIDaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ;;
	"routing provide"*) : ;;
	"pin "*) : ;;
	*) : ;;
esac
exit 0
STUB

# Both privilege-drop tools FAIL, exactly as they do on morphit.io under this
# unit's hardening: sudo refuses (setuid under NoNewPrivileges) and runuser
# cannot setuid (no CAP_SETUID). The script must fall through to talking to kubo
# directly as root, which is all that is needed since the CLI just reads
# $IPFS_PATH/api and speaks HTTP.
if [ "${HARNESS_BREAK_PRIVDROP:-0}" = "1" ]; then
	printf '#!/usr/bin/env bash\necho "runuser: cannot set user id: Operation not permitted" >&2\nexit 1\n' > "$BIN/runuser"
	printf '#!/usr/bin/env bash\necho "sudo: unable to open /etc/sudoers: Operation not permitted" >&2\nexit 1\n' > "$BIN/sudo"
	chmod +x "$BIN/runuser" "$BIN/sudo"
fi

# `systemctl` stub — the script restarts ipfs.service in step 3.
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/systemctl"
# `runuser` stub — exec through, preserving the env the script set.
printf '#!/usr/bin/env bash\nshift 2; [ "$1" = "--" ] && shift; exec "$@"\n' > "$BIN/runuser"
# A long-lived stand-in for the kubo daemon. The script reads IPFS_PATH out of
# /proc/<pid>/environ, so the fake daemon must actually exist for the duration
# AND carry IPFS_PATH in its environment — same as the real thing.
IPFS_PATH="$KUBO_REPO" setsid sleep 600 >/dev/null 2>&1 &
FAKE_KUBO_PID=$!
trap 'kill "$FAKE_KUBO_PID" 2>/dev/null; rm -rf "$WORK"' EXIT
mkdir -p "$KUBO_REPO/indexer-snapshots"

# `pgrep`/`ps`/`getent` so kubo "detection" resolves to the stand-in above.
printf '#!/usr/bin/env bash\necho %s\n' "$FAKE_KUBO_PID" > "$BIN/pgrep"
printf '#!/usr/bin/env bash\necho harness\n' > "$BIN/ps"
printf '#!/usr/bin/env bash\necho "harness:x:1000:1000::%s:/bin/sh"\n' "$KUBO_REPO" > "$BIN/getent"
chmod +x "$BIN"/*

export HARNESS_LOG="$WORK/ipfs-calls.log"; : > "$HARNESS_LOG"
export HARNESS_PROBE_COUNT="$WORK/probe-count"
# Deliberately NOT exported here. In production the caller's environment has no
# IPFS_PATH — the script must read it from the daemon's /proc/<pid>/environ and
# pass it explicitly on every call. Exporting it in the harness would let an
# inherited value paper over exactly the bug this check exists to catch.
export PATH="$BIN:$PATH"

echo "── publish path, executed ──────────────────────────────────────"

# ── 1. The script must be executable (systemd refuses otherwise) ──────
if [ -x "$PIN" ]; then ok "pin script carries the execute bit"; else no "pin script is NOT executable — systemd would fail with 203/EXEC"; fi

# ── 2. Clean run: does the publish path actually complete? ────────────
export HARNESS_PROBE_FAILURES=0
: > "$HARNESS_PROBE_COUNT"
OUT="$(bash "$PIN" "$TARBALL" 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then ok "publish path runs end to end (exit 0)"; else
	no "publish path failed (exit $RC)"; printf '%s\n' "$OUT" | sed 's/^/      /'
fi
case "$OUT" in
	*"manifest: chain cd8d90f2"*) ok "manifest parsed out of the tarball (the stdin-collision bug)" ;;
	*) no "manifest was NOT parsed — the python heredoc/stdin bug is back" ;;
esac
case "$OUT" in
	*"MORPHIT_SNAPSHOT_PAYLOAD="*) ok "payload locator emitted on stdout" ;;
	*) no "no MORPHIT_SNAPSHOT_PAYLOAD locator — the caller would have to scan the filesystem" ;;
esac
case "$OUT" in
	*" kB"*) ok "size reported in kB (not a floored 0 MB)" ;;
	*"0 MB"*) no "size still reports 0 MB for a sub-1MB snapshot" ;;
	*) ok "size reported in kB (not a floored 0 MB)" ;;
esac

# ── 3. IPFS_PATH must be passed explicitly, never inherited via HOME ──
if grep -q 'IPFS_PATH=UNSET' "$HARNESS_LOG"; then
	no "at least one ipfs call ran with IPFS_PATH UNSET — kubo would use ~/.ipfs"
else
	ok "every ipfs call carried an explicit IPFS_PATH"
fi

# ── 4. A daemon that has just restarted must be waited for ────────────
# This is the exact production failure: the script restarts ipfs itself, then a
# probe finds the API briefly down. A one-shot probe called that fatal.
export HARNESS_PROBE_FAILURES=3
: > "$HARNESS_PROBE_COUNT"
OUT2="$(bash "$PIN" "$TARBALL" 2>&1)"; RC2=$?
if [ "$RC2" -eq 0 ]; then
	ok "survives a kubo API that is briefly down (retries instead of dying)"
else
	no "died while the kubo API was briefly down (exit $RC2) — the no-retry probe is back"
fi

# ── 5. A genuinely dead daemon must fail LOUDLY, not silently ─────────
export HARNESS_PROBE_FAILURES=999
: > "$HARNESS_PROBE_COUNT"
OUT3="$(bash "$PIN" "$TARBALL" 2>&1)"; RC3=$?
if [ "$RC3" -ne 0 ]; then ok "a permanently dead kubo still fails (does not hang or pass)"; else
	no "a dead kubo was treated as success"
fi
case "$OUT3" in
	*"ipfs said:"*) ok "reports what ipfs actually said when it gives up" ;;
	*) no "gave up without reporting the child's error — the swallowed-output bug is back" ;;
esac

# ── 6. Both privilege-drop tools blocked → must still work as root ───
# This is the morphit.io failure exactly: sudo refused under NoNewPrivileges,
# then runuser could not setuid either. Guessing which tool a host permits is
# how this job failed five times in one evening; it must probe and adapt.
export HARNESS_BREAK_PRIVDROP=1
printf '#!/usr/bin/env bash\necho "runuser: cannot set user id: Operation not permitted" >&2\nexit 1\n' > "$BIN/runuser"
printf '#!/usr/bin/env bash\necho "sudo: unable to open /etc/sudoers: Operation not permitted" >&2\nexit 1\n' > "$BIN/sudo"
chmod +x "$BIN/runuser" "$BIN/sudo"
export HARNESS_PROBE_FAILURES=0
: > "$HARNESS_PROBE_COUNT"
OUT4="$(bash "$PIN" "$TARBALL" 2>&1)"; RC4=$?
if [ "$RC4" -eq 0 ]; then
	ok "still publishes when BOTH sudo and runuser are blocked (falls back to root)"
else
	no "failed when sudo and runuser are blocked (exit $RC4) — the morphit.io failure"
	printf '%s\n' "$OUT4" | sed 's/^/      /' | tail -6
fi
case "$OUT4" in
	*"strategy: direct"*) ok "reports which strategy it chose" ;;
	*) no "did not report choosing the direct strategy" ;;
esac

echo ""
if [ "$fails" -gt 0 ]; then
	printf '\033[31m✗ %d harness check(s) failed\033[0m (%d passed)\n' "$fails" "$pass"
	exit 1
fi
printf '\033[32m✓ all %d publish-path harness checks passed\033[0m\n' "$pass"
