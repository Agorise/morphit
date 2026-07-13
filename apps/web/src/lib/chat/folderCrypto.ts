/**
 * Chat folder-state crypto (t.txt v1.4.9 #5).
 *
 * The user's chat folder organization (which threads are kept in Inbox /
 * Starred) is stored on chain so it syncs across devices — but the chat GRAPH
 * is already public, and publishing the organization in the clear would make a
 * user's preferences trivially readable. So we encrypt it with a key derived
 * from the POSTING private key, using the SAME BLAKE2b-256 keyed-derivation
 * pattern as `deriveChatIdentity` (crypto.ts) — domain-separated by a distinct
 * info tag. This means:
 *   - posting-key-only users are fully supported (no memo key needed);
 *   - the key is already in memory whenever the user is in chat (it's needed to
 *     decrypt messages), so reading the folder state adds no extra unlock;
 *   - an outside observer sees only an opaque blob.
 *
 * Cipher matches chat messages: ChaCha20-Poly1305 IETF (12-byte nonce), wire
 * format base64(nonce || ciphertext+tag).
 */
import sodium from 'libsodium-wrappers-sumo';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** ChaCha20-Poly1305 IETF nonce length. */
const NONCE_BYTES = 12;
/** Poly1305 tag length — used only to sanity-check a blob's minimum size. */
const TAG_BYTES = 16;

async function ready(): Promise<void> {
	await sodium.ready;
}

/**
 * Derive the 32-byte symmetric folder-state key from the posting private key.
 * BLAKE2b-256 keyed (key = postingPriv, message = domain-separated info), the
 * same construction chat identity keys use — so it can never collide with
 * them. This is a symmetric key (no X25519 clamping): it feeds the AEAD.
 */
async function deriveFolderKey(postingPriv: Uint8Array, account: string): Promise<Uint8Array> {
	await ready();
	if (postingPriv.length !== 32) {
		throw new Error(`folder crypto: posting priv must be 32 bytes, got ${postingPriv.length}`);
	}
	if (account.length === 0) {
		throw new Error('folder crypto: account name must not be empty');
	}
	const info = enc.encode(`morphit-chat-folders-v1/state/${account}`);
	return sodium.crypto_generichash(32, info, postingPriv);
}

function aadFor(account: string): Uint8Array {
	return enc.encode(`morphit-chat-folders-v1/${account}`);
}

/**
 * Encrypt a folder-state object to a compact base64 blob for the op payload.
 * The posting private key never leaves this function; the derived key is wiped.
 */
export async function encryptFolderState(
	postingPriv: Uint8Array,
	account: string,
	state: unknown
): Promise<string> {
	await ready();
	const key = await deriveFolderKey(postingPriv, account);
	try {
		const plaintext = enc.encode(JSON.stringify(state));
		const nonce = sodium.randombytes_buf(NONCE_BYTES);
		const ct = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
			plaintext,
			aadFor(account),
			null, // nsec — ietf variant ignores this
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
 * Decrypt a folder-state blob. Returns null on ANY failure (corrupt base64,
 * wrong/rotated key, tampered ciphertext, bad JSON) so the caller can fall back
 * to defaults without throwing. The derived key is always wiped.
 */
export async function decryptFolderState(
	postingPriv: Uint8Array,
	account: string,
	blob: string
): Promise<unknown | null> {
	await ready();
	let key: Uint8Array | null = null;
	try {
		key = await deriveFolderKey(postingPriv, account);
		const combined = sodium.from_base64(blob, sodium.base64_variants.ORIGINAL);
		if (combined.length < NONCE_BYTES + TAG_BYTES) return null;
		const nonce = combined.slice(0, NONCE_BYTES);
		const ct = combined.slice(NONCE_BYTES);
		const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
			null, // nsec
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
