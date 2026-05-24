/**
 * Minimal ambient declaration for `libsodium-wrappers-sumo`.
 *
 * The package ships no TypeScript types of its own.  We declare
 * only the API surface Morphit actually consumes — anything not
 * listed here will trigger a typecheck error when first used,
 * which is the right time to extend this file.
 *
 * Usage in the codebase is exclusively via the default export:
 *   import sodium from 'libsodium-wrappers-sumo';
 *
 * so the named exports are intentionally absent — the default
 * export carries the full surface area as a typed interface.
 */
declare module 'libsodium-wrappers-sumo' {
	/** Symmetric base64 encoding-variant codes (sodium uses these
	 *  as integer flags to switch padding + URL-safety on the
	 *  to_base64 / from_base64 helpers). */
	interface Base64Variants {
		ORIGINAL: number;
		ORIGINAL_NO_PADDING: number;
		URLSAFE: number;
		URLSAFE_NO_PADDING: number;
	}

	/** The actual surface Morphit calls. */
	interface LibsodiumModule {
		/** Awaited before any other sodium call.  The library is
		 *  lazy-initialized — calling any method before this resolves
		 *  throws "sodium not ready". */
		ready: Promise<void>;

		// ── Length / algorithm constants ────────────────────────
		crypto_pwhash_ALG_ARGON2ID13: number;
		crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
		crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
		/** "Moderate" parameters — slower than INTERACTIVE; used for
		 *  hashes of low-entropy values (e.g. TOTP backup codes,
		 *  ~40 bits) where extra slowness is the defense. */
		crypto_pwhash_MEMLIMIT_MODERATE: number;
		crypto_pwhash_OPSLIMIT_MODERATE: number;
		crypto_pwhash_SALTBYTES: number;
		crypto_secretbox_KEYBYTES: number;
		crypto_secretbox_NONCEBYTES: number;

		base64_variants: Base64Variants;

		// ── Random ──────────────────────────────────────────────
		randombytes_buf(length: number): Uint8Array;
		randombytes_uniform(upperBound: number): number;

		// ── Hashes ──────────────────────────────────────────────
		crypto_generichash(
			hashLength: number,
			message: Uint8Array | string,
			key?: Uint8Array | null
		): Uint8Array;
		crypto_hash_sha256(message: Uint8Array | string): Uint8Array;

		// ── Password hashing (Argon2id) ─────────────────────────
		crypto_pwhash(
			keyLength: number,
			password: Uint8Array | string,
			salt: Uint8Array,
			opsLimit: number,
			memLimit: number,
			algorithm: number
		): Uint8Array;
		/** Self-contained password hashing — libsodium picks the
		 *  salt and packs the params into a portable string format
		 *  ("$argon2id$...").  Used for TOTP backup-code storage. */
		crypto_pwhash_str(
			password: Uint8Array | string,
			opsLimit: number,
			memLimit: number
		): string;
		/** Verify a password against a self-contained hash string
		 *  produced by crypto_pwhash_str.  Constant-time. */
		crypto_pwhash_str_verify(hash: string, password: Uint8Array | string): boolean;

		// ── X25519 key-agreement ────────────────────────────────
		crypto_scalarmult_base(secretKey: Uint8Array): Uint8Array;
		crypto_scalarmult(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array;

		// ── secretbox (XSalsa20-Poly1305) ───────────────────────
		crypto_secretbox_easy(
			message: Uint8Array | string,
			nonce: Uint8Array,
			key: Uint8Array
		): Uint8Array;
		crypto_secretbox_open_easy(
			ciphertext: Uint8Array,
			nonce: Uint8Array,
			key: Uint8Array
		): Uint8Array;

		// ── ChaCha20-Poly1305-IETF AEAD ─────────────────────────
		crypto_aead_chacha20poly1305_ietf_encrypt(
			message: Uint8Array | string,
			additionalData: Uint8Array | string | null,
			secretNonce: null,
			publicNonce: Uint8Array,
			key: Uint8Array
		): Uint8Array;
		crypto_aead_chacha20poly1305_ietf_decrypt(
			secretNonce: null,
			ciphertext: Uint8Array,
			additionalData: Uint8Array | string | null,
			publicNonce: Uint8Array,
			key: Uint8Array
		): Uint8Array;

		// ── Encoding helpers ────────────────────────────────────
		from_base64(input: string, variant?: number): Uint8Array;
		to_base64(input: Uint8Array, variant?: number): string;
		from_hex(input: string): Uint8Array;
		to_hex(input: Uint8Array): string;
		from_string(input: string): Uint8Array;
		to_string(input: Uint8Array): string;

		// ── Memory hygiene ──────────────────────────────────────
		memcmp(a: Uint8Array, b: Uint8Array): boolean;
		memzero(buf: Uint8Array): void;
	}

	const sodium: LibsodiumModule;
	export default sodium;
}
