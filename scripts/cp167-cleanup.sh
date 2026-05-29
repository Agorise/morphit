#!/usr/bin/env bash
# cp167-cleanup.sh — structural deletions that accompany this tarball.
#
# WHY THIS EXISTS
#
# Tarball extraction (`tar -xzf …`) creates and overwrites files but
# never deletes them.  When cp166 removed the circuit-breaker
# abstraction (replaced by the rpc-pool's quorumCall primitive), the
# cp166 tarball couldn't communicate "delete these four files" via
# the tar itself.  Result: the operator extracts cp166 onto an
# existing tree, the obsolete files stick around, and the next CI
# run fails on stale tests that no longer match the migrated APIs.
#
# This script runs the required `rm -f` for every cp166 deletion so
# the post-extract tree matches what was tested locally.  Idempotent:
# safe to run when the files are already gone (rm -f exits 0).
#
# WHEN TO RUN
#
# Right after extracting cp167-FULL-STATE.tar.gz over an existing
# checkout, BEFORE `npm install` and BEFORE any CI step:
#
#   cd /path/to/morphit
#   tar -xzf morphit-audit-2026-05-XXX-cp167-FULL-STATE.tar.gz
#   bash scripts/cp167-cleanup.sh
#   npm install
#   bash scripts/run-smokes.sh
#
# A first-time install starting from `git clone` does NOT need this
# script — those files were never on disk to begin with.  This is
# strictly for "extract over a prior cp16N tree" upgrades.

set -euo pipefail

# Detect whether we're at the repo root by checking for known sentinels.
if [ ! -f package.json ] || [ ! -d apps/indexer ]; then
	echo "✗ cp167-cleanup.sh: run from the repo root (apps/, package.json expected)."
	exit 1
fi

# cp166: the rpc-pool quorumCall primitive replaced the circuit-breaker
# abstraction.  The breaker source + its three test files are obsolete.
TO_REMOVE=(
	"apps/indexer/test/indexer/fee/bitcoinExplorerVerifier.breaker.test.ts"
	"apps/indexer/test/indexer/fee/moneroProofVerifier.breaker.test.ts"
	"apps/indexer/test/indexer/fee/circuitBreaker.test.ts"
	"apps/indexer/src/indexer/fee/circuitBreaker.ts"
)

removed=0
already_gone=0
for f in "${TO_REMOVE[@]}"; do
	if [ -e "$f" ]; then
		rm -f "$f"
		echo "  ✓ removed $f"
		removed=$((removed + 1))
	else
		echo "  - already gone $f"
		already_gone=$((already_gone + 1))
	fi
done

echo ""
echo "cp167-cleanup.sh done — $removed removed, $already_gone already absent."
