<script lang="ts">
	/**
	 * OrderPosterIdentity — the poster identity + reputation row shown on an
	 * order. Extracted from OrderCard (cp406, Ken) so the order DETAIL page's
	 * "POSTED BY" card renders the EXACT same layout as the orderbook cards:
	 * avatar, then display name · new-trader chip · ⭐ reputation, then the
	 * truncated posting key · trade-count line. The trade specifics (side,
	 * asset, range, fiat, payment methods, terms, location, timing) live in the
	 * DETAILS card below on the detail page, so they are intentionally NOT here.
	 *
	 * All fields derive from the OrderRecord, so both call sites (OrderCard and
	 * the detail page — both fed by getOrdersByAccount) produce identical
	 * output.
	 */
	import { _ } from 'svelte-i18n';
	import type { OrderRecord } from '@morphit/indexer-client';
	import IdentityLabel from '$lib/components/IdentityLabel.svelte';
	import NewTraderChip from '$lib/components/NewTraderChip.svelte';
	import TradeRepCluster from '$lib/components/TradeRepCluster.svelte';
	import { truncatePublicKey } from '$lib/crypto/publicKeyDisplay';
	import { resolvePostingKey } from '$blurt/postingKeyResolver';

	interface Props {
		order: OrderRecord;
		/** Resolved display name (null → the @handle is shown instead). */
		displayName?: string | null;
		/** Forwarded: true while the poster's profile is still loading, so the
		 *  label waits rather than asserting @account + identicon (v1.8.13). */
		pending?: boolean;
		avatarSvg?: string | null;
		avatarDataUri?: string | null;
		/** Locale-aware href to the poster's profile. */
		profileHref: string;
		/** Optional posting key to show instead of order.posting_pubkey. The
		 *  order detail page fetches a fresh /keys value; the orderbook card
		 *  uses the record's own field. Both are truncated identically, so the
		 *  layout is unchanged either way. */
		postingKeyOverride?: string | null;
	}

	let {
		order,
		displayName = null,
		pending = false,
		avatarSvg = null,
		avatarDataUri = null,
		profileHref,
		postingKeyOverride = null
	}: Props = $props();

	const handle = $derived('@' + order.account);
	// v1.5.5 — two DIFFERENT numbers now: `ratingCount` says how many RATINGS
	// back the star average; `tradeCount` counts COMPLETED TRADES (both sides
	// credited). A trade nobody reviewed counts in the second and not the first.
	const ratingCount = $derived(order.feedback_count ?? 0);
	const tradeCount = $derived(order.trade_count ?? 0);
	const score = $derived(order.reputation_score ?? null);
	// v1.8.11 (Ken) — resolve through the shared resolver instead of trusting
	// `order.posting_pubkey` alone. That column is filled by a BACKFILL JOB, so
	// for an account new to Morphit it is briefly empty and the card rendered
	// with no key while the order detail page — which does a live authority
	// lookup — showed it fine. The key is the anti-impersonation anchor, so
	// "present only once a background job has run" is the wrong contract.
	// The inline value short-circuits the resolver, so a populated column costs
	// nothing; only the gap triggers a (cached, de-duplicated) lookup.
	let resolvedKey = $state<string | null>(null);
	$effect(() => {
		const acct = order.account;
		const inline = order.posting_pubkey ?? null;
		resolvedKey = inline;
		if (inline !== null || !acct) return;
		let cancelled = false;
		void resolvePostingKey(acct, inline).then((k) => {
			// Discard if the card was re-used for a DIFFERENT order while the
			// lookup was in flight — otherwise one poster's key could land on
			// another poster's card, which is the one mistake a trust anchor
			// must never make.
			if (!cancelled && order.account === acct) resolvedKey = k;
		});
		return () => {
			cancelled = true;
		};
	});
	const postingKey = $derived(truncatePublicKey(postingKeyOverride ?? resolvedKey ?? ''));

	// v1.5.5 — the trade count moved into TradeRepCluster ("1 trade · ★5.00
	// (34)"), which owns the wording. The old "852 trades since July, 2026"
	// tail is deliberately gone from this row: the cluster is `whitespace-
	// nowrap` by contract (Ken: the chunk must never break mid-way), and a
	// "since {month}" tail makes it long enough to overflow a phone instead of
	// wrapping — the exact tightness problem Ken asked to fix. The first-trade
	// date remains available on the profile.
</script>

<!-- Identity row: avatar tucks up under the title; name + key beside. -->
<div class="flex items-start gap-3">
	<div class="relative z-0 flex-none">
		<IdentityLabel account={order.account} {pending} {avatarSvg} {avatarDataUri} avatarSize={52} hideHandle />
	</div>
	<div class="min-w-0 flex-1 pt-1">
		<!-- Line 1: display name · new-trader · reputation score -->
		<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
			<a
				href={profileHref}
				class="relative z-10 truncate font-bold text-ink-900 hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-white"
			>
				{displayName || handle}
			</a>
			{#if order.is_new_trader}
				<NewTraderChip />
			{/if}
			<!-- v1.5.5 — ONE cluster: "1 trade · ★5.00 (34)". Unbreakable
			     (TradeRepCluster is nowrap + flex-none); this row is flex-wrap,
			     so it sits at the end of the name line when it fits and drops
			     WHOLE onto its own line when it doesn't. Replaces the old bare
			     ⭐ score span — the emoji star read as a different thing from
			     the emerald ★ used for feedback, and the trade count used to
			     live on a separate grey line below. -->
			<TradeRepCluster {tradeCount} rating={score} {ratingCount} />
		</div>
		<!-- Line 2: truncated posting key (the trade count moved up into the
		     cluster on line 1 — see above). -->
		{#if postingKey}
			<div class="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
				<span class="font-mono">({postingKey})</span>
			</div>
		{/if}
	</div>
</div>
