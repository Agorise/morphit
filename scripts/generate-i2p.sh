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
# Usage:  bash generate-i2p.sh <letters> [ssh-target-of-your-server]
# Example: bash generate-i2p.sh morph alice@morphit.example
#
# Each run makes a NEW folder (hidden-services/i2p-<letters>, then -2, -3 …):
# an earlier key is never overwritten or mixed up with the new one.
#
# `sudo morphit-ops alt-address` (on the server) prints the command to copy
# this script to your computer and run it.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PREFIX="${1:-morph}"
SERVER="${2:-YOUR-USER@YOUR-SERVER}"

# Where the copy lands on the server: root's home is /root; any other login's
# is its own home folder ("~" there).
case "${SERVER}" in
	root@*) HOME_THERE="/root" ;;
	*) HOME_THERE="~" ;;
esac

# The login those commands run under on the server.
case "${SERVER}" in
	*@*) LOGIN="${SERVER%%@*}" ;;
	*) LOGIN="the account you ssh in with" ;;
esac

# A fresh folder for this run: vain writes private.dat into the folder it runs
# in, so reusing one would overwrite (or be mistaken for) an earlier key.
BASE_DIR="$(pwd)/hidden-services/i2p-${PREFIX}"
OUT_DIR="${BASE_DIR}"
n=1
while [ -e "${OUT_DIR}" ]; do
	n=$((n + 1))
	OUT_DIR="${BASE_DIR}-${n}"
done

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
# scp with a relative path puts the file in the login's home folder.
if [ "${HOME_THERE}" = "/root" ]; then REMOTE_PATH="/root/morphit-web.dat"; else REMOTE_PATH="morphit-web.dat"; fi
if [ ! -f "${KEYFILE}" ]; then
	echo >&2 "No private.dat was produced — check the vain output above."
	exit 1
fi

# The .b32.i2p address is base32(sha256(first 391 bytes of the dest)), lower-
# cased, padding removed.
# (openssl gives the raw digest directly; xxd — from vim — is not on every
# computer, so it is only the second choice.)
sha256_raw() {
	if command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 -binary
	else
		sha256sum | cut -d' ' -f1 | xxd -r -p
	fi
}
if ! command -v openssl >/dev/null 2>&1 && ! command -v xxd >/dev/null 2>&1; then
	echo >&2 "To work out the address this needs openssl (or xxd). On this computer: sudo apt install openssl"
	exit 1
fi
ADDRESS="$(head -c 391 "${KEYFILE}" | sha256_raw | base32 | tr 'A-Z' 'a-z' | tr -d '=').b32.i2p"

echo
echo "Done! Your address is:"
echo "  ${ADDRESS}"
echo "It is saved in this folder:"
echo "  ${OUT_DIR}"
echo "Your secret key file (keep private — never share or commit):"
echo "  ${KEYFILE}"

# The server's i2pd already runs Morphit's tunnel, [morphit-web] in
# /etc/i2pd/tunnels.conf (set up by the installer: port = 8090, the site's
# front), with its key in /var/lib/i2pd/morphit-web.dat owned by the i2pd
# user. Only that key file is replaced; a second tunnel is not needed.
# Hardened servers turn SSH's SFTP off, so plain scp fails there; `scp -O`
# uses the older transfer that works.
cat <<NEXT

Next steps:

1. On THIS computer, copy the key to your server:
     scp -O "${KEYFILE}" ${SERVER}:${REMOTE_PATH}

2. On the SERVER (logged in as ${LOGIN}), keep a copy of the current key,
   put the new one in place and restart i2pd:
     sudo test -f /var/lib/i2pd/morphit-web.dat && sudo cp -a /var/lib/i2pd/morphit-web.dat "/root/morphit-web.dat.old-\$(date +%s)"
     sudo install -o i2pd -g i2pd -m 600 ${HOME_THERE}/morphit-web.dat /var/lib/i2pd/morphit-web.dat
     sudo shred -u ${HOME_THERE}/morphit-web.dat
     sudo systemctl restart i2pd

   The [morphit-web] tunnel (port = 8090) in /etc/i2pd/tunnels.conf already
   uses that key file. To see it, on the SERVER:
     grep -A6 '\[morphit-web\]' /etc/i2pd/tunnels.conf

3. On the SERVER, save the address for your footer and registration (it also
   checks that i2pd serves it):
     sudo morphit-ops alt-address      (I2P b32 -> paste ${ADDRESS})
NEXT
if [ "${HOME_THERE}" = "~" ]; then
	echo
	echo "(~ is your home folder on the server — where the scp line above puts the file.)"
fi
case "${SERVER}" in
	*YOUR-SERVER*)
		echo
		echo "(Put your ssh login and your server's address in place of YOUR-USER@YOUR-SERVER.)"
		;;
esac
