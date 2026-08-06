/**
 * Morphit — release-discovery fetch path with full trust-anchor
 * verification (Batch J).
 *
 * Why this lives here, not in $lib/indexer/client:
 *
 *   The indexer ALSO surfaces a /v1/release endpoint that returns
 *   the latest release it stored.  The indexer's own handler verifies
 *   the signer + signer's posting pubkey before storing.  But trusting
 *   the indexer's verification means trusting the indexer — and the
 *   whole point of the trust anchor is to NOT have to trust any
 *   single server.  A malicious indexer could serve a forged
 *   payload claiming any version, any hashes, any endpoint list.
 *
 *   So the frontend fetches the release op DIRECTLY from chain RPC,
 *   verifies @morphit's CURRENT posting pubkey on chain matches our
 *   pinned trust anchor, validates the payload, and uses that.
 *
 *   The chain itself enforces signature validity at consensus time —
 *   if the op is in @morphit's account history, @morphit (someone
 *   who held the posting key at broadcast time) signed it.  We don't
 *   need to re-verify the signature; we need to verify the SIGNER
 *   matches our pin.
 *
 * Failure modes:
 *
 *   • Chain RPC unreachable → 'rpc_failed'.  The app continues to
 *     run (no banner; we can't tell if the build is stale or
 *     tampered, so don't alarm the user without evidence).
 *   • No release op found in @morphit's recent history → 'no_release'.
 *     Fresh project, hasn't published yet, or history pruned.
 *     No banner.
 *   • @morphit's current posting pubkey is NOT the pinned one →
 *     'pubkey_mismatch'.  CRITICAL: someone rotated the official
 *     account's key, or our pin is stale.  Banner explains the
 *     trust-anchor mismatch and refuses to consume the release.
 *   • Payload structurally invalid → 'invalid_payload'.  Malformed
 *     op; treat as no_release for UI purposes but log details.
 *
 * Refresh cadence: once per session at app boot is sufficient.
 * Releases are infrequent (a handful per year).  Optional periodic
 * refresh in long-lived sessions is in the store.
 */

import { getDirectChainClient } from '$blurt/client';
import { MORPHIT_OFFICIAL_POSTING_PUBKEY } from '$net/config';
import { validateReleasePayload, type ReleaseValidateError } from '@morphit/release-schema';
import { checkPinnedKeyInAuthority } from '@morphit/release-schema';
import type { ReleasePayloadV1 } from '@morphit/release-schema';

// Re-export for backward-compat with anything that imports it from
// here.  releaseTrustAnchor.ts is the new canonical module.
export { checkPinnedKeyInAuthority } from '@morphit/release-schema';
export type { PubkeyAuthorityCheck } from '@morphit/release-schema';

/** The signer account whose release ops we follow.  Mainnet
 *  default; configurable per-deployment for sibling instances that
 *  run their own release-discovery cadence. */
export const RELEASE_SIGNER_ACCOUNT = 'morphit';

/** How many history entries to walk when looking for the latest
 *  release op.  Large enough that even an active operator account
 *  doesn't bury the release op beyond reach.  10K is the chain RPC
 *  per-call cap. */
const HISTORY_WALK_LIMIT = 10_000;

export type ReleaseFetchError =
	/** Chain RPC unreachable / all endpoints failed. */
	| { kind: 'rpc_failed'; cause: string }
	/** @morphit hasn't published any release op in the
	 *  HISTORY_WALK_LIMIT-sized window we checked. */
	| { kind: 'no_release' }
	/** @morphit's account couldn't be fetched; chain accepts the
	 *  request but returns no row.  Either the account doesn't
	 *  exist (signer mis-configured) or RPC returned bad data. */
	| { kind: 'signer_account_missing' }
	/** @morphit's current posting authorities do NOT include the
	 *  pinned trust-anchor pubkey.  Refuse the release. */
	| { kind: 'pubkey_mismatch'; pinned: string; chain_keys: readonly string[] }
	/** Payload validation failed.  Maps the validator's error code
	 *  through. */
	| { kind: 'invalid_payload'; reason: ReleaseValidateError };

export interface VerifiedRelease {
	readonly payload: ReleasePayloadV1;
	readonly trxId: string;
	readonly blockNumber: number;
	readonly timestamp: string;
	/** The signer account name (always RELEASE_SIGNER_ACCOUNT for
	 *  this fetcher; included so callers don't have to import it). */
	readonly signer: string;
}

export type ReleaseFetchResult =
	| { ok: true; value: VerifiedRelease }
	| { ok: false; error: ReleaseFetchError };

/** Fetch the latest verified release.  Performs:
 *
 *   1. Latest custom_json with id `morphit_release_v1` authored by
 *      RELEASE_SIGNER_ACCOUNT, walking up to HISTORY_WALK_LIMIT ops
 *      back from the chain head.
 *   2. RELEASE_SIGNER_ACCOUNT's current account record from chain.
 *   3. Trust-anchor check: pinned MORPHIT_OFFICIAL_POSTING_PUBKEY
 *      must appear in the account's posting authority.
 *   4. Payload validation via validateReleasePayload.
 *
 *  Returns a VerifiedRelease or a categorized error.  Never throws
 *  on expected failure conditions — every error is mapped to a
 *  ReleaseFetchError.  Throws only on programmer error.
 */
export async function fetchVerifiedRelease(): Promise<ReleaseFetchResult> {
	// DIRECT-to-chain (NOT the indexer). cp410: this is the sole sanctioned
	// browser→Blurt-node reader. Release verification's trust anchor exists to
	// detect a malicious operator serving a tampered build, so it must read the
	// real chain — routing it through the operator's own indexer would let that
	// operator forge a "verified" release and defeat the whole check.
	//
	// ─── THE PRIVACY COST, STATED (v1.7.5, t.txt #10) ──────────────────────────
	// This call is the ONE place a user's browser touches a third-party host, and
	// that host sees their IP. It fires once per session, from `initRelease()` in
	// the root layout, so it happens on EVERY page — including the explorer.
	// Previously this file argued the security case at length and never named the
	// cost, which made the tradeoff invisible to the next reader.
	//
	// It is a real tradeoff and it does not reduce:
	//   • Direct  → a Blurt node learns "some IP loaded Morphit". It learns
	//     nothing else: not the account, not the orders, not the chat. But the
	//     client learns the TRUE latest release, which is what makes
	//     `staleBuild` (payload.version !== RUNNING_VERSION) meaningful.
	//   • Indexer → zero third-party exposure (the operator already serves the
	//     page and knows the IP anyway). But the operator then decides what
	//     "latest" means, so they can pin every user to an old, genuine,
	//     validly-signed build forever and no banner ever fires. Signature
	//     checking does NOT close this: a rollback replays a real signature.
	//
	// So the direct call protects users from the operator at the cost of exposing
	// them to one node. Given Morphit's threat model — "don't trust the operator"
	// is the product — that trade currently favours keeping it. It is Ken's call,
	// and it is recorded in docs/REVISIT-LIST.md rather than buried here.
	//
	// NOTE: `faq.entries.data_collection.a` currently tells users "No third-party
	// services on any Morphit page." That is not accurate while this call exists.
	// Whichever way the tradeoff is settled, the copy and the code must agree.
	const client = getDirectChainClient();

	// ─── 1. Find the latest release op in @morphit's history.  ──
	let opResult;
	try {
		opResult = await client.getLatestCustomJson<unknown>(
			RELEASE_SIGNER_ACCOUNT,
			'morphit_release_v1',
			HISTORY_WALK_LIMIT
		);
	} catch (err) {
		return {
			ok: false,
			error: {
				kind: 'rpc_failed',
				cause: err instanceof Error ? err.message : String(err)
			}
		};
	}
	if (opResult === null) {
		return { ok: false, error: { kind: 'no_release' } };
	}

	// ─── 2. Trust-anchor pubkey check.  ───────────────────────────
	let signerAccount;
	try {
		signerAccount = await client.getAccount(RELEASE_SIGNER_ACCOUNT);
	} catch (err) {
		return {
			ok: false,
			error: {
				kind: 'rpc_failed',
				cause: err instanceof Error ? err.message : String(err)
			}
		};
	}
	if (!signerAccount) {
		return { ok: false, error: { kind: 'signer_account_missing' } };
	}

	// Walk the posting authority's key_auths via the pure helper
	// (so we can smoke-test the matching logic independently of
	// the chain client).  Audit J-1: requires the pinned key with
	// non-zero weight; weight-0 entries don't count.
	const pinned = MORPHIT_OFFICIAL_POSTING_PUBKEY;
	const check = checkPinnedKeyInAuthority(signerAccount.posting?.key_auths, pinned);
	if (!check.ok) {
		return {
			ok: false,
			error: {
				kind: 'pubkey_mismatch',
				pinned,
				chain_keys: check.chainKeys
			}
		};
	}

	// ─── 3. Validate payload structurally.  ───────────────────────
	const validated = validateReleasePayload(opResult.payload);
	if (!validated.ok) {
		return {
			ok: false,
			error: { kind: 'invalid_payload', reason: validated.reason }
		};
	}

	return {
		ok: true,
		value: {
			payload: validated.value,
			trxId: opResult.trxId,
			blockNumber: opResult.blockNumber,
			timestamp: opResult.timestamp,
			signer: RELEASE_SIGNER_ACCOUNT
		}
	};
}
