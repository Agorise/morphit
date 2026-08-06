<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { gotoLocale } from '$i18n/navigate';
	import { getUserBlurtAccount, blurtAccountName } from '$blurt/ops/profile';

	/**
	 * /my/wallet — a canonical shortcut to the signed-in user's wallet.
	 *
	 * The wallet UI itself lives on the user's OWN profile (cp424
	 * `MyBalanceCard`, rendered only when the live viewer === the profile
	 * account). So this route doesn't render a wallet — it resolves who you
	 * are and forwards:
	 *   • have an account name  → `/@{account}` (the wallet shows there once
	 *     the session is live; a locked visitor can unlock on that page).
	 *   • live but name unknown → home. This is a rare Privacy-Mode edge
	 *     (localStorage unavailable) — NOT `/login`, which would loop because
	 *     the login page, seeing an already-live session, forwards straight
	 *     back here.
	 *   • signed out            → `/login?next=<here>`; after they unlock or
	 *     import, the login page forwards back here → the account-name branch
	 *     resolves them to their profile.
	 *
	 * A short grace lets a cross-tab session handoff restore the live session
	 * before we decide (mirrors `RequireLiveSession`), so a user with another
	 * open tab isn't bounced. Client-side only; on adapter-static this route
	 * prerenders to the placeholder below and redirects after hydration.
	 */
	const GRACE_MS = 200;

	onMount(() => {
		const timer = setTimeout(() => {
			const account = getUserBlurtAccount() ?? get(blurtAccountName);
			if (account) {
				void gotoLocale('/@' + account, { replaceState: true });
			} else if (get(isUnlocked) || get(isPairedReadOnly)) {
				void gotoLocale('/', { replaceState: true });
			} else {
				const here =
					window.location.pathname + window.location.search + window.location.hash;
				void gotoLocale('/login?next=' + encodeURIComponent(here), { replaceState: true });
			}
		}, GRACE_MS);
		return () => clearTimeout(timer);
	});
</script>

<svelte:head>
	<!-- A pure redirect target: keep it out of search indexes. -->
	<meta name="robots" content="noindex,nofollow" />
</svelte:head>

<!-- Brief placeholder while the client-side redirect resolves. -->
<div class="flex min-h-[40vh] items-center justify-center">
	<div
		class="h-8 w-8 animate-spin rounded-full border-2 border-morphit-teal border-t-transparent"
		aria-hidden="true"
	></div>
</div>
