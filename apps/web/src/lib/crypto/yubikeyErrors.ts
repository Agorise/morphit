/**
 * Morphit — YubiKey error taxonomy + classifier.
 *
 * Standalone module deliberately separate from
 * $crypto/keystoreYubikey, which pulls in libsodium at module
 * load.  The classifier is pure data — no crypto deps — and
 * extracting it here lets:
 *   - smoke runners exercise the classifier without spinning
 *     up a sodium build for tsx;
 *   - the login + settings UIs import the small surface
 *     without the full keystore module load;
 *   - the keystore module re-exports YubikeyKeystoreError +
 *     classifyYubikeyError + yubikeyErrorI18nKey for callers
 *     that only look in the keystore namespace.
 *
 * REVISIT-LIST item 3 — code-specific error copy.
 */

/** Stable error-kind discriminator surfaced to UI as i18n keys.
 *  Mapping to copy lives in:
 *    - settings.hardware_key.error.<kind> (settings flow)
 *    - login.unlock.yubikey.error.<kind> (login flow)
 *
 *  Ordered by layer:
 *    1. keystore-shape errors (raised by $crypto/keystoreYubikey)
 *    2. transport-layer errors (raised by $crypto/yubikey/transport)
 *    3. wrap-layer errors (raised by $crypto/yubikey/wrap)
 */
export type YubikeyKeystoreErrorKind =
	// ─── keystore-shape errors ─────────────────────────────────
	| 'label_too_long'
	| 'wrap_limit_reached'
	| 'duplicate_yubikey_label'
	| 'not_layered'
	| 'no_yubikey_wrap'
	| 'wrap_index_out_of_range'
	| 'cannot_unenroll_last_wrap'
	| 'unwrap_failed'
	// ─── transport-layer errors ────────────────────────────────
	/** Browser doesn't expose `navigator.hid`. */
	| 'webhid_unsupported'
	/** User cancelled the WebHID device picker. */
	| 'no_device'
	/** Device picked but failed to open (busy / permission). */
	| 'open_failed'
	/** Touch never happened within the timeout. */
	| 'timeout'
	/** Malformed feature report — hardware or non-Yubico HID. */
	| 'protocol_violation'
	// ─── wrap-layer errors ─────────────────────────────────────
	/** KDF parameters below the minimum-safety floor (tampering). */
	| 'unsafe_kdf_params'
	/** Wrap schema version unknown to this client. */
	| 'wrap_schema_unsupported'
	/** Enrollment verification failed: the device returned
	 *  challenge-INDEPENDENT responses to two distinct challenges, so
	 *  it is not performing real HMAC-SHA1 challenge-response (broken
	 *  transport, constant/zero-entropy stub, wrong slot, or non-Yubico
	 *  HID).  Raised by the fail-closed verify gate in
	 *  $crypto/yubikey/wrap before any wrap is committed. */
	| 'enroll_verify_failed';

/** Stable error class for keystore-shape errors.  Throw sites
 *  in $crypto/keystoreYubikey use this.  Transport + wrap
 *  layers throw plain Error with stable message strings (which
 *  classifyYubikeyError pattern-matches into kinds). */
export class YubikeyKeystoreError extends Error {
	readonly kind: YubikeyKeystoreErrorKind;
	constructor(kind: YubikeyKeystoreErrorKind, message: string) {
		super(message);
		this.name = 'YubikeyKeystoreError';
		this.kind = kind;
	}
}

/** Map a kind to the corresponding settings-context i18n key.
 *  Login uses its own prefix `login.unlock.yubikey.error.<kind>`. */
export function yubikeyErrorI18nKey(kind: YubikeyKeystoreErrorKind): string {
	return `settings.hardware_key.error.${kind}`;
}

/** Classify an arbitrary caught error.  Returns a kind if the
 *  error matches a known shape, or null if unrecognized.
 *  Callers route null to `error.unknown` rather than risking
 *  misclassification.
 *
 *  Match rules:
 *    - YubikeyKeystoreError instances → use err.kind directly.
 *    - Transport-layer markers: EXACT-equality on the message
 *      strings the transport module throws.  We don't use
 *      includes() — `Some library wrapped: [webhid-unsupported]`
 *      should NOT match (that's the kind of false-positive that
 *      bit us in the prior mapTransportError implementation).
 *    - Wrap-layer markers: startsWith / includes specific
 *      diagnostic prefixes that the wrap module emits.
 *    - Anything else → null. */
export function classifyYubikeyError(err: unknown): YubikeyKeystoreErrorKind | null {
	if (err instanceof YubikeyKeystoreError) {
		return err.kind;
	}
	if (!(err instanceof Error)) return null;
	const msg = err.message;
	if (msg.length === 0) return null;
	// ── Transport-layer (exact equality on stable token strings) ─
	if (msg === 'webhid-unsupported') return 'webhid_unsupported';
	if (msg === 'no-device-selected') return 'no_device';
	if (msg === 'open-failed') return 'open_failed';
	// HMAC timeout uses startsWith because the transport
	// emits this prefix followed by a freeform suffix.
	if (msg.startsWith('YubiKey HMAC timed out')) return 'timeout';
	// Short feature-report frames (frame-length protocol violation).
	if (msg.startsWith('yubikey: short feature report')) return 'protocol_violation';
	// HMAC output length mismatch (response longer/shorter than spec).
	if (msg.startsWith('YubiKey returned') && msg.includes('byte HMAC')) {
		return 'protocol_violation';
	}
	// ── Wrap-layer ──────────────────────────────────────────────
	if (msg.includes('invalid or unsafe KDF parameters')) return 'unsafe_kdf_params';
	// Enroll-time fail-closed verify gate: challenge-independent response.
	if (msg.startsWith('YubiKey verification failed')) return 'enroll_verify_failed';
	if (msg.startsWith('Unsupported YubiKey wrap schema')) return 'wrap_schema_unsupported';
	if (msg.startsWith('YubiKey wrap challenge has wrong length')) {
		return 'wrap_schema_unsupported';
	}
	if (msg.includes('YubiKey-unwrapped CEK has wrong length')) return 'unwrap_failed';
	return null;
}
