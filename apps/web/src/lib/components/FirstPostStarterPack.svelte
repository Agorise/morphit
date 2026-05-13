<script lang="ts">
	/**
	 * FirstPostStarterPack — surfaces a green-tinted explainer
	 * card at the top of /post the first time a user is about
	 * to broadcast their first Morphit order.
	 *
	 * Tier 2.5 of the grandma-friendly investigation: the
	 * post-order form doesn't ask "is this your first time?"
	 * If yes, it could surface a different flow:
	 *   - Strongly recommend a small first trade ("less than
	 *     $50") for safety.
	 *   - Pre-fill a 7-day expiry instead of 90.
	 *   - Explain what each form field means inline rather
	 *     than the user having to figure out which fields
	 *     are required.
	 *
	 * Privacy posture: client-side only.  Looks at the user's
	 * own orders-by-account list to detect "have they ever
	 * posted an order?" — if not, this is plausibly their
	 * first post and the helper renders.  Once they have
	 * any order on record, the helper auto-hides on next
	 * mount.
	 *
	 * Distinct from FirstTradeHelper:
	 *   - FirstTradeHelper renders inside chat for users
	 *     who haven't completed a TRADE (have no outgoing
	 *     feedback).  It surfaces in ConversationView.
	 *   - FirstPostStarterPack renders on /post for users
	 *     who haven't posted an ORDER (have no orders on
	 *     record).  It surfaces in the post-order form.
	 *
	 * A user can be a first-time poster but already-completed-
	 * trade (matched on someone else's order before posting
	 * their own) or a first-time trader but already-posted
	 * (broadcast orders that nobody matched).  The two
	 * helpers cover the two distinct moments.
	 *
	 * Dismissible per session (sessionStorage).  Once
	 * dismissed, doesn't re-show until the next tab/session.
	 *
	 * Renders only when:
	 *   - The user has an account name (anonymous browsers
	 *     can't post anyway).
	 *   - The user has zero orders on record.
	 *   - The user hasn't dismissed it this session.
	 */

	import { _ } from 'svelte-i18n';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { getOrdersByAccount } from '$indexer/client';

	interface Props {
		/** Called once when first-time-poster status is
		 *  determined, with `true` if this is plausibly a
		 *  first-time post and the parent should apply the
		 *  safer-default form values (small amount, 7-day
		 *  expiry, etc.).  Called with `false` if the user
		 *  has prior orders.  Caller can use this to
		 *  conditionally pre-fill before the user sees the
		 *  form.  Optional. */
		onFirstTimeStatus?: (_isFirstTime: boolean) => void;
	}

	let { onFirstTimeStatus }: Props = $props();

	const DISMISSED_KEY = 'morphit.firstPostStarterPack.dismissedThisSession';

	function readDismissed(): boolean {
		if (!browser) return false;
		try {
			return window.sessionStorage.getItem(DISMISSED_KEY) === '1';
		} catch {
			return false;
		}
	}

	function writeDismissed(): void {
		if (!browser) return;
		try {
			window.sessionStorage.setItem(DISMISSED_KEY, '1');
		} catch {
			// ignore quota errors
		}
	}

	let visible = $state(false);
	let loaded = $state(false);

	function dismiss(): void {
		writeDismissed();
		visible = false;
	}

	onMount(() => {
		if (!browser) {
			loaded = true;
			return;
		}
		if (readDismissed()) {
			loaded = true;
			return;
		}
		const acct = getUserBlurtAccount();
		if (!acct) {
			loaded = true;
			return;
		}
		// Fetch the user's orders.  If empty, this is a
		// first-time poster.  Empty here means the indexer
		// has zero orders attributed to this account — both
		// open AND historical (cancelled, expired, completed)
		// are counted, so a user who has previously posted
		// and cancelled doesn't see the helper.
		void (async () => {
			try {
				const r = await getOrdersByAccount(acct, { limit: 1 });
				if (r.ok) {
					const isFirstTime = r.data.items.length === 0;
					visible = isFirstTime;
					onFirstTimeStatus?.(isFirstTime);
				}
			} catch {
				// Network error — don't show.  Defaulting to
				// invisible is the right error mode (avoid
				// being annoying for experienced users on a
				// flaky connection).
			} finally {
				loaded = true;
			}
		})();
	});
</script>

{#if loaded && visible}
	<aside
		class="mb-6 rounded-xl border-2 border-morphit-emerald/40 bg-emerald-50 p-4 dark:bg-ink-900"
		aria-label={$_('first_post_starter.aria_label')}
	>
		<div class="mb-2 flex items-start justify-between gap-2">
			<h3 class="font-display text-base font-bold text-morphit-emerald">
				🌱 {$_('first_post_starter.heading')}
			</h3>
			<button
				type="button"
				onclick={dismiss}
				class="-mr-1 -mt-1 rounded-md px-2 py-1 text-xs text-ink-600 hover:bg-emerald-100 hover:text-ink-800 dark:text-ink-400 dark:hover:bg-emerald-900 dark:hover:text-ink-200"
				aria-label={$_('first_post_starter.dismiss_aria') as string}
			>
				✕
			</button>
		</div>
		<p class="mb-3 text-sm text-ink-700 dark:text-ink-200">
			{$_('first_post_starter.intro')}
		</p>
		<ul class="space-y-2 text-sm text-ink-700 dark:text-ink-200">
			<li class="flex gap-2">
				<span class="flex-none text-morphit-emerald">✓</span>
				<span>
					<strong>{$_('first_post_starter.tip_small_label')}</strong>
					{$_('first_post_starter.tip_small_body')}
				</span>
			</li>
			<li class="flex gap-2">
				<span class="flex-none text-morphit-emerald">✓</span>
				<span>
					<strong>{$_('first_post_starter.tip_expiry_label')}</strong>
					{$_('first_post_starter.tip_expiry_body')}
				</span>
			</li>
			<li class="flex gap-2">
				<span class="flex-none text-morphit-emerald">✓</span>
				<span>
					<strong>{$_('first_post_starter.tip_payment_label')}</strong>
					{$_('first_post_starter.tip_payment_body')}
				</span>
			</li>
		</ul>
		<p class="mt-3 text-xs text-ink-500 dark:text-ink-500">
			<a
				href="/faq#how_to_trade_walkthrough"
				class="underline hover:text-morphit-emerald"
			>
				{$_('first_post_starter.faq_link')}
			</a>
		</p>
	</aside>
{/if}
