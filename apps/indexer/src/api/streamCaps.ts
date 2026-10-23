/**
 * Morphit indexer — caps on open SSE streams.
 *
 * WHAT WAS WRONG. The SSE routes (orderbook, chat, chat-activity,
 * instances; the login-pairing wait since) had no limit of any kind: no rate limit on connecting, no cap on
 * how many stay open. The comments said per-IP connection caps "belong at the
 * reverse proxy" — but the shipped BunkerWeb frontend sets none, and Tor/I2P
 * visitors reach it without passing BunkerWeb at all. Every open stream costs
 * a snapshot query on connect and its own background work after, so a few
 * hundred idle connections from one client were a steady database load
 * nobody else could get past.
 *
 * NOW, three caps, all answered with 503 (the stream is unavailable right
 * now; the client's own backoff retries):
 *   - PER CLIENT, keyed exactly as the rate limiter keys requests. Not applied
 *     to a SHARED key — our own proxy's address, which stands for every Tor/I2P
 *     visitor at once; capping it like one client would cap the whole
 *     hidden-service audience.
 *   - SHARED: every stream through a shared key — anonymous or ticketed —
 *     counts here, so the hidden-service audience cannot take the slots
 *     clearnet visitors need (on a zero-clearnet node it is simply the
 *     audience's ceiling). Ticketed streams counted too since the independent
 *     review of the audit fixes (finding 5): without that, 84 accounts × 24
 *     streams took every slot of the instance.
 *   - ANONYMOUS SHARED: streams through a shared key WITHOUT a ticket hold at
 *     most this many of the shared allowance, so one anonymous client cannot
 *     leave hidden-service users without live chat (v1.21.14, S-M7);
 *   - PER ACCOUNT, for a chat stream through a shared key: it carries a
 *     ticket its account signed (streamTicket.ts), so it is counted against
 *     that account (S-M7);
 *   - INSTANCE-WIDE, which bounds everything else.
 *
 * A slot is released when the stream ends (the client leaves, or the stream
 * closes itself), exactly once.
 */
import type { Context } from 'hono';
import { requestClient } from '$api/middleware/ratelimit';

/** Streams one client may hold open. A browser tab opens up to four (orderbook,
 *  chat, chat activity, directory); this leaves room for several tabs. */
export const DEFAULT_STREAMS_PER_CLIENT = 24;
/** Streams the instance holds open in total. */
export const DEFAULT_STREAMS_GLOBAL = 2_000;
/** Streams all SHARED keys (the Tor/I2P gateway) may hold together,
 *  ticketed or not: the rest of the instance-wide cap stays for clearnet. */
export const DEFAULT_STREAMS_SHARED = 1_500;
/** Of those, the most that may be anonymous (no ticket): the rest stays for
 *  hidden-service users' own chat streams. */
export const DEFAULT_STREAMS_ANON_SHARED = 1_000;
/** Streams one ACCOUNT may hold through a shared key (v1.21.14 full chat
 *  audit, S-M7): a chat stream names its account with a ticket only that
 *  account can sign (streamTicket.ts), so a hidden-service visitor's chat
 *  streams are counted against their account, not the allowance every
 *  anonymous visitor shares — one anonymous client can no longer take every
 *  hidden-service user's live chat. A browser holds at most three per tab
 *  (W-H2), so this is four tabs; lowered from 24 so that filling the shared
 *  allowance takes 125 accounts, not 63 (independent review 2, finding 4). */
export const DEFAULT_STREAMS_PER_ACCOUNT = 12;

let perClientCap = DEFAULT_STREAMS_PER_CLIENT;
let globalCap = DEFAULT_STREAMS_GLOBAL;
let sharedCap = DEFAULT_STREAMS_SHARED;
let anonSharedCap = DEFAULT_STREAMS_ANON_SHARED;
let perAccountCap = DEFAULT_STREAMS_PER_ACCOUNT;
const perClient = new Map<string, number>();
let open = 0;
let openShared = 0;
let openAnonShared = 0;

/**
 * Take a slot for a new stream. Returns the release function, or null when a
 * cap is reached (answer 503). The release is idempotent.
 */
export function acquireStreamSlot(
	c: Context,
	/** The account a verified stream ticket names, when there is one. */
	account?: string
): (() => void) | null {
	if (open >= globalCap) return null;
	const client = requestClient(c);
	// Through a shared key, a ticketed stream is its ACCOUNT's (S-M7).
	const byAccount = client.shared && account !== undefined;
	const key = byAccount ? `account:${account}` : client.key;
	const shared = client.shared;
	const anon = client.shared && !byAccount;
	const held = perClient.get(key) ?? 0;
	if (byAccount && held >= perAccountCap) return null;
	if (!client.shared && held >= perClientCap) return null;
	if (shared && openShared >= sharedCap) return null;
	if (anon && openAnonShared >= anonSharedCap) return null;
	open++;
	if (shared) openShared++;
	if (anon) openAnonShared++;
	perClient.set(key, held + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		open--;
		if (shared) openShared--;
		if (anon) openAnonShared--;
		const n = (perClient.get(key) ?? 1) - 1;
		if (n <= 0) perClient.delete(key);
		else perClient.set(key, n);
	};
}

/**
 * The request's "client gone" signal (v1.21.14 review B, F1). READ IT BEFORE
 * THE FIRST AWAIT: @hono/node-server creates the signal lazily and aborts only
 * a signal that exists when the client leaves; and it never cancels a stream
 * whose client left before the response was written. A stream route that
 * awaits (the ticket check) before it takes a slot must check this after the
 * await, and close its stream when it fires — or the slot, the bus listeners
 * and the keepalive stay until restart.
 */
export function clientGoneSignal(c: Context): AbortSignal {
	return c.req.raw.signal;
}

/** The 503 body every capped stream route returns. */
export function streamCapResponse(c: Context): Response {
	c.header('retry-after', '30');
	return c.json(
		{
			status: 'error',
			code: 'stream_capacity',
			message: 'Too many open live-update streams. Retry shortly.'
		},
		503
	);
}

/** The refusal a chat stream answers without a valid ticket (streamTicket.ts).
 *  The reason is a fixed word, never anything the caller sent.
 *
 *  403, not 401 (v1.21.14 review B, F7): BunkerWeb bans an address for an
 *  hour after 50 answers in a minute with a status in BAD_BEHAVIOR_STATUS_CODES
 *  (401 405 444 in the template and the upgrade heal). Every tab of an older
 *  bundle and every tab with a stale ticket asks again, so many visitors
 *  behind one address would together get it banned from the whole site. */
export function streamTicketRefused(c: Context, reason: string): Response {
	return c.json(
		{
			status: 'error',
			code: 'stream_ticket_required',
			reason,
			message: 'A live chat stream needs a ticket signed by the account.'
		},
		403
	);
}

/** Open streams right now, for /v1/health. */
export function openStreamCount(): number {
	return open;
}

/** Test seam. */
export function _setStreamCapsForTest(caps: {
	perClient: number;
	global: number;
	shared?: number;
	anonShared?: number;
	perAccount?: number;
}): void {
	perClientCap = caps.perClient;
	globalCap = caps.global;
	sharedCap = caps.shared ?? caps.global;
	anonSharedCap = caps.anonShared ?? sharedCap;
	perAccountCap = caps.perAccount ?? DEFAULT_STREAMS_PER_ACCOUNT;
}
/** Test seam: restore defaults and forget every slot. */
export function _resetStreamCapsForTest(): void {
	perClientCap = DEFAULT_STREAMS_PER_CLIENT;
	globalCap = DEFAULT_STREAMS_GLOBAL;
	sharedCap = DEFAULT_STREAMS_SHARED;
	anonSharedCap = DEFAULT_STREAMS_ANON_SHARED;
	perAccountCap = DEFAULT_STREAMS_PER_ACCOUNT;
	perClient.clear();
	open = 0;
	openShared = 0;
	openAnonShared = 0;
}
