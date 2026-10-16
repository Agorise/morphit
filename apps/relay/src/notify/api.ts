/**
 * Offline notices — the relay's endpoints for Settings → Offline Notifications.
 *
 *   GET  /v1/notify/channels  which channels this site offers (+ its bots)
 *   POST /v1/notify/status    her channels and whether each is on or waiting
 *   POST /v1/notify/set       give an address (a code is sent there), or start
 *                             a Telegram link (a code to send the bot)
 *   POST /v1/notify/verify    type the code
 *   POST /v1/notify/remove    forget one channel, or all
 *   POST /v1/notify/here      "I have the site open" (once a minute, memory only)
 *   POST /v1/notify/open      which conversation a notice's link opens
 *
 * Every POST is signed with her posting key (sig.ts): for THIS site, once. No
 * answer ever contains an address — not even hers, not even masked: once
 * saved, an address is only ever read by the worker that sends to it.
 *
 * Limits (memory only):
 *   - per IP, only failed requests that cost something (a chain lookup, a
 *     signature check) count: one IP may be every Tor visitor of the site, so
 *     her heartbeats and changes must not fill it. Once an IP has used them
 *     up, a request is still checked when its account's key is known without
 *     asking the chain (seen within a day) — within a small shared budget per
 *     second for all such requests, which bounds the work a flood can cause
 *     (and, during one, may make her wait);
 *   - per account, once the signature checks out: heartbeats; taking an
 *     address back (remove, cancel, generous); everything else. Only then is
 *     the request remembered as used, so refused requests take no room in the
 *     replay memory (sig.ts).
 * Codes are also limited per account, per account and address, and per
 * address (store.ts). Nothing is logged with an account, an address or a code.
 */

import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { Limiter } from '../middleware/ratelimit.ts';
import { canonicalBucketKey, clientIp } from '../middleware/ip.ts';
import { normalizePushLocale } from '../policy/pushSubscriptions.ts';
import { logger } from '$log';
import { CHANNELS, isChannel, normalizeAddress, type AddressChannel } from './addresses.ts';
import type { NotifyConfig } from './config.ts';
import { offeredChannels } from './config.ts';
import { dispatch, errorClass, withTimeout } from './dispatch.ts';
import { MatrixRoomLeftOpen } from './channels/matrix.ts';
import { drainLeaves } from './leaves.ts';
import { notifyPayload, type NotifySigVerifier, type NotifyAction } from './sig.ts';

export { notifyPayload };
import { LINK_NETS, newCode, type LinkNet, type OfflineNotifyStore } from './store.ts';
import { render } from './text.ts';
import type { Presence } from './worker.ts';

const log = logger('offline-notify-api');

/** How long sending a code may take in all; past it, it counts as failed. */
export const CODE_SEND_BUDGET_MS = 45_000;
/** Every "send me a code" is answered this long after it arrived — whether a
 *  code was sent, failed, is still on its way, or (the address's daily
 *  limit) none was sent at all — so the time an answer takes says nothing.
 *  A send still running then finishes in the background; if it fails, the
 *  waiting code goes (her old address comes back) and the card finds out. */
export const CODE_ANSWER_MS = 8_000;

/** The request limits (see the top of this file). */
export interface NotifyLimits {
	/** Per IP: failed requests that cost something. */
	readonly ip: Limiter;
	/** All requests from IPs that used theirs up, checked with a known key. */
	readonly spent: Limiter;
	/** Per account: heartbeats. */
	readonly here: Limiter;
	/** Per account: remove and cancel. */
	readonly takeBack: Limiter;
	/** Per account: everything else. */
	readonly account: Limiter;
}

export function notifyLimits(): NotifyLimits {
	return {
		ip: new Limiter(300, 10 * 60_000),
		spent: new Limiter(20, 1_000),
		here: new Limiter(4, 60_000),
		takeBack: new Limiter(60, 10 * 60_000),
		account: new Limiter(30, 10 * 60_000)
	};
}

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
const signed = {
	account: z.string().regex(ACCOUNT_RE),
	nonce: z.string().regex(/^[0-9a-f]{32}$/),
	timestamp: z.number().int().positive(),
	signature: z.string().min(40).max(200)
};
const bodies = {
	status: z.object(signed).strict(),
	set: z
		.object({
			...signed,
			channel: z.enum(CHANNELS),
			address: z.string().max(300).optional(),
			locale: z.string().min(2).max(10),
			net: z.enum(LINK_NETS).optional()
		})
		.strict(),
	verify: z
		.object({ ...signed, channel: z.enum(CHANNELS), code: z.string().regex(/^\d{6}$/) })
		.strict(),
	remove: z.object({ ...signed, channel: z.union([z.enum(CHANNELS), z.literal('all')]) }).strict(),
	cancel: z.object({ ...signed, channel: z.enum(CHANNELS) }).strict(),
	here: z.object(signed).strict(),
	open: z.object({ ...signed, token: z.string().regex(/^[A-Za-z0-9_-]{20,40}$/) }).strict()
} as const;

export class OfflineNotifyEndpoints {
	constructor(
		private readonly cfg: NotifyConfig,
		private readonly store: OfflineNotifyStore | null,
		private readonly sig: NotifySigVerifier,
		private readonly presence: Presence,
		private readonly limits: NotifyLimits,
		opts: {
			readonly now?: () => Date;
			/** {@link CODE_ANSWER_MS}; tests make it long so sends settle first. */
			readonly codeAnswerMs?: number;
			/** {@link CODE_SEND_BUDGET_MS}. */
			readonly codeSendBudgetMs?: number;
			/** Waits until the answer's time (ms since the epoch). */
			readonly waitUntil?: (at: number) => Promise<void>;
		} = {}
	) {
		this.now = opts.now ?? (() => new Date());
		this.codeAnswerMs = opts.codeAnswerMs ?? CODE_ANSWER_MS;
		this.codeSendBudgetMs = opts.codeSendBudgetMs ?? CODE_SEND_BUDGET_MS;
		this.waitUntil =
			opts.waitUntil ??
			((at) => {
				const left = at - this.now().getTime();
				// Already there: no extra timer turn (that, too, would be a tell).
				return left <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, left));
			});
	}

	private readonly now: () => Date;
	private readonly codeAnswerMs: number;
	private readonly codeSendBudgetMs: number;
	private readonly waitUntil: (at: number) => Promise<void>;

	register(app: Hono): void {
		app.get('/v1/notify/channels', (c) => this.channels(c));
		for (const action of ['status', 'set', 'verify', 'remove', 'cancel', 'here', 'open'] as const) {
			app.post(`/v1/notify/${action}`, (c) => this.handle(c, action));
		}
	}

	private channels(c: Context): Response {
		const offered = this.store === null ? [] : offeredChannels(this.cfg);
		return c.json({
			site: this.cfg.siteName,
			audience: this.cfg.audience,
			// Whether addresses can still be seen and deleted here even when no
			// channel is offered (one flag for the whole site, nothing about anyone).
			stored: this.store !== null,
			channels: offered.map((id) => ({
				id,
				...(id === 'matrix' && this.cfg.matrix ? { bot: this.cfg.matrix.userId } : {}),
				...(id === 'xmpp' && this.cfg.xmpp ? { bot: this.cfg.xmpp.jid } : {}),
				...(id === 'telegram' && this.cfg.telegram ? { bot: this.cfg.telegram.username } : {}),
				...(id === 'session' && this.cfg.session ? { bot: this.cfg.session.sessionId } : {})
			})),
			zero_clearnet: this.cfg.policy.hiddenOnly
		});
	}

	private async handle(c: Context, action: keyof typeof bodies): Promise<Response> {
		if (this.store === null) return c.json({ status: 'offline_notify_unavailable' }, 503);
		const ip = canonicalBucketKey(clientIp(c));
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json({ status: 'malformed_request' }, 400);
		}
		const parsed = bodies[action].safeParse(raw);
		if (!parsed.success) return c.json({ status: 'bad_request' }, 400);
		const b = parsed.data as Record<string, unknown> & {
			account: string;
			nonce: string;
			timestamp: number;
			signature: string;
		};
		const takeBack = action === 'remove' || action === 'cancel';
		// This IP has used up its failures: only a request whose key is known
		// without asking the chain, within the shared budget.
		const ipSpent = !this.limits.ip.peek(ip);
		if (ipSpent && (!this.sig.knowsKey(b.account, true) || !this.limits.spent.allow('all')))
			return c.json({ status: 'rate_limited' }, 429);
		const request = {
			action,
			account: b.account,
			nonce: b.nonce,
			payload: notifyPayload(action, b),
			timestamp: b.timestamp,
			signature: b.signature
		};
		const v = await this.sig.check(request, { cachedOnly: ipSpent, staleOk: ipSpent });
		if (!v.ok) {
			// allow() records only while under the limit: a flood cannot grow it.
			if (v.costly) this.limits.ip.allow(ip);
			return c.json(
				{ status: 'signature_invalid', reason: v.reason },
				v.reason === 'chain_unreachable' ? 503 : 401
			);
		}
		const perAccount = takeBack
			? this.limits.takeBack
			: action === 'here'
				? this.limits.here
				: this.limits.account;
		if (!perAccount.allow(`notify:${b.account}`)) return c.json({ status: 'rate_limited' }, 429);
		// Accepted: only now remembered as used.
		if (!this.sig.commit(b.account, b.nonce, b.timestamp))
			return c.json({ status: 'signature_invalid', reason: 'replayed' }, 401);
		try {
			switch (action) {
				case 'status':
					return c.json({ status: 'ok', ...(await this.store.status(b.account)) });
				case 'set':
					return await this.set(c, b);
				case 'verify': {
					const r = await this.store.verifyCode(
						b.account,
						b.channel as AddressChannel,
						String(b.code),
						this.now()
					);
					// A confirmed change, or one that ended: a room may wait to be left.
					if (r === 'verified' || r === 'expired') this.drainLeaves();
					return c.json({ status: r }, r === 'verified' ? 200 : 400);
				}
				case 'remove': {
					await this.store.remove(b.account, b.channel as AddressChannel | 'all');
					this.drainLeaves();
					return c.json({ status: 'removed' });
				}
				case 'cancel': {
					// She stops a change: the address she had comes back (or, when
					// there was none, the waiting one goes).
					await this.store.restoreOrDrop(b.account, b.channel as AddressChannel);
					this.drainLeaves();
					return c.json({ status: 'cancelled' });
				}
				case 'here':
					// Only kept for an account that has offline notices on.
					if (await this.store.hasVerified(b.account)) this.presence.mark(b.account);
					return c.json({ status: 'ok' });
				case 'open': {
					const r = await this.store.resolveLink(b.account, String(b.token), this.now());
					return r === null
						? c.json({ status: 'not_found' }, 404)
						: c.json({
								status: 'ok',
								peer: r.peer,
								order: r.orderPermlink === '' ? null : r.orderPermlink
							});
				}
			}
		} catch (err) {
			log.error('offline_notify_request_failed', { action, err: errorClass(err) });
			return c.json({ status: 'internal' }, 500);
		}
	}

	/** The bot leaves and forgets the rooms waiting in the queue, now, in the
	 *  background (the worker also does it every round). */
	private drainLeaves(): void {
		const store = this.store;
		if (store === null) return;
		void drainLeaves(store, this.cfg.matrix, this.cfg.policy, this.now());
	}

	private async set(
		c: Context,
		b: Record<string, unknown> & { account: string }
	): Promise<Response> {
		const store = this.store!;
		const channel = String(b.channel);
		if (!isChannel(channel) || !offeredChannels(this.cfg).includes(channel)) {
			return c.json({ status: 'channel_not_offered' }, 400);
		}
		const locale = normalizePushLocale(String(b.locale));
		const net: LinkNet = (LINK_NETS as readonly string[]).includes(String(b.net))
			? (b.net as LinkNet)
			: 'clearnet';
		const now = this.now();
		if (channel === 'telegram') {
			const code = await store.beginTelegram(b.account, locale, net, now);
			if (code === null) return c.json({ status: 'too_many_codes' }, 429);
			return c.json({ status: 'telegram_code', code, bot: this.cfg.telegram!.username });
		}
		const address = normalizeAddress(channel, b.address);
		if (address === null) return c.json({ status: 'invalid_address' }, 400);
		const code = newCode(6);
		const answerAt = this.now().getTime() + this.codeAnswerMs;
		const begun = await store.beginAddress(b.account, channel, address, locale, code, net, now);
		// Her own limits (per account, per account and address): said at once —
		// the timing tells nothing about anyone else.
		if (!begun.ok) return c.json({ status: 'too_many_codes' }, 429);
		if (!begun.send) {
			// Enough codes went to this address today from other accounts: none
			// is sent, and the answer comes at the same moment as every other.
			await this.waitUntil(answerAt);
			return c.json({ status: 'code_sent' });
		}
		const raw = dispatch(this.cfg, channel, address, null, {
			subject: render(locale, 'code_subject', { site: this.cfg.siteName, code }),
			text: render(locale, 'code', { site: this.cfg.siteName, code })
		});
		const done = this.afterCodeSend(b.account, channel, begun.codeMac, raw);
		let timer: NodeJS.Timeout | undefined;
		const first = await Promise.race([
			done,
			new Promise<'later'>((r) => {
				timer = setTimeout(() => r('later'), this.codeAnswerMs);
			})
		]);
		clearTimeout(timer);
		await this.waitUntil(answerAt);
		// Still on its way: it finishes in the background (afterCodeSend).
		if (first === 'later' || first) return c.json({ status: 'code_sent' });
		return c.json({ status: 'send_failed' }, 502);
	}

	/**
	 * What happens once a code send settles — in the request, or after it was
	 * answered. Sent: its Matrix room is kept, on the row still waiting for
	 * THIS code only (else the bot leaves it). Failed: the address she had
	 * before keeps working (a first address goes), and any room opened for it
	 * is left. Never throws: true when the code went out.
	 */
	private async afterCodeSend(
		account: string,
		channel: AddressChannel,
		codeMac: Buffer,
		raw: Promise<string | null>
	): Promise<boolean> {
		const store = this.store!;
		try {
			const route = await withTimeout(raw, this.codeSendBudgetMs, 'code delivery');
			if (route !== null) await store.setRoute(account, channel, route, { codeMac });
			this.drainLeaves();
			return true;
		} catch (err) {
			log.warn('offline_notify_code_failed', { channel, err: errorClass(err) });
			try {
				await store.restoreOrDrop(account, channel, codeMac);
				if (err instanceof MatrixRoomLeftOpen) await store.queueLeave(account, err.room);
				// Past its budget it may still finish: a room it opens then is
				// left too (no row waits for it any more).
				else if (err instanceof Error && err.name === 'TimeoutError')
					void raw
						.then(
							(late) => (late !== null ? store.queueLeave(account, late) : undefined),
							(e: unknown) =>
								e instanceof MatrixRoomLeftOpen ? store.queueLeave(account, e.room) : undefined
						)
						.then(() => this.drainLeaves())
						.catch((e: unknown) =>
							log.warn('offline_notify_code_cleanup_failed', { channel, err: errorClass(e) })
						);
			} catch (e) {
				log.warn('offline_notify_code_cleanup_failed', { channel, err: errorClass(e) });
			}
			this.drainLeaves();
			return false;
		}
	}
}
