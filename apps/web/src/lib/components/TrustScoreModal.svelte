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

{#if open}
	<!-- Backdrop: dark + blur so the dialog lifts off the page, per Ken. Clicking
	     it closes, which is the expected escape on touch where Esc has no key. -->
	<div
		class="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
		role="presentation"
		onclick={onClose}
		onkeydown={(e) => {
			if (e.key === 'Escape') onClose();
		}}
	>
		<!-- Mobile: full-width sheet pinned to the bottom (thumb-reachable), with
		     `dvh` so an open keyboard or browser chrome cannot clip the OK button.
		     Desktop: a centred card. Stop propagation so a click INSIDE never
		     dismisses. -->
		<div
			class="max-h-[90dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl border border-ink-200 bg-white p-5 shadow-morphit-card-hover sm:rounded-2xl dark:border-ink-700 dark:bg-ink-900"
			role="dialog"
			aria-modal="true"
			aria-labelledby="trust-score-heading"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<h2 id="trust-score-heading" class="font-display text-lg font-bold">
				{$t('trust_score.heading', { values: { score: shown } })}
			</h2>

			<div class="mt-3 space-y-3 text-sm text-ink-700 dark:text-ink-200">
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
	</div>
{/if}
