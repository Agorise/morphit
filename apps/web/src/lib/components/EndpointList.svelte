<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import { getRpcEndpoints } from '$lib/indexer/client';
	import type { RpcEndpointHealth } from '@morphit/indexer-client';

	/** The canonical Blurt RPC pool + per-node health, fetched from the operator's
	 *  indexer. cp410: this card is purely INFORMATIONAL — there is nothing for
	 *  the user to configure. The browser talks ONLY to the operator's indexer,
	 *  which relays every chain read/write and measures these nodes server-side,
	 *  so the browser NEVER contacts a Blurt node directly (the sole exception is
	 *  a boot-time release-integrity check, which uses this same canonical pool).
	 *  Opening settings therefore never exposes the user's IP to a node operator.
	 *  PRIVACY (#1): the indexer is the ONLY source of the health shown here. */
	let endpoints = $state<RpcEndpointHealth[]>([]);
	/** True while the indexer health fetch is in flight (initial load or a click
	 *  on refresh) — drives the refresh icon's spin. */
	let loading = $state(false);
	/** Unix-ms of the last fetch START. t.txt #1 — the button stays clickable
	 *  as fast as the user likes, but we never re-ping the indexer more than once
	 *  per THROTTLE_MS so nobody can pound the pool. */
	let lastFetchAt = $state(0);
	/** Briefly true after a completed refresh — shows a ✓ so a click always reads as
	 *  "did something", even when the stable health snapshot is unchanged). */
	let justRefreshed = $state(false);
	/** Briefly true when a click is rate-limited (a quick pulse ack instead of
	 *  silently doing nothing). */
	let justThrottled = $state(false);
	let refreshedTimer: ReturnType<typeof setTimeout> | null = null;

	/** Never re-ping the indexer faster than this (t.txt #1). */
	const THROTTLE_MS = 5000;
	/** Keep the spinner up at least this long so a fast fetch is still visible. */
	const MIN_SPIN_MS = 550;

	$effect(() => {
		if (!browser) return;
		void loadHealth(false);
	});

	/** Fetch per-node health. `probe=false` → the indexer's cheap passive pool
	 *  snapshot (used on mount). `probe=true` → ask the indexer to actively ping
	 *  every node NOW for fresh latency (the refresh button; server-side that's
	 *  rate-limited to once per 5s). Best-effort: on failure the list stays. */
	async function loadHealth(probe: boolean): Promise<void> {
		if (!browser) return;
		loading = true;
		lastFetchAt = Date.now();
		const started = Date.now();
		try {
			const res = await getRpcEndpoints({ probe });
			if (res.ok) endpoints = [...res.data.endpoints];
		} finally {
			const wait = MIN_SPIN_MS - (Date.now() - started);
			if (wait > 0) await new Promise((r) => setTimeout(r, wait));
			loading = false;
			justRefreshed = true;
			if (refreshedTimer) clearTimeout(refreshedTimer);
			refreshedTimer = setTimeout(() => (justRefreshed = false), 1200);
		}
	}

	/** The refresh button handler. Always clickable; a click re-pings the indexer
	 *  at most once per THROTTLE_MS. A rate-limited click gives a quick visual ack
	 *  rather than silently doing nothing (t.txt #1). */
	function onRefreshClick(): void {
		if (loading) return;
		if (Date.now() - lastFetchAt < THROTTLE_MS) {
			justThrottled = true;
			setTimeout(() => (justThrottled = false), 320);
			return;
		}
		void loadHealth(true);
	}

	/** Status line for a node, derived ENTIRELY from the indexer's health
	 *  snapshot: latency when healthy, a cooling-down / unreachable reason
	 *  otherwise, or "probing" before the first measurement lands. */
	function healthStatus(h: RpcEndpointHealth): { text: string; cls: string } {
		if (h.cooldown_ms > 0) {
			return { text: $_('settings.endpoints.cooling_down'), cls: 'text-ink-700 dark:text-ink-400' };
		}
		if (h.consecutive_failures > 0) {
			return { text: $_('settings.endpoints.unreachable'), cls: 'text-red-600 dark:text-red-400' };
		}
		if (h.latency_ms != null) {
			return {
				text: formatLatency(h.latency_ms),
				cls: h.latency_ms > 1000 ? 'text-ink-700 dark:text-ink-400' : 'text-morphit-emerald'
			};
		}
		return { text: $_('settings.endpoints.probing'), cls: 'text-ink-500 dark:text-ink-400' };
	}

	/** Rank a node "best first": 0 = healthy (by latency, fastest first), 1 = not
	 *  yet measured, 2 = failing / cooling down (bottom). */
	function sortKey(h: RpcEndpointHealth): [number, number] {
		if (h.cooldown_ms > 0 || h.consecutive_failures > 0) return [2, h.consecutive_failures];
		if (h.latency_ms != null) return [0, h.latency_ms];
		return [1, 0];
	}

	const sortedEndpoints = $derived(
		[...endpoints]
			.map((h, i) => ({ h, i }))
			.sort((a, b) => {
				const ka = sortKey(a.h);
				const kb = sortKey(b.h);
				return ka[0] - kb[0] || ka[1] - kb[1] || a.i - b.i;
			})
			.map((x) => x.h)
	);

	/** Render a round-trip in seconds (or minutes when pathologically slow)
	 *  rather than raw ms — a human reads "0.34 s" faster than "340 ms". SI
	 *  symbols (s / min) are locale-independent. */
	function formatLatency(ms: number): string {
		if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
		return `${(ms / 1000).toFixed(2)} s`;
	}
</script>

<div>
	<div class="mb-3 flex items-start justify-between gap-3">
		<p class="text-xs text-ink-500 dark:text-ink-400">
			{$_('settings.endpoints.pool_note')}
		</p>
		<button
			type="button"
			onclick={onRefreshClick}
			aria-label={$_('settings.endpoints.recheck')}
			title={$_('settings.endpoints.recheck')}
			class="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border text-ink-600 transition hover:border-morphit-emerald hover:bg-ink-50 hover:text-morphit-emerald dark:text-ink-300 dark:hover:bg-ink-900 {justRefreshed &&
			!loading
				? 'border-morphit-emerald text-morphit-emerald dark:text-morphit-emerald'
				: 'border-ink-300 dark:border-ink-700'} {justThrottled ? 'scale-90' : ''}"
		>
			{#if justRefreshed && !loading}
				<svg
					class="h-4 w-4"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M20 6 9 17l-5-5" />
				</svg>
			{:else}
				<svg
					class="h-4 w-4 {loading ? 'animate-spin' : ''}"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M21 12a9 9 0 1 1-2.64-6.36" />
					<path d="M21 3v6h-6" />
				</svg>
			{/if}
		</button>
	</div>
	<ul class="space-y-2">
		{#each sortedEndpoints as h (h.url)}
			{@const status = healthStatus(h)}
			<li
				class="flex items-center gap-3 rounded-xl border border-ink-200 bg-white p-3 dark:border-ink-700 dark:bg-ink-900"
			>
				<div class="min-w-0 flex-1">
					<p class="break-all font-mono text-sm">{h.url}</p>
					<p class="mt-0.5 text-xs {status.cls}">{status.text}</p>
				</div>
			</li>
		{/each}
		{#if sortedEndpoints.length === 0}
			<li
				class="rounded-xl border border-dashed border-ink-200 p-3 text-xs text-ink-500 dark:border-ink-700 dark:text-ink-400"
			>
				{$_('settings.endpoints.probing')}
			</li>
		{/if}
	</ul>
</div>
