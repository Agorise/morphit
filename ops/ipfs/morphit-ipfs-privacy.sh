#!/bin/sh
# morphit-ipfs-privacy.sh — the ONE list of Kubo settings that keep this box's
# IPFS node private, and the one place that applies or checks them.
# (v1.18.0 deep-deep, H3)
#
# WHAT WAS WRONG. Every Morphit install, tor-only ones included, ran a stock
# Kubo: public DHT, the default bootstrap peers, swarm listeners on every
# interface, UPnP asking the home router to open a port, mDNS on the LAN, and
# provider announcements for the Morphit release. On a tor-only node that joined
# the public IPFS network from the home IP and published "this IP hosts Morphit"
# in a list anyone can read. Kubo 0.42 also phones home by default: AutoConf
# fetches its network config from conf.ipfs-mainnet.org, AutoTLS registers with
# libp2p.direct, and telemetry POSTs to telemetry.ipshipyard.dev.
#
# WHAT A HIDDEN-ONLY NODE STILL DOES. It serves the release it holds, by CID,
# from its own gateway (Gateway.NoFetch=true), which the frontend exposes over
# the node's .onion/.b32.i2p. That is the path a hidden-only peer upgrades
# through (/ipfs/<on-chain cid>/…), and it needs no DHT, no swarm and no peers.
#
# Modes (run as the ipfs service user, with IPFS_PATH set):
#   check-hidden  exit 0 when every hidden-only setting is in place, else 1
#   apply-hidden  set them all (idempotent)
#   check-base    exit 0 when the every-node settings are in place, else 1
#   apply-base    set them (every node: telemetry off)
# Kubo reads its config at start, so a caller that applies must restart ipfs.
# POSIX sh. Every value was checked against Kubo v0.42.0's config reference and
# a real v0.42.0 daemon (starts, serves /ipfs/<cid> from its gateway, opens no
# outbound connection, and a /ipns/<domain> request makes no DNS query).
set -u

# key<TAB>JSON value. Every node:
BASE_SETTINGS='Plugins.Plugins.telemetry.Config.Mode	"off"'

# Hidden-only nodes, in addition:
#   Routing.Type none            no DHT, no delegated routing: nothing announced
#   Bootstrap / Addresses.Swarm  no peers dialled, nothing listening
#   Swarm.DisableNatPortMap      never ask the home router to open a port (UPnP)
#   Discovery.MDNS.Enabled       no multicast announcements on the LAN
#   AutoConf / AutoTLS           no fetch from conf.ipfs-mainnet.org, no
#                                registration with libp2p.direct. AutoConf off
#                                requires every "auto" placeholder replaced, hence
#                                the explicit empty router/publisher lists.
#   Provide.Enabled              no provider records at all
#   AutoNAT / relay              no reachability service, no relaying
#   DNS.Resolvers                a DoH resolver on a closed loopback port: a
#                                /ipns/<domain> request through the gateway (which
#                                anyone can send over the .onion) would otherwise
#                                make Kubo ask the system resolver for a name the
#                                requester chose. This way the lookup fails
#                                locally and nothing leaves the box.
#   Gateway.NoDNSLink            no DNSLink lookup for the Host header either
HIDDEN_SETTINGS="$BASE_SETTINGS
Routing.Type	\"none\"
Bootstrap	[]
Addresses.Swarm	[]
Swarm.DisableNatPortMap	true
Discovery.MDNS.Enabled	false
AutoConf.Enabled	false
AutoTLS.Enabled	false
Routing.DelegatedRouters	[]
Ipns.DelegatedPublishers	[]
Provide.Enabled	false
AutoNAT.ServiceMode	\"disabled\"
Swarm.RelayClient.Enabled	false
Swarm.RelayService.Enabled	false
DNS.Resolvers	{\".\":\"https://127.0.0.1:9/dns-query\"}
Gateway.NoDNSLink	true"

log() { echo "morphit-ipfs-privacy: $*" >&2; }

MODE="${1:-}"
case "$MODE" in
	check-hidden|apply-hidden) SETTINGS="$HIDDEN_SETTINGS" ;;
	check-base|apply-base) SETTINGS="$BASE_SETTINGS" ;;
	*)
		echo "usage: morphit-ipfs-privacy.sh check-hidden|apply-hidden|check-base|apply-base" >&2
		exit 2
		;;
esac
export IPFS_PATH="${IPFS_PATH:-/var/lib/ipfs/.ipfs}"
command -v ipfs >/dev/null 2>&1 || { log "ipfs (Kubo) is not installed."; exit 1; }

# Compare without whitespace; `ipfs config <key>` prints a string without its
# quotes, so drop quotes on both sides.
_norm() { tr -d ' \t\r\n"'; }

TAB="$(printf '\t')"
_drift=0
_failed=0
# A here-document, not a pipe: a pipe runs the loop in a subshell, and the
# counters would be lost.
while IFS="$TAB" read -r _key _want; do
	[ -n "$_key" ] || continue
	_have="$(ipfs config "$_key" 2>/dev/null | _norm)" || true
	if [ "$_have" = "$(printf '%s' "$_want" | _norm)" ]; then
		continue
	fi
	_drift=1
	case "$MODE" in
		check-*)
			log "not yet set: $_key"
			;;
		apply-*)
			if ipfs config --json "$_key" "$_want" >/dev/null 2>&1; then
				log "set $_key = $_want"
			else
				log "could not set $_key"
				_failed=1
			fi
			;;
	esac
done <<EOF
$SETTINGS
EOF

case "$MODE" in
	check-*) [ "$_drift" = 0 ] && exit 0 || exit 1 ;;
	apply-*) [ "$_failed" = 0 ] && exit 0 || exit 1 ;;
esac
