#!/usr/bin/env bash
# find-live-file.sh — determine WHICH operationalHealth.ts the running indexer
# actually loads (there are duplicate copies). Marks every copy, restarts, reads
# which one fired, restores all. Run on the box:  sudo bash find-live-file.sh
set -uo pipefail
LOG=/tmp/molog
g=$'\e[32m'; y=$'\e[33m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

hdr "1. Every operationalHealth.ts copy under /opt/morphit"
mapfile -t FILES < <(find /opt/morphit -name operationalHealth.ts \
	-not -name '*.bak*' -not -name '*.dbg-bak*' -not -name '*.flog-bak*' -not -name '*.livetest-bak*' \
	-not -path '*/node_modules/tsx/*' -not -path '*/node_modules/.cache/*' 2>/dev/null)
for f in "${FILES[@]}"; do echo "    $f"; done
[ "${#FILES[@]}" -gt 0 ] || { warn "none found?"; exit 1; }

hdr "2. Mark each copy with its own path, clear cache, restart"
: > "$LOG"; chmod 666 "$LOG"
python3 - "$LOG" "${FILES[@]}" <<'PYEOF'
import sys
log = sys.argv[1]; files = sys.argv[2:]
for f in files:
    open(f + '.livetest-bak', 'w', encoding='utf-8').write(open(f, encoding='utf-8').read())
    body = open(f, encoding='utf-8').read()
    line = ("import { appendFileSync as __molog } from 'node:fs'; "
            "try { __molog(%r, %r + '\\n'); } catch {}\n" % (log, 'LIVE-FILE::' + f))
    open(f, 'w', encoding='utf-8').write(line + body)
print("marked %d file(s)" % len(files))
PYEOF
for c in /tmp/tsx-* /opt/morphit/node_modules/.cache /opt/morphit/apps/indexer/node_modules/.cache; do [ -e "$c" ] && rm -rf "$c" 2>/dev/null && echo "    cleared cache: $c"; done
systemctl restart morphit-indexer 2>/dev/null && ok "restarted" || warn "restart manually"
IHOST="$(grep -h '^MORPHIT_INDEXER_LISTEN_HOST=' /opt/morphit/morphit.env /etc/morphit/indexer.env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' )"; IHOST="${IHOST:-172.18.0.1}"
sleep 8; for _ in 1 2 3; do curl -s -o /dev/null "http://$IHOST:8081/v1/health" 2>/dev/null || true; sleep 3; done
sleep 2

hdr "3. Which copy actually loaded in the running process"
if [ -s "$LOG" ]; then sort -u "$LOG" | sed 's/^/  >>> /'; else warn "NOTHING loaded — operationalHealth.ts isn't imported at all by the running code (bundled dist? different entry?)"; fi

hdr "4. Restore every copy"
for f in "${FILES[@]}"; do [ -f "$f.livetest-bak" ] && cp -a "$f.livetest-bak" "$f" && rm -f "$f.livetest-bak"; done
for c in /tmp/tsx-*; do rm -rf "$c" 2>/dev/null; done
systemctl restart morphit-indexer 2>/dev/null && ok "restored + restarted clean" || warn "restart manually"
echo
echo "The >>> LIVE-FILE line is the ONE file the running indexer executes."
echo "If it's node_modules/morphit-indexer/... then every edit to apps/indexer/src was the wrong copy —"
echo "and THAT copy is what needs the fix (or the deploy must stop shipping a stale duplicate)."
