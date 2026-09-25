#!/usr/bin/env bash
# ops/test/focus-scrim-guard-harness.sh — prove focus-opens-scrim-smoke.ts
# actually catches the bug it was written for, and each variant of it.
#
# WHY THIS EXISTS
# The rule here is that a test never seen to fail is not a test. This guard
# exists because three guards written for specific fixes passed while guarding
# nothing. Worse, the bug it targets was originally "confirmed clean" in two
# sibling components by an exact-string grep — and BOTH were wrong: one had the
# bug spread across several lines, and one had it behind a named function, where
# no pattern matching the handler attribute could ever have found it.
#
# So the guard does not match text; it EXECUTES each focus handler's real body
# in a recording sandbox and observes what state it sets. This harness proves
# that machinery works by putting each bug back, one at a time, and requiring
# the guard to fail. A mutation the guard survives is a hole in the guard.
#
# Hermetic: operates on a COPY of apps/web in a temp dir. The real tree is never
# modified, so an interrupted run cannot leave a mutation behind.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -x "$REPO/node_modules/.bin/tsx" ]; then
	TSX="$REPO/node_modules/.bin/tsx"
elif command -v tsx >/dev/null 2>&1; then
	TSX="$(command -v tsx)"
else
	echo "ERROR: tsx not found. Run 'npm install' from the repo root." >&2
	exit 2
fi

pass=0; fails=0
ok(){ printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m\xe2\x9c\x97\033[0m %s\n' "$1"; fails=$((fails+1)); }

# ── Build the hermetic copy ──────────────────────────────────────────
mkdir -p "$WORK/apps/web/scripts"
cp -r "$REPO/apps/web/src" "$WORK/apps/web/src"
cp "$REPO/apps/web/scripts/focus-opens-scrim-smoke.ts" "$WORK/apps/web/scripts/"
GUARD="$WORK/apps/web/scripts/focus-opens-scrim-smoke.ts"
COMP="$WORK/apps/web/src/lib/components"

# The guard imports only node builtins, so it needs no tsconfig or aliases.
#
# TSX_TSCONFIG_PATH must be cleared. When this harness is run from its battery
# wrapper, the outer `tsx --tsconfig tsconfig.smoke.json` exports that flag to
# every child as a RELATIVE path. This harness then runs the guard from a temp
# directory, where `tsconfig.smoke.json` does not exist, and tsx dies inside
# getExtendsChain before the guard runs at all — every run then reports a stack
# trace instead of a verdict. Cleared here rather than at the call site so
# nothing downstream has to remember. `verdict()` below additionally refuses to
# read a crash as a result, so this can never be mistaken for a passing guard.
run_guard(){ (cd "$WORK/apps/web" && unset TSX_TSCONFIG_PATH && timeout 120 "$TSX" "$GUARD" 2>&1); }

snapshot(){ cp "$1" "$1.orig"; }
restore(){ mv "$1.orig" "$1"; }

# Read the guard's verdict from its own summary line. A guard that CRASHED
# printed neither, and must never be read as "passed" or as "survived the
# mutation" — those are conclusions about code that never ran.
verdict(){ # <output> -> pass | fail | crash
	if printf '%s' "$1" | grep -q 'scenarios passed'; then echo pass
	elif printf '%s' "$1" | grep -q 'FAILED'; then echo fail
	else echo crash; fi
}

# A mutation must make the guard FAIL, and the failure must be legible — by
# default it has to name the mutated file, so the report tells you where to
# look. The 4th argument overrides that needle for mutations whose failure is
# inherently global (a population pin has no one file to blame).
mutate(){ # <label> <file> <python-edit> [expected-needle]
	local label="$1" file="$2" edit="$3"
	local needle="${4:-}"
	snapshot "$file"
	if ! python3 - "$file" <<PY
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
$edit
open(p, 'w', encoding='utf-8').write(s)
PY
	then
		no "$label — could not apply the mutation (the anchor moved)"
		restore "$file"
		return
	fi
	local out; out="$(run_guard)"
	local base; base="${needle:-$(basename "$file")}"
	case "$(verdict "$out")" in
		fail)
			if printf '%s' "$out" | grep -qF "$base"; then
				ok "$label — guard fails, reporting \"$base\""
			else
				no "$label — guard fails but never reports \"$base\" (would not tell you where to look)"
				printf '%s\n' "$out" | sed 's/^/      /' | tail -6
			fi
			;;
		pass)
			no "$label — GUARD SURVIVED THE MUTATION. It is not guarding this."
			printf '%s\n' "$out" | sed 's/^/      /' | tail -6
			;;
		crash)
			no "$label — guard CRASHED, so this mutation proves nothing either way"
			printf '%s\n' "$out" | sed 's/^/      /' | tail -6
			;;
	esac
	restore "$file"
}

echo "focus-scrim-guard-harness — the guard must fail when the bug comes back"
echo ""

# ── Baseline: the shipped tree must pass ─────────────────────────────
BASE_OUT="$(run_guard)"
case "$(verdict "$BASE_OUT")" in
	pass) ok "baseline — guard passes against the tree as shipped" ;;
	fail)
		no "baseline — guard FAILS against the shipped tree; fix that before trusting any mutation below"
		printf '%s\n' "$BASE_OUT" | sed 's/^/      /' | tail -12
		;;
	crash)
		no "baseline — guard CRASHED; nothing below this line means anything"
		printf '%s\n' "$BASE_OUT" | sed 's/^/      /' | tail -12
		;;
esac

# ── M-A: the original bug, inline, single line ───────────────────────
# LanguageFilterSelect is where the maintainer hit this: the Settings page rendered blurred
# on every load because Firefox restored focus into this field.
mutate "M-A inline onfocus opens (the original Settings blur)" \
	"$COMP/LanguageFilterSelect.svelte" \
	"s = s.replace('\t\t\taria-controls=\"language-filter-listbox\"', '\t\t\taria-controls=\"language-filter-listbox\"\n\t\t\tonfocus={() => (open = true)}', 1)"

# ── M-B: the same bug spread over several lines ──────────────────────
# This is the formatting that defeated the exact-string grep the first time.
mutate "M-B multi-line onfocus body opens (defeated the original grep)" \
	"$COMP/PaymentFilterSelect.svelte" \
	"s = s.replace('onfocus={() => void ensureLoaded()}', 'onfocus={() => {\n\t\t\t\topen = true;\n\t\t\t\tvoid ensureLoaded();\n\t\t\t}}', 1)"

# ── M-C: the bug behind a named function ─────────────────────────────
# FiatCurrencySelect had exactly this and was missed entirely: the handler
# attribute is just \`onfocus={onFocus}\`, so nothing about it looks wrong.
mutate "M-C named-function indirection opens (invisible to attribute matching)" \
	"$COMP/FiatCurrencySelect.svelte" \
	"s = s.replace('\tfunction onFocus(): void {\n\t\tvoid ensureLoaded();', '\tfunction onFocus(): void {\n\t\topen = true;\n\t\tvoid ensureLoaded();', 1)"

# ── M-D: across the component boundary ───────────────────────────────
# A parent that MOUNTS a scrim-painting modal from a focus handler blurs the
# page just the same, and a guard that only read one file would never see it.
mutate "M-D focus mounts a scrim-painting child (cross-component)" \
	"$COMP/AssetFilterSelect.svelte" \
	"s = s.replace('onfocus={() => (focused = true)}', 'onfocus={() => (showTrust = true)}', 1); s = s.replace('<div class=\"relative {open ? \'z-30\' : \'z-10\'}\" bind:this={rootEl}>', '{#if showTrust}<TrustScoreModal />{/if}\n<div class=\"relative {open ? \'z-30\' : \'z-10\'}\" bind:this={rootEl}>', 1)"

# ── M-E: the guard must not pass by going blind ──────────────────────
# If a handler's body cannot be resolved or executed, that is a FAILURE, not a
# quiet pass. J-1 in this repo was exactly this shape: a counter that silently
# reported zero rather than admitting it had seen nothing.
mutate "M-E unresolvable handler fails loudly instead of passing" \
	"$COMP/LanguageFilterSelect.svelte" \
	"s = s.replace('\t\t\taria-controls=\"language-filter-listbox\"', '\t\t\taria-controls=\"language-filter-listbox\"\n\t\t\tonfocus={someImportedHandlerWeCannotSee}', 1)"

# ── M-F: the population pins must notice the guard going quiet ───────
# Deleting the scrims would make every remaining check vacuously true. The pins
# exist so that reads as a failure rather than a clean run.
mutate "M-F scrim removed wholesale trips the population pin" \
	"$COMP/PaymentFilterSelect.svelte" \
	"s = s.replace('class=\"fixed inset-0 z-20 cursor-default bg-ink-900/5 backdrop-blur-sm\"', 'class=\"hidden\"')" \
	"focus handlers to execute"

echo ""
printf '\xe2\x94\x80%.0s' $(seq 1 56); echo ""
if [ "$fails" -eq 0 ]; then
	printf '\033[32m\xe2\x9c\x93\033[0m all %d focus-scrim-guard-harness checks passed\n' "$pass"
	exit 0
else
	printf '\033[31m\xe2\x9c\x97\033[0m %d FAILED, %d passed\n' "$fails" "$pass"
	exit 1
fi
