<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * FirstTradeHelper — surfaces a 3-step "what to do" panel
	 * the first time a user is in a chat for one of their own
	 * orders.
	 *
	 * Item 16 phase 4 (Item 1.5 from grandma investigation).
	 *
	 * Privacy posture: client-side only.  Looks at the user's
	 * own outgoing-feedback list to detect "have they ever
	 * completed a trade?" — if not, this is plausibly their
	 * first trade and the helper renders.  Once they leave
	 * any feedback, the helper auto-hides on next mount.
	 *
	 * Dismissible per session (sessionStorage).  Once dismissed
	 * for an order, doesn't re-show for that order.  Cleared
	 * on tab close — the next session re-evaluates.
	 *
	 * Renders only when:
	 *   - `orderPermlink` is set (anchored to a specific order).
	 *   - The user has never given feedback (truly first trade).
	 *   - The user hasn't dismissed it for this order this session.
	 */

	import { _ } from 'svelte-i18n';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { getFeedbackGiven } from '$indexer/client';

	interface Props {
		readonly orderPermlink?: string;
	}

	let { orderPermlink }: Props = $props();

	const DISMISSED_KEY = 'morphit.firstTradeHelper.dismissedThisSession';

	function readDismissedSet(): Set<string> {
		if (!browser) return new Set();
		try {
			const raw = window.sessionStorage.getItem(DISMISSED_KEY);
			if (!raw) return new Set();
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return new Set(parsed.filter((x) => typeof x === 'string'));
		} catch {
			// fall through
		}
		return new Set();
	}

	function writeDismissedSet(s: Set<string>): void {
		if (!browser) return;
		try {
			window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...s]));
		} catch {
			// ignore
		}
	}

	let visible = $state(false);
	let loaded = $state(false);
	/** Collapsed by default — the user expands it on demand and can
	 *  collapse it again at will.  Fresh each mount; the box is only
	 *  ever shown to users who have never completed a trade, so a
	 *  quiet collapsed bar is the right default. */
	let collapsed = $state(true);

	function dismiss(): void {
		if (!orderPermlink) return;
		const s = readDismissedSet();
		s.add(orderPermlink);
		writeDismissedSet(s);
		visible = false;
	}

	onMount(() => {
		if (!browser || !orderPermlink) {
			loaded = true;
			return;
		}
		const dismissed = readDismissedSet();
		if (dismissed.has(orderPermlink)) {
			loaded = true;
			return;
		}
		const acct = getUserBlurtAccount();
		if (!acct) {
			loaded = true;
			return;
		}
		// Fetch feedback-given.  If nonempty, the user has done a
		// trade before and the helper isn't relevant anymore.
		void (async () => {
			try {
				const r = await getFeedbackGiven(acct, { limit: 1 });
				if (r.ok && r.data.items.length === 0) {
					visible = true;
				}
			} catch {
				// Network error — don't show.  Defaulting to invisible
				// is the right error mode (avoid being annoying for
				// experienced users on a flaky connection).
			} finally {
				loaded = true;
			}
		})();
	});

	// Part 121 cp7 — per-locale internal-link wrapper.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

{#if loaded && visible}
	<div
		class="mb-3 rounded-xl border-2 border-blue-400/40 bg-blue-400/5"
		aria-label={$_('first_trade_helper.aria_label')}
	>
		<div class="flex items-start justify-between gap-2 p-3">
			<!-- Whole heading row toggles the panel open/closed. -->
			<button
				type="button"
				onclick={() => (collapsed = !collapsed)}
				class="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded-md"
				aria-expanded={!collapsed}
			>
				<span
					class="flex-none text-blue-700 transition-transform dark:text-blue-300 {collapsed
						? ''
						: 'rotate-90'}"
					aria-hidden="true">▸</span
				>
				<h3 class="text-sm font-semibold text-blue-700 dark:text-blue-300">
					{$_('first_trade_helper.heading')}
				</h3>
			</button>
			<button
				type="button"
				onclick={dismiss}
				class="-mr-1 -mt-1 flex-none rounded-md px-2 py-1 text-xs text-ink-600 hover:bg-blue-400/10 hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-200"
				aria-label={$_('first_trade_helper.dismiss_aria') as string}
			>
				✕
			</button>
		</div>
		{#if !collapsed}
			<div class="px-3 pb-3">
				<ol class="space-y-2 text-sm text-ink-700 dark:text-ink-300">
					<li class="flex gap-2">
						<span class="flex-none font-bold text-blue-700 dark:text-blue-300">1.</span>
						<span>{$_('first_trade_helper.step_1')}</span>
					</li>
					<li class="flex gap-2">
						<span class="flex-none font-bold text-blue-700 dark:text-blue-300">2.</span>
						<span
							><strong>{$_('first_trade_helper.step_2_warn')}</strong>
							{$_('first_trade_helper.step_2')}</span
						>
					</li>
					<li class="flex gap-2">
						<span class="flex-none font-bold text-blue-700 dark:text-blue-300">3.</span>
						<span>{$_('first_trade_helper.step_3')}</span>
					</li>
				</ol>
				<p class="mt-3 text-xs text-ink-500 dark:text-ink-500">
					<a
						href={lp('/faq#how_to_trade_walkthrough')}
						class="group underline transition hover:text-morphit-emerald dark:hover:text-morphit-emerald"
					>
						{$_('first_trade_helper.faq_link')} <span
							class="nav-arrow nav-arrow-right"
							aria-hidden="true">⇨</span
						>
					</a>
				</p>
			</div>
		{/if}
	</div>
{/if}
