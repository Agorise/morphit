/**
 * Pure decision for the "turn on chat notifications" nudge shown the
 * first time a user opens a trade chat thread.
 *
 * Goal: help trades complete faster by getting the user a heads-up when
 * a counterparty replies — even with the tab closed — WITHOUT any
 * privacy cost. This rides the existing web-push system (opaque push
 * endpoint, no PII; see $lib/notifications/push.ts), NOT any stored
 * contact address. The `chat` notification category ships OFF by default
 * (tuned down for noise), so most users never discover it; this nudge
 * surfaces it at the one moment it's clearly relevant.
 *
 * The component owns the side effects (reading the browser push
 * subscription, the prefs store, localStorage dismissal, and the
 * subscribe call). This module is the pure show/hide decision so it can
 * be unit-tested without a browser.
 */

/** localStorage key holding the permanent "Not now" dismissal. Once the
 *  user dismisses the nudge we never nag again (they can still enable
 *  chat pings from Settings → Notifications). */
export const CHAT_NUDGE_DISMISSED_KEY = 'morphit.chatNotifNudge.dismissed';

export interface ChatNudgeState {
	/** Browser supports SW + Push + Notification APIs (isPushSupported). */
	readonly supported: boolean;
	/** User has a Blurt account (signed in). */
	readonly loggedIn: boolean;
	/** User previously dismissed this nudge (localStorage). */
	readonly dismissed: boolean;
	/** Chat pings already reach this user: a live push subscription AND
	 *  the push channel on AND the chat category on. When true there is
	 *  nothing to nudge. */
	readonly chatPingsActive: boolean;
}

/**
 * Show the nudge only when push is actually available, the user is
 * signed in, they haven't dismissed it, and chat pings aren't already
 * active. Pure.
 */
export function shouldShowChatNudge(s: ChatNudgeState): boolean {
	return s.supported && s.loggedIn && !s.dismissed && !s.chatPingsActive;
}
