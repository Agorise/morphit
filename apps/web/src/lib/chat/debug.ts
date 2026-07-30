/**
 * chatDebug — opt-in, privacy-conscious tracing for the chat delivery
 * pipeline. OFF by default; never logs in production unless a human
 * explicitly turns it on.
 *
 * Enable (either works, persists across reloads via localStorage):
 *   • In the dev console:  localStorage.setItem('morphit.debug.chat','1')  then reload
 *   • Or append to the URL:  ?chatdebug=1   (also persists it for next time)
 * Disable:
 *   • localStorage.removeItem('morphit.debug.chat')   then reload
 *   • Or ?chatdebug=0
 *
 * What it prints (all with a `[chat-debug]` prefix, so you can filter the
 * console to just this): every SSE connect/snapshot/appended event and
 * every decision `mergePollResponse` makes about an incoming record —
 * which path delivered it, whether it passed the (peer, order) thread
 * filter, whether it decrypted, and whether it was added / reconciled /
 * skipped. That is enough to pinpoint which stage drops a message
 * WITHOUT ever logging ciphertext or plaintext (privacy is priority #1):
 * we log message metadata only (id, sender, recipient, order_permlink,
 * client_tag prefix, decrypt ok/fail, action).
 */

import { browser } from '$app/environment';

const LS_KEY = 'morphit.debug.chat';

let cached: boolean | null = null;

/** Read the flag once per page load. `?chatdebug=1|0` flips + persists
 *  the localStorage value so a shared debug URL "just works" and stays
 *  on for the next reload. */
function resolveEnabled(): boolean {
	if (!browser) return false;
	try {
		const url = new URL(window.location.href);
		const q = url.searchParams.get('chatdebug');
		if (q === '1' || q === 'true') {
			window.localStorage.setItem(LS_KEY, '1');
			return true;
		}
		if (q === '0' || q === 'false') {
			window.localStorage.removeItem(LS_KEY);
			return false;
		}
		return window.localStorage.getItem(LS_KEY) === '1';
	} catch {
		return false;
	}
}

export function chatDebugEnabled(): boolean {
	if (cached === null) cached = resolveEnabled();
	return cached;
}

/** Safe, short client_tag preview — never the whole tag. */
export function tagPreview(tag: string | null | undefined): string {
	if (!tag) return '∅';
	return tag.length <= 10 ? tag : `${tag.slice(0, 10)}…`;
}

/** Structured debug line. No-op unless enabled. `data` should carry
 *  METADATA ONLY — never ciphertext or decrypted text. */
export function chatDebug(event: string, data?: Record<string, unknown>): void {
	if (!chatDebugEnabled()) return;
	// eslint-disable-next-line no-console
	console.log(`[chat-debug] ${event}`, data ?? {});
}
