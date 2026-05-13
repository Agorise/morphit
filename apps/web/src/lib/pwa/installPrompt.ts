/**
 * Morphit — PWA install prompt store.
 *
 * Item 16 phase 5: PWA polish.
 *
 * Captures the browser's `beforeinstallprompt` event so we control
 * when the install prompt is offered (via Settings page button)
 * rather than letting Chrome surface a banner the user didn't
 * ask for.  Privacy posture: install prompts are not notifications
 * but they are interruptive, so we adopt the same opt-in stance —
 * the user explicitly clicks "Install" in Settings to trigger it.
 *
 * Browser support:
 *   - Chrome / Edge: full BeforeInstallPromptEvent.  Prompt-on-demand
 *     works.
 *   - Safari (desktop & iOS): no event.  iOS uses Share → Add to
 *     Home Screen instead — see /faq#iphone_install.  We surface
 *     instructions in Settings as a fallback.
 *   - Firefox desktop: no install support.  Settings UI hides the
 *     install option.
 *   - Firefox Android: A2HS via menu (no event).  Same fallback as
 *     Safari.
 *
 * Detection: if `installPrompt` store is non-null, native install
 * is available and clicking the button prompts.  Otherwise the
 * Settings UI shows manual instructions.
 */

import { writable, type Writable } from 'svelte/store';
import { browser } from '$app/environment';

/** The shape of `BeforeInstallPromptEvent` per WICG spec. */
interface BeforeInstallPromptEvent extends Event {
	readonly platforms: readonly string[];
	readonly userChoice: Promise<{
		readonly outcome: 'accepted' | 'dismissed';
		readonly platform: string;
	}>;
	prompt(): Promise<void>;
}

/** The deferred prompt, or null if no prompt is currently
 *  available (browser doesn't support it, already installed,
 *  or the event hasn't fired yet). */
export const installPrompt: Writable<BeforeInstallPromptEvent | null> = writable(null);

/** True when the user is running in a PWA context (display:
 *  standalone media query matches).  In that case there's no
 *  point offering install. */
export const isInstalled: Writable<boolean> = writable(false);

if (browser) {
	// Capture the event when fired.  preventDefault() stops the
	// browser from showing its own install banner — we control
	// the UX.
	window.addEventListener('beforeinstallprompt', (e) => {
		e.preventDefault();
		installPrompt.set(e as BeforeInstallPromptEvent);
	});

	// If the user installs through any path (manifest button,
	// browser menu, our prompt), the appinstalled event fires.
	// Clear the deferred prompt and mark installed.
	window.addEventListener('appinstalled', () => {
		installPrompt.set(null);
		isInstalled.set(true);
	});

	// Detect already-installed state via display-mode media query.
	// Runs once at module load — the store updates only if the
	// answer changes.
	const dm = window.matchMedia('(display-mode: standalone)');
	isInstalled.set(dm.matches);
	// The match can change at runtime if the user opens the same
	// URL in a regular tab vs the PWA.  Keep the store in sync.
	dm.addEventListener?.('change', (ev) => isInstalled.set(ev.matches));
}

/** Trigger the install prompt.  Call this from a click handler
 *  in response to a user action — browsers reject prompts that
 *  weren't initiated by a user gesture.
 *
 *  Returns the outcome string ('accepted' | 'dismissed') or
 *  null if no prompt was available. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
	let event: BeforeInstallPromptEvent | null = null;
	const unsubscribe = installPrompt.subscribe((e) => {
		event = e;
	});
	unsubscribe();
	if (!event) return null;
	const e = event as BeforeInstallPromptEvent;
	await e.prompt();
	const choice = await e.userChoice;
	// Spec says the prompt is single-use — clear it so the UI
	// hides the button until the next page load (when the event
	// may re-fire if the user is still eligible).
	installPrompt.set(null);
	return choice.outcome;
}
