#!/bin/sh
# morphit-ipfs-setup.sh — one-shot setup of IPFS release hosting on a MANUAL
# (non-Ansible) install. Installs a small Kubo node + the release-pinning
# service, so this instance helps host Morphit's signed releases.
#
# Ansible installs already get this via the `ipfs` role (ON by default). This is
# the equivalent for a hand-managed box (e.g. /opt/morphit). `morphit-ops`
# invokes it, or run it directly:  sudo sh ops/ipfs/morphit-ipfs-setup.sh
#
# Idempotent + safe to re-run. POSIX sh. Must run as root.
set -eu

KUBO_VERSION="${MORPHIT_KUBO_VERSION:-v0.42.0}"
KUBO_ARCH="${MORPHIT_KUBO_ARCH:-linux-amd64}"
KUBO_SHA512="${MORPHIT_KUBO_SHA512:-054c38a0cf66f7d738e25085ad62cb3a42d03d4bac329b7dd25c1d71cf18e1ce87d55b1d1b705b04c65210dca9109973579e0eb1cd72f6341ecb3311d840d156}"          # optional strong pin
DIST="${MORPHIT_KUBO_DIST_BASE:-https://dist.ipfs.tech/kubo}"
IPFS_USER="${MORPHIT_IPFS_USER:-ipfs}"
IPFS_HOME="${MORPHIT_IPFS_HOME:-/var/lib/ipfs}"
IPFS_REPO="${IPFS_PATH:-$IPFS_HOME/.ipfs}"
RELEASE_URL="${MORPHIT_RELEASE_URL:-http://127.0.0.1:${MORPHIT_INDEXER_PORT:-8088}/v1/release}"
PIN_CALENDAR="${MORPHIT_IPFS_PIN_ON_CALENDAR:-hourly}"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

echo "== Morphit IPFS release hosting setup =="

# 1. Service account.
if ! id "$IPFS_USER" >/dev/null 2>&1; then
	useradd --system --home-dir "$IPFS_HOME" --create-home --shell /usr/sbin/nologin "$IPFS_USER"
	echo "  + created user $IPFS_USER"
fi
mkdir -p "$IPFS_HOME"; chown "$IPFS_USER:$IPFS_USER" "$IPFS_HOME"

# 2. Kubo binary (skip if the pinned version is already installed).
if ! command -v ipfs >/dev/null 2>&1 || ! ipfs --version 2>/dev/null | grep -q "${KUBO_VERSION#v}"; then
	TMP=$(mktemp -d)
	TARBALL="kubo_${KUBO_VERSION}_${KUBO_ARCH}.tar.gz"
	echo "  downloading Kubo ${KUBO_VERSION}…"
	curl -fsSL "$DIST/$KUBO_VERSION/$TARBALL" -o "$TMP/$TARBALL"
	GOT=$(sha512sum "$TMP/$TARBALL" | awk '{print $1}')
	if [ -n "$KUBO_SHA512" ]; then
		[ "$(echo "$GOT" | tr A-Z a-z)" = "$(echo "$KUBO_SHA512" | tr A-Z a-z)" ] \
			|| { echo "  ✗ SHA-512 mismatch vs pinned value — aborting." >&2; exit 1; }
	else
		curl -fsSL "$DIST/$KUBO_VERSION/$TARBALL.sha512" -o "$TMP/$TARBALL.sha512" || true
		if [ -s "$TMP/$TARBALL.sha512" ]; then
			WANT=$(grep -oiE '[0-9a-f]{128}' "$TMP/$TARBALL.sha512" | head -n1)
			[ "$(echo "$GOT" | tr A-Z a-z)" = "$(echo "$WANT" | tr A-Z a-z)" ] \
				|| { echo "  ✗ SHA-512 mismatch vs published checksum — aborting." >&2; exit 1; }
		else
			echo "  ! could not fetch the published checksum; set MORPHIT_KUBO_SHA512 to verify." >&2
		fi
	fi
	tar -C "$TMP" -xzf "$TMP/$TARBALL"
	install -m 0755 "$TMP/kubo/ipfs" /usr/local/bin/ipfs
	rm -rf "$TMP"
	echo "  + installed /usr/local/bin/ipfs ($(ipfs --version))"
fi

# 3. Repo init (low-footprint profile) + conservative config.
if [ ! -f "$IPFS_REPO/config" ]; then
	sudo -u "$IPFS_USER" env IPFS_PATH="$IPFS_REPO" ipfs init --profile lowpower >/dev/null
	echo "  + initialised Kubo repo at $IPFS_REPO"
fi
sudo -u "$IPFS_USER" env IPFS_PATH="$IPFS_REPO" sh -c '
	ipfs config Addresses.API "/ip4/127.0.0.1/tcp/5001" >/dev/null 2>&1 || true
	ipfs config Addresses.Gateway "/ip4/127.0.0.1/tcp/8081" >/dev/null 2>&1 || true
	ipfs config --json Swarm.ConnMgr.HighWater 80 >/dev/null 2>&1 || true
	ipfs config --json Swarm.ConnMgr.LowWater 20 >/dev/null 2>&1 || true
'

# 4. Pin script + env.
mkdir -p /usr/local/lib/morphit /etc/morphit
install -m 0755 "$HERE/morphit-ipfs-pin.sh" /usr/local/lib/morphit/morphit-ipfs-pin.sh
cat > /etc/morphit/ipfs-pin.env <<EOF
MORPHIT_RELEASE_URL=$RELEASE_URL
IPFS_PATH=$IPFS_REPO
MORPHIT_IPFS_PIN_TIMEOUT=900
EOF
chmod 0640 /etc/morphit/ipfs-pin.env

# 5. systemd units.
cat > /etc/systemd/system/ipfs.service <<EOF
[Unit]
Description=IPFS (Kubo) daemon — Morphit release hosting
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
User=$IPFS_USER
Group=$IPFS_USER
Environment=IPFS_PATH=$IPFS_REPO
ExecStart=/usr/local/bin/ipfs daemon --migrate=true --enable-gc
Restart=on-failure
RestartSec=10
LimitNOFILE=8192
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$IPFS_HOME
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/morphit-ipfs-pin.service <<EOF
[Unit]
Description=Pin Morphit's current signed release to IPFS
After=ipfs.service morphit-indexer.service
Wants=ipfs.service
[Service]
Type=oneshot
User=$IPFS_USER
Group=$IPFS_USER
EnvironmentFile=-/etc/morphit/ipfs-pin.env
Environment=IPFS_PATH=$IPFS_REPO
ExecStart=/usr/local/lib/morphit/morphit-ipfs-pin.sh
SuccessExitStatus=0 1
EOF

cat > /etc/systemd/system/morphit-ipfs-pin.timer <<EOF
[Unit]
Description=Periodically pin Morphit's current signed release to IPFS
[Timer]
OnBootSec=3min
OnCalendar=$PIN_CALENDAR
Persistent=true
RandomizedDelaySec=90
[Install]
WantedBy=timers.target
EOF

# 6. Enable + start.
systemctl daemon-reload
systemctl enable --now ipfs.service
systemctl enable --now morphit-ipfs-pin.timer

echo "  ✓ Kubo daemon + release-pinning timer are up."
echo "    Check:   systemctl status ipfs morphit-ipfs-pin.timer"
echo "    Pin now: sudo systemctl start morphit-ipfs-pin.service && journalctl -u morphit-ipfs-pin -e"
echo "    Your node will pin release $(curl -fsS --max-time 5 "$RELEASE_URL" 2>/dev/null | grep -o '\"version\"[^,]*' | head -n1 || echo '(fetch /v1/release to see)')."
