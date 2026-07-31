<script lang="ts">
	/**
	 * OrderCard (cp404) — the shared orderbook/profile order card.
	 *
	 * Replaces the two hand-duplicated inline cards (orderbook results +
	 * profile "active orders") with one component so the layout stays in
	 * sync. Layout, top to bottom:
	 *
	 *   • Title (bold), sitting cleanly ABOVE the avatar (cp420 — it used
	 *     to tuck over the avatar; that was dropped). On phones the title
	 *     clamps to 2 lines.
	 *   • Top-right cluster (DESKTOP ≥sm): the ⏳ "Expires in…" pill, the
	 *     tiny price-model line, the stablecoin peg subline, and — when the
	 *     viewer can message — a stacked green "Message / @username" button.
	 *   • Identity row: avatar (identicon fallback) beside two lines —
	 *       line 1: display name (linked) · 🌱 new-trader chip · ⭐ score
	 *       line 2: truncated posting key · "N trades since {month}"
	 *     The reputation SCORE and the trade COUNT are deliberately
	 *     separate signals (score = how good; count = how much).
	 *   • "I can pay with:" (buy) / "I accept:" (sell) + payment methods,
	 *     with "Location:" alongside when a region is set.
	 *   • Terms — a single truncated line (full text on the order page).
	 *   • Eyeball hide/show toggle, bottom-right (DESKTOP ≥sm only).
	 *
	 * MOBILE (<sm) declutter (cp420): the top-right pill + message button,
	 * the price-model line, and the eyeball are all hidden; instead a single
	 * full-width "🗨 Message @username before <date>" button spans the foot
	 * of the card (OrderCardMobileMessageButton).
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
	import OrderPosterIdentity from '$lib/components/OrderPosterIdentity.svelte';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import OrderExpiryChip from '$lib/components/OrderExpiryChip.svelte';
	// cp404: the "N talking now" engagement chip is hidden per Ken's
	// request. The engagement_24h data still flows on OrderRecord — to
	// display it again, restore this import and the commented block in
	// OrderPosterIdentity.
	// import EngagementChip from '$lib/components/EngagementChip.svelte';
	import StablecoinPriceSubline from '$lib/components/StablecoinPriceSubline.svelte';
	import { isStablecoinSublineTicker } from '$lib/assets/stablecoinSubline';
	import MessageIcon from '$lib/components/MessageIcon.svelte';
	import OrderCardMobileMessageButton from '$lib/components/OrderCardMobileMessageButton.svelte';
	import { stripMarkdown } from '$lib/seo/stripMarkdown';
	import { highlightMatches } from '$lib/utils/highlightMatches';

	interface Props {
		/** The order to render. */
		order: OrderRecord;
		/** Precomputed, localized card title (e.g. "I'm buying 500 MXN…"). */
		title: string;
		/** Poster's display name, or null to fall back to "@account". */
		displayName?: string | null;
		/** Forwarded: true while the poster's profile is still loading, so the
		 *  label waits rather than asserting @account + identicon (v1.8.13). */
		pending?: boolean;
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
		/** cp411 — lowercased search tokens from the orderbook's free-text
		 *  "Order details" filter. When non-empty, occurrences in the terms
		 *  preview are wrapped in a <mark> so the searcher sees why the card
		 *  matched. Omitted/empty everywhere except the filtered orderbook. */
		highlightTokens?: readonly string[];
		/** Extra classes for the root <li> (e.g. list animation). */
		class?: string;
		/** cp428 — render this card in the FEATURED style: an emerald border +
		 *  faint gradient wash + a "🎉 Featured" corner badge. The card content
		 *  is identical to a normal order card (same layout on PC + mobile) —
		 *  featuring only changes the frame, so a featured order reads exactly
		 *  like every other card plus the badge. */
		featured?: boolean;
		/** t.txt (v1.4.9 #9) — true when this card was just prepended to a
		 *  live-updating orderbook (a brand-new on-chain order arriving while
		 *  the user watches). Plays a one-shot slide-in on the card's root, so
		 *  the new order slides into first place instead of popping in. Default
		 *  false — every other OrderCard usage (initial load, static lists) is
		 *  unaffected. Reduced-motion users get no animation (CSS media query). */
		justArrived?: boolean;
	}

	let {
		order,
		title,
		displayName = null,
		pending = false,
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
		highlightTokens = [],
		class: cls = '',
		featured = false,
		justArrived = false
	}: Props = $props();

	// count / score / postingKey / tradesLine now live inside
	// OrderPosterIdentity (the shared identity row).

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

	// cp440/v1.1.5 — the top-right cluster (expiry pill, price-model line,
	// message button) is DESKTOP-only (all `hidden sm:block` / `sm:flex`). On
	// phones the ONLY thing that can sit top-right is the stablecoin price
	// subline, and only for USDT/USDC/DAI. So on mobile the title's `pr-24`
	// was reserving 6rem of EMPTY space for the other 95% of orders, forcing
	// "…worth of BLURT" to wrap a line early. Reserve mobile right-pad only
	// when the subline is actually there; otherwise a hair of pad so a long
	// title can use nearly the full card width and fit in fewer lines.
	const hasMobileTopRight = $derived(isStablecoinSublineTicker(order.asset));

	// cp406 — the card shows a single truncated line, so strip the terms'
	// markdown (headings / bold / italics / lists / hr) and collapse line feeds
	// to plain text. Full markdown renders on the order detail page (TermsText).
	const termsPreview = $derived(order.terms ? stripMarkdown(order.terms) : '');
	// cp411 — when the orderbook's "Order details" search is active, mark the
	// matched word(s) in the preview. highlightMatches escapes the text and only
	// emits <mark class="…"> (static), so this {@html} is safe for user terms.
	const termsPreviewHtml = $derived(
		highlightTokens.length > 0
			? highlightMatches(termsPreview, highlightTokens)
			: null
	);
</script>

<li
	class="card-interactive relative p-4 sm:p-6 card-hover-emerald {hidden ||
	blocked
		? 'opacity-50'
		: ''} {featured
		? 'border-2 border-morphit-emerald/40 bg-gradient-to-br from-morphit-emerald/5 to-morphit-teal/5'
		: ''} {cls} {justArrived ? 'order-slide-in' : ''}"
>
	<!-- Stretched link: whole card opens the order detail page (z-0).
	     Interactive children below are raised to z-10. -->
	<a
		href={detailHref}
		class="absolute inset-0 z-0 rounded-[inherit] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-morphit-emerald"
		aria-label={$_('orderbook.order.open_aria', { values: { title } }) as string}
	></a>

	<!-- Top-right cluster (DESKTOP ≥sm): expiry pill, the tiny price-model
	     line, the stablecoin peg subline, then the (optional) Message button.
	     On phones the pill, price-model line, and message button are hidden —
	     they fold into the full-width button at the foot of the card. -->
	<div class="absolute right-3 top-3 z-10 flex flex-col items-end gap-1.5 sm:right-4 sm:top-4">
		{#if order.expires_at}
			<div class="hidden sm:block">
				<!-- v1.7.5 (t.txt #5) — `created_at`, NOT `updated_at`. The tooltip says
					     "Posted {age} ago", and `updated_at` doesn't mean that: feeAttest
					     moves it when a BTC/XMR listing fee verifies, which happens to a
					     live order hours after posting. -->
					<OrderExpiryChip expiresAt={order.expires_at} postedAtIso={order.created_at} />
			</div>
		{/if}
		{#if priceModelLabel}
			<span
				class="hidden text-xs text-ink-500 dark:text-ink-400 sm:block"
				title={$_('orderbook.price_model.tooltip') as string}
			>
				{priceModelLabel}
			</span>
		{/if}
		{#if isStablecoinSublineTicker(order.asset)}
			<StablecoinPriceSubline asset={order.asset} compact />
		{/if}
		{#if messageHref && !hidden && !blocked}
			<a
				href={messageHref}
				onclick={() => onMessageClick?.()}
				class="mt-0.5 hidden flex-col items-center rounded-lg border border-morphit-emerald px-3 py-1 text-center leading-tight text-morphit-emerald transition hover:bg-morphit-emerald/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald sm:flex"
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

	<!-- cp428 — featured badge sits on its own line above the title (top-left),
	     so it never collides with the top-right expiry / message cluster. -->
	{#if featured}
		<p class="mb-2">
			<span
				class="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-morphit-emerald to-morphit-teal px-2.5 py-0.5 text-xs font-bold text-ink-950"
			>
				🎉 {$_('featured.badge')}
			</span>
		</p>
	{/if}

	<!-- Title (cp615). DESKTOP: one line, ellipsised (sm:line-clamp-1), with a
	     right pad wide enough to clear the top-right cluster — the Message
	     button's username is max-w-[10rem], so the cluster runs ~11.5rem and the
	     old sm:pr-28 (7rem) let a long title bleed right up to the button.
	     sm:pr-[13rem] keeps a clear gap. MOBILE: at most two lines
	     (line-clamp-2); that cluster is hidden there, so we pad only when the
	     stablecoin subline is present (pr-20), otherwise a hair (pr-2) so the
	     title uses nearly the full width. -->
	<h3
		class="font-display line-clamp-2 text-lg font-bold sm:line-clamp-1 sm:pr-[13rem] {hasMobileTopRight
			? 'pr-20'
			: 'pr-2'}"
	>
		{title}
	</h3>

	<!-- Identity row (shared with the order detail "POSTED BY" card via
	     OrderPosterIdentity). cp420 — the avatar now sits cleanly below the
	     title (was -mt-2, which tucked it up under the title). -->
	<div class="mt-1">
		<OrderPosterIdentity {order} {pending} {displayName} {avatarSvg} {avatarDataUri} {profileHref} />
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
					<bdi>{order.location_region}</bdi>
				</span>
			{/if}
		</p>
	{/if}

	<!-- Terms — a single truncated, markdown-stripped line. Full text (with
	     markdown) lives on the order page. -->
	{#if termsPreview}
		<p
			class="mt-1.5 flex min-w-0 items-baseline gap-1 text-sm text-ink-700 sm:pr-8 dark:text-ink-200"
		>
			<span class="shrink-0 font-semibold">{$_('orderbook.card.terms_label')}:</span>
			{#if termsPreviewHtml !== null}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- highlightMatches
				     escapes the text and only injects <mark class> (see its doc). -->
				<span dir="auto" class="truncate">{@html termsPreviewHtml}</span>
			{:else}
				<span dir="auto" class="truncate">{termsPreview}</span>
			{/if}
		</p>
	{/if}

	<!-- MOBILE (<sm) foot button: the combined "🗨 Message @username before
	     <date>" CTA, full width. It stands in for the top-right pill + message
	     button, both hidden on phones. Only shown when the poster is
	     messageable (same guard as the desktop button). -->
	{#if messageHref && !hidden && !blocked}
		<div class="mt-3 sm:hidden">
			<OrderCardMobileMessageButton
				href={messageHref}
				account={order.account}
				expiresAt={order.expires_at ?? null}
				onClick={() => onMessageClick?.()}
			/>
		</div>
	{/if}

	<!-- Bottom-right cluster: a blocked/hidden marker (so a dimmed card
	     explains itself) sits to the LEFT of the hide/show eyeball. The
	     eyeball is suppressed when chain-blocked (a stronger action was
	     taken) or when no toggle is wired; the marker still shows. The
	     eyeball is also hidden on phones (cp420); the marker still shows. -->
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
				<!-- cp425 — the hide/show explainer moved from the native `title`
				     tooltip (small + hard to read) to the styled Tooltip. The
				     desktop-only gate lives on the wrapper (was `sm:block` on the
				     button); the button keeps its own toggle click handler. -->
				<div class="hidden sm:block">
					<Tooltip
						textKey={hidden
							? 'orderbook.unhide_button_tooltip'
							: 'orderbook.hide_button_tooltip'}
						ariaLabel={hidden
							? ($_('orderbook.unhide_button_aria', {
									values: { account: order.account }
								}) as string)
							: ($_('orderbook.hide_button_aria', {
									values: { account: order.account }
								}) as string)}
					>
						{#snippet trigger()}
							<button
								type="button"
								onclick={() => onToggleHide?.()}
								class="rounded px-2 py-1 text-ink-400 transition hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
								aria-label={hidden
									? ($_('orderbook.unhide_button_aria', {
											values: { account: order.account }
										}) as string)
									: ($_('orderbook.hide_button_aria', {
											values: { account: order.account }
										}) as string)}
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
						{/snippet}
					</Tooltip>
				</div>
			{/if}
		</div>
	{/if}
</li>

<style>
	/* t.txt (v1.4.9 #9) — a brand-new order prepended to the LIVE orderbook
	   slides into first place instead of popping in. One-shot: the page clears
	   the `justArrived` flag after the animation so it never replays. `:global`
	   because the class is applied via a dynamic `{justArrived ? … : ''}`
	   expression, which Svelte's scoped-CSS pass would otherwise tree-shake. */
	@keyframes order-slide-in {
		from {
			opacity: 0;
			transform: translateY(-0.75rem);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	:global(.order-slide-in) {
		animation: order-slide-in 0.32s ease-out;
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.order-slide-in) {
			animation: none;
		}
	}
</style>
