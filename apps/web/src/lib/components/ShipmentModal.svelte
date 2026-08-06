<script lang="ts">
	/**
	 * ShipmentModal (cp121) — record that the user shipped
	 * something physical to their trade counterparty.  Generic
	 * to both cash-by-mail trades (buyer ships cash to seller)
	 * and physical-goods trades (seller ships e.g. a Barbie doll
	 * to a buyer paying with crypto).
	 *
	 * Builds a `morphit_shipment` v1 payload and sends it through
	 * the chat-send path.  Recipient's ChatMessage renders a
	 * "Shipped via X, tracking ABC" pill with optional clickable
	 * tracking link.
	 *
	 * SAFETY ASIDE
	 * ────────────
	 * The modal surfaces two sets of tips:
	 *
	 *  1. Always-shown (any physical shipment):
	 *     - Use a tracked, INSURED service
	 *     - Plain unmarked envelope/box (don't advertise contents)
	 *     - Return address tradeoff (anonymity vs. recovery)
	 *     - Tracking number is OPTIONAL but recommended as proof
	 *
	 *  2. Collapsible "If you're mailing CASH" expander:
	 *     - Wrap cash in foil/aluminum (defeats envelope-fishers
	 *       + RFID scanners; Ken's tip)
	 *     - UPS and FedEx PROHIBIT cash shipments; opened
	 *       packages can be confiscated with no recourse
	 *     - International: don't lie on customs; high-value
	 *       cash will be seized
	 *
	 * PRIVACY POSTURE
	 * ───────────────
	 * Tracking numbers stay in E2E-encrypted chat ONLY.  They
	 * are never written to indexer / never on-chain.  The
	 * RECIPIENT can look up tracking on the carrier's site
	 * (revealing origin postmark + delivery info to them, which
	 * is fine — they're the destination).  A third party would
	 * need access to the chat to obtain the number.
	 */

	import { _ } from 'svelte-i18n';
	import {
		encodeShipmentPayload,
		isValidTrackingNumber,
		isValidCustomTrackingUrl,
		SHIPMENT_LIMITS,
		type ShipmentPayload
	} from '$lib/chat/payload';
	import { CARRIERS } from '$lib/shipping/carriers';

	interface Props {
		/** Pre-filled order permlink. */
		orderPermlink?: string;
		/** Called with the encoded JSON payload string. */
		onShare: (payload: string) => Promise<void> | void;
		/** Called when user cancels. */
		onCancel: () => void;
	}

	let { orderPermlink, onShare, onCancel }: Props = $props();

	// Form state
	let carrier = $state<string>(''); // empty = no carrier picked
	let tracking = $state('');
	let customCarrierName = $state('');
	let customTrackingUrl = $state('');
	let note = $state('');
	let cashTipsOpen = $state(false);

	const carrierValid = $derived(carrier.length > 0 && /^[a-z0-9_]{2,32}$/.test(carrier));
	const trackingValid = $derived(isValidTrackingNumber(tracking));
	const customCarrierNameValid = $derived(
		carrier !== 'other' ||
			(customCarrierName.length > 0 &&
				customCarrierName.length <= SHIPMENT_LIMITS.customCarrierNameMax)
	);
	const customTrackingUrlValid = $derived(
		carrier !== 'other' ||
			customTrackingUrl.length === 0 ||
			isValidCustomTrackingUrl(customTrackingUrl)
	);
	const noteValid = $derived(note.length <= SHIPMENT_LIMITS.noteMax);

	const canShare = $derived(
		carrierValid && trackingValid && customCarrierNameValid && customTrackingUrlValid && noteValid
	);

	let sending = $state(false);
	let errorMsg = $state<string | null>(null);

	async function handleShare() {
		if (!canShare || sending) return;
		errorMsg = null;
		sending = true;
		try {
			const payload: ShipmentPayload = {
				v: 1,
				kind: 'morphit_shipment',
				carrier,
				tracking: tracking.trim()
			};
			if (carrier === 'other') {
				if (customCarrierName.trim())
					(payload as { customCarrierName?: string }).customCarrierName = customCarrierName.trim();
				if (customTrackingUrl.trim())
					(payload as { customTrackingUrl?: string }).customTrackingUrl = customTrackingUrl.trim();
			}
			if (note.trim()) (payload as { note?: string }).note = note.trim();
			if (orderPermlink) (payload as { orderPermlink?: string }).orderPermlink = orderPermlink;
			const encoded = encodeShipmentPayload(payload);
			await onShare(encoded);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
			sending = false;
		}
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="shipment-modal-title"
	onclick={(e) => {
		if (e.target === e.currentTarget) onCancel();
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') onCancel();
	}}
	tabindex="-1"
>
	<div
		class="max-h-[95dvh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl dark:bg-ink-900 sm:rounded-2xl sm:p-6"
	>
		<h2
			id="shipment-modal-title"
			class="font-display text-xl font-bold text-ink-900 dark:text-ink-50"
		>
			{$_('shipment_modal.heading')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('shipment_modal.intro')}
		</p>

		<!-- Always-shown safety tips -->
		<div
			class="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm dark:border-red-700 dark:bg-red-950/30"
			role="note"
		>
			<p class="font-semibold text-red-900 dark:text-red-200">
				{$_('shipment_modal.safety_heading')}
			</p>
			<ul class="mt-1 list-disc space-y-1 pl-5 text-red-800 dark:text-red-300">
				<li>{$_('shipment_modal.safety_insurance')}</li>
				<li>{$_('shipment_modal.safety_plain_envelope')}</li>
				<li>{$_('shipment_modal.safety_return_address')}</li>
				<li>{$_('shipment_modal.safety_tracking_optional')}</li>
			</ul>

			<!-- Cash-specific expander -->
			<button
				type="button"
				class="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-red-900 underline hover:no-underline dark:text-red-200"
				onclick={() => (cashTipsOpen = !cashTipsOpen)}
				aria-expanded={cashTipsOpen}
				aria-controls="shipment-cash-tips"
			>
				<span aria-hidden="true">{cashTipsOpen ? '▼' : '▶'}</span>
				{$_('shipment_modal.cash_tips_toggle')}
			</button>

			{#if cashTipsOpen}
				<div
					id="shipment-cash-tips"
					class="mt-2 rounded-md border border-red-400 bg-red-100 p-3 text-red-900 dark:border-red-600 dark:bg-red-950 dark:text-red-100"
				>
					<p class="font-semibold">{$_('shipment_modal.cash_heading')}</p>
					<ul class="mt-1 list-disc space-y-1 pl-5">
						<li>{$_('shipment_modal.cash_tinfoil')}</li>
						<li>{$_('shipment_modal.cash_ups_fedex_prohibit')}</li>
						<li>{$_('shipment_modal.cash_customs')}</li>
					</ul>
				</div>
			{/if}
		</div>

		<div class="mt-5 grid gap-4">
			<!-- Carrier dropdown -->
			<div>
				<label for="sh-carrier" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('shipment_modal.carrier_label')}
				</label>
				<select
					id="sh-carrier"
					bind:value={carrier}
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
				>
					<option value="">{$_('shipment_modal.carrier_placeholder')}</option>
					{#each CARRIERS as c (c.key)}
						<option value={c.key}>{c.name}</option>
					{/each}
				</select>
			</div>

			<!-- Custom carrier fields when 'other' selected -->
			{#if carrier === 'other'}
				<div
					class="rounded-lg border border-ink-200 bg-ink-50 p-3 dark:border-ink-700 dark:bg-ink-950"
				>
					<p class="text-xs font-semibold text-ink-700 dark:text-ink-200">
						{$_('shipment_modal.other_heading')}
					</p>
					<div class="mt-2 grid gap-3">
						<div>
							<label
								for="sh-custom-name"
								class="block text-xs font-semibold text-ink-600 dark:text-ink-300"
							>
								{$_('shipment_modal.custom_carrier_name_label')}
							</label>
							<input
								id="sh-custom-name"
								type="text"
								bind:value={customCarrierName}
								maxlength={SHIPMENT_LIMITS.customCarrierNameMax}
								class="mt-1 w-full rounded-md border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-900"
							/>
						</div>
						<div>
							<label
								for="sh-custom-url"
								class="block text-xs font-semibold text-ink-600 dark:text-ink-300"
							>
								{$_('shipment_modal.custom_tracking_url_label')}
								<span class="ml-1 font-normal text-ink-400"
									>{$_('shipment_modal.optional_marker')}</span
								>
							</label>
							<input
								id="sh-custom-url"
								type="url"
								placeholder="https://..."
								bind:value={customTrackingUrl}
								maxlength={SHIPMENT_LIMITS.customTrackingUrlMax}
								class="mt-1 w-full rounded-md border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-900"
							/>
							<p class="mt-1 text-xs text-ink-500">
								{$_('shipment_modal.custom_tracking_url_help')}
							</p>
						</div>
					</div>
				</div>
			{/if}

			<!-- Tracking number -->
			<div>
				<label for="sh-tracking" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('shipment_modal.tracking_label')}
				</label>
				<input
					id="sh-tracking"
					type="text"
					bind:value={tracking}
					minlength={SHIPMENT_LIMITS.trackingMin}
					maxlength={SHIPMENT_LIMITS.trackingMax}
					required
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-950"
				/>
				<p class="mt-1 text-xs text-ink-500">
					{$_('shipment_modal.tracking_help')}
				</p>
			</div>

			<!-- Note (optional) -->
			<div>
				<label for="sh-note" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('shipment_modal.note_label')}
					<span class="ml-1 font-normal text-ink-400">{$_('shipment_modal.optional_marker')}</span>
				</label>
				<textarea
					id="sh-note"
					bind:value={note}
					maxlength={SHIPMENT_LIMITS.noteMax}
					rows="2"
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
				></textarea>
			</div>

			{#if errorMsg}
				<div
					class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/30 dark:text-red-200"
					role="alert"
				>
					{errorMsg}
				</div>
			{/if}

			<div class="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
				<button
					type="button"
					onclick={onCancel}
					class="rounded-lg border border-ink-200 bg-white px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-ink-800"
				>
					{$_('common.cancel')}
				</button>
				<button
					type="button"
					onclick={handleShare}
					disabled={!canShare || sending}
					class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
				>
					{sending ? $_('common.sending') : $_('shipment_modal.share_button')}
				</button>
			</div>
		</div>
	</div>
</div>
