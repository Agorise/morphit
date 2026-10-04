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
	 * Shows what this instance says about itself, from the verify.json file
	 * scripts/build-verify-json.mjs writes at build time: version, git
	 * commit, build time, operator tag, number of hashed files.
	 *
	 * Next to that claim it shows the result of the in-page check against
	 * the signed release ($stores/release, the same check the tamper banner
	 * uses): how many of the files the latest @morphit release lists — the
	 * files that start the app — this site served unchanged. It is a
	 * per-file count against the signed manifest; the signed release
	 * carries no aggregate hash, so none is shown. This page makes no
	 * Blurt request of its own: the release check the layout runs is
	 * reused.
	 */

	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { fetchWithTimeout } from '$net/fetchWithTimeout';
	import Head from '$components/Head.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import { instance } from '$stores/instance';
	import { showFeeRecipientUnregistered } from '$stores/feeRecipient';
	import { chainPinnedTreasury, integritySummary } from '$stores/release';
	import { btcFeeKeyId } from '$lib/orders/btcFeeAddress';
	import { findPaymentMethod } from '$lib/payments/registry';

	interface VerifyPayload {
		schema_version: number;
		morphit_version: string;
		git_commit: string | null;
		operator_tag: string | null;
		built_at: string;
		hash_manifest: Record<string, string>;
		/** Present when the operator re-branded files in place (docs/BRANDING.md). */
		operator_branding?: { brand_name?: unknown; files?: unknown };
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

	/** The operator's re-branding disclosure (ops-cli writes it into verify.json):
	 *  the name the site calls itself and how many files it re-branded. A
	 *  green integrity check covers the app code, not who runs the site — this
	 *  row says plainly that this site's look is the operator's own. */
	const branding = $derived.by(() => {
		const b = verify?.operator_branding;
		if (!b || typeof b !== 'object') return null;
		const name = typeof b.brand_name === 'string' ? b.brand_name : '';
		const count = Array.isArray(b.files) ? b.files.length : 0;
		return count > 0 ? { name, count } : null;
	});

	/** Build a link to a Matrix room alias (#…) or user id (@…). We use the
	 *  universal matrix.to redirect (the same link the rest of the app uses)
	 *  rather than the bare `matrix:` URI scheme: most browsers have NO `matrix:`
	 *  protocol handler registered, so a `matrix:` link silently does nothing when
	 *  clicked — which is exactly the "invalid link" users hit here. The alias/id
	 *  lives in the URL *fragment* (after `#`), which browsers never send to the
	 *  matrix.to server, and the room advertised here is public, so there is no
	 *  meaningful click leak.
	 *    #room:server  → https://matrix.to/#/#room:server
	 *    @user:server  → https://matrix.to/#/@user:server                       */
	function matrixUri(alias: string): string {
		return `https://matrix.to/#/${alias}`;
	}

	/** Human-readable built-at. */
	const builtAtHuman = $derived.by(() => {
		if (!verify) return '';
		return formatDayMonthTime(verify.built_at);
	});

	// per-locale internal-link wrapper.  See
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
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
						{$_('about_this_instance.field.origin')}
					</dt>
					<dd class="break-all font-mono">{origin || '—'}</dd>
				</div>
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
						{$_('about_this_instance.field.version')}
					</dt>
					<dd class="font-mono">{verify.morphit_version}</dd>
				</div>
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
						{$_('about_this_instance.field.built_at')}
					</dt>
					<dd>{builtAtHuman}</dd>
				</div>
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
						{$_('about_this_instance.field.commit')}
					</dt>
					<dd class="break-all font-mono">
						{#if verify.git_commit}
							{verify.git_commit}
						{:else}
							<span class="text-ink-500">—</span>
						{/if}
					</dd>
				</div>
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
						{$_('about_this_instance.field.operator_tag')}
					</dt>
					<dd class="font-mono">
						{#if $instance.operator_tag ?? verify.operator_tag}
							{$instance.operator_tag ?? verify.operator_tag}
						{:else}
							<span class="text-ink-500">
								{$_('about_this_instance.field.operator_tag_none')}
							</span>
						{/if}
					</dd>
				</div>
				{#if branding}
					<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
						<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
							{$_('about_this_instance.field.branding')}
						</dt>
						<dd>
							{$_('about_this_instance.field.branding_value', {
								values: { name: branding.name, count: branding.count }
							})}
						</dd>
					</div>
				{/if}
				{#if btcFeeKeyId($chainPinnedTreasury) !== null}
					<!-- v1.20.0 (MK-H2): the chain-pinned treasury BTC key that every BTC
					     listing fee address is derived from. Only its short public id is
					     shown here (the full key is public in the release op anyway). -->
					<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
						<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
							{$_('about_this_instance.field.btc_fee_key')}
						</dt>
						<dd>
							<span class="font-mono">{btcFeeKeyId($chainPinnedTreasury)}</span>
							<span class="ml-2 text-ink-500">
								{$_('about_this_instance.field.btc_fee_key_hint')}
							</span>
						</dd>
					</div>
				{/if}
				{#if $instance.operator_matrix_room}
					<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
						<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
							{$_('about_this_instance.field.operator_matrix')}
						</dt>
						<dd>
							<a
								class="font-mono text-morphit-emerald hover:underline"
								href={matrixUri($instance.operator_matrix_room)}
								rel="noopener noreferrer"
							>
								{$instance.operator_matrix_room}
							</a>
						</dd>
					</div>
				{/if}
			</dl>
			{#if showFeeRecipientUnregistered($instance.fee_recipient_registered)}
				<!-- v1.20.0 (G1): only on a VERIFIED "not registered" (never on
				     null = unknown). Informational, not an alarm: it is the
				     operator's to-do, and visitors' funds are unaffected. -->
				<p
					class="mt-4 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-sm text-ink-800 dark:text-ink-100"
					data-testid="fee-recipient-unregistered"
				>
					{$_('about_this_instance.fee_recipient_unregistered', {
						values: { account: $instance.fee_recipient }
					})}
				</p>
			{/if}
		</section>

		<!-- Item 3 / — operator-stance surfacing.
		     Renders THIS instance's asset-policy stance for users who
		     want to know whether they're on a "USDT-enabled" or
		     "privacy-pure" Morphit before deciding to trade here.
		     Data source: $instance.disabled_assets, pulled from
		     /v1/instance at session start (the default-on rule for new assets — every new
		     tradable asset defaults ON instance-wide; operators opt
		     OUT via MORPHIT_INDEXER_DISABLED_ASSETS).  Federation
		     note: this is THIS instance's stance; peer instances'
		     stances surface on /operators once the federation probe
		     starts caching disabled_assets (deferred to a follow-on
		     Part; backlog entry filed). -->
		<section class="card mb-6">
			<h2 class="font-display text-xl font-bold">
				{$_('about_this_instance.section.asset_stance')}
			</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('about_this_instance.asset_stance.explain')}
			</p>
			<dl class="mt-4 space-y-3 text-sm">
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
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

		<!-- payment-method stance, parity with the asset stance
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
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
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
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
						{$_('about_this_instance.field.file_count')}
					</dt>
					<dd class="font-mono">{manifestFileCount}</dd>
				</div>
				<div class="flex flex-col sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="font-semibold text-ink-700 dark:text-ink-200 sm:w-48 sm:shrink-0">
						{$_('about_this_instance.field.signed_check')}
					</dt>
					<dd data-testid="integrity-summary">
						{#if $integritySummary.kind === 'checked' && $integritySummary.matched === $integritySummary.total}
							<span class="text-morphit-emerald">
								{$_('about_this_instance.integrity.check_ok', {
									values: {
										matched: $integritySummary.matched,
										total: $integritySummary.total,
										version: $integritySummary.version
									}
								})}
							</span>
						{:else if $integritySummary.kind === 'checked'}
							<span class="font-semibold text-red-700 dark:text-red-300">
								{$_('about_this_instance.integrity.check_mismatch', {
									values: {
										matched: $integritySummary.matched,
										total: $integritySummary.total,
										version: $integritySummary.version
									}
								})}
							</span>
						{:else if $integritySummary.kind === 'not_checked'}
							{$_('about_this_instance.integrity.check_not_checked', {
								values: {
									running: $integritySummary.running,
									version: $integritySummary.announced
								}
							})}
						{:else if $integritySummary.kind === 'unconfirmed'}
							{$_('about_this_instance.integrity.check_unconfirmed', {
								values: {
									running: $integritySummary.running,
									version: $integritySummary.announced
								}
							})}
						{:else if $integritySummary.kind === 'no_release'}
							{$_('about_this_instance.integrity.check_no_release')}
						{:else if $integritySummary.kind === 'incomplete'}
							{$_('about_this_instance.integrity.check_incomplete')}
						{:else}
							<span class="text-ink-500">{$_('common.loading')}</span>
						{/if}
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
			<!-- Sally finding ATI1: a user who suspects
			     they're on a rogue instance can't trust the rendered
			     links here either — a malicious instance can rewrite
			     the hrefs to point at attacker.example with the
			     visible text still saying "morphit.io".  Surface
			     this honestly with a "type these into your browser
			     bar" warning and render the URLs with select-all
			     styling so they copy cleanly.  They are addresses to
			     type, not links. -->
			<div
				class="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
			>
				<p class="font-semibold">⚠ {$_('about_this_instance.worried.type_warning_heading')}</p>
				<p class="mt-1">{$_('about_this_instance.worried.type_warning_body')}</p>
			</div>
			<ul class="mt-4 space-y-2 text-sm">
				<li>
					<!-- An address to TYPE (the warning above), not a link: a link here would
					     be a clearnet URL on every instance, hidden-only ones included, and on
					     a rogue instance its href could point anywhere. -->
					<code
						class="select-all text-morphit-emerald underline decoration-dotted underline-offset-2"
						>morphit.io</code
					>
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
