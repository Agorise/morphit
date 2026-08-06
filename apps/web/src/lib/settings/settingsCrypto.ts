/**
 * User-settings crypto (v1.5.0 — settings-to-chain mirroring).
 *
 * The user's device-local settings (notification prefs + quiet hours, privacy
 * toggles, syndication targets, hidden accounts, UI preferences) are mirrored
 * on chain so they follow the user to a fresh device — but publishing them in
 * the clear would leak the user's preferences and (worse) the accounts they've
 * hidden. So, exactly like chat folder-state (folderCrypto), we encrypt the
 * whole settings blob with a key derived from the POSTING private key via the
 * SAME BLAKE2b-256 keyed-derivation, DOMAIN-SEPARATED by a distinct info tag
 * (`morphit-settings-v1/...`) so it can never collide with the folder key or a
 * chat-identity key. This means:
 *   - posting-key-only users are fully supported (no memo key needed);
 *   - the key is already in memory whenever the user is signed in;
 *   - an outside observer (and the operator) sees only an opaque blob.
 *
 * Cipher matches chat messages + folders: ChaCha20-Poly1305 IETF (12-byte
 * nonce), wire format base64(nonce || ciphertext+tag).
 */
// cp471 (tt.txt K): MUST be the lazy accessor, never a static
// `import sodium from 'libsodium-wrappers-sumo'`. This module is reachable
// from the shared [lang] layout (layout → settingsSync → here), so a static
// import drags libsodium's ~1 MB into the modulepreload closure of EVERY
// page — home, orderbook, FAQ — even for visitors who never sign in. That is
// exactly the regression `libsodium-not-in-baseline-closure-smoke` exists to
// catch, and v1.5.0's settings-to-chain feature reintroduced it. See
// $crypto/sodium's header (cp267 measured 1040 KB on the baseline).
//
// Safe by the same contract keygen/keystore use: every sodium.* call below is
// preceded by `await ready()` (→ ensureSodium()), so the binding is always
// populated before it is read.
import { sodium, ensureSodium } from '$crypto/sodium';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** ChaCha20-Poly1305 IETF nonce length. */
const NONCE_BYTES = 12;
/** Poly1305 tag length — used only to sanity-check a blob's minimum size. */
const TAG_BYTES = 16;

async function ready(): Promise<void> {
	await ensureSodium();
}

/**
 * Derive the 32-byte symmetric settings-state key from the posting private key.
 * BLAKE2b-256 keyed (key = postingPriv, message = domain-separated info). The
 * info tag differs from the folder key's, so the two keys can never collide.
 */
async function deriveSettingsKey(postingPriv: Uint8Array, account: string): Promise<Uint8Array> {
	await ready();
	if (postingPriv.length !== 32) {
		throw new Error(`settings crypto: posting priv must be 32 bytes, got ${postingPriv.length}`);
	}
	if (account.length === 0) {
		throw new Error('settings crypto: account name must not be empty');
	}
	const info = enc.encode(`morphit-settings-v1/state/${account}`);
	return sodium.crypto_generichash(32, info, postingPriv);
}

function aadFor(account: string): Uint8Array {
	return enc.encode(`morphit-settings-v1/${account}`);
}

/**
 * Encrypt a settings object to a compact base64 blob for the op payload. The
 * posting private key never leaves this function; the derived key is wiped.
 */
export async function encryptSettingsState(
	postingPriv: Uint8Array,
	account: string,
	state: unknown
): Promise<string> {
	await ready();
	const key = await deriveSettingsKey(postingPriv, account);
	try {
		const plaintext = enc.encode(JSON.stringify(state));
		const nonce = sodium.randombytes_buf(NONCE_BYTES);
		const ct = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
			plaintext,
			aadFor(account),
			null,
			nonce,
			key
		);
		const combined = new Uint8Array(nonce.length + ct.length);
		combined.set(nonce, 0);
		combined.set(ct, nonce.length);
		return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
	} finally {
		sodium.memzero(key);
	}
}

/**
 * Decrypt a settings blob. Returns null on ANY failure (corrupt base64,
 * wrong/rotated key, tampered ciphertext, bad JSON) so the caller can fall back
 * to device-local defaults without throwing. The derived key is always wiped.
 */
export async function decryptSettingsState(
	postingPriv: Uint8Array,
	account: string,
	blob: string
): Promise<unknown | null> {
	await ready();
	let key: Uint8Array | null = null;
	try {
		key = await deriveSettingsKey(postingPriv, account);
		const combined = sodium.from_base64(blob, sodium.base64_variants.ORIGINAL);
		if (combined.length < NONCE_BYTES + TAG_BYTES) return null;
		const nonce = combined.slice(0, NONCE_BYTES);
		const ct = combined.slice(NONCE_BYTES);
		const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
			null,
			ct,
			aadFor(account),
			nonce,
			key
		);
		return JSON.parse(dec.decode(plaintext));
	} catch {
		return null;
	} finally {
		if (key !== null) sodium.memzero(key);
	}
}
