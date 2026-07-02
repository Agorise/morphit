<!--
	Morphit — operator-instance block banner (ADR-0018).

	Surfaces the "this Morphit instance has blocked you" notification
	when the signed-in user has been operator-blocked on the current
	instance.  Critical UX surface for honest-and-narrow framing:
	the user needs to know what happened, what it does NOT mean
	(funds, identity, chain history are unaffected), what they can
	do (sign in elsewhere, contact the operator).

	Lifecycle:
	  • Subscribes to `identity` so we re-fetch when the user signs
	    in or out.  No fetch when not signed in.
	  • Calls /v1/operator-blocks/by-blocked/:account once per
	    sign-in event.  No polling — operator blocks are
	    chain-driven and rare; a stale-by-one-page-load cache is
	    acceptable.
	  • On error, renders nothing — better to show no banner on a
	    transient indexer hiccup than a false alarm.

	Privacy posture: this is a CLIENT-SIDE check against PUBLIC chain
	data.  The operator-block status is derivable by anyone scraping
	the chain; we're just making the user aware of it.

	The banner is NOT dismissible.  An operator-block is high-stakes
	enough that the user should keep seeing it until the block is
	lifted (the next page load will then return blocked: false).
-->
<script lang="ts">
	import { formatDayMonth } from '$lib/i18n/formatters';
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import { identity } from '$stores/identity';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { getOperatorBlockStatus, type OperatorBlockStatus } from '$lib/indexer/client';
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';

	// Part 121 cp7 — per-locale internal-link wrapper. cp242: the
	// "contact the operator" link below was a bare `/inbox/<operator>` —
	// a route that does not exist AND a bare 2-segment path (which the
	// [lang]/+layout invalid-locale redirect cannot rescue, unlike a
	// 1-segment bare path). Both bugs fixed: point at the real chat route
	// and locale-prefix it like every other internal link.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));

	/** Latest fetched status.  Initial null = not yet fetched.
	 *  After fetch, either the typed status object or null on
	 *  error (we render nothing on error — see file header). */
	let status = $state<OperatorBlockStatus | null>(null);

	/** Whether the "what does this mean?" details panel is open.
	 *  Default collapsed — the headline is enough to communicate
	 *  the situation; details are for users who want them. */
	let showDetails = $state(false);

	/** Latest-call-wins guard.  identity.subscribe can fire multiple
	 *  times during sign-in (initial unlock + JIT keys land), and the
	 *  user can sign out → in mid-fetch.  Without this guard, a stale
	 *  in-flight refresh could overwrite a fresh result with a stale
	 *  one, or write the previous user's banner to a now-different
	 *  account.  The fetch generation increments on every refresh()
	 *  call; only writes from the latest generation are accepted. */
	let fetchGen = 0;

	async function refresh(): Promise<void> {
		if (!browser) return;
		const myGen = ++fetchGen;
		const acct = getUserBlurtAccount();
		if (!acct) {
			// Signed out — clear the banner.  This write is unguarded
			// (no async wait) so it can't be raced.
			status = null;
			return;
		}
		const result = await getOperatorBlockStatus(acct);
		// Drop if a newer refresh started while we were awaiting,
		// OR if the user signed out / switched account in the
		// meantime.
		if (myGen !== fetchGen) return;
		if (getUserBlurtAccount() !== acct) return;
		if (!result.ok) {
			// Network / shape error.  Stay silent.
			return;
		}
		status = result.data;
	}

	onMount(() => {
		// Subscribe to identity changes — fetch on sign-in, clear
		// on sign-out.
		const unsub = identity.subscribe(async () => {
			await refresh();
		});
		return unsub;
	});

	/** Format `since` as a localized YYYY-MM-DD date.  The full
	 *  ISO timestamp is in the chain record but a date alone is
	 *  more readable in the banner.  We use the user's locale via
	 *  Intl.DateTimeFormat — no extra dependency. */
	function formatSince(iso: string): string {
		// Sitewide canonical date format ("30 June, 2026").
		return formatDayMonth(iso);
	}

	const isBlocked = $derived(status !== null && status.blocked === true);
</script>

{#if isBlocked && status !== null && status.blocked === true}
	<aside
		class="border-b-2 border-rose-700 bg-rose-950 px-4 py-3 text-rose-100"
		role="alert"
		aria-live="polite"
	>
		<div class="mx-auto max-w-screen-xl">
			<h2 class="text-base font-semibold">
				{$_('operator_block.banner.title')}
			</h2>
			<p class="mt-2 text-sm">
				{$_('operator_block.banner.body', {
					values: {
						operator: status.operator,
						since: formatSince(status.created_at)
					}
				})}
			</p>

			<p class="mt-2 text-sm font-semibold">
				{$_('operator_block.banner.still_visible_elsewhere')}
			</p>

			{#if status.reason && status.reason.length > 0}
				<p class="mt-2 text-sm">
					<span class="font-semibold">{$_('operator_block.banner.reason_label')}:</span>
					<span class="ml-1 break-words">{status.reason}</span>
				</p>
			{:else}
				<p class="mt-2 text-sm italic text-rose-300">
					{$_('operator_block.banner.no_reason_provided')}
				</p>
			{/if}

			<p class="mt-2 text-sm">
				{$_('operator_block.banner.contact_prefix')}
				<a
					href="https://matrix.to/#/#agorise:matrix.org"
					target="_blank"
					rel="noopener noreferrer"
					class="underline hover:no-underline focus:outline focus:outline-2 focus:outline-rose-300"
				>{$_('operator_block.banner.contact_link')}</a>
			</p>

			<button
				type="button"
				class="mt-3 text-sm underline hover:no-underline focus:outline focus:outline-2 focus:outline-rose-300"
				onclick={() => (showDetails = !showDetails)}
				aria-expanded={showDetails}
			>
				{showDetails
					? $_('operator_block.banner.what_it_means_collapse')
					: $_('operator_block.banner.what_it_means_expand')}
			</button>

			{#if showDetails}
				<div class="mt-3 space-y-3 text-sm">
					<div>
						<h3 class="font-semibold">
							{$_('operator_block.banner.what_it_does_do')}
						</h3>
						<ul class="mt-1 list-disc space-y-1 pl-5">
							<li>
								{$_('operator_block.banner.does_filter_listings')}
							</li>
						</ul>
					</div>
					<div>
						<h3 class="font-semibold">
							{$_('operator_block.banner.what_it_does_not_do')}
						</h3>
						<ul class="mt-1 list-disc space-y-1 pl-5">
							<li>{$_('operator_block.banner.not_funds')}</li>
							<li>{$_('operator_block.banner.not_other_instances')}</li>
							<li>{$_('operator_block.banner.not_chain')}</li>
							<li>{$_('operator_block.banner.reversible')}</li>
						</ul>
					</div>
					<p>
						<a href={lp(`/chat/${status.operator}`)} class="font-semibold underline hover:no-underline">
							{$_('operator_block.banner.contact_operator', {
								values: { operator: status.operator }
							})}
						</a>
					</p>
				</div>
			{/if}
		</div>
	</aside>
{/if}
