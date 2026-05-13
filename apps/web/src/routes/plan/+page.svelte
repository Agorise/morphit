<script lang="ts">
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import { PHASES, statusI18nKey, statusBadgeClass } from '$lib/plan/phases';
</script>

<Head routeKey="plan" />

<div class="mx-auto max-w-prose px-4 py-12 md:py-16">
	<header class="mb-8 text-center">
		<h1 class="font-display text-4xl font-extrabold">
			<span class="brand-gradient-text">{$_('plan.heading')}</span>
		</h1>
		<p class="mt-3 text-ink-600 dark:text-ink-300">
			{$_('plan.subtitle')}
		</p>
	</header>

	<!-- Sally finding L11 closure (Part 70): phase status is now
	     data-driven from the manifest at $lib/plan/phases.ts.  The
	     hardcoded "in progress" chip on Phase 1 was removed in
	     Part 68; this is the proper replacement.  When a phase
	     ships, flip its status in the manifest and the badge
	     here updates with the build. -->
	<ol class="space-y-4">
		{#each PHASES as phase (phase.number)}
			<li
				class="card"
				class:border-l-4={phase.status === 'in_progress'}
				class:border-l-morphit-lime={phase.status === 'in_progress'}
			>
				<div class="flex items-baseline justify-between gap-3">
					<h2 class="font-display text-lg font-bold">
						{$_(phase.titleKey)}
					</h2>
					<span
						class={`flex-none rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadgeClass(phase.status)}`}
					>
						{$_(statusI18nKey(phase.status))}
					</span>
				</div>
				<p class="mt-2 text-ink-700 dark:text-ink-200">
					{$_(phase.bodyKey)}
				</p>
			</li>
		{/each}
	</ol>

	<footer class="mt-10 text-center text-sm text-ink-500">
		<p>
			{$_('plan.footer_prefix')}
			<a
				href="https://git.agorise.net/agorise/morphit/src/branch/main/docs/PLAN.md"
				class="text-morphit-emerald hover:underline"
				rel="noopener">docs/PLAN.md</a
			>.
		</p>
	</footer>
</div>
