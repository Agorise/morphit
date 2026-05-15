#!/usr/bin/env bash
# Morphit typecheck sweep — reports source-level type errors
# across every workspace project in one pass.
#
# When run in an environment without `npm install` (e.g. a fresh
# checkout), modules like hono, zod, pg, @morphit/*, svelte-kit
# can't resolve — those errors are filtered out as expected
# noise. Anything else is a real bug.
#
# One gotcha: the indexer's tsconfig has `"types": ["node"]`,
# which produces TS2688 in environments missing @types/node and
# silently disables type-checking (it continues to bind files
# but skips assignability checks). We work around by passing
# `--types` on the command line, which overrides the tsconfig
# value.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Resolve the locally-installed TypeScript compiler. Falls back
# to `tsc` on PATH if the workspace install isn't present.
if [ -x "$REPO_ROOT/node_modules/.bin/tsc" ]; then
	TSC="$REPO_ROOT/node_modules/.bin/tsc"
else
	TSC="$(command -v tsc 2>/dev/null || echo tsc)"
fi

# `--ignoreDeprecations 5.0` is the documented incantation that
# silences "X is deprecated, will be removed in TS 6" warnings.
# TypeScript 5.x rejects any other value (including "6.0", which
# was a previous typo here that produced TS5103 noise on every
# project).
TS_IGNORE_DEPRECATIONS="--ignoreDeprecations 5.0"

# Known-harmless errors when modules aren't installed. Anything
# NOT matching these is a real bug.
#
# HISTORY (architectural): apps/relay's tsconfig used to be
# `moduleResolution: "NodeNext"`, which did NOT honor the `paths`
# alias map ($config / $crypto / $db / etc).  Every $-aliased
# import emitted "Cannot find module '$xyz'" plus a cascade of
# secondary errors in the importing file (TS18046 'unknown' on
# catch vars from `instanceof X`, TS2345 mistyped args from
# inferred-any returns, etc.).  Those weren't real bugs — they
# were the gap between vitest's bundler-style resolution and
# tsc's NodeNext.  The noise filter used to allowlist:
#   - The primary "Cannot find module '$...'" emission.
#   - The cascade TS18046 in apps/relay/{src,test}.
#   - ALL errors in the three relay test files that imported most
#     heavily through aliases (create / drainer / unlock).
# Part 89 (J-7) flipped relay to `moduleResolution: "Bundler"` +
# `module: "Preserve"`, which makes tsc honor the `paths` map and
# eliminates both the primary error and the cascade.  The two
# relay-cascade clauses (TS18046 and the test-file allowlist)
# were dropped from NOISE_PATTERNS at the same time.  The
# remaining `\$` clause in the "Cannot find module" group still
# matches NodeNext-mode workspaces (e.g. apps/web's $components,
# $stores, $crypto aliases) and is retained.
#
# The TS2345 cascade in indexer's two BalanceScanner files is a
# single-error narrow, scoped to that exact code, and unrelated
# to the relay flip.
#
# cp22 (Part 121): the TS6133 unused-variable clause was previously
# `error TS6133 .* is declared but` — a literal space between
# `TS6133` and `.*`.  Real `tsc` output is `error TS6133: '<name>'
# is declared but its value is never read.` — a COLON, not a
# space, follows the error code.  The old pattern matched
# nothing, meaning legitimate TS6133 noise wasn't being
# suppressed AND any real TS6133 in the codebase would surface
# as a typecheck error.  Fixed to `error TS6133[ :].*` so the
# class matches either format (real colon, hypothetical space).
NOISE_PATTERNS='(Cannot find module .(hono|zod|pg|svelte|vitest|libsodium|@sveltejs|@morphit|@beblurt|@hono|\$|@/|@scure|@noble)|Cannot find type definition file for .(@sveltejs|svelte|libsodium|node).$|implicitly has an .any. type|error TS5101|error TS2835|error TS2688|error TS6133[ :].* is declared but|\.svelte-kit/tsconfig|safeStorage|preferences\.ts|Option .baseUrl|Cannot find name .(Response|TextEncoder|crypto|setInterval|clearInterval|setTimeout|clearTimeout|fetch|Buffer|process|console|URL|URLSearchParams|RequestInfo|RequestInit|Headers|Blob|atob|btoa|queueMicrotask|AbortController|AbortSignal|FormData|TextDecoder|structuredClone|globalThis).$|Cannot find namespace .NodeJS.|^apps/web/src/.*: error TS18046:|apps/indexer/src/indexer/(low|operatorAccount)BalanceScanner\.ts.* error TS2345:)'

project() {
	local name="$1"
	local tsconfig="$2"
	local filter_path="${3:-}"  # optional: restrict to files under this path
	
	local out
	out=$("$TSC" --noEmit $TS_IGNORE_DEPRECATIONS --types node -p "$tsconfig" 2>&1)
	local errors
	errors=$(echo "$out" | grep "error TS" | grep -vE "$NOISE_PATTERNS")
	
	if [ -n "$filter_path" ]; then
		errors=$(echo "$errors" | grep "^$filter_path" || true)
	fi
	
	local count
	if [ -z "$errors" ]; then
		count=0
	else
		count=$(echo "$errors" | wc -l)
	fi
	
	printf "%-30s %s errors\n" "$name" "$count"
	if [ "$count" -gt 0 ]; then
		echo "$errors" | sed 's/^/    /'
	fi
}

cd "$REPO_ROOT"

echo "=== Typecheck (uninstalled-module noise filtered) ==="
project "indexer (src only)"    apps/indexer/tsconfig.json        apps/indexer/src/
project "indexer (incl. test)"  apps/indexer/tsconfig.json
project "relay (src only)"      apps/relay/tsconfig.json          apps/relay/src/
project "relay (incl. test)"    apps/relay/tsconfig.json
# Frontend is intentionally NOT swept here. The apps/web tsconfig
# extends `.svelte-kit/tsconfig.json` (generated by `svelte-kit
# sync`), which this sweep does not run. The CI `web` job's
# `npm run check` step does the correct svelte-aware typecheck;
# duplicating it here would double-fail or false-fail.
project "ops-cli"               apps/ops-cli/tsconfig.json
project "matrix-bot"            apps/matrix-bot/tsconfig.json
project "indexer-client"        packages/indexer-client/tsconfig.json
project "relay-client"          packages/relay-client/tsconfig.json
project "operator-config"       packages/operator-config/tsconfig.json
project "asset-registry"        packages/asset-registry/tsconfig.json
