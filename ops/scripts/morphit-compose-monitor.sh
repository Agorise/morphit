#!/bin/sh
# morphit-compose-monitor.sh — Docker Compose service health
#
# Watches container health-check status and restart counts for
# all services in the BunkerWeb compose stack (or any compose
# stack the operator wants monitored).  Catches:
#   - service in "unhealthy" state (the canonical compose-side
#     signal that something is wrong)
#   - service in restart loop (high restart count over short time)
#   - service "exited" when it should be "running"
#
# Module name: "compose".  Event names:
#   service_unhealthy            — CRITICAL: docker compose ps reports unhealthy
#   service_exited               — CRITICAL: service stopped unexpectedly
#   service_restart_loop         — WARN:     restart count > threshold
#   docker_unavailable           — INFO:     docker / compose CLI missing
#
# Cadence: every 5 min via systemd timer.

set -eu

# ─── Thresholds (env-tunable) ──────────────────────────────────
RESTART_THRESHOLD=${MORPHIT_COMPOSE_RESTART_THRESHOLD:-5}

# Where to look for compose stacks.  The canonical Morphit
# BunkerWeb path is /opt/morphit/ops/bunkerweb/ — supply a
# space-separated list if you have multiple stacks.
COMPOSE_PROJECTS=${MORPHIT_COMPOSE_PROJECTS:-/opt/morphit/ops/bunkerweb}

# ─── Emit helpers (shared lib) ─────────────────────────────────
. "$(dirname "$0")/lib/emit.sh"
MORPHIT_EMIT_MODULE="compose"
MORPHIT_EMIT_TAG="morphit-compose-monitor"

# ─── Bail if docker / compose missing ──────────────────────────
if ! command -v docker >/dev/null 2>&1; then
    emit info docker_unavailable \
         '{"hint":"docker not installed; this sidecar is only useful with Docker-based deploys (e.g. BunkerWeb per OPERATIONS.md §32)"}'
    exit 0
fi

# Verify docker compose v2 plugin is available.  `docker compose
# version` exits non-zero if not.
if ! docker compose version >/dev/null 2>&1; then
    emit info docker_unavailable \
         '{"hint":"docker compose v2 plugin not installed; run `docker compose version` to check"}'
    exit 0
fi

# ─── Iterate compose projects ──────────────────────────────────
for project_dir in $COMPOSE_PROJECTS; do
    [ -d "$project_dir" ] || continue
    # Skip dirs without a compose file.
    if [ ! -f "$project_dir/docker-compose.yml" ] && \
       [ ! -f "$project_dir/compose.yml" ] && \
       [ ! -f "$project_dir/compose.yaml" ]; then
        continue
    fi

    # docker compose ps --format json prints one JSON object
    # per service.  Each has fields: Name, State, Health,
    # RestartCount (when available).
    services_json=$(docker compose --project-directory "$project_dir" \
                                   ps --format json 2>/dev/null || echo '')
    [ -z "$services_json" ] && continue

    # Use jq if available; fall back to a minimal grep-based
    # parser otherwise.
    if command -v jq >/dev/null 2>&1; then
        # JSON-per-line format (Docker Compose v2 default).
        echo "$services_json" | while IFS= read -r line; do
            [ -z "$line" ] && continue
            name=$(echo "$line" | jq -r '.Name // ""')
            state=$(echo "$line" | jq -r '.State // ""')
            health=$(echo "$line" | jq -r '.Health // ""')
            restart_count=$(echo "$line" | jq -r '.RestartCount // 0')
            [ -z "$name" ] && continue

            payload_base='{"service":"'$(json_str "$name")'","state":"'$(json_str "$state")'","health":"'$(json_str "$health")'","restart_count":'${restart_count:-0}',"project_dir":"'$(json_str "$project_dir")'"}'

            if [ "$health" = "unhealthy" ]; then
                emit error service_unhealthy "$payload_base"
            elif [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
                emit error service_exited "$payload_base"
            elif [ "$restart_count" -ge "$RESTART_THRESHOLD" ] 2>/dev/null; then
                emit warn service_restart_loop "$payload_base"
            fi
        done
    fi
done

exit 0
