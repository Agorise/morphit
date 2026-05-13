<script lang="ts">
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import AppStoreIcon from '$components/AppStoreIcon.svelte';

	// Store metadata: ID (matches AppStoreIcon store prop + i18n keys),
	// URL, and a hint about whether the URL goes direct to the Morphit
	// listing or to the store's root (which the user then searches).
	//
	// URLs are placeholders here — an operator running their own build
	// substitutes their Morphit listing URLs at build time. The
	// hard-coded defaults point at each store's root.
	//
	// Sally finding DL1 (Part 69): the 'direct' entry used to point
	// at /morphit.apk on the current instance's origin.  That file
	// is NOT shipped in the repo and most operator instances won't
	// host it manually — Sally clicking "direct download" got a
	// 404 with no explanation.  Pointed at the Forgejo releases page
	// instead: every release ships a signed APK there, and the
	// link works regardless of whether this instance hosts a
	// local copy.  Operators who DO host /morphit.apk locally can
	// still override at build time.
	const STORES = [
		{ id: 'fdroid', url: 'https://f-droid.org/' },
		{ id: 'aptoide', url: 'https://aptoide.com/' },
		{ id: 'aptoide_connect', url: 'https://connect.aptoide.com/' },
		{ id: 'apkpure', url: 'https://apkpure.com/' },
		{ id: 'uptodown', url: 'https://uptodown.com/' },
		{ id: 'apkmirror', url: 'https://apkmirror.com/' },
		{ id: 'alternativeto', url: 'https://alternativeto.net/' },
		{ id: 'obtainium', url: 'https://obtainium.imranr.dev/' },
		{ id: 'direct', url: 'https://git.agorise.net/agorise/morphit/releases' }
	] as const;
</script>

<Head routeKey="download" />

<div class="mx-auto max-w-4xl px-4 py-12 md:py-16">
	<header class="mb-10 text-center">
		<h1 class="font-display text-4xl font-extrabold md:text-5xl">
			<span class="brand-gradient-text">{$_('download.title')}</span>
		</h1>
		<p class="mx-auto mt-4 max-w-2xl text-ink-600 dark:text-ink-300">
			{$_('download.subtitle')}
		</p>
	</header>

	<!-- App store grid. Cards are opt-in interactive via .card-interactive
	     so hover/focus affordance matches the rest of the app. -->
	<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
		{#each STORES as store (store.id)}
			<li>
				<a
					href={store.url}
					target={store.url.startsWith('http') ? '_blank' : undefined}
					rel={store.url.startsWith('http') ? 'noopener noreferrer external' : undefined}
					class="card-interactive flex items-start gap-4"
				>
					<AppStoreIcon store={store.id} size={40} class="flex-none text-morphit-emerald" />
					<div class="min-w-0 flex-1">
						<h2 class="font-display text-lg font-bold">
							{$_(`app_stores.${store.id}.name`)}
						</h2>
						<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
							{$_(`app_stores.${store.id}.blurb`)}
						</p>
						<p class="mt-2 break-all font-mono text-xs text-ink-500">
							{store.url}
						</p>
					</div>
				</a>
			</li>
		{/each}
	</ul>

	<!-- Verification reminder. Every build's SHA-256 hash manifest is
	     published in the morphit_release_v1 op on the Blurt chain, so
	     regardless of which store you downloaded from, you can verify
	     the APK hasn't been tampered with. -->
	<section class="card mt-10">
		<h2 class="font-display text-xl font-bold">
			{$_('download.verify_heading')}
		</h2>
		<p class="mt-2 text-ink-700 dark:text-ink-300">
			{$_('download.verify_body')}
		</p>
		<div class="mt-4 flex flex-wrap gap-3">
			<a href="/about-this-instance" class="btn-secondary">
				{$_('download.verify_cta')}
			</a>
			<a href="/faq#app_stores" class="btn-ghost">
				{$_('download.app_stores_faq_cta')}
			</a>
		</div>
	</section>

	<!-- GrapheneOS + Pixel callout. This is the "MOST important"
	     path per the directive — the one that doesn't need the 9-step
	     sideload dance and doesn't need any Google relationship at
	     all. We surface it prominently so users who'd benefit don't
	     have to dig into the FAQ to find it. -->
	<section class="card mt-6 border-morphit-emerald/40 bg-morphit-emerald/5">
		<h2 class="font-display text-xl font-bold">
			{$_('download.graphene_heading')}
		</h2>
		<p class="mt-2 text-ink-700 dark:text-ink-300">
			{$_('download.graphene_body')}
		</p>
		<div class="mt-4 flex flex-wrap gap-3">
			<a
				href="https://grapheneos.org/"
				target="_blank"
				rel="noopener noreferrer external"
				class="btn-secondary"
			>
				{$_('download.graphene_cta')}
			</a>
			<a href="/faq#android_sideload" class="btn-ghost">
				{$_('download.sideload_faq_cta')}
			</a>
		</div>
	</section>

	<!-- iPhone / iPad section.  Item 6.  Apple's App Store does not
	     list non-KYC P2P-crypto apps and would reject Morphit; you do
	     NOT need to jailbreak to use Morphit on iOS, you use the PWA
	     install path through Safari.  This section makes that path
	     explicit so iPhone users don't think they're locked out. -->
	<section class="card mt-6 border-blue-400/40 bg-blue-400/5">
		<h2 class="font-display text-xl font-bold">
			{$_('download.iphone_heading')}
		</h2>
		<p class="mt-2 text-ink-700 dark:text-ink-300">
			{$_('download.iphone_body')}
		</p>
		<ol class="mt-4 list-decimal space-y-1 pl-6 text-ink-700 dark:text-ink-300">
			<li>{$_('download.iphone_step_1')}</li>
			<li>{$_('download.iphone_step_2')}</li>
			<li>{$_('download.iphone_step_3')}</li>
			<li>{$_('download.iphone_step_4')}</li>
		</ol>
		<p class="mt-3 text-sm text-ink-500 dark:text-ink-400">
			{$_('download.iphone_jailbreak_note')}
		</p>
		<div class="mt-4 flex flex-wrap gap-3">
			<a href="/faq#iphone_install" class="btn-ghost">
				{$_('download.iphone_faq_cta')}
			</a>
		</div>
	</section>

	<!-- Web version pointer — for users who'd rather skip any install
	     at all. The FAQ covers this extensively but it's worth a direct
	     CTA here because the whole point of listing 8 app stores is
	     "we're not locked to any one of them," and the zero-install
	     option completes that story. -->
	<section class="card mt-6">
		<h2 class="font-display text-xl font-bold">
			{$_('download.web_heading')}
		</h2>
		<p class="mt-2 text-ink-700 dark:text-ink-300">
			{$_('download.web_body')}
		</p>
		<div class="mt-4 flex flex-wrap gap-3">
			<a href="/" class="btn-primary btn-shine">
				{$_('download.web_cta')}
			</a>
			<a href="/faq#mobile_desktop" class="btn-ghost">
				{$_('download.web_faq_cta')}
			</a>
		</div>
	</section>

	<!-- Visual divider — everything above is for END USERS who want to
	     trade.  Everything below is for OPERATORS who want to run their
	     own Morphit instance.  These are different audiences with
	     different needs (PWA install vs. server deployment).  The
	     directive in #4 of 2026-05-02 user request was explicit about
	     keeping these visually separated. -->
	<div class="mt-12 border-t border-ink-200 pt-12 dark:border-ink-800">
		<header class="mb-8 text-center">
			<h2 class="font-display text-3xl font-extrabold md:text-4xl">
				<span class="brand-gradient-text">{$_('download.operator_section_title')}</span>
			</h2>
			<p class="mx-auto mt-3 max-w-2xl text-ink-600 dark:text-ink-300">
				{$_('download.operator_section_subtitle')}
			</p>
		</header>

		<!-- Source code primary CTA. -->
		<section class="card border-morphit-emerald/40 bg-morphit-emerald/5">
			<h3 class="font-display text-xl font-bold">
				{$_('download.operator_source_heading')}
			</h3>
			<p class="mt-2 text-ink-700 dark:text-ink-300">
				{$_('download.operator_source_body')}
			</p>
			<div class="mt-4 flex flex-wrap gap-3">
				<a
					href="https://git.agorise.net/agorise/morphit"
					target="_blank"
					rel="noopener noreferrer external"
					class="btn-primary"
				>
					{$_('download.operator_source_cta')}
				</a>
				<a
					href="https://git.agorise.net/agorise/morphit/releases"
					target="_blank"
					rel="noopener noreferrer external"
					class="btn-secondary"
				>
					{$_('download.operator_releases_cta')}
				</a>
			</div>
			<!-- Verification: every release has a SHA-256 manifest +
			     optionally a GPG signature.  This applies to BOTH end-user
			     APKs (above) AND operator source tarballs.  Same chain
			     publishes both. -->
			<p class="mt-4 text-sm text-ink-500 dark:text-ink-400">
				{$_('download.operator_verify_note')}
			</p>
		</section>

		<!-- Setup walkthrough. -->
		<section class="card mt-6">
			<h3 class="font-display text-xl font-bold">
				{$_('download.operator_setup_heading')}
			</h3>
			<p class="mt-2 text-ink-700 dark:text-ink-300">
				{$_('download.operator_setup_body')}
			</p>
			<ul class="mt-4 list-disc space-y-1 pl-6 text-ink-700 dark:text-ink-300">
				<li>{$_('download.operator_setup_doc_run')}</li>
				<li>{$_('download.operator_setup_doc_ops')}</li>
				<li>{$_('download.operator_setup_doc_switching')}</li>
				<li>{$_('download.operator_setup_doc_security')}</li>
			</ul>
			<div class="mt-4 flex flex-wrap gap-3">
				<a
					href="https://git.agorise.net/agorise/morphit/src/branch/main/docs/RUN-A-MORPHIT-NODE.md"
					target="_blank"
					rel="noopener noreferrer external"
					class="btn-secondary"
				>
					{$_('download.operator_setup_cta')}
				</a>
			</div>
		</section>

		<!-- Distros / package formats — honest section about what's
		     possible and what isn't. -->
		<section class="card mt-6">
			<h3 class="font-display text-xl font-bold">
				{$_('download.operator_distros_heading')}
			</h3>
			<p class="mt-2 text-ink-700 dark:text-ink-300">
				{$_('download.operator_distros_body')}
			</p>
			<div class="mt-4 flex flex-wrap gap-3">
				<a href="/faq#node_minimum_requirements" class="btn-ghost">
					{$_('download.operator_distros_faq_cta')}
				</a>
			</div>
		</section>

		<!-- Operators directory. -->
		<section class="card mt-6">
			<h3 class="font-display text-xl font-bold">
				{$_('download.operator_join_heading')}
			</h3>
			<p class="mt-2 text-ink-700 dark:text-ink-300">
				{$_('download.operator_join_body')}
			</p>
			<div class="mt-4 flex flex-wrap gap-3">
				<a href="/operators" class="btn-secondary">
					{$_('download.operator_join_cta')}
				</a>
				<a href="/instances" class="btn-ghost">
					{$_('download.operator_instances_cta')}
				</a>
			</div>
		</section>
	</div>
</div>
