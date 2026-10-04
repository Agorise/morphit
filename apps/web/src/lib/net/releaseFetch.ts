/**
 * Morphit — the browser's release check: the latest `morphit_release_v1` op,
 * read straight from the Blurt chain and PROVED by its signature, never taken
 * on one node's word.
 *
 * Why not ask the operator's indexer (/v1/release)? The check exists to catch
 * an operator serving a tampered or outdated build; asking that operator would
 * let it decide what "latest" and "genuine" mean. So the browser reads the
 * chain itself, from public Blurt RPC nodes.
 *
 * Why not trust the node? A node can answer `get_account_history` with an op
 * it made up. The op is therefore proved (./releaseVerifyCore.ts): the block
 * that holds it is fetched from the same node, the transaction id is
 * recomputed from the block's content, and the transaction's signature must
 * recover to the pinned @morphit posting key (MORPHIT_OFFICIAL_POSTING_PUBKEY).
 * Only the payload parsed from that block is used — version, hash manifest,
 * treasury addresses.
 *
 * Budget (stated in the FAQ `ip_address_and_rpc_nodes`;
 * RELEASE_CHECK_STEADY_STATE_REQUESTS): two small requests to ONE node — the
 * last 100 entries of @morphit's history and the block holding the release —
 * at most once a day per browser (./releaseCache.ts remembers the outcome,
 * success or failure, for 24 h, shared by every tab). One other operator's
 * node is asked the same two reads only when the first fails, serves a record
 * that cannot be verified, or serves a verified release whose version is not
 * the one this site runs (a node may lag or withhold the newest). The
 * 10,000-entry window (~115 KB) is read only when the release is not among
 * the last 100 entries.
 *
 * Failure modes:
 *
 *   • Nothing verifiable from either node → 'rpc_failed'. The app continues
 *     to run, with no banner: nothing is known, so nothing is claimed.
 *   • No release op in @morphit's history window (both nodes) → 'no_release'.
 *   • Both nodes name the same newest release op, NOT signed by the pinned
 *     key → 'pubkey_mismatch'. Either @morphit rotated its key and this
 *     build's pin is stale, or the account was taken over. The banner says the
 *     release cannot be trusted.
 *   • The signed payload is structurally invalid → 'invalid_payload'.
 */

import { getRotator } from '$net/endpoints';
import { MORPHIT_OFFICIAL_POSTING_PUBKEY } from '$net/config';
import { validateReleasePayload, type ReleaseValidateError } from '@morphit/release-schema';
import type { ReleasePayloadV1 } from '@morphit/release-schema';
import { RELEASE_SIGNER_ACCOUNT } from './releaseCache';
import { readSignedOp } from './releaseVerifyCore';
import { compareReleaseVersions } from './releaseVersion';

function versionOf(payload: unknown): string {
	const v =
		payload !== null && typeof payload === 'object'
			? (payload as { version?: unknown }).version
			: undefined;
	return typeof v === 'string' ? v : '';
}

// Re-export for anything that imports the authority check from here.
export { checkPinnedKeyInAuthority } from '@morphit/release-schema';
export type { PubkeyAuthorityCheck } from '@morphit/release-schema';

/** The signer account whose release ops we follow (defined in ./releaseCache,
 *  which must not import the chain client). */
export { RELEASE_SIGNER_ACCOUNT };

export const RELEASE_OP_ID = 'morphit_release_v1';

/** Requests one check makes in steady state: one history read and one block
 *  read, to one node. */
export const RELEASE_CHECK_STEADY_STATE_REQUESTS = 2;

/** How many history entries to walk when looking for the latest release op,
 *  tried in order: the last 100 entries first — a few KB, and the latest
 *  release is normally among them — and the full 10,000 (the chain RPC's
 *  per-call cap, ~115 KB) only when it is not. */
export const RELEASE_HISTORY_WINDOWS = [100, 10_000] as const;

export type ReleaseFetchError =
	/** Chain RPC unreachable / all endpoints failed. */
	| { kind: 'rpc_failed'; cause: string }
	/** No release op in the largest history window checked. */
	| { kind: 'no_release' }
	/** The newest release op is signed by keys other than the pinned one
	 *  (`chain_keys`, recovered from its signatures). Refuse the release. */
	| { kind: 'pubkey_mismatch'; pinned: string; chain_keys: readonly string[] }
	/** Payload validation failed.  Maps the validator's error code
	 *  through. */
	| { kind: 'invalid_payload'; reason: ReleaseValidateError }
	/** Decided by the store, never returned by fetchVerifiedRelease: the only
	 *  verified release read is OLDER than the running build and this browser
	 *  has verified no newer one ($net/releaseCache decideReleaseOutcome). */
	| { kind: 'older_release'; announced: string };

export interface VerifiedRelease {
	readonly payload: ReleasePayloadV1;
	readonly trxId: string;
	/** The block number as the node reported it — NOT verified (the signature
	 *  does not cover it); informational only. */
	readonly blockNumber: number;
	/** The release transaction's `expiration`, covered by @morphit's
	 *  signature (the block's own timestamp is not, so it is not kept). */
	readonly signedExpiration: string;
	/** The signer account name (always RELEASE_SIGNER_ACCOUNT for
	 *  this fetcher; included so callers don't have to import it). */
	readonly signer: string;
}

export type ReleaseFetchResult =
	| { ok: true; value: VerifiedRelease }
	| { ok: false; error: ReleaseFetchError };

/** The latest release, proved as described in the file header. Never throws
 *  on expected failure conditions — every error is mapped to a
 *  ReleaseFetchError. */
export async function fetchVerifiedRelease(
	opts: {
		/** The version this site runs. A verified release of another version
		 *  sends the check to one more node (see the file header). */
		readonly runningVersion?: string;
	} = {}
): Promise<ReleaseFetchResult> {
	const running = opts.runningVersion;
	let r;
	try {
		r = await readSignedOp(getRotator(), {
			signer: RELEASE_SIGNER_ACCOUNT,
			opId: RELEASE_OP_ID,
			pinnedPubkey: MORPHIT_OFFICIAL_POSTING_PUBKEY,
			windows: RELEASE_HISTORY_WINDOWS,
			isCurrent: (payload) => running === undefined || versionOf(payload) === running,
			// Between two verified releases, the higher signed version wins (then
			// the later signed expiration) — never a node-reported block number.
			newer: (a, b) =>
				compareReleaseVersions(versionOf(a.payload), versionOf(b.payload)) ||
				(a.signedExpiration < b.signedExpiration
					? -1
					: a.signedExpiration > b.signedExpiration
						? 1
						: 0)
		});
	} catch (err) {
		return {
			ok: false,
			error: { kind: 'rpc_failed', cause: err instanceof Error ? err.message : String(err) }
		};
	}
	if (!r.ok) {
		if (r.reason === 'none') return { ok: false, error: { kind: 'no_release' } };
		if (r.reason === 'bad_signature') {
			return {
				ok: false,
				error: {
					kind: 'pubkey_mismatch',
					pinned: MORPHIT_OFFICIAL_POSTING_PUBKEY,
					chain_keys: r.keys ?? []
				}
			};
		}
		return {
			ok: false,
			error: {
				kind: 'rpc_failed',
				cause: 'no Blurt RPC node served a release record that could be verified'
			}
		};
	}
	const validated = validateReleasePayload(r.payload);
	if (!validated.ok) {
		return { ok: false, error: { kind: 'invalid_payload', reason: validated.reason } };
	}
	return {
		ok: true,
		value: {
			payload: validated.value,
			trxId: r.trxId,
			blockNumber: r.blockNum,
			signedExpiration: r.signedExpiration,
			signer: RELEASE_SIGNER_ACCOUNT
		}
	};
}
