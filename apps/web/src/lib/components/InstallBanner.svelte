<script lang="ts">
	/**
	 * InstallBanner — a compact, dismissible "Install Morphit" affordance that
	 * makes the PWA installable across as many browsers/devices as the platform
	 * actually allows:
	 *
	 *   - Chromium (Chrome / Edge / Brave / Opera / Samsung Internet), desktop
	 *     AND Android: these fire `beforeinstallprompt`. We captured it at boot
	 *     (hooks.client.ts) into the `installPrompt` store, so the button here
	 *     triggers the real native install prompt in one tap.
	 *   - iOS / iPadOS Safari: NO `beforeinstallprompt` exists on this platform —
	 *     installation is only possible via Share → "Add to Home Screen". We
	 *     detect it and reveal those steps instead of a (impossible) one-tap
	 *     button.
	 *   - Firefox desktop / other browsers with no install path: we show nothing
	 *     (the store stays null and it isn't iOS), so we never dangle an
	 *     "Install" button that can't do anything.
	 *
	 * Already-installed (display-mode: standalone, or navigator.standalone on
	 * iOS) hides it. Dismissal is remembered in localStorage so it never nags —
	 * the full install UX still lives on the settings page.
	 */
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { installPrompt, isInstalled, promptInstall } from '$lib/pwa/installPrompt';

	const DISMISS_KEY = 'morphit:install-banner-dismissed';

	let mounted = $state(false);
	let dismissed = $state(false);
	let isIOS = $state(false);
	let showIOSHelp = $state(false);

	onMount(() => {
		// Defer to the client: no localStorage / navigator on the server, and we
		// don't want the banner in the SSR'd HTML.
		try {
			dismissed = localStorage.getItem(DISMISS_KEY) === '1';
		} catch {
			/* private mode / storage disabled — treat as not dismissed */
		}
		const ua = navigator.userAgent;
		// iPhone/iPod report in the UA; iPadOS 13+ masquerades as Macintosh but
		// has a touch screen, so include that. Any iOS browser is worth guiding
		// (only Safari can Add to Home Screen, so the help text names Safari).
		const iOSUA = /iphone|ipad|ipod/i.test(ua);
		const iPadOSDesktop = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
		isIOS = iOSUA || iPadOSDesktop;
		mounted = true;
	});

	// A native prompt is available (Chromium) — one-tap install.
	const canPrompt = $derived(mounted && !dismissed && !$isInstalled && $installPrompt !== null);
	// iOS Safari — no prompt possible, show the manual Add-to-Home-Screen steps.
	const iosOnly = $derived(mounted && !dismissed && !$isInstalled && isIOS && $installPrompt === null);
	const visible = $derived(canPrompt || iosOnly);

	function dismiss(): void {
		dismissed = true;
		showIOSHelp = false;
		try {
			localStorage.setItem(DISMISS_KEY, '1');
		} catch {
			/* ignore */
		}
	}

	async function onInstall(): Promise<void> {
		if ($installPrompt) {
			const outcome = await promptInstall();
			// Accepted → it's installing; dismiss so the banner doesn't linger.
			if (outcome === 'accepted') dismiss();
		} else {
			// iOS path — reveal the Share → Add to Home Screen steps inline.
			showIOSHelp = !showIOSHelp;
		}
	}
</script>

{#if visible}
	<div
		class="border-b border-morphit-emerald/30 bg-emerald-50 px-4 py-2 text-sm
		       text-ink-800 dark:border-morphit-emerald/25 dark:bg-emerald-950/40
		       dark:text-ink-100"
		role="region"
		aria-label={$_('install.banner.heading')}
	>
		<div class="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
			<span class="font-medium">{$_('install.banner.heading')}</span>
			<span class="text-ink-600 dark:text-ink-300">{$_('install.banner.blurb')}</span>
			<span class="ms-auto flex items-center gap-2">
				<button type="button" class="btn-primary-sm" onclick={() => void onInstall()}>
					{canPrompt ? $_('install.banner.cta') : $_('install.banner.ios_cta')}
				</button>
				<button
					type="button"
					class="rounded-lg px-2 py-1 text-ink-500 underline-offset-2 hover:underline
					       dark:text-ink-400"
					onclick={dismiss}
				>
					{$_('install.banner.dismiss')}
				</button>
			</span>
		</div>
		{#if showIOSHelp}
			<p class="mx-auto mt-1 max-w-5xl text-ink-600 dark:text-ink-300">
				{$_('install.banner.ios_help')}
			</p>
		{/if}
	</div>
{/if}
