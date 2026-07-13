<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import Head from '$components/Head.svelte';
	import AltNetworkIcon from '$components/AltNetworkIcon.svelte';
	import RelativeTime from '$components/RelativeTime.svelte';
	import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
	import { getInstances } from '$indexer/client';
	import { safeContactUrl, safeInstanceOrigin } from '$lib/utils/safeContactUrl';
	import { formatDayMonth, formatDayMonthTime } from '$i18n/formatters';
	import type { InstanceDirectoryEntry, InstanceProbeStatus } from '@morphit/indexer-client';

	/** Normalize an origin for identity comparison: parse it and take the
	 *  canonical `scheme://host[:port]` (lowercased host, no path / trailing
	 *  slash). Returns null for anything unparseable. */
	function normOrigin(raw: string | null | undefined): string | null {
		if (raw === null || raw === undefined) return null;
		try {
			return new URL(raw).origin.toLowerCase();
		} catch {
			return null;
		}
	}
	/** The origin the browser is currently on — i.e. the instance the user is
	 *  literally viewing. This is how "the current instance" is identified in the
	 *  directory. The pre-cp461 check compared a directory entry's
	 *  `operator_account` to `$instance.relay_account`, which is ALWAYS false on
	 *  any instance that runs separate operator/relay accounts (e.g. the
	 *  canonical morphit.io with @morphit / @morphit-relay / @morphit-fees) — so
	 *  the "you are here" highlight, badge, sort-to-top, and the footer
	 *  Contact-link flash never fired. Origin-matching is robust regardless of
	 *  how many Blurt accounts the operator runs. */
	const currentOrigin = normOrigin(browser ? window.location.origin : null);

	// Map keyed by origin so SSE diffs can apply in O(1).  Filter
	// is applied at render time via the `filtered` derived array
	// rather than baked into the data structure.
	let entries = $state<Map<string, InstanceDirectoryEntry>>(new Map());
	let directoryUpdatedAt: string | null = $state(null);
	let error: string | null = $state(null);
	let statusFilter: '' | InstanceProbeStatus = $state('');
	/** True from the moment the SSE snapshot arrives.  Stays true
	 *  through the rest of the session even on transient
	 *  reconnects, so the UI doesn't flap "loading" badges every
	 *  time the EventSource silently re-establishes. */
	let snapshotReceived = $state(false);
	/** True when we're streaming live; renders a small "Live" pip
	 *  in the header so users know the page is auto-updating. */
	let streaming = $state(false);

	let eventSource: EventSource | null = null;
	/** Setinterval handle for the no-EventSource fallback path. */
	let fallbackTimer: ReturnType<typeof setInterval> | null = null;

	function applySnapshot(payload: {
		instances: readonly InstanceDirectoryEntry[];
		directory_updated_at: string;
	}): void {
		const next = new Map<string, InstanceDirectoryEntry>();
		for (const e of payload.instances) {
			next.set(e.origin, e);
		}
		entries = next;
		directoryUpdatedAt = payload.directory_updated_at;
		snapshotReceived = true;
	}

	function applyAddOrUpdate(entry: InstanceDirectoryEntry): void {
		const next = new Map(entries);
		next.set(entry.origin, entry);
		entries = next;
	}

	function applyRemove(origin: string): void {
		if (!entries.has(origin)) return;
		const next = new Map(entries);
		next.delete(origin);
		entries = next;
	}

	function startStream(): void {
		if (typeof EventSource === 'undefined') {
			// Browser without EventSource (very rare) — fall back
			// to a one-shot REST fetch + periodic refetch.  Same
			// data, just with poll latency baked in.
			void fallbackLoad();
			fallbackTimer = setInterval(() => {
				void fallbackLoad();
			}, 30_000);
			return;
		}
		const url = new URL('/v1/instances/stream', resolveOrigin(MORPHIT_INDEXER_ORIGIN)).href;
		eventSource = new EventSource(url);

		eventSource.addEventListener('snapshot', (ev: MessageEvent) => {
			try {
				applySnapshot(JSON.parse(ev.data));
				streaming = true;
				// SSE worked — if a fallback poll was running because
				// of an earlier connect failure, leave it running.
				// Each REST poll is a no-op when streaming is alive
				// (applySnapshot is idempotent).  Clearing here
				// would be slightly cleaner; not worth the
				// complexity right now.
			} catch (err) {
				error = err instanceof Error ? err.message : 'snapshot parse failed';
			}
		});
		eventSource.addEventListener('instance_added', (ev: MessageEvent) => {
			try {
				applyAddOrUpdate(JSON.parse(ev.data));
			} catch {
				// Ignore parse errors on diffs — next snapshot will
				// reconcile if we missed something.
			}
		});
		eventSource.addEventListener('instance_updated', (ev: MessageEvent) => {
			try {
				applyAddOrUpdate(JSON.parse(ev.data));
			} catch {
				// see above
			}
		});
		eventSource.addEventListener('instance_removed', (ev: MessageEvent) => {
			try {
				const { origin } = JSON.parse(ev.data) as { origin: string };
				applyRemove(origin);
			} catch {
				// see above
			}
		});
		eventSource.addEventListener('error', () => {
			// EventSource auto-reconnects; we mark streaming false
			// transiently so users know connectivity blipped, then
			// it'll flip back true when the next snapshot arrives.
			streaming = false;
			// F-41 audit fix: if we never got a snapshot, the user
			// is staring at "Loading..." with no data.  Kick over
			// to the REST fallback so they see SOMETHING, while
			// EventSource keeps trying in the background.
			if (!snapshotReceived && fallbackTimer === null) {
				void fallbackLoad();
				fallbackTimer = setInterval(() => {
					void fallbackLoad();
				}, 30_000);
			}
		});
	}

	async function fallbackLoad(): Promise<void> {
		const result = await getInstances({});
		if (result.ok) {
			applySnapshot({
				instances: result.data.instances,
				directory_updated_at: result.data.directory_updated_at
			});
			error = null;
		} else if (!snapshotReceived) {
			error = result.message ?? result.code;
		}
	}

	function stopStream(): void {
		if (eventSource !== null) {
			eventSource.close();
			eventSource = null;
		}
		if (fallbackTimer !== null) {
			clearInterval(fallbackTimer);
			fallbackTimer = null;
		}
		streaming = false;
	}

	/** t.txt (v1.4.8) — the footer "Contact" link lands here with
	 *  ?highlight=current; flash the current instance's card border so the eye
	 *  finds "the instance you're actually on". The directory loads ASYNC over a
	 *  stream, so a blind onMount timer used to reset the flag before the card even
	 *  rendered (bug: no flash). Instead fire it once, the moment the snapshot has
	 *  arrived AND the param is present — read reactively from the page store. */
	let flashCurrent = $state(false);
	let flashFired = false;

	onMount(() => {
		if (!browser) return;
		startStream();
	});

	$effect(() => {
		if (flashFired || !snapshotReceived) return;
		if ($page.url.searchParams.get('highlight') !== 'current') return;
		flashFired = true;
		flashCurrent = true;
		// 5 flashes × ~0.45s ≈ 2.25s; clear a hair later.
		setTimeout(() => (flashCurrent = false), 2600);
	});

	onDestroy(() => {
		stopStream();
	});

	// Filtered + sorted view derived from the live entries Map.
	// Sort matches the indexer's /v1/instances ordering: status
	// priority then registered_at desc.
	const STATUS_RANK: Record<InstanceProbeStatus, number> = {
		good: 1,
		quiet: 2,
		syncing: 3,
		stale: 4,
		mismatch: 5,
		unreachable: 6,
		never: 7
	};
	const filtered = $derived.by(() => {
		const arr = Array.from(entries.values());
		const after = statusFilter === '' ? arr : arr.filter((e) => e.status === statusFilter);
		// Sally finding M12 (Part 68): pin the current instance to
		// the top of the list so the user always sees "you are
		// here" without scrolling.  Pre-Part-68 the emerald ring +
		// "this instance" badge were only visible if you scrolled
		// to find them.  The remaining sort (status rank, then
		// recency) applies to everything else.
		return after.sort((a, b) => {
			const aIsCurrent = isCurrentInstance(a);
			const bIsCurrent = isCurrentInstance(b);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const sa = STATUS_RANK[a.status as InstanceProbeStatus] ?? 8;
			const sb = STATUS_RANK[b.status as InstanceProbeStatus] ?? 8;
			if (sa !== sb) return sa - sb;
			// Newer registrations first.
			return b.registered_at.localeCompare(a.registered_at);
		});
	});

	function statusLabel(status: InstanceProbeStatus): string {
		return $_(`instances.status.${status}`);
	}

	/** Brief plain-language explanation of a status, shown in the
	 *  pill's hover tooltip (cursor turns to a question mark). */
	function statusDescription(status: InstanceProbeStatus): string {
		return $_(`instances.status_desc.${status}`);
	}

	function statusClass(status: InstanceProbeStatus): string {
		switch (status) {
			case 'good':
				return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/30';
			case 'quiet':
				return 'bg-ink-500/15 text-ink-800 dark:text-ink-200 ring-1 ring-ink-500/30';
			case 'syncing':
				return 'bg-blue-500/15 text-blue-700 dark:text-blue-300 ring-1 ring-blue-500/30';
			case 'stale':
			case 'mismatch':
				return 'bg-orange-500/15 text-orange-800 dark:text-orange-200 ring-1 ring-orange-500/30';
			case 'unreachable':
				return 'bg-red-500/15 text-red-800 dark:text-red-200 ring-1 ring-red-500/30';
			case 'never':
				return 'bg-ink-500/15 text-ink-700 dark:text-ink-200 ring-1 ring-ink-500/30';
			default:
				return 'bg-ink-500/15 text-ink-700 dark:text-ink-200 ring-1 ring-ink-500/30';
		}
	}

	function effectiveName(entry: InstanceDirectoryEntry): string {
		return (
			entry.name ?? entry.operator_display_name ?? entry.operator_tag ?? entry.operator_account
		);
	}

	/** Whether `entry` describes the same instance the user is currently
	 *  viewing. Matched by ORIGIN (see `currentOrigin` above): the browser is
	 *  literally on this instance, so its origin identifies it unambiguously —
	 *  no matter how many Blurt accounts the operator runs. (The old account
	 *  comparison was always false on any multi-account instance.) A user who
	 *  reaches the instance via a non-canonical mirror domain simply gets no
	 *  highlight rather than a wrong one. */
	function isCurrentInstance(entry: InstanceDirectoryEntry): boolean {
		const eo = normOrigin(entry.origin);
		return eo !== null && currentOrigin !== null && eo === currentOrigin;
	}
</script>

<Head routeKey="instances" />

<section class="mx-auto max-w-5xl px-4 py-12 md:px-6">
	<header class="mb-10">
		<h1 class="font-display text-3xl font-extrabold md:text-4xl">
			<span class="brand-gradient-text">{$_('instances.title')}</span>
		</h1>
		<p class="mt-4 max-w-prose text-ink-700 dark:text-ink-200">
			{$_('instances.intro')}
		</p>
		<div
			class="mt-5 max-w-prose rounded-xl border border-morphit-emerald/30 bg-morphit-emerald/5 p-4 text-sm text-ink-700 dark:border-morphit-emerald/40 dark:bg-morphit-emerald/10 dark:text-ink-200"
		>
			{$_('instances.bookmark_tip')}
		</div>
	</header>

	<div class="mb-6 flex flex-wrap items-end gap-3">
		<label class="flex flex-col gap-1 text-sm">
			<span class="text-xs uppercase tracking-widest text-ink-500">
				{$_('instances.filter_label')}
			</span>
			<select
				bind:value={statusFilter}
				class="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm dark:border-ink-700 dark:bg-ink-900"
			>
				<option value="">{$_('instances.filter_all')}</option>
				<option value="good">{$_('instances.status.good')}</option>
				<option value="quiet">{$_('instances.status.quiet')}</option>
				<option value="syncing">{$_('instances.status.syncing')}</option>
				<option value="stale">{$_('instances.status.stale')}</option>
				<option value="mismatch">{$_('instances.status.mismatch')}</option>
				<option value="unreachable">{$_('instances.status.unreachable')}</option>
				<option value="never">{$_('instances.status.never')}</option>
			</select>
		</label>
	</div>

	{#if error && !snapshotReceived}
		<p
			class="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
			title={error}
		>
			{$_('instances.fetch_error')}
		</p>
	{:else if !snapshotReceived}
		<p class="text-sm text-ink-500">{$_('instances.loading')}</p>
	{:else}
		<div class="mb-6 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-500">
			<p>
				{$_('instances.last_updated', { values: { date: formatDayMonthTime(directoryUpdatedAt) } })}
			</p>
			{#if streaming}
				<span class="inline-flex items-center gap-1.5">
					<span class="relative inline-flex h-2 w-2">
						<span
							class="absolute inline-flex h-full w-full animate-ping rounded-full bg-morphit-emerald opacity-60"
						></span>
						<span class="relative inline-flex h-2 w-2 rounded-full bg-morphit-emerald"></span>
					</span>
					<span class="uppercase tracking-widest">{$_('instances.live')}</span>
				</span>
			{/if}
		</div>

		{#if filtered.length === 0}
			<div
				class="rounded-lg border border-ink-100 bg-ink-50 p-8 text-center dark:border-ink-800 dark:bg-ink-950"
			>
				{#if statusFilter !== '' && entries.size > 0}
					<!-- Peers exist, but none match the active status filter.
					     A filter-aware message avoids the misleading "no peers
					     known yet" copy when the directory is simply filtered. -->
					<p class="font-display text-base font-bold">{$_('instances.no_match_title')}</p>
					<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">{$_('instances.no_match_body')}</p>
				{:else}
					<p class="font-display text-base font-bold">{$_('instances.empty_title')}</p>
					<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">{$_('instances.empty_body')}</p>
				{/if}
			</div>
		{:else}
			<ul class="grid gap-5 md:grid-cols-2">
				{#each filtered as inst (inst.origin)}
					{@const safeOrigin = safeInstanceOrigin(inst.origin)}
					{@const safeContact = safeContactUrl(inst.contact_url)}
					<li
						class="card border {isCurrentInstance(inst)
							? 'border-morphit-emerald/40 ring-1 ring-morphit-emerald/30'
							: 'border-ink-100 dark:border-ink-800'} {flashCurrent &&
						isCurrentInstance(inst)
							? 'flash-instance'
							: ''}"
					>
						<div class="flex flex-col gap-3">
							<div class="flex items-start justify-between gap-3">
								<div>
									<div class="flex items-center gap-2">
										{#if safeOrigin}
											<a
												href={safeOrigin}
												class="font-display text-xl font-bold text-morphit-emerald hover:underline"
												rel="noopener"
											>
												{effectiveName(inst)}
											</a>
										{:else}
											<!-- Origin failed scheme allowlist (XSS guard).
											     Render the name as plain text rather than a
											     clickable link.  This indicates a malformed
											     federation entry; an operator monitoring will
											     see it and investigate. -->
											<span class="font-display text-xl font-bold text-ink-700 dark:text-ink-200">
												{effectiveName(inst)}
											</span>
										{/if}
										{#if isCurrentInstance(inst)}
											<span
												class="inline-flex items-center rounded-full bg-morphit-emerald/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-morphit-emerald ring-1 ring-morphit-emerald/30"
											>
												{$_('instances.this_instance')}
											</span>
										{/if}
									</div>
									<p class="text-xs text-ink-500">{inst.origin}</p>
								</div>
								<span
									class="inline-flex cursor-help items-center rounded-full px-2.5 py-1 text-xs font-medium {statusClass(
										inst.status
									)}"
									title={statusDescription(inst.status)}
								>
									{statusLabel(inst.status)}
								</span>
							</div>

							{#if inst.tagline}
								<p class="text-sm italic text-ink-600 dark:text-ink-300">{inst.tagline}</p>
							{/if}

							<dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-ink-500">
								<dt>{$_('instances.operator_label')}</dt>
								<dd class="font-mono text-ink-700 dark:text-ink-200">@{inst.operator_account}</dd>
								<dt>{$_('instances.registered_label')}</dt>
								<dd>{formatDayMonth(inst.registered_at)}</dd>
								<dt>{$_('instances.last_probed_label')}</dt>
								<dd>
									{#if inst.last_probed_at}
										<RelativeTime iso={inst.last_probed_at} format="terse" />
									{:else}
										{$_('instances.never_probed')}
									{/if}
								</dd>
								{#if inst.indexed_block !== null}
									<dt>{$_('instances.indexed_block_label')}</dt>
									<dd class="font-mono">{inst.indexed_block}</dd>
								{/if}
							</dl>

							{#if inst.alt_networks}
								<div class="flex flex-wrap gap-2">
									{#if inst.alt_networks.tor}
										<a
											href="http://{inst.alt_networks.tor}"
											class="chip text-xs"
											title={$_('footer.alt_network_address', {
												values: { address: inst.alt_networks.tor }
											})}
											rel="noopener noreferrer"
											target="_blank"
										>
											<AltNetworkIcon network="tor" size={16} class="h-4 w-4" />
											{$_('footer.tor')}
										</a>
									{/if}
									{#if inst.alt_networks.lokinet}
										<a
											href="http://{inst.alt_networks.lokinet}"
											class="chip text-xs"
											title={$_('footer.alt_network_address', {
												values: { address: inst.alt_networks.lokinet }
											})}
											rel="noopener noreferrer"
											target="_blank"
										>
											<AltNetworkIcon network="lokinet" size={16} class="h-4 w-4" />
											{$_('footer.lokinet')}
										</a>
									{/if}
									{#if inst.alt_networks.i2p_b32}
										<a
											href="http://{inst.alt_networks.i2p_b32}"
											class="chip text-xs"
											title={$_('footer.alt_network_address', {
												values: { address: inst.alt_networks.i2p_b32 }
											})}
											rel="noopener noreferrer"
											target="_blank"
										>
											<AltNetworkIcon network="i2p" size={16} class="h-4 w-4" />
											{$_('footer.i2p_b32')}
										</a>
									{/if}
									{#if inst.alt_networks.i2p_name}
										<a
											href="http://{inst.alt_networks.i2p_name}"
											class="chip text-xs"
											title={$_('footer.alt_network_address', {
												values: { address: inst.alt_networks.i2p_name }
											})}
											rel="noopener noreferrer"
											target="_blank"
										>
											<AltNetworkIcon network="i2p" size={16} class="h-4 w-4" />
											{$_('footer.i2p_name')}
										</a>
									{/if}
									{#if inst.alt_networks.ens}
										<a
											href="https://{inst.alt_networks.ens}"
											class="chip text-xs"
											title={$_('footer.alt_network_address', {
												values: { address: inst.alt_networks.ens }
											})}
											rel="noopener noreferrer"
											target="_blank"
										>
											<AltNetworkIcon network="ens" size={16} class="h-4 w-4" />
											{$_('footer.ens')}
										</a>
									{/if}
									{#if inst.alt_networks.nostr}
										<a
											href="nostr:{inst.alt_networks.nostr}"
											class="chip text-xs"
											title={$_('footer.alt_network_address', {
												values: { address: inst.alt_networks.nostr }
											})}
											rel="noopener noreferrer"
											target="_blank"
										>
											<AltNetworkIcon network="nostr" size={16} class="h-4 w-4" />
											{$_('footer.nostr')}
										</a>
									{/if}
								</div>
							{/if}

							{#if safeContact}
								<a
									href={safeContact}
									class="group inline-flex items-center text-sm text-ink-600 transition hover:text-morphit-emerald dark:text-ink-300"
									rel="noopener"
								>
									{$_('instances.contact')}
									<span class="nav-arrow nav-arrow-right" aria-hidden="true">⇨</span>
								</a>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		<aside
			class="mt-12 rounded-lg border border-ink-100 bg-ink-50 p-5 text-sm dark:border-ink-800 dark:bg-ink-950"
		>
			<h2 class="font-display text-base font-bold">{$_('instances.add_yours_title')}</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-300">{$_('instances.add_yours_body')}</p>
		</aside>
	{/if}
</section>

<style>
	/* t.txt (v1.4.9 #1) — flash the current instance's card border a warm
	   amber-yellow five times when the footer "Contact" link lands here with
	   ?highlight=current, so the eye finds the instance you're actually on. The
	   current instance is matched by ORIGIN (see isCurrentInstance) — the old
	   account-field match was always false on multi-account instances, so this
	   flash never actually fired on the canonical instance until cp461. */
	@keyframes flash-instance-border {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgba(245, 158, 11, 0);
		}
		50% {
			box-shadow:
				0 0 0 2px #f59e0b,
				0 0 12px 2px rgba(245, 158, 11, 0.6);
		}
	}
	:global(.flash-instance) {
		animation: flash-instance-border 0.45s ease-in-out 5;
	}
</style>
