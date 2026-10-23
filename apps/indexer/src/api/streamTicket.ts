/**
 * Stream tickets: who may watch an account's chat streams
 * (v1.21.14 full chat audit, S-M8 and S-M7).
 *
 * WHAT WAS WRONG. `/v1/chat-activity/:account/stream` and
 * `/v1/chat/:a/:b/stream` answered anyone. Every instance shows a message on
 * the SENDER's own instance first — local delivery, as soon as the node takes
 * it, before any block — while every other instance learns of it only from a
 * federation push or a block. So anybody holding one of those public streams
 * open for an account on every instance could tell, by which instance spoke
 * first, which instance that account uses: the very fact the chain does not
 * record and the leak catalogue said was not revealed. And because no stream
 * named a client, every Tor and I2P visitor shared one stream allowance, so one
 * anonymous client could hold all of it and leave every hidden-service user
 * without live chat (S-M7).
 *
 * NOW. Both streams need a TICKET: a short statement signed by the account's
 * posting key —
 *
 *     <base64url JSON {"v":1,"a":account,"h":host,"e":expiry}>.<signature hex>
 *
 * signed over sha256("morphit-stream-ticket-v1\n" + <the base64url part>).
 *   - `a`: the account it lets one watch (an activity stream for `a`, or a
 *     conversation `a` is part of);
 *   - `h`: the host name the browser used for THIS instance (one of the names
 *     it answers to, `instanceHosts`), so a ticket cannot be used at another
 *     instance;
 *   - `e`: when it expires, unix seconds, at most STREAM_TICKET_MAX_TTL_S ahead
 *     (a paired desktop holds one for its pairing's life; an unlocked session
 *     mints a short one).
 * The key is the posting key that can sign alone, from the same lookup the
 * fast path uses (database, else two agreeing RPC operators). A verified
 * ticket is remembered for ten minutes (within its life), so a reconnect costs
 * nothing and a key rotated away stops opening streams soon.
 *
 * With the account known, the stream caps can count a hidden-service stream
 * against ITS ACCOUNT rather than the shared allowance (streamCaps.ts).
 */
import { createHash } from 'node:crypto';
import { hiddenHostNetworkOf } from '@morphit/hidden-transport';

/** The longest a ticket may run (a pairing's life). */
export const STREAM_TICKET_MAX_TTL_S = 372 * 24 * 3600;
/** How long a verified ticket is taken on trust before its key is looked up
 *  again. */
const VERIFIED_FOR_MS = 10 * 60 * 1000;
/** Tickets remembered as verified, at most. */
const VERIFIED_MAX = 10_000;
const DOMAIN = 'morphit-stream-ticket-v1\n';
const ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

export interface StreamTicket {
	readonly account: string;
	readonly host: string;
	readonly expires: number;
}

/** The posting key that can sign alone for `account` (null: none / unknown).
 *  `signedBy` lets the lookup confirm a rotation it has not recorded yet. */
export type TicketKeyLookup = (
	account: string,
	opts?: {
		signedBy?: (key: string) => boolean;
		refresh?: boolean;
		/** false: answer from this instance alone (no chain read). */
		network?: boolean;
		/** Always 'ticket' from here: see RefreshBudget in chatFastFederation. */
		budget?: 'ticket';
	}
) => Promise<string | null>;

export type TicketVerdict =
	| { readonly ok: true; readonly ticket: StreamTicket }
	| { readonly ok: false; readonly reason: string };

/** The bytes a ticket's signature covers. Exported for the browser's twin
 *  and the tests. */
export function streamTicketDigest(payloadB64: string): Buffer {
	return createHash('sha256')
		.update(DOMAIN + payloadB64, 'utf8')
		.digest();
}

/**
 * Every name this instance answers to, for a ticket's `h`: its configured
 * origins and hidden addresses, and the name this request arrived under. The
 * configured names are what make a clearnet ticket work whatever `Host` the
 * edge proxy forwards; the request's own name is what makes it work for a
 * hidden address the operator never wrote into the environment.
 */
export function instanceHosts(
	configured: readonly (string | undefined | null)[],
	hostHeader: string | undefined | null
): string[] {
	const out = new Set<string>();
	for (const v of configured) {
		if (typeof v !== 'string' || v.trim() === '') continue;
		let h = v.trim();
		try {
			h = new URL(/^[a-z]+:\/\//i.test(h) ? h : `http://${h}`).hostname;
		} catch {
			continue;
		}
		out.add(h.toLowerCase());
	}
	// The name the request arrived under counts ONLY for a hidden network the
	// operator configured no address for (an onion never written into the
	// environment). A clearnet Host, or a hidden one beside a configured
	// address of its network, is the caller's word — and accepting it let a
	// ticket made for one instance open streams on another (independent
	// review of the audit fixes, finding 8).
	const own = requestHost(hostHeader);
	const net = hiddenHostNetworkOf(own);
	if (net !== null && ![...out].some((h) => hiddenHostNetworkOf(h) === net)) out.add(own);
	return [...out];
}

/** The host a request names, lowercased, without a port. */
export function requestHost(hostHeader: string | undefined | null): string {
	const h = (hostHeader ?? '').trim().toLowerCase();
	if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
	const colon = h.lastIndexOf(':');
	return colon > 0 ? h.slice(0, colon) : h;
}

function parse(token: string): { payloadB64: string; sig: string; ticket: StreamTicket } | null {
	if (token.length === 0 || token.length > 600) return null;
	const dot = token.lastIndexOf('.');
	if (dot <= 0) return null;
	const payloadB64 = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[0-9a-f]{130}$/.test(sig)) return null;
	let p: unknown;
	try {
		p = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (typeof p !== 'object' || p === null) return null;
	const o = p as { v?: unknown; a?: unknown; h?: unknown; e?: unknown };
	if (o.v !== 1) return null;
	if (typeof o.a !== 'string' || !ACCOUNT_RE.test(o.a)) return null;
	if (typeof o.h !== 'string' || o.h.length === 0 || o.h.length > 255) return null;
	if (typeof o.e !== 'number' || !Number.isInteger(o.e)) return null;
	return { payloadB64, sig, ticket: { account: o.a, host: o.h.toLowerCase(), expires: o.e } };
}

/** Signature recoveries per second for new tickets naming an account whose
 *  key this instance does NOT hold (a recovery costs about 2.5 ms of CPU). */
export const TICKET_RECOVER_PER_SEC = 40;
/** …and for new tickets naming an account whose key it holds. Separate, so a
 *  flood of junk tickets naming made-up accounts cannot turn real members away
 *  (independent review 2, finding 3); above the shared Tor/I2P rate limit
 *  (50 requests a second), so one hidden-service client cannot use it up. */
export const TICKET_RECOVER_KNOWN_PER_SEC = 100;
const recoverTimes: number[] = [];
const knownRecoverTimes: number[] = [];
function recoverAllowed(times: number[], max: number, nowMs: number): boolean {
	while (times.length > 0 && (times[0] ?? 0) <= nowMs - 1000) times.shift();
	if (times.length >= max) return false;
	times.push(nowMs);
	return true;
}

/** token → when it stops being valid (ms), for tickets already verified. */
const verified = new Map<string, { ticket: StreamTicket; untilMs: number }>();

/** Test seam. */
export function _resetStreamTicketsForTest(): void {
	verified.clear();
	recoverTimes.length = 0;
	knownRecoverTimes.length = 0;
}

/**
 * Check a ticket for a stream on `host` that `allowed` accounts may watch.
 * Never throws.
 */
export async function verifyStreamTicket(
	token: string | undefined | null,
	allowed: readonly string[],
	/** The names this instance answers to (see `instanceHosts`). */
	hosts: readonly string[],
	lookup: TicketKeyLookup,
	nowMs: number = Date.now()
): Promise<TicketVerdict> {
	if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing' };
	const known = verified.get(token);
	if (known !== undefined) {
		if (nowMs >= known.untilMs) {
			verified.delete(token);
			return verifyStreamTicket(token, allowed, hosts, lookup, nowMs);
		}
		if (!allowed.includes(known.ticket.account)) return { ok: false, reason: 'wrong_account' };
		if (!hosts.includes(known.ticket.host)) return { ok: false, reason: 'wrong_host' };
		return { ok: true, ticket: known.ticket };
	}
	const parsed = parse(token);
	if (parsed === null) return { ok: false, reason: 'malformed' };
	const { ticket } = parsed;
	const nowS = Math.floor(nowMs / 1000);
	if (ticket.expires <= nowS) return { ok: false, reason: 'expired' };
	if (ticket.expires - nowS > STREAM_TICKET_MAX_TTL_S) return { ok: false, reason: 'too_long' };
	if (!allowed.includes(ticket.account)) return { ok: false, reason: 'wrong_account' };
	if (!hosts.includes(ticket.host)) return { ok: false, reason: 'wrong_host' };
	// The key this instance already holds for the account, if any (no chain
	// read): a member's ticket is checked against it under its own budget.
	let localKey: string | null = null;
	try {
		localKey = await lookup(ticket.account, { network: false, budget: 'ticket' });
	} catch {
		localKey = null;
	}
	// Recovering the key costs a few ms of CPU; a junk ticket always gets this
	// far. Bounded like the pre-send check on /v1/broadcast (S-M6).
	const mayRecover =
		localKey !== null && localKey !== ''
			? recoverAllowed(knownRecoverTimes, TICKET_RECOVER_KNOWN_PER_SEC, nowMs)
			: recoverAllowed(recoverTimes, TICKET_RECOVER_PER_SEC, nowMs);
	if (!mayRecover) return { ok: false, reason: 'busy' };
	let signer: string;
	try {
		const { Signature } = await import('@beblurt/dblurt');
		signer = Signature.fromString(parsed.sig)
			.recover(streamTicketDigest(parsed.payloadB64))
			.toString();
	} catch {
		return { ok: false, reason: 'bad_signature' };
	}
	const signedBy = (k: string): boolean => k === signer;
	let key: string | null = localKey;
	try {
		// Chain reads made for a ticket are charged to their OWN budget: anyone
		// can present a ticket naming any account, and these reads must never
		// spend the budgets message delivery depends on (independent review of
		// the audit fixes, finding 1).
		if (key === null) key = await lookup(ticket.account, { signedBy, budget: 'ticket' });
		// The key on file may be one the account has since rotated away from
		// (the chain changed it and this instance has not caught up): ask the
		// chain once, as the fast path does for a message (bounded by the same
		// refresh budget). Found in the end-to-end rig: an account with a stale
		// key on file got no live chat at all.
		if (key !== signer)
			key = await lookup(ticket.account, { signedBy, refresh: true, budget: 'ticket' });
	} catch {
		return { ok: false, reason: 'key_unavailable' };
	}
	if (key === null || key !== signer) return { ok: false, reason: 'bad_signature' };
	if (verified.size >= VERIFIED_MAX) {
		const oldest = verified.keys().next().value;
		if (oldest !== undefined) verified.delete(oldest);
	}
	// Remembered for VERIFIED_FOR_MS at most, not for the ticket's life: a key
	// rotated away (a leak) must stop opening streams soon, not in a month.
	verified.set(token, {
		ticket,
		untilMs: Math.min(ticket.expires * 1000, nowMs + VERIFIED_FOR_MS)
	});
	return { ok: true, ticket };
}
