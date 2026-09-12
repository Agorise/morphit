#!/bin/sh
# morphit-gateway-firewall-heal.sh — make sure the frontend container can
# actually reach this host's IPFS gateway, and FIX it if it cannot.
#
# WHY THIS EXISTS
# The frontend nginx proxies /ipfs/ and /ipns/ to the gateway on the host
# (host.docker.internal:8082). UFW's default-deny DROPS that container-to-host
# connect unless a rule allows it, so nginx times out and returns its stock 404
# for EVERY hidden (.onion / .b32.i2p) release fetch. That is what stranded
# morphitlat for weeks while morphit.io looked perfectly healthy to itself: a
# host-side `curl 127.0.0.1:8082` passes happily while no container and no peer
# can reach it (the maintainer, diagnosed 2026-09-11).
#
# v1.17.2 codified the rule in the Ansible bunkerweb role — which never runs on
# a MANUAL /opt/morphit install (morphit.io is one), and only reaches an
# Ansible box on a re-harden. So the fix shipped without reaching the boxes it
# was written for. This script closes that: every upgrade observes the REAL
# container-to-host path and heals it in place, with no admin in the loop.
#
# DISCIPLINE (the standing architectural mandate)
#   1. OBSERVE running state — probe from INSIDE the frontend container, which
#      is the only vantage point that tells the truth. A timeout is the firewall
#      signature; "refused" means the gateway itself is not listening.
#   2. Try the primary fix (ufw), then VERIFY it took by re-probing — never
#      trust an exit code.
#   3. Fall through to an alternate method (iptables) if it did not take.
#   4. Fall through again (restart the frontend, clearing stale conntrack/DNS).
#   5. Degrade gracefully and say which strategy worked. NEVER fail: this runs
#      inside an upgrade and must not be able to break one.
#
# Usage (root):  sh ops/ipfs/morphit-gateway-firewall-heal.sh
# Always exits 0. POSIX sh (/bin/sh is dash on Ubuntu — no bashisms).
set -u

CONTAINER="${MORPHIT_FRONTEND_CONTAINER:-morphit-frontend}"
NET="${MORPHIT_BUNKERWEB_NET:-bunkerweb_net}"
FALLBACK_CIDR="172.20.0.0/16"

log() { echo "morphit-gateway-heal: $*" >&2; }

# ── 0. Preconditions — every one of these is a legitimate "nothing to do" ──
command -v docker >/dev/null 2>&1 || { log "no docker on this box — nothing to heal."; exit 0; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { log "no $CONTAINER container — this box does not front the site with one; nothing to heal."; exit 0; }
command -v ipfs >/dev/null 2>&1 || { log "no ipfs on this box — nothing to heal."; exit 0; }

# Gateway port: read it from kubo rather than assuming 8082.
PORT="$(ipfs config Addresses.Gateway 2>/dev/null | sed -n 's#.*/tcp/\([0-9]\{1,5\}\).*#\1#p' | head -1)" || true
[ -n "${PORT:-}" ] || PORT=8082

# Source CIDR: read it from the ACTUAL docker network rather than hardcoding,
# then fall back to the pinned default. (The compose file deliberately pins
# 172.20.0.0/16 for trusted-proxy correctness — do not widen it.)
CIDR="$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -m1 '/' )" || true
# VALIDATE before we ever open a port to it. `docker network inspect` is a local
# and trusted source, but this value becomes a firewall rule, so a malformed or
# unexpectedly wide answer must never be honoured: accept ONLY an RFC1918 private
# range, and fall back to the pinned default otherwise. Refusing to widen is the
# safe direction — a too-narrow rule leaves the gateway unreachable and gets
# reported, while a too-wide one silently exposes it.
case "${CIDR:-}" in
	10.*/*|192.168.*/*|172.1[6-9].*/*|172.2[0-9].*/*|172.3[0-1].*/*) : ;;
	*)
		[ -n "${CIDR:-}" ] && log "  ignoring non-private subnet '${CIDR}' from docker; using ${FALLBACK_CIDR}"
		CIDR=""
		;;
esac
[ -n "${CIDR:-}" ] || CIDR="$FALLBACK_CIDR"

# ── 1. OBSERVE from inside the container (ground truth) ──────────────
# nginx:alpine ships busybox wget, not curl (same reason the compose healthcheck
# uses wget). Probe the gateway's own version endpoint: tiny, always present,
# and it does not depend on any particular CID being pinned yet.
probe() {
	docker exec "$CONTAINER" wget -q -T 6 -O /dev/null \
		"http://host.docker.internal:${PORT}/api/v0/version" 2>/dev/null
}

if probe; then
	log "frontend container can reach the IPFS gateway on ${PORT} — nothing to heal."
	exit 0
fi

log "frontend container CANNOT reach the host IPFS gateway on ${PORT}."
log "  hidden (.onion/.b32.i2p) release fetches would 404 from this box — healing."

# Is the gateway even listening? If not, this is not a firewall problem and
# adding rules would be cargo-culting. Say so plainly and stop.
if command -v ss >/dev/null 2>&1; then
	if ! ss -lnt 2>/dev/null | grep -qE "[:.]${PORT}([^0-9]|$)"; then
		log "  the gateway is not LISTENING on ${PORT} at all — not a firewall issue."
		log "  check: systemctl status ipfs   and   ipfs config Addresses.Gateway"
		log "  (it must bind 0.0.0.0, not 127.0.0.1, for the container to reach it)"
		exit 0
	fi
fi

HEALED=""

# ── 2. STRATEGY A — ufw (the canonical path on a Morphit box) ────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -qi active; then
	log "  strategy A: ufw allow from ${CIDR} to any port ${PORT} proto tcp"
	ufw allow from "$CIDR" to any port "$PORT" proto tcp >/dev/null 2>&1 || true
	# VERIFY it took effect by observing ufw's own state, not the exit code.
	if ufw status 2>/dev/null | grep -q "$PORT" && probe; then
		HEALED="ufw"
	fi
else
	log "  strategy A skipped: ufw absent or inactive."
fi

# ── 3. STRATEGY B — iptables (ufw missing, inactive, or it did not take) ──
if [ -z "$HEALED" ] && command -v iptables >/dev/null 2>&1; then
	log "  strategy B: iptables INPUT accept ${CIDR} → ${PORT}/tcp"
	# -C first so repeated upgrades do not stack duplicate rules.
	if ! iptables -C INPUT -s "$CIDR" -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
		iptables -I INPUT 1 -s "$CIDR" -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || true
	fi
	if iptables -C INPUT -s "$CIDR" -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null && probe; then
		HEALED="iptables"
	fi
fi

# ── 4. STRATEGY C — restart the frontend (stale conntrack / DNS cache) ──
# A rule can be correct while the container still holds a dead path. Restarting
# is cheap, and `morphit-ops upgrade` restarts this container anyway.
if [ -z "$HEALED" ]; then
	log "  strategy C: restarting $CONTAINER to clear a stale path"
	docker restart "$CONTAINER" >/dev/null 2>&1 || true
	_i=0
	while [ "$_i" -lt 10 ]; do
		sleep 2
		if probe; then HEALED="restart"; break; fi
		_i=$((_i + 1))
	done
fi

# ── 5. REPORT — say which strategy worked, or exactly what to do next ──
if [ -n "$HEALED" ]; then
	log "✓ healed via ${HEALED}: the frontend can now reach the gateway on ${PORT}."
	log "  hidden-only peers can fetch releases from this box again."
	exit 0
fi

log "⚠ could not heal automatically. The frontend still cannot reach the gateway."
log "  Hidden-only peers CANNOT upgrade from this box until this is fixed."
log "  Try, in order:"
log "    sudo ufw allow from ${CIDR} to any port ${PORT} proto tcp"
log "    sudo docker restart ${CONTAINER}"
log "  Then confirm from inside the container (a TIMEOUT means the firewall is"
log "  still dropping it; 'refused' means the gateway is not bound to 0.0.0.0):"
log "    sudo docker exec ${CONTAINER} wget -q -T 6 -O - http://host.docker.internal:${PORT}/api/v0/version"
exit 0
