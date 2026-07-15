<script lang="ts">
	/**
	 * MailingAddressModal (cp121) — share a physical mailing
	 * address through the chat for cash-by-mail trades and any
	 * trade involving a physical-good shipment (barter_goods etc).
	 *
	 * This modal builds a structured `morphit_mailing_address` v1
	 * payload and sends it through the same chat-send path as a
	 * normal text message.  The recipient's ChatMessage component
	 * decodes the JSON payload and renders a copyable address pill.
	 *
	 * PRIVACY POSTURE
	 * ───────────────
	 * Physical mailing addresses are HIGHLY SENSITIVE PII.
	 *
	 *  - The full address stays in E2E-encrypted chat ONLY.  It is
	 *    NEVER written to the indexer / NEVER stored in chain ops /
	 *    NEVER federation-readable.  The chat envelope is opaque
	 *    to server infrastructure.
	 *
	 *  - The sender should consider their threat model: sharing a
	 *    physical address with a trade counterparty is irreversible
	 *    (they now know where you live or get mail).  Mitigations:
	 *    use a P.O. box, an Anytime Mailbox / iPostal1 virtual
	 *    address service, or a friend/family relay address.
	 *
	 *  - After the trade completes, both parties should consider
	 *    clearing the chat history for this conversation.  Morphit
	 *    chat doesn't auto-expire today (deferred follow-up).
	 *
	 * Validation happens at three layers:
	 *   1. Inline as the user types (send button disabled until valid).
	 *   2. encodeMailingAddressPayload, throws on bad input.
	 *   3. Recipient's decodePayload falls back to plaintext if off.
	 */

	import { _ } from 'svelte-i18n';
	import {
		encodeMailingAddressPayload,
		isValidCountryCode,
		MAILING_ADDRESS_LIMITS,
		type MailingAddressPayload
	} from '$lib/chat/payload';

	interface Props {
		/** Pre-filled order permlink — when opened from an order
		 *  context, this is passed through so the recipient can
		 *  associate the address with a specific trade. */
		orderPermlink?: string;
		/** Called with the encoded JSON payload string. */
		onShare: (payload: string) => Promise<void> | void;
		/** Called when user cancels. */
		onCancel: () => void;
	}

	let { orderPermlink, onShare, onCancel }: Props = $props();

	// Form state
	let country = $state('');
	let street = $state('');
	let street2 = $state('');
	let city = $state('');
	let state_ = $state(''); // `state` is a Svelte reserved-ish name
	let postalCode = $state('');
	let recipientName = $state('');
	let note = $state('');

	// ISO 3166-1 alpha-2 countries.  Top-15-by-Morphit-relevance + "Other"
	// shows free text.  Picker UI sorts alphabetically.  Full list
	// available via the "Type any 2-letter ISO country code" affordance.
	//
	// Conscious choice: don't bundle all 249 ISO countries in a giant
	// dropdown that grandma has to scroll through.  Show common ones
	// + accept any valid 2-letter code from a small input.
	const COMMON_COUNTRIES: ReadonlyArray<{ code: string; name: string }> = [
		{ code: 'AU', name: 'Australia' },
		{ code: 'CA', name: 'Canada' },
		{ code: 'CN', name: 'China' },
		{ code: 'DE', name: 'Germany' },
		{ code: 'ES', name: 'Spain' },
		{ code: 'FR', name: 'France' },
		{ code: 'GB', name: 'United Kingdom' },
		{ code: 'HK', name: 'Hong Kong' },
		{ code: 'IN', name: 'India' },
		{ code: 'IR', name: 'Iran' },
		{ code: 'IT', name: 'Italy' },
		{ code: 'JP', name: 'Japan' },
		{ code: 'PL', name: 'Poland' },
		{ code: 'RU', name: 'Russia' },
		{ code: 'US', name: 'United States' }
	];

	const countryValid = $derived(isValidCountryCode(country));
	const streetValid = $derived(
		street.length > 0 && street.length <= MAILING_ADDRESS_LIMITS.streetMax
	);
	const cityValid = $derived(city.length > 0 && city.length <= MAILING_ADDRESS_LIMITS.cityMax);
	const postalCodeValid = $derived(
		postalCode.length >= MAILING_ADDRESS_LIMITS.postalCodeMin &&
			postalCode.length <= MAILING_ADDRESS_LIMITS.postalCodeMax
	);
	const noteValid = $derived(note.length <= MAILING_ADDRESS_LIMITS.noteMax);
	const street2Valid = $derived(street2.length <= MAILING_ADDRESS_LIMITS.streetMax);
	const stateValid = $derived(state_.length <= MAILING_ADDRESS_LIMITS.stateMax);
	const recipientNameValid = $derived(
		recipientName.length <= MAILING_ADDRESS_LIMITS.recipientNameMax
	);

	const canShare = $derived(
		countryValid &&
			streetValid &&
			cityValid &&
			postalCodeValid &&
			noteValid &&
			street2Valid &&
			stateValid &&
			recipientNameValid
	);

	let sending = $state(false);
	let errorMsg = $state<string | null>(null);

	async function handleShare() {
		if (!canShare || sending) return;
		errorMsg = null;
		sending = true;
		try {
			const payload: MailingAddressPayload = {
				v: 1,
				kind: 'morphit_mailing_address',
				country: country.toUpperCase(),
				street: street.trim(),
				city: city.trim(),
				postalCode: postalCode.trim()
			};
			if (street2.trim()) (payload as { street2?: string }).street2 = street2.trim();
			if (state_.trim()) (payload as { state?: string }).state = state_.trim();
			if (recipientName.trim())
				(payload as { recipientName?: string }).recipientName = recipientName.trim();
			if (note.trim()) (payload as { note?: string }).note = note.trim();
			if (orderPermlink) (payload as { orderPermlink?: string }).orderPermlink = orderPermlink;
			const encoded = encodeMailingAddressPayload(payload);
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
	aria-labelledby="mailing-address-modal-title"
	onclick={(e) => {
		// Backdrop click → close.  Inner clicks stop propagation.
		if (e.target === e.currentTarget) onCancel();
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') onCancel();
	}}
	tabindex="-1"
>
	<div
		class="max-h-[95vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl dark:bg-ink-900 sm:rounded-2xl sm:p-6"
	>
		<h2
			id="mailing-address-modal-title"
			class="font-display text-xl font-bold text-ink-900 dark:text-ink-50"
		>
			{$_('mailing_address_modal.heading')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('mailing_address_modal.intro')}
		</p>

		<!-- Privacy aside — highly sensitive PII; user should
		     understand what they're sharing before they share. -->
		<div
			class="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm dark:border-red-700 dark:bg-red-950/30"
			role="note"
		>
			<p class="font-semibold text-red-900 dark:text-red-200">
				{$_('mailing_address_modal.privacy_heading')}
			</p>
			<ul class="mt-1 list-disc space-y-1 pl-5 text-red-800 dark:text-red-300">
				<li>{$_('mailing_address_modal.privacy_e2ee')}</li>
				<li>{$_('mailing_address_modal.privacy_irreversible')}</li>
				<li>{$_('mailing_address_modal.privacy_pobox_tip')}</li>
				<li>{$_('mailing_address_modal.privacy_clear_chat')}</li>
			</ul>
		</div>

		<div class="mt-5 grid gap-4">
			<!-- Country picker -->
			<div>
				<label for="ma-country" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('mailing_address_modal.country_label')}
				</label>
				<select
					id="ma-country"
					bind:value={country}
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
				>
					<option value="">{$_('mailing_address_modal.country_placeholder')}</option>
					{#each COMMON_COUNTRIES as c (c.code)}
						<option value={c.code}>{c.name} ({c.code})</option>
					{/each}
					<option value="__other__">{$_('mailing_address_modal.country_other')}</option>
				</select>
				{#if country === '__other__'}
					<input
						type="text"
						placeholder={$_('mailing_address_modal.country_iso_placeholder')}
						maxlength="2"
						bind:value={country}
						class="mt-2 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm uppercase dark:border-ink-700 dark:bg-ink-950"
					/>
				{/if}
				<p class="mt-1 text-xs text-ink-500">
					{$_('mailing_address_modal.country_help')}
				</p>
			</div>

			<!-- Recipient name (optional) -->
			<div>
				<label
					for="ma-recipient"
					class="block text-sm font-semibold text-ink-700 dark:text-ink-200"
				>
					{$_('mailing_address_modal.recipient_label')}
					<span class="ml-1 font-normal text-ink-400"
						>{$_('mailing_address_modal.optional_marker')}</span
					>
				</label>
				<input
					id="ma-recipient"
					type="text"
					bind:value={recipientName}
					maxlength={MAILING_ADDRESS_LIMITS.recipientNameMax}
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
				/>
				<p class="mt-1 text-xs text-ink-500">
					{$_('mailing_address_modal.recipient_help')}
				</p>
			</div>

			<!-- Street -->
			<div>
				<label for="ma-street" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('mailing_address_modal.street_label')}
				</label>
				<input
					id="ma-street"
					type="text"
					bind:value={street}
					maxlength={MAILING_ADDRESS_LIMITS.streetMax}
					required
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
				/>
			</div>

			<!-- Street 2 (optional) -->
			<div>
				<label for="ma-street2" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('mailing_address_modal.street2_label')}
					<span class="ml-1 font-normal text-ink-400"
						>{$_('mailing_address_modal.optional_marker')}</span
					>
				</label>
				<input
					id="ma-street2"
					type="text"
					bind:value={street2}
					maxlength={MAILING_ADDRESS_LIMITS.streetMax}
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
				/>
			</div>

			<!-- City + State + Postal in a responsive row -->
			<div class="grid gap-4 sm:grid-cols-3">
				<div>
					<label for="ma-city" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
						{$_('mailing_address_modal.city_label')}
					</label>
					<input
						id="ma-city"
						type="text"
						bind:value={city}
						maxlength={MAILING_ADDRESS_LIMITS.cityMax}
						required
						class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
					/>
				</div>
				<div>
					<label for="ma-state" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
						{$_('mailing_address_modal.state_label')}
						<span class="ml-1 font-normal text-ink-400"
							>{$_('mailing_address_modal.optional_marker')}</span
						>
					</label>
					<input
						id="ma-state"
						type="text"
						bind:value={state_}
						maxlength={MAILING_ADDRESS_LIMITS.stateMax}
						class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
					/>
				</div>
				<div>
					<label for="ma-postal" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
						{$_('mailing_address_modal.postal_label')}
					</label>
					<input
						id="ma-postal"
						type="text"
						bind:value={postalCode}
						maxlength={MAILING_ADDRESS_LIMITS.postalCodeMax}
						required
						class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
					/>
				</div>
			</div>

			<!-- Note (optional) -->
			<div>
				<label for="ma-note" class="block text-sm font-semibold text-ink-700 dark:text-ink-200">
					{$_('mailing_address_modal.note_label')}
					<span class="ml-1 font-normal text-ink-400"
						>{$_('mailing_address_modal.optional_marker')}</span
					>
				</label>
				<textarea
					id="ma-note"
					bind:value={note}
					maxlength={MAILING_ADDRESS_LIMITS.noteMax}
					rows="2"
					class="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-sm dark:border-ink-700 dark:bg-ink-950"
				></textarea>
				<p class="mt-1 text-xs text-ink-500">
					{$_('mailing_address_modal.note_help')}
				</p>
			</div>

			{#if errorMsg}
				<div
					class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/30 dark:text-red-200"
					role="alert"
				>
					{errorMsg}
				</div>
			{/if}

			<!-- Actions -->
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
					{sending ? $_('common.sending') : $_('mailing_address_modal.share_button')}
				</button>
			</div>
		</div>
	</div>
</div>
