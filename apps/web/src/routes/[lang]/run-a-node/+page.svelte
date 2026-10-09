<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import Term from '$components/Term.svelte';

	/** The release this site runs (baked in at build time), named on the download button. */
	const version = typeof __MORPHIT_VERSION__ === 'string' ? __MORPHIT_VERSION__ : '';

	// per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="run_a_node" />

<section class="mx-auto max-w-4xl px-4 py-12 md:px-6 md:py-16">
	<header class="text-center">
		<h1 class="font-display text-3xl font-extrabold tracking-tight md:text-5xl">
			<span class="brand-gradient-text">{$_('run_a_node.title')}</span>
		</h1>
		<p class="mx-auto mt-4 max-w-2xl text-ink-700 dark:text-ink-300">
			{$_('run_a_node.subtitle_pre')}<a
				href={lp('/instances')}
				class="text-morphit-emerald hover:underline">{$_('run_a_node.subtitle_link')}</a
			>{$_('run_a_node.subtitle_post')}
		</p>
	</header>

	<!-- Tier 1.4 follow-up: inline glossary cues for the
	     handful of jargon words this page leans on heavily.  The
	     <Term> component renders each as dotted-underline +
	     hover/tap tooltip, with the underline cue suppressed on
	     subsequent appearances on the same route. -->
	<aside
		class="mt-6 rounded-lg border border-ink-200 bg-ink-50 px-4 py-3 text-sm text-ink-700 dark:border-ink-800 dark:bg-ink-950/50 dark:text-ink-300"
		aria-label={$_('run_a_node.key_terms.aria')}
	>
		<p class="font-semibold text-ink-900 dark:text-ink-50">
			{$_('run_a_node.key_terms.heading')}
		</p>
		<p class="mt-1">
			{$_('run_a_node.key_terms.intro_1')}
			<Term key="operator">{$_('run_a_node.key_terms.term_operator')}</Term>
			{$_('run_a_node.key_terms.intro_2')}
			<Term key="indexer">{$_('run_a_node.key_terms.term_indexer')}</Term>{$_('run_a_node.key_terms.and')}<Term
				key="relay">{$_('run_a_node.key_terms.term_relay')}</Term>{$_('run_a_node.key_terms.intro_3')}
			<Term key="federation">{$_('run_a_node.key_terms.term_federation')}</Term>{$_('run_a_node.key_terms.intro_4')}
		</p>
	</aside>

	<!-- Why: the motivations for third-party operators. Ordered by
		 strength — censorship resistance first, earnings second,
		 because putting money first attracts the wrong kind of
		 operator. -->
	<section class="mt-12">
		<h2 class="font-display text-2xl font-bold">{$_('run_a_node.why_heading')}</h2>
		<ul class="mt-6 grid gap-5 md:grid-cols-2">
			<li class="card border border-ink-200 dark:border-ink-800">
				<h3 class="font-display text-lg font-bold">
					{$_('run_a_node.why_uncensor_title')}
				</h3>
				<p class="mt-2 text-ink-700 dark:text-ink-300">{$_('run_a_node.why_uncensor_body')}</p>
			</li>
			<li class="card border border-ink-200 dark:border-ink-800">
				<h3 class="font-display text-lg font-bold">
					{$_('run_a_node.why_community_title')}
				</h3>
				<p class="mt-2 text-ink-700 dark:text-ink-300">{$_('run_a_node.why_community_body')}</p>
			</li>
			<li class="card border border-ink-200 dark:border-ink-800">
				<h3 class="font-display text-lg font-bold">
					{$_('run_a_node.why_privacy_title')}
				</h3>
				<p class="mt-2 text-ink-700 dark:text-ink-300">{$_('run_a_node.why_privacy_body')}</p>
				<p class="mt-2 text-ink-700 dark:text-ink-300">{$_('run_a_node.why_privacy_body_2')}</p>
			</li>
			<li class="card border border-ink-200 dark:border-ink-800">
				<h3 class="font-display text-lg font-bold">
					{$_('run_a_node.why_earn_title')}
				</h3>
				<p class="mt-2 whitespace-pre-line text-ink-700 dark:text-ink-300">{$_('run_a_node.why_earn_body')}</p>
			</li>
		</ul>
	</section>

	<!-- v1.21.3: the money, both ways, so an operator knows what to fund.
	     Figures: the 90/10 split (indexer fee.ts, featureBid.ts, strangerFee.ts);
	     the relay's costs (relay api/create.ts: chain fee + 2 BLURT; indexer
	     feedback.ts: 10 + 10; loyalty.ts: 1 BP + milestones; config:
	     1 BLURT top-ups, 50 BLURT/hour featured floor). -->
	<section class="mt-14" aria-labelledby="earn-box-heading">
		<h2 id="earn-box-heading" class="font-display text-2xl font-bold">
			{$_('run_a_node.earn_box.heading')}
		</h2>
		<div class="mt-6 grid gap-5 md:grid-cols-2">
			<div class="card border border-morphit-emerald/40 bg-morphit-emerald/5">
				<h3 class="font-display text-lg font-bold text-morphit-emerald">
					{$_('run_a_node.earn_box.earn_title')}
				</h3>
				<ul class="mt-3 space-y-2 text-ink-700 dark:text-ink-300">
					{#each ['earn_listing', 'earn_featured', 'earn_stranger'] as k (k)}
						<li class="flex gap-2">
							<span class="text-morphit-emerald" aria-hidden="true">+</span>
							<span>{$_(`run_a_node.earn_box.${k}`)}</span>
						</li>
					{/each}
				</ul>
				<p class="mt-3 text-sm text-ink-600 dark:text-ink-400">{$_('run_a_node.earn_box.earn_when')}</p>
			</div>
			<div class="card border border-ink-200 dark:border-ink-800">
				<h3 class="font-display text-lg font-bold">{$_('run_a_node.earn_box.pay_title')}</h3>
				<ul class="mt-3 space-y-2 text-ink-700 dark:text-ink-300">
					{#each ['pay_account', 'pay_bonus', 'pay_lent', 'pay_top_up', 'pay_server'] as k (k)}
						<li class="flex gap-2">
							<span class="text-ink-500" aria-hidden="true">−</span>
							<span>{$_(`run_a_node.earn_box.${k}`)}</span>
						</li>
					{/each}
				</ul>
			</div>
		</div>
		<p class="mt-5 text-ink-700 dark:text-ink-300">{$_('run_a_node.earn_box.rule')}</p>
		<p class="mt-3 text-ink-700 dark:text-ink-300">{$_('run_a_node.earn_box.fund')}</p>
	</section>

	<!-- How: a linear walkthrough of setup, pointing readers at the
		 OPERATIONS.md runbook for full detail. This page is the
		 marketing onramp; OPERATIONS.md is the operations manual. -->
	<section class="mt-14">
		<h2 class="font-display text-2xl font-bold">{$_('run_a_node.how_heading')}</h2>
		<ol class="mt-6 space-y-4">
			{#each [1, 2, 3] as n (n)}
				<li
					class="flex gap-4 rounded-2xl border border-ink-200 bg-white p-5 dark:border-ink-800 dark:bg-ink-900"
				>
					<span
						class="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-morphit-gradient font-display text-sm font-bold text-ink-950"
					>
						{n}
					</span>
					<div>
						<h3 class="font-display text-lg font-bold">
							{$_(`run_a_node.step${n}_title`)}
						</h3>
						{#if n === 2}
							<p class="mt-1 text-ink-700 dark:text-ink-300">
								<a href={lp('/download')} class="text-morphit-emerald hover:underline"
									>{$_('run_a_node.step2_download')}</a
								>{$_('run_a_node.step2_body_1')}<code
									class="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-sm text-ink-900 dark:bg-ink-800 dark:text-ink-100"
									>sudo bash morphit-setup.sh</code
								>{$_('run_a_node.step2_body_2')}
							</p>
						{:else}
							<p class="mt-1 text-ink-700 dark:text-ink-300">{$_(`run_a_node.step${n}_body`)}</p>
						{/if}
					</div>
				</li>
			{/each}
		</ol>

	</section>

	<!-- Operator stance: which assets (MORPHIT_INDEXER_DISABLED_ASSETS) and
	     payment methods (MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS, and
	     `morphit-ops payment-method` to add one) a site supports. Peer
	     instances' orders still appear regardless. -->
	<section class="mt-14">
		<h2 class="font-display text-2xl font-bold">
			{$_('run_a_node.asset_policy_heading')}
		</h2>
		<p class="mt-4 text-ink-700 dark:text-ink-300">
			{$_('run_a_node.asset_policy_body')}
		</p>
		<ul class="mt-4 space-y-3 text-ink-700 dark:text-ink-300">
			<li class="flex gap-3">
				<span class="text-morphit-emerald" aria-hidden="true">✓</span>
				<span>
					<strong>{$_('run_a_node.asset_policy_federation_label')}</strong>
					{$_('run_a_node.asset_policy_federation_body')}
				</span>
			</li>
		</ul>
	</section>

	<!-- Requirements: hardware floor + networking. Written to be
		 honest rather than aspirational; a would-be operator
		 should know what they're signing up for. -->
	<section class="mt-14">
		<h2 class="font-display text-2xl font-bold">
			{$_('run_a_node.requirements_heading')}
		</h2>
		<dl class="mt-6 grid gap-4 md:grid-cols-3">
			<div class="card border border-ink-200 dark:border-ink-800">
				<dt class="text-xs uppercase tracking-wider text-ink-500">
					{$_('run_a_node.req_hw_label')}
				</dt>
				<dd class="mt-2 font-display text-base">
					{$_('run_a_node.req_hw_value')}
				</dd>
			</div>
			<div class="card border border-ink-200 dark:border-ink-800">
				<dt class="text-xs uppercase tracking-wider text-ink-500">
					{$_('run_a_node.req_network_label')}
				</dt>
				<dd class="mt-2 font-display text-base">
					{$_('run_a_node.req_network_value')}
				</dd>
			</div>
			<div class="card border border-ink-200 dark:border-ink-800">
				<dt class="text-xs uppercase tracking-wider text-ink-500">
					{$_('run_a_node.req_time_label')}
				</dt>
				<dd class="mt-2 font-display text-base">
					{$_('run_a_node.req_time_value')}
				</dd>
			</div>
		</dl>
	</section>

	<section
		class="mt-14 flex flex-wrap items-center justify-center gap-3 rounded-3xl border border-ink-200 bg-white p-8 text-center dark:border-ink-800 dark:bg-ink-900"
	>
		<div class="w-full">
			<h2 class="font-display text-2xl font-bold">
				{$_('run_a_node.cta_heading')}
			</h2>
		</div>
		<a href={lp('/download')} class="btn-primary btn-shine">
			{$_('run_a_node.cta_repo', { values: { version } })}
		</a>
	</section>
</section>
