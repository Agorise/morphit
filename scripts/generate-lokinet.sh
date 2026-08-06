#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-lokinet.sh — set up a Lokinet (.loki) address
#
# IMPORTANT: unlike Tor and I2P, Lokinet does NOT let you pick the letters.
# Lokinet makes the name for you and there is no vanity tool. This script
# just prints the short setup steps. Run it anywhere; it only echoes help.
#
# (A *readable* name like "yourname.loki" is possible, but it's a separate,
# paid thing called ONS — see the bottom.)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

cat <<'EOF'
Lokinet (.loki) — Lokinet picks your address; you can't choose the letters.

On the SERVER (where Lokinet runs):

  1. Open Lokinet's config:   sudo nano /var/lib/lokinet/lokinet.ini
     (path varies; it may be /etc/loki/lokinet.ini)

  2. Under the [network] section, add a line telling it where to keep
     your address key (this makes the address STAY THE SAME forever):
       keyfile=/var/lib/lokinet/morphit-snapp.private

  3. Restart Lokinet:   sudo systemctl restart lokinet
     The first start makes the key and prints your address — a long
     scramble ending in ".loki".

  4. To read it again later:
       sudo journalctl -u lokinet | grep -i '\.loki' | tail
     (or check the Lokinet console output)

  5. Run "morphit-ops" -> "Set up a Tor / Lokinet / I2P address" -> Lokinet,
     and paste that .loki address. That puts it in your site footer.

Want a SHORT, readable name like "morphit.loki"?
  That's "ONS" (Oxen Name Service). You buy it with OXEN coin in the Oxen
  wallet (it lasts 1–10 years), and point it at your .loki address above.
  It costs money and is totally optional — the long .loki works on its own.
EOF
