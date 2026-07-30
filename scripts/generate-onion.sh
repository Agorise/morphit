#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-onion.sh — Tor v3 hidden-service vanity address generator
#
# Runs ONLY on operator hardware. The resulting private key file must be
# hand-delivered to the VPS over an authenticated channel (SSH, never email).
# Never commit the output; the repo's .gitignore excludes hidden-services/.
#
# Usage:  ./scripts/generate-onion.sh <prefix>
# Example: ./scripts/generate-onion.sh morphit
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PREFIX="${1:-morphit}"
OUT_DIR="$(pwd)/hidden-services/tor-${PREFIX}"

if ! command -v mkp224o >/dev/null 2>&1; then
	cat >&2 <<'EOF'
mkp224o is not installed.

Install it from source (GPL-3.0), not a prebuilt binary:
  git clone https://github.com/cathugger/mkp224o.git
  cd mkp224o
  ./autogen.sh && ./configure && make

Put the `mkp224o` binary on your $PATH.
EOF
	exit 1
fi

mkdir -p "${OUT_DIR}"
echo "Searching for .onion starting with '${PREFIX}'…"
echo "This may take minutes to hours depending on prefix length and CPU count."
echo "Output directory: ${OUT_DIR}"

# -n 1     : stop after one match
# -d       : output directory
# -t N     : thread count = all cores
mkp224o -n 1 -d "${OUT_DIR}" -t "$(nproc)" "${PREFIX}"

echo
echo "Found addresses:"
find "${OUT_DIR}" -maxdepth 1 -type d -name "${PREFIX}*.onion" | while read -r d; do
	echo "  $(basename "${d}")"
done

cat <<'EOF'

Next steps:
  1. Inspect the hs_ed25519_secret_key in the chosen directory — DO NOT share it.
  2. scp the whole directory to the VPS under /var/lib/tor/morphit/ (root-owned, mode 0700).
  3. Add the HiddenServiceDir and HiddenServicePort lines to /etc/tor/torrc.
  4. systemctl reload tor.
  5. tail /var/log/tor/notices.log to confirm the service is reachable.
EOF
