/**
 * Morphit — YubiKey enrollment + unlock orchestration (Batch I, ADR-0017).
 *
 * High-level operations the UI calls:
 *
 *   - enrollYubikey(env, password, hmacFn, slot, label)
 *       Take a simple-passphrase or layered envelope, add a YubiKey
 *       wrap to it, return the new layered envelope.  Idempotent in
 *       the sense that re-enrolling produces a NEW wrap with a fresh
 *       challenge (does not modify existing wraps).  Caps at
 *       MAX_YUBIKEY_WRAPS yubikeys per envelope.
 *
 *   - hardenToYubikeyOnly(env)
 *       Remove ALL passphrase wraps from a layered envelope, leaving
 *       only YubiKey wraps.  This is the (A) → (B) transition the
 *       roadmap describes.  Throws if no YubiKey wraps are present
 *       (won't leave the user with an unrecoverable keystore).
 *
 *   - unenrollYubikey(env, wrapIndex)
 *       Remove a specific YubiKey wrap.  If that was the only YubiKey
 *       and the envelope is layered, leave the layered envelope with
 *       just the passphrase wrap(s) intact.  If removing it would
 *       leave the envelope empty, throws.
 *
 *   - unlockWithYubikey(env, hmacFn)
 *       Find the first YubiKey wrap on the envelope and unwrap it
 *       via the supplied HMAC callback.  Returns the recovered
 *       Identity.
 *
 * All operations are pure transformations over the envelope plus
 * caller-supplied secrets.  Persistence (writing back to local-
 * storage) happens in the caller — the same layer that calls
 * writeEnvelope / readEnvelope today.
 */

import sodium from 'libsodium-wrappers-sumo';
import {
	type KeystoreEnvelope,
	type LayeredCekEnvelope,
	type SimplePassphraseEnvelope,
	decryptIdentity,
	decryptIdentityFromCek,
	encryptIdentityToCek,
	buildPassphraseWrap,
	generateCek,
	validateLayeredEnvelope
} from './keystore';
import { ensureSodium, wipeFullIdentity, type Identity } from './keygen';
import {
	type YubikeySlot,
	type WrappedCekYubikey,
	isYubikeyWrap,
	MAX_YUBIKEY_WRAPS,
	normalizeYubikeyLabel
} from './yubikey/protocol';
import {
	buildVerifiedYubikeyWrap,
	recoverCekFromYubikey,
	type YubikeyHmacFn
} from './yubikey/wrap';

function toB64(bytes: Uint8Array): string {
	return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

// ─── Stable error class (Audit 2026-05 Finding 7-1 fix) ──────────
//
// Prior to this hardening, every throw site here used `new Error(...)`
// with a free-form English string. The HardwareKeyCard UI surfaced
// those raw strings to the user via showToast, which (a) lost
// localization and (b) risked leaking implementation detail in
// future changes.
//
// All new code paths throw `YubikeyKeystoreError` with a stable
// `kind` discriminator. The UI maps `kind` → i18n key. The free-form
// `message` is kept for log/devtools but never user-facing.
//
// REVISIT-LIST item 3 follow-up (2026-05-02): the kind taxonomy
// originally only covered keystore-shape errors raised by THIS file.
// Real-world YubiKey unlock paths can also fail at the WebHID
// transport layer (browser/OS issues) or in the cryptographic wrap
// layer (tampered envelope, schema mismatch).  Those throw paths
// in $crypto/yubikey/{transport,wrap}.ts use plain Error objects
// with stable message strings.  We extended the kind enum to cover
// them and `classifyYubikeyError` maps an arbitrary caught error to
// the appropriate kind.
//
// The taxonomy + classifier live in $crypto/yubikeyErrors (no
// libsodium dep), and we re-export them here so existing
// importers of $crypto/keystoreYubikey see no API change.
export {
	YubikeyKeystoreError,
	yubikeyErrorI18nKey,
	classifyYubikeyError,
	type YubikeyKeystoreErrorKind
} from './yubikeyErrors';

import { YubikeyKeystoreError } from './yubikeyErrors';

/** Predicate: is this envelope already in layered form? */
export function isLayered(env: KeystoreEnvelope): env is LayeredCekEnvelope {
	return env.scheme === 'layered-cek';
}

/** Predicate: does this envelope have at least one YubiKey wrap? */
export function hasYubikeyWrap(env: KeystoreEnvelope): boolean {
	if (!isLayered(env)) return false;
	return env.wraps.some(isYubikeyWrap);
}

/** Predicate: is this envelope locked to a YubiKey only (state B)? */
export function isYubikeyOnly(env: KeystoreEnvelope): boolean {
	if (!isLayered(env)) return false;
	return env.wraps.every(isYubikeyWrap);
}

/** Convert a simple-passphrase envelope into a layered envelope by
 *  decrypting it (with the passphrase) and re-encrypting under a
 *  fresh CEK + passphrase wrap.  Internal helper used by
 *  enrollYubikey when called with a simple-passphrase envelope. */
async function upgradeToLayered(
	env: SimplePassphraseEnvelope,
	password: string
): Promise<{ env: LayeredCekEnvelope; cek: Uint8Array }> {
	await ensureSodium();
	// Decrypt the existing simple-passphrase envelope to recover the identity.
	const id = await decryptIdentity(env, password);
	let cek: Uint8Array | null = null;
	try {
		cek = await generateCek();
		const { cekNonce, ciphertext } = await encryptIdentityToCek(id, cek);
		const passphraseWrap = await buildPassphraseWrap(cek, password);
		const layered: LayeredCekEnvelope = {
			scheme: 'layered-cek',
			v: 1,
			cekNonce: toB64(cekNonce),
			ciphertext: toB64(ciphertext),
			wraps: [passphraseWrap],
			createdAt: env.createdAt
		};
		// Caller wants the CEK so they can immediately add a YubiKey
		// wrap without making the user enter their passphrase a
		// second time.  Hand it over (still owned by us); we'll only
		// wipe in the catch path.
		const cekHandedOver = cek;
		cek = null;
		return { env: layered, cek: cekHandedOver };
	} finally {
		// Always wipe the identity.
		wipeFullIdentity(id);
		// Wipe the CEK ONLY if we threw before handing it over.
		if (cek) sodium.memzero(cek);
	}
}

/** Add a YubiKey wrap to an envelope.
 *
 *  Accepts either a simple-passphrase envelope (which will be
 *  upgraded to layered with a single passphrase wrap, then have the
 *  yubikey wrap appended) or an already-layered envelope (which
 *  just gets the new wrap appended).
 *
 *  Returns the new layered envelope.  Caller persists.
 */
export async function enrollYubikey(
	env: KeystoreEnvelope,
	password: string,
	hmacFn: YubikeyHmacFn,
	slot: YubikeySlot,
	label: string
): Promise<LayeredCekEnvelope> {
	await ensureSodium();
	const cleanLabel = normalizeYubikeyLabel(label);
	if (cleanLabel === null) {
		throw new YubikeyKeystoreError('label_too_long', 'YubiKey label is too long');
	}

	let cek: Uint8Array | null = null;
	let layered: LayeredCekEnvelope;
	try {
		if (isLayered(env)) {
			// Already layered — recover the CEK via passphrase.
			validateLayeredEnvelope(env);
			const existingYubikeyWraps = env.wraps.filter(isYubikeyWrap);
			if (existingYubikeyWraps.length >= MAX_YUBIKEY_WRAPS) {
				throw new YubikeyKeystoreError(
					'wrap_limit_reached',
					`This keystore already has ${MAX_YUBIKEY_WRAPS} YubiKey wraps`
				);
			}
			// Decrypt to identity → re-build the CEK from scratch.
			// (We could try to recover the existing CEK via an
			// existing passphrase wrap; that's a slightly cheaper
			// path but adds branches.  Decrypting and re-CEKing is
			// cleaner and the cost is one extra Argon2id, which
			// happens once per enrollment — fine.)
			const id = await decryptIdentity(env, password);
			try {
				cek = await generateCek();
				const { cekNonce, ciphertext } = await encryptIdentityToCek(id, cek);
				// Audit 2026-05 finding 1-5: preserve previously
				// enrolled YubiKeys.  Pre-fix, this code path replaced
				// the wraps array with [passphrase, new-yubikey],
				// silently dropping every previously enrolled YubiKey.
				// Now we re-wrap each existing YubiKey under the new
				// CEK using the SAME slot+label+challenge, so the same
				// physical YubiKey continues to unlock.  The user has
				// to tap the new YubiKey AND each already-enrolled one
				// during enrollment so we can re-derive their wraps
				// against the new CEK.
				//
				// Implementation: this function only knows how to call
				// hmacFn for ONE YubiKey (the new one).  Re-wrapping
				// existing yubikey wraps would require a different
				// signature (one hmacFn per existing wrap).  Until we
				// extend the API, we ENFORCE the simpler invariant:
				// only one YubiKey wrap may exist at enrollment time.
				// If the user already has a yubikey wrap and wants to
				// add a second, they must use a future API
				// `enrollAdditionalYubikey(env, hmacFnForExisting,
				// hmacFnForNew, ...)`.  Until then, throw clearly.
				if (existingYubikeyWraps.length > 0) {
					throw new YubikeyKeystoreError(
						'duplicate_yubikey_label',
						'enrollYubikey: this keystore already has a YubiKey enrolled. ' +
							'Use unenrollYubikey to remove it first, or wait for ' +
							'multi-YubiKey enrollment support (tracked).'
					);
				}
				// Preserve existing passphrase wraps' password by re-
				// wrapping the new CEK under the same password.  (The
				// passphrase wrap stores no per-passphrase identifier;
				// we'd need the user's old passphrase if they wanted
				// to keep multiple passphrase wraps with different
				// passphrases.  Per validateLayeredEnvelope, only ONE
				// passphrase wrap is permitted anyway, so this is a
				// non-issue today.)
				const newPassphraseWrap = await buildPassphraseWrap(cek, password);
				const newYubikeyWrap = await buildVerifiedYubikeyWrap(cek, hmacFn, slot, cleanLabel);
				layered = {
					scheme: 'layered-cek',
					v: 1,
					cekNonce: toB64(cekNonce),
					ciphertext: toB64(ciphertext),
					wraps: [newPassphraseWrap, newYubikeyWrap],
					createdAt: env.createdAt
				};
			} finally {
				wipeFullIdentity(id);
			}
		} else {
			// Simple-passphrase → upgrade to layered with passphrase
			// wrap first, then add the yubikey wrap on top.
			const upgraded = await upgradeToLayered(env, password);
			cek = upgraded.cek;
			const yubikeyWrap = await buildVerifiedYubikeyWrap(cek, hmacFn, slot, cleanLabel);
			layered = {
				...upgraded.env,
				wraps: [...upgraded.env.wraps, yubikeyWrap]
			};
		}
		validateLayeredEnvelope(layered);
		return layered;
	} finally {
		if (cek) sodium.memzero(cek);
	}
}

/** Remove all passphrase wraps from a layered envelope, leaving
 *  only YubiKey wraps.  This is the (A)→(B) hardening transition.
 *
 *  Throws:
 *    - 'no-yubikey-wrap' if the envelope has no yubikey wrap (would
 *      leave it unrecoverable).
 *    - 'not-layered' if called on a simple-passphrase envelope.
 *
 *  Pure transformation — does not require any secrets.  Caller
 *  persists. */
export function hardenToYubikeyOnly(env: KeystoreEnvelope): LayeredCekEnvelope {
	if (!isLayered(env)) {
		throw new YubikeyKeystoreError('not_layered', 'not-layered: enroll a YubiKey first');
	}
	validateLayeredEnvelope(env);
	const yubikeyWraps = env.wraps.filter(isYubikeyWrap);
	if (yubikeyWraps.length === 0) {
		throw new YubikeyKeystoreError(
			'no_yubikey_wrap',
			'no-yubikey-wrap: enroll a YubiKey before hardening'
		);
	}
	if (yubikeyWraps.length === env.wraps.length) {
		// Already hardened — return as-is rather than re-allocating.
		return env;
	}
	return {
		...env,
		wraps: yubikeyWraps
	};
}

/** Reverse of hardenToYubikeyOnly: re-add a passphrase wrap so the
 *  user can unlock without a YubiKey again.  Requires a YubiKey
 *  unlock to recover the CEK first; the caller must produce the
 *  HMAC callback. */
export async function softenToAlsoPassphrase(
	env: LayeredCekEnvelope,
	hmacFn: YubikeyHmacFn,
	newPassword: string
): Promise<LayeredCekEnvelope> {
	await ensureSodium();
	validateLayeredEnvelope(env);
	const ykWrap = env.wraps.find(isYubikeyWrap);
	if (!ykWrap) {
		throw new YubikeyKeystoreError('no_yubikey_wrap', 'no-yubikey-wrap');
	}
	let cek: Uint8Array | null = null;
	try {
		cek = await recoverCekFromYubikey(ykWrap, hmacFn);
		const passphraseWrap = await buildPassphraseWrap(cek, newPassword);
		return {
			...env,
			wraps: [passphraseWrap, ...env.wraps]
		};
	} finally {
		if (cek) sodium.memzero(cek);
	}
}

/** Remove a specific wrap from a layered envelope by index.
 *
 *  Throws if removing this wrap would leave the envelope empty.
 *  If removing it would leave only yubikey wraps, the envelope is
 *  effectively hardened — that's fine, just changes the state.
 *
 *  Pure — no secrets needed. */
export function unenrollWrap(env: LayeredCekEnvelope, wrapIndex: number): LayeredCekEnvelope {
	validateLayeredEnvelope(env);
	if (wrapIndex < 0 || wrapIndex >= env.wraps.length) {
		throw new YubikeyKeystoreError(
			'wrap_index_out_of_range',
			`Wrap index ${wrapIndex} out of range`
		);
	}
	if (env.wraps.length === 1) {
		throw new YubikeyKeystoreError(
			'cannot_unenroll_last_wrap',
			'cannot remove the only wrap — keystore would become unrecoverable'
		);
	}
	const newWraps = env.wraps.filter((_, i) => i !== wrapIndex);
	return {
		...env,
		wraps: newWraps
	};
}

/** Find the wrap-index of the first YubiKey wrap on a layered
 *  envelope.  Returns -1 if there are none. */
export function firstYubikeyWrapIndex(env: KeystoreEnvelope): number {
	if (!isLayered(env)) return -1;
	return env.wraps.findIndex(isYubikeyWrap);
}

/** Unlock with the YubiKey transport.  Tries each yubikey wrap in
 *  order until one succeeds.  Returns the decrypted Identity.
 *  Caller wraps in toLiveIdentity / wipeFullIdentity per the usual
 *  contract.
 *
 *  The HMAC callback is invoked once per wrap attempted; in the
 *  typical case (one yubikey enrolled) it's invoked exactly once.
 *  Multiple-yubikey envelopes still work but the user has to tap
 *  multiple times if early wraps don't match the present YubiKey. */
export async function unlockWithYubikey(
	env: KeystoreEnvelope,
	hmacFn: YubikeyHmacFn
): Promise<Identity> {
	if (!isLayered(env)) {
		throw new YubikeyKeystoreError('not_layered', 'not-layered: this keystore has no YubiKey wrap');
	}
	validateLayeredEnvelope(env);
	const ykWraps = env.wraps.filter(isYubikeyWrap);
	if (ykWraps.length === 0) {
		throw new YubikeyKeystoreError('no_yubikey_wrap', 'no-yubikey-wrap');
	}
	let lastErr: unknown = null;
	for (const wrap of ykWraps) {
		let cek: Uint8Array | null = null;
		try {
			cek = await recoverCekFromYubikey(wrap, hmacFn);
			const id = decryptIdentityFromCek(env, cek);
			return id;
		} catch (err) {
			lastErr = err;
		} finally {
			if (cek) sodium.memzero(cek);
		}
	}
	// Audit 2026-05 finding 1-6: surface a generic message rather
	// than the underlying cryptographic-detail error from inner
	// helpers.  Internal context lives in `cause` for devtools but
	// won't reach an i18n layer that might log it to a remote
	// logging endpoint.
	const e = new Error(
		'unlock failed: YubiKey did not unlock this keystore (wrong slot, wrong key, or HMAC mismatch)'
	);
	(e as Error & { cause?: unknown }).cause = lastErr;
	throw e;
}

/** List the YubiKey wraps on a layered envelope, in display order.
 *  Used by Settings → Hardware key to show enrolled YubiKeys with
 *  their labels and enrollment dates. */
export function listYubikeyWraps(env: KeystoreEnvelope): ReadonlyArray<{
	readonly index: number;
	readonly wrap: WrappedCekYubikey;
}> {
	if (!isLayered(env)) return [];
	const out: Array<{ index: number; wrap: WrappedCekYubikey }> = [];
	env.wraps.forEach((w, i) => {
		if (isYubikeyWrap(w)) out.push({ index: i, wrap: w });
	});
	return out;
}
