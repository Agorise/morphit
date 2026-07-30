/**
 * Morphit — ephemeral toast notifications.
 *
 * A small stack of auto-dismissing messages shown in the
 * bottom-right corner. Replaces the `alert()` + `confirm()`
 * instincts with something that:
 *
 *   - stays visually consistent with the Morphit palette
 *   - doesn't block the page or steal focus
 *   - stacks gracefully when multiple events fire close together
 *   - auto-dismisses (kind-specific timing so errors get longer
 *     read time) but stays dismissable by hand
 *   - routes errors through an aria-live=assertive region so
 *     screen readers interrupt for them
 *
 * Zero-tracking: purely in-memory. Toasts never land in
 * localStorage; once dismissed (auto or manual) they're gone.
 * This is the correct tradeoff — a toast by definition is
 * ephemeral UI. If the user needs durable feedback, the caller
 * should surface a StatusLine or banner, not a toast.
 *
 * Usage:
 *
 *   import { showToast } from '$lib/stores/toast';
 *   showToast('Message sent', 'success');
 *   showToast('Check your connection', 'error');
 *
 * Components wanting to render the stack mount the
 * `ToastRegion` once at the app root.
 */

import { writable, type Readable } from 'svelte/store';

/** Toast variants. Match the StatusLine kind vocabulary for
 *  UX consistency — an operation that showed a `warn`
 *  StatusLine inline should use the same kind for a toast
 *  about the same event.
 *
 *  NOTE: since the de-brown, `warn` and `error` render with the
 *  SAME red styling in ToastRegion (red is the only attention
 *  colour left in the palette). `warn` is kept as a distinct
 *  level for its auto-dismiss timing (below), assertive aria-live
 *  grouping, and StatusLine parity — not for a separate colour. */
export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
	readonly id: string;
	readonly kind: ToastKind;
	readonly message: string;
	readonly createdAt: number;
	/** Optional href — when set, the toast becomes a clickable
	 *  link.  Used by Phase F.5 trade-event toasts to deep-link
	 *  the user to the relevant chat conversation. */
	readonly href?: string;
	/** Optional action label — when href is set, this label
	 *  appears as a "tap to view" affordance.  Defaults to a
	 *  generic localized "View" if unset by the caller. */
	readonly actionLabel?: string;
}

/** Default auto-dismiss time per kind, ms. Tuned so short
 *  info/success don't linger, warn/error stick around long
 *  enough for the user to read and react. Callers can
 *  override via the timeout parameter. */
const DEFAULT_TIMEOUT_MS: Readonly<Record<ToastKind, number>> = {
	info: 4_000,
	success: 4_000,
	warn: 6_000,
	error: 8_000
};

/** Maximum number of toasts visible at once. Excess pushes
 *  drop the oldest. Large enough to handle a burst of
 *  notifications without visually overwhelming. */
const MAX_STACK = 5;

interface InternalToast extends Toast {
	timeoutId: ReturnType<typeof setTimeout> | null;
	/** Phase G prep / Audit fix #6 — pause-on-hover support.
	 *  Total auto-dismiss budget for this toast (ms).  Zero
	 *  means "no auto-dismiss." */
	readonly timeoutMsTotal: number;
	/** Timestamp when the current run started.  Set on push and
	 *  on resume; reset to null on pause. */
	startedAt: number | null;
	/** Cumulative elapsed time across previous pause cycles. */
	elapsedAccumulated: number;
}

const stack = writable<readonly InternalToast[]>([]);

/** Readable view of the current toast stack. Consumers
 *  subscribe; internal mutation goes through the
 *  `push`/`dismiss` exports. Toasts are returned in
 *  creation order (oldest first); the region renders them
 *  top-to-bottom. */
export const toastStore: Readable<readonly Toast[]> = {
	subscribe: stack.subscribe
};

let nextId = 1;

/** Generate an ID. Simple monotonic counter is enough — IDs
 *  only need uniqueness within the process lifetime, and
 *  the counter resets cleanly on page reload. */
function mintId(): string {
	return `t${nextId++}`;
}

/** Remove a toast from the stack. Clears its auto-dismiss
 *  timeout if still pending. No-op on unknown IDs (common
 *  when manual dismiss races with auto-dismiss). */
export function dismissToast(id: string): void {
	stack.update((current) => {
		const idx = current.findIndex((t) => t.id === id);
		if (idx === -1) return current;
		const t = current[idx]!;
		if (t.timeoutId !== null) clearTimeout(t.timeoutId);
		const next = current.slice();
		next.splice(idx, 1);
		return next;
	});
}

/** Push a new toast onto the stack. Returns the toast's ID
 *  so callers can dismiss programmatically (rare — most
 *  callers let it auto-dismiss).
 *
 *  Pass `timeout: 0` or a negative number to disable
 *  auto-dismiss; the toast stays until manually dismissed. */
export function showToast(
	message: string,
	kind: ToastKind = 'info',
	options: { timeout?: number; href?: string; actionLabel?: string } = {}
): string {
	const id = mintId();

	// Phase F.5 audit fix (F-33) — validate href scheme.  Allow
	// only same-origin paths (start with `/`) and explicit https://
	// URLs.  Reject anything else: javascript:, data:, vbscript:,
	// and any future weird scheme would render as a clickable link
	// that executes inline JS in the user's session.  Defensive
	// boundary at the entry point so callers who pass arbitrary
	// strings can't accidentally introduce XSS.
	let safeHref: string | undefined;
	if (options.href !== undefined) {
		if (options.href.startsWith('/') || options.href.startsWith('https://')) {
			safeHref = options.href;
		} else {
			// Drop the href silently — toast still renders, just
			// not clickable.  A console warning helps developers
			// catch the issue in dev mode.
			if (typeof console !== 'undefined') {
				console.warn('[toast] dropped href with disallowed scheme:', options.href.slice(0, 32));
			}
		}
	}

	// Phase F.5 audit fix (F-35) — extend timeout when the toast
	// has an action link.  Keyboard users tabbing through the page
	// to reach the action need more than the default 4s.  Add 6s
	// when href is present, giving 10s total for info/success
	// (still bounded; user can dismiss anytime).
	const baseTimeout = options.timeout ?? DEFAULT_TIMEOUT_MS[kind];
	const timeoutMs =
		options.timeout !== undefined
			? options.timeout
			: safeHref !== undefined
				? baseTimeout + 6_000
				: baseTimeout;
	const timeoutId = timeoutMs > 0 ? setTimeout(() => dismissToast(id), timeoutMs) : null;

	const toast: InternalToast = {
		id,
		kind,
		message,
		createdAt: Date.now(),
		timeoutId,
		href: safeHref,
		actionLabel: options.actionLabel,
		timeoutMsTotal: timeoutMs > 0 ? timeoutMs : 0,
		startedAt: timeoutMs > 0 ? Date.now() : null,
		elapsedAccumulated: 0
	};

	stack.update((current) => {
		let next = [...current, toast];
		// Cap the stack — drop oldest if we've blown past the
		// limit. Clear its timeout first so it doesn't fire
		// against a state it's no longer in.
		while (next.length > MAX_STACK) {
			const oldest = next.shift()!;
			if (oldest.timeoutId !== null) clearTimeout(oldest.timeoutId);
		}
		return next;
	});

	return id;
}

/** Pause a toast's auto-dismiss countdown.  Used by ToastRegion
 *  on pointer-enter so a toast the user is reading or hovering
 *  to click stays put.  No-op on unknown IDs or toasts without
 *  auto-dismiss (timeoutMsTotal === 0). */
export function pauseToast(id: string): void {
	stack.update((current) => {
		const idx = current.findIndex((t) => t.id === id);
		if (idx === -1) return current;
		const t = current[idx]!;
		if (t.timeoutMsTotal === 0) return current;
		if (t.startedAt === null) return current; // already paused
		if (t.timeoutId !== null) clearTimeout(t.timeoutId);
		const elapsed = Date.now() - t.startedAt;
		const next = current.slice();
		next[idx] = {
			...t,
			timeoutId: null,
			startedAt: null,
			elapsedAccumulated: t.elapsedAccumulated + elapsed
		};
		return next;
	});
}

/** Resume a paused toast's countdown.  The remaining time is
 *  the total budget minus what already elapsed across previous
 *  run cycles.  Floor at 1s — a hover-and-leave with <1s left
 *  shouldn't dismiss the toast instantly out from under the
 *  user's mouse. */
export function resumeToast(id: string): void {
	stack.update((current) => {
		const idx = current.findIndex((t) => t.id === id);
		if (idx === -1) return current;
		const t = current[idx]!;
		if (t.timeoutMsTotal === 0) return current;
		if (t.startedAt !== null) return current; // already running
		const remaining = Math.max(1_000, t.timeoutMsTotal - t.elapsedAccumulated);
		const newTimeoutId = setTimeout(() => dismissToast(id), remaining);
		const next = current.slice();
		next[idx] = {
			...t,
			timeoutId: newTimeoutId,
			startedAt: Date.now()
		};
		return next;
	});
}
