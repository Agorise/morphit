#!/usr/bin/env bash
# Morphit — run all tsx-runnable smoke scenarios.
set -u
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

# Resolve tsx from the workspace first, then PATH.  Mirrors the
# fallback pattern in scripts/typecheck-sweep.sh — operators who
# call the smoke runner before `npm install` has fully populated
# .bin/ get a clearer error than "command not found", and CI
# workflows that don't prepend node_modules/.bin to PATH still
# work.
if [ -x "$repo/node_modules/.bin/tsx" ]; then
	TSX="$repo/node_modules/.bin/tsx"
elif command -v tsx >/dev/null 2>&1; then
	TSX="$(command -v tsx)"
else
	echo "ERROR: tsx not found.  Run 'npm install' from the repo root." >&2
	exit 2
fi

SMOKES=(
	"apps/indexer:block-handler-smoke"
	"apps/indexer:chat-handler-smoke"
	"apps/indexer:chat-identity-handler-smoke"
	"apps/indexer:order-handler-smoke"
	"apps/indexer:feedback-handler-smoke"
	"apps/indexer:stranger-fee-handler-smoke"
	"apps/indexer:stranger-fee-pricing-smoke"
	"apps/indexer:api-response-shape-smoke"
	"apps/indexer:body-cap-smoke"
	"apps/indexer:daily-ceiling-persist-smoke"
	"apps/indexer:monero-jitter-smoke"
	"apps/indexer:attestor-eligibility-smoke"
	"apps/indexer:fee-attest-handler-smoke"
	"apps/indexer:fee-reward-copy-consistency-smoke"
	"apps/indexer:btc-min-confirmations-smoke"
	"apps/indexer:explorer-txid-echo-smoke"
	"apps/indexer:featurebid-handler-smoke"
	"apps/indexer:operator-earnings-smoke"
	"apps/indexer:db-password-placeholder-smoke"
	"apps/indexer:indexer-result-shape-smoke"
	"apps/indexer:duplicate-import-smoke"
	"apps/indexer:handler-coverage-smoke"
	"apps/indexer:fee-status-filter-lint"
	"apps/indexer:rss-orderbook-smoke"
	"apps/indexer:rss-orderbook-xml-validate"
	"apps/indexer:operator-register-handler-smoke"
	"apps/indexer:operator-payment-method-handler-smoke"
	"apps/indexer:reserved-keys-parity-smoke"
	"apps/indexer:confusables-parity-smoke"
	"apps/indexer:federation-probe-smoke"
	"apps/indexer:dns-rebinding-defense-smoke"
	"apps/indexer:instances-stream-smoke"
	"apps/indexer:orderbook-stream-smoke"
	"apps/indexer:chat-stream-smoke"
	"apps/indexer:chat-payload-smoke"
	"apps/indexer:chat-blurt-verify-smoke"
	"apps/indexer:trade-status-smoke"
	"apps/indexer:listener-dispatch-smoke"
	"apps/indexer:asset-registry-smoke"
	"apps/indexer:disabled-assets-parse-smoke"
	"apps/indexer:order-views-smoke"
	"apps/indexer:profile-handler-smoke"
	"apps/indexer:apr-smoke"
	"apps/indexer:explorer-activity-smoke"
	"apps/indexer:explorer-search-smoke"
	"apps/indexer:explorer-urls-smoke"
	"apps/indexer:loyalty-welcome-smoke"
	"apps/indexer:onion-location-smoke"
	"apps/indexer:pending-feedback-reminders-smoke"
	"apps/indexer:pwa-manifest-smoke"
	"apps/indexer:posting-verify-smoke"
	"apps/indexer:release-validator-smoke"
	"apps/indexer:treasury-source-smoke"
	"apps/indexer:balance-math-smoke"
	"apps/indexer:payments-smoke"
	"apps/indexer:pnl-smoke"
	"apps/indexer:wif-smoke"
	"apps/indexer:yubikey-protocol-smoke"
	"apps/indexer:clearing-price-history-smoke"
	"apps/indexer:login-pairing-registry-smoke"
	"apps/indexer:schema-migration-coverage-smoke"
	"apps/relay:drain-defense-live-fire"
	"apps/relay:drainer-defense-smoke"
	"apps/relay:clock-drift-smoke"
	"apps/relay:key-envelope-smoke"
	"apps/relay:fee-divergence-smoke"
	"apps/relay:ip-bucketing-canonicalization-smoke"
	"apps/relay:trusted-proxy-smoke"
	"apps/relay:squatter-defense-smoke"
	"apps/ops-cli:ops-cli-smoke"
	"apps/ops-cli:init-smoke"
	"apps/ops-cli:edit-smoke"
	"apps/ops-cli:edit-rpc-smoke"
	"apps/ops-cli:altkeystore-smoke"
	"packages/operator-config:operator-config-smoke"
	"packages/relay-client:contract-symmetry-smoke"
	"apps/web:balance-bus-smoke"
	"apps/web:chain-op-verify-smoke"
	"apps/web:yubikey-error-classifier-smoke"
	"apps/web:fingerprint-smoke"
	"apps/web:split-on-placeholder-smoke"
	"apps/web:voucher-locale-parity-smoke"
	"apps/web:price-model-display-smoke"
	"apps/web:price-model-picker-parity-smoke"
	"apps/web:desktop-pairing-crypto-smoke"
	"apps/web:paired-readonly-lifecycle-smoke"
	"apps/web:paired-readonly-affordance-surfaces-smoke"
	"apps/web:asset-tab-completeness-smoke"
	"apps/web:post-edit-multi-network-wired-smoke"
	"apps/web:native-translations-floor-smoke"
	"apps/web:i18n-key-coverage-smoke"
	"apps/web:i18n-locale-parity-smoke"
	"apps/web:i18n-locale-registry-smoke"
	"apps/web:i18n-path-helpers-smoke"
	"apps/web:path-adversarial-smoke"
	"apps/web:no-stale-top-level-routes-smoke"
	"apps/matrix-bot:classifier-smoke"
	"apps/matrix-bot:rate-limiter-smoke"
	"apps/matrix-bot:surface-invariant-smoke"
	"apps/web:canary-template-smoke"
	"packages/asset-registry:asset-registry-smoke"
	".:operations-hardening-smoke"
	".:workspace-membership-smoke"
	"apps/web:i18n-hardcoded-english-smoke"
	"apps/web:i18n-raw-exception-smoke"
	"apps/web:i18n-html-injection-smoke"
	"apps/web:href-xss-smoke"
	"apps/web:active-owner-key-invariants-smoke"
	"apps/web:account-number-detector-smoke"
	"apps/web:i18n-formatters-smoke"
	"apps/web:identity-label-policy-smoke"
	"apps/web:onboarding-back-button-smoke"
	"apps/web:user-preferences-smoke"
	"apps/web:a11y-patterns-smoke"
	"apps/web:heading-hierarchy-smoke"
	"apps/web:forgejo-not-gitea-smoke"
	"apps/web:fee-status-label-coverage-smoke"
	"apps/web:color-contrast-smoke"
	"apps/web:i18n-translation-completeness-smoke"
	"apps/web:sally-walkthrough-smoke"
	"apps/web:persona-walkthrough-smoke"
	"apps/web:mediakit-freshness-smoke"
	"apps/web:wiring-completeness-smoke"
	"apps/web:chat-asset-ticker-narrow-union-parity-smoke"
	"apps/web:network-icon-coverage-smoke"
	"apps/web:payment-method-i18n-parity-smoke"
	"apps/web:web-push-wiring-smoke"
	"apps/web:npm-audit-gate-smoke"
	"apps/web:version-consistency-smoke"
	"apps/relay:canonical-message-cross-check-smoke"
	"apps/indexer:anti-snipe-extension-smoke"
	"packages/asset-registry:fee-method-enum-frozen-smoke"
	"packages/asset-registry:first-buy-waiver-payment-agnostic-smoke"
	"packages/asset-registry:usdt-trade-only-smoke"
	"packages/asset-registry:usdc-trade-only-smoke"
	"packages/asset-registry:dai-trade-only-smoke"
	"packages/asset-registry:bch-trade-only-smoke"
	"packages/asset-registry:ltc-trade-only-smoke"
	"packages/asset-registry:dash-trade-only-smoke"
	"packages/asset-registry:doge-trade-only-smoke"
	"packages/asset-registry:zec-trade-only-smoke"
	"packages/asset-registry:arrr-trade-only-smoke"
	"packages/asset-registry:dcr-trade-only-smoke"
	"packages/asset-registry:sol-trade-only-smoke"
	"packages/asset-registry:eth-trade-only-smoke"
	"apps/web:asset-payload-precision-parity-smoke"
	"workspace-typecheck-smoke"
	"packages/asset-registry:asset-accent-class-uniqueness-smoke"
	"packages/asset-registry:payment-rail-coverage-parity-smoke"
	"packages/asset-registry:address-shape-overlap-smoke"
	"packages/asset-registry:price-provider-coverage-parity-smoke"
	"packages/asset-registry:privacy-features-registry-smoke"
	"apps/web:address-history-helper-smoke"
	"apps/web:amount-jitter-utxo-smoke"
	"apps/web:payjoin-uri-wire-shape-smoke"
	"apps/ops-cli:disabled-assets-wizard-smoke"
	"apps/ops-cli:ansible-structural-smoke"
	"apps/ops-cli:ansible-systemd-user-consistency-smoke"
	"apps/ops-cli:ansible-env-var-consumer-smoke"
	"apps/ops-cli:ansible-lint-smoke"
	"apps/matrix-bot:deps-pin-check"
	"apps/matrix-bot:sidecar-envelope-smoke"
	"apps/matrix-bot:json-str-injection-smoke"
	"apps/matrix-bot:render-alert-hardening-smoke"
	"apps/matrix-bot:api-response-shape-smoke"
	"apps/matrix-bot:sse-stream-shape-smoke"
	"apps/ops-cli:workspace-deps-pin-check"
	"packages/asset-registry:usdt-network-picker-required-smoke"
)

total=0
failed=0
# Per-invocation tempfile prevents concurrent runs from racing on
# the same /tmp/smoke.out and producing transient miscounts.
SMOKE_OUT="$(mktemp -t morphit-smoke.XXXXXX.out)"
trap 'rm -f "$SMOKE_OUT"' EXIT
for entry in "${SMOKES[@]}"; do
	dir="${entry%:*}"
	name="${entry##*:}"
	path="$repo/$dir/scripts/$name.ts"
	if [ ! -f "$path" ]; then
		echo "  ✗ $name (file missing: $path)"
		failed=$((failed + 1))
		continue
	fi
	if (cd "$repo/$dir" && "$TSX" "scripts/$name.ts" >"$SMOKE_OUT" 2>&1); then
		# Smokes MUST emit a canonical `✓ all N ...` line so this runner
		# can tally scenarios.  Without that line, the smoke is treated as
		# a runner failure rather than silently counted as 0 — see J-1
		# (silent zero counting from empty arithmetic) and J-2 (sally
		# emitted a custom format and was undercounted by 22 for ~20
		# Parts) findings, Part 87.
		n=$(grep "^✓ all" "$SMOKE_OUT" | sed "s/.*all \([0-9]*\).*/\1/")
		if [ -z "$n" ] || [ "$n" -eq 0 ] 2>/dev/null; then
			failed=$((failed + 1))
			echo "  ✗ $name (passed runner but emitted no canonical '^✓ all N …' line — fix the smoke to print it)"
			tail -10 "$SMOKE_OUT" | sed 's/^/      /'
			continue
		fi
		total=$((total + n))
	else
		failed=$((failed + 1))
		echo "  ✗ $name"
		tail -10 "$SMOKE_OUT" | sed 's/^/      /'
	fi
done

echo
echo "──────────────────────────────────────────────────────"
echo "Total: $total scenarios passed, $failed runners failed"
if [ "$failed" -ne 0 ]; then
	exit 1
fi
