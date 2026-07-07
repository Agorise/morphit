#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-i2p.sh — I2P (.b32.i2p) vanity address generator
#
# Run this on YOUR OWN computer (a laptop you control) — NOT the server — so
# the secret key is born on a machine you trust. Carry the key file to the
# server over SSH (never email). Never commit it; .gitignore excludes
# hidden-services/.
#
# Plain English: an I2P address is a long scramble. You can make one that
# STARTS with a few letters you choose — but only a FEW, because they come
# from a hash. Rough wait by length:
#   1–5 letters: seconds.   6 letters: a few minutes.   7+: hours or more.
# Pick something short, like your project's first 3–5 letters.
#
# Usage:  ./scripts/generate-i2p.sh <letters>
# Example: ./scripts/generate-i2p.sh morph
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PREFIX="${1:-morph}"
OUT_DIR="$(pwd)/hidden-services/i2p-${PREFIX}"

VAIN_BIN="vain"
if ! command -v vain >/dev/null 2>&1; then
	if [ -x "./vain" ]; then
		VAIN_BIN="./vain"
	else
		cat >&2 <<'EOF'
The "vain" tool (from i2pd-tools) isn't installed.

Build it from source (it uses git submodules, so clone with --recursive):
  git clone --recursive https://github.com/PurpleI2P/i2pd-tools
  cd i2pd-tools
  git submodule update --init
  make

Then put the "vain" binary on your $PATH, or run this script from inside the
i2pd-tools folder so ./vain is found.
EOF
		exit 1
	fi
fi

mkdir -p "${OUT_DIR}"
echo "Looking for an I2P address that starts with '${PREFIX}'…"
echo "1–5 letters finish in seconds; 6 can take minutes; 7+ much longer."
echo "Output folder: ${OUT_DIR}"
echo

# vain takes just the prefix and writes "private.dat" (your destination keys)
# into the current directory — so run it from inside the output folder.
( cd "${OUT_DIR}" && "${VAIN_BIN}" "${PREFIX}" )

KEYFILE="${OUT_DIR}/private.dat"
if [ ! -f "${KEYFILE}" ]; then
	echo >&2 "No private.dat was produced — check the vain output above."
	exit 1
fi

# The .b32.i2p address is base32(sha256(first 391 bytes of the dest)), lower-
# cased, padding removed.
ADDRESS="$(head -c 391 "${KEYFILE}" | sha256sum | cut -d' ' -f1 | xxd -r -p | base32 | tr 'A-Z' 'a-z' | tr -d '=').b32.i2p"

echo
echo "Done! Your address is:"
echo "  ${ADDRESS}"
echo "Your secret key file (keep private — never share or commit):"
echo "  ${KEYFILE}"

cat <<EOF

Next, on the SERVER:
  1. Copy the key file over, e.g.:
       scp "${KEYFILE}" you@server:/var/lib/i2pd/morphit.dat
     then: sudo chown i2pd:i2pd /var/lib/i2pd/morphit.dat && sudo chmod 600 /var/lib/i2pd/morphit.dat
  2. Add a tunnel in i2pd's tunnels.conf (point it at your web port):
       [morphit]
       type = http
       host = 127.0.0.1
       port = 8080
       keys = morphit.dat
     then: sudo systemctl restart i2pd
  3. Run "morphit-ops" → "Set up a Tor / Lokinet / I2P address" → I2P,
     and paste the address above. That puts it in your site footer.
EOF
