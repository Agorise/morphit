/**
 * Morphit's stable IPNS name (Ed25519 `k51…`) — the on-chain "always find the latest
 * release" pointer. Generated ONCE via `scripts/ipns-keygen.mjs`; the private key
 * lives only as the `MORPHIT_IPNS_KEY` CI secret. Each release, CI SIGNS a record
 * (scripts/ipns-sign.mjs) pointing this name at the new tarball's CID and anchors the
 * signed record on-chain as `distribution.ipns_record`; every instance then
 * rebroadcasts that record to the public DHT (ops/ipfs/morphit-ipns-rebroadcast.sh)
 * WITHOUT the key, so `ipns://<name>` resolves on any DHT-aware client for as long as
 * one instance is alive — and no instance can repoint it. The name is PUBLIC and
 * anchored on-chain every release as `distribution.ipns_name`.
 *
 * TWO download surfaces (v1.9.6, Ken):
 *   - NATIVE `ipns://<name>/…` — resolves over the PUBLIC DHT with no DNS and no
 *     third party. Needs an IPFS-capable client (Brave, IPFS Companion, a local
 *     Kubo); a plain browser won't act on it. Maximally private + decentralized.
 *   - GATEWAY `https://ipfs.io/ipfs/<cid>/…` — the current release's immutable
 *     DIRECTORY CID via a public gateway; resolves in ANY browser (grandma), at the
 *     cost of one DNS lookup + one third-party gateway. The labeled fallback.
 * (w3name is gone — it stored records off the DHT, so gateways never resolved them.)
 */
export const MORPHIT_IPNS_NAME = 'k51qzi5uqu5dhsa0lbq7pkci906lvm3pu12jvddho7dl1cpl42pqbrh3nra4c8';

/** The permanent, DNS-free, third-party-free NATIVE IPNS URL for the latest release
 *  tarball. Resolves over the public DHT in an IPFS-capable client (Brave, IPFS
 *  Companion, a local Kubo); a plain browser won't act on it — that's what the
 *  gateway link is for. The name never changes, so this is safe to hard-code. */
export function ipnsNativeTarballUrl(): string {
	return `ipns://${MORPHIT_IPNS_NAME}/morphit-latest.tar.gz`;
}

/** The bare NATIVE `ipns://<name>/` directory URL — shown as copyable text so anyone
 *  can paste it into their own IPFS node/browser. */
export function ipnsNativeDirUrl(): string {
	return `ipns://${MORPHIT_IPNS_NAME}/`;
}

/** Public gateway to BROWSE a release directory by its immutable CID — the
 *  versioned tarball, `morphit-latest.tar.gz`, `metadata.json`, `RELEASE-NOTES.md`
 *  and the `.sha256` all sit at the root. Raw CIDs resolve on any gateway (unlike
 *  the w3name IPNS name). Empty string when no CID is known yet. */
export function ipfsCidDirUrl(cid: string | null | undefined): string {
	return cid ? `https://ipfs.io/ipfs/${cid}` : '';
}

/** Direct-download URL for a release's tarball, by the directory's immutable CID.
 *  The release directory always contains a stable-named `morphit-latest.tar.gz`
 *  (identical bytes to the versioned file), so this resolves to that release's
 *  current tarball on any gateway. Empty string when no CID is known yet. */
export function ipfsCidTarballUrl(cid: string | null | undefined): string {
	return cid ? `https://ipfs.io/ipfs/${cid}/morphit-latest.tar.gz` : '';
}
