/**
 * Settings → Offline Notifications — the browser side.
 *
 * Talks to THIS site's relay only (same origin, /relay/v1/notify/*). Every
 * request about her notices is signed with her posting key; the canonical
 * message must match apps/relay/src/notify/sig.ts verbatim:
 *
 *   morphit:notify:<action>:<audience>:<account>:<nonce>:<sha256 hex of payload>:<timestamp>
 *
 * <audience> is this site, as its relay names itself (GET /channels): a
 * request signed here is no good at any other instance she uses. <nonce> is
 * random per request: the relay accepts each signature once.
 *
 * The relay never sends an address back — not even hers. Once saved, it is
 * only read by the relay's worker, to send to it.
 *
 * While she has offline notices on and the site open, `startOfflinePresence`
 * tells the relay so once a minute (kept in the relay's memory for three
 * minutes, never written down), so she is not notified about a message she
 * can see coming in.
 */

import { get } from 'svelte/store';
import { MORPHIT_RELAY_ORIGIN, resolveOrigin } from '$net/config';
import { fetchWithTimeout } from '$net/fetchWithTimeout';
import { liveIdentity } from '$lib/stores/identity';
import { getUserBlurtAccount } from '$lib/blurt/ops/profile';
import { ACCOUNT_NAME } from './noticeLink';

export type OfflineChannel = 'email' | 'matrix' | 'xmpp' | 'telegram' | 'session';
/** The order the Settings card shows them in (the maintainer's choice). */
export const OFFLINE_CHANNELS: readonly OfflineChannel[] = [
	'matrix',
	'session',
	'xmpp',
	'telegram',
	'email'
];

type Action = 'status' | 'set' | 'verify' | 'remove' | 'cancel' | 'here' | 'open';

export interface OfferedChannel {
	readonly id: OfflineChannel;
	/** The instance's own account on that network (shown so she knows who
	 *  will write to her). */
	readonly bot?: string;
}

export interface OfferedChannels {
	readonly site: string;
	/** Who signed requests are for (this site's relay account). */
	readonly audience: string;
	/** The site keeps saved addresses (so hers can be seen and deleted even
	 *  when it offers no channel any more). */
	readonly stored: boolean;
	readonly channels: readonly OfferedChannel[];
	readonly zeroClearnet: boolean;
}

export type OfflineError =
	| 'locked_session'
	| 'invalid_address'
	| 'too_many_codes'
	| 'send_failed'
	| 'wrong'
	| 'expired'
	| 'none'
	| 'rate_limited'
	| 'unavailable'
	| 'failed';

const base = (): string => `${resolveOrigin(MORPHIT_RELAY_ORIGIN)}/v1/notify`;

function hex(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

async function sha256(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** The signed payload of each action (mirrors notifyPayload in the relay). */
export function notifyPayload(action: Action, b: Record<string, string | undefined>): string {
	switch (action) {
		case 'set':
			return `${b.channel ?? ''}\n${b.address ?? ''}\n${b.locale ?? ''}\n${b.net ?? 'clearnet'}`;
		case 'verify':
			return `${b.channel ?? ''}\n${b.code ?? ''}`;
		case 'remove':
		case 'cancel':
			return b.channel ?? '';
		case 'open':
			return b.token ?? '';
		default:
			return '';
	}
}

/** The canonical string signed for an action. PURE apart from the hash. */
export async function notifyCanonical(
	action: Action,
	audience: string,
	account: string,
	nonce: string,
	payload: string,
	timestamp: number
): Promise<string> {
	return `morphit:notify:${action}:${audience}:${account}:${nonce}:${hex(await sha256(payload))}:${timestamp}`;
}

/** This site's audience, learned from /channels (asked once, when needed). */
let audienceCache: string | null = null;
async function audience(): Promise<string> {
	if (audienceCache === null) {
		const o = await offeredChannels();
		if (o.audience === '') throw 'unavailable' satisfies OfflineError;
	}
	return audienceCache!;
}

/** Which of the site's addresses she is using now: her notices link there. */
export function currentNet(hostname: string = globalThis.location?.hostname ?? ''): string {
	const h = hostname.toLowerCase();
	if (h.endsWith('.onion')) return 'tor';
	if (h.endsWith('.i2p')) return 'i2p';
	if (h.endsWith('.loki')) return 'loki';
	return 'clearnet';
}

async function signed(
	action: Action,
	fields: Record<string, string | undefined>,
	timeoutMs = 20_000
): Promise<{ status: number; body: Record<string, unknown> }> {
	const account = getUserBlurtAccount();
	const key = get(liveIdentity)?.posting.privateKey;
	if (!account || !key) throw 'locked_session' satisfies OfflineError;
	const timestamp = Math.floor(Date.now() / 1000);
	const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
	const canonical = await notifyCanonical(
		action,
		await audience(),
		account,
		nonce,
		notifyPayload(action, fields),
		timestamp
	);
	const { PrivateKey } = await import('@beblurt/dblurt');
	const digest = await sha256(canonical);
	const signature = new PrivateKey(key as unknown as Buffer)
		.sign(digest as unknown as Buffer)
		.toString();
	const clean: Record<string, string> = {};
	for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
	let res: Response;
	try {
		res = await fetchWithTimeout(
			`${base()}/${action}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...clean, account, nonce, timestamp, signature })
			},
			timeoutMs
		);
	} catch {
		throw 'failed' satisfies OfflineError;
	}
	let body: Record<string, unknown> = {};
	try {
		body = (await res.json()) as Record<string, unknown>;
	} catch {
		/* not JSON */
	}
	return { status: res.status, body };
}

function errorOf(r: { status: number; body: Record<string, unknown> }): OfflineError {
	const s = String(r.body.status ?? '');
	if (r.status === 429) return s === 'too_many_codes' ? 'too_many_codes' : 'rate_limited';
	if (r.status === 503) return 'unavailable';
	if (['invalid_address', 'send_failed', 'wrong', 'expired', 'none'].includes(s))
		return s as OfflineError;
	return 'failed';
}

/** A /channels reply as this card can use it, whatever came back: known
 *  channels only, each once, in the site's order; texts capped (they are
 *  shown); flags only when they are true. */
export function sanitizeOffered(raw: unknown): OfferedChannels {
	const b = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
	const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
	const seen = new Set<OfflineChannel>();
	const channels: OfferedChannel[] = [];
	for (const c of Array.isArray(b.channels) ? (b.channels as unknown[]) : []) {
		const id = typeof c === 'object' && c !== null ? (c as { id?: unknown }).id : undefined;
		if (typeof id !== 'string' || !(OFFLINE_CHANNELS as readonly string[]).includes(id)) continue;
		if (seen.has(id as OfflineChannel)) continue;
		seen.add(id as OfflineChannel);
		const bot = (c as { bot?: unknown }).bot;
		channels.push({
			id: id as OfflineChannel,
			bot: typeof bot === 'string' ? bot.slice(0, 200) : undefined
		});
	}
	return {
		site: text(b.site, 200),
		audience: text(b.audience, 200),
		stored: b.stored === true,
		channels,
		zeroClearnet: b.zero_clearnet === true
	};
}

let offeredInFlight: Promise<OfferedChannels> | null = null;

/** Which channels this site offers. No signature: it says nothing about her.
 *  Asked once at a time (the card and the heartbeat ask together). */
export function offeredChannels(): Promise<OfferedChannels> {
	offeredInFlight ??= (async () => {
		try {
			const res = await fetchWithTimeout(`${base()}/channels`, { method: 'GET' });
			if (!res.ok) return sanitizeOffered(null);
			const o = sanitizeOffered(await res.json());
			if (o.audience !== '') audienceCache = o.audience;
			return o;
		} catch {
			return sanitizeOffered(null);
		}
	})().finally(() => {
		offeredInFlight = null;
	});
	return offeredInFlight;
}

export type ChannelState = 'on' | 'pending';

type Status = Partial<Record<OfflineChannel, ChannelState>>;

/** Her last status answer, for whom and when: the Settings card and the
 *  heartbeat both ask as she opens the site, and the relay allows each account
 *  30 requests in 10 minutes. Forgotten whenever she changes something. */
let statusKept: { account: string; at: number; value: Status } | null = null;
let statusInFlight: { account: string; p: Promise<Status> } | null = null;
const STATUS_REUSE_MS = 10_000;

/** Forget the status kept: something was just changed. */
function statusChanged(): void {
	statusKept = null;
	statusInFlight = null;
}

/** Her channels and whether each is on or waiting for its code. An answer
 *  from the last few seconds (or one on its way) is shared, unless `fresh`. */
export function offlineStatus(opts: { fresh?: boolean } = {}): Promise<Status> {
	const account = getUserBlurtAccount() ?? '';
	if (!opts.fresh) {
		if (
			statusKept !== null &&
			statusKept.account === account &&
			Date.now() - statusKept.at < STATUS_REUSE_MS
		)
			return Promise.resolve({ ...statusKept.value });
		if (statusInFlight !== null && statusInFlight.account === account)
			return statusInFlight.p.then((v) => ({ ...v }));
	}
	const p = (async (): Promise<Status> => {
		const r = await signed('status', {});
		if (r.status !== 200) throw errorOf(r);
		const out: Status = {};
		for (const c of Array.isArray(r.body.channels) ? (r.body.channels as unknown[]) : []) {
			const { channel, state } = (c ?? {}) as { channel?: unknown; state?: unknown };
			if (
				typeof channel === 'string' &&
				(OFFLINE_CHANNELS as readonly string[]).includes(channel) &&
				(state === 'on' || state === 'pending')
			)
				out[channel as OfflineChannel] = state;
		}
		return out;
	})();
	const mine = { account, p };
	statusInFlight = mine;
	p.then(
		(value) => {
			if (statusInFlight === mine) statusKept = { account, at: Date.now(), value };
		},
		() => undefined
	).finally(() => {
		if (statusInFlight === mine) statusInFlight = null;
	});
	return p.then((v) => ({ ...v }));
}

/** Save an address: a code is sent to it. (Telegram: use {@link startTelegram}.) */
export async function setAddress(
	channel: Exclude<OfflineChannel, 'telegram'>,
	address: string,
	locale: string
): Promise<void> {
	// Sending through Tor (Session) can take a while: the relay allows 45 s.
	statusChanged();
	const r = await signed(
		'set',
		{ channel, address: address.trim(), locale, net: currentNet() },
		55_000
	);
	if (r.status !== 200 || r.body.status !== 'code_sent') throw errorOf(r);
}

/** Telegram: a code to send to the site's bot, and the bot's name. */
export async function startTelegram(locale: string): Promise<{ code: string; bot: string }> {
	statusChanged();
	const r = await signed('set', { channel: 'telegram', locale, net: currentNet() });
	if (r.status !== 200 || r.body.status !== 'telegram_code') throw errorOf(r);
	// The code goes into a t.me link and on screen: digits only, as the relay makes it.
	const code = typeof r.body.code === 'string' ? r.body.code : '';
	if (!/^\d{6,10}$/.test(code)) throw 'failed' satisfies OfflineError;
	return { code, bot: typeof r.body.bot === 'string' ? r.body.bot.slice(0, 200) : '' };
}

export async function verifyCode(channel: OfflineChannel, code: string): Promise<void> {
	statusChanged();
	const r = await signed('verify', { channel, code: code.replace(/\s+/g, '') });
	if (r.status !== 200 || r.body.status !== 'verified') throw errorOf(r);
}

export async function removeChannel(channel: OfflineChannel | 'all'): Promise<void> {
	statusChanged();
	const r = await signed('remove', { channel });
	if (r.status !== 200) throw errorOf(r);
}

/**
 * She stops a change of address before typing its code: the confirmed address
 * she had before comes back (or, when there was none, the waiting one goes) —
 * the channel stays on. A relay from before `cancel` existed answers 404 or
 * 400: then nothing is changed (her old address is not removed either).
 */
export async function cancelChange(channel: OfflineChannel): Promise<void> {
	statusChanged();
	const r = await signed('cancel', { channel });
	if (r.status === 404 || r.status === 400) return;
	if (r.status !== 200) throw errorOf(r);
}

/** What a notice's link gives: the conversation, a link that will never
 *  open (expired, someone else's, malformed), or "not right now" (the relay
 *  was busy or unreachable, or she was locked): then the link is kept. */
export type NoticeLinkResult =
	| { readonly kind: 'ok'; readonly peer: string; readonly order: string | null }
	| { readonly kind: 'gone' }
	| { readonly kind: 'retry' };

/** The conversation a notice's link opens (for the signed-in account only). */
export async function openNoticeLink(token: string): Promise<NoticeLinkResult> {
	let r: { status: number; body: Record<string, unknown> };
	try {
		r = await signed('open', { token });
	} catch {
		return { kind: 'retry' };
	}
	if (r.status === 404 || r.status === 400) return { kind: 'gone' };
	if (r.status !== 200) return { kind: 'retry' };
	const peer = r.body.peer;
	if (typeof peer !== 'string' || !ACCOUNT_NAME.test(peer)) return { kind: 'gone' };
	const order = r.body.order;
	return {
		kind: 'ok',
		peer,
		order: typeof order === 'string' && order !== '' ? order.slice(0, 256) : null
	};
}

let presenceTimer: ReturnType<typeof setInterval> | null = null;

/** While she has the site open and offline notices on: once a minute. */
export function startOfflinePresence(): () => void {
	if (presenceTimer !== null) return stopOfflinePresence;
	const beat = (): void => {
		if (!get(liveIdentity)?.posting.privateKey) return;
		void signed('here', {}).catch(() => undefined);
	};
	beat();
	presenceTimer = setInterval(beat, 60_000);
	return stopOfflinePresence;
}

export function stopOfflinePresence(): void {
	if (presenceTimer !== null) clearInterval(presenceTimer);
	presenceTimer = null;
}

/** On app start: begin the heartbeat only if she has a channel on — unless
 *  `ended` says she locked or signed out while the answers were on their way. */
export async function resumeOfflinePresence(ended: () => boolean = () => false): Promise<void> {
	try {
		// Nothing to sign when this site offers no offline notices at all.
		if ((await offeredChannels()).channels.length === 0 || ended()) return;
		const s = await offlineStatus();
		if (!ended() && Object.values(s).includes('on')) startOfflinePresence();
	} catch {
		/* signed out, locked, or no offline notices on this site */
	}
}

/** While she is signed in: the heartbeat, if she has a channel on. The
 *  returned function (on lock or sign-out) stops it, and keeps an answer
 *  still on its way from starting it again. */
export function watchOfflinePresence(): () => void {
	let ended = false;
	void resumeOfflinePresence(() => ended);
	return () => {
		ended = true;
		stopOfflinePresence();
	};
}
