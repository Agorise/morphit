/**
 * Stream tickets, browser side (v1.21.14 full chat audit, S-M8).
 *
 * Both chat streams — `/v1/chat-activity/:account/stream` and
 * `/v1/chat/:a/:b/stream` — answer 403 without `?ticket=`: a short statement
 * signed by the account's POSTING key (the indexer's twin is
 * apps/indexer/src/api/streamTicket.ts):
 *
 *     <base64url JSON {"v":1,"a":account,"h":host,"e":expiry}>.<signature hex>
 *
 * signed over sha256("morphit-stream-ticket-v1\n" + <the base64url part>).
 *
 * Without it, anyone could hold an account's streams open on every instance and
 * tell, by which one showed a message first, which instance the account uses.
 *
 * WHERE A TICKET COMES FROM
 *   - An unlocked session signs one itself with the posting key in memory,
 *     valid MINTED_TTL_S, reused until it is within RENEW_BEFORE_S of expiry.
 *   - A paired (read-only) desktop holds no key: its phone signs a ticket for
 *     the pairing's life and hands it over with the pairing
 *     (PairingEnvelope.stream_ticket), stored in the paired-session record.
 *   - Neither: no ticket, and the caller opens no stream (it would be refused).
 *
 * `h` is the host name this page was loaded from — the name the browser uses
 * for this instance — so a ticket cannot be used at another instance.
 */
import { get } from 'svelte/store';
import { sha256 } from '@noble/hashes/sha2';

import { liveIdentity } from '$lib/stores/identity';
import { getUserBlurtAccount } from '$lib/blurt/ops/profile';
import { readPairedSession } from '$lib/crypto/pairedSession';
import {
	mintStreamTicket,
	MINTED_TTL_S,
	readStreamTicket,
	RENEW_BEFORE_S
} from './streamTicketCore';

export {
	mintStreamTicket,
	MINTED_TTL_S,
	PAIRED_TTL_S,
	readStreamTicket,
	RENEW_BEFORE_S,
	streamTicketDigest
} from './streamTicketCore';

/** The name the browser uses for this instance. */
function pageHost(): string {
	try {
		return globalThis.location?.hostname?.toLowerCase() ?? '';
	} catch {
		return '';
	}
}

/** Tickets this page signed, per account and host, with a one-way tag of the
 *  key that signed each (v1.21.14 review C, L2: a ticket cached under the
 *  account alone outlived a key change and was handed out for hours, then
 *  refused). */
const minted = new Map<string, { keyTag: string; ticket: string }>();

/** Test seam. */
export function _resetStreamTicketsForTest(): void {
	minted.clear();
}

/** Sign Out: forget every ticket this page signed. */
export function clearStreamTickets(): void {
	minted.clear();
}

function keyTagOf(postingPriv: Uint8Array): string {
	const h = sha256(postingPriv);
	let out = '';
	for (let i = 0; i < 8; i++) out += (h[i] ?? 0).toString(16).padStart(2, '0');
	return out;
}

/**
 * A ticket for `account`'s chat streams on this instance, or null when this
 * page cannot have one (locked, another account, no paired ticket).
 */
export function streamTicketFor(
	account: string,
	nowS: number = Math.floor(Date.now() / 1000)
): string | null {
	const host = pageHost();
	if (host === '' || account === '') return null;
	const key = `${account}\u0000${host}`;
	const live = get(liveIdentity);
	const unlocked = live !== null && getUserBlurtAccount() === account;
	const keyTag = unlocked ? keyTagOf(live.posting.privateKey) : null;
	const cached = minted.get(key);
	// A locked page keeps using the ticket its key signed; an unlocked one only
	// the ticket of the key it holds now.
	if (cached !== undefined && (keyTag === null || cached.keyTag === keyTag)) {
		const t = readStreamTicket(cached.ticket);
		if (t !== null && t.expires - nowS > RENEW_BEFORE_S) return cached.ticket;
	}
	if (unlocked && keyTag !== null) {
		minted.delete(key);
		try {
			const t = mintStreamTicket(live.posting.privateKey, account, host, MINTED_TTL_S, nowS);
			minted.set(key, { keyTag, ticket: t });
			return t;
		} catch {
			return null;
		}
	}
	const paired = readPairedSession();
	if (paired !== null && paired.account === account && typeof paired.streamTicket === 'string') {
		const t = readStreamTicket(paired.streamTicket);
		if (t !== null && t.account === account && t.host === host && t.expires > nowS)
			return paired.streamTicket;
	}
	return null;
}

/** `path` with `account`'s ticket added, or null when there is none (then
 *  open no stream: it would be refused). */
export function withStreamTicket(path: string, account: string): string | null {
	const t = streamTicketFor(account);
	if (t === null) return null;
	return `${path}${path.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(t)}`;
}
