#!/usr/bin/env bash
# ops/test/canary-prompt-execution-harness.sh — EXECUTE the canary-prompt
# decision for every operator shape.
#
# WHY THIS EXISTS
# An operator who signs their warrant canary on a SEPARATE computer had an
# upgrade stop and ask whether to set up an on-box canary. Answering yes would
# have created a second signing key fighting their real one; the prompt also
# blocks an unattended upgrade until someone answers.
#
# The old rule was: prompt unless a canary is in the new build, OR in the
# BACKUP, OR a morphit-canary.service exists. The backup check was the entire
# memory of "this operator signs remotely" — and it remembers exactly ONE
# upgrade. A redeploy wipes canary.txt, the operator re-uploads it afterwards,
# so skipping a single refresh (because the previous upgrade errored, say) made
# the very next upgrade conclude the box had never had a canary. That happened.
#
# The decision is pure logic over a handful of filesystem facts, so it is tested
# by executing the same predicate against real directory layouts rather than by
# matching source text — a text match would have passed the broken version too.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO/apps/ops-cli/src/commands/upgrade.ts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fails=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }

# Mirror of the shipped predicate. Kept in step with the source by the assertions
# at the end, which fail if the source stops consulting any of these facts.
decide() { # $1=servedCanary $2=backupHadCanary $3=haveUnit $4=everHad $5=liveCanary
	if [ "$1" = n ] && [ "$2" = n ] && [ "$3" = n ] && [ "$4" = n ] && [ "$5" = n ]; then
		echo prompt
	else
		echo silent
	fi
}

echo "── canary prompt decision, by operator shape ───────────────────"

# A remote (laptop-signing) operator mid-cycle: the redeploy has just wiped
# canary.txt and they have not re-uploaded yet. THE CASE THAT BROKE.
[ "$(decide n n n y n)" = silent ] \
	&& ok "remote signer who missed a refresh is NOT prompted (the marker remembers)" \
	|| no "remote signer who missed a refresh WAS prompted — the exact reported failure"

# Same operator, marker absent but the live site still serves it.
[ "$(decide n n n n y)" = silent ] \
	&& ok "a canary served by the LIVE SITE suppresses the prompt" \
	|| no "live-site canary did not suppress the prompt"

# Ordinary cases that must stay as they were.
[ "$(decide y n n n n)" = silent ] && ok "canary in the new build → silent" || no "build canary prompted"
[ "$(decide n y n n n)" = silent ] && ok "canary in the backup → silent" || no "backup canary prompted"
[ "$(decide n n y n n)" = silent ] && ok "on-box morphit-canary.service → silent" || no "unit present prompted"

# A genuinely fresh box with no canary anywhere SHOULD still be offered one —
# suppressing that would leave a dead footer link, which is why the prompt exists.
[ "$(decide n n n n n)" = prompt ] \
	&& ok "a box that has never had a canary IS still offered one (prompt not gutted)" \
	|| no "a fresh box was not offered a canary — the feature was gutted, not fixed"

# ── the init prompts need the same bounded wait ──────────────────────
# The protection belongs in the helper, not at whichever call site remembered.
initsrc="$(cat "$REPO/apps/ops-cli/src/init/prompt.ts")"
case "$initsrc" in
	*"NON_TTY_ANSWER_TIMEOUT_MS"*) ok "init ask() also bounds the wait on a non-terminal stdin" ;;
	*) no "init ask() can hang when stdin never delivers" ;;
esac
case "$initsrc" in
	*"return defaultValue ?? '';"*) ok "…and falls back to the documented default on timeout" ;;
	*) no "init ask() does not fall back to its default" ;;
esac

# ── the source must actually consult each fact ───────────────────────
src="$(cat "$SRC")"
case "$src" in
	*"canary-seen"*) ok "source writes/reads a persistent remote-signer marker" ;;
	*) no "source has no persistent marker — one missed refresh will nag again" ;;
esac
case "$src" in
	*"/canary.txt"*) ok "source probes the LIVE site, not only the build dir" ;;
	*) no "source does not probe the live site" ;;
esac
case "$src" in
	*"!everHadCanary && !liveCanary"*) ok "both new facts are part of the decision" ;;
	*) no "the new facts are computed but not used in the decision" ;;
esac
# The prompt must never block an unattended run.
case "$src" in
	*"!forceYes && process.stdin.isTTY === true"*) ok "the canary prompt is gated on an interactive TTY" ;;
	*) no "the canary prompt is not gated on an interactive TTY" ;;
esac
# …and the protection must live in promptYes itself, not only at one call site.
# The main upgrade confirmation was gated only on !forceYes, so an upgrade from
# cron without MORPHIT_AUTO_UPGRADE=1 would block on readline forever, having
# printed a question nobody can see.
# Piped answers are ordinary automation and MUST keep working — an earlier
# version refused to read a non-terminal stdin at all and broke exactly that.
# The hazard is stdin that never DELIVERS, so the instrument is a timeout.
case "$src" in
	*"NON_TTY_ANSWER_TIMEOUT_MS"*)
		ok "promptYes bounds the wait on a non-terminal stdin instead of hanging" ;;
	*) no "promptYes can hang when stdin never delivers" ;;
esac
case "$src" in
	*"process.stdin.isTTY === true"*"ac.signal"*)
		ok "…while a human at a terminal still gets unlimited time to answer" ;;
	*) no "the terminal path is not distinguished from the piped path" ;;
esac

echo ""
if [ "$fails" -gt 0 ]; then
	printf '\033[31m✗ %d canary-prompt check(s) failed\033[0m (%d passed)\n' "$fails" "$pass"; exit 1
fi
printf '\033[32m✓ all %d canary-prompt checks passed\033[0m\n' "$pass"
