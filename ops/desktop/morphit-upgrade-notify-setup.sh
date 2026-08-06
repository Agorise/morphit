#!/bin/sh
# morphit-upgrade-notify-setup.sh (cp598) — one-shot setup of the desktop
# "an upgrade is available" notification on a home node with a graphical desktop.
#
# A desktop toast must run in the LOGGED-IN USER's graphical session, so this
# installs a systemd --user timer SYSTEM-WIDE (in /etc/systemd/user/) and
# enables it GLOBALLY.  When the desktop user logs in, THEIR user-systemd starts
# the timer, which checks the local indexer and pops a notify-send toast when a
# newer release is on-chain — telling them to run `sudo morphit-ops` and upgrade.
#
# The morphit-ops wizard runs this on the HOME branch (a desktop box); it's a
# no-op benefit on a headless VPS (no graphical session → the timer's service
# just bails).  Run directly:  sudo sh ops/desktop/morphit-upgrade-notify-setup.sh
# Idempotent.  POSIX sh.  Must run as root.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

LIB=/usr/local/lib/morphit
USER_UNIT_DIR=/etc/systemd/user
# 6h between checks matches the release-monitor sidecar's cadence.
CHECK_INTERVAL="${MORPHIT_UPGRADE_NOTIFY_INTERVAL:-6h}"

echo "== Morphit desktop upgrade-notification setup =="

# 1. notify-send (libnotify) is required for the toast.  Best-effort install so
#    grandma doesn't have to; non-fatal if apt isn't available or it's already
#    present (the timer's script also bails gracefully if it's still missing).
if ! command -v notify-send >/dev/null 2>&1; then
	if command -v apt-get >/dev/null 2>&1; then
		echo "  installing libnotify-bin (for notify-send)…"
		DEBIAN_FRONTEND=noninteractive apt-get install -y libnotify-bin >/dev/null 2>&1 \
			|| echo "  ! could not auto-install libnotify-bin — install it to get toasts."
	else
		echo "  ! notify-send not found and apt-get unavailable — install libnotify-bin for toasts."
	fi
fi

# 2. Install the notifier at a stable system path.
install -d "$LIB"
install -m 0755 "$HERE/morphit-upgrade-notify.sh" "$LIB/morphit-upgrade-notify.sh"
echo "  + installed $LIB/morphit-upgrade-notify.sh"

# 3. System-wide USER units (apply to every user's session manager).
install -d "$USER_UNIT_DIR"
cat > "$USER_UNIT_DIR/morphit-upgrade-notify.service" <<EOF
# Morphit — desktop "upgrade available" notifier (cp598).  Runs in the user's
# graphical session; the script bails quietly if no desktop is reachable.
[Unit]
Description=Notify me on my desktop when a Morphit upgrade is available
Documentation=file:///opt/morphit/docs/RUN-A-MORPHIT-NODE.md
After=graphical-session.target

[Service]
Type=oneshot
ExecStart=$LIB/morphit-upgrade-notify.sh
EOF

cat > "$USER_UNIT_DIR/morphit-upgrade-notify.timer" <<EOF
# Morphit — desktop upgrade-notification timer (cp598).  Checks a couple of
# minutes after login, then every $CHECK_INTERVAL.
[Unit]
Description=Timer for the Morphit desktop upgrade notification

[Timer]
OnStartupSec=2min
OnUnitActiveSec=$CHECK_INTERVAL
# Run soon after login if a scheduled tick was missed while logged out.
Persistent=true

[Install]
WantedBy=timers.target
EOF
echo "  + wrote $USER_UNIT_DIR/morphit-upgrade-notify.{service,timer}"

# 4. Enable for ALL users globally.  Real login users with a graphical session
#    (grandma) start it at login; system/service users without a user manager
#    never run it.
systemctl --global enable morphit-upgrade-notify.timer >/dev/null 2>&1 || true
echo "  + enabled morphit-upgrade-notify.timer for desktop sessions (systemctl --global)"
echo ""
echo "  Done.  When the desktop user logs in, they'll be nudged to upgrade"
echo "  whenever a new release lands (once per version, no nagging)."
echo "    Test now (as the DESKTOP user, in their session):"
echo "      systemctl --user start morphit-upgrade-notify.service"
