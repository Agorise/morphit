#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-onion.sh — Tor v3 hidden-service vanity address generator
#
# Runs ONLY on operator hardware. The resulting private key file must be
# hand-delivered to the VPS over an authenticated channel (SSH, never email).
# Never commit the output; the repo's .gitignore excludes hidden-services/.
#
# Usage:  bash generate-onion.sh <prefix> [ssh-target-of-your-server]
# Example: bash generate-onion.sh morph alice@morphit.example
#
# Each run makes a NEW folder (hidden-services/tor-<prefix>, then -2, -3 …),
# so an earlier key is never mixed up with the new one.
#
# `sudo morphit-ops alt-address` (on the server) prints the command to copy
# this script to your computer and run it; the steps it prints at the end
# install the key into the hidden service the server ALREADY runs.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PREFIX="${1:-morphit}"
SERVER="${2:-YOUR-USER@YOUR-SERVER}"

# Where the copies land on the server: root's home is /root; any other login's
# is its own home folder ("~" there — scp with no path puts files in it).
case "${SERVER}" in
	root@*) REMOTE_DEST="${SERVER}:/root/"; HOME_THERE="/root" ;;
	*) REMOTE_DEST="${SERVER}:"; HOME_THERE="~" ;;
esac

# The login those commands run under on the server.
case "${SERVER}" in
	*@*) LOGIN="${SERVER%%@*}" ;;
	*) LOGIN="the account you ssh in with" ;;
esac

# A fresh folder for this run: an earlier run's key stays where it was.
BASE_DIR="$(pwd)/hidden-services/tor-${PREFIX}"
OUT_DIR="${BASE_DIR}"
n=1
while [ -e "${OUT_DIR}" ]; do
	n=$((n + 1))
	OUT_DIR="${BASE_DIR}-${n}"
done

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

# The folder is new, so exactly one address is in it — the one just made.
FOUND="$(find "${OUT_DIR}" -mindepth 1 -maxdepth 1 -type d -name "${PREFIX}*.onion")"
COUNT="$(printf '%s' "${FOUND}" | grep -c . || true)"
if [ "${COUNT}" != "1" ]; then
	echo >&2 "Expected one new address in ${OUT_DIR}, found ${COUNT} — check the mkp224o output above."
	exit 1
fi
ONION_DIR="${FOUND}"
ADDRESS="$(basename "${ONION_DIR}")"

echo
echo "Done! Your new address is:"
echo "  ${ADDRESS}"
echo "It is saved in this folder:"
echo "  ${ONION_DIR}"
echo "Its secret key (keep private — never share or commit):"
echo "  ${ONION_DIR}/hs_ed25519_secret_key"

# The server's Tor already runs a hidden service in /var/lib/tor/morphit
# (set up by the installer, owned by the debian-tor user, mode 0700, with its
# torrc lines managed for you). Only its key files are replaced: Tor refuses a
# hidden-service directory it does not own, and a second HiddenServiceDir is
# not needed. Hardened servers turn SSH's SFTP off, so plain scp fails there;
# `scp -O` uses the older transfer that works.
cat <<NEXT

Next steps:

1. On THIS computer, copy the key to your server:
     cd "${ONION_DIR}"
     scp -O hs_ed25519_secret_key hs_ed25519_public_key hostname ${REMOTE_DEST}

2. On the SERVER (logged in as ${LOGIN}), keep a copy of the current key,
   put the new one in place and restart Tor:
     sudo cp -a /var/lib/tor/morphit "/root/morphit-onion-old-\$(date +%s)"
     sudo install -o debian-tor -g debian-tor -m 600 ${HOME_THERE}/hs_ed25519_secret_key ${HOME_THERE}/hs_ed25519_public_key /var/lib/tor/morphit/
     sudo install -o debian-tor -g debian-tor -m 644 ${HOME_THERE}/hostname /var/lib/tor/morphit/hostname
     sudo chown -R debian-tor:debian-tor /var/lib/tor/morphit
     sudo chmod 700 /var/lib/tor/morphit
     sudo shred -u ${HOME_THERE}/hs_ed25519_secret_key
     sudo rm -f ${HOME_THERE}/hs_ed25519_public_key ${HOME_THERE}/hostname
     sudo systemctl restart tor

3. On the SERVER, check that Tor serves it (this prints ${ADDRESS}):
     sudo cat /var/lib/tor/morphit/hostname

4. On the SERVER, save it for your footer and registration:
     sudo morphit-ops alt-address      (Tor -> paste ${ADDRESS})
NEXT
if [ "${HOME_THERE}" = "~" ]; then
	echo
	echo "(~ is your home folder on the server — where the scp line above puts the files.)"
fi
case "${SERVER}" in
	*YOUR-SERVER*)
		echo
		echo "(Put your ssh login and your server's address in place of YOUR-USER@YOUR-SERVER.)"
		;;
esac
