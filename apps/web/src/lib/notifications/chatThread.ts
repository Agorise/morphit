/**
 * Morphit — chat-thread identity for notifications (v1.8.9).
 *
 * ONE definition of "is this path the chat thread with <peer>", shared by the
 * service worker (deciding whether to raise an OS notification) and the page
 * (deciding whether to take one back down). These two answers must never
 * disagree, so they must not be two implementations.
 *
 * WHY THE PAGE NEEDS TO TAKE THEM DOWN AT ALL. Ken reported the same annoyance
 * three releases running: chatting with someone, and every reply raising an OS
 * notification for a message he was watching arrive. The suppression lives in
 * the service worker — and a service worker is the one piece of the app that
 * does NOT update when you reload. A new one installs, then WAITS, and the old
 * one keeps handling pushes until it activates (the "Load it now" prompt).
 * So a suppression fix can be shipped, deployed, and still not be running.
 *
 * Page code has no such problem: it is fresh on every load. So the page closes
 * any notification naming the thread it is already showing. With an up-to-date
 * worker the notification is never raised; with a stale one it is dismissed
 * immediately. Belt and braces, and the braces don't depend on an upgrade the
 * user has to opt into.
 */

/** Works in both the window and the service worker: `self` is defined in each.
 *  The fallback origin is only ever a parsing base for relative paths — it is
 *  never navigated to, and both sides of a comparison use the same one. */
function baseOrigin(): string {
	if (typeof self !== 'undefined' && self.location) return self.location.origin;
	return 'https://morphit.invalid';
}

/** The (peer, order) a chat path names, or null when it isn't a chat thread.
 *  Accepts an absolute client URL or a relative clickPath. */
export function chatThreadFromClickPath(
	clickPath: string
): { peer: string; order: string } | null {
	try {
		const u = new URL(clickPath, baseOrigin());
		const parts = u.pathname.split('/').filter(Boolean);
		const chatIdx = parts.indexOf('chat');
		const peer = chatIdx >= 0 ? parts[chatIdx + 1] : undefined;
		if (!peer) return null;
		return { peer, order: u.searchParams.get('order') ?? '' };
	} catch {
		return null;
	}
}

/** True when both paths name a chat thread with the SAME peer. Compares the
 *  PEER only, deliberately: a notification about someone you are already
 *  talking to is noise whichever order thread it arrived under. */
export function chatPeerMatches(clientUrl: string, clickPath: string): boolean {
	const a = chatThreadFromClickPath(clientUrl);
	const b = chatThreadFromClickPath(clickPath);
	return a !== null && b !== null && a.peer.toLowerCase() === b.peer.toLowerCase();
}

/**
 * Close any OS notification that names a chat thread with `peer`.
 *
 * Matches on the notification's own `data.clickPath` (set by the service
 * worker), NOT on its tag: tags encode the category and event id, and reading
 * a peer out of them would re-derive thread identity from a second, weaker
 * source. Notifications with no clickPath — order lifecycle, feedback — are
 * left strictly alone, as are conversations with anybody else.
 *
 * Safe on every path: no service worker, no registration, or a browser without
 * `getNotifications` simply means nothing to close.
 */
export async function dismissChatNotificationsFor(peer: string): Promise<void> {
	if (!peer) return;
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
	try {
		const reg = await navigator.serviceWorker.getRegistration();
		if (!reg || typeof reg.getNotifications !== 'function') return;
		const wanted = peer.toLowerCase();
		for (const note of await reg.getNotifications()) {
			const clickPath = (note.data as { clickPath?: unknown } | undefined)?.clickPath;
			if (typeof clickPath !== 'string') continue;
			const thread = chatThreadFromClickPath(clickPath);
			if (thread !== null && thread.peer.toLowerCase() === wanted) note.close();
		}
	} catch {
		// Best-effort cleanup — never let it disturb message delivery.
	}
}
