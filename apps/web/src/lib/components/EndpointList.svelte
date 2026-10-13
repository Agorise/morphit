<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import { getRpcEndpoints } from '$lib/indexer/client';
	import type { RpcEndpointHealth } from '@morphit/indexer-client';

	/** The public Blurt RPC nodes and how each one is doing, as this site's
	 *  indexer measures them. Purely INFORMATIONAL — nothing to configure. The
	 *  browser talks ONLY to the operator's indexer, which measures these nodes
	 *  server-side, so the browser NEVER contacts a Blurt node here and opening
	 *  the page never exposes the visitor's IP to a node operator.
	 *
	 *  v1.21.6 — ACCURATE FROM THE FIRST PAINT. The indexer measures every node
	 *  continuously in the background (each one every ~20 s, independently), so
	 *  the first answer already carries real latencies and real failures. The
	 *  card then re-reads those figures every POLL_MS while the page is visible,
	 *  so nothing goes stale. The refresh button asks the indexer to re-measure
	 *  every node now; the rows on screen stay as they are until the new figures
	 *  arrive (they are never swapped for older or guessed ones). A node the
	 *  indexer has not measured yet (it just started) says "probing…", never
	 *  "offline". Each row shows how long ago it was measured.
	 *
	 *  v1.21.7 — ONLY WHILE SOMEONE IS THERE. Re-reading stops when the tab is
	 *  hidden and after IDLE_MS without input, and the card says it paused; any
	 *  input reads again at once. The indexer measures the nodes only while the
	 *  card is read and caps refreshes per node, so no number of open pages or
	 *  scripted requests makes it contact the nodes more often. */
	let endpoints = $state<RpcEndpointHealth[]>([]);
	/** True while a refresh (or the first load) is in flight — spins the icon. */
	let loading = $state(false);
	/** Unix-ms of the last refresh START. The button stays clickable as fast as
	 *  the user likes, but we never ask for a re-measure more than once per
	 *  THROTTLE_MS so nobody can pound the nodes. */
	let lastFetchAt = $state(0);
	/** Briefly true after a completed refresh — shows a ✓ so a click always reads
	 *  as "did something". */
	let justRefreshed = $state(false);
	/** Briefly true when a click is rate-limited (a quick pulse ack instead of
	 *  silently doing nothing). */
	let justThrottled = $state(false);
	let refreshedTimer: ReturnType<typeof setTimeout> | null = null;
	/** The clock the "measured N s ago" labels count from (ticks every second). */
	let nowMs = $state(Date.now());
	/** `generated_at` of the answer on screen: an answer generated earlier (a
	 *  poll that was slow to arrive) is dropped, so the rows never go back in
	 *  time. */
	let shownGeneratedAt = 0;
	/** Request order, on a counter (no clock): when each request was sent and
	 *  when the answer on screen arrived. An answer to a request sent AFTER the
	 *  one on screen arrived is newer whatever its `generated_at` says — so a
	 *  step back of the indexer's clock (an NTP correction) cannot freeze the
	 *  card. */
	let tick = 0;
	let shownArrivedTick = 0;
	/** The indexer's clock minus the browser's, from the answer on screen:
	 *  "measured N s ago" counts on the indexer's clock, which also stamped
	 *  `checked_at` (the visitor's clock may be off by any amount). */
	let clockOffsetMs = $state(0);

	/** Never ask for a re-measure faster than this. */
	const THROTTLE_MS = 5000;
	/** Keep the spinner up at least this long so a fast fetch is still visible. */
	const MIN_SPIN_MS = 550;
	/** Re-read the indexer's latest figures this often while the page is visible. */
	const POLL_MS = 10_000;
	/** v1.21.7 — stop re-reading after this long without mouse, touch, keyboard
	 *  or scroll input (a tab left open on a second screen, a phone on a desk).
	 *  The indexer measures the nodes only while the card is read, so an idle
	 *  page frees that bandwidth on this site and on the nodes. Any input reads
	 *  again at once. */
	const IDLE_MS = 3 * 60_000;
	/** Figures older than this on the first answer were measured before a
	 *  quiet spell (the indexer had stopped): read again after FOLLOW_UP_MS,
	 *  once, instead of leaving them until the next POLL_MS read. */
	const OLD_FIGURE_MS = 60_000;
	const FOLLOW_UP_MS = 3_000;
	/** True while re-reading is paused for lack of input. */
	let paused = $state(false);
	let lastInputAt = Date.now();

	/** Read the indexer's figures. `probe` asks it to re-measure every node now
	 *  (the refresh button). On failure, or on an answer that is not the
	 *  expected shape, the rows on screen stay as they are. */
	async function fetchHealth(probe: boolean): Promise<void> {
		const sentTick = ++tick;
		const res = await getRpcEndpoints({ probe });
		if (!res.ok) return;
		const data: unknown = res.data;
		if (typeof data !== 'object' || data === null) return;
		const { endpoints: list, generated_at: g } = data as Record<string, unknown>;
		if (!Array.isArray(list)) return;
		const generated = typeof g === 'string' ? Date.parse(g) : NaN;
		if (sentTick < shownArrivedTick && Number.isFinite(generated) && generated < shownGeneratedAt)
			return;
		// One row per URL (the list is keyed by it); a row without one is dropped.
		const seen = new Set<string>();
		const rows = list.filter((e: unknown): e is RpcEndpointHealth => {
			const url = typeof e === 'object' && e !== null ? (e as { url?: unknown }).url : undefined;
			if (typeof url !== 'string' || seen.has(url)) return false;
			seen.add(url);
			return true;
		});
		if (rows.length === 0 && list.length > 0) return; // rows, but none usable
		shownArrivedTick = ++tick;
		nowMs = Date.now();
		shownGeneratedAt = Number.isFinite(generated) ? generated : 0;
		clockOffsetMs = Number.isFinite(generated) ? generated - nowMs : 0;
		endpoints = rows;
	}

	/** True when any row was measured before a quiet spell (or not yet). */
	function hasOldFigures(): boolean {
		const at = nowMs + clockOffsetMs;
		return endpoints.some((h) => {
			const t = h.checked_at == null ? NaN : Date.parse(h.checked_at);
			return !Number.isFinite(t) || at - t > OLD_FIGURE_MS;
		});
	}

	$effect(() => {
		if (!browser) return;
		lastInputAt = Date.now();
		paused = false;
		let followUp: ReturnType<typeof setTimeout> | null = null;
		let stopped = false;
		/** Read now; when what comes back predates a quiet spell (the indexer
		 *  has only just started measuring again), read once more FOLLOW_UP_MS
		 *  later — on the first read, and on every return from a pause or a
		 *  hidden tab. */
		const readNow = async (): Promise<void> => {
			await fetchHealth(false);
			if (stopped || !hasOldFigures()) return;
			if (followUp) clearTimeout(followUp);
			followUp = setTimeout(() => {
				followUp = null;
				if (!stopped && document.visibilityState === 'visible') void fetchHealth(false);
			}, FOLLOW_UP_MS);
		};
		loading = true;
		void readNow().finally(() => (loading = false));
		const poll = setInterval(() => {
			if (document.visibilityState !== 'visible') return;
			if (Date.now() - lastInputAt >= IDLE_MS) {
				paused = true;
				return;
			}
			void fetchHealth(false);
		}, POLL_MS);
		const clock = setInterval(() => (nowMs = Date.now()), 1000);
		/** Input (or a return to the tab): count as active; read at once if paused. */
		const onInput = (): void => {
			lastInputAt = Date.now();
			if (paused && document.visibilityState === 'visible') {
				paused = false;
				void readNow();
			}
		};
		const onVisible = (): void => {
			if (document.visibilityState !== 'visible') return;
			lastInputAt = Date.now();
			paused = false;
			void readNow();
		};
		const INPUT = [
			'pointermove',
			'pointerdown',
			'keydown',
			'wheel',
			'touchstart',
			'scroll',
			'focus'
		];
		for (const e of INPUT) window.addEventListener(e, onInput, { passive: true });
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			stopped = true;
			clearInterval(poll);
			clearInterval(clock);
			if (followUp) clearTimeout(followUp);
			for (const e of INPUT) window.removeEventListener(e, onInput);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	/** The refresh button handler. Always clickable; a click asks for a
	 *  re-measure at most once per THROTTLE_MS. A rate-limited click gives a
	 *  quick visual ack rather than silently doing nothing. */
	function onRefreshClick(): void {
		if (loading) return;
		if (Date.now() - lastFetchAt < THROTTLE_MS) {
			justThrottled = true;
			setTimeout(() => (justThrottled = false), 320);
			return;
		}
		lastFetchAt = Date.now();
		loading = true;
		const started = Date.now();
		void (async () => {
			try {
				await fetchHealth(true);
			} finally {
				const wait = MIN_SPIN_MS - (Date.now() - started);
				if (wait > 0) await new Promise((r) => setTimeout(r, wait));
				loading = false;
				justRefreshed = true;
				if (refreshedTimer) clearTimeout(refreshedTimer);
				refreshedTimer = setTimeout(() => (justRefreshed = false), 1200);
			}
		})();
	}

	/** "8 s" / "2 min" since a row was measured, or null when it never was. */
	function age(h: RpcEndpointHealth): string | null {
		if (h.checked_at == null) return null;
		const t = Date.parse(h.checked_at);
		if (!Number.isFinite(t)) return null;
		const s = Math.max(0, Math.round((nowMs + clockOffsetMs - t) / 1000));
		return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
	}

	/** a ONE-LINE reason a node is red, instead of a flat
	 *  "unreachable" that sends the reader chasing the wrong problem (the maintainer's
	 *  case: the node's operator had renovated the balancer certificate, so the
	 *  node answered 200 to him while our TLS handshake failed).
	 *
	 *  The reason comes from the INDEXER's server-side probe — the browser never
	 *  pings a node (privacy #1). That's also why no branch here says "CORS":
	 *  a server-side probe cannot hit CORS, so naming it would be a lie.
	 *
	 *  Falls back to the plain "Unreachable" label when the indexer sent no
	 *  reason (an older indexer) or when the node is
	 *  genuinely not pingable — as requested, "Unreachable" suffices for that. */
	function failureText(h: RpcEndpointHealth): string {
		switch (h.failure_reason) {
			case 'timeout':
				return $_('settings.endpoints.err_timeout');
			case 'tls':
				return $_('settings.endpoints.err_tls');
			case 'dns':
				return $_('settings.endpoints.err_dns');
			case 'refused':
				return $_('settings.endpoints.err_refused');
			case 'rpc_error':
				return $_('settings.endpoints.err_rpc');
			case 'bad_body':
				return $_('settings.endpoints.err_body');
			case 'transport_off':
				return $_('settings.endpoints.err_transport_off');
			case 'http': {
				const status = h.http_status ?? 0;
				// 401/403/451 = something in FRONT of the node refused us (WAF,
				// security policy, geo-block) — the node itself may be perfectly
				// healthy, which is exactly the distinction the maintainer asked for.
				if (status === 401 || status === 403 || status === 451) {
					return $_('settings.endpoints.err_http_blocked', { values: { status } });
				}
				if (status === 429) return $_('settings.endpoints.err_http_rate');
				return $_('settings.endpoints.err_http', { values: { status } });
			}
			default:
				return $_('settings.endpoints.unreachable');
		}
	}

	/** Names of nodes that are healthy on AT LEAST ONE transport. A named node
	 *  (an operator's "oldpc" published on both Tor and I2P) that answers on one
	 *  transport proves the box is UP, so a sibling transport that fails is shown
	 *  in amber rather than red — with its real reason, not a guess. */
	const healthyNames = $derived(
		new Set(endpoints.filter((e) => e.healthy && e.name != null).map((e) => e.name))
	);

	/** Status line for a node, derived ENTIRELY from the indexer's latest
	 *  measurement: its latency when it answered, the reason when it did not, or
	 *  "probing" before the first measurement lands. */
	function healthStatus(h: RpcEndpointHealth): { text: string; cls: string } {
		// A hidden node this instance can't reach because it has no Tor/I2P
		// running is NOT a failure — show a calm, muted "requires Tor/I2P" note
		// (takes precedence over the cooldown / red-failure rendering below).
		if (h.failure_reason === 'transport_off') {
			return {
				text: $_('settings.endpoints.err_transport_off'),
				cls: 'text-ink-500 dark:text-ink-400'
			};
		}
		// A failing node shows WHY it's failing (timed out / TLS / refused …) —
		// the reason is the actionable signal.
		if (h.consecutive_failures > 0) {
			// If this node answers on ANOTHER transport (same name), the box is UP
			// and only this transport failed: amber, with the real reason.
			if (h.name != null && healthyNames.has(h.name)) {
				return { text: failureText(h), cls: 'text-amber-600 dark:text-amber-400' };
			}
			return { text: failureText(h), cls: 'text-red-600 dark:text-red-400' };
		}
		if (h.cooldown_ms > 0) {
			return { text: $_('settings.endpoints.cooling_down'), cls: 'text-ink-700 dark:text-ink-400' };
		}
		if (h.latency_ms != null) {
			// Latency colour thresholds: under 5 s is healthy (emerald); 5–10 s is
			// slow (amber); 10 s+ is painfully slow (red). Tor/I2P legitimately run
			// a few seconds, so onion-routed nodes aren't red-flagged for latency
			// they can't avoid.
			const ms = h.latency_ms;
			const cls =
				ms >= 10_000
					? 'text-red-600 dark:text-red-400'
					: ms >= 5_000
						? 'text-amber-600 dark:text-amber-400'
						: 'text-morphit-emerald';
			return { text: formatLatency(ms), cls };
		}
		return { text: $_('settings.endpoints.probing'), cls: 'text-ink-500 dark:text-ink-400' };
	}

	/** Rank a node "best first": 0 = healthy (by latency, fastest first), 1 = not
	 *  yet measured, 2 = failing (bottom). */
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
	<!-- v1.7.7 — the pool note is gone; `settings.endpoints.explain`
	     above already says what these nodes are and how they're picked, and the
	     second paragraph only restated it. `justify-end` (not `justify-between`)
	     because the refresh button is now the only child, and justify-between
	     with one child silently left-aligns it. -->
	<div class="mb-3 flex items-start justify-end gap-3">
		{#if paused}
			<p class="mr-auto text-xs text-ink-500 dark:text-ink-400" role="status">
				{$_('settings.endpoints.paused')}
			</p>
		{/if}
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
					<p class="break-all font-mono text-sm">
						{#if h.transport === 'tor' || h.transport === 'i2p' || h.transport === 'local'}
							<span
								class="mr-1.5 inline-block rounded bg-morphit-emerald/10 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-morphit-emerald"
							>
								{h.transport === 'tor'
									? $_('settings.endpoints.transport_tor')
									: h.transport === 'i2p'
										? $_('settings.endpoints.transport_i2p')
										: $_('settings.endpoints.transport_local')}
							</span>
						{/if}{h.url}
					</p>
					<p class="mt-0.5 text-xs">
						<span class={status.cls}>{status.text}</span>{#if age(h) !== null}<span
								class="text-ink-500 dark:text-ink-400"
							>
								{' · '}{$_('settings.endpoints.checked_ago', { values: { age: age(h) } })}</span
							>{/if}
					</p>
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
