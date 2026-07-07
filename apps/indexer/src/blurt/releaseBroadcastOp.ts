/**
 * Morphit — release-op builder (cp317).
 *
 * Pure, network-free, key-free helpers shared by the
 * `release-broadcast` CLI and its smoke.  Given the JSON payload
 * produced by `release-build-payload.ts`, this validates it (the
 * SAME rules the indexer enforces), re-checks that it carries no
 * secret key material, and shapes it into the exact `custom_json`
 * operation params that get signed with the @morphit posting key
 * and broadcast to the Blurt chain.
 *
 * Keeping this separate from the CLI means the validation + op
 * shape + view-key guard are typechecked and unit-tested, while
 * the CLI is left with only the unavoidable, untestable-in-CI
 * parts (reading the key from a masked prompt, the live broadcast).
 */

import { validateReleasePayload } from '@morphit/release-schema';

/** custom_json op id the indexer's release handler + frontend
 *  release store both key on.  Frozen. */
export const RELEASE_OP_ID = 'morphit_release_v1';

/** Default signer — the canonical @morphit account whose posting
 *  pubkey is pinned on the frontend build.  Overridable for tests
 *  / a community fork that runs its own trust anchor. */
export const RELEASE_SIGNER_DEFAULT = 'morphit';

/** The exact shape `@beblurt/dblurt`'s `broadcast.customJson(data, key)`
 *  expects as its first argument. */
export interface ReleaseCustomJsonOp {
	readonly required_auths: readonly string[];
	readonly required_posting_auths: readonly string[];
	readonly id: string;
	readonly json: string;
}

/** Mirror of the builder's view-key guard (release-build-payload.ts):
 *  lowercase 64-hex, word-bounded.  Identical regex on purpose, so
 *  the broadcaster never refuses a payload the builder happily
 *  emitted, while still catching a hand-edited secret. */
const SECRET_HEX_RE = /\b[0-9a-f]{64}\b/;

/** Throws if `payloadJson` contains a 64-hex run — the Part 107/109
 *  invariant enforced again at the broadcast boundary so a Monero
 *  view key (or any private key) can NEVER reach the chain through a
 *  hand-edited release.json. */
export function assertNoSecretHex(payloadJson: string): void {
	if (SECRET_HEX_RE.test(payloadJson)) {
		throw new Error(
			'payload contains a 64-hex string that looks like a secret key ' +
				'(XMR view key / private key) — REFUSING to broadcast. Morphit ' +
				'release ops never carry secret key material. Remove it and rebuild.'
		);
	}
}

/** Blurt account-name shape — the project-canonical regex (cp175
 *  F-007): 3–16 chars, lowercase, leading letter, `[a-z0-9.-]`
 *  interior.  Kept byte-identical to every other account-name regex
 *  in the tree (blurt-account-regex-parity sentinel). */
const ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/**
 * Validate the release payload and shape it into the custom_json op
 * params ready for `broadcast.customJson`.  Pure + throws on any
 * problem; performs NO network and handles NO key.
 *
 * The on-chain `json` is the EXACT (trimmed) input string — what the
 * operator built and previewed — not a re-serialization, so a dry-run
 * shows byte-for-byte what will be signed.
 */
export function buildReleaseCustomJsonOp(
	payloadJson: string,
	signer: string = RELEASE_SIGNER_DEFAULT
): ReleaseCustomJsonOp {
	const trimmed = payloadJson.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error('release payload is not valid JSON');
	}
	const result = validateReleasePayload(parsed);
	if (!result.ok) {
		throw new Error(`release payload failed validation: ${result.reason}`);
	}
	assertNoSecretHex(trimmed);
	if (!ACCOUNT_RE.test(signer)) {
		throw new Error(`invalid signer account name: "${signer}"`);
	}
	return {
		required_auths: [],
		required_posting_auths: [signer],
		id: RELEASE_OP_ID,
		json: trimmed
	};
}
