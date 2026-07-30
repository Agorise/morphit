<script lang="ts">
	/**
	 * TrustScoreModal — explains why the pill's number is not the plain average.
	 *
	 * v1.8.14 (Ken). The pill shows a Bayesian-shrunk trust score; a profile also
	 * shows the raw average beneath its headline. Two numbers, and until now
	 * nothing on screen said why they differ — Ken asked directly, and if the
	 * person who commissioned the system has to ask, every trader will wonder
	 * whether the site is simply inconsistent.
	 *
	 * The text is deliberately the plain-language version Ken asked for rather
	 * than the statistical one: what it is, why it is lower than the average, and
	 * the concrete abuse it prevents. A trust signal nobody understands is not a
	 * trust signal.
	 *
	 * The score is interpolated so the explanation names the number actually on
	 * that trader's pill, not a stand-in.
	 */
	import { t } from '$lib/i18n';
	import { portal } from '$lib/ui/portal';

	interface Props {
		/** The trust score shown in the pill that was clicked. */
		score: number;
		open: boolean;
		onClose: () => void;
	}

	const { score, open, onClose }: Props = $props();

	const shown = $derived(score.toFixed(2));

	/** Focus the OK button when the dialog opens, so keyboard and screen-reader
	 *  users land inside it and Enter closes. Defined locally: the codebase has
	 *  no shared action for this, and inventing an import would be worse than
	 *  four lines. */
	function focusOnMount(node: HTMLElement): void {
		node.focus();
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window on:keydown={open ? onKeydown : undefined} />

<!-- Backdrop: dark + blur so the dialog lifts off the page, per Ken. Clicking
     it closes, which is the expected escape on touch where Esc has no key.

     `use:portal` moves this container to <body> for the life of the component
     (t.txt v1.8.16 #4). This modal is not mounted at page/layout level like
     SendBlurtModal et al. — it lives DEEP inside the RatingChip, which sits
     inside TradeRepCluster's `whitespace-nowrap` span, inside OrderCard, and
     also inside ConversationView's slide-transitioned chat panel and the sticky
     (`backdrop-blur-md`) header. Two bugs came straight out of that:
       (a) the `<p>` text INHERITED `white-space: nowrap` from the cluster, so
           every paragraph ran off the side instead of wrapping (Ken's
           wrap-is-wrong.png); and
       (b) an ancestor with `transform`/`filter`/`backdrop-filter` becomes the
           containing block for `position: fixed`, so `fixed inset-0` no longer
           covered the viewport on those pages — the scrim was clipped to the
           card/panel and a click in the uncovered area never reached it, so the
           modal wouldn't close (Ken: "doesn't always close, no matter which
           page").
     Portaling to <body> escapes BOTH: <body> is `white-space: normal` and has
     no filtered/transformed ancestor, so the text wraps and the scrim truly
     fills the viewport. z-[60] (not z-50) to sit above the sticky header (z-40)
     once we're a <body> child — same value AvatarMenu's scrim uses for the
     identical reason. See $lib/ui/portal.ts.

     CRITICAL — this container is ALWAYS rendered and portaled ONCE; the `{#if
     open}` lives INSIDE it, never around it. Portaling the first node of an
     `{#if}` block moves that block's boundary node to <body>, which breaks the
     block's teardown (avatar-menu-portal-smoke: "closing removed nothing, a
     dead scrim stayed over the page"). Rule: portal a STABLE node. When closed
     the container is `pointer-events-none hidden` (display:none), so it shows
     nothing and cannot eat clicks. -->
<div
	use:portal
	class="fixed inset-0 z-[60] flex items-end justify-center bg-ink-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-4 {open
		? ''
		: 'pointer-events-none hidden'}"
	role="presentation"
	onclick={onClose}
	onkeydown={(e) => {
		if (e.key === 'Escape') onClose();
	}}
>
	{#if open}
		<!-- Mobile: full-width sheet pinned to the bottom (thumb-reachable), with
		     `dvh` so an open keyboard or browser chrome cannot clip the OK button.
		     Desktop: a centred card. Stop propagation so a click INSIDE never
		     dismisses. Gated by `{#if open}` (INSIDE the stable container) so the OK
		     button's `use:focusOnMount` fires on each open, not once at page load. -->
		<div
			class="max-h-[90dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl border border-ink-200 bg-white p-5 shadow-morphit-card-hover sm:rounded-2xl dark:border-ink-700 dark:bg-ink-900"
			role="dialog"
			aria-modal="true"
			aria-labelledby="trust-score-heading"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<h2 id="trust-score-heading" class="whitespace-normal font-display text-lg font-bold">
				{$t('trust_score.heading', { values: { score: shown } })}
			</h2>

			<!-- `whitespace-normal` is belt-and-suspenders (t.txt v1.8.16 #4): the
			     portal already re-parents this to <body> so nowrap is no longer
			     inherited, but stating it here means a future re-mount inside a
			     nowrap ancestor can't silently regress the wrapping again. -->
			<div class="mt-3 space-y-3 whitespace-normal text-sm text-ink-700 dark:text-ink-200">
				<p>{$t('trust_score.what_it_is', { values: { score: shown } })}</p>
				<p>{$t('trust_score.why')}</p>
				<p>{$t('trust_score.drift', { values: { score: shown } })}</p>
			</div>

			<button
				type="button"
				class="mt-5 w-full rounded-xl bg-morphit-teal px-4 py-3 font-semibold text-white hover:bg-morphit-teal/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
				onclick={onClose}
				use:focusOnMount
			>
				{$t('common.ok')}
			</button>
		</div>
	{/if}
</div>
