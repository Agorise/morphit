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
# WHERE ITS DEPENDENCIES COME FROM: the install's own node_modules, which
# `npm ci` laid down from the repository's package-lock.json. This script
# copies exactly the packages the MCP needs at run time (its production
# dependencies and theirs, resolved through that lockfile the way Node would)
# and checks every copied version against the lockfile. Nothing is resolved
# from a registry and no install script runs, so the deployed tree is the
# audited one, byte for byte, and a hidden-only node deploys it with no
# network at all.
#
# THE TWO @morphit/* WORKSPACE DEPS (asset-registry, net-defense) are pure,
# zero-runtime-dependency TypeScript-source packages (`main` = src/index.ts).
# Their src + package.json are copied into node_modules/@morphit/, and tsx
# loads the TS source directly (the unit runs `npm start` = `tsx src/main.ts`).
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
# Requirements: node on PATH, and REPO_DIR's dependencies installed from its lockfile.

set -euo pipefail

REPO_DIR="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
DEST="${2:-/opt/morphit-mcp}"
SVC_USER="${3:-morphit-mcp}"

SRC="$REPO_DIR/apps/mcp-server"
[ -d "$SRC" ] || {
	echo "ERROR: $SRC not found — is REPO_DIR ($REPO_DIR) the morphit repo root?" >&2
	exit 1
}

# Step off a possibly-DELETED working directory.
#
# `morphit-ops upgrade` swaps /opt/morphit for a fresh tree, so the shell that
# invoked it — typically sitting IN /opt/morphit — is left on an inode that no
# longer exists. Every subshell then inherits that dead cwd and bash prints
#   shell-init: error retrieving current directory: getcwd: ...
#   job-working-directory: error retrieving current directory: ...
# once per subshell; an upgrade printed about 20 of them around this
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
	"$DEST/package.json" "$DEST/package-lock.json" "$DEST/.npmrc" \
	"$DEST/tsconfig.json" "$DEST/tsconfig.build.json"

cp -R "$SRC/src" "$DEST/src"
cp "$SRC/package.json" "$DEST/package.json"
[ -f "$SRC/tsconfig.json" ] && cp "$SRC/tsconfig.json" "$DEST/tsconfig.json"
[ -f "$SRC/tsconfig.build.json" ] && cp "$SRC/tsconfig.build.json" "$DEST/tsconfig.build.json"
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$DEST/README.md"
[ -f "$SRC/LICENSE" ] && cp "$SRC/LICENSE" "$DEST/LICENSE"

# ── 2. The runtime dependency closure, from the locked install ─────
[ -f "$REPO_DIR/package-lock.json" ] && [ -d "$REPO_DIR/node_modules" ] || {
	echo "ERROR: $REPO_DIR has no package-lock.json + node_modules — its dependencies are not installed" >&2
	exit 1
}
mkdir -p "$DEST/node_modules/.bin" "$DEST/node_modules/@morphit"
node --input-type=module - "$REPO_DIR" "$DEST" <<'JS'
import { readFileSync, cpSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
const [repo, dest] = process.argv.slice(2);
const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')).packages;
const ws = lock['apps/mcp-server'];
if (!ws) throw new Error('package-lock.json has no apps/mcp-server workspace');
if (Object.keys(lock).some((k) => k.startsWith('apps/mcp-server/node_modules/'))) {
	throw new Error('apps/mcp-server has its own nested node_modules in the lockfile; this deploy only copies the root tree');
}
// Node's lookup: <from>/node_modules/<name>, then each ancestor's node_modules.
const resolveDep = (from, name) => {
	const segs = from === '' ? [] : from.split('/');
	for (let i = segs.length; i >= 0; i--) {
		const prefix = segs.slice(0, i).join('/');
		const last = segs[i - 1];
		if (last === 'node_modules' || (last?.startsWith('@') && segs[i - 2] === 'node_modules')) continue;
		const cand = prefix === '' ? `node_modules/${name}` : `${prefix}/node_modules/${name}`;
		if (lock[cand]) return cand;
	}
	return null;
};
const need = new Set();
const queue = Object.keys(ws.dependencies ?? {})
	.filter((n) => !n.startsWith('@morphit/'))
	.map((n) => ['apps/mcp-server', n, false]);
while (queue.length > 0) {
	const [from, name, optional] = queue.shift();
	const at = resolveDep(from, name);
	if (at === null) {
		if (optional) continue;
		throw new Error(`${name} (needed by ${from}) is not in the lockfile`);
	}
	if (need.has(at)) continue;
	const e = lock[at];
	if (e.link) throw new Error(`${at} is a workspace link; only @morphit/* links are expected`);
	if (e.dev) throw new Error(`${at} is marked dev-only in the lockfile but the MCP needs it at run time`);
	if (!existsSync(join(repo, at, 'package.json'))) {
		if (e.optional) continue; // an optional package not built for this machine
		throw new Error(`${at} is not installed in ${repo}`);
	}
	need.add(at);
	for (const [deps, opt] of [[e.dependencies, false], [e.optionalDependencies, true], [e.peerDependencies, true]]) {
		for (const n of Object.keys(deps ?? {})) queue.push([at, n, opt || (e.peerDependenciesMeta?.[n]?.optional ?? false)]);
	}
}
// Copy top-level packages whole (nested node_modules come along), check
// every version against the lockfile, and link the binaries.
let copied = 0;
for (const at of [...need].sort()) {
	if (at.split('/node_modules/').length > 1) continue; // nested: inside its parent's copy
	cpSync(join(repo, at), join(dest, at), { recursive: true, verbatimSymlinks: true });
	copied++;
}
for (const at of need) {
	const got = JSON.parse(readFileSync(join(dest, at, 'package.json'), 'utf8')).version;
	if (got !== lock[at].version) throw new Error(`${at}: deployed ${got}, lockfile says ${lock[at].version}`);
	const top = at.split('/node_modules/').length === 1;
	const bins = typeof lock[at].bin === 'string' ? { [at.replace(/^.*node_modules\//, '')]: lock[at].bin } : (lock[at].bin ?? {});
	if (!top) continue;
	for (const [b, rel] of Object.entries(bins)) {
		const link = join(dest, 'node_modules', '.bin', b);
		if (existsSync(link)) continue;
		symlinkSync(relative(dirname(link), join(dest, at, rel)), link);
		chmodSync(join(dest, at, rel), 0o755);
	}
}
console.log(`  ${need.size} runtime packages from the locked install (${copied} top-level), versions checked against package-lock.json`);
JS

# ── 3. The two @morphit/* workspace packages (pure TS source) ──────
for pkg in asset-registry net-defense; do
	src_pkg="$REPO_DIR/packages/$pkg"
	[ -d "$src_pkg" ] || {
		echo "ERROR: workspace package $src_pkg not found" >&2
		exit 1
	}
	mkdir -p "$DEST/node_modules/@morphit/$pkg"
	cp -R "$src_pkg/src" "$DEST/node_modules/@morphit/$pkg/src"
	cp "$src_pkg/package.json" "$DEST/node_modules/@morphit/$pkg/package.json"
done

# ── 4. The deployed package.json + npm settings ────────────────────
# Only `npm start` reads package.json here (the unit's ExecStart). Drop the
# devDependencies; the npmrc keeps that npm offline and quiet: it has nothing
# to fetch, so it must never try.
node -e '
const fs = require("fs");
const p = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
delete pkg.devDependencies;
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
' "$DEST/package.json"
printf '%s\n' 'offline=true' 'update-notifier=false' 'fund=false' 'audit=false' > "$DEST/.npmrc"

# The deployed tree must start on its own: tsx from its node_modules/.bin.
"$DEST/node_modules/.bin/tsx" --version >/dev/null || {
	echo "ERROR: the deployed tree has no working tsx" >&2
	exit 1
}

# ── 5. Lock down ownership + perms (the isolation boundary) ────────
if id "$SVC_USER" >/dev/null 2>&1; then
	chown -R "$SVC_USER":"$SVC_USER" "$DEST"
else
	echo "NOTE: service user '$SVC_USER' does not exist yet — skipping chown."
	echo "      Create it and re-run, or let the Ansible role own this step."
fi
chmod 0750 "$DEST"

echo "✓ morphit-mcp deployed to $DEST"
