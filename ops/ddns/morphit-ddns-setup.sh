#!/bin/sh
# morphit-ddns-setup.sh (cp596) — one-shot setup of dynamic DNS on a MANUAL
# (non-Ansible) install.  Installs the updater + a 5-minute timer that keeps
# your domain's A record pointed at this box's current public IP, so a home
# node stays reachable at your OWN domain even when your ISP changes the IP.
#
# This is the hand-managed equivalent of the shipped `ddns` Ansible role.
# `morphit-ops` invokes it (it builds MORPHIT_DDNS_UPDATE_URL for you from a
# short provider menu and passes it in the environment), or run it directly:
#
#   sudo MORPHIT_DDNS_UPDATE_URL='https://njal.la/update/?h=you.example&k=KEY&a={ip}' \
#        sh ops/ddns/morphit-ddns-setup.sh
#
# The literal token {ip} in the URL is replaced with the detected public IP at
# each run.  Idempotent + safe to re-run.  POSIX sh.  Must run as root.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

ENV_FILE=/etc/morphit/ddns.env
LIB=/usr/local/lib/morphit
STATE_DIR=/var/lib/morphit
# systemd OnCalendar for "every 5 minutes"; override with MORPHIT_DDNS_ON_CALENDAR.
TIMER_CALENDAR="${MORPHIT_DDNS_ON_CALENDAR:-*:0/5}"

echo "== Morphit dynamic DNS setup =="

URL="${MORPHIT_DDNS_UPDATE_URL:-}"
if [ -z "$URL" ]; then
	echo "  ✗ MORPHIT_DDNS_UPDATE_URL is not set." >&2
	echo "    Run this via 'sudo morphit-ops harden' (it builds the URL from a" >&2
	echo "    provider menu), or pass it yourself — see the header of this file." >&2
	exit 1
fi
case "$URL" in
	*'{ip}'*) : ;;
	*) echo "  ! note: your URL has no {ip} token — the provider will have to" >&2
	   echo "         infer your IP from the request's source address." >&2 ;;
esac

# 1. Persist the config (contains the provider secret → 0600).
mkdir -p /etc/morphit
umask 077
cat > "$ENV_FILE" <<EOF
# Morphit dynamic DNS config (cp596).  CONTAINS YOUR PROVIDER SECRET — keep 0600.
# The updater replaces {ip} with this box's detected public IP on each run.
MORPHIT_DDNS_UPDATE_URL=$URL
EOF
chmod 600 "$ENV_FILE"
echo "  + wrote $ENV_FILE (0600)"

# 2. Install the updater at a stable system path (decoupled from where the repo
#    was extracted — the unit doesn't need to know that path).
install -d "$LIB"
install -m 0755 "$HERE/morphit-ddns-update.sh" "$LIB/morphit-ddns-update.sh"
install -d "$STATE_DIR"
echo "  + installed $LIB/morphit-ddns-update.sh"

# 3. systemd service (oneshot) + timer.
cat > /etc/systemd/system/morphit-ddns.service <<EOF
# Morphit — dynamic DNS update (cp596).  Pushes this box's current public IP to
# your DNS provider.  See ops/ddns/morphit-ddns-update.sh for what it does.
[Unit]
Description=Morphit dynamic DNS update
Documentation=file:///opt/morphit/docs/RUN-A-MORPHIT-NODE.md
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-/etc/morphit/ddns.env
ExecStart=$LIB/morphit-ddns-update.sh
# The updater exits 1 on a transient failure so the timer simply retries; that
# must not mark the unit failed forever.
SuccessExitStatus=0 1

# ─── Hardening ───
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
RestrictSUIDSGID=true
LockPersonality=true
# Only the state-cache dir needs to be writable.
ReadWritePaths=$STATE_DIR
SyslogIdentifier=morphit-ddns

[Install]
# The timer triggers this; nothing else wants the service directly.
EOF

cat > /etc/systemd/system/morphit-ddns.timer <<EOF
# Morphit — dynamic DNS timer (cp596).  Checks the public IP shortly after boot
# and every 5 minutes; the updater only calls the provider when it changed.
[Unit]
Description=Timer for morphit-ddns.service (keep your home DNS current)
Documentation=file:///opt/morphit/docs/RUN-A-MORPHIT-NODE.md

[Timer]
OnBootSec=1min
OnCalendar=$TIMER_CALENDAR
# Fire on next activation if the box was asleep/off at a scheduled tick.
Persistent=true
AccuracySec=30s
# Smear a fleet of home nodes so they don't all hit the IP-echo services at the
# same instant.
RandomizedDelaySec=45s

[Install]
WantedBy=timers.target
EOF
echo "  + wrote morphit-ddns.service + morphit-ddns.timer"

# 4. Enable + start.
systemctl daemon-reload
systemctl enable --now morphit-ddns.timer
echo "  + morphit-ddns.timer enabled (schedule: $TIMER_CALENDAR)"
echo ""
echo "  Done.  Your domain now follows this box's IP automatically."
echo "    Check:    systemctl status morphit-ddns.timer"
echo "    Push now: sudo systemctl start morphit-ddns.service && journalctl -u morphit-ddns -e --no-pager"
