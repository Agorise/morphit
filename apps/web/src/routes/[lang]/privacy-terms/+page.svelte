<script lang="ts">
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
</script>

<Head routeKey="privacy_terms" />

<div class="mx-auto max-w-2xl px-4 py-10 md:py-14">
	<header class="mb-8">
		<h1 class="font-display text-3xl font-extrabold">
			<span class="brand-gradient-text">{$_('privacy_terms.heading')}</span>
		</h1>
	</header>

	<section class="card mb-4">
		<h2 class="mb-3 font-display text-xl font-bold">
			{$_('privacy_terms.privacy_heading')}
		</h2>
		<p class="mb-3 text-ink-700 dark:text-ink-200">
			{$_('privacy_terms.privacy_body_1')}
		</p>
		<p class="mb-3 text-ink-700 dark:text-ink-200">
			{$_('privacy_terms.privacy_body_2')}
		</p>
		<p class="text-ink-700 dark:text-ink-200">
			{$_('privacy_terms.privacy_body_3')}
		</p>
	</section>

	<section class="card">
		<h2 class="mb-3 font-display text-xl font-bold">
			{$_('privacy_terms.terms_heading')}
		</h2>
		<p class="text-ink-700 dark:text-ink-200">
			{$_('privacy_terms.terms_body')}
		</p>
	</section>
</div>
