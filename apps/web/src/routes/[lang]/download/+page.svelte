<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import { MIRROR_LOGO_PATHS, MIRROR_LOGO_VIEWBOX } from '$lib/mirrorLogos';
	import { MORPHIT_IPNS_NAME, ipnsLatestTarballUrl } from '$lib/ipns';

	// Source mirrors.  Morphit's canonical repository is our own Forgejo
	// server; it's mirrored across the web so the code stays reachable
	// even if one host is blocked or disappears.  `status`:
	//   'primary' — the canonical Forgejo repo (direct link)
	//   'live'    — mirror is up; link straight to the Morphit repo
	//   'pending' — mirror not created yet; link to the SITE ROOT (never a
	//               broken link) and the section copy tells the visitor to
	//               search "morphit" there.  Flip to 'live' + a direct repo
	//               URL once each mirror exists.
	//
	// NB: Morphit ships ONLY as a PWA — there is no APK / IPA / Flatpak /
	// native package, by design (the PWA installs on every platform from
	// the browser).  So this page has no app-store listings.
	//
	// Sally finding DL1: there is NO /morphit.apk direct-download link
	// anymore (PWA-only, per the note above) — the old broken APK link
	// that 404'd on instances without a manually-dropped APK is gone.
	const MIRRORS = [
		{
			id: 'forgejo',
			name: 'git.agorise.net',
			url: 'https://git.agorise.net/agorise/morphit',
			status: 'primary'
		},
		{ id: 'github', name: 'GitHub', url: 'https://github.com/Agorise/morphit', status: 'live' },
		{
			id: 'codeberg',
			name: 'Codeberg',
			url: 'https://codeberg.org/agorise/morphit',
			status: 'live'
		},
		// v1.8.16 (Ken) — SourceForge + SourceHut mirrors are live and anchored
		// on-chain (buildDistribution baked list). They link straight to the repo.
		{
			id: 'sourceforge',
			name: 'SourceForge',
			url: 'https://sourceforge.net/projects/agorise-morphit/',
			status: 'live'
		},
		{ id: 'sourcehut', name: 'SourceHut', url: 'https://git.sr.ht/~agorise/morphit', status: 'live' },
		{ id: 'gitlab', name: 'GitLab', url: 'https://gitlab.com/Agorise/morphit', status: 'live' },
		// v1.8.16 (Ken) — Bitbucket + Launchpad push-mirrors confirmed live. Every
		// git mirror is now live; only IPFS remains pending (per-release
		// content-addressed copy, auto-pinned once a release runs with PINATA_JWT).
		// Removed earlier: Gitee (site down), GitFlic (no signup confirmation
		// email), Radicle (requires installing their app).
		{ id: 'bitbucket', name: 'Bitbucket', url: 'https://bitbucket.org/agorise/morphit', status: 'live' },
		{
			id: 'launchpad',
			name: 'Launchpad',
			url: 'https://git.launchpad.net/~agorise/+git/morphit',
			status: 'live'
		},
		// IPFS: once Morphit's stable IPNS name is configured (scripts/ipns-keygen.mjs
		// → paste into $lib/ipns.ts), this card goes live and always resolves to the
		// LATEST release via IPNS; until then it stays a "coming soon" card. The
		// per-release immutable CID is separately anchored on-chain (distribution.ipfs_cid).
		MORPHIT_IPNS_NAME
			? { id: 'ipfs', name: 'IPFS (always latest)', url: ipnsLatestTarballUrl(), status: 'live' }
			: { id: 'ipfs', name: 'IPFS', url: 'https://ipfs.tech/', status: 'pending' }
	] as const;

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));

	function mirrorLabel(status: string): string {
		if (status === 'primary') return $_('download.mirror_primary');
		if (status === 'live') return $_('download.mirror_open');
		return $_('download.mirror_pending');
	}
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

	<!-- Install Morphit (PWA).  Morphit installs from the browser on every
	     platform — no app store, no native package. -->
	<!-- Already emerald-tinted at rest; adding the hover would DIM its
	     border (/40 -> /20) on hover, which reads as the card receding. -->
	<section class="card border-morphit-emerald/40 bg-morphit-emerald/5">
		<h2 class="font-display text-xl font-bold">
			{$_('download.pwa_heading')}
		</h2>
		<p class="mt-2 text-ink-700 dark:text-ink-300">
			{$_('download.pwa_body')}
		</p>
		<p class="mt-3 text-sm text-ink-600 dark:text-ink-400">
			{$_('download.pwa_platforms')}
		</p>
		<div class="mt-4 flex flex-wrap gap-3">
			<a href={lp('/')} class="btn-primary">
				{$_('download.web_cta')}
			</a>
		</div>
	</section>

	<!-- Source code & mirrors.  Canonical Forgejo repo + web mirrors;
	     pending mirrors link to the site root (no broken links) and the
	     body copy says to search "morphit" there for now. -->
	<section class="mt-6">
		<h2 class="font-display text-xl font-bold">
			{$_('download.mirrors_heading')}
		</h2>
		<p class="mt-2 text-ink-700 dark:text-ink-300">
			{$_('download.mirrors_body')}
		</p>
		<p class="mt-3 text-sm">
			<a
				href={lp('/faq#morphit_mirrors')}
				class="text-morphit-emerald underline decoration-dotted underline-offset-2 hover:no-underline"
			>
				{$_('download.why_mirrors', {
					values: { count: MIRRORS.filter((m) => m.status !== 'primary').length }
				})}
			</a>
		</p>
		<ul class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each MIRRORS as m (m.id)}
				<li>
					<a
						href={m.url}
						target="_blank"
						rel="noopener noreferrer external"
						class="card-interactive card-hover-emerald flex cursor-pointer items-center justify-between gap-3 {m.status ===
						'primary'
							? 'border-morphit-emerald/40 bg-morphit-emerald/5'
							: ''}"
					>
						<span class="flex min-w-0 items-center gap-3">
							<svg
								viewBox={MIRROR_LOGO_VIEWBOX[m.id] ?? '0 0 24 24'}
								width="20"
								height="20"
								fill="currentColor"
								aria-hidden="true"
								class="flex-none text-ink-500 dark:text-ink-400"
							>
								<path d={MIRROR_LOGO_PATHS[m.id]} />
							</svg>
							<span class="min-w-0">
								<span class="block font-display font-bold">{m.name}</span>
								<span
									class="block text-xs {m.status === 'pending'
										? 'text-ink-500 dark:text-ink-400'
										: 'text-morphit-emerald'}"
								>
									{mirrorLabel(m.status)}
								</span>
							</span>
						</span>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
							class="flex-none text-ink-400"
						>
							<path d="M7 17 17 7" />
							<path d="M7 7h10v10" />
						</svg>
					</a>
				</li>
			{/each}
		</ul>
	</section>

	<!-- Visual divider — everything above is for END USERS who want to
	     trade.  Everything below is for OPERATORS who want to run their
	     own Morphit instance.  These are different audiences with
	     different needs (PWA install vs. server deployment). -->
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
		<!-- Already emerald-tinted at rest; adding the hover would DIM its
	     border (/40 -> /20) on hover, which reads as the card receding. -->
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
			     optionally a GPG signature, recorded on-chain.  Applies to
			     the source tarballs + container images operators run. -->
			<p class="mt-4 text-sm text-ink-500 dark:text-ink-400">
				{$_('download.operator_verify_note')}
			</p>
		</section>

		<!-- Setup walkthrough. -->
		<section class="card card-hover-emerald mt-6">
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
		<section class="card card-hover-emerald mt-6">
			<h3 class="font-display text-xl font-bold">
				{$_('download.operator_distros_heading')}
			</h3>
			<p class="mt-2 text-ink-700 dark:text-ink-300">
				{$_('download.operator_distros_body')}
			</p>
			<div class="mt-4 flex flex-wrap gap-3">
				<a href={lp('/faq#node_minimum_requirements')} class="btn-ghost">
					{$_('download.operator_distros_faq_cta')}
				</a>
			</div>
		</section>

		<!-- Operators directory. -->
		<section class="card card-hover-emerald mt-6">
			<h3 class="font-display text-xl font-bold">
				{$_('download.operator_join_heading')}
			</h3>
			<p class="mt-2 text-ink-700 dark:text-ink-300">
				{$_('download.operator_join_body')}
			</p>
			<div class="mt-4 flex flex-wrap gap-3">
				<a href={lp('/operators')} class="btn-secondary">
					{$_('download.operator_join_cta')}
				</a>
				<a href={lp('/instances')} class="btn-ghost">
					{$_('download.operator_instances_cta')}
				</a>
			</div>
		</section>
	</div>
</div>
