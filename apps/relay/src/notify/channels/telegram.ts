/**
 * Offline notices — Telegram, through the operator's bot (a token from
 * @BotFather).
 *
 * A Telegram bot cannot write to anyone first, and a username is not enough to
 * reach someone. So she links her Telegram herself: the card shows a one-time
 * code and a t.me link that opens the bot with `/start <code>`; when she sends
 * it, the relay — which polls the bot only while such a code is waiting — sees
 * the code and her chat id, and keeps the chat id (sealed). Her Telegram
 * username, name and phone number are never read or kept.
 *
 * Link previews are switched off, so Telegram's servers do not fetch the link.
 */

import { httpRequest, type NetPolicy } from '../net.ts';

export interface TelegramConfig {
	readonly token: string;
	/** The bot's username, without @ (shown on the card, used for t.me links). */
	readonly username: string;
	/** The Bot API server; Telegram's own unless the operator runs one. */
	readonly apiBase?: string;
}

export class TelegramError extends Error {
	constructor(
		readonly status: number,
		readonly description: string
	) {
		super(`Telegram answered ${status}`);
		this.name = 'TelegramError';
	}
}

async function api<T>(
	cfg: TelegramConfig,
	policy: NetPolicy,
	method: string,
	body: unknown,
	timeoutMs = 30_000
): Promise<T> {
	const base = (cfg.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
	const r = await httpRequest(`${base}/bot${cfg.token}/${method}`, policy, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		timeoutMs
	});
	let parsed: { ok?: boolean; result?: T; description?: string } = {};
	try {
		parsed = JSON.parse(r.body) as typeof parsed;
	} catch {
		/* not JSON */
	}
	if (r.status !== 200 || parsed.ok !== true) {
		// The description never contains her chat id; it is kept short anyway.
		throw new TelegramError(r.status, String(parsed.description ?? '').slice(0, 120));
	}
	return parsed.result as T;
}

export async function sendTelegram(
	cfg: TelegramConfig,
	policy: NetPolicy,
	chatId: string,
	text: string
): Promise<void> {
	await api(cfg, policy, 'sendMessage', {
		chat_id: chatId,
		text,
		link_preview_options: { is_disabled: true },
		disable_web_page_preview: true
	});
}

export interface TelegramUpdate {
	readonly updateId: number;
	readonly chatId: string;
	/** Only private chats with a text message are returned. */
	readonly text: string;
	/** When the message was sent (Telegram's clock); epoch 0 when unknown. */
	readonly sentAt: Date;
}

/** One long poll for new messages to the bot (updates after `offset`). */
export async function pollTelegram(
	cfg: TelegramConfig,
	policy: NetPolicy,
	offset: number,
	waitSeconds = 20
): Promise<TelegramUpdate[]> {
	const updates = await api<
		Array<{
			update_id: number;
			message?: {
				chat?: { id?: number | string; type?: string };
				text?: string;
				date?: number;
			};
		}>
	>(
		cfg,
		policy,
		'getUpdates',
		{ offset, timeout: waitSeconds, allowed_updates: ['message'] },
		(waitSeconds + 15) * 1000
	);
	const out: TelegramUpdate[] = [];
	for (const u of updates) {
		const chat = u.message?.chat;
		if (chat?.type !== 'private' || chat.id === undefined || typeof u.message?.text !== 'string') {
			out.push({ updateId: u.update_id, chatId: '', text: '', sentAt: new Date(0) });
			continue;
		}
		const date = u.message.date;
		out.push({
			updateId: u.update_id,
			chatId: String(chat.id),
			text: u.message.text,
			sentAt: new Date(typeof date === 'number' && Number.isFinite(date) ? date * 1000 : 0)
		});
	}
	return out;
}

/** The code in "/start 12345678" or "12345678" (8 digits). PURE. */
export function codeInTelegramText(text: string): string | null {
	const m = /^\s*(?:\/start(?:@\w+)?\s+)?(\d{8})\s*$/.exec(text);
	return m ? m[1]! : null;
}

/** The bot's username, from its token (operator setup check). */
export async function telegramBotName(token: string, policy: NetPolicy): Promise<string> {
	const me = await api<{ username?: string }>({ token, username: '' }, policy, 'getMe', {});
	if (typeof me.username !== 'string' || me.username === '')
		throw new TelegramError(200, 'no username');
	return me.username;
}
