<script lang="ts">
	/**
	 * OrderExpiryChip — relative countdown for an order's expiry.
	 *
	 * One flat emerald countdown style for every LIVE tier, matching
	 * the profile + order-view "expires in X" pills (de-brown D2 — a
	 * single visual language for "time left"; red is reserved for
	 * genuine errors/destructive actions, not a normal expiry). The
	 * tiers below now differ ONLY in tick cadence, not colour:
	 *
	 *   far    (> 1 hour):  emerald, ticks every 60s.  Format:
	 *                       "Expires in 5d 3h" or "Expires in 4h 12m".
	 *   near   (1 min..1 hour): emerald, ticks every 60s.  Format:
	 *                       "Expires in 42m".
	 *   urgent (< 15 min):  emerald, ticks every SECOND so the
	 *                       countdown feels alive.  Format:
	 *                       "Expires in 8m 14s".
	 *   expired (≤ 0):      muted gray, "Expired", strikethrough.
	 *                       No ticking — frozen. (In practice the
	 *                       callers only render this chip for LIVE
	 *                       orders, so the expired tier is rarely hit.)
	 *
	 * Why a per-instance timer rather than a global tick channel:
	 * the orderbook's typical row count is ~50 visible at once,
	 * and at most a handful are in the "urgent" tier (most orders
	 * expire days from now).  Per-instance timers cost ~4 bytes
	 * each in V8; the cleanup-on-destroy pattern is well-paved by
	 * Svelte's $effect + return-cleanup idiom.  A global tick
	 * channel would save trivial CPU and trade it for more code
	 * to debug.
	 *
	 * Why one-second ticks ONLY in urgent tier: a 60-second tick
	 * in the urgent tier would mean the displayed "8m 14s" stays
	 * visible for up to 60 seconds before updating to "7m 14s",
	 * which feels broken when the user is watching a deadline.
	 * In the far/near tiers, "5d 3h" doesn't change second-by-
	 * second, so a 60s tick is plenty.
	 *
	 * a11y:
	 *   - aria-label includes the full deadline + time remaining
	 *     so screen readers don't need the user to translate emoji
	 *     or the countdown format.
	 *   - prefers-reduced-motion: n/a — the chip no longer animates
	 *     (the urgent-tier pulse was retired in the D2 flat-emerald
	 *     unification); the live per-second countdown text conveys
	 *     urgency without movement.
	 *   - aria-live="polite" on the wrapper so screen readers
	 *     announce the countdown only when it changes meaningfully
	 *     (we throttle the tick to once-per-minute except in
	 *     urgent tier).
	 *
	 * Usage:
	 *   {#if o.expires_at}
	 *     <OrderExpiryChip expiresAt={o.expires_at} />
	 *   {/if}
	 */

	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';

	interface Props {
		/** ISO-8601 timestamp string from the indexer.  Caller is
		 *  responsible for filtering null and skipping the chip. */
		expiresAt: string;
		/** Optional ISO-8601 last-updated timestamp. When provided, a
		 *  terse "Updated 5m/2h/3d" is folded into the chip's hover
		 *  tooltip (the orderbook card no longer shows a separate
		 *  "Updated 1d" line — it lives here on the expires pill). */
		updatedAtIso?: string;
	}
	let { expiresAt, updatedAtIso }: Props = $props();

	/** Cached parsed value — re-derived if the prop changes. */
	const expiresAtMs = $derived.by(() => {
		const ms = Date.parse(expiresAt);
		return Number.isFinite(ms) ? ms : null;
	});

	/** Re-rendered every tick.  Drives the countdown and the
	 *  tier classification.  Initialized to current time so the
	 *  first frame renders correctly. */
	let now = $state(Date.now());

	/** Tier derivation.  Pure function of (now, expiresAtMs). */
	const remainingMs = $derived(expiresAtMs === null ? 0 : Math.max(0, expiresAtMs - now));
	const tier = $derived.by((): 'expired' | 'urgent' | 'near' | 'far' => {
		if (remainingMs <= 0) return 'expired';
		if (remainingMs < 15 * 60_000) return 'urgent';
		if (remainingMs < 60 * 60_000) return 'near';
		return 'far';
	});

	/** Single timer handle.  We re-key it whenever the tier
	 *  flips so the tick interval matches the tier's needs.
	 *  Cleared on unmount. */
	let timer: ReturnType<typeof setInterval> | null = null;
	let activeTickInterval: 1000 | 60_000 | null = null;

	function ensureTimer(): void {
		if (typeof window === 'undefined') return;
		const need: 1000 | 60_000 | null =
			tier === 'urgent' ? 1000 : tier === 'expired' ? null : 60_000;
		if (need === activeTickInterval) return;
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		activeTickInterval = need;
		if (need !== null) {
			timer = setInterval(() => {
				now = Date.now();
			}, need);
		}
	}

	onMount(() => {
		now = Date.now();
		ensureTimer();
	});

	onDestroy(() => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	});

	// React to tier changes by adjusting the tick interval.
	$effect(() => {
		// Read tier so the effect tracks it.
		void tier;
		ensureTimer();
	});

	/** Format remaining time.  Granularity scales with magnitude:
	 *  - days+hours when ≥ 1 day
	 *  - hours+minutes when ≥ 1 hour
	 *  - minutes only when ≥ 1 minute
	 *  - minutes+seconds when < 1 minute (urgent tier especially)
	 *
	 *  Returns the i18n-keyed format suitable for the active
	 *  locale; we don't try to do locale-specific units past
	 *  what svelte-i18n covers (no Catalan-dual-form pluralization
	 *  for "1 hours" — i18n keys handle plural via ICU below). */
	const formatted = $derived.by(() => {
		if (remainingMs <= 0) return $_('orderbook.order.expired');
		const totalSec = Math.floor(remainingMs / 1000);
		const days = Math.floor(totalSec / 86_400);
		const hours = Math.floor((totalSec % 86_400) / 3_600);
		const minutes = Math.floor((totalSec % 3_600) / 60);
		const seconds = totalSec % 60;
		if (days >= 1) {
			return $_('orderbook.order.expires_in_days_hours', {
				values: { days, hours }
			});
		}
		if (hours >= 1) {
			return $_('orderbook.order.expires_in_hours_minutes', {
				values: { hours, minutes }
			});
		}
		if (minutes >= 1) {
			// In the urgent tier (< 15m) we surface seconds too so
			// the countdown is readably alive.  In the near tier
			// (15..59m) seconds would be jittery noise; show
			// minutes only.
			if (tier === 'urgent') {
				return $_('orderbook.order.expires_in_minutes_seconds', {
					values: { minutes, seconds }
				});
			}
			return $_('orderbook.order.expires_in_minutes', {
				values: { minutes }
			});
		}
		return $_('orderbook.order.expires_in_seconds', {
			values: { seconds }
		});
	});

	/** Full ISO-style aria label for screen readers. */
	const ariaLabel = $derived.by(() => {
		if (expiresAtMs === null) return '';
		const expiresDate = new Date(expiresAtMs).toISOString();
		return $_('orderbook.order.expires_aria', {
			values: { iso: expiresDate, formatted }
		}) as string;
	});

	/** Terse "Updated {ago}" for the tooltip. Mirrors RelativeTime's
	 *  terse ladder (same relative_time.terse.* keys) — kept inline so
	 *  the chip's native title can carry it without a wrapper element
	 *  stealing the hover. null when no updatedAtIso is supplied. */
	const updatedTooltip = $derived.by(() => {
		if (!updatedAtIso) return null;
		const ms = Date.parse(updatedAtIso);
		if (!Number.isFinite(ms)) return null;
		const seconds = Math.max(0, Math.floor((now - ms) / 1000));
		let rel: string;
		if (seconds < 60) {
			rel = $_('relative_time.terse.lt1m') as string;
		} else {
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) {
				rel = $_('relative_time.terse.minutes', { values: { n: minutes } }) as string;
			} else {
				const hours = Math.floor(minutes / 60);
				if (hours < 24) {
					rel = $_('relative_time.terse.hours', { values: { n: hours } }) as string;
				} else {
					const days = Math.floor(hours / 24);
					if (days < 30) {
						rel = $_('relative_time.terse.days', { values: { n: days } }) as string;
					} else {
						const months = Math.floor(days / 30);
						if (months < 12) {
							rel = $_('relative_time.terse.months', { values: { n: months } }) as string;
						} else {
							rel = $_('relative_time.terse.years', {
								values: { n: Math.floor(months / 12) }
							}) as string;
						}
					}
				}
			}
		}
		return `${$_('orderbook.order.updated_prefix')} ${rel}`;
	});

	/** Title/aria shown on hover: the expiry deadline, plus the
	 *  "Updated {ago}" suffix when a last-updated time is supplied. */
	const titleText = $derived(updatedTooltip ? `${ariaLabel} · ${updatedTooltip}` : ariaLabel);
</script>

<span
	class="order-expiry-chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
	class:expired={tier === 'expired'}
	class:urgent={tier === 'urgent'}
	class:near={tier === 'near'}
	class:far={tier === 'far'}
	aria-label={titleText}
	aria-live="polite"
	title={titleText}
>
	<span aria-hidden="true">⏳</span>
	<span>{formatted}</span>
</span>

<style>
	.order-expiry-chip {
		font-variant-numeric: tabular-nums;
	}
	/* De-brown D2: one flat emerald countdown style for every LIVE
	   tier (far/near/urgent), matching the profile + order-view
	   "expires in X" pills (border-morphit-emerald/30, bg /5, emerald
	   text). The tier still drives the JS tick rate (1s in urgent, 60s
	   otherwise) — only the colour is unified. Red stays reserved for
	   genuine errors/destructive actions, not a normal expiry. */
	.far,
	.near,
	.urgent {
		color: var(--morphit-emerald);
		background: rgba(0, 218, 105, 0.05);
		box-shadow: 0 0 0 1px rgba(0, 218, 105, 0.3);
	}
	.expired {
		color: rgb(107, 114, 128); /* tailwind ink-500 */
		background: rgb(243, 244, 246); /* tailwind ink-100 */
		text-decoration: line-through;
	}
	:global(.dark) .expired {
		color: rgb(156, 163, 175); /* tailwind ink-400 */
		background: rgba(31, 41, 55, 0.4); /* tailwind ink-800/40 */
	}
</style>
