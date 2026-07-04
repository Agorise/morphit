/**
 * Morphit indexer — signature verification.
 *
 * On Blurt (Graphene lineage), signatures cover the SERIALIZED
 * TRANSACTION DIGEST — not individual ops. The transaction includes:
 *   ref_block_num, ref_block_prefix, expiration, [operations],
 *   [extensions]
 * and is signed by one or more accounts whose required auth matches
 * the ops in the transaction. For `custom_json` ops, the required
 * auth is `required_posting_auths` (or `required_auths` if the op
 * declares active-level).
 *
 * The indexer's verification job:
 *   1. For each custom_json op, figure out which account signed
 *      (from the op's required_posting_auths)
 *   2. Resolve that account's posting public key via the chain
 *   3. Recover the transaction digest and match it against the
 *      transaction's signatures
 *
 * In practice we can skip step 3 because the Blurt consensus nodes
 * have already verified every signature in every block we're
 * reading. If the block made it into `last_irreversible_block_num`,
 * its signatures were valid for the posting keys at that time.
 *
 * What we DO verify ourselves is:
 *   - The op claims an authorized signer (required_posting_auths
 *     is exactly [signer])
 *   - The signer has an account on chain
 *   - For release-discovery specifically, the signer matches the
 *     pinned MORPHIT_OFFICIAL_POSTING_PUBKEY (which is the account
 *     @morphit; the chain-side check already covers "signed with
 *     the current posting key of @morphit", but an additional
 *     equality-check against the pinned key defends against a
 *     future key-rotation-gone-wrong)
 */

import type { ChainAccount } from '$blurt/client';

/** A custom_json op as it sits inside a block transaction. */
export interface CustomJsonOp {
	readonly required_auths: readonly string[];
	readonly required_posting_auths: readonly string[];
	readonly id: string;
	/** Serialized JSON string (Blurt stores it as a string, not an
	 *  already-parsed object). */
	readonly json: string;
}

/** Result of signer extraction. */
export type SignerResult =
	| { readonly ok: true; readonly signer: string }
	| { readonly ok: false; readonly reason: SignerRejectReason };

export type SignerRejectReason =
	| 'no_posting_auth'
	| 'multiple_posting_auths'
	| 'active_auth_not_allowed'
	| 'missing_required_auths_field';

/**
 * Extract the single signer of a custom_json op per Morphit's op
 * policy.
 *
 * Morphit ops (ADR-0001) are signed with the POSTING key of exactly
 * one account — EXCEPT order-create ops paid in BLURT. Those carry an
 * active-authority `transfer` (the listing fee) in the SAME transaction,
 * and Blurt (Graphene) forbids mixing posting-level and active-level
 * operations in one tx (it asserts `required_active.size() == 0` when any
 * posting op is present). So a BLURT-paid order op must itself be
 * active-level. `allowActiveAuth` opts INTO accepting that — the
 * dispatcher passes it only for `OP_IDS.order`; every other op stays
 * strictly posting-only, so a stray active-level chat/feedback/cancel op
 * is still rejected as before.
 *
 * Ops that: use required_auths (active) when not allowed; declare multiple
 * signers; mix posting + active; or declare zero signers — are rejected.
 * The dispatcher lands them in the event log with status='rejected'.
 */
export function extractSigner(op: CustomJsonOp, allowActiveAuth = false): SignerResult {
	if (!Array.isArray(op.required_posting_auths) || !Array.isArray(op.required_auths)) {
		return { ok: false, reason: 'missing_required_auths_field' };
	}
	if (op.required_auths.length > 0) {
		// Active-level custom_json. Rejected by default (ADR-0001). Accepted
		// ONLY for order ops (allowActiveAuth), and only when it's a clean
		// single-active-signer op with no posting auth mixed in — a mixed op
		// would itself be chain-invalid, so it never legitimately reaches here.
		if (!allowActiveAuth || op.required_posting_auths.length > 0 || op.required_auths.length > 1) {
			return { ok: false, reason: 'active_auth_not_allowed' };
		}
		return { ok: true, signer: op.required_auths[0]! };
	}
	if (op.required_posting_auths.length === 0) {
		return { ok: false, reason: 'no_posting_auth' };
	}
	if (op.required_posting_auths.length > 1) {
		return { ok: false, reason: 'multiple_posting_auths' };
	}
	return { ok: true, signer: op.required_posting_auths[0]! };
}

/**
 * Verify a signer has a posting-key record on chain.
 *
 * This resolves the signer claim to a real account. If the account
 * doesn't exist — someone submitted an op with a non-existent
 * required_posting_auth — the block wouldn't have validated in the
 * first place, so this is a defense-in-depth check.
 *
 * Returns the account's posting pubkey (the single key we expect
 * under Morphit's identity model) or null if the account is absent
 * or has a non-single-key posting auth (multi-sig accounts aren't
 * in scope for Morphit v1).
 */
export function resolveSignerPostingPubkey(
	account: ChainAccount | null | undefined
): string | null {
	if (!account) return null;
	const auths = account.posting.key_auths;
	if (auths.length !== 1) return null; // multi-sig out of scope for Phase 3b
	const pair = auths[0];
	if (!pair) return null;
	const [pubkey, weight] = pair;
	if (weight < account.posting.weight_threshold) return null;
	return pubkey;
}

/**
 * Audit 2026-05 finding 3-1: hard length cap on the raw JSON
 * string BEFORE JSON.parse.  Blurt's chain-level custom_json
 * ceiling is currently ~8KB but (a) it has shifted before, (b)
 * a future bump would be silent.  Cap at 16KB-equivalent —
 * comfortably above any legitimate Morphit payload, well below
 * pathological sizes that exercise stack-depth or parser-
 * allocation issues.
 *
 * Per-handler length caps (e.g. checkJsonbSize at 4KB, profile
 * at 8KB) are downstream of this; this is the universal first
 * gate.
 *
 * Naming note (cp81-A1): the name uses LENGTH rather than BYTES
 * because `string.length` counts UTF-16 code units, not bytes.
 * A 16K-code-unit multibyte string could be ~64KB on disk.  The
 * defense is correct (parser allocation scales with code units,
 * not bytes), but the original name `MAX_RAW_JSON_BYTES` was
 * misleading.  Renamed to MAX_RAW_JSON_LENGTH in cp82 to match
 * the unit it actually checks; the back-compat alias was
 * removed in cp84 after confirming no external consumer (audit:
 * repo-wide grep returned only this file + historical changelog
 * entries in TARBALL.md / REVISIT-LIST.md).
 */
export const MAX_RAW_JSON_LENGTH = 16 * 1024;

/**
 * Parse a custom_json op's `json` string safely. On malformed JSON,
 * returns null — caller should mark the op rejected.
 */
export function parseJsonPayload(op: CustomJsonOp): unknown {
	if (typeof op.json !== 'string') return null;
	if (op.json.length > MAX_RAW_JSON_LENGTH) return null;
	try {
		return JSON.parse(op.json);
	} catch {
		return null;
	}
}
