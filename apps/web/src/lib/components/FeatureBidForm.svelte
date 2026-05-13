<script lang="ts">
	/**
	 * FeatureBidForm — inline UI for bidding on a featured slot.
	 *
	 * Used on /my/orders as a disclosure under each live order,
	 * and on the post-order success flow as an "also feature
	 * this?" upsell. Emits a callback on success so the parent
	 * can refetch (or push a toast, or navigate).
	 *
	 * Design choices:
	 *   - Hours picker is a 4-option chip ladder (1, 6, 24, 72)
	 *     because a free-entry input would invite 168 here and
	 *     0.5 there and we don't need either edge case in the UI.
	 *     Power users can broadcast the op directly; the UI
	 *     caters to the 95% case.
	 *   - Live BLURT cost preview updates as the user picks
	 *     hours.
	 *   - Password gathered inline with the same JIT pattern as
	 *     /post — we never persist the password, and the
	 *     plaintext active key only exists inside the
	 *     useActiveKey callback.
	 */

	import { get } from 'svelte/store';
	import { _ } from 'svelte-i18n';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import { identity } from '$stores/identity';
	import { runWithActiveKey } from '$crypto/runWithActiveKey';
	import { broadcastFeatureBid } from '$blurt/ops/featureBid';

	interface Props {
		/** Permlink of the order to promote. Must be a live order
		 *  owned by the current signer — enforced on-chain by the
		 *  indexer handler, but the parent UI should already have
		 *  filtered to live-owned. */
		orderPermlink: string;
		/** Per-hour BLURT rate from config. Default 50 matches the
		 *  indexer's `MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR`
		 *  default. Surfacing this as a prop lets the parent
		 *  override if it has fresher config data. */
		feeBlurtPerHour?: number;
		/** Called on successful broadcast so the parent can refetch
		 *  or close the disclosure. */
		onSuccess?: (result: { trx_id: string; blurtPaid: number }) => void;
		/** Called when the user dismisses the form without bidding. */
		onCancel?: () => void;
	}

	let { orderPermlink, feeBlurtPerHour = 50, onSuccess, onCancel }: Props = $props();

	const HOURS_OPTIONS = [1, 6, 24, 72] as const;
	let selectedHours: (typeof HOURS_OPTIONS)[number] = $state(24);
	let password = $state('');
	let submitting = $state(false);
	let errorMessage = $state('');

	const totalBlurt = $derived(feeBlurtPerHour * selectedHours);
	// Ceil at 3 decimals to match on-chain formatting and avoid
	// an under-by-epsilon rendered vs. transferred discrepancy.
	const totalBlurtDisplay = $derived((Math.ceil(totalBlurt * 1000) / 1000).toFixed(3));

	async function submit(): Promise<void> {
		if (submitting) return;
		const state = get(identity);
		if (state.state !== 'unlocked') {
			errorMessage = $_('feature_bid.error_locked');
			return;
		}
		if (password.length === 0) {
			errorMessage = $_('feature_bid.error_password_required');
			return;
		}
		submitting = true;
		errorMessage = '';

		// Phase F.5 audit fix (F-18) — sign-callback pattern.
		try {
			const signCallback = async (
				unsigned: import('@beblurt/dblurt').Transaction
			): Promise<import('@beblurt/dblurt').SignedTransaction> => {
				const r = await runWithActiveKey(password, async (activePriv) => {
					const { signOrderWithFeeWithKey } = await import('$blurt/sign');
					return signOrderWithFeeWithKey(unsigned, state.live.posting.privateKey, activePriv);
				});
				if (!r.ok) {
					const err = new Error(`runWithActiveKey:${r.kind}`);
					(err as Error & { kind?: string }).kind = r.kind;
					throw err;
				}
				return r.value;
			};
			const result = await broadcastFeatureBid(state.live, signCallback, {
				orderPermlink,
				hoursRequested: selectedHours,
				feeBlurtPerHour
			});
			password = '';
			onSuccess?.({
				trx_id: result.trx_id,
				blurtPaid: result.blurtPaid
			});
		} catch (err) {
			password = '';
			const kind = (err as Error & { kind?: string }).kind;
			if (kind === 'bad_password') {
				errorMessage = $_('feature_bid.error_bad_password');
			} else if (kind === 'identity_mismatch') {
				errorMessage = $_('crypto.error.identity_mismatch');
			} else if (kind === 'locked') {
				errorMessage = $_('feature_bid.error_locked');
			} else if (kind === 'password_empty') {
				errorMessage = $_('feature_bid.error_password_required');
			} else {
				console.warn('[feature_bid] unrecognized error:', err);
				errorMessage = $_('feature_bid.error_generic');
			}
		}
		submitting = false;
	}
</script>

<div
	class="rounded-xl border-2 border-morphit-emerald/40 bg-gradient-to-br from-morphit-emerald/5 to-morphit-teal/5 p-4"
>
	<p class="mb-1 font-display text-sm font-bold">
		⭐ {$_('feature_bid.title')}
	</p>
	<p class="mb-3 text-xs text-ink-600 dark:text-ink-300">
		{$_('feature_bid.explainer')}
	</p>

	<!-- Hours picker -->
	<fieldset class="mb-3">
		<legend class="mb-2 text-xs font-semibold text-ink-700 dark:text-ink-200">
			{$_('feature_bid.hours_label')}
		</legend>
		<div class="flex flex-wrap gap-2" role="radiogroup">
			{#each HOURS_OPTIONS as h}
				<button
					type="button"
					role="radio"
					aria-checked={selectedHours === h}
					onclick={() => (selectedHours = h)}
					class="rounded-full border-2 px-3 py-1 text-sm transition active:scale-[0.98] {selectedHours ===
					h
						? 'border-morphit-emerald bg-morphit-emerald/10 font-semibold'
						: 'border-ink-300 dark:border-ink-600'}"
				>
					{$_('feature_bid.hours_option', { values: { n: h } })}
				</button>
			{/each}
		</div>
	</fieldset>

	<!-- Cost preview -->
	<div class="mb-3 rounded-lg bg-ink-50 p-3 dark:bg-ink-800">
		<p class="text-xs text-ink-500 dark:text-ink-400">
			{$_('feature_bid.cost_label')}
		</p>
		<p class="font-display text-lg font-bold">
			{totalBlurtDisplay} BLURT
		</p>
		<p class="text-xs text-ink-500 dark:text-ink-400">
			{$_('feature_bid.cost_detail', {
				values: { per_hour: feeBlurtPerHour, hours: selectedHours }
			})}
		</p>
	</div>

	<!-- Password prompt. Required because this op uses the
	     active key (pays BLURT). Same JIT pattern as /post:
	     never persisted, cleared after submit, and the plaintext
	     active key only exists inside the useActiveKey callback. -->
	<label class="mb-3 block">
		<span class="mb-1 block text-xs font-semibold text-ink-700 dark:text-ink-200">
			{$_('feature_bid.password_label')}
		</span>
		<input
			type="password"
			bind:value={password}
			autocomplete="current-password"
			disabled={submitting}
			class="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
		/>
	</label>

	<div class="flex flex-col gap-2">
		<BusyButton
			variant="primary"
			busy={submitting}
			busyLabel={$_('feature_bid.submitting')}
			onclick={submit}
		>
			{$_('feature_bid.submit_button')}
		</BusyButton>
		{#if onCancel}
			<BusyButton variant="ghost" onclick={() => onCancel?.()}>
				{$_('feature_bid.cancel_button')}
			</BusyButton>
		{/if}
	</div>

	{#if errorMessage}
		<div class="mt-2">
			<StatusLine kind="warn">{errorMessage}</StatusLine>
		</div>
	{/if}
</div>
