<script lang="ts">
	/**
	 * OrderCard (cp404) — the shared orderbook/profile order card.
	 *
	 * Replaces the two hand-duplicated inline cards (orderbook results +
	 * profile "active orders") with one component so the layout stays in
	 * sync. Layout, top to bottom:
	 *
	 *   • Title (bold) that tucks slightly over the avatar below it.
	 *   • Top-right cluster: the ⏳ "Expires in…" pill, and — when the
	 *     viewer can message — a stacked green "Message / @username" button.
	 *   • Identity row: avatar (identicon fallback) beside two lines —
	 *       line 1: display name (linked) · 🌱 new-trader chip · ⭐ score
	 *       line 2: truncated posting key · "N trades since {month}"
	 *     The reputation SCORE and the trade COUNT are deliberately
	 *     separate signals (score = how good; count = how much).
	 *   • "I can pay with:" (buy) / "I accept:" (sell) + payment methods,
	 *     with "Location:" alongside when a region is set.
	 *   • Terms — a single truncated line (full text on the order page).
	 *   • Eyeball hide/show toggle, bottom-right.
	 *
	 * The whole card is a stretched link to the order's detail page (z-0);
	 * the genuinely-interactive children (name link, Message button, hide
	 * toggle) are raised to z-10 so they keep their own click targets.
	 *
	 * Pure/presentational: every derived value (title, avatar, hrefs,
	 * payment labels) is passed in precomputed, so both call sites keep
	 * their own data plumbing and this component stays trivially testable.
	 */
	import type { OrderRecord } from '@morphit/indexer-client';
	import { _ } from 'svelte-i18n';
	import IdentityLabel from '$lib/components/IdentityLabel.svelte';
	import NewTraderChip from '$lib/components/NewTraderChip.svelte';
	import OrderExpiryChip from '$lib/components/OrderExpiryChip.svelte';
	// cp404: the "N talking now" engagement chip is hidden per Ken's
	// request. The engagement_24h data still flows on OrderRecord — to
	// display it again, restore this import and the commented block in
	// the identity row below.
	// import EngagementChip from '$lib/components/EngagementChip.svelte';
	import UsdtPriceSubline from '$lib/components/UsdtPriceSubline.svelte';
	import MessageIcon from '$lib/components/MessageIcon.svelte';
	import { truncatePublicKey } from '$lib/crypto/publicKeyDisplay';
	import { formatCountCompact, formatMonthYear } from '$lib/i18n/formatters';

	interface Props {
		/** The order to render. */
		order: OrderRecord;
		/** Precomputed, localized card title (e.g. "I'm buying 500 MXN…"). */
		title: string;
		/** Poster's display name, or null to fall back to "@account". */
		displayName?: string | null;
		/** Poster's sanitized avatar SVG (takes precedence over dataUri). */
		avatarSvg?: string | null;
		/** Poster's raster avatar as a data URI. */
		avatarDataUri?: string | null;
		/** Card-click target — the order's detail page. */
		detailHref: string;
		/** The poster's profile page. */
		profileHref: string;
		/** Chat deep-link, or null to hide the Message button (anonymous
		 *  viewer, or the order is the viewer's own). */
		messageHref?: string | null;
		/** Localized payment-method display names. */
		paymentLabels?: readonly string[];
		/** Optional multi-network chip (USDT/USDC/DAI). */
		networkChip?: { label: string; tone: 'usdt' | 'usdc' | 'dai' } | null;
		/** Localized price-model label (e.g. "Fixed price", "Market rate"),
		 *  shown under the expiry pill. Null/omitted → not shown. */
		priceModelLabel?: string | null;
		/** Whether this account is locally hidden / chain-blocked. */
		hidden?: boolean;
		blocked?: boolean;
		/** Toggle local hide. Omit to hide the eyeball entirely. */
		onToggleHide?: (() => void) | null;
		/** Fired when the Message button is clicked (e.g. view-count ping). */
		onMessageClick?: (() => void) | null;
		/** Extra classes for the root <li> (e.g. list animation). */
		class?: string;
	}

	let {
		order,
		title,
		displayName = null,
		avatarSvg = null,
		avatarDataUri = null,
		detailHref,
		profileHref,
		messageHref = null,
		paymentLabels = [],
		networkChip = null,
		priceModelLabel = null,
		hidden = false,
		blocked = false,
		onToggleHide = null,
		onMessageClick = null,
		class: cls = ''
	}: Props = $props();

	const count = $derived(order.feedback_count ?? 0);
	const score = $derived(order.reputation_score ?? null);
	const postingKey = $derived(truncatePublicKey(order.posting_pubkey ?? ''));

	// "852 trades since July, 2026" — count always shown (0 when none);
	// the "since {month}" tail only when a first trade exists.
	const tradesLine = $derived.by(() => {
		const c = formatCountCompact(count);
		return order.first_trade_at
			? ($_('orderbook.card.trades_since', {
					values: { count: c, month: formatMonthYear(order.first_trade_at) }
				}) as string)
			: ($_('orderbook.card.trades_only', { values: { count: c } }) as string);
	});

	const paymentLabelKey = $derived(
		order.side === 'buy' ? 'orderbook.card.pay_with_label' : 'orderbook.card.accept_label'
	);

	const networkChipClass = $derived(
		networkChip === null
			? ''
			: networkChip.tone === 'usdt'
				? 'border-ink-400/30 bg-ink-400/5 text-ink-300'
				: networkChip.tone === 'usdc'
					? 'border-sky-400/30 bg-sky-400/5 text-sky-300'
					: 'border-yellow-400/30 bg-yellow-400/5 text-yellow-300'
	);

	const handle = $derived('@' + order.account);
</script>

<li
	class="card-interactive relative p-4 sm:p-6 hover:border-morphit-emerald/20 hover:bg-emerald-50/30 dark:hover:border-morphit-emerald/15 dark:hover:bg-morphit-emerald/[0.05] {hidden ||
	blocked
		? 'opacity-50'
		: ''} {cls}"
>
	<!-- Stretched link: whole card opens the order detail page (z-0).
	     Interactive children below are raised to z-10. -->
	<a
		href={detailHref}
		class="absolute inset-0 z-0 rounded-[inherit] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-morphit-emerald"
		aria-label={$_('orderbook.order.open_aria', { values: { title } }) as string}
	></a>

	<!-- Top-right cluster: expiry pill, then the tiny price-model line and
	     USDT peg subline, then the (optional) Message button. -->
	<div class="absolute right-3 top-3 z-10 flex flex-col items-end gap-1.5 sm:right-4 sm:top-4">
		{#if order.expires_at}
			<OrderExpiryChip expiresAt={order.expires_at} updatedAtIso={order.updated_at} />
		{/if}
		{#if priceModelLabel}
			<span
				class="text-xs text-ink-500 dark:text-ink-400"
				title={$_('orderbook.price_model.tooltip') as string}
			>
				{priceModelLabel}
			</span>
		{/if}
		{#if order.asset === 'USDT'}
			<UsdtPriceSubline compact />
		{/if}
		{#if messageHref && !hidden && !blocked}
			<a
				href={messageHref}
				onclick={() => onMessageClick?.()}
				class="mt-0.5 flex flex-col items-center rounded-lg border border-morphit-emerald px-3 py-1 text-center leading-tight text-morphit-emerald transition hover:bg-morphit-emerald/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
				aria-label={$_('chat.message_button_aria', { values: { peer: order.account } }) as string}
			>
				<span class="inline-flex items-center gap-1 text-sm font-semibold">
					<MessageIcon class="h-4 w-4 shrink-0" />
					{$_('orderbook.card.message_word')}
				</span>
				<span class="max-w-[10rem] truncate text-[11px] opacity-90">{handle}</span>
			</a>
		{/if}
	</div>

	<!-- Title. Right padding clears the top-right cluster. -->
	<h3 class="font-display pr-24 text-lg font-bold sm:pr-28">{title}</h3>

	<!-- Identity row: avatar tucks up under the title; name + key beside. -->
	<div class="-mt-2 flex items-start gap-3">
		<div class="relative z-0 flex-none">
			<IdentityLabel
				account={order.account}
				{avatarSvg}
				{avatarDataUri}
				avatarSize={52}
				hideHandle
			/>
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
				{#if score !== null}
					<span
						class="inline-flex items-center gap-1 text-sm font-semibold text-morphit-emerald"
						aria-label={$_('orderbook.card.reputation_aria', {
							values: { score: score.toFixed(2) }
						}) as string}
						title={$_('orderbook.card.reputation_aria', {
							values: { score: score.toFixed(2) }
						}) as string}
					>
						<span aria-hidden="true">⭐</span>
						<span aria-hidden="true">{score.toFixed(2)}</span>
					</span>
				{/if}
				<!-- cp404: "N talking now" engagement chip hidden per Ken.
				     engagement_24h still flows on OrderRecord; restore the
				     EngagementChip import above and uncomment to display:
				{#if (order.engagement_24h ?? 0) > 0}
					<EngagementChip count={order.engagement_24h ?? 0} />
				{/if}
				-->
			</div>
			<!-- Line 2: truncated posting key · trade count since {month} -->
			<div
				class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-500 dark:text-ink-400"
			>
				{#if postingKey}
					<span class="font-mono">({postingKey})</span>
				{/if}
				<span>{tradesLine}</span>
			</div>
		</div>
	</div>

	<!-- Network chip (multi-network assets only). -->
	{#if networkChip !== null}
		<p class="mt-2">
			<span
				class="rounded-md border px-2 py-0.5 text-xs font-semibold {networkChipClass}"
				title={networkChip.label}
			>
				{networkChip.label}
			</span>
		</p>
	{/if}

	<!-- Payment + location. -->
	{#if paymentLabels.length > 0 || order.location_region}
		<p class="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-500 dark:text-ink-400">
			{#if paymentLabels.length > 0}
				<span>
					<span class="font-semibold">{$_(paymentLabelKey)}:</span>
					{paymentLabels.join(', ')}
				</span>
			{/if}
			{#if order.location_region}
				<span>
					<span class="font-semibold">{$_('orderbook.card.location_label')}:</span>
					{order.location_region}
				</span>
			{/if}
		</p>
	{/if}

	<!-- Terms — a single truncated line. Full text lives on the order page. -->
	{#if order.terms}
		<p class="mt-1.5 flex min-w-0 items-baseline gap-1 text-sm text-ink-700 dark:text-ink-200">
			<span class="shrink-0 font-semibold">{$_('orderbook.card.terms_label')}:</span>
			<span class="truncate">{order.terms}</span>
		</p>
	{/if}

	<!-- Bottom-right cluster: a blocked/hidden marker (so a dimmed card
	     explains itself) sits to the LEFT of the hide/show eyeball. The
	     eyeball is suppressed when chain-blocked (a stronger action was
	     taken) or when no toggle is wired; the marker still shows. -->
	{#if blocked || hidden || onToggleHide}
		<div class="absolute bottom-3 right-3 z-10 flex items-center gap-2">
			{#if blocked}
				<span
					class="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
				>
					{$_('orderbook.blocked_marker')}
				</span>
			{:else if hidden}
				<span
					class="rounded-full bg-ink-200 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-700 dark:bg-ink-800 dark:text-ink-300"
				>
					{$_('orderbook.hidden_marker')}
				</span>
			{/if}
			{#if onToggleHide && !blocked}
				<button
					type="button"
					onclick={() => onToggleHide?.()}
					title={hidden
						? ($_('orderbook.unhide_button_tooltip') as string)
						: ($_('orderbook.hide_button_tooltip') as string)}
					class="rounded px-2 py-1 text-ink-400 transition hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
					aria-label={hidden
						? ($_('orderbook.unhide_button_aria', { values: { account: order.account } }) as string)
						: ($_('orderbook.hide_button_aria', { values: { account: order.account } }) as string)}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						{#if hidden}
							<path
								d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"
							/>
							<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
							<path
								d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"
							/>
							<path d="m2 2 20 20" />
						{:else}
							<path
								d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
							/>
							<circle cx="12" cy="12" r="3" />
						{/if}
					</svg>
				</button>
			{/if}
		</div>
	{/if}
</li>
