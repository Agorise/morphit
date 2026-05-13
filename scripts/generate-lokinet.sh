#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-lokinet.sh — Lokinet vanity .loki address generator
#
# Runs on operator hardware. Writes the resulting keypair to a local dir;
# you'll copy the snapp keypair to the VPS separately.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PREFIX="${1:-morphit}"
OUT_DIR="$(pwd)/hidden-services/lokinet-${PREFIX}"

if ! command -v lokinet-vanity >/dev/null 2>&1; then
	cat >&2 <<'EOF'
lokinet-vanity is not installed.

Install Lokinet:
  https://lokinet.org/

The `lokinet-vanity` binary ships with the Lokinet source build. You may need
to build from source; distro packages sometimes omit this tool.
EOF
	exit 1
fi

mkdir -p "${OUT_DIR}"
echo "Searching for .loki starting with '${PREFIX}'…"
echo "Output directory: ${OUT_DIR}"

# lokinet-vanity <prefix> <output-file>
lokinet-vanity "${PREFIX}" "${OUT_DIR}/snapp.private"

echo
echo "Public address written; keypair saved to ${OUT_DIR}/snapp.private"
echo
cat <<'EOF'
Next steps:
  1. scp snapp.private to the VPS: /var/lib/lokinet/snapp-morphit.private
  2. chown lokinet:lokinet and chmod 0600 the file.
  3. Add a [snapp] section to /etc/loki/lokinet.ini pointing at that keyfile.
  4. systemctl restart lokinet.
  5. Verify: lokinet-resolve morphit.loki
EOF
