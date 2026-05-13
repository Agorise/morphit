<script lang="ts">
	/**
	 * Sally finding H7 (Part 68): /support was a one-card stub
	 * that bounced to /faq.  A user clicking "Help & Support"
	 * from the avatar menu deserves more than a redirect.  This
	 * page now surfaces:
	 *   1. Search the FAQ (most questions are already answered)
	 *   2. Operator contact (per-instance — public room or
	 *      operator's contact_url, whatever they configured)
	 *   3. Bug bounty / security disclosure link (private)
	 *   4. Self-host escape hatch (link to /run-a-node)
	 *
	 * No telemetry, no support-ticket form (that would imply a
	 * server-side store of personal complaints, which we
	 * deliberately don't have).  Everything routes to existing
	 * documented surfaces.
	 */
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import { instance } from '$stores/instance';
	import { safeContactUrl } from '$lib/utils/safeContactUrl';

	const safeContact = $derived(safeContactUrl($instance.contact_url));
</script>

<Head routeKey="support" />

<div class="mx-auto max-w-2xl px-4 py-12 md:py-16">
	<header class="mb-8 text-center">
		<h1 class="font-display text-3xl font-extrabold md:text-4xl">
			<span class="brand-gradient-text">{$_('support.heading')}</span>
		</h1>
		<p class="mt-3 text-ink-600 dark:text-ink-300">
			{$_('support.subtitle')}
		</p>
	</header>

	<!-- 1. FAQ search — almost every common question is in there. -->
	<section class="card mb-4">
		<div class="flex items-start gap-3">
			<span class="text-2xl" aria-hidden="true">📖</span>
			<div class="flex-1">
				<h2 class="font-display text-lg font-bold">
					{$_('support.faq.heading')}
				</h2>
				<p class="mt-1 text-sm text-ink-700 dark:text-ink-200">
					{$_('support.faq.body')}
				</p>
				<a class="btn-primary mt-3 inline-flex" href="/faq">
					{$_('support.faq.cta')}
				</a>
			</div>
		</div>
	</section>

	<!-- 2. Operator contact — only renders when this instance has
	     a contact URL configured.  Distinct from the security
	     bounty link below: this is "I'm having trouble using the
	     site" not "I found a vulnerability." -->
	{#if safeContact || $instance.name}
		<section class="card mb-4">
			<div class="flex items-start gap-3">
				<span class="text-2xl" aria-hidden="true">💬</span>
				<div class="flex-1">
					<h2 class="font-display text-lg font-bold">
						{$_('support.operator.heading')}
					</h2>
					<p class="mt-1 text-sm text-ink-700 dark:text-ink-200">
						{#if $instance.name}
							{$_('support.operator.body_with_name', { values: { name: $instance.name } })}
						{:else}
							{$_('support.operator.body_generic')}
						{/if}
					</p>
					{#if safeContact}
						<a class="btn-secondary mt-3 inline-flex" href={safeContact} rel="noopener">
							{$_('support.operator.cta')}
						</a>
					{:else}
						<p class="mt-3 text-xs text-ink-500">
							{$_('support.operator.no_contact_hint')}
						</p>
					{/if}
				</div>
			</div>
		</section>
	{/if}

	<!-- 3. Security disclosure — kept distinct from the operator
	     contact above.  Bugs that put users at risk should go to
	     the project, not (just) to the local operator. -->
	<section class="card mb-4">
		<div class="flex items-start gap-3">
			<span class="text-2xl" aria-hidden="true">🛡️</span>
			<div class="flex-1">
				<h2 class="font-display text-lg font-bold">
					{$_('support.security.heading')}
				</h2>
				<p class="mt-1 text-sm text-ink-700 dark:text-ink-200">
					{$_('support.security.body')}
				</p>
				<a class="btn-secondary mt-3 inline-flex" href="/security#bounty">
					{$_('support.security.cta')}
				</a>
			</div>
		</div>
	</section>

	<!-- 4. Self-host escape hatch.  When the project's policy or
	     this operator's behavior is the source of friction, the
	     answer in a federated system is "run your own."  This
	     surface should explicitly mention that. -->
	<section class="card">
		<div class="flex items-start gap-3">
			<span class="text-2xl" aria-hidden="true">🌐</span>
			<div class="flex-1">
				<h2 class="font-display text-lg font-bold">
					{$_('support.self_host.heading')}
				</h2>
				<p class="mt-1 text-sm text-ink-700 dark:text-ink-200">
					{$_('support.self_host.body')}
				</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<a class="btn-ghost" href="/run-a-node">
						{$_('support.self_host.cta_run')}
					</a>
					<a class="btn-ghost" href="/instances">
						{$_('support.self_host.cta_browse')}
					</a>
				</div>
			</div>
		</div>
	</section>
</div>
