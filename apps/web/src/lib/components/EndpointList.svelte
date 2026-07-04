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
	 *  on refresh) — drives the refresh icon's spin + disables it so a
	 *  double-click can't fire overlapping fetches. */
	let loading = $state(false);

	$effect(() => {
		if (!browser) return;
		void loadHealth();
	});

	/** Fetch the indexer's per-node health for the canonical Blurt RPC pool (the
	 *  indexer probes them server-side; the browser never does). Best-effort: on
	 *  any failure the list just stays as-is. */
	async function loadHealth(): Promise<void> {
		if (!browser) return;
		loading = true;
		try {
			const res = await getRpcEndpoints();
			if (res.ok) endpoints = [...res.data.endpoints];
		} finally {
			loading = false;
		}
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
			onclick={() => void loadHealth()}
			disabled={loading}
			aria-label={$_('settings.endpoints.recheck')}
			title={$_('settings.endpoints.recheck')}
			class="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-ink-300 text-ink-600 transition hover:border-morphit-emerald hover:bg-ink-50 hover:text-morphit-emerald disabled:cursor-wait disabled:opacity-100 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-900"
		>
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
