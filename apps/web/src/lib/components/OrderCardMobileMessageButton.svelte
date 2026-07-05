<!--
	OrderCardMobileMessageButton (cp420) — the mobile-only, full-width message
	CTA at the bottom of an OrderCard. Combines what desktop shows as two
	separate top-right elements (the ⏳ expiry pill + the "Message / @user"
	button) into ONE slim button: "🗨 Message @username before 26 Jun".

	Mobile order cards were cramped, so on phones we drop the top-right cluster
	and put this single spanning button at the foot of the card instead.

	One line only (whitespace-nowrap). If the full "before <date>" suffix would
	not fit — long username on a narrow phone — we drop it and show just
	"Message @username" rather than wrapping to two lines. The fit is measured
	against a hidden full-width copy of the label (so the decision never
	oscillates), re-checked on resize. The month is clipped to 3 chars by
	formatDayMonthShort so it stays compact in every language.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import MessageIcon from '$components/MessageIcon.svelte';
	import { formatDayMonthShort } from '$lib/i18n/formatters';

	interface Props {
		/** Chat deep-link for the poster. */
		href: string;
		/** Poster's Blurt account (without the leading @). */
		account: string;
		/** ISO expiry; omit/null to show just "Message @username". */
		expiresAt?: string | null;
		/** Fired on click (e.g. the orderbook's view-count ping). */
		onClick?: (() => void) | null;
	}
	let { href, account, expiresAt = null, onClick = null }: Props = $props();

	const handle = $derived('@' + account);
	const dateShort = $derived(expiresAt ? formatDayMonthShort(expiresAt) : '');

	// The full (dated) label and the compact fallback.
	const datedLabel = $derived(
		$_('orderbook.card.message_before', { values: { handle, date: dateShort } }) as string
	);
	const compactLabel = $derived(
		$_('orderbook.card.message_compact', { values: { handle } }) as string
	);

	// Fit measurement: does "icon + gap + dated label" fit the button's inner
	// width? Compared against a hidden intrinsic-width copy so toggling the
	// suffix can't change the measurement (no oscillation).
	const ICON_AND_GAP = 22; // h-4 icon (16) + gap-1.5 (6)
	const PAD_X = 24; // px-3 both sides
	let btnEl = $state<HTMLElement | null>(null);
	let measurerEl = $state<HTMLElement | null>(null);
	let dateFits = $state(true);

	$effect(() => {
		const btn = btnEl;
		const m = measurerEl;
		if (!btn || !m || !dateShort || typeof ResizeObserver === 'undefined') return;
		// This button is display:none on desktop (parent is sm:hidden), where
		// offsetParent is null — bail so we don't attach an observer per card
		// on viewports that never show it. Phones (<sm) always reach the
		// observer since the button is laid out there.
		if (btn.offsetParent === null) return;
		const recompute = () => {
			dateFits = m.scrollWidth + ICON_AND_GAP <= btn.clientWidth - PAD_X;
		};
		const ro = new ResizeObserver(recompute);
		ro.observe(btn);
		recompute();
		return () => ro.disconnect();
	});

	const label = $derived(dateShort && dateFits ? datedLabel : compactLabel);
</script>

<a
	bind:this={btnEl}
	{href}
	onclick={() => onClick?.()}
	class="relative z-10 flex w-full items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-lg border border-morphit-emerald px-3 py-2 text-sm font-semibold text-morphit-emerald transition hover:bg-morphit-emerald/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
	aria-label={$_('chat.message_button_aria', { values: { peer: account } }) as string}
>
	<MessageIcon class="h-4 w-4 shrink-0" />
	<span class="truncate">{label}</span>
	<!-- Hidden intrinsic-width measurer for the full (dated) label. -->
	{#if dateShort}
		<span
			bind:this={measurerEl}
			aria-hidden="true"
			class="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
		>
			{datedLabel}
		</span>
	{/if}
</a>
