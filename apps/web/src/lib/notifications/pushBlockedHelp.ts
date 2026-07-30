/**
 * When the browser refuses to register with its push service
 * (`push_service_unavailable`), the fix is browser-specific — and the generic
 * "lower your shields" advice actively misleads Brave users (Brave gates web
 * push behind a browser setting, NOT Shields). This maps the running browser to
 * a tailored help message so we hand-hold with the RIGHT steps.
 *
 * Detection is best-effort and only used to pick which friendly instructions to
 * show; a wrong guess just falls back to the generic message.
 */
export type PushHelpVariant = 'brave' | 'firefox' | 'safari' | 'generic';

export function pushBlockedHelpVariant(): PushHelpVariant {
	if (typeof navigator === 'undefined') return 'generic';
	// Brave injects `navigator.brave`; its user-agent also says "Chrome", so it
	// MUST be checked before the Chromium/Safari UA sniffing below.
	if ('brave' in navigator && (navigator as { brave?: unknown }).brave) return 'brave';
	const ua = navigator.userAgent || '';
	if (/firefox/i.test(ua)) return 'firefox';
	// Safari carries "Safari" but so does every Chromium browser; exclude the
	// Chromium/Android/Edge/Chrome-on-iOS markers to isolate real Safari.
	if (/safari/i.test(ua) && !/chrome|chromium|crios|android|edg/i.test(ua)) return 'safari';
	return 'generic';
}

/** The i18n key (under `settings.notifications.`) for the push-blocked message
 *  that matches the running browser. For the generic case this is the original
 *  `push_error_push_service_unavailable`; the others append the variant. */
export function pushBlockedHelpKey(): string {
	const v = pushBlockedHelpVariant();
	return v === 'generic'
		? 'push_error_push_service_unavailable'
		: `push_error_push_service_unavailable_${v}`;
}
