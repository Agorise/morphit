/**
 * The release trust anchors every node-side tool pins in code.
 *
 * They live here, in the package both the upgrade tooling and the release
 * scripts import, so that no file inside a downloaded release decides which
 * keys a node trusts. A release tarball can ship any `.asc` it likes under
 * `.forgejo/release-signers/`; only a signature from a fingerprint listed
 * below, or an on-chain release op signed by the posting key below, makes a
 * tarball installable.
 *
 * Changing either value is a release-trust change: it reaches installed nodes
 * only through an upgrade that the CURRENT anchors already accept.
 */

/** The Blurt account that publishes `morphit_release_v1`. */
export const MORPHIT_RELEASE_ACCOUNT = 'morphit';

/** The posting public key of @morphit. A `morphit_release_v1` op counts only
 *  when its transaction signature recovers to this key. Same value as the
 *  indexer's MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY default and the
 *  frontend's MORPHIT_OFFICIAL_POSTING_PUBKEY. */
export const MORPHIT_OFFICIAL_POSTING_PUBKEY =
	'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9';

/** Fingerprints (upper-case hex, no spaces) of the GPG keys allowed to sign
 *  release tags and release tarballs. A good signature from any other key is
 *  treated as no signature at all. */
export const RELEASE_SIGNER_FINGERPRINTS: readonly string[] = Object.freeze([
	'7B4C1D189DBB610C473B59ED53524E1F1017EB9C'
]);

/** The Blurt mainnet chain id. */
export const BLURT_MAINNET_CHAIN_ID =
	'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';

/** Normalise a GPG fingerprint for comparison: upper-case, no spaces. */
export function normalizeFingerprint(f: string): string {
	return f.replace(/\s+/g, '').toUpperCase();
}
