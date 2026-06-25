<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { gotoLocale } from '$i18n/navigate';

	/**
	 * Render-nothing guard for session-required pages (settings, post, backup-
	 * keys, 2FA, …). Drop `<RequireLiveSession />` at the top of such a page's
	 * template.
	 *
	 * WHY: the in-memory session is wiped on every reload — decrypted keys never
	 * persist across a refresh (the security posture; cp334/cp340). A page whose
	 * core action needs a live signing session is therefore unusable for a
	 * fully-locked visitor, and leaving them stranded there LOOKS like a logout.
	 * Instead, send them to the homepage; the header CTA there reads "Unlock"
	 * (when a keystore is remembered) and takes them to the welcome-back screen.
	 *
	 * RULES:
	 *   • Redirects ONLY when fully locked — `!isUnlocked && !isPairedReadOnly`.
	 *     A paired-readonly session is a LIVE read-only session (keys on the
	 *     phone), so it KEEPS access; the page shows its own read-only / write-
	 *     blocked affordance instead.
	 *   • Runs ONCE on mount (not an `$effect`), so a later idle auto-lock while
	 *     the user is actively on the page does NOT yank them away mid-task.
	 *   • A short grace lets a multi-tab cross-tab session handoff restore the
	 *     live session first, so a user with another open tab isn't bounced on
	 *     reload.
	 *
	 * Pages that present their OWN locked-state UI in place (e.g. /my/orders,
	 * which shows an "unlock to view your orders" card rather than redirecting —
	 * cp345 keeps order history behind the unlock so a locked, walked-away device
	 * never reveals your trades) must NOT use this guard: they handle the locked
	 * visitor themselves and shouldn't be bounced to the homepage.
	 */
	const GRACE_MS = 250;

	onMount(() => {
		const t = setTimeout(() => {
			if (!get(isUnlocked) && !get(isPairedReadOnly)) {
				void gotoLocale('/');
			}
		}, GRACE_MS);
		return () => clearTimeout(t);
	});
</script>
