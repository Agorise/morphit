/**
 * Morphit — what the browser takes away outside a "secure context".
 *
 * An https:// page, Tor Browser's .onion pages and localhost are secure
 * contexts. A plain-HTTP I2P address (`http://….b32.i2p`, e.g. Firefox with an
 * I2P proxy) is NOT, so the browser removes:
 *   - crypto.subtle      → authenticator (TOTP) codes, the safety-number
 *                          check with a peer, the "About this instance" hash;
 *   - navigator.clipboard → copy buttons;
 *   - service workers    → offline mode, update prompts, push notifications.
 * Everything built on libsodium / WebAssembly (keys, signing, chat
 * encryption, backup codes) keeps working.
 *
 * (v1.20.0 review, F-9.) Use these helpers instead of touching those APIs
 * directly, so the missing feature is reported calmly rather than crashing.
 */

/** True when WebCrypto's subtle API is present (secure contexts only). */
export function webCryptoAvailable(): boolean {
	const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
	return (
		subtle !== undefined &&
		subtle !== null &&
		typeof subtle.importKey === 'function' &&
		typeof subtle.digest === 'function'
	);
}

/** True only when the browser positively reports an insecure context. */
export function isInsecureContext(): boolean {
	return (
		typeof window !== 'undefined' &&
		(window as { isSecureContext?: boolean }).isSecureContext === false
	);
}

/** Copy text to the clipboard. Resolves false (never throws) when the
 *  clipboard API is missing (insecure context) or the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
	const clip =
		typeof navigator === 'undefined'
			? undefined
			: (navigator as { clipboard?: { writeText?: (t: string) => Promise<void> } }).clipboard;
	if (!clip || typeof clip.writeText !== 'function') return false;
	try {
		await clip.writeText(text);
		return true;
	} catch {
		return false;
	}
}
