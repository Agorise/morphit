#!/usr/bin/env bash
# Morphit — deploy the MCP server into its OWN isolated directory as a
# self-contained tree, so morphit-mcp.service can run it as a
# low-privilege user that CANNOT read the main install's secrets.
#
# WHY ISOLATED (and not run from the monorepo at /opt/morphit):
# the relay + indexer run from /opt/morphit, where the main install's
# secrets are readable (DB password in the env files, the relay key
# envelope).  The MCP server is the most exposed surface — AI agents
# reach it from anywhere — so morphit-mcp.service runs it as its own
# user (morphit-mcp) from its own directory with ProtectSystem=strict
# + ReadOnlyPaths locked to just /etc/morphit + this dir.  It never
# gets read access to /opt/morphit.  The cost of that isolation is
# that this dir needs its OWN copy of the source + node_modules.
#
# THE TWO @morphit/* WORKSPACE DEPS (asset-registry, net-defense) are
# pure, zero-runtime-dependency TypeScript-source packages
# (`main` = src/index.ts).  We VENDOR them under ./vendor and point
# the deployed package.json at them with `file:` deps, so a standalone
# `npm install` in this dir resolves everything (tsx + the MCP SDK +
# zod + the two vendored packages) with no reach back into the
# monorepo.  tsx loads the TS source directly (the unit runs
# `npm start` = `tsx src/main.ts`).
#
# IDEMPOTENT-ISH: safe to re-run — it rebuilds the deployed tree from
# the repo each time (used by the Ansible role on every converge and
# by `morphit-ops upgrade`).  Installing the systemd unit + enabling
# the service is the CALLER's job (the Ansible role, or the operator);
# this script only lays down the directory contents.
#
# Usage:
#   sudo bash ops/scripts/deploy-mcp.sh [REPO_DIR] [DEST_DIR] [SERVICE_USER]
# Defaults:
#   REPO_DIR     = two levels up from this script (the repo root)
#   DEST_DIR     = /opt/morphit-mcp
#   SERVICE_USER = morphit-mcp   (chown is skipped if the user doesn't exist)
#
# Requirements: node + npm on PATH, network access to the npm registry.

set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
DEST="${2:-/opt/morphit-mcp}"
SVC_USER="${3:-morphit-mcp}"

SRC="$REPO_DIR/apps/mcp-server"
[ -d "$SRC" ] || {
	echo "ERROR: $SRC not found — is REPO_DIR ($REPO_DIR) the morphit repo root?" >&2
	exit 1
}

# v1.8.12 (Ken) — step off a possibly-DELETED working directory.
#
# `morphit-ops upgrade` swaps /opt/morphit for a fresh tree, so the shell that
# invoked it — typically sitting IN /opt/morphit — is left on an inode that no
# longer exists. Every subshell then inherits that dead cwd and bash prints
#   shell-init: error retrieving current directory: getcwd: ...
#   job-working-directory: error retrieving current directory: ...
# once per subshell. Ken's v1.8.12 upgrade emitted ~20 of them around this
# script. Harmless — the deploy completed correctly — but noise that looks like
# breakage teaches operators to skim past the real warnings beside it.
#
# Placed AFTER the path resolution above, deliberately: REPO_DIR falls back to
# resolving $0, which is RELATIVE when someone runs `bash ops/scripts/
# deploy-mcp.sh` by hand. Changing directory before that would break the
# fallback. Everything below this line uses absolute paths.
cd / 2>/dev/null || true

echo "morphit-mcp deploy: $SRC  ->  $DEST  (service user: $SVC_USER)"

# ── 1. Lay down the MCP source ─────────────────────────────────────
# Replace the managed contents wholesale (so a re-run reflects repo
# state) but leave the dir itself alone in case it has mountpoint /
# ownership we want to keep.
mkdir -p "$DEST"
rm -rf "$DEST/src" "$DEST/vendor" "$DEST/node_modules" \
	"$DEST/package.json" "$DEST/package-lock.json" \
	"$DEST/tsconfig.json" "$DEST/tsconfig.build.json"

cp -R "$SRC/src" "$DEST/src"
cp "$SRC/package.json" "$DEST/package.json"
[ -f "$SRC/tsconfig.json" ] && cp "$SRC/tsconfig.json" "$DEST/tsconfig.json"
[ -f "$SRC/tsconfig.build.json" ] && cp "$SRC/tsconfig.build.json" "$DEST/tsconfig.build.json"
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$DEST/README.md"
[ -f "$SRC/LICENSE" ] && cp "$SRC/LICENSE" "$DEST/LICENSE"

# ── 2. Vendor the zero-dep workspace packages ──────────────────────
mkdir -p "$DEST/vendor"
for pkg in asset-registry net-defense; do
	src_pkg="$REPO_DIR/packages/$pkg"
	[ -d "$src_pkg" ] || {
		echo "ERROR: workspace package $src_pkg not found" >&2
		exit 1
	}
	rm -rf "$DEST/vendor/$pkg"
	mkdir -p "$DEST/vendor/$pkg"
	cp -R "$src_pkg/src" "$DEST/vendor/$pkg/src"
	cp "$src_pkg/package.json" "$DEST/vendor/$pkg/package.json"
done

# ── 3. Rewrite the deployed package.json ───────────────────────────
# - point the two @morphit/* deps at the vendored copies (file:)
# - keep tsx as a runtime dep (the source package.json now declares
#   tsx in `dependencies` — the unit runs `tsx src/main.ts`, so
#   `npm install --omit=dev` must keep it; this read is kept
#   robust to tsx living in either section)
# - drop the remaining devDependencies for a lean runtime tree
node -e '
const fs = require("fs");
const p = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies["@morphit/asset-registry"] = "file:./vendor/asset-registry";
pkg.dependencies["@morphit/net-defense"] = "file:./vendor/net-defense";
const tsxVer = (pkg.dependencies && pkg.dependencies.tsx) || (pkg.devDependencies && pkg.devDependencies.tsx) || "^4.19.1";
pkg.dependencies.tsx = tsxVer;
delete pkg.devDependencies;
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
' "$DEST/package.json"

# ── 4. Install the runtime dependency tree ─────────────────────────
# A self-contained offline bundle ships an npm cache at <repo>/vendor/npm-cache
# (populated by the bundle's `npm ci`).  When it exists, install from it with
# --offline so nothing reaches the registry — the two @morphit/* deps are already
# file: (vendored above), and tsx (+esbuild) resolve from the cache.  Otherwise a
# normal online install.
if [ -d "$REPO_DIR/vendor/npm-cache" ]; then
	( cd "$DEST" && npm install --omit=dev --no-audit --no-fund --offline --cache "$REPO_DIR/vendor/npm-cache" )
else
	( cd "$DEST" && npm install --omit=dev --no-audit --no-fund )
fi

# ── 5. Lock down ownership + perms (the isolation boundary) ────────
if id "$SVC_USER" >/dev/null 2>&1; then
	chown -R "$SVC_USER":"$SVC_USER" "$DEST"
else
	echo "NOTE: service user '$SVC_USER' does not exist yet — skipping chown."
	echo "      Create it and re-run, or let the Ansible role own this step."
fi
chmod 0750 "$DEST"

echo "✓ morphit-mcp deployed to $DEST"
