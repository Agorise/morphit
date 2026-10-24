/**
 * Morphit — the operator's explorer link template check (pure: no imports,
 * so the ops-cli wizard's tests can compare all three validators).
 */

/** A Tor v3 onion host (56 base32 characters) or an I2P host: the only hosts
 *  a chat-link template may reach over plain `http://` (v1.21.15 — the hidden
 *  network encrypts and authenticates the connection, and hidden explorers
 *  serve http only). Mirrors apps/web urlsCore.isHiddenServiceHost. */
function isHiddenServiceHost(hostname: string): boolean {
	return /^[a-z2-7]{56}\.onion$/.test(hostname) || /^(?:[a-z0-9-]+\.)+i2p$/.test(hostname);
}

/** Validate a chat-link URL template.  Must start with https:// (or
 *  http:// to a Tor v3 onion or I2P host), contain literal `{txid}`, and
 *  parse as a URL after substitution with a placeholder txid.  Mirrors
 *  the ops-cli wizard's parseChatLinkTemplate and the web app's
 *  urlsCore.isValidChatLinkTemplate so the validation reasoning is
 *  identical at config-write time, config-load time and in the browser. */
export function isValidChatLinkTemplate(s: string): boolean {
	if (!s.startsWith('https://') && !s.startsWith('http://')) return false;
	if (!s.includes('{txid}')) return false;
	const sampleTxid = '0000000000000000000000000000000000000000000000000000000000000000';
	const filled = s.replace(/\{txid\}/g, sampleTxid);
	try {
		const parsed = new URL(filled);
		if (parsed.username !== '' || parsed.password !== '') return false;
		if (parsed.protocol === 'https:') return true;
		return parsed.protocol === 'http:' && isHiddenServiceHost(parsed.hostname);
	} catch {
		return false;
	}
}
