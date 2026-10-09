/**
 * What the relay does with a promise rejection nobody handled.
 *
 * WHY. An unhandled rejection means some code started work and stopped
 * listening for its outcome, so the relay exits on one, and systemd starts a
 * clean process. 2026-10-08, morphit.io: twelve restarts in a day. Every one
 * was a request to a Blurt node that had been abandoned ("AbortError: This
 * operation was aborted") or whose connection failed ("TypeError: fetch
 * failed"), after the code that sent it had already gone on with another
 * node's answer. Such a request can change nothing in the relay; stopping a
 * relay over it only cut off its users and its payout queue for the restart.
 *
 * NOW. A rejection that is exactly a network request ending (aborted, or the
 * connection failed) is logged as a warning, with its stack, and the relay
 * keeps running. Anything else still stops it, as before.
 */

/** True when `reason` is a network request that ended without an answer:
 *  cancelled (AbortError / TimeoutError) or a failed connection (undici's
 *  "fetch failed"). Narrow on purpose: nothing else is let through. */
export function isAbandonedNetworkRequest(reason: unknown): boolean {
	if (!(reason instanceof Error)) return false;
	if (reason.name === 'AbortError' || reason.name === 'TimeoutError') return true;
	return reason instanceof TypeError && reason.message === 'fetch failed';
}

export interface UnhandledRejectionDeps {
	readonly warn: (event: string, ctx: Record<string, unknown>, err: unknown) => void;
	readonly error: (event: string, ctx: Record<string, unknown>, err: unknown) => void;
	readonly exit: (code: number) => void;
}

export function onUnhandledRejection(reason: unknown, deps: UnhandledRejectionDeps): void {
	if (isAbandonedNetworkRequest(reason)) {
		deps.warn(
			'unhandled_network_rejection',
			{ hint: 'a request to a node ended after nothing waited for it; the relay keeps running' },
			reason
		);
		return;
	}
	deps.error('unhandled_rejection', {}, reason);
	deps.exit(1);
}
