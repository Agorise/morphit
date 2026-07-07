#!/usr/bin/env bash
#
# validate-fresh-install.sh — exercise the Morphit install arc on a
# THROWAWAY Ubuntu 24.04 VM and report what works vs what breaks.
#
# PURPOSE
#   We cannot certify "fresh box -> live node, no hiccups" from a dev
#   sandbox — it needs a real machine. Run this on a disposable VM
#   (a $5 droplet you delete after, or a local multipass/lxd/VM) to
#   find the real-world gaps before an operator does. It is
#   deliberately NOISY and NON-DESTRUCTIVE-ish: it installs packages
#   and writes under /opt, so ONLY run it on a VM you will throw away.
#
# WHAT IT CHECKS, in order:
#   0. Confirms it's on Ubuntu 24.04 and you really meant to run it.
#   1. Prerequisites the installer expects (node>=22, npm, psql, git).
#   2. That `npx morphit-ops install` exists and its preflight runs.
#   3. The systemd unit installation path (the cp192 gap: units must
#      be copied to /etc/systemd/system and enabled — verifies the
#      shipped units load and the service names match the docs).
#   4. That `npx morphit-ops upgrade` can discover the latest release
#      (the cp191 pre-release-discovery fix, against the live API).
#
# It does NOT fully configure a node (that needs Postgres creds, a
# Blurt account, keys). It validates the SCAFFOLDING and SEQUENCING —
# the parts that have been breaking — and prints a PASS/FAIL summary.
#
# USAGE
#   git clone https://git.agorise.net/agorise/morphit.git
#   cd morphit
#   sudo bash scripts/validate-fresh-install.sh
#
set -uo pipefail

PASS=0
FAIL=0
WARN=0
note()  { printf '  \033[36m·\033[0m %s\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()   { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; WARN=$((WARN+1)); }
hdr()   { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 0. Safety + environment ──────────────────────────────────────
hdr "0. Environment & safety"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  if [ "${ID:-}" = "ubuntu" ] && [ "${VERSION_ID:-}" = "24.04" ]; then
    ok "Ubuntu 24.04 detected"
  else
    warn "Not Ubuntu 24.04 (found ${PRETTY_NAME:-unknown}) — results may differ from the supported target"
  fi
else
  warn "Cannot read /etc/os-release — proceeding, but this may not be a supported OS"
fi

if [ "${MORPHIT_VALIDATE_YES:-}" != "1" ]; then
  printf '\n\033[33mThis installs packages and writes under /opt. Run ONLY on a throwaway VM.\033[0m\n'
  printf 'Re-run with MORPHIT_VALIDATE_YES=1 to confirm:\n'
  printf '    sudo MORPHIT_VALIDATE_YES=1 bash %s\n\n' "${BASH_SOURCE[0]}"
  exit 2
fi

# ── 1. Prerequisites ─────────────────────────────────────────────
hdr "1. Prerequisites"
check_cmd() {
  local name="$1" cmd="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$name present ($("$cmd" --version 2>&1 | head -1))"
  else
    bad "$name MISSING (install it: see docs/RUN-A-MORPHIT-NODE.md, or run the Ansible playbook in ops/ansible/)"
  fi
}
check_cmd "Node.js" node
check_cmd "npm" npm
check_cmd "PostgreSQL client" psql
check_cmd "git" git

# Node major version >= 22
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 22 ]; then ok "Node major >= 22 (${NODE_MAJOR})"; else bad "Node major < 22 (${NODE_MAJOR}); install Node 22 LTS"; fi
fi

# ── 2. morphit-ops install exists + preflight runs ───────────────
hdr "2. morphit-ops install (the cp192 guided installer)"
cd "$REPO_DIR" || { bad "cannot cd to repo dir $REPO_DIR"; }
if [ ! -d node_modules ]; then
  note "node_modules absent — running npm ci (one-time, needed for the CLI)"
  npm ci --no-audit --no-fund >/tmp/morphit-npmci.log 2>&1 \
    && ok "npm ci succeeded" \
    || bad "npm ci FAILED (see /tmp/morphit-npmci.log)"
fi
# Does the install subcommand exist in THIS tree's CLI? (it won't in
# pre-cp192 releases — that's the sysadmin's "Unknown subcommand".)
if npx --no-install morphit-ops --help 2>&1 | grep -q "install"; then
  ok "morphit-ops has an 'install' subcommand"
  # Run its preflight non-interactively (answer 'no' to proceeding).
  if printf 'n\n' | npx --no-install morphit-ops install 2>&1 | grep -q "checking prerequisites"; then
    ok "morphit-ops install preflight runs"
  else
    bad "morphit-ops install preflight did not run as expected"
  fi
else
  bad "morphit-ops has NO 'install' subcommand — this tree predates cp192 (release built from cp192+ needed)"
fi

# ── 3. systemd unit installation (the gap the sysadmin hit) ──────
hdr "3. systemd units"
UNIT_SRC="$REPO_DIR/ops/systemd"
for unit in morphit-indexer.service morphit-relay.service; do
  if [ -f "$UNIT_SRC/$unit" ]; then
    ok "shipped unit present: ops/systemd/$unit"
    # Verify systemd can parse it (analyze without enabling).
    if systemd-analyze verify "$UNIT_SRC/$unit" >/tmp/morphit-unit-$unit.log 2>&1; then
      ok "$unit parses cleanly (systemd-analyze verify)"
    else
      warn "$unit has analyze warnings (often just EnvironmentFile/WorkingDirectory not present yet on a fresh box) — see /tmp/morphit-unit-$unit.log"
    fi
  else
    bad "shipped unit MISSING: ops/systemd/$unit"
  fi
  # Is it actually installed on this box?
  if systemctl list-unit-files 2>/dev/null | grep -q "^$unit"; then
    ok "$unit is INSTALLED on this host"
  else
    warn "$unit is NOT installed here yet — install with: sudo cp ops/systemd/$unit /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable $unit"
  fi
done
note "NOTE: the relay unit expects WorkingDirectory=/opt/morphit-relay and"
note "EnvironmentFile=/etc/morphit/relay.env — confirm these match your actual"
note "deployment layout (this is a known doc/unit seam flagged in cp192)."

# ── 4. release discovery (cp191 fix) ─────────────────────────────
hdr "4. Release discovery (morphit-ops upgrade --check-only)"
if npx --no-install morphit-ops upgrade --check-only 2>&1 | tee /tmp/morphit-upgrade-check.log | grep -qiE "latest version|already on|new release"; then
  ok "upgrade --check-only reached the release API and reported a version"
  note "$(grep -iE 'current version|latest version' /tmp/morphit-upgrade-check.log | head -2)"
else
  warn "upgrade --check-only did not report a version (network? no release published? or this tree has no release-info.json) — see /tmp/morphit-upgrade-check.log"
fi

# ── Summary ──────────────────────────────────────────────────────
hdr "Summary"
printf '  PASS: %d   FAIL: %d   WARN: %d\n\n' "$PASS" "$FAIL" "$WARN"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31mInstall arc has FAILURES above — fix before telling operators it is smooth.\033[0m\n'
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  printf '\033[33mNo hard failures, but warnings above are the real-world rough edges to address.\033[0m\n'
  exit 0
fi
printf '\033[32mFresh-install arc looks clean on this VM.\033[0m\n'
