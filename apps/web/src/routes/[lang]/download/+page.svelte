<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import {
		MIRROR_LOGO_PATHS,
		MIRROR_LOGO_VIEWBOX,
		MIRROR_LOGO_INNER,
		MIRROR_LOGO_FALLBACK
	} from '$lib/mirrorLogos';
	import { ipfsCidTarballUrl, ipnsNativeTarballUrl, ipnsNativeDirUrl } from '$lib/ipns';
	import { release } from '$lib/stores/release';

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
	const GIT_MIRRORS = [
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
		// v1.9.6 (Ken) — gitea.com + framagit.org push-mirrors confirmed live; both are
		// anchored on-chain too (buildDistribution baked list; the mirror cap was
		// bumped 8 -> 10 to fit them).
		{ id: 'gitea', name: 'Gitea', url: 'https://gitea.com/agorise/morphit', status: 'live' },
		{ id: 'framagit', name: 'Framagit', url: 'https://framagit.org/agorise/morphit', status: 'live' },
		// v1.11.1 (Ken) — NINE new push-mirrors on indie git hosts, all confirmed
		// live and anchored on-chain (buildDistribution baked list; the mirror cap
		// was bumped 10 -> 32 to fit them + leave headroom for the pending Savannah
		// + 0xacab mirrors). None has a simple-icons brand glyph, so each renders
		// the shared generic Git mark (MIRROR_LOGO_FALLBACK) beside its real name.
		{ id: 'gitgud', name: 'GitGud', url: 'https://gitgud.io/agorise/morphit', status: 'live' },
		{ id: 'chapril', name: 'Chapril', url: 'https://forge.chapril.org/agorise/morphit', status: 'live' },
		{ id: 'disroot', name: 'Disroot', url: 'https://git.disroot.org/agorise/morphit', status: 'live' },
		{ id: 'kaki87', name: 'KaKi87', url: 'https://git.kaki87.net/agorise/morphit', status: 'live' },
		{ id: 'codefloe', name: 'Codefloe', url: 'https://codefloe.com/agorise/morphit', status: 'live' },
		{ id: 'gitgay', name: 'git.gay', url: 'https://git.gay/agorise/morphit', status: 'live' },
		{ id: 'bolha', name: 'Bolha.dev', url: 'https://bolha.dev/agorise/morphit', status: 'live' },
		{ id: 'opencommit', name: 'OpenCommit', url: 'https://opencommit.eu/agorise/morphit', status: 'live' },
		{ id: 'sijai', name: 'sij.ai', url: 'https://sij.ai/agorise/morphit', status: 'live' }
	] as const;

	// v1.9.6 (Ken) — TWO decentralized "latest release" surfaces:
	//   • IPNS (always latest): native ipns://<name>/… — resolves over the public DHT
	//     with no DNS + no third party (every instance rebroadcasts the signed record;
	//     see $lib/ipns.ts + ops/ipfs/morphit-ipns-rebroadcast.sh). Needs an IPFS-capable
	//     browser; always shown (the URL is static). The privacy/decentralization pick.
	//   • IPFS (always latest): the current release's immutable DIRECTORY CID (from
	//     /v1/release → distribution.ipfs_cid) via ipfs.io — resolves in ANY browser
	//     (grandma), at the cost of one DNS lookup + one gateway. Live once a release
	//     carrying a CID is on-chain; a "coming soon" card until then.
	// (w3name is gone — it stored records off the DHT, so gateways never resolved them.)
	const ipfsCid = $derived(
		$release.kind === 'ok' ? ($release.release.payload.distribution?.ipfs_cid ?? null) : null
	);
	const MIRRORS = $derived([
		...GIT_MIRRORS,
		// The pure pointer first: native ipns:// over the DHT, no DNS, no third party.
		// Always "live" — the URL is static (needs no CID). See the note under the grid.
		{ id: 'ipns', name: 'IPNS (always latest)', url: ipnsNativeTarballUrl(), status: 'live' },
		ipfsCid
			? { id: 'ipfs', name: 'IPFS (always latest)', url: ipfsCidTarballUrl(ipfsCid), status: 'live' }
			: { id: 'ipfs', name: 'IPFS', url: 'https://ipfs.tech/', status: 'pending' }
	]);

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
								<!-- v1.9.6 — the gitea.com + framagit.org mirrors carry real multi-element brand art
								     (fills stripped → currentColor in mirrorLogos.ts); everything
								     else is a single monochrome path. Content is static. -->
								{#if MIRROR_LOGO_INNER[m.id]}
									{@html MIRROR_LOGO_INNER[m.id]}
								{:else}
									<path d={MIRROR_LOGO_PATHS[m.id] ?? MIRROR_LOGO_FALLBACK} />
								{/if}
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
		<!-- v1.9.6 (Ken) — IPNS note: the native ipns:// card needs an IPFS-capable
		     browser; the IPFS card works anywhere. The permanent address is shown as
		     copyable text (select-all) so anyone can paste it into their own node. -->
		<p class="mt-4 text-sm text-ink-600 dark:text-ink-400">
			{$_('download.ipns_note')}
		</p>
		<p class="mt-2">
			<code
				class="select-all break-all rounded bg-ink-100 px-2 py-1 font-mono text-xs text-ink-700 dark:bg-ink-800 dark:text-ink-200"
				>{ipnsNativeDirUrl()}</code
			>
		</p>
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
