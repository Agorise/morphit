<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { page } from '$app/stores';

	// cp242 — per-locale internal-link wrapper (cp7 design: every
	// internal link is locale-prefixed; bare 2-segment paths 404).
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
	/**
	 * /compare
	 *
	 * OPERATOR-TRUST-DESIGN.md item 3: orderbook comparison view.
	 *
	 * User enters another Morphit instance URL. We fetch both
	 * instances' orderbooks with identical filters and diff by the
	 * stable (account, permlink) key — every instance that reads the
	 * same chain SHOULD show the same set of live orders. If one
	 * instance is censoring (Tier 2 bad behavior in the design doc),
	 * the diff surfaces it.
	 *
	 * Limitations the UI is explicit about:
	 *   - This is a one-shot snapshot; both sides may have changed
	 *     in the seconds between fetches.
	 *   - A small disparity is normal — the two instances may be at
	 *     slightly different indexed blocks.
	 *   - A large disparity or a persistent one across refreshes is
	 *     the actual signal.
	 */

	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import { getOrderbook, getOrderbookFromOrigin } from '$lib/indexer/client';
	import { validateInstanceUrl, type InstanceUrlError } from '$utils/instanceUrl';
	import { safeInstanceOrigin } from '$lib/utils/safeContactUrl';
	import type { OrderRecord } from '@morphit/indexer-client';

	/** Keyed view of a set of orders for diffing. Key =
	 *  `${account}/${permlink}` — stable across all instances
	 *  reading the same chain. */
	type KeyedOrders = Map<string, OrderRecord>;

	function keyOf(o: OrderRecord): string {
		return `${o.account}/${o.permlink}`;
	}

	function indexByKey(items: readonly OrderRecord[]): KeyedOrders {
		const m = new Map<string, OrderRecord>();
		for (const o of items) m.set(keyOf(o), o);
		return m;
	}

	let otherUrlInput = $state('');
	let comparing = $state(false);
	let fetchError = $state('');

	let thisOrigin = $state('');
	let otherOrigin = $state('');

	let thisIndexedBlock = $state<number | null>(null);
	let otherIndexedBlock = $state<number | null>(null);

	// Diff output: three sets derived from the two fetched orderbooks.
	let onlyHere = $state<OrderRecord[]>([]);
	let inBoth = $state<OrderRecord[]>([]);
	let onlyThere = $state<OrderRecord[]>([]);

	let hasRun = $state(false);

	onMount(() => {
		thisOrigin = window.location.origin;
	});

	/** Live-validate on input so the Compare button enables/disables
	 *  cleanly and we surface errors before submit. */
	const liveValidation = $derived.by(() => {
		if (otherUrlInput.trim().length === 0) return null;
		return validateInstanceUrl(otherUrlInput);
	});

	const canCompare = $derived(
		!comparing && otherUrlInput.trim().length > 0 && liveValidation !== null && liveValidation.ok
	);

	async function runComparison(): Promise<void> {
		if (!canCompare) return;
		// canCompare already guarantees liveValidation is a valid
		// { ok: true, origin }, so we can assert the shape without
		// re-running the validator here.
		if (liveValidation === null || !liveValidation.ok) return;
		const v = liveValidation;

		// Don't let the user compare an instance to itself — the
		// diff would be trivially empty and it looks broken.
		if (v.origin === thisOrigin) {
			fetchError = $_('compare.error.same_instance');
			return;
		}

		comparing = true;
		fetchError = '';
		hasRun = false;
		otherOrigin = v.origin;

		try {
			// Parallel fetches — one of them failing doesn't stop the
			// other. We report partial success with a clear indication
			// of which side failed.
			const [localRes, remoteRes] = await Promise.all([
				getOrderbook({ limit: 100 }),
				getOrderbookFromOrigin(v.origin, { limit: 100 })
			]);

			if (!localRes.ok) {
				fetchError = $_('compare.error.local_failed', {
					values: { reason: localRes.message }
				});
				return;
			}
			if (!remoteRes.ok) {
				fetchError = $_('compare.error.remote_failed', {
					values: { reason: remoteRes.message, host: v.origin }
				});
				return;
			}

			const hereMap = indexByKey(localRes.data.items);
			const thereMap = indexByKey(remoteRes.data.items);

			thisIndexedBlock = localRes.data.indexed_block;
			otherIndexedBlock = remoteRes.data.indexed_block;

			const oh: OrderRecord[] = [];
			const ib: OrderRecord[] = [];
			const ot: OrderRecord[] = [];

			for (const [k, order] of hereMap) {
				if (thereMap.has(k)) ib.push(order);
				else oh.push(order);
			}
			for (const [k, order] of thereMap) {
				if (!hereMap.has(k)) ot.push(order);
			}

			onlyHere = oh;
			inBoth = ib;
			onlyThere = ot;
			hasRun = true;
		} catch (err) {
			// Either getOrderbook call could throw (network failure
			// pre-response, DNS error, etc).  Without this catch the
			// rejection bubbles unhandled and the user just sees the
			// spinner clear with no feedback.
			console.warn('[compare] orderbook fetch threw:', err);
			fetchError = $_('compare.error.fetch_threw', {
				values: { host: v.origin }
			});
		} finally {
			comparing = false;
		}
	}

	function renderError(reason: InstanceUrlError): string {
		return $_(`compare.url_error.${reason}`);
	}

	function blockGapNote(a: number | null, b: number | null): string {
		if (a === null || b === null) return '';
		const gap = Math.abs(a - b);
		if (gap === 0) return $_('compare.block_gap.synced');
		return $_('compare.block_gap.delta', { values: { blocks: gap } });
	}
</script>

<Head routeKey="compare" />

<div class="mx-auto max-w-4xl px-4 py-12 md:py-16">
	<header class="mb-8">
		<h1 class="font-display text-4xl font-extrabold">
			<span class="brand-gradient-text">{$_('compare.heading')}</span>
		</h1>
		<p class="mt-3 text-ink-600 dark:text-ink-300">{$_('compare.lede')}</p>
	</header>

	<!-- Input form -->
	<section class="card mb-6">
		<label for="other-url" class="block font-semibold">
			{$_('compare.input.label')}
		</label>
		<p class="mt-1 text-sm text-ink-500">{$_('compare.input.hint')}</p>
		<div class="mt-3 flex flex-col gap-2 sm:flex-row">
			<input
				id="other-url"
				type="url"
				bind:value={otherUrlInput}
				placeholder={$_('compare.input.placeholder')}
				class="input flex-1 font-mono"
				maxlength="256"
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				onkeydown={(e) => {
					if (e.key === 'Enter' && canCompare) void runComparison();
				}}
			/>
			<BusyButton type="button" busy={comparing} disabled={!canCompare} onclick={runComparison}>
				{$_('compare.button.compare')}
			</BusyButton>
		</div>
		{#if liveValidation && !liveValidation.ok && otherUrlInput.trim().length > 3}
			<p class="mt-2 text-sm text-red-400" aria-live="polite">
				{renderError(liveValidation.reason)}
			</p>
		{/if}
	</section>

	{#if fetchError}
		<StatusLine kind="error">{fetchError}</StatusLine>
	{/if}

	<!-- Results -->
	{#if hasRun}
		<section class="card mb-6">
			<h2 class="font-display text-xl font-bold">
				{$_('compare.results.heading')}
			</h2>
			<dl class="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
				<div>
					<dt class="text-ink-500">{$_('compare.results.only_here')}</dt>
					<dd class="font-mono text-2xl font-bold">{onlyHere.length}</dd>
				</div>
				<div>
					<dt class="text-ink-500">{$_('compare.results.in_both')}</dt>
					<dd class="font-mono text-2xl font-bold">{inBoth.length}</dd>
				</div>
				<div>
					<dt class="text-ink-500">{$_('compare.results.only_there')}</dt>
					<dd class="font-mono text-2xl font-bold">{onlyThere.length}</dd>
				</div>
				<div>
					<dt class="text-ink-500">{$_('compare.results.block_gap')}</dt>
					<dd class="font-mono text-sm">
						{blockGapNote(thisIndexedBlock, otherIndexedBlock)}
					</dd>
				</div>
			</dl>
			<p class="mt-4 text-xs text-ink-500">
				{$_('compare.results.interpretation')}
			</p>
			<!-- Sally finding CMP1 (Part 69): re-run button.  A user
			     seeing a non-zero `onlyHere`/`onlyThere` diff needs
			     to know whether it's persistent (Tier 2 censorship)
			     or just block-gap timing.  Pre-Part-69 they had to
			     re-type the URL to re-compare.  Now they can re-run
			     with one click — same URL, fresh fetches. -->
			<div class="mt-4">
				<BusyButton
					type="button"
					variant="secondary"
					busy={comparing}
					disabled={comparing}
					onclick={runComparison}
				>
					{$_('compare.button.rerun')}
				</BusyButton>
			</div>
		</section>

		<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
			<article class="card">
				<h3 class="font-semibold">
					{$_('compare.pane.only_here_heading', {
						values: { host: thisOrigin, n: onlyHere.length }
					})}
				</h3>
				{#if onlyHere.length === 0}
					<p class="mt-2 text-sm text-ink-500">
						{$_('compare.pane.empty')}
					</p>
				{:else}
					<!-- Sally finding CMP2 (Part 69): orders in the
					     "only here" pane were rendered as plain mono
					     text — a user seeing a flagged order had no
					     way to click through to investigate.  These
					     are local orders, so the standard
					     /@account/permlink route resolves on the
					     current instance. -->
					<ul class="mt-2 max-h-96 space-y-1 overflow-y-auto text-sm">
						{#each onlyHere as o (keyOf(o))}
							<li>
								<a
									href={lp(`/@${o.account}/${o.permlink}`)}
									class="block break-all font-mono text-xs text-morphit-emerald hover:underline"
								>
									<bdi class="ltr-in-rtl">@{o.account}/{o.permlink}</bdi>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</article>

			<article class="card">
				<h3 class="font-semibold">
					{$_('compare.pane.in_both_heading', {
						values: { n: inBoth.length }
					})}
				</h3>
				{#if inBoth.length === 0}
					<p class="mt-2 text-sm text-ink-500">
						{$_('compare.pane.empty')}
					</p>
				{:else}
					<p class="mt-2 text-sm text-ink-500">
						{$_('compare.pane.in_both_note')}
					</p>
				{/if}
			</article>

			<article class="card">
				<h3 class="font-semibold">
					{$_('compare.pane.only_there_heading', {
						values: { host: otherOrigin, n: onlyThere.length }
					})}
				</h3>
				{#if onlyThere.length === 0}
					<p class="mt-2 text-sm text-ink-500">
						{$_('compare.pane.empty')}
					</p>
				{:else}
					<!-- Sally finding CMP2 (Part 69): orders only on
					     the OTHER instance link out to that
					     instance's profile/order URL — the order is
					     not on this instance to view.  rel external
					     + target=_blank because we're cross-origin.
					     The fact the link goes off-site is the whole
					     point of "only there."
					     Part 70 hardening: wrap otherOrigin through
					     safeInstanceOrigin() before splicing into
					     the href, defense in depth even though
					     validateInstanceUrl() already gated the user
					     input.  Falls back to inline mono text when
					     the origin is rejected (shouldn't happen —
					     validateInstanceUrl was the gate that let
					     the comparison run — but the smoke wants
					     the wrapped form and the safety it provides
					     is real for any future codepath that might
					     populate otherOrigin without going through
					     the form). -->
					{@const safeOther = safeInstanceOrigin(otherOrigin)}
					<ul class="mt-2 max-h-96 space-y-1 overflow-y-auto text-sm">
						{#each onlyThere as o (keyOf(o))}
							<li>
								{#if safeOther}
									<a
										href={`${safeOther}/@${o.account}/${o.permlink}`}
										target="_blank"
										rel="noopener noreferrer external"
										class="block break-all font-mono text-xs text-morphit-emerald hover:underline"
									>
										<bdi class="ltr-in-rtl">@{o.account}/{o.permlink}</bdi> ↗
									</a>
								{:else}
									<span class="block break-all font-mono text-xs text-ink-500">
										<bdi class="ltr-in-rtl">@{o.account}/{o.permlink}</bdi>
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</article>
		</div>

		<p class="mt-6 text-xs text-ink-500">
			{$_('compare.footer.snapshot_note')}
		</p>
	{/if}
</div>
