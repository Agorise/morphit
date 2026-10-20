<script lang="ts">
	/**
	 * RewardsPanel — "What you get on {brand}": every reward a user of this site
	 * can receive, when, and how, in plain words (v1.21.3).
	 *
	 * Each line states what the code does (apps/relay/src/api/create.ts for the
	 * account and its 4 BLURT; apps/indexer/src/indexer/handlers/order.ts for the
	 * free first buy; loyalty.ts for the 1 BP stake and the milestones;
	 * handlers/feedback.ts for the 10 + 10 first-trade bonus;
	 * lowBalanceScanner.ts for the top-ups). Rewards are paid by the relay of the
	 * site whose operator tag is on the order, so a site without an operator tag
	 * pays none of them: the panel is not shown there.
	 */
	import { page } from '$app/stores';
	import { _ } from 'svelte-i18n';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { instance } from '$stores/instance';

	const ITEMS = [
		'free_account',
		'free_buy',
		'welcome_stake',
		'first_trade',
		'loyalty',
		'top_up'
	] as const;

	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
	const paysRewards = $derived($instance.loaded && $instance.operator_tag !== null);
</script>

{#if paysRewards}
	<section
		class="card mb-6 border border-ink-200 dark:border-ink-800"
		aria-labelledby="rewards-panel-heading"
		data-testid="rewards-panel"
	>
		<h2 id="rewards-panel-heading" class="font-display text-xl font-bold">
			{$_('rewards.heading')}
		</h2>
		<p class="mt-2 text-sm text-ink-700 dark:text-ink-300">{$_('rewards.intro')}</p>
		<ul id="rewards-panel-list" class="mt-5 grid gap-4 sm:grid-cols-2">
			{#each ITEMS as item (item)}
				<li class="flex items-start gap-3">
					<span class="mt-0.5 flex-none text-morphit-emerald" aria-hidden="true">✓</span>
					<span>
						<strong class="block text-ink-900 dark:text-ink-50"
							>{$_(`rewards.${item}_title`)}</strong
						>
						<span class="text-sm text-ink-700 dark:text-ink-300">{$_(`rewards.${item}_body`)}</span>
					</span>
				</li>
			{/each}
		</ul>
		<p class="mt-4 text-xs text-ink-500 dark:text-ink-400">{$_('rewards.lent_note')}</p>
		<div class="mt-5 flex flex-wrap items-center gap-3">
			<a
				href="{lp('/faq')}?q=welcome_bonus&lang={currentLang}"
				class="text-sm font-semibold text-morphit-emerald hover:underline"
			>
				{$_('rewards.learn_more')}
			</a>
		</div>
	</section>
{/if}
