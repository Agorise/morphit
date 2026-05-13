#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-i2p.sh — I2P vanity .b32.i2p destination generator
#
# Runs on operator hardware. Uses i2pd-tools' vain (vanity generator).
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PREFIX="${1:-morphit}"
OUT_DIR="$(pwd)/hidden-services/i2p-${PREFIX}"

if ! command -v vain >/dev/null 2>&1; then
	cat >&2 <<'EOF'
The `vain` tool from i2pd-tools is not installed.

Install it:
  git clone https://github.com/PurpleI2P/i2pd-tools.git
  cd i2pd-tools
  make vain

Put the `vain` binary on your $PATH, or adjust this script.
EOF
	exit 1
fi

mkdir -p "${OUT_DIR}"
echo "Searching for I2P destination starting with '${PREFIX}'…"
echo "Shorter prefixes are much faster. 5–6 characters is realistic on a laptop."
echo "Output directory: ${OUT_DIR}"

# vain -t N -n prefix outfile
vain -t "$(nproc)" "${PREFIX}" "${OUT_DIR}/morphit.dat"

echo
echo "Keypair file: ${OUT_DIR}/morphit.dat"
echo
cat <<'EOF'
Next steps:
  1. scp morphit.dat to /var/lib/i2pd/morphit.dat on the VPS.
  2. chown i2pd:i2pd, chmod 0600.
  3. Add a section to /etc/i2pd/tunnels.conf:
       [morphit]
       type = http
       host = 127.0.0.1
       port = 8080
       keys = morphit.dat
  4. systemctl restart i2pd.
  5. Check: grep "morphit" /var/log/i2pd/i2pd.log
EOF
