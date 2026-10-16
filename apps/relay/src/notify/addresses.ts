/**
 * Offline notices — what counts as an address on each channel, PURE.
 *
 * Normalised so the same address typed two ways is one address (for the
 * per-address code limit), and refused when it could do harm: nothing with a
 * line break (an email header or an XMPP stanza), nothing over the length a
 * real address has.
 */

export const CHANNELS = ['matrix', 'session', 'xmpp', 'telegram', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(v: unknown): v is Channel {
	return typeof v === 'string' && (CHANNELS as readonly string[]).includes(v);
}

/** Channels where she types an address (Telegram links through its bot). */
export type AddressChannel = Exclude<Channel, 'telegram'>;

const DOMAIN = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]';
const EMAIL_RE = new RegExp(`^[a-z0-9.!#$%&'*+/=?^_\`{|}~-]{1,64}@${DOMAIN}$`, 'i');
// Matrix user ID: @localpart:server[:port] (spec: localpart a-z 0-9 . _ = - / +).
const MATRIX_RE = new RegExp(`^@[a-z0-9._=/+-]{1,200}:${DOMAIN}(?::[0-9]{1,5})?$`);
// XMPP bare JID (no resource): node@domain. Node may not hold " & ' / : < > @.
const XMPP_RE = new RegExp(`^[^\\s"&'/:<>@]{1,64}@${DOMAIN}$`, 'i');
// Session ID: 05 + 64 hex (an X25519 public key).
const SESSION_RE = /^05[0-9a-f]{64}$/;

/** The address in its one canonical form, or null when it is not one. */
export function normalizeAddress(channel: AddressChannel, raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const v = raw.trim();
	if (v.length === 0 || v.length > 254 || /[\r\n\t\u0000]/.test(v)) return null;
	switch (channel) {
		case 'email': {
			if (!EMAIL_RE.test(v)) return null;
			const at = v.lastIndexOf('@');
			return `${v.slice(0, at)}@${v.slice(at + 1).toLowerCase()}`;
		}
		case 'matrix': {
			const m = v.toLowerCase();
			return MATRIX_RE.test(m) ? m : null;
		}
		case 'xmpp': {
			// The form XMPP servers compare (PRECIS: width-folded, compatibility-
			// normalised, lower-cased), and nothing invisible: a control, format
			// (zero-width, bidi), private-use, unassigned or space character would
			// make one account look like several to the per-address limit while
			// the server delivers to the same one.
			const m = v.normalize('NFKC').toLowerCase();
			if (/[\p{C}\p{Z}]/u.test(m)) return null;
			return XMPP_RE.test(m) ? m : null;
		}
		case 'session': {
			const m = v.toLowerCase();
			return SESSION_RE.test(m) ? m : null;
		}
	}
}

/** Mail providers that ignore dots in the local part. */
const DOTLESS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The form an address is COUNTED under for the per-address code limit, PURE:
 * one mailbox written several ways is one mailbox. Email: the local part
 * lower-cased (almost every server ignores its case), a `+tag` dropped, and
 * Gmail's dots dropped. Never used to send — only to count.
 */
export function countingKey(channel: AddressChannel, address: string): string {
	if (channel !== 'email') return address.toLowerCase();
	const at = address.lastIndexOf('@');
	const domain = address.slice(at + 1).toLowerCase();
	let local = address.slice(0, at).toLowerCase();
	const plus = local.indexOf('+');
	if (plus > 0) local = local.slice(0, plus);
	if (DOTLESS.has(domain)) local = local.replace(/\./g, '');
	return `${local}@${domain === 'googlemail.com' ? 'gmail.com' : domain}`;
}
