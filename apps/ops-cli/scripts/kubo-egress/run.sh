#!/bin/bash
# Run a Kubo daemon on a copy of a repo and record every network attempt it
# makes. Used by kubo-no-phone-home-smoke.ts. Needs root, ip, nft, unshare.
#
#   run.sh <ipfs-binary> <ipfs-repo> <out-dir> <seconds> <action-script>
#
# The daemon runs in its own network namespace whose only way out is a veth to
# a "sink" namespace. The sink accepts packets to ANY address, records each
# destination (address, protocol, port) in an nftables set and refuses the
# connection at once; its DNS server (dnslog.py) logs every query name and
# answers NXDOMAIN. Once the daemon is up, <action-script> runs with $BIN set
# (providing, finding providers, publishing IPNS, resolving a DNSLink name), so
# routing is exercised as on a live node. Proxy variables are cleared: Kubo
# must not be helped out of the namespace.
#
# <out-dir> gets daemon.log, action.log, dns.log (name and query type per line)
# and sink.json.
set -u
BIN=$1; REPO=$2; OUT=$3; SECS=$4; ACT=$5
H=$(dirname "$(readlink -f "$0")")
W=$(mktemp -d /tmp/kh-XXXXXX); cp -a "$REPO" "$W/repo"; mkdir -p "$W/out"
N=kh$$; S=ks$$
ip netns add $N; ip netns add $S
ip link add vk$$ type veth peer name vs$$
ip link set vk$$ netns $N; ip link set vs$$ netns $S
ip -n $N addr add 10.201.0.2/24 dev vk$$; ip -n $N link set vk$$ up; ip -n $N link set lo up
ip -n $N route add default via 10.201.0.1
ip -n $S addr add 10.201.0.1/24 dev vs$$; ip -n $S link set vs$$ up; ip -n $S link set lo up
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
		iifname "vs$$" udp dport 53 ip daddr 10.201.0.1 accept
		iifname "vs$$" meta l4proto tcp reject with tcp reset
		iifname "vs$$" meta l4proto udp reject
	}
}
NFT
ip netns exec $S python3 "$H/dnslog.py" "$W/out/dns.log" & DL=$!
printf 'nameserver 10.201.0.1\n' > "$W/resolv"
ip netns exec $N unshare -m --propagation private bash -c "
mount --bind '$W/resolv' /etc/resolv.conf
export IPFS_PATH='$W/repo'
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy -u NO_PROXY -u no_proxy '$BIN' daemon > '$W/out/daemon.log' 2>&1 & D=\$!
for i in \$(seq 1 60); do grep -q 'Daemon is ready' '$W/out/daemon.log' && break; sleep 1; done
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy BIN='$BIN' bash '$ACT' > '$W/out/action.log' 2>&1
sleep $SECS
'$BIN' shutdown >/dev/null 2>&1; sleep 2; kill \$D 2>/dev/null
"
kill $DL 2>/dev/null
ip netns exec $S nft -j list set inet sink seen > "$W/out/sink.json"
ip netns del $N; ip netns del $S
rm -rf "$OUT"; mkdir -p "$OUT"; cp -a "$W/out/." "$OUT/"; rm -rf "$W"
