#!/bin/sh
# morphit-ipfs-privacy.sh — the ONE list of Kubo settings that keep this box's
# IPFS node private, and the one place that applies or checks them.
#
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
#   check-base    exit 0 when the clearnet settings are in place, else 1
#   apply-base    set them (a clearnet node: DHT seeding, nothing else)
# Kubo reads its config at start, so a caller that applies must restart ipfs.
# POSIX sh. Every value was checked against Kubo v0.42.0's config reference and
# a real v0.42.0 daemon (starts, serves /ipfs/<cid> from its gateway, opens no
# outbound connection, and a /ipns/<domain> request makes no DNS query).
set -u

# key<TAB>JSON value. Every node:
#   telemetry off                no POSTs to telemetry.ipshipyard.dev
#   AutoTLS.Enabled false        no registration with libp2p.direct (it would
#                                publish this node's address in a public
#                                certificate log); the gateway is served by the
#                                frontend over https anyway.
#   AutoConf.Enabled false       no fetch of conf.ipfs-mainnet.org (Kubo's network
#                                settings, by default fetched at every start).
#                                Off requires every "auto" placeholder replaced:
#   Routing.DelegatedRouters []  no HTTP routers (cid.contact, delegated-ipfs.dev):
#                                content is found and announced on the DHT only.
#   Ipns.DelegatedPublishers []  IPNS records go to the DHT only.
COMMON_SETTINGS='Plugins.Plugins.telemetry.Config.Mode	"off"
AutoTLS.Enabled	false
AutoConf.Enabled	false
Routing.DelegatedRouters	[]
Ipns.DelegatedPublishers	[]'

# A clearnet node seeds the release on the public IPFS network, so it keeps
# the DHT, with the values AutoConf would have supplied written out:
#   Routing.Type dht             the public DHT only (client, or server when
#                                this node is reachable)
#   Bootstrap                    the IPFS mainnet bootstrap peers (the list
#                                Kubo 0.42 itself falls back to, boxo
#                                autoconf/fallbacks.go); a node only needs them
#                                to join the DHT
#   DNS.Resolvers {}             this server's own resolver for every name (the
#                                "auto" default adds DoH resolvers)
BASE_SETTINGS="$COMMON_SETTINGS
Routing.Type	\"dht\"
Bootstrap	[\"/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN\",\"/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa\",\"/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb\",\"/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt\",\"/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8\",\"/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ\",\"/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ\"]
DNS.Resolvers	{}"

# Hidden-only nodes, instead of the clearnet list:
#   Routing.Type none            no DHT, no delegated routing: nothing announced
#   Bootstrap / Addresses.Swarm  no peers dialled, nothing listening
#   Swarm.DisableNatPortMap      never ask the home router to open a port (UPnP)
#   Discovery.MDNS.Enabled       no multicast announcements on the LAN
#   Provide.Enabled              no provider records at all
#   AutoNAT / relay              no reachability service, no relaying
#   DNS.Resolvers                a DoH resolver on a closed loopback port: a
#                                /ipns/<domain> request through the gateway (which
#                                anyone can send over the .onion) would otherwise
#                                make Kubo ask the system resolver for a name the
#                                requester chose. This way the lookup fails
#                                locally and nothing leaves the box.
#   Gateway.NoDNSLink            no DNSLink lookup for the Host header either
HIDDEN_SETTINGS="$COMMON_SETTINGS
Routing.Type	\"none\"
Bootstrap	[]
Addresses.Swarm	[]
Swarm.DisableNatPortMap	true
Discovery.MDNS.Enabled	false
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
