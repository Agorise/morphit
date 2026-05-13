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
	import { DEFAULT_RPC_ENDPOINTS } from '$net/config';

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

	// Load current endpoint list + stats.
	$effect(() => {
		if (!browser) return;
		urls = loadEndpoints();
		refreshStats();

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
		refreshStats();
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
		refreshStats();
	}

	function doReset(): void {
		resetEndpoints();
		urls = [...DEFAULT_RPC_ENDPOINTS];
		refreshRotator();
		refreshStats();
		error = '';
		confirmingReset = false;
	}

	function statOf(url: string): EndpointStat | undefined {
		return stats.find((s) => s.url === url);
	}

	function statusLabel(s: EndpointStat | undefined): { text: string; cls: string } {
		if (!s) return { text: '—', cls: 'text-ink-500 dark:text-ink-400' };
		if (s.cooldownUntil > Date.now()) {
			return {
				text: $_('settings.endpoints.cooling_down'),
				cls: 'text-amber-700 dark:text-amber-400'
			};
		}
		if (s.lastLatencyMs != null && s.consecutiveFailures === 0) {
			return {
				text: `${s.lastLatencyMs} ms`,
				cls:
					s.lastLatencyMs < 300
						? 'text-morphit-emerald'
						: s.lastLatencyMs < 1000
							? 'text-ink-600 dark:text-ink-300'
							: 'text-amber-700 dark:text-amber-400'
			};
		}
		if (s.consecutiveFailures > 0) {
			return {
				text: $_('settings.endpoints.failing', { values: { n: s.consecutiveFailures } }),
				cls: 'text-red-600 dark:text-red-400'
			};
		}
		return { text: $_('settings.endpoints.probing'), cls: 'text-ink-500 dark:text-ink-400' };
	}
</script>

<div>
	<ul class="space-y-2">
		{#each urls as url (url)}
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

	<div class="mt-4 flex flex-col gap-2 sm:flex-row">
		<input
			type="url"
			bind:value={newUrl}
			placeholder={$_('settings.endpoints.add_placeholder')}
			autocomplete="url"
			class="min-w-0 flex-1 rounded-xl border-2 border-ink-200 bg-white px-3 py-2 font-mono text-sm focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-950"
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
