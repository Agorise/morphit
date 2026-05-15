#!/bin/sh
# morphit-trivy-monitor.sh — Docker image vulnerability rescan
#
# Periodically scans currently-running Docker images with trivy
# for known CVEs.  Most relevant for operators using the
# BunkerWeb deployment path (§32) which pulls a Docker image
# that may have unpatched CVEs disclosed since you deployed.
#
# Without this monitor, an operator wouldn't know they were
# running a vulnerable BunkerWeb until they happened to read a
# CVE advisory and remembered they had it deployed.
#
# Module name: "trivy".  Event names:
#   image_critical_vulns       — CRITICAL: scan found CRITICAL CVEs
#   image_high_vulns           — WARN:     scan found HIGH CVEs
#   image_scan_failed          — WARN:     trivy couldn't scan
#   image_scan_clean           — INFO:     scan found no actionable findings
#   trivy_unavailable          — INFO:     trivy not installed
#
# Requires: trivy installed (sudo apt install -y trivy via the
# aquasec/trivy apt repo) + Docker daemon reachable.
#
# Cadence: daily (overnight via systemd timer) — trivy's CVE DB
# updates a few times per day, so daily is the right granularity.

set -eu

# ─── Thresholds (env-tunable) ──────────────────────────────────
# These are counts.  "1 critical CVE" is a CRITICAL alert; if
# you want to suppress noise on known-not-yet-patched advisories,
# raise CRITICAL_THRESHOLD or use trivy's .trivyignore file.
CRITICAL_THRESHOLD=${MORPHIT_TRIVY_CRITICAL_THRESHOLD:-1}
HIGH_THRESHOLD=${MORPHIT_TRIVY_HIGH_THRESHOLD:-5}

# Image scan timeout (some images are huge).
SCAN_TIMEOUT=${MORPHIT_TRIVY_SCAN_TIMEOUT:-300}

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="trivy"
MORPHIT_EMIT_TAG="morphit-trivy-monitor"

# ─── Bail if trivy missing ─────────────────────────────────────
if ! command -v trivy >/dev/null 2>&1; then
    emit info trivy_unavailable \
         '{"hint":"install trivy: https://aquasecurity.github.io/trivy/latest/getting-started/installation/"}'
    exit 0
fi

# ─── Bail if Docker missing ────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
    emit info trivy_unavailable \
         '{"hint":"docker not installed; this sidecar is only useful with Docker-based deploys (e.g. BunkerWeb per OPERATIONS.md §32)"}'
    exit 0
fi

# ─── Enumerate running images ──────────────────────────────────
# Use `docker ps` to find currently-running containers and their
# images.  Skip the morphit-relay / morphit-indexer themselves
# (they're bare-metal, not containerized in the canonical
# deploy).  Skip ephemeral helper containers (those with
# "<none>" tags).
images=$(docker ps --format '{{.Image}}' 2>/dev/null | sort -u | grep -v '^$' | grep -v ':<none>$' || true)

if [ -z "$images" ]; then
    # No running containers — nothing to scan.  Not an error.
    exit 0
fi

# ─── Scan each unique image ────────────────────────────────────
for image in $images; do
    # Scan with --severity CRITICAL,HIGH for actionable findings
    # only.  --quiet suppresses progress noise.
    # --format json gives parseable output.
    output=$(timeout "$SCAN_TIMEOUT" \
              trivy image --severity CRITICAL,HIGH \
                          --format json \
                          --quiet \
                          --timeout "${SCAN_TIMEOUT}s" \
                          "$image" 2>/dev/null || echo '')
    if [ -z "$output" ]; then
        payload='{"image":"'$(json_str "$image")'","hint":"trivy scan returned no output; check `trivy image '"$image"'` manually"}'
        emit warn image_scan_failed "$payload"
        continue
    fi

    # Count CRITICAL + HIGH by parsing the trivy JSON.  Use jq
    # if available (best); fall back to grep counts (good
    # enough — we're counting CVE entries which appear once
    # each).
    if command -v jq >/dev/null 2>&1; then
        critical_count=$(echo "$output" | jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL")] | length' 2>/dev/null || echo 0)
        high_count=$(echo "$output" | jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH")] | length' 2>/dev/null || echo 0)
    else
        critical_count=$(echo "$output" | grep -oE '"Severity":\s*"CRITICAL"' | wc -l)
        high_count=$(echo "$output" | grep -oE '"Severity":\s*"HIGH"' | wc -l)
    fi
    critical_count=${critical_count:-0}
    high_count=${high_count:-0}

    if [ "$critical_count" -ge "$CRITICAL_THRESHOLD" ] 2>/dev/null; then
        payload='{"image":"'$(json_str "$image")'","critical_count":'$critical_count',"high_count":'$high_count',"threshold":'$CRITICAL_THRESHOLD'}'
        emit error image_critical_vulns "$payload"
    elif [ "$high_count" -ge "$HIGH_THRESHOLD" ] 2>/dev/null; then
        payload='{"image":"'$(json_str "$image")'","critical_count":'$critical_count',"high_count":'$high_count',"threshold":'$HIGH_THRESHOLD'}'
        emit warn image_high_vulns "$payload"
    else
        payload='{"image":"'$(json_str "$image")'","critical_count":'$critical_count',"high_count":'$high_count'}'
        emit info image_scan_clean "$payload"
    fi
done

exit 0
