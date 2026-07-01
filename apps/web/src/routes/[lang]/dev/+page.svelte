<script lang="ts">
	/**
	 * /dev — diagnostic-tools landing page.
	 *
	 * The /dev subtree is for operator and contributor diagnostics
	 * (icon catalog, responsive viewport preview, WebAuthn probe).
	 * Before cp136 this directory had three children but no index,
	 * so a direct visit to /dev returned 404 with no signpost to
	 * the actual tools.  Sally-operator finding F-3.
	 *
	 * No telemetry, no auth, no chain calls — pure static link list.
	 */
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';

	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));

	// Order chosen to match what an operator would touch in priority:
	// (1) icons first — most-visited; needed when customising payment-method UI
	// (2) responsive — second-most; how does my custom branding look on mobile
	// (3) yubikey-probe — last; only matters if the operator uses hardware keys
	const TOOLS = [
		{
			path: '/dev/icons',
			titleKey: 'dev.index.icons.title',
			bodyKey: 'dev.index.icons.body'
		},
		{
			path: '/dev/responsive',
			titleKey: 'dev.index.responsive.title',
			bodyKey: 'dev.index.responsive.body'
		},
		{
			path: '/dev/yubikey-probe',
			titleKey: 'dev.index.yubikey_probe.title',
			bodyKey: 'dev.index.yubikey_probe.body'
		}
	] as const;
</script>

<Head routeKey="dev_index" />

<section class="mx-auto max-w-3xl px-4 py-12 md:px-6">
	<h1 class="font-display text-3xl font-extrabold tracking-tight">
		{$_('dev.index.heading')}
	</h1>
	<p class="mt-3 text-ink-600 dark:text-ink-300">
		{$_('dev.index.subhead')}
	</p>

	<ul class="mt-8 grid gap-4">
		{#each TOOLS as t (t.path)}
			<li>
				<a
					href={lp(t.path)}
					class="block rounded-2xl border border-ink-200 bg-white p-5 transition hover:border-morphit-emerald hover:shadow-md dark:border-ink-700 dark:bg-ink-900"
				>
					<div class="flex items-center gap-3">
						<code
							class="rounded-md bg-ink-100 px-2 py-0.5 font-mono text-sm text-ink-700 dark:bg-ink-800 dark:text-ink-200"
						>
							{t.path}
						</code>
						<h2 class="font-display text-lg font-bold">
							{$_(t.titleKey)}
						</h2>
					</div>
					<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
						{$_(t.bodyKey)}
					</p>
				</a>
			</li>
		{/each}
	</ul>

	<p class="mt-10 text-sm text-ink-500 dark:text-ink-400">
		{$_('dev.index.footnote')}
	</p>
</section>
