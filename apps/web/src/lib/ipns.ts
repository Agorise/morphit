/**
 * Morphit's stable IPNS name (w3name Ed25519 `k51…`) — the "always find the
 * latest release" pointer. Generated ONCE via `scripts/ipns-keygen.mjs`; the
 * private key lives only as the `MORPHIT_IPNS_KEY` CI secret, and the release
 * workflow republishes this name to each new tarball's CID. The name itself is
 * PUBLIC and safe to ship. It is also anchored on-chain every release as
 * `distribution.ipns_name`.
 *
 * Leave this empty until the key has been generated and the printed `k51…` name
 * pasted here — the download page shows the IPFS "latest" link live only once it
 * is set (until then IPFS stays a "coming soon" card).
 */
export const MORPHIT_IPNS_NAME = 'k51qzi5uqu5dhsa0lbq7pkci906lvm3pu12jvddho7dl1cpl42pqbrh3nra4c8';

/** Public gateway URL for the release DIRECTORY (browse it: the versioned
 *  tarball, RELEASE-NOTES.md, and metadata.json all sit at the root).
 *  Empty string when no name is configured yet. */
export function ipnsLatestUrl(name: string = MORPHIT_IPNS_NAME): string {
	return name ? `https://dweb.link/ipns/${name}` : '';
}

/** Direct-download URL for the newest release tarball, via IPNS. The release
 *  directory always contains a stable-named `morphit-latest.tar.gz` (same bytes
 *  as the versioned file), so this one link is always the current release. */
export function ipnsLatestTarballUrl(name: string = MORPHIT_IPNS_NAME): string {
	return name ? `https://dweb.link/ipns/${name}/morphit-latest.tar.gz` : '';
}
