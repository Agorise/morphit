/**
 * Offline notices — send one text to one address on one channel. The single
 * place that maps a channel to its sender, so the code message and the notice
 * take exactly the same route.
 *
 * Errors are reduced to a channel name and an error class before they are
 * logged: a server's own error text can repeat the address, and the address
 * is never logged.
 */

import type { Channel } from './addresses.ts';
import type { NotifyConfig } from './config.ts';
import { sendMail } from './channels/smtp.ts';
import { sendMatrix } from './channels/matrix.ts';
import { sendXmpp } from './channels/xmpp.ts';
import { sendTelegram } from './channels/telegram.ts';
import { sendSession } from './channels/session.ts';

export interface Outgoing {
	/** Email subject (other channels send `text` only). */
	readonly subject: string;
	readonly text: string;
}

/** What a failed send may say in a log: the error's class, never its text. */
export function errorClass(err: unknown): string {
	if (err instanceof Error) return err.name || 'Error';
	return typeof err;
}

/**
 * Send. Returns the route to keep for next time (Matrix: the room), or null.
 * Throws when the channel is not offered or the send failed.
 */
export async function dispatch(
	cfg: NotifyConfig,
	channel: Channel,
	address: string,
	route: string | null,
	msg: Outgoing
): Promise<string | null> {
	switch (channel) {
		case 'email':
			if (!cfg.email) throw new Error('email not offered');
			await sendMail(cfg.email, cfg.siteName, address, msg.subject, msg.text, cfg.policy);
			return null;
		case 'matrix':
			if (!cfg.matrix) throw new Error('matrix not offered');
			return sendMatrix(cfg.matrix, cfg.policy, address, route, msg.text);
		case 'xmpp':
			if (!cfg.xmpp) throw new Error('xmpp not offered');
			await sendXmpp(cfg.xmpp, cfg.policy, address, msg.text);
			return null;
		case 'telegram':
			if (!cfg.telegram) throw new Error('telegram not offered');
			await sendTelegram(cfg.telegram, cfg.policy, address, msg.text);
			return null;
		case 'session':
			if (!cfg.session) throw new Error('session not offered');
			await sendSession(cfg.session, cfg.siteName, cfg.policy, address, msg.text);
			return null;
	}
}

/** `p`, or a TimeoutError after `ms` (the work itself is bounded by its own
 *  connection deadlines in net.ts and ends soon after). */
export function withTimeout<T>(p: Promise<T>, ms: number, what = 'delivery'): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => {
			const e = new Error(`${what} took too long`);
			e.name = 'TimeoutError';
			reject(e);
		}, ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e: unknown) => {
				clearTimeout(t);
				reject(e);
			}
		);
	});
}
