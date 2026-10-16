/**
 * Settings → Offline Notifications: a notice's link is /<lang>/chat?n=<token>.
 *
 * The link names nobody (the mail, Matrix, XMPP, Telegram or Session servers
 * that carried it learn nothing), so the conversation it opens is asked from
 * this site's relay, signed as the account it was sent to — then the thread
 * opens, scoped to its order like a card in the chat list. The chat page calls
 * {@link followNoticeLink} whenever its address or her session changes.
 *
 *  - Locked or signed out: nothing happens here and the token stays in the
 *    address (the page sends her to unlock, with this address as `next`).
 *  - Opened: the thread replaces this address in her history (the token is
 *    spent; it should not sit in Back).
 *  - Gone (expired, another account's, a reply that names no account): the
 *    token is taken out of the address and history, and she is told.
 *  - Not right now (the relay was busy, down or unreachable): the address is
 *    left as it is, so she can open the link again in a little while.
 *
 * Each token is tried once while the site is open, however often the page is
 * mounted again (unlocking on the chat page remounts it).
 */
import type { NoticeLinkResult } from './offlineNotify';

/** The shape of a token the relay hands out. */
export const NOTICE_TOKEN = /^[A-Za-z0-9_-]{20,40}$/;
/** A Blurt account name: the only thing a link may open a conversation with. */
export const ACCOUNT_NAME = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

const tried = new Set<string>();

export interface NoticeLinkDeps {
	/** The locale-prefixed path for an app path ("/chat" → "/es/chat"). */
	lp(path: string): string;
	goto(
		url: string,
		opts: { replaceState: true; noScroll?: boolean; keepFocus?: boolean }
	): Promise<unknown>;
	/** Show settings.offline_notify.<key> as a toast. */
	toast(key: 'link_gone' | 'link_retry'): void;
	/** Ask the relay (defaults to the real request). */
	open?(token: string): Promise<NoticeLinkResult>;
}

export type NoticeLinkOutcome = 'none' | 'opened' | 'gone' | 'retry';

export async function followNoticeLink(
	url: URL,
	unlocked: boolean,
	deps: NoticeLinkDeps
): Promise<NoticeLinkOutcome> {
	if (!unlocked) return 'none';
	const token = url.searchParams.get('n') ?? '';
	if (!NOTICE_TOKEN.test(token) || tried.has(token)) return 'none';
	tried.add(token);
	let r: NoticeLinkResult;
	try {
		r = deps.open
			? await deps.open(token)
			: await (await import('./offlineNotify')).openNoticeLink(token);
	} catch {
		r = { kind: 'retry' };
	}
	if (r.kind === 'retry') {
		deps.toast('link_retry');
		return 'retry';
	}
	const base = r.kind === 'ok' && ACCOUNT_NAME.test(r.peer) ? deps.lp(`/chat/${r.peer}`) : '';
	if (!base.startsWith('/') || base.startsWith('//')) {
		// Take the spent token out of the address bar and history too.
		await deps.goto(deps.lp('/chat'), { replaceState: true, noScroll: true, keepFocus: true });
		deps.toast('link_gone');
		return 'gone';
	}
	const order = r.kind === 'ok' ? r.order : null;
	await deps.goto(order ? `${base}?order=${encodeURIComponent(order)}` : base, {
		replaceState: true
	});
	return 'opened';
}
