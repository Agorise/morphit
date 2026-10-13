# Mirroring the Morphit indexer snapshot on a hidden Blurt RPC node

For operators of the hidden-service (Tor / I2P) Blurt RPC nodes that Morphit nodes use. It is a
small addition: your node keeps a copy of one ~600 kB file and serves it on the address and port it
already serves JSON-RPC on. Nothing about your RPC service changes.

## Why

A new Morphit node does not replay the whole Blurt chain. It restores a **snapshot** of the indexer
database that the `@morphit` account publishes and anchors on chain, then catches up the last few
days itself (`morphit-ops fast-sync`). The snapshot is fetched from IPFS, by its CID.

A new **Tor/I2P-only** node has a problem: it has no indexer yet, so it knows no other Morphit node to
fetch the snapshot from privately, and it never uses clearnet. The one set of hidden addresses every
new node knows is **your RPC nodes**: they are in its settings
(`MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS`). If your node serves the snapshot, every new node can start
in minutes instead of days, without ever touching clearnet.

From Morphit v1.21.7, `fast-sync` already asks each hidden RPC node in its settings for the
snapshot. A node that does not mirror simply answers 404 and the next source is tried, so nothing
breaks before you turn this on.

## What Morphit nodes request

On the **same `.onion` / `.b32.i2p` and port** as your JSON-RPC (`:8091` for the nodes in Morphit's
seed list), plain HTTP:

| Request | Answer |
|---|---|
| `GET /ipfs/<cid>` | `200`, the raw tarball (`application/x-gzip` or `application/octet-stream`), when you hold `<cid>`; `404` otherwise |
| `GET /ipfs/<cid>?format=car` | `200` with `Content-Type: application/vnd.ipld.car` — the same content as a CAR, which another node imports into its own IPFS under the same CID |
| `HEAD` of the above | the same headers, no body |

Rules Morphit relies on:

- **Never redirect.** A redirect is treated as a failure (a hidden node must not be sent elsewhere).
- **Answer promptly, or not at all.** A source that sends less than 512 bytes a second for two minutes
  is dropped. A quick `404` for a CID you do not hold is best.
- **Serve only what you hold.** Do not fetch arbitrary CIDs on request (see `Gateway.NoFetch` below).
  Otherwise your node becomes an open IPFS proxy reachable over Tor/I2P.
- **Only `/ipfs/<cid>`.** Do not expose `/ipns/`, `/api/v0/` or anything else of the IPFS daemon.
- `<cid>` is a CIDv0 (`Qm…`, 46 characters) or a CIDv1 in base32 (`b…`).

Nobody has to trust your copy: every downloading node checks the file against the SHA-256 that
`@morphit` signed on chain and throws away anything else. Still, check it yourself before serving
(step 3 below), so you never serve a file every node will reject.

## Where the snapshot is announced

`@morphit` posts a `custom_json` operation with `id` = `indexer_snapshot_v1`, signed with its
**posting** authority (`required_posting_auths` = `["morphit"]`). The newest one is the snapshot to
mirror. Its `json` field:

```json
{
  "ipfs_cid": "QmVs236Da4ER5DeSSkda7BXCLm6czEm4rYC9B92Qu32kv1",
  "sha256": "<64 hex: SHA-256 of indexer.sql.gz inside the tarball>",
  "chain_id": "cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f",
  "schema_version": 67,
  "last_applied_block": 64288040,
  "size_bytes": <bytes>,
  "indexer_version": "1.21.1",
  "hidden_mirrors": { "tor": "<56 chars>.onion", "i2p_b32": "<52 chars>.b32.i2p" }
}
```

- `hidden_mirrors` (optional) is the publisher's own `.onion` / `.b32.i2p`, which serve the same
  CID. Use it to fetch the snapshot over Tor/I2P when your IPFS daemon cannot reach the public IPFS
  network.
- There may be `forgejo_url` or `ipns_name` too. You can ignore them.
- The tarball contains `manifest.json` and `indexer.sql.gz`. `sha256` is the hash of
  `indexer.sql.gz`, not of the tarball.

Read it from your own node: `condenser_api.get_account_history`, `["morphit", -1, 1000]`.

## Setting it up

### 1. An IPFS (kubo) daemon that serves only what it holds

Any recent kubo works. Morphit nodes run 0.42.

```sh
ipfs init --profile server          # once, as the user that runs the daemon
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8088    # loopback only; pick a free port
ipfs config --json Gateway.NoFetch true                  # serve ONLY local content
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
```

- **On a Tor/I2P-only box**, also keep kubo off the public network
  (`ipfs config Routing.Type none`, `ipfs bootstrap rm --all`,
  `ipfs config --json Addresses.Swarm '[]'`). The script then fetches the snapshot as a CAR from
  the publisher's `.onion` over Tor, or its `.b32.i2p` over i2pd (step 2b).
- Run the daemon as a service (`ipfs daemon --enable-gc`).

### 2. Follow the newest snapshot (hourly)

The script below needs `curl`, `jq`, `tar`, `sha256sum` and `ipfs`. Run it hourly from a systemd timer
or cron, as the user that owns the IPFS repo, one run at a time (for example `flock -n` around it). It
is idempotent: it does nothing while the newest snapshot is already mirrored.

```sh
#!/bin/sh
# morphit-snapshot-follow.sh — keep the newest Morphit indexer snapshot pinned.
set -eu
RPC="${RPC:-http://127.0.0.1:8091}"                 # this node's own Blurt JSON-RPC
IPFS_API="${IPFS_API:-/ip4/127.0.0.1/tcp/5001}"
TOR_SOCKS="${TOR_SOCKS:-127.0.0.1:9050}"
I2P_PROXY="${I2P_PROXY:-http://127.0.0.1:4444}"    # i2pd's HTTP proxy
STATE="${STATE:-$HOME/.morphit-snapshot-mirror}"    # writable by the user running this
mkdir -p "$STATE"
ipfs() { command ipfs --api "$IPFS_API" "$@"; }

# 1. The newest indexer_snapshot_v1 record @morphit signed.
hist=$(curl -fsS --max-time 60 -H 'content-type: application/json' \
	--data '{"jsonrpc":"2.0","method":"condenser_api.get_account_history","params":["morphit",-1,1000],"id":1}' \
	"$RPC") || { echo "could not read @morphit's history from $RPC"; exit 1; }
op=$(printf '%s' "$hist" | jq -c '[.result[] | .[1].op | select(.[0] == "custom_json") | .[1]
		| select(.id == "indexer_snapshot_v1" and .required_posting_auths == ["morphit"])
		| .json | fromjson] | last // empty') || { echo "unexpected answer from $RPC"; exit 1; }
[ -n "$op" ] || { echo "no snapshot record in @morphit's last 1000 operations"; exit 0; }
cid=$(printf '%s' "$op" | jq -r '.ipfs_cid // empty')
sha=$(printf '%s' "$op" | jq -r '.sha256 // empty')
printf '%s' "$cid" | grep -Eq '^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$' || { echo "bad CID"; exit 1; }
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$' || { echo "bad sha256"; exit 1; }
[ "$(cat "$STATE/current" 2>/dev/null || true)" = "$cid" ] && exit 0

# 2a. Fetch it into IPFS under the same CID, from the IPFS network (skipped when
#     this IPFS node is off the public network: it could only wait it out) ...
offline_ipfs=no
[ "$(ipfs config Routing.Type 2>/dev/null)" = none ] && offline_ipfs=yes
if [ "$offline_ipfs" = yes ] \
	|| ! timeout 1800 ipfs --api "$IPFS_API" pin add --progress=false "$cid" >/dev/null 2>&1; then
	# 2b. ... or, on a Tor/I2P-only box, as a CAR from the publisher's .onion
	#     over Tor, or failing that its .b32.i2p over i2pd (an I2P-only box).
	onion=$(printf '%s' "$op" | jq -r '.hidden_mirrors.tor // empty')
	b32=$(printf '%s' "$op" | jq -r '.hidden_mirrors.i2p_b32 // empty')
	tmp=$(mktemp)
	trap 'rm -f "$tmp"' EXIT
	if printf '%s' "$onion" | grep -Eq '^[a-z2-7]{56}\.onion$' \
		&& curl -fsS --max-time 900 --max-filesize 67108864 --socks5-hostname "$TOR_SOCKS" \
			-o "$tmp" "http://$onion/ipfs/$cid?format=car"; then
		:
	elif printf '%s' "$b32" | grep -Eq '^[a-z2-7]{52}\.b32\.i2p$' \
		&& curl -fsS --max-time 1200 --max-filesize 67108864 -x "$I2P_PROXY" \
			-o "$tmp" "http://$b32/ipfs/$cid?format=car"; then
		:
	else
		echo "could not fetch $cid"
		exit 1
	fi
	ipfs dag import --pin-roots=false "$tmp" >/dev/null
	ipfs pin add --progress=false "$cid" >/dev/null
fi

# 3. Serve it only if it is what @morphit signed.
got=$(ipfs cat "$cid" | tar -xzO indexer.sql.gz | sha256sum | cut -d' ' -f1)
if [ "$got" != "$sha" ]; then
	ipfs pin rm "$cid" >/dev/null 2>&1 || true
	echo "the bytes for $cid do not match the signed sha256 — not serving them"
	exit 1
fi

# 4. Keep the current and the previous snapshot; unpin older ones.
prev=$(cat "$STATE/current" 2>/dev/null || true)
old=$(cat "$STATE/previous" 2>/dev/null || true)
if [ -n "$old" ] && [ "$old" != "$cid" ] && [ "$old" != "$prev" ]; then
	ipfs pin rm "$old" >/dev/null 2>&1 || true
fi
[ -n "$prev" ] && [ "$prev" != "$cid" ] && printf '%s\n' "$prev" > "$STATE/previous"
printf '%s\n' "$cid" > "$STATE/current"
echo "mirroring $cid"
```

A new snapshot appears every few days, so hourly is plenty. The previous one is kept because a node
that read the record just before a new one was published may still ask for it.

### 3. Route `/ipfs/` on your RPC address to the gateway

In whatever answers HTTP on your hidden RPC port, send `GET`/`HEAD` for `/ipfs/<cid>` to the kubo
gateway, and everything else to the RPC as before. For nginx:

```nginx
# Inside the server {} that serves JSON-RPC on the .onion / .b32.i2p port.
location ~ "^/ipfs/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$" {
    limit_except GET HEAD { deny all; }
    proxy_pass http://127.0.0.1:8088;      # kubo's Addresses.Gateway
    proxy_set_header Host 127.0.0.1;
    proxy_redirect off;
    proxy_intercept_errors on;
    error_page 301 302 307 308 = @no_snapshot;   # never hand out a redirect
    proxy_read_timeout 120s;
}
location @no_snapshot { return 404; }
```

- The regex passes the `?format=car` query through unchanged, because nginx matches the path only.
- Your existing JSON-RPC `location` stays as it is.
- If you rate-limit by connection, allow at least a few parallel downloads of ~1 MB.

## Checking it

From any machine with Tor (replace the address and CID):

```sh
torsocks curl -sI http://<your>.onion:8091/ipfs/<cid> | head -1          # HTTP/1.1 200 OK
torsocks curl -s http://<your>.onion:8091/ipfs/<cid> | tar -tzf -        # manifest.json, indexer.sql.gz
torsocks curl -sI "http://<your>.onion:8091/ipfs/<cid>?format=car" | grep -i content-type
                                                     # application/vnd.ipld.car
torsocks curl -sI http://<your>.onion:8091/ipfs/<a CID you do not hold> | head -1
                                                     # 404, not a fetch from the network
```

On a Morphit node that lists your RPC node, `sudo morphit-ops fast-sync --rehearse` finds,
downloads and verifies the snapshot without changing anything. Its output names each source it
tried, so you can see yours answer.

## Cost

- **Disk:** two snapshots, ~1–2 MB today. They grow slowly with the marketplace.
- **Traffic:** one download per new Morphit node, shared with every other mirror.
- **Trust:** none asked of you or given to you. Downloading nodes verify every byte against
  `@morphit`'s signed record.
