<!--
	Morphit — payment-methods picker (Batch L).

	Multi-select with three category sections (Crypto, In Person,
	Online — alphabetized per user preference), each collapsible.
	Search box at top filters across name + description (AND
	semantics across whitespace-separated terms).

	Selected methods render as chips above the picker; tapping a
	chip removes it.  When at least one method is selected, the
	description of the most-recently-selected one renders below
	the picker as an inline tooltip-style affordance.

	Asset-exclusion: the `excludeForAsset` prop hides crypto
	entries matching the order's traded asset (e.g. `BTC` hides
	"Bitcoin (BTC)" so users can't accidentally pick "buy BTC
	with BTC").

	Instance additions: `instanceAdditions` prop carries any
	operator-defined extra methods (keyed `@instance:foo`).  They
	render in their own "Instance additions" section at the
	bottom and are tagged with a "(this instance only)" label.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import type { AssetTicker } from '@morphit/asset-registry';
	import {
		PAYMENT_METHODS,
		PAYMENT_CATEGORIES_ORDERED,
		groupByCategory,
		isInstanceKey,
		findPaymentMethod,
		type PaymentMethodEntry,
		type PaymentCategory
	} from '$lib/payments/registry';
	import { searchPaymentMethods } from '$lib/payments/search';
	import { instance } from '$lib/stores/instance';
	import { safeContactUrl } from '$lib/utils/safeContactUrl';

	interface Props {
		/** Currently-selected payment-method keys (canonical or
		 *  instance-namespaced).  Two-way bound by the form. */
		selected: string[];
		/** Asset being traded; hides matching crypto entries. */
		excludeForAsset?: AssetTicker;
		/** Optional instance-defined additions.  Each entry uses a
		 *  key like `@instance:promptpay`. */
		instanceAdditions?: readonly PaymentMethodEntry[];
		/** Maximum methods that can be selected.  Mirrors the
		 *  pre-Batch-L cap of 12. */
		max?: number;
		/** Called when selection changes — emits the new array. */
		onchange?: (next: string[]) => void;
		/** Whether the picker's selection is currently invalid
		 *  (e.g. the form requires at least one method but none
		 *  is selected).  Surfaces as `aria-invalid` on the
		 *  picker's root region so screen readers announce the
		 *  invalidity when the picker is focused.  The picker
		 *  doesn't render its own error message — the parent
		 *  form is responsible (typically via a StatusLine
		 *  beneath the picker), and supplies that message's id
		 *  via `describedById` so the picker's root advertises
		 *  it as the source of the explanation. */
		invalid?: boolean;
		/** id of the parent form's error-message element (the
		 *  StatusLine usually).  Wired into the picker root's
		 *  `aria-describedby` only when `invalid` is true and
		 *  this prop is supplied — pointing at a missing id is
		 *  itself an a11y bug per Memory fact #46. */
		describedById?: string;
	}

	let {
		selected = $bindable([]),
		excludeForAsset,
		instanceAdditions = [],
		max = 12,
		onchange,
		invalid = false,
		describedById
	}: Props = $props();

	let query = $state('');
	// O (cp295): the four standard category sections start COLLAPSED so
	// the picker opens compact — the user expands only the category they
	// pay with. (The operator's own "instance additions" section, if any,
	// stays open since it's small and operator-curated.)
	let collapsed = $state<Record<PaymentCategory | 'instance', boolean>>({
		crypto: true,
		in_person: true,
		by_mail: true,
		online: true,
		instance: false
	});

	/** i18n description lookup.  Returns the translated string
	 *  for `payment_method.<key>.description` or null if no
	 *  description i18n key exists.  svelte-i18n returns the
	 *  key itself on miss; we detect that and report null. */
	function descFor(key: string): string | null {
		const i18nKey = `payment_method.${key}.description`;
		const v = $_(i18nKey);
		if (typeof v !== 'string' || v === i18nKey || v.length === 0) return null;
		return v;
	}

	/** Canonical payment-method keys the operator disabled on this
	 *  instance — hidden from the picker so sellers can't OFFER a
	 *  method the instance doesn't support (e.g. "barter_goods"). */
	const disabledMethods = $derived($instance?.disabled_payment_methods ?? []);

	/** Combined entries: canonical + instance additions, minus any
	 *  the operator disabled.  Used by the search helper. */
	const allEntries = $derived(
		[...PAYMENT_METHODS, ...instanceAdditions].filter((e) => !disabledMethods.includes(e.key))
	);

	/** Search-filtered entries with score.  Empty query → all
	 *  entries with score 0 (caller renders by category +
	 *  alphabetical order). */
	const searchHits = $derived(
		searchPaymentMethods(allEntries, query, descFor, { excludeForAsset })
	);

	/** Are we in "search mode"?  When the user has typed something,
	 *  collapse category headers and render a flat ranked list. */
	const inSearchMode = $derived(query.trim().length > 0);

	/** Reactive scheme-allowlisted version of the operator's
	 *  contact URL.  Computed up here (rather than via {@const}
	 *  inline in the template) because Svelte 5 requires
	 *  {@const} to be the immediate child of a control-flow
	 *  block, which isn't where this value is read. */
	const safeContactUrlMemo = $derived(safeContactUrl($instance.contact_url));

	/** Grouped (no-search-query) view.  Excludes asset-matching
	 *  crypto entries.  Pure derivation; cheap. */
	const grouped = $derived.by(() => {
		const g = groupByCategory();
		const out = new Map<PaymentCategory, PaymentMethodEntry[]>();
		for (const cat of PAYMENT_CATEGORIES_ORDERED) {
			const entries = g.get(cat)!;
			const filtered = (
				excludeForAsset
					? entries.filter((e) => e.assetExclusion !== excludeForAsset)
					: entries.slice()
			).filter((e) => !disabledMethods.includes(e.key));
			out.set(cat, filtered);
		}
		return out;
	});

	function isSelected(key: string): boolean {
		return selected.includes(key);
	}

	function toggle(key: string): void {
		if (isSelected(key)) {
			const next = selected.filter((k) => k !== key);
			selected = next;
			onchange?.(next);
			return;
		}
		if (selected.length >= max) return;
		const next = [...selected, key];
		selected = next;
		onchange?.(next);
	}

	function nameFor(key: string): string {
		const canonical = findPaymentMethod(key);
		if (canonical) return canonical.name;
		// Instance addition?
		const inst = instanceAdditions.find((e) => e.key === key);
		if (inst) return inst.name;
		// Legacy free-text — display verbatim.  Shouldn't reach
		// here from the picker, but defensive.
		return key;
	}

	function categoryLabel(cat: PaymentCategory): string {
		const i18nKey = `payment_method.category.${cat}`;
		return $_(i18nKey);
	}

	const maxReached = $derived(selected.length >= max);
</script>

<div
	class="space-y-3"
	role="group"
	aria-label={$_('post_order.form.payment_methods_label')}
	aria-describedby={invalid && describedById ? describedById : undefined}
>
	<!-- Selected chips ─────────────────────────────────────── -->
	{#if selected.length > 0}
		<div class="flex flex-wrap gap-2">
			{#each selected as key (key)}
				<span
					class="inline-flex items-center gap-1 rounded-full border border-morphit-emerald bg-emerald-50 px-3 py-1 text-sm dark:bg-ink-800"
				>
					{nameFor(key)}
					{#if isInstanceKey(key)}
						<span
							class="text-xs text-ink-500 dark:text-ink-400"
							title={$_('payment_method.instance_addition_label')}
						>
							*
						</span>
					{/if}
					<button
						type="button"
						class="text-morphit-emerald active:scale-[0.9]"
						aria-label={$_('payment_method.remove_aria') as string}
						onclick={() => toggle(key)}>×</button
					>
				</span>
			{/each}
		</div>
	{/if}

	<!-- Search box ─────────────────────────────────────────── -->
	<div>
		<input
			type="text"
			name="payment-methods-search"
			bind:value={query}
			maxlength="64"
			placeholder={$_('payment_method.search_placeholder')}
			aria-invalid={invalid || undefined}
			aria-describedby={invalid && describedById ? describedById : undefined}
			class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
			autocomplete="off"
			autocapitalize="off"
			autocorrect="off"
			spellcheck="false"
		/>
		<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
			{$_('payment_method.search_hint')}
		</p>
	</div>

	{#if maxReached}
		<p class="text-xs text-amber-700 dark:text-amber-300">
			{$_('payment_method.max_reached', { values: { max } })}
		</p>
	{/if}

	<!-- Picker body ────────────────────────────────────────── -->
	{#if inSearchMode}
		<!-- Flat ranked list for search results -->
		<ul class="space-y-1">
			{#each searchHits as { entry } (entry.key)}
				<li>
					<button
						type="button"
						onclick={() => toggle(entry.key)}
						disabled={!isSelected(entry.key) && maxReached}
						class="flex w-full items-center justify-between gap-3 rounded-lg border border-ink-200 px-3 py-2 text-left text-sm transition cursor-pointer hover:border-morphit-emerald disabled:cursor-not-allowed disabled:opacity-50 dark:border-ink-800 {isSelected(
							entry.key
						)
							? 'bg-emerald-50 dark:bg-ink-800'
							: ''}"
					>
						<span class="flex flex-col gap-0.5">
							<span class="font-semibold">
								{entry.name}
								{#if isInstanceKey(entry.key)}
									<span class="ml-1 text-xs font-normal text-ink-500 dark:text-ink-400">
										({$_('payment_method.instance_addition_label')})
									</span>
								{/if}
							</span>
							{#if descFor(entry.key)}
								<span class="text-xs text-ink-500 dark:text-ink-400">
									{descFor(entry.key)}
								</span>
							{/if}
						</span>
						<input
							type="checkbox"
							class="pointer-events-none h-4 w-4 accent-morphit-emerald"
							name={`pm-${entry.key}`}
							checked={isSelected(entry.key)}
							tabindex="-1"
							readonly
						/>
					</button>
				</li>
			{:else}
				<li class="text-sm text-ink-500 dark:text-ink-400">{$_('payment_method.no_results')}</li>
			{/each}
		</ul>
	{:else}
		<!-- Categorical view (default) -->
		{#each PAYMENT_CATEGORIES_ORDERED as cat (cat)}
			{@const entries = grouped.get(cat) ?? []}
			{#if entries.length > 0}
				<section class="rounded-xl border border-ink-200 dark:border-ink-800">
					<button
						type="button"
						onclick={() => (collapsed[cat] = !collapsed[cat])}
						class="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold"
						aria-expanded={!collapsed[cat]}
					>
						<span>{categoryLabel(cat)}</span>
						<span class="text-xs text-ink-500 dark:text-ink-400">
							{collapsed[cat] ? '+' : '−'}
						</span>
					</button>
					{#if !collapsed[cat]}
						<ul class="divide-y divide-ink-100 dark:divide-ink-900">
							{#each entries as entry (entry.key)}
								<li>
									<button
										type="button"
										onclick={() => toggle(entry.key)}
										disabled={!isSelected(entry.key) && maxReached}
										class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition cursor-pointer hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-ink-900 {isSelected(
											entry.key
										)
											? 'bg-emerald-50 dark:bg-ink-800'
											: ''}"
									>
										<span class="flex flex-col gap-0.5">
											<span class="font-semibold">{entry.name}</span>
											{#if descFor(entry.key)}
												<span class="text-xs text-ink-500 dark:text-ink-400">
													{descFor(entry.key)}
												</span>
											{/if}
										</span>
										<input
											type="checkbox"
											class="pointer-events-none h-4 w-4 accent-morphit-emerald"
											name={`pm-${entry.key}`}
											checked={isSelected(entry.key)}
											tabindex="-1"
											readonly
										/>
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/if}
		{/each}

		<!-- Instance additions section -->
		{#if instanceAdditions.length > 0}
			<section class="rounded-xl border border-ink-200 dark:border-ink-800">
				<button
					type="button"
					onclick={() => (collapsed.instance = !collapsed.instance)}
					class="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold"
					aria-expanded={!collapsed.instance}
				>
					<span>
						{$_('payment_method.category.instance')}
						<span class="ml-1 text-xs font-normal text-ink-500 dark:text-ink-400">
							({$_('payment_method.instance_addition_label')})
						</span>
					</span>
					<span class="text-xs text-ink-500 dark:text-ink-400">
						{collapsed.instance ? '+' : '−'}
					</span>
				</button>
				{#if !collapsed.instance}
					<ul class="divide-y divide-ink-100 dark:divide-ink-900">
						{#each instanceAdditions as entry (entry.key)}
							<li>
								<button
									type="button"
									onclick={() => toggle(entry.key)}
									disabled={!isSelected(entry.key) && maxReached}
									class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition cursor-pointer hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-ink-900 {isSelected(
										entry.key
									)
										? 'bg-emerald-50 dark:bg-ink-800'
										: ''}"
								>
									<span class="flex flex-col gap-0.5">
										<span class="font-semibold">{entry.name}</span>
										{#if descFor(entry.key)}
											<span class="text-xs text-ink-500 dark:text-ink-400">
												{descFor(entry.key)}
											</span>
										{/if}
									</span>
									<input
										type="checkbox"
										class="pointer-events-none h-4 w-4 accent-morphit-emerald"
										name={`pm-${entry.key}`}
										checked={isSelected(entry.key)}
										tabindex="-1"
										readonly
									/>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	{/if}

	<!-- Request-a-method footer.  When the operator has set
	     `contact_url` in /v1/instance, the "let us know" link
	     points there (matrix room, email, nostr, etc).  When
	     contact_url is null (operator hasn't published a
	     channel), the picker falls back to a no-link version of
	     the prompt — same encouragement, but tells the user the
	     instance hasn't published a contact channel.  Either way,
	     users who can't find the right method see the prompt at
	     the bottom of the picker.

	     BATCH14-7 audit fix — `safeContactUrl` allowlists URI
	     schemes (https/http/mailto/matrix/xmpp/nostr).  A
	     malicious operator setting contact_url=javascript:alert(1)
	     would otherwise XSS users in the operator's frontend
	     origin.  Today's indexer-side regex permits arbitrary
	     URLs that match the URL ABNF; the scheme allowlist is
	     a defense-in-depth client-side check.  When the URL
	     fails the allowlist, we render the no-contact branch
	     as if the operator hadn't set one — which is exactly
	     correct: an unsafe URL is no contact channel. -->
	<p class="mt-3 text-center text-xs text-ink-500 dark:text-ink-400">
		{#if safeContactUrlMemo}
			{$_('payment_method.request_missing_with_contact')}
			<a
				href={safeContactUrlMemo}
				target="_blank"
				rel="noopener noreferrer"
				class="font-semibold text-morphit-emerald underline decoration-dotted underline-offset-2 hover:decoration-solid"
			>
				{$_('payment_method.request_missing_link')}
			</a>
		{:else}
			{$_('payment_method.request_missing_no_contact')}
		{/if}
	</p>
</div>
