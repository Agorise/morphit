<script lang="ts">
	import { formatDayMonth } from '$lib/i18n/formatters';
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import { getOperators, getInstances } from '$indexer/client';
	import { getProfilesBatch } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import type { OperatorRecord, ProfileResponse } from '@morphit/indexer-client';
	// v1.16.12 — instance contact_url keyed by operator tag, used as a fallback
	// when an operator's ON-CHAIN registration carries no contact (its instance may
	// still publish one — e.g. time.relay shows on /instances but not /operators).
	let instanceContactByTag = $state<Record<string, string>>({});
	import CopyButton from '$lib/components/CopyButton.svelte';
	import { normalizeContactUrl, detectContactProtocol } from '@morphit/operator-config/contact';

	// Loading states are explicit so empty-data and failed-fetch
	// don't look the same. `null` means "haven't asked yet"; the
	// returned list itself is the success signal.
	let operators = $state<OperatorRecord[] | null>(null);
	let error: string | null = $state(null);

	/** Profile data for listed operators — used for custom avatars,
	 *  Nostr / Blurt.media glyphs. display_name comes from the
	 *  OperatorRecord itself (set during operator registration op),
	 *  not from this profile map — the registration op IS the
	 *  canonical source for operator display-name, which may be
	 *  stricter-validated than a regular profile name. */
	let profileMap = $state<Record<string, ProfileResponse | null>>({});
	/** False until the operator-profile hydrate has completed once.
	 *  v1.8.13 (the maintainer) — identity labels wait rather than asserting `@account` +
	 *  identicon and rewriting themselves seconds later. */
	let profilesHydrated = $state(false);


	onMount(async () => {
		void getInstances({}).then((r) => {
			if (!r.ok) return;
			const next: Record<string, string> = {};
			for (const inst of r.data.instances) {
				if (inst.operator_tag && inst.contact_url && !next[inst.operator_tag]) {
					next[inst.operator_tag] = inst.contact_url;
				}
			}
			instanceContactByTag = next;
		});
		const res = await getOperators();
		if (res.ok) {
			operators = [...res.data.operators];
			// Fire-and-forget: hydrate profile data for custom avatar +
			// social links. Operator list is small (dozens at most);
			// one batch call suffices.
			const accounts = operators.map((o) => o.account);
			if (accounts.length > 0) {
				void getProfilesBatch(accounts).then((fetched) => {
					const next = { ...profileMap };
					for (const [a, p] of fetched) {
						next[a] = p;
					}
					profileMap = next;
					profilesHydrated = true;
				});
			}
		} else {
			console.warn('[operators] load failed:', res.message);
			error = $_('operators.error.load_failed');
			operators = [];
		}
	});

	// Display helpers — kept inline because they're single-page
	// concerns. If a second page needs the same formatting, move
	// them to $lib/utils.
	function formatBlurt(n: number): string {
		return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(n);
	}

	function formatDate(iso: string): string {
		// Sitewide canonical date format ("30 June, 2026").
		return formatDayMonth(iso);
	}

	// Contact links are created with the shared, scheme-aware contact policy
	// (normalizeContactUrl → detectContactProtocol), matching the instances page.
	// It accepts every allowlisted scheme (mailto, matrix, xmpp, https, session,
	// cwtch, …) and repairs a bare email to mailto:, so an operator's email /
	// Matrix / XMPP / Discord-invite contact renders — not just https (the old
	// https-only validator here silently dropped everything else, v1.16.9).

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));

	// t.txt #3 — the subtitle links the word "instances" to the instances page.
	// Fill the {link} placeholder with a sentinel, split the localized string on
	// it, and render an <a> between the parts, so the link sits at the
	// grammatically-correct spot in every locale (word order varies).
	const SUBTITLE_LINK_SLOT = '\u0000IL\u0000';
	const subtitleParts = $derived.by(() => {
		const full = $_('operators.subtitle', { values: { link: SUBTITLE_LINK_SLOT } }) as string;
		const i = full.indexOf(SUBTITLE_LINK_SLOT);
		if (i < 0) return { before: full, after: '' };
		return { before: full.slice(0, i), after: full.slice(i + SUBTITLE_LINK_SLOT.length) };
	});
</script>

<Head routeKey="operators" />

<section class="mx-auto max-w-5xl px-4 py-12 md:px-6 md:py-16">
	<header class="text-center">
		<h1 class="font-display text-3xl font-extrabold tracking-tight md:text-5xl">
			<span class="brand-gradient-text">{$_('operators.title')}</span>
		</h1>
		<p class="mx-auto mt-4 max-w-2xl text-ink-700 dark:text-ink-300">
			{subtitleParts.before}<a
				href={lp('/instances')}
				class="text-morphit-teal hover:underline dark:text-morphit-emerald"
				>{$_('operators.subtitle_instances_link')}</a
			>{subtitleParts.after}
		</p>
	</header>

	<!-- The run-your-own CTA stays prominent even on a populated
		 directory — the whole point of listing operators is to
		 make it easy to become one. -->
	<div class="mt-10 flex flex-wrap items-center justify-center gap-3">
		<a href={lp('/run-a-node')} class="btn-primary btn-shine">
			{$_('operators.run_cta')}
		</a>
		<a
			href={lp('/faq#how_operators_earn')}
			class="rounded-xl border border-ink-300 px-5 py-3 font-semibold text-ink-800 transition hover:border-morphit-emerald hover:text-morphit-emerald dark:border-ink-700 dark:text-ink-200"
		>
			{$_('operators.learn_cta')}
		</a>
	</div>

	<hr class="my-12 border-ink-200 dark:border-ink-800" />

	{#if operators === null}
		<!-- Loading. Skeleton cards match the final card count rough -->
		<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
			{#each Array(3) as _, i (i)}
				<li class="card animate-pulse border border-ink-200 dark:border-ink-800">
					<div class="h-5 w-3/4 rounded bg-ink-200 dark:bg-ink-800"></div>
					<div class="mt-3 h-4 w-1/2 rounded bg-ink-200 dark:bg-ink-800"></div>
					<div class="mt-6 h-3 w-2/3 rounded bg-ink-200 dark:bg-ink-800"></div>
				</li>
			{/each}
		</ul>
	{:else if operators.length === 0}
		<!-- Empty state. Phase 5b pre-ADR-0013 ships with this
			 view. Copy is written assuming no operator has ever
			 registered yet — once ADR-0013 lands and the first
			 operator registers, this branch becomes unreachable
			 and the populated branch takes over. -->
		<div
			class="mx-auto max-w-2xl rounded-2xl border border-dashed border-ink-200 bg-ink-50 p-10 text-center dark:border-ink-800 dark:bg-ink-950"
		>
			<p class="text-6xl" aria-hidden="true">🌱</p>
			<h2 class="mt-4 font-display text-2xl font-bold">
				{$_('operators.empty_heading')}
			</h2>
			<p class="mt-3 text-ink-700 dark:text-ink-300">{$_('operators.empty_body')}</p>
			<a href={lp('/run-a-node')} class="btn-primary btn-shine mt-6 inline-flex">
				{$_('operators.empty_cta')}
			</a>
			{#if error}
				<p class="mt-6 text-xs text-ink-500">
					{$_('operators.load_error')}: {error}
				</p>
			{/if}
		</div>
	{:else}
		<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each operators as op (op.account)}
				{@const labelProps = extractLabelPropsFromProfile(profileMap[op.account])}
				<li class="card border border-ink-200 dark:border-ink-800">
					<header class="flex items-start gap-3">
						<!--
							IdentityLabel carries the identicon avatar + display_name
							+ account fingerprint. display_name comes from the
							operator registration op (canonical for operators);
							avatarSvg / avatarDataUri / nostrUrl / streamingUrl
							are hydrated separately from the operator's regular
							profile record.
						-->
						<IdentityLabel
							pending={!profilesHydrated}
							account={op.account}
							displayName={op.display_name}
							avatarSvg={labelProps.avatarSvg}
							avatarDataUri={labelProps.avatarDataUri}
							href={lp(`/@${op.account}`)}
							weight="bold"
							showCopy={false}
							avatarSize={40}
							class="min-w-0 flex-1"
						/>

						{#if !op.is_active}
							<span
								class="flex-none rounded-full border border-ink-500/50 bg-ink-500/10 px-2 py-0.5 text-xs font-semibold text-ink-300"
								>{$_('operators.inactive_badge')}</span
							>
						{/if}
					</header>

					<p class="mt-2 flex items-center gap-2 text-sm">
						<span class="flex-none text-xs uppercase tracking-wider text-ink-500"
							>{$_('operators.tag_label')}</span
						>
						<code
							class="rounded bg-ink-200 px-1.5 py-0.5 text-xs text-morphit-emerald dark:bg-ink-800"
						>
							{op.tag}
						</code>
					</p>

					{#if op.stats}
						<dl class="mt-5 grid grid-cols-2 gap-3 text-sm">
							<div>
								<dt class="text-xs uppercase tracking-wider text-ink-500">
									{$_('operators.orders_attributed')}
								</dt>
								<dd class="mt-0.5 font-display text-lg font-semibold">
									{op.stats.total_orders_attributed}
								</dd>
							</div>
							<div>
								<dt class="text-xs uppercase tracking-wider text-ink-500">
									{$_('operators.earnings_lifetime')}
								</dt>
								<dd class="mt-0.5 font-display text-lg font-semibold">
									{formatBlurt(op.stats.cumulative_blurt_earned)}
									<span class="text-sm font-normal text-ink-600 dark:text-ink-400">BLURT</span>
								</dd>
							</div>
						</dl>
					{/if}

					<footer class="mt-5 flex items-center justify-between text-xs text-ink-500">
						<span>
							{$_('operators.registered_on')}
							{formatDate(op.registered_at)}
						</span>
						{#if op.contact_url || instanceContactByTag[op.tag]}
							{@const safeContact = normalizeContactUrl(op.contact_url || instanceContactByTag[op.tag] || '')}
							{#if safeContact}
								{@const cp = detectContactProtocol(safeContact)}
								{#if cp && !cp.clickable}
									<!-- session:/cwtch: etc. — not a browser-openable link; offer copy -->
									<CopyButton
										value={safeContact}
										label={$_('operators.contact')}
										class="inline-flex items-center text-morphit-emerald hover:underline"
									/>
								{:else}
									<a
										href={safeContact}
										rel="noopener noreferrer nofollow"
										class="truncate text-morphit-emerald hover:underline"
									>
										{$_('operators.contact')}
									</a>
								{/if}
							{/if}
						{/if}
					</footer>
				</li>
			{/each}
		</ul>
	{/if}
</section>
