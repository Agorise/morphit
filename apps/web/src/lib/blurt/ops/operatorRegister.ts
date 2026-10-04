import { isAllowedContactUrl } from '@morphit/operator-config/contact';
/**
 * Morphit — operator register op broadcaster.
 *
 * Builds a `morphit_operator_register_v1` custom_json payload,
 * signs it with the user's posting key, and broadcasts it same-origin
 * through this instance's indexer. Per ADR-0013 Q1.1 (ratified: a), this
 * is an explicit registration: the operator claims a tag and sets their
 * display_name. Sending it again from the same account updates the
 * entry (the indexer upserts on the signer); the tag itself cannot change.
 *
 * Tag format: lowercase alphanumeric + dash/underscore/dot,
 * 1-64 chars. First-come-first-served — the indexer's UNIQUE
 * constraint on operators.tag enforces this regardless of client.
 */

// Byte budget: broadcastCustomJson is dynamically imported
// at the call site below so dblurt (a 2 MB chunk) doesn't land in
// the eager-load graph of routes that pull this ops file for its
// types/helpers but don't immediately trigger a broadcast.
import { OP_IDS } from '$net/config';
import type { LiveIdentity } from '$crypto/keygen';
import { getUserBlurtAccount, BroadcastError } from './profile';
import { redactPrivateKeys } from '$lib/security/privateKeyDetector';
import { isReservedTag, ownsReservedName, tagImpersonatesReserved } from '$crypto/confusables';

export const TAG_MIN = 1;
export const TAG_MAX = 64;
export const DISPLAY_NAME_MAX = 64;
export const CONTACT_URL_MAX = 2048;

/** Tag format: lowercase alphanumeric + dash/underscore/dot. Must
 *  match the indexer handler's TAG_PATTERN or the broadcast will
 *  be rejected on-chain. We validate client-side so the user gets
 *  immediate feedback. */
export const TAG_PATTERN = /^[a-z0-9._-]+$/;

export interface OperatorRegisterPayload {
	/** The tag to claim. Case-sensitive, lowercase-only. */
	tag: string;
	/** Display name for the /operators directory. */
	display_name: string;
	/** Optional https:// URL for the operator's own contact info. */
	contact_url?: string;
}

/** Machine-readable reasons a tag would fail client-side validation.
 *  Maps 1:1 to the indexer handler's reason slugs so UI code can
 *  localize both paths uniformly. */
export type TagValidationReason =
	| 'tag_too_short'
	| 'tag_too_long'
	| 'tag_invalid_chars'
	| 'tag_reserved';

export function validateTag(
	tag: string,
	/** The registering account. A look-alike of a reserved name is refused
	 *  unless this account owns that name — the indexer's own rule (L3). */
	signer?: string | null
): { ok: true } | { ok: false; reason: TagValidationReason } {
	if (tag.length < TAG_MIN) return { ok: false, reason: 'tag_too_short' };
	if (tag.length > TAG_MAX) return { ok: false, reason: 'tag_too_long' };
	if (!TAG_PATTERN.test(tag)) return { ok: false, reason: 'tag_invalid_chars' };
	if (isReservedTag(tag)) return { ok: false, reason: 'tag_reserved' };
	if (tagImpersonatesReserved(tag) && !(signer && ownsReservedName(signer, tag))) {
		return { ok: false, reason: 'tag_reserved' };
	}
	return { ok: true };
}

export type DisplayNameValidationReason = 'display_name_too_short' | 'display_name_too_long';

export function validateOperatorDisplayName(
	name: string
): { ok: true } | { ok: false; reason: DisplayNameValidationReason } {
	const trimmed = name.trim();
	if (trimmed.length < 1) return { ok: false, reason: 'display_name_too_short' };
	if ([...trimmed].length > DISPLAY_NAME_MAX) {
		return { ok: false, reason: 'display_name_too_long' };
	}
	return { ok: true };
}

export type ContactUrlValidationReason =
	| 'contact_url_too_long'
	| 'contact_url_bad_scheme'
	| 'contact_url_not_url';

export function validateContactUrl(
	url: string
): { ok: true } | { ok: false; reason: ContactUrlValidationReason } {
	if (url.length > CONTACT_URL_MAX) return { ok: false, reason: 'contact_url_too_long' };
	try {
		new URL(url);
	} catch {
		return { ok: false, reason: 'contact_url_not_url' };
	}
	if (!isAllowedContactUrl(url)) {
		return { ok: false, reason: 'contact_url_bad_scheme' };
	}
	return { ok: true };
}

/** Pure body-builder for an operator-register op. Takes the
 *  (already-validated) payload plus an explicit `ts` and returns
 *  the wire body with redaction applied to free-text.
 *
 *  Extracted from `broadcastOperatorRegister` so redaction
 *  behavior is testable as a pure function. Caller supplies
 *  `ts` so tests can pin the timestamp.
 */
export function buildOperatorRegisterBody(
	payload: OperatorRegisterPayload,
	ts: number
): Record<string, unknown> {
	// Silent private-key redaction on free-text fields. display_name
	// is short (<=64 chars) and unlikely to fit a real key, but the
	// chokepoint discipline — every op-builder sanitizes — means no
	// op leaves this module unredacted. contact_url is URL-validated
	// upstream; redaction here is belt-and-suspenders for URL-shaped
	// strings that might somehow embed key material.
	const body: Record<string, unknown> = {
		v: 1,
		tag: payload.tag,
		display_name: redactPrivateKeys(payload.display_name.trim()),
		ts
	};
	if (payload.contact_url !== undefined && payload.contact_url.trim().length > 0) {
		body.contact_url = redactPrivateKeys(payload.contact_url.trim());
	}
	return body;
}

/** Broadcast an operator registration op. Signs with the posting
 *  key from the LiveIdentity. Caller is responsible for ensuring
 *  the identity is unlocked — this function throws BroadcastError
 *  with code='no_account' if the user has no Blurt account yet.
 *
 *  The indexer applies the op as an UPSERT keyed on the SIGNING ACCOUNT
 *  (apps/indexer/src/indexer/handlers/operatorRegister.ts): the first op
 *  claims the tag (first-come-first-served, immutable afterwards);
 *  re-registering from the same account with the same tag UPDATES
 *  display_name, origin, contact_url and the alt addresses. On-chain
 *  rejections (visible in the indexer event log):
 *    - tag_already_claimed: another account already holds this tag
 *    - tag_immutable: this account is registered under a different tag
 *    - plus the shape/validation reasons the client-side validators
 *      above already catch. */
export async function broadcastOperatorRegister(
	live: LiveIdentity,
	payload: OperatorRegisterPayload
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered yet.');
	}

	// Client-side validation — fail fast rather than submitting a
	// definitely-rejected op. The indexer will still validate, but
	// there's no point spending a broadcast on something we can
	// already prove bad.
	const tagCheck = validateTag(payload.tag, account);
	if (!tagCheck.ok) throw new Error(tagCheck.reason);
	const nameCheck = validateOperatorDisplayName(payload.display_name);
	if (!nameCheck.ok) throw new Error(nameCheck.reason);
	if (payload.contact_url !== undefined && payload.contact_url.trim().length > 0) {
		const urlCheck = validateContactUrl(payload.contact_url.trim());
		if (!urlCheck.ok) throw new Error(urlCheck.reason);
	}

	const body = buildOperatorRegisterBody(payload, Math.floor(Date.now() / 1000));

	const { broadcastCustomJson } = await import('../sign');
	return await broadcastCustomJson(live, OP_IDS.operatorRegister, body, account);
}
