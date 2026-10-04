#!/bin/bash
# Run BunkerWeb 1.5.10's REAL scheduler (its main.py, every job it schedules,
# its config saver and nginx config generator) once, with a given env file and
# bind mounts, and record every network attempt it makes. Used by
# bunkerweb-no-phone-home-smoke.ts. Needs root, ip, nft, unshare, python3.12.
#
#   run.sh <usr-share-bunkerweb> <mmdb-dir> <env-file> <out-dir> <max-seconds> [host:container ...]
#
# <usr-share-bunkerweb>  the scheduler image's /usr/share/bunkerweb, rebuilt from
#                        the BunkerWeb source (see the smoke's header).
# <mmdb-dir>             the GeoIP files the image ships (src/bw/misc).
# host:container         files mounted over the image's, as Compose does.
#
# How attempts are seen. The scheduler runs in its own network namespace whose
# only way out is a veth to a second namespace (the "sink"). The sink accepts
# packets to ANY address, records each destination (address, protocol, port)
# in an nftables set, and refuses the connection at once (TCP reset / ICMP),
# so nothing waits and nothing reaches the internet. DNS goes to the sink too.
# Every Python process also logs its socket.connect / getaddrinfo calls (a
# sitecustomize audit hook), which names the host each attempt was for. A fake
# Docker API (one BunkerWeb instance, with the env file as its environment) and
# a fake instance API on 127.0.0.1:5000 stand in for the other containers.
#
# <out-dir> gets: scheduler.log, audit.log (one JSON line per attempt),
# sink.json (nft's set of destinations), api.log, nginx/ (the generated config)
# and jobs-cache.txt.
set -u
USB=$1
MMDB=$2
ENVF=$(readlink -f "$3")
OUT=$4
SECS=$5
shift 5
H=$(dirname "$(readlink -f "$0")")
W=$(mktemp -d /tmp/bwh-XXXXXX)
mkdir -p "$W/out" "$W/mmdb"
cp -a "$USB" "$W/usb"
# As the scheduler image sets them (src/scheduler/Dockerfile).
find "$W/usb/core" -path '*/jobs/*' -type f -exec chmod 750 {} +
chmod 750 "$W/usb/scheduler/main.py" "$W/usb/gen/"*.py
cp "$MMDB"/*.mmdb "$W/mmdb/"
# Mount points for the private mount namespace (empty directories).
for d in /etc/bunkerweb /var/tmp/bunkerweb /var/run/bunkerweb /var/log/bunkerweb /var/cache/bunkerweb /var/lib/bunkerweb /data /var/www /var/log/bwh /usr/share/bunkerweb /etc/letsencrypt; do
	[ -e "$d" ] || mkdir -p "$d"
done
N=bwh$$
S=bws$$
ip netns add $N
ip netns add $S
ip link add vh$$ type veth peer name vs$$
ip link set vh$$ netns $N
ip link set vs$$ netns $S
ip -n $N addr add 10.200.0.2/24 dev vh$$
ip -n $N link set vh$$ up
ip -n $N link set lo up
ip -n $N route add default via 10.200.0.1
ip -n $S addr add 10.200.0.1/24 dev vs$$
ip -n $S link set vs$$ up
ip -n $S link set lo up
# The sink answers for every address, so each attempt fails at once.
ip -n $S route add local 0.0.0.0/0 dev lo table local
ip netns exec $S nft -f - <<NFT
table inet sink {
	set seen {
		type ipv4_addr . inet_proto . inet_service
		flags dynamic
		size 65535
	}
	chain pre {
		type filter hook prerouting priority -300; policy accept;
		iifname "vs$$" meta l4proto { tcp, udp } add @seen { ip daddr . meta l4proto . th dport }
	}
	chain in {
		type filter hook input priority 0; policy accept;
		iifname "vs$$" meta l4proto tcp reject with tcp reset
		iifname "vs$$" meta l4proto udp reject
	}
}
NFT
ip netns exec $N unshare -m --propagation private bash "$H/inner.sh" "$W" "$ENVF" "$SECS" "$@"
ip netns exec $S nft -j list set inet sink seen > "$W/out/sink.json"
ip netns del $N
ip netns del $S
rm -rf "$OUT"
mkdir -p "$OUT"
cp -a "$W/out/." "$OUT/"
rm -rf "$W"
