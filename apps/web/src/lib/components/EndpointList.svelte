<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import {
		loadEndpoints,
		saveEndpoints,
		resetEndpoints,
		refreshRotator,
		getRotator,
		type EndpointStat
	} from '$net/endpoints';
	import { DEFAULT_RPC_ENDPOINTS, SERVER_ONLY_CANONICAL_RPC_ENDPOINTS } from '$net/config';

	let urls: string[] = $state([]);
	let newUrl = $state('');
	let error = $state('');
	let stats = $state<EndpointStat[]>([]);
	/** Reset button's two-click confirmation gate.  doReset wipes
	 *  the operator's custom endpoint list entirely — minor but
	 *  destructive; without a gate, an accidental click drops
	 *  hours of endpoint curation.  Same standing-rule pattern as
	 *  unblock/discard elsewhere in the app. */
	let confirmingReset = $state(false);
	/** True while a re-probe is in flight (mount warmup or a click on the
	 *  refresh button) — drives the refresh icon's spin + disables it so a
	 *  double-click can't fire overlapping warmups. */
	let probing = $state(false);

	// Load current endpoint list + stats.
	$effect(() => {
		if (!browser) return;
		urls = loadEndpoints();
		refreshStats();
		probeEndpoints();
		// Poll stats so latency updates appear as probes complete.
		const t = setInterval(() => {
			refreshStats();
		}, 1500);
		return () => clearInterval(t);
	});

	function refreshStats(): void {
		if (!browser) return;
		try {
			const r = getRotator();
			stats = [...r.getAll()];
		} catch {
			stats = [];
		}
	}

	/** Probe every endpoint once (to show its latency) then refresh the
	 *  display. cp268: the eager per-page warmup was removed from
	 *  getRotator() because it pinged every Blurt RPC operator from the
	 *  user's browser on every page load (an IP leak + CORS noise on
	 *  misconfigured nodes). The endpoint-settings panel is the deliberate,
	 *  user-initiated place to probe, so warm up here instead. */
	function probeEndpoints(): void {
		if (!browser) return;
		probing = true;
		void getRotator()
			.warmup()
			.then(refreshStats)
			.finally(() => {
				probing = false;
			});
	}

	function addEndpoint(): void {
		error = '';
		const trimmed = newUrl.trim();
		if (!trimmed) return;
		if (!/^https?:\/\/.+/i.test(trimmed)) {
			error = $_('settings.endpoints.invalid_url');
			return;
		}
		if (urls.includes(trimmed)) {
			error = $_('settings.endpoints.duplicate');
			return;
		}
		urls = [...urls, trimmed];
		saveEndpoints(urls);
		refreshRotator();
		probeEndpoints();
		newUrl = '';
	}

	function removeEndpoint(url: string): void {
		if (urls.length <= 1) {
			error = $_('settings.endpoints.at_least_one');
			return;
		}
		urls = urls.filter((u) => u !== url);
		saveEndpoints(urls);
		refreshRotator();
		probeEndpoints();
	}

	function doReset(): void {
		resetEndpoints();
		urls = [...DEFAULT_RPC_ENDPOINTS];
		refreshRotator();
		probeEndpoints();
		error = '';
		confirmingReset = false;
	}

	function statOf(url: string): EndpointStat | undefined {
		return stats.find((s) => s.url === url);
	}

	/** Rank a node for the "best first" display order. Returns a tuple
	 *  [tier, tiebreak] — lower sorts earlier (= better). Tier 0 = healthy
	 *  (ordered by latency, fastest first), 1 = not-yet-probed / probing,
	 *  2 = failing or cooling down (parked at the bottom). */
	function sortKey(url: string): [number, number] {
		const s = statOf(url);
		if (!s) return [1, 0];
		if (s.cooldownUntil > Date.now() || s.consecutiveFailures > 0) {
			return [2, s.consecutiveFailures];
		}
		if (s.lastLatencyMs != null) return [0, s.lastLatencyMs];
		return [1, 0];
	}

	/** The endpoint list ordered best-first. Recomputes whenever the
	 *  health stats change (so a re-probe via the refresh button reorders
	 *  the list); equal-rank ties keep the user's original list order via
	 *  the index tiebreak, so it doesn't churn for no reason. */
	const sortedUrls = $derived(
		urls
			.map((url, i) => ({ url, i }))
			.sort((a, b) => {
				const ka = sortKey(a.url);
				const kb = sortKey(b.url);
				return ka[0] - kb[0] || ka[1] - kb[1] || a.i - b.i;
			})
			.map((x) => x.url)
	);

	/** Render a round-trip in seconds (or minutes when it's pathologically
	 *  slow) rather than raw milliseconds — a human reads "0.34 s" faster
	 *  than "340 ms", and a node taking whole seconds is the signal that
	 *  matters. SI symbols (s / min) are locale-independent. */
	function formatLatency(ms: number): string {
		if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
		return `${(ms / 1000).toFixed(2)} s`;
	}

	function statusLabel(s: EndpointStat | undefined): { text: string; cls: string } {
		if (!s) return { text: '—', cls: 'text-ink-500 dark:text-ink-400' };
		if (s.cooldownUntil > Date.now()) {
			return {
				text: $_('settings.endpoints.cooling_down'),
				cls: 'text-amber-700 dark:text-amber-400'
			};
		}
		// Failing → RED, with the REASON so the user can see why a node is
		// failing: an HTTP status ("Error: 429"), a timeout ("Timed out"), or a
		// network/DNS/TLS/CORS failure the browser won't let us disambiguate
		// ("Unreachable"). The bare count is only a fallback if no kind was
		// captured.
		if (s.consecutiveFailures > 0) {
			let text: string;
			if (s.lastErrorKind === 'http' && s.lastErrorCode != null) {
				text = $_('settings.endpoints.http_error', { values: { code: s.lastErrorCode } });
			} else if (s.lastErrorKind === 'timeout') {
				text = $_('settings.endpoints.timed_out');
			} else if (s.lastErrorKind === 'network') {
				text = $_('settings.endpoints.unreachable');
			} else {
				text = $_('settings.endpoints.failing', { values: { n: s.consecutiveFailures } });
			}
			return { text, cls: 'text-red-600 dark:text-red-400' };
		}
		// Healthy → latency in seconds. Yellow once it crosses 1 s.
		if (s.lastLatencyMs != null) {
			return {
				text: formatLatency(s.lastLatencyMs),
				cls:
					s.lastLatencyMs > 1000
						? 'text-amber-700 dark:text-amber-400'
						: 'text-morphit-emerald'
			};
		}
		return { text: $_('settings.endpoints.probing'), cls: 'text-ink-500 dark:text-ink-400' };
	}
</script>

<div>
	<div class="mb-2 flex items-center justify-end">
		<button
			type="button"
			onclick={probeEndpoints}
			disabled={probing}
			aria-label={$_('settings.endpoints.recheck')}
			title={$_('settings.endpoints.recheck')}
			class="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-ink-300 text-ink-600 transition hover:border-morphit-emerald hover:bg-ink-50 hover:text-morphit-emerald disabled:cursor-wait disabled:opacity-100 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-900"
		>
			<svg
				class="h-4 w-4 {probing ? 'animate-spin' : ''}"
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
		{#each sortedUrls as url (url)}
			{@const s = statOf(url)}
			{@const status = statusLabel(s)}
			<li
				class="flex items-center gap-3 rounded-xl border border-ink-200 bg-white p-3 dark:border-ink-700 dark:bg-ink-900"
			>
				<div class="min-w-0 flex-1">
					<p class="break-all font-mono text-sm">{url}</p>
					<p class="mt-0.5 text-xs {status.cls}">{status.text}</p>
				</div>
				<button
					type="button"
					class="flex-none rounded-lg p-2 text-ink-500 hover:bg-ink-100 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:text-ink-400 dark:hover:bg-ink-800"
					aria-label={$_('settings.endpoints.remove_aria', { values: { url } })}
					onclick={() => removeEndpoint(url)}
				>
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
					>
						<path d="M3 6h18" />
						<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
						<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
					</svg>
				</button>
			</li>
		{/each}
	</ul>

	{#if SERVER_ONLY_CANONICAL_RPC_ENDPOINTS.length > 0}
		<!-- The CORS-omitted canonical nodes, shown read-only so the
		     operator sees the COMPLETE pool (these three + the browser
		     ones above). Never probed from the browser — the note
		     explains why — so no status/latency is shown. -->
		<div
			class="mt-3 rounded-xl border border-dashed border-ink-200 bg-ink-50/60 p-3 dark:border-ink-700 dark:bg-ink-900/40"
		>
			<p class="text-xs font-semibold text-ink-600 dark:text-ink-300">
				{$_('settings.endpoints.server_only_heading')}
			</p>
			<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
				{$_('settings.endpoints.server_only_note')}
			</p>
			<ul class="mt-2 space-y-1">
				{#each SERVER_ONLY_CANONICAL_RPC_ENDPOINTS as url (url)}
					<li class="break-all font-mono text-xs text-ink-500 dark:text-ink-400">{url}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<div class="mt-4 flex flex-col gap-2 sm:flex-row">
		<input
			type="url"
			bind:value={newUrl}
			maxlength="512"
			placeholder={$_('settings.endpoints.add_placeholder')}
			autocomplete="url"
			class="min-w-0 flex-1 rounded-xl border-2 border-ink-200 bg-white px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-950"
		/>
		<button type="button" class="btn-secondary" disabled={!newUrl.trim()} onclick={addEndpoint}>
			{$_('settings.endpoints.add')}
		</button>
	</div>

	{#if error}
		<p class="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
	{/if}

	<div class="mt-4 flex justify-end">
		{#if !confirmingReset}
			<button type="button" class="btn-ghost text-sm" onclick={() => (confirmingReset = true)}>
				{$_('settings.endpoints.reset')}
			</button>
		{:else}
			<div
				class="flex flex-wrap items-center gap-2 rounded-xl border-2 border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950"
				role="alertdialog"
				aria-live="polite"
			>
				<p class="text-sm text-amber-900 dark:text-amber-100">
					{$_('settings.endpoints.reset_confirm_prompt')}
				</p>
				<button
					type="button"
					class="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-700"
					onclick={doReset}
				>
					{$_('settings.endpoints.reset_confirm_yes')}
				</button>
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-semibold dark:border-ink-700"
					onclick={() => (confirmingReset = false)}
				>
					{$_('settings.endpoints.reset_confirm_cancel')}
				</button>
			</div>
		{/if}
	</div>
</div>
