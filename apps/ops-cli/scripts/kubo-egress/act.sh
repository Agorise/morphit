#!/usr/bin/env bash
# Run by run.sh once the daemon is up ($BIN = the ipfs binary): exercise
# routing the way a node does (provide, find providers, publish IPNS, resolve
# a DNSLink name), so a router or resolver Kubo would ask shows up.
CID=$(echo "morphit egress probe $RANDOM" | $BIN add -q)
echo "cid $CID"
timeout 20 $BIN routing provide $CID; echo "provide rc=$?"
timeout 20 $BIN routing findprovs -n 1 bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy; echo "findprovs rc=$?"
timeout 20 $BIN name publish --lifetime 1h $CID; echo "publish rc=$?"
timeout 15 $BIN resolve /ipns/en.wikipedia-on-ipfs.org; echo "dnslink rc=$?"
$BIN stats dht 2>&1 | head -5
