<script lang="ts">
	/**
	 * /dev — diagnostic-tools landing page.
	 *
	 * The /dev subtree is for operator and contributor diagnostics
	 * (icon catalog, responsive viewport preview, WebAuthn probe).
	 * Previously this directory had three children but no index,
	 * so a direct visit to /dev returned 404 with no signpost to
	 * the actual tools.  Sally-operator finding F-3.
	 *
	 * No telemetry, no auth, no chain calls — pure static link list.
	 *
	 * English only, like the tools it links: the page 404s in production
	 * (./+layout.ts), so its copy is not shipped in the locale files.
	 */
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
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
			title: 'Icon catalog',
			body: 'Browse every icon shipped in the codebase. Click any tile to copy its name. Handy when adding a custom payment-method or alt-network glyph.'
		},
		{
			path: '/dev/responsive',
			title: 'Responsive preview',
			body: 'Render the current site at five simulated viewport widths (320 / 375 / 768 / 1024 / 1440 px). Useful when QA-ing custom branding on mobile.'
		},
		{
			path: '/dev/yubikey-probe',
			title: 'WebAuthn / YubiKey probe',
			body: 'Test whether your hardware key works with this instance, list known credentials, register or remove an authenticator. Same code path the Settings → Hardware key card uses.'
		}
	] as const;
</script>

<Head routeKey="dev_index" />

<section class="mx-auto max-w-3xl px-4 py-12 md:px-6">
	<h1 class="font-display text-3xl font-extrabold tracking-tight">
		Developer &amp; operator tools
	</h1>
	<p class="mt-3 text-ink-600 dark:text-ink-300">
		Diagnostic utilities for operators customizing their instance and contributors verifying build
		output. None of these collect telemetry or require sign-in.
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
							{t.title}
						</h2>
					</div>
					<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
						{t.body}
					</p>
				</a>
			</li>
		{/each}
	</ul>

	<p class="mt-10 text-sm text-ink-500 dark:text-ink-400">
		These pages are intentionally unstyled and information-dense. If you stumbled here as a regular
		user, head to the homepage — these tools are not for trading.
	</p>
</section>
