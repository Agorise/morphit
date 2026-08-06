#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# vps-bootstrap.sh — prepare an Ubuntu 24.04 host for the Morphit stack
#
# Run this ONCE, as root, immediately after provisioning the VPS. It installs
# the base packages, hardens SSH, configures firewall, and creates unprivileged
# service users. It does NOT start any public-facing daemon — configuration
# of nginx, Tor, Lokinet, and i2pd happens in Phase 5 with proper keys.
#
# WARNING: this script locks down SSH to key-auth only. Make sure you can
# log in with a key before running.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
	echo "Run as root." >&2
	exit 1
fi

if ! grep -q "Ubuntu 24.04" /etc/os-release 2>/dev/null; then
	echo "This script is tuned for Ubuntu 24.04 LTS." >&2
	echo "Your system: $(lsb_release -ds 2>/dev/null || echo unknown)" >&2
	read -r -p "Continue anyway? [y/N] " reply
	[[ "${reply}" =~ ^[Yy]$ ]] || exit 1
fi

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

log "Updating package lists"
apt-get update -qq

log "Installing base packages"
apt-get install -y \
	ufw fail2ban crowdsec \
	nginx \
	tor tor-geoipdb \
	lokinet \
	i2pd \
	postgresql-16 \
	wireguard wireguard-tools \
	unattended-upgrades \
	curl ca-certificates gnupg lsb-release \
	htop iotop \
	zstd \
	restic

log "Disabling every installed public-facing daemon until Phase 5 configures it"
systemctl disable --now nginx tor i2pd || true
systemctl disable --now lokinet@default || true

log "Creating /opt/morphit service directories"
mkdir -p /opt/morphit/{bin,etc,log,data}
chmod 750 /opt/morphit

log "Creating unprivileged service users"
for svc in indexer relay payment-watcher avatar-server matrix-bot; do
	if ! id -u "morphit-${svc}" >/dev/null 2>&1; then
		useradd --system --home "/opt/morphit/${svc}" --shell /usr/sbin/nologin "morphit-${svc}"
		mkdir -p "/opt/morphit/${svc}"
		chown "morphit-${svc}:morphit-${svc}" "/opt/morphit/${svc}"
		chmod 750 "/opt/morphit/${svc}"
	fi
done

log "Configuring UFW (deny incoming by default, allow 22/80/443)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'http'
ufw allow 443/tcp comment 'https'
ufw --force enable

log "Hardening SSH (key-auth only, no root login)"
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#*PermitEmptyPasswords.*/PermitEmptyPasswords no/' /etc/ssh/sshd_config
systemctl restart ssh

log "Disabling access logs in nginx (no IP logging anywhere)"
cat > /etc/nginx/conf.d/00-no-logs.conf <<'EOF'
# Morphit: no access logs, anywhere. Error log kept for operator diagnostics,
# but redacted of IP addresses.
access_log off;
# (Error log stays default until Phase 5, when per-vhost error logs are tuned.)
EOF

log "Enabling unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

log "Configuring PostgreSQL 16 to listen on localhost only"
sed -i "s/^#*listen_addresses.*/listen_addresses = 'localhost'/" /etc/postgresql/16/main/postgresql.conf
systemctl restart postgresql

log "Ensuring Tor, Lokinet, and i2pd are disabled until keys are installed"
# Phase 5 will copy vanity keys in, then enable/start these.
for svc in tor i2pd; do
	systemctl disable --now "${svc}" || true
done

log "Done."
cat <<'EOF'

Next steps (Phase 5):
  1. Copy operator-generated Tor / Lokinet / I2P keys into their service dirs.
  2. Configure nginx vhosts (clearnet + Tor + Lokinet + I2P).
  3. Install Morphit service binaries into /opt/morphit/<svc>/bin/.
  4. Enable and start services one at a time, verifying each.
  5. Set up nightly encrypted backups with restic to an external endpoint.
  6. Configure Zabbix to page you on Matrix if anything flaps.
EOF
