/**
 * Stream tickets — the pure part (signing, reading), shared by the browser
 * session wrapper (streamTicket.ts) and the indexer's interop test. No
 * aliases, no stores: dblurt and noble only.
 *
 * Wire format and digest: apps/indexer/src/api/streamTicket.ts.
 */
import { PrivateKey } from '@beblurt/dblurt';
import { sha256 } from '@noble/hashes/sha2';

const DOMAIN = 'morphit-stream-ticket-v1\n';
const enc = new TextEncoder();

/** A paired desktop's ticket, signed by its phone: as long as the pairing is
 *  accepted (pairedSession MAX_PAIRED_AGE_SECONDS, a year). It was 30 days, so
 *  a paired desktop lost live chat for good a month into a year-long pairing
 *  (v1.21.14 review C, L1). The indexer accepts a week more than this
 *  (STREAM_TICKET_MAX_TTL_S), for a phone whose clock runs fast. A ticket stops
 *  opening streams as soon as the account's posting key changes. */
export const PAIRED_TTL_S = 365 * 24 * 3600;
/**
 * A ticket an unlocked session signs for itself, dated by the DEVICE clock and
 * judged by the server's. Seven days, re-signed once a day (RENEW_BEFORE_S): a
 * device up to six days slow still holds a ticket the server takes, at every
 * reuse. It was six hours, so a device a few hours slow — a dual-boot machine
 * keeping local time in its hardware clock, a phone set by hand — signed
 * tickets that were already expired and kept reusing them: no live chat,
 * silently (v1.21.14 review B, F2).
 */
export const MINTED_TTL_S = 7 * 24 * 3600;
/** Signed again when this close to expiry (by the device clock). */
export const RENEW_BEFORE_S = 6 * 24 * 3600;

function base64Url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes a ticket's signature covers (same as the indexer's). */
export function streamTicketDigest(payloadB64: string): Uint8Array {
	return sha256(enc.encode(DOMAIN + payloadB64));
}

/** Sign a ticket for `account` on `host`, valid `ttlS` from `nowS`. */
export function mintStreamTicket(
	postingPriv: Uint8Array,
	account: string,
	host: string,
	ttlS: number,
	nowS: number = Math.floor(Date.now() / 1000)
): string {
	const payload = base64Url(
		enc.encode(JSON.stringify({ v: 1, a: account, h: host, e: nowS + ttlS }))
	);
	const key = new PrivateKey(postingPriv as unknown as Buffer);
	const sig = key.sign(streamTicketDigest(payload) as unknown as Buffer);
	return `${payload}.${sig.toString()}`;
}

/** The account, host and expiry a ticket names, or null if it is not one. */
export function readStreamTicket(
	token: string
): { account: string; host: string; expires: number } | null {
	const dot = token.lastIndexOf('.');
	if (dot <= 0) return null;
	try {
		const b64 = token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
		const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
		const p = JSON.parse(raw) as { v?: unknown; a?: unknown; h?: unknown; e?: unknown };
		if (p.v !== 1 || typeof p.a !== 'string' || typeof p.h !== 'string') return null;
		if (typeof p.e !== 'number') return null;
		return { account: p.a, host: p.h, expires: p.e };
	} catch {
		return null;
	}
}
