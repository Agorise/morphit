<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { formatDayMonthTime } from '$i18n/formatters';
	/**
	 * /about-this-instance
	 *
	 * OPERATOR-TRUST-DESIGN.md item 2.
	 *
	 * Consumes the verify.json file produced by
	 * scripts/build-verify-json.mjs at build time. Shows the
	 * instance's claimed version, git commit, build timestamp,
	 * operator tag, and a count of hashed assets.
	 *
	 * The point of this page is LEGIBILITY: users who suspect
	 * they're on a wrong instance can read, at a glance, what
	 * the instance says it is. A watchdog tool (future work)
	 * can then cross-check the hash_manifest against the
	 * latest @morphit release-op on chain.
	 *
	 * Currently this page does NOT fetch the release-op itself —
	 * that requires a chain RPC round trip with the same
	 * endpoint rotation the rest of the frontend uses, and is
	 * complexity that's orthogonal to "make the claim
	 * visible." A followup can add the cross-check; the
	 * scaffolding for endpoint rotation already exists.
	 */

	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { fetchWithTimeout } from '$net/fetchWithTimeout';
	import Head from '$components/Head.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import { instance } from '$stores/instance';
	import { findPaymentMethod } from '$lib/payments/registry';

	interface VerifyPayload {
		schema_version: number;
		morphit_version: string;
		git_commit: string | null;
		operator_tag: string | null;
		built_at: string;
		hash_manifest: Record<string, string>;
	}

	let verify = $state<VerifyPayload | null>(null);
	let loadError = $state<string>('');
	let origin = $state<string>('');

	onMount(async () => {
		origin = window.location.host;
		try {
			const res = await fetchWithTimeout('/verify.json', { cache: 'no-cache' });
			if (!res.ok) {
				loadError = $_('about_this_instance.error.fetch_failed', {
					values: { status: res.status }
				});
				return;
			}
			const body = (await res.json()) as VerifyPayload;
			// typeof null === 'object' in JS, so an explicit null
			// check on hash_manifest is required.
			if (
				typeof body.morphit_version !== 'string' ||
				typeof body.built_at !== 'string' ||
				body.hash_manifest === null ||
				typeof body.hash_manifest !== 'object'
			) {
				loadError = $_('about_this_instance.error.malformed');
				return;
			}
			verify = body;
		} catch (err) {
			console.warn('[about-this-instance] verify.json fetch failed:', err);
			loadError = $_('about_this_instance.error.fetch_failed');
		}
	});

	const manifestFileCount = $derived(verify ? Object.keys(verify.hash_manifest).length : 0);

	/** Short commit hash for visual compactness. Full hash is
	 *  still below for copy/paste. */
	const shortCommit = $derived(verify?.git_commit ? verify.git_commit.slice(0, 7) : null);

	/** Human-readable built-at. */
	const builtAtHuman = $derived.by(() => {
		if (!verify) return '';
		return formatDayMonthTime(verify.built_at);
	});

	/** Aggregate hash: SHA-256 of the manifest JSON itself.
	 *  Shown for quick eyeball comparison against the
	 *  @morphit release-op's published aggregate (once that
	 *  op shape is decided — see OPERATOR-TRUST-DESIGN.md
	 *  item 4). Computed lazily via SubtleCrypto.
	 *
	 *  Keys are sorted before serialization so the aggregate
	 *  is deterministic regardless of runtime iteration order
	 *  — matches what an external verification tool computing
	 *  from the raw JSON would produce. */
	let aggregateHash = $state<string>('');

	$effect(() => {
		if (!verify) return;
		void (async () => {
			const sortedKeys = Object.keys(verify.hash_manifest).sort();
			const sorted: Record<string, string> = {};
			for (const k of sortedKeys) {
				const v = verify.hash_manifest[k];
				if (v !== undefined) sorted[k] = v;
			}
			const manifestStr = JSON.stringify(sorted);
			const enc = new TextEncoder().encode(manifestStr);
			const digest = await crypto.subtle.digest('SHA-256', enc);
			aggregateHash = Array.from(new Uint8Array(digest))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');
		})();
	});

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="about_this_instance" />

<div class="mx-auto max-w-prose px-4 py-12 md:py-16">
	<header class="mb-8">
		<h1 class="font-display text-4xl font-extrabold">
			<span class="brand-gradient-text">
				{$_('about_this_instance.heading')}
			</span>
		</h1>
		<p class="mt-3 text-ink-600 dark:text-ink-300">
			{$_('about_this_instance.lede')}
		</p>
	</header>

	{#if loadError}
		<StatusLine kind="error">
			{loadError}
		</StatusLine>
		<p class="mt-4 text-sm text-ink-600 dark:text-ink-300">
			{$_('about_this_instance.error.suggestion')}
		</p>
	{:else if !verify}
		<p class="text-ink-500">
			{$_('common.loading')}
		</p>
	{:else}
		<!-- The verify.json contents, presented as a readable card -->
		<section class="card mb-6">
			<h2 class="font-display text-xl font-bold">
				{$_('about_this_instance.section.instance')}
			</h2>
			<dl class="mt-4 space-y-3 text-sm">
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-40">
						{$_('about_this_instance.field.origin')}
					</dt>
					<dd class="font-mono">{origin || '—'}</dd>
				</div>
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-40">
						{$_('about_this_instance.field.version')}
					</dt>
					<dd class="font-mono">{verify.morphit_version}</dd>
				</div>
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-40">
						{$_('about_this_instance.field.built_at')}
					</dt>
					<dd>{builtAtHuman}</dd>
				</div>
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-40">
						{$_('about_this_instance.field.commit')}
					</dt>
					<dd class="font-mono">
						{#if shortCommit}
							{shortCommit}
							<span class="ml-2 break-all text-ink-500">({verify.git_commit})</span>
						{:else}
							<span class="text-ink-500">—</span>
						{/if}
					</dd>
				</div>
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-40">
						{$_('about_this_instance.field.operator_tag')}
					</dt>
					<dd class="font-mono">
						{#if verify.operator_tag}
							{verify.operator_tag}
						{:else}
							<span class="text-ink-500">
								{$_('about_this_instance.field.operator_tag_none')}
							</span>
						{/if}
					</dd>
				</div>
				{#if $instance.operator_matrix_room}
					<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
						<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-40">
							{$_('about_this_instance.field.operator_matrix')}
						</dt>
						<dd>
							<a
								class="font-mono text-morphit-emerald hover:underline"
								href="https://matrix.to/#/{encodeURIComponent($instance.operator_matrix_room)}"
								rel="noopener noreferrer"
								target="_blank"
							>
								{$instance.operator_matrix_room}
							</a>
						</dd>
					</div>
				{/if}
			</dl>
		</section>

		<!-- Item 3 / Part 121 cp6 — operator-stance surfacing.
		     Renders THIS instance's asset-policy stance for users who
		     want to know whether they're on a "USDT-enabled" or
		     "privacy-pure" Morphit before deciding to trade here.
		     Data source: $instance.disabled_assets, pulled from
		     /v1/instance at session start (Memory #25 — every new
		     tradable asset defaults ON instance-wide; operators opt
		     OUT via MORPHIT_INDEXER_DISABLED_ASSETS).  Federation
		     note: this is THIS instance's stance; peer instances'
		     stances surface on /operators once the federation probe
		     starts caching disabled_assets (deferred to a follow-on
		     Part; REVISIT entry filed). -->
		<section class="card mb-6">
			<h2 class="font-display text-xl font-bold">
				{$_('about_this_instance.section.asset_stance')}
			</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('about_this_instance.asset_stance.explain')}
			</p>
			<dl class="mt-4 space-y-3 text-sm">
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-40">
						{$_('about_this_instance.asset_stance.disabled_label')}
					</dt>
					<dd>
						{#if $instance.disabled_assets.length === 0}
							<span class="text-morphit-emerald">
								{$_('about_this_instance.asset_stance.disabled_none')}
							</span>
						{:else}
							<span class="font-mono">{$instance.disabled_assets.join(', ')}</span>
							<span class="ml-2 text-ink-500">
								{$_('about_this_instance.asset_stance.disabled_suffix')}
							</span>
						{/if}
					</dd>
				</div>
			</dl>
			<p class="mt-4 text-xs text-ink-500">
				{$_('about_this_instance.asset_stance.federation_note')}
			</p>
		</section>

		<!-- cp208 — payment-method stance, parity with the asset stance
		     above.  Data source: $instance.disabled_payment_methods from
		     /v1/instance.  Canonical keys are mapped to display names via
		     the payments registry; unknown keys fall back to the raw key. -->
		<section class="card mb-6">
			<h2 class="font-display text-xl font-bold">
				{$_('about_this_instance.section.payment_stance')}
			</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('about_this_instance.payment_stance.explain')}
			</p>
			<dl class="mt-4 space-y-3 text-sm">
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-40">
						{$_('about_this_instance.payment_stance.disabled_label')}
					</dt>
					<dd>
						{#if $instance.disabled_payment_methods.length === 0}
							<span class="text-morphit-emerald">
								{$_('about_this_instance.payment_stance.disabled_none')}
							</span>
						{:else}
							<span>
								{$instance.disabled_payment_methods
									.map((k) => findPaymentMethod(k)?.name ?? k)
									.join(', ')}
							</span>
							<span class="ml-2 text-ink-500">
								{$_('about_this_instance.payment_stance.disabled_suffix')}
							</span>
						{/if}
					</dd>
				</div>
			</dl>
			<p class="mt-4 text-xs text-ink-500">
				{$_('about_this_instance.asset_stance.federation_note')}
			</p>
		</section>

		<section class="card mb-6">
			<h2 class="font-display text-xl font-bold">
				{$_('about_this_instance.section.integrity')}
			</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('about_this_instance.integrity.explain', {
					values: { count: manifestFileCount }
				})}
			</p>
			<dl class="mt-4 space-y-3 text-sm">
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-40">
						{$_('about_this_instance.field.file_count')}
					</dt>
					<dd class="font-mono">{manifestFileCount}</dd>
				</div>
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-40">
						{$_('about_this_instance.field.aggregate_hash')}
					</dt>
					<dd class="break-all font-mono">
						{aggregateHash || $_('about_this_instance.field.aggregate_hash_computing')}
					</dd>
				</div>
			</dl>
			<p class="mt-4 text-xs text-ink-500">
				<a
					href="/verify.json"
					target="_blank"
					rel="noopener"
					data-sveltekit-reload
					class="text-morphit-emerald underline decoration-dotted underline-offset-2 hover:no-underline"
				>
					{$_('about_this_instance.integrity.raw_link')}
				</a>
			</p>
		</section>

		<section class="card">
			<h2 class="font-display text-xl font-bold">
				{$_('about_this_instance.section.worried')}
			</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('about_this_instance.worried.explain')}
			</p>
			<!-- Sally finding ATI1 (Part 69): a user who suspects
			     they're on a rogue instance can't trust the rendered
			     links here either — a malicious instance can rewrite
			     the hrefs to point at attacker.example with the
			     visible text still saying "morphit.io".  Surface
			     this honestly with a "type these into your browser
			     bar" warning and render the URLs with select-all
			     styling so they copy cleanly.  The links remain
			     clickable for the much-more-common non-suspicious
			     case (user verifying out of caution, not under
			     attack), but the warning makes the trust boundary
			     visible. -->
			<div
				class="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
			>
				<p class="font-semibold">⚠ {$_('about_this_instance.worried.type_warning_heading')}</p>
				<p class="mt-1">{$_('about_this_instance.worried.type_warning_body')}</p>
			</div>
			<ul class="mt-4 space-y-2 text-sm">
				<li>
					<!-- v1.7.5 (t.txt #10) — `rel="noopener noreferrer"`, like every other
					     outbound link in the app. This was the only external anchor without
					     it. It matters MORE here than it looks: on a FEDERATED instance this
					     link points off-instance, so without noreferrer the destination
					     learns "a user of <this operator's node> clicked through" — a
					     cross-instance correlation hint, handed over for free, on the page
					     whose whole purpose is telling a worried user how to check their
					     operator. `noopener` also denies the target window a handle back. -->
					<a
						href="https://morphit.io"
						target="_blank"
						rel="noopener noreferrer"
						class="select-all text-morphit-emerald underline decoration-dotted underline-offset-2 hover:no-underline"
					>
						morphit.io
					</a>
					<span class="ml-2 text-ink-500">
						{$_('about_this_instance.worried.known_good_note')}
					</span>
				</li>
			</ul>
			<p class="mt-4 text-sm text-ink-700 dark:text-ink-200">
				{$_('about_this_instance.worried.faq_pointer')}
				<a
					href={lp('/faq#rogue_operator')}
					class="text-morphit-emerald underline decoration-dotted underline-offset-2 hover:no-underline"
				>
					{$_('about_this_instance.worried.faq_link')}
				</a>
			</p>
			<p class="mt-3 text-sm text-ink-700 dark:text-ink-200">
				{$_('about_this_instance.worried.compare_tool_pointer')}
				<a
					href={lp('/compare')}
					class="text-morphit-emerald underline decoration-dotted underline-offset-2 hover:no-underline"
				>
					{$_('about_this_instance.worried.compare_tool_label')}
				</a>.
			</p>
		</section>
	{/if}
</div>
