<script lang="ts">
	/**
	 * SignupProgress — a skinny "Step X of Y" progress bar for the
	 * new-account signup journey. The journey spans the onboarding
	 * wizard (choose path → back up seed → confirm seed) plus the
	 * register-name route (claim @account), so this component is
	 * rendered on both with a shared 1..total step model. Existing
	 * Blurt users importing keys do NOT see it (different flow).
	 *
	 * Purely presentational: the caller passes the current step and
	 * the total. Kept intentionally minimal — a thin bar plus a small
	 * "Step X of Y" label — so it sits unobtrusively at the top of the
	 * page.
	 */
	import { _ } from 'svelte-i18n';

	interface Props {
		/** 1-based current step. */
		current: number;
		/** Total number of steps. */
		total: number;
	}

	let { current, total }: Props = $props();

	// Clamp to [0, 100] so an out-of-range step can never produce a
	// bar that overflows its track or goes negative.
	const pct = $derived(
		total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0
	);
</script>

<div class="mx-auto mb-6 w-full max-w-md">
	<p
		class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400"
	>
		{$_('onboarding.progress.step_label', { values: { current, total } })}
	</p>
	<div
		class="h-1.5 w-full overflow-hidden rounded-full bg-ink-200 dark:bg-ink-800"
		role="progressbar"
		aria-valuenow={current}
		aria-valuemin={1}
		aria-valuemax={total}
		aria-label={$_('onboarding.progress.step_label', { values: { current, total } })}
	>
		<div
			class="h-full rounded-full bg-morphit-emerald transition-[width] duration-500 ease-out"
			style="width: {pct}%"
		></div>
	</div>
</div>
