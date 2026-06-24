/**
 * YubiKey error classifier smoke (REVISIT-LIST item 3).
 *
 * The classifier maps an arbitrary caught error to a stable
 * YubikeyKeystoreErrorKind so the UI can pick localized,
 * code-specific copy.  Coverage:
 *
 *   - `instanceof YubikeyKeystoreError` short-circuit (uses
 *     err.kind directly)
 *   - Transport-layer markers from
 *     apps/web/src/lib/crypto/yubikey/transport.ts
 *   - Wrap-layer markers from
 *     apps/web/src/lib/crypto/yubikey/wrap.ts
 *   - Unknown errors → null (so callers route to
 *     `error.unknown` rather than misclassifying)
 *
 * Usage:
 *   tsx apps/web/scripts/yubikey-error-classifier-smoke.ts
 */

import { classifyYubikeyError, YubikeyKeystoreError } from '../src/lib/crypto/yubikeyErrors.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
	}
}

console.log('YubiKey error classifier smoke');

// ─── YubikeyKeystoreError pass-through ────────────────────────

scenario('YubikeyKeystoreError instance → uses err.kind', () => {
	const err = new YubikeyKeystoreError('label_too_long', 'whatever message');
	assertEqual(classifyYubikeyError(err), 'label_too_long', 'kind');
});

scenario('YubikeyKeystoreError with all keystore-shape kinds round-trip', () => {
	const kinds = [
		'label_too_long',
		'wrap_limit_reached',
		'duplicate_yubikey_label',
		'not_layered',
		'no_yubikey_wrap',
		'wrap_index_out_of_range',
		'cannot_unenroll_last_wrap',
		'unwrap_failed'
	] as const;
	for (const kind of kinds) {
		const err = new YubikeyKeystoreError(kind, 'msg');
		assertEqual(classifyYubikeyError(err), kind, `roundtrip ${kind}`);
	}
});

// ─── Transport-layer markers ──────────────────────────────────

scenario('webhid-unsupported → webhid_unsupported', () => {
	assertEqual(classifyYubikeyError(new Error('webhid-unsupported')), 'webhid_unsupported', 'kind');
});

scenario('no-device-selected → no_device', () => {
	assertEqual(classifyYubikeyError(new Error('no-device-selected')), 'no_device', 'kind');
});

scenario('open-failed → open_failed', () => {
	assertEqual(classifyYubikeyError(new Error('open-failed')), 'open_failed', 'kind');
});

scenario('"YubiKey HMAC timed out — touch your key..." → timeout', () => {
	assertEqual(
		classifyYubikeyError(
			new Error('YubiKey HMAC timed out — touch your key or check the connection')
		),
		'timeout',
		'kind'
	);
});

scenario('"yubikey: short feature report (got 4 bytes...)" → protocol_violation', () => {
	assertEqual(
		classifyYubikeyError(new Error('yubikey: short feature report (got 4 bytes, expected 8)')),
		'protocol_violation',
		'kind'
	);
});

scenario('"YubiKey returned 16-byte HMAC, expected 20" → protocol_violation', () => {
	assertEqual(
		classifyYubikeyError(new Error('YubiKey returned 16-byte HMAC, expected 20')),
		'protocol_violation',
		'kind'
	);
});

// ─── Wrap-layer markers ───────────────────────────────────────

scenario('"YubiKey wrap has invalid or unsafe KDF parameters" → unsafe_kdf_params', () => {
	assertEqual(
		classifyYubikeyError(new Error('YubiKey wrap has invalid or unsafe KDF parameters')),
		'unsafe_kdf_params',
		'kind'
	);
});

scenario('"Unsupported YubiKey wrap schema: 99" → wrap_schema_unsupported', () => {
	assertEqual(
		classifyYubikeyError(new Error('Unsupported YubiKey wrap schema: 99')),
		'wrap_schema_unsupported',
		'kind'
	);
});

scenario('"YubiKey wrap challenge has wrong length: 8 vs 16" → wrap_schema_unsupported', () => {
	assertEqual(
		classifyYubikeyError(new Error('YubiKey wrap challenge has wrong length: 8 vs 16')),
		'wrap_schema_unsupported',
		'kind'
	);
});

scenario('"YubiKey verification failed: challenge-independent response" → enroll_verify_failed', () => {
	assertEqual(
		classifyYubikeyError(new Error('YubiKey verification failed: challenge-independent response')),
		'enroll_verify_failed',
		'kind'
	);
});

scenario('"YubiKey returned 16-byte HMAC, expected 20" (verify length check) → protocol_violation', () => {
	// The verify gate reuses the canonical length-mismatch message, which
	// must keep classifying as a protocol violation, not a verify failure.
	assertEqual(
		classifyYubikeyError(new Error('YubiKey returned 16-byte HMAC, expected 20')),
		'protocol_violation',
		'kind'
	);
});

scenario('"YubiKey-unwrapped CEK has wrong length" → unwrap_failed', () => {
	assertEqual(
		classifyYubikeyError(new Error('YubiKey-unwrapped CEK has wrong length')),
		'unwrap_failed',
		'kind'
	);
});

// ─── Unknown errors → null ────────────────────────────────────

scenario('Plain string error not in taxonomy → null', () => {
	assertEqual(classifyYubikeyError(new Error('something completely unrelated')), null, 'kind');
});

scenario('non-Error throwable → null', () => {
	assertEqual(classifyYubikeyError('a raw string'), null, 'kind');
	assertEqual(classifyYubikeyError(42), null, 'kind');
	assertEqual(classifyYubikeyError(null), null, 'kind');
	assertEqual(classifyYubikeyError(undefined), null, 'kind');
});

scenario('Empty Error → null', () => {
	assertEqual(classifyYubikeyError(new Error('')), null, 'kind');
});

// ─── Defense against partial-match false positives ────────────

scenario('arbitrary text containing "timed out" but not the YubiKey HMAC marker → null', () => {
	// We use startsWith('YubiKey HMAC timed out') to be strict;
	// a completely unrelated "request timed out" should NOT
	// classify as a YubiKey timeout.
	assertEqual(classifyYubikeyError(new Error('Network request timed out')), null, 'kind');
});

scenario('"webhid-unsupported" as substring of larger msg → null', () => {
	// We use exact-equality for transport tokens to avoid the
	// 2026-05 audit prior bug where mapTransportError used
	// `includes` and matched accidentally.
	assertEqual(
		classifyYubikeyError(new Error('Some library wrapped: [webhid-unsupported]')),
		null,
		'kind'
	);
});

console.log('');
if (failures > 0) {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
} else {
	console.log(`✓ all ${scenarios} scenarios passed`);
}
