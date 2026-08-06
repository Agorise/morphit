/**
 * Morphit — TOTP (Time-based One-Time Password) — RFC 6238.
 *
 * Used as a SESSION GATE between successful password-unlock of the
 * keystore and the calling code receiving the unlocked identity.
 *
 * ─── Honest threat-model framing (read this before adding callers) ──
 *
 * TOTP in Morphit is NOT a cryptographic second factor in the strict
 * sense.  The TOTP shared secret is stored inside the same encrypted
 * keystore blob that holds the user's Blurt keys.  A determined
 * attacker who already has the encrypted keystore AND has cracked
 * the password can extract the TOTP secret directly — the TOTP
 * verify step adds no work to that attack.
 *
 * What TOTP DOES meaningfully protect against:
 *   - **Shoulder-surfing.**  Someone watching you type your password
 *     can't unlock without also having your authenticator app.
 *   - **Casual local malware.**  Stealers that grab keystore files
 *     and look for the standard "decrypt and use" path don't know
 *     to also extract and use the TOTP secret to compute codes.
 *   - **Borrowed-laptop / shared-device.**  The "I'll just check
 *     the orderbook on your phone for a sec" case is gated on the
 *     other party also having the user's authenticator.
 *
 * What TOTP does NOT protect against:
 *   - A determined attacker with the stolen encrypted-keystore file
 *     plus an offline password-cracking rig: post-crack, they have
 *     the keys directly.  TOTP doesn't slow them down here.
 *
 * For cryptographically-meaningful 2FA (where the second factor's
 * private material never lives on the protected device), Morphit's
 * roadmap is FIDO2/WebAuthn hardware keys.  Exploratory code lives
 * at `apps/web/src/routes/[lang]/dev/yubikey-probe/+page.svelte`.
 *
 * ─── Recommended authenticator apps (open-source only) ─────────────
 *
 * See `recommendedAuthenticatorApps.ts` for the curated list with
 * platform + URL info.  Quick summary:
 *
 *   - **Aegis Authenticator** — Android (F-Droid / Play Store /
 *     direct APK).  GPLv3.  Encrypted local backups, biometric lock.
 *   - **2FAS Authenticator** — iOS + Android.  GPLv3.  Optional
 *     encrypted iCloud / Google Drive backup (your choice).
 *   - **Ente Auth** — iOS + Android + desktop (Linux/Mac/Win) + web.
 *     AGPLv3.  End-to-end-encrypted cross-device sync.
 *
 * Morphit deliberately does NOT recommend Google Authenticator
 * (closed source) or Microsoft Authenticator (closed source).
 *
 * ─── Implementation notes ──────────────────────────────────────────
 *
 * - Algorithm fixed to HMAC-SHA1 (RFC 6238 §1.2 default — what every
 *   authenticator app supports out of the box).  Some apps support
 *   SHA-256/SHA-512 but interop is patchy; HMAC-SHA1 is the
 *   universally-supported standard.
 * - Period fixed to 30 seconds (RFC 6238 §5.2 recommendation).
 * - Digits fixed to 6 (RFC 6238 §5.3 recommendation).
 * - Acceptance window: ±1 step (90s total) tolerates ±30s clock
 *   skew between user device and the local clock, which is what
 *   real-world authenticator apps need.  Tighter than this rejects
 *   legitimate users; looser bleeds entropy.
 * - Secret length: 160 bits (20 bytes) per RFC 4226 §4.  Encoded as
 *   base32 (uppercase, no padding) for the QR / manual-entry
 *   string.  Any authenticator app that follows the otpauth:// URI
 *   spec accepts this.
 *
 * Crypto primitives use the browser's WebCrypto API (subtle.sign +
 * importKey).  No third-party JS crypto library on the hot path.
 */

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20; // 160 bits — RFC 4226 §4

/** ±1 step on each side of the current code.  90 seconds of total
 *  acceptance window centered on "now". */
const VERIFY_WINDOW_STEPS = 1;

/** Modulus table: 10^digits.  6 digits → 1_000_000. */
const TEN_TO_DIGITS = 10 ** DIGITS;

/* ───────────── base32 (RFC 4648, uppercase, no padding) ──────────── */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = new Map<string, number>();
for (let i = 0; i < BASE32_ALPHABET.length; i++) {
	BASE32_LOOKUP.set(BASE32_ALPHABET[i]!, i);
}

/** Encode raw bytes as RFC 4648 base32 (uppercase, no padding). */
export function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		value = (value << 8) | bytes[i]!;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
		}
	}
	if (bits > 0) {
		out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
	}
	return out;
}

/** Decode RFC 4648 base32 to bytes.  Tolerant of:
 *   - lowercase (uppercased before lookup)
 *   - spaces and dashes (stripped — users type "ABCD EFGH" from a QR)
 *   - missing padding (we don't require '=' at all)
 *
 * Throws if any non-alphabet character remains after stripping. */
export function base32Decode(s: string): Uint8Array {
	const cleaned = s.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
	if (cleaned.length === 0) return new Uint8Array(0);
	let bits = 0;
	let value = 0;
	const bytes: number[] = [];
	for (let i = 0; i < cleaned.length; i++) {
		const c = cleaned[i]!;
		const idx = BASE32_LOOKUP.get(c);
		if (idx === undefined) {
			throw new Error(`base32Decode: invalid character '${c}' at position ${i}`);
		}
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((value >>> bits) & 0xff);
		}
	}
	return new Uint8Array(bytes);
}

/* ───────────── secret generation ─────────────────────────────────── */

/** Generate a fresh 160-bit TOTP secret using crypto.getRandomValues. */
export function generateSecret(): Uint8Array {
	const bytes = new Uint8Array(SECRET_BYTES);
	crypto.getRandomValues(bytes);
	return bytes;
}

/* ───────────── otpauth:// URI for QR codes ───────────────────────── */

/** Build the otpauth:// URI string that gets QR-encoded for the user
 *  to scan with their authenticator app.  Follows the de-facto
 *  Google-Authenticator URI spec (also implemented by Aegis, 2FAS,
 *  Ente Auth, and ~every other authenticator).
 *
 *  Example:
 *    otpauth://totp/Morphit:alice?secret=JBSWY3DPEHPK3PXP&issuer=Morphit
 *
 *  Account label is the user's Morphit account name; issuer is
 *  hard-coded to "Morphit" so the authenticator displays a
 *  consistent label across instances.
 */
export function otpauthUri(account: string, secretB32: string): string {
	// Per the URI spec, label = "issuer:account", URL-encoded.
	const issuer = 'Morphit';
	const label = encodeURIComponent(`${issuer}:${account}`);
	const params = new URLSearchParams({
		secret: secretB32,
		issuer,
		algorithm: 'SHA1',
		digits: String(DIGITS),
		period: String(PERIOD_SECONDS)
	});
	return `otpauth://totp/${label}?${params.toString()}`;
}

/* ───────────── code computation (RFC 6238 + RFC 4226) ────────────── */

/** Compute the TOTP code for the given secret at the given time
 *  step.  The step is `floor(unix_seconds / PERIOD_SECONDS)`. */
async function computeCodeAtStep(secret: Uint8Array, step: number): Promise<string> {
	// RFC 4226 §5.2: HMAC counter is 8-byte big-endian.
	const counter = new Uint8Array(8);
	let s = step;
	// We only have safe-integer range; the high 4 bytes stay zero
	// until 2^32 steps elapse (≈4082 years from epoch at 30s/step).
	for (let i = 7; i >= 4; i--) {
		counter[i] = s & 0xff;
		s = Math.floor(s / 256);
	}
	for (let i = 3; i >= 0; i--) {
		counter[i] = s & 0xff;
		s = Math.floor(s / 256);
	}

	// Copy into a fresh Uint8Array so WebCrypto sees a stable
	// view backed by a non-shared ArrayBuffer.  Some WebCrypto
	// implementations dislike SharedArrayBuffer-backed views,
	// and TypeScript narrows .buffer to ArrayBufferLike
	// (which is the union of both) — be explicit.
	const secretCopy = new Uint8Array(secret);
	const key = await crypto.subtle.importKey(
		'raw',
		secretCopy,
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);
	const sigBuf = await crypto.subtle.sign('HMAC', key, counter);
	const sig = new Uint8Array(sigBuf);

	// RFC 4226 §5.3: dynamic truncation.
	const offset = sig[19]! & 0x0f;
	const binCode =
		((sig[offset]! & 0x7f) << 24) |
		((sig[offset + 1]! & 0xff) << 16) |
		((sig[offset + 2]! & 0xff) << 8) |
		(sig[offset + 3]! & 0xff);

	const code = binCode % TEN_TO_DIGITS;
	return code.toString().padStart(DIGITS, '0');
}

/** Compute the TOTP code for the given secret at the given unix
 *  timestamp (seconds since 1970).  Defaults to "now". */
export async function computeCode(
	secret: Uint8Array,
	atUnixSeconds: number = Math.floor(Date.now() / 1000)
): Promise<string> {
	const step = Math.floor(atUnixSeconds / PERIOD_SECONDS);
	return computeCodeAtStep(secret, step);
}

/* ───────────── verification (with ±1 step skew tolerance) ────────── */

/** Constant-time string equality.  Used in code verification so
 *  timing of mismatch doesn't leak which digit position differed.
 *  (Realistic threat — a network adversary in a remote-attack scenario
 *  wouldn't get useful precision, but it's free to do this right.) */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/** Verify a user-provided code against the secret, tolerating ±1
 *  time step of skew (90 seconds of total acceptance window).
 *  Returns the matching step offset (-1, 0, or +1) so the caller
 *  can detect codes used at a previous step (replay defense — the
 *  app should refuse to re-accept the same step's code for a short
 *  window, but the responsibility of remembering "last accepted
 *  step" belongs to the caller). */
export async function verifyCode(
	secret: Uint8Array,
	userCode: string,
	atUnixSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ valid: boolean; usedStep?: number }> {
	const cleaned = userCode.replace(/\s+/g, '');
	if (cleaned.length !== DIGITS || !/^\d{6}$/.test(cleaned)) {
		return { valid: false };
	}
	const baseStep = Math.floor(atUnixSeconds / PERIOD_SECONDS);
	for (let offset = -VERIFY_WINDOW_STEPS; offset <= VERIFY_WINDOW_STEPS; offset++) {
		const step = baseStep + offset;
		const expected = await computeCodeAtStep(secret, step);
		if (constantTimeEqual(expected, cleaned)) {
			return { valid: true, usedStep: step };
		}
	}
	return { valid: false };
}

/* ───────────── exported constants for UI/tests ──────────────────── */

export const TOTP_PERIOD_SECONDS = PERIOD_SECONDS;
export const TOTP_DIGITS = DIGITS;
export const TOTP_SECRET_BYTES = SECRET_BYTES;
export const TOTP_VERIFY_WINDOW_STEPS = VERIFY_WINDOW_STEPS;
