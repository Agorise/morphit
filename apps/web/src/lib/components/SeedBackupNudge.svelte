<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * SeedBackupNudge — gentle banner reminding the user to back up
	 * their seed phrase 7+ days after first persisting a keystore
	 * on this device.
	 *
	 * Design:
	 *   - Renders in the layout above the main content, only when
	 *     `shouldShowSeedBackupNudge()` returns true.
	 *   - One-tap permanent dismissal ("Got it") writes a
	 *     localStorage flag; the banner never returns on this
	 *     device until full sign-out (which clears the flag and
	 *     restarts the 7-day clock on next persisted keystore).
	 *   - Provides a "Show me how" link to the seed-recovery FAQ
	 *     entry so the user can act on the prompt.
	 *   - Visually friendly, not alarming — this is a routine
	 *     reminder, not a warning.  Amber background to catch
	 *     the eye without screaming.
	 *
	 * Why only after 7 days: a fresh user is overwhelmed; we
	 * don't want this banner appearing within 5 minutes of
	 * onboarding.  By day 7 they've used the app, see value in
	 * preserving access, and are receptive to "back up your seed."
	 */
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import {
		shouldShowSeedBackupNudge,
		dismissSeedBackupNudge
	} from '$lib/crypto/persistentKeystore';

	let visible = $state(false);

	onMount(() => {
		// Defer visibility check to onMount so SSR doesn't render
		// the banner (no localStorage on the server).  The brief
		// flash on first paint is acceptable; it lands quickly.
		if (shouldShowSeedBackupNudge()) {
			visible = true;
		}
	});

	function dismiss(): void {
		dismissSeedBackupNudge();
		visible = false;
	}

	// Part 121 cp7 — per-locale internal-link wrapper.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

{#if visible}
	<div
		class="border-b border-amber-300/40 bg-amber-50 px-4 py-2 text-sm
		       text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40
		       dark:text-amber-200"
		role="status"
		aria-live="polite"
	>
		<div class="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
			<span aria-hidden="true">🔐</span>
			<span class="min-w-0 flex-1">
				{$_('seed_backup_nudge.body')}
			</span>
			<a
				href={lp('/faq#lost_keys')}
				class="group font-semibold underline decoration-dotted underline-offset-2 transition hover:decoration-solid"
			>
				{$_('seed_backup_nudge.show_me_how')} <span
					class="nav-arrow nav-arrow-right"
					aria-hidden="true">⇨</span
				>
			</a>
			<button
				type="button"
				onclick={dismiss}
				class="rounded px-2 py-1 font-semibold hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-amber-900/40"
			>
				{$_('seed_backup_nudge.got_it')}
			</button>
		</div>
	</div>
{/if}
