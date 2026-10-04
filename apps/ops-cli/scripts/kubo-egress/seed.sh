#!/bin/bash
# Used by kubo-no-phone-home-smoke.ts.  seed.sh <ipfs-binary> <seeder-repo> <privacy-script> <out-dir>
# Local proof that the clearnet settings still seed over the DHT: B is a DHT
# server standing in for the public bootstrap peers; A has Morphit's clearnet
# settings (only its Bootstrap points at B, as there is no internet here); C is
# any IPFS user. A adds and provides; C finds A through the DHT and fetches.
set -u
BIN=$1; AREPO=$2; PRIV=$3; OUT=$4
W=$(mktemp -d /tmp/ks-XXXXXX); mkdir -p "$OUT"
N=kp$$
ip netns add $N
ip -n $N link set lo up
for i in 1 2 3; do ip -n $N addr add 45.33.0.$i/32 dev lo; done
run() { timeout 60 ip netns exec $N env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy IPFS_PATH="$1" "$BIN" "${@:2}"; }
cp -a "$AREPO" "$W/a"
for n in b c; do IPFS_PATH=$W/$n "$BIN" init --profile lowpower >/dev/null 2>&1; done
i=0
for n in a b c; do
	i=$((i+1))
	IPFS_PATH=$W/$n "$BIN" config --json Addresses.Swarm "[\"/ip4/45.33.0.$i/tcp/4001\"]"
	IPFS_PATH=$W/$n "$BIN" config Addresses.API "/ip4/127.0.0.1/tcp/500$i"
	IPFS_PATH=$W/$n "$BIN" config --json Addresses.Gateway "[]"
done
for n in b c; do
	IPFS_PATH=$W/$n PATH=$(dirname "$BIN"):$PATH sh "$PRIV" apply-base >/dev/null 2>&1
done
IPFS_PATH=$W/b "$BIN" config Routing.Type dhtserver
IPFS_PATH=$W/b "$BIN" config --json Bootstrap '[]'
BID=$(IPFS_PATH=$W/b "$BIN" config Identity.PeerID)
for n in a c; do IPFS_PATH=$W/$n "$BIN" config --json Bootstrap "[\"/ip4/45.33.0.2/tcp/4001/p2p/$BID\"]"; done
AID=$(IPFS_PATH=$W/a "$BIN" config Identity.PeerID)
for n in b a c; do ip netns exec $N env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy IPFS_PATH="$W/$n" "$BIN" daemon > "$OUT/daemon-$n.log" 2>&1 & sleep 4; done
sleep 10
CID=$(echo "morphit seeding proof $$" | run "$W/a" add -q)
echo "cid=$CID" > "$OUT/result.txt"
echo "a=$AID" >> "$OUT/result.txt"
run "$W/a" routing provide "$CID" >> "$OUT/result.txt" 2>&1; echo "provide_rc=$?" >> "$OUT/result.txt"
echo "findprovs=$(run "$W/c" routing findprovs -n 1 "$CID" 2>&1 | tr '\n' ' ')" >> "$OUT/result.txt"
echo "cat=$(run "$W/c" cat "$CID" 2>&1)" >> "$OUT/result.txt"
run "$W/a" stats dht >> "$OUT/result.txt" 2>&1
run "$W/a" config show > "$OUT/a-config.json"
for n in a b c; do run "$W/$n" shutdown >/dev/null 2>&1; done
sleep 3
ip netns del $N
rm -rf "$W"
