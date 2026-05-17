<script lang="ts">
	/**
	 * AddressShareModal — share a BTC/XMR receiving address through
	 * the chat.
	 *
	 * This modal builds a structured payload (`morphit_addr` v1) and
	 * sends it through the same chat-send path as a normal text
	 * message.  The recipient's ChatMessage component decodes the
	 * JSON payload and renders an address pill instead of plaintext.
	 *
	 * Validation happens at three layers:
	 *
	 *   1. Inline as the user types — the Send button stays disabled
	 *      until isValidAddress(method, address) returns true.
	 *
	 *   2. encodeAddressPayload, which throws if anything fails
	 *      validation — defense in depth in case the inline check
	 *      missed a state transition.
	 *
	 *   3. The recipient's decodePayload, which falls back to
	 *      plaintext if anything is off — protects against a buggy
	 *      future sender or a tampered indexer.
	 *
	 * The sender's wallet does the final crypto-checksum verify
	 * when they actually broadcast funds — see payload.ts module
	 * header for why we don't do checksum verification here.
	 */

	import { _ } from 'svelte-i18n';
	import {
		encodeAddressPayload,
		generateBlurtMemo,
		isValidAddress,
		jitterMoneroAmount,
		PAYLOAD_CONSTANTS,
		type AddressPayload,
		type ChatAssetTicker
	} from '$lib/chat/payload';
	import { validateUsdtAddress, type UsdtNetwork } from '$lib/assets/networks';
	import PrivacyWarningChip from './PrivacyWarningChip.svelte';
	import UsdtNetworkPicker from './UsdtNetworkPicker.svelte';

	interface Props {
		/** Pre-filled order permlink — when the modal was opened
		 *  from an order page (or via ?order= query param), this is
		 *  passed through and rendered as "For order:" so the user
		 *  sees what trade they're sharing the address for. */
		orderPermlink?: string;
		/** Called with the encoded JSON payload string ready to be
		 *  sent through the normal chat-send path.  The parent
		 *  (ConversationView) wraps controller.sendMessage. */
		onShare: (payload: string) => Promise<void> | void;
		/** Called when the user cancels.  Modal closes; no message
		 *  sent. */
		onCancel: () => void;
	}

	let { orderPermlink, onShare, onCancel }: Props = $props();

	/** Selected payment method.  Tab UI; default BTC because
	 *  Morphit's expected most-common pair is BLURT↔BTC. */
	let method = $state<ChatAssetTicker>('btc');
	let address = $state('');
	let amount = $state('');
	let note = $state('');
	/** Part 121 — USDT sub-network (ERC-20/TRC-20/SPL/BEP-20).
	 *  Null when method !== 'usdt' OR when user hasn't picked
	 *  yet.  When method === 'usdt', the form REQUIRES a non-null
	 *  network before canSubmit goes true.  Per-network address
	 *  validation runs against the specific network's regex
	 *  (TRC-20 starts with T, ERC-20/BEP-20 are 0x+40-hex, SPL
	 *  is base58 32-44 chars). */
	let usdtNetwork = $state<UsdtNetwork | null>(null);
	/** Phase F.4 — BLURT payment memo.  Auto-generated when the
	 *  seller opens the modal with the BLURT tab selected (or
	 *  switches to it).  Lets them match incoming transfers to
	 *  this specific trade even if other unrelated transfers
	 *  arrive at the same time.  Random and opaque — leaks no
	 *  trade-identifying info to public-chain observers. */
	let memo = $state('');
	/** Whether to include the memo in the shared payload.  Default
	 *  ON; off lets the seller opt out for trades where they
	 *  explicitly don't want matching support. */
	let useMemo = $state(true);

	/** Q5 — privacy: randomize Monero amount.  Default ON for XMR.
	 *  Adds up to 999_999 piconero (~1 microXMR ≈ trivial cost) of
	 *  random low-order digits to the typed amount, defeating
	 *  amount-correlation attacks on the Monero chain.  See
	 *  jitterMoneroAmount in payload.ts for the mechanism, and
	 *  openmonero.com/knowledge/how-bad-actors-try-to-track-monero
	 *  for the threat. */
	let jitterXmr = $state(true);
	/** Memoized jittered amount.  Recomputed each time the user
	 *  edits the amount or toggles jitter; held stable so re-
	 *  rendering the preview doesn't re-roll the random low-order
	 *  digits (which would be confusing — the user expects the
	 *  number they see to be the number that gets sent). */
	let xmrJitteredAmount = $state<string | null>(null);
	$effect(() => {
		if (
			method !== 'xmr' ||
			!jitterXmr ||
			amount.trim() === '' ||
			!/^\d{1,12}(?:\.\d{1,12})?$/.test(amount.trim())
		) {
			xmrJitteredAmount = null;
			return;
		}
		try {
			xmrJitteredAmount = jitterMoneroAmount(amount.trim());
		} catch {
			xmrJitteredAmount = null;
		}
	});

	/** Auto-generate the memo the first time the user lands on
	 *  the BLURT tab with useMemo enabled and no memo yet.  Don't
	 *  regenerate automatically on subsequent triggers — once a
	 *  user sees a specific token, regenerating mid-flow would
	 *  be confusing.  A "Regenerate" button is provided for the
	 *  rare case where they want a fresh one. */
	$effect(() => {
		if (method === 'blurt' && useMemo && memo === '') {
			memo = generateBlurtMemo();
		}
	});

	function regenerateMemo(): void {
		memo = generateBlurtMemo();
	}
	let sending = $state(false);
	let sendError = $state<string | null>(null);

	const trimmedAddress = $derived(address.trim());
	const trimmedAmount = $derived(amount.trim());
	const trimmedNote = $derived(note.trim());

	const addressLooksValid = $derived(
		trimmedAddress.length > 0 &&
			(method === 'usdt'
				? usdtNetwork !== null && validateUsdtAddress(usdtNetwork, trimmedAddress)
				: isValidAddress(method, trimmedAddress))
	);
	/** Amount is OPTIONAL.  Empty is fine.  Non-empty must be a
	 *  valid positive decimal. */
	const amountLooksValid = $derived(
		trimmedAmount.length === 0 || /^\d{1,12}(?:\.\d{1,12})?$/.test(trimmedAmount)
	);
	const noteLooksValid = $derived(trimmedNote.length <= PAYLOAD_CONSTANTS.MAX_NOTE_LEN);

	/** USDT-specific gate: network MUST be picked.  No default
	 *  network — cross-network sends lose funds, so the form
	 *  refuses to submit until the user explicitly chooses. */
	const usdtNetworkPicked = $derived(method !== 'usdt' || usdtNetwork !== null);

	const canSubmit = $derived(
		addressLooksValid &&
			amountLooksValid &&
			noteLooksValid &&
			usdtNetworkPicked &&
			!sending
	);

	/** Address-error inline message.  Empty when the address looks
	 *  valid OR is empty.  Showing an error pre-emptively (before
	 *  the user has typed enough chars) is jarring, so only flag
	 *  invalid AFTER they've typed something substantial.  BLURT
	 *  account names are short (3-16 chars) so the threshold is
	 *  lower than for BTC/XMR. */
	const addressErrorKey = $derived.by(() => {
		if (trimmedAddress.length === 0) return null;
		// Method-aware "still typing" threshold.
		const minTyped = method === 'blurt' ? 3 : 10;
		if (trimmedAddress.length < minTyped) return null;
		if (addressLooksValid) return null;
		if (method === 'btc') return 'chat.address.address_invalid_btc';
		if (method === 'xmr') return 'chat.address.address_invalid_xmr';
		if (method === 'usdt') return 'chat.address.address_invalid_usdt';
		if (method === 'bch') return 'chat.address.address_invalid_bch';
		return 'chat.address.address_invalid_blurt';
	});

	/** Phase F.3 — soft subaddress nudge.  XMR addresses starting
	 *  with `4` (standard or integrated) reuse the same view-key
	 *  anchor across receipts; subaddresses (`8...`) break that
	 *  link.  We display a non-blocking tip when the user pastes a
	 *  valid `4...` XMR address, encouraging them to use a
	 *  subaddress instead.  Hard-blocking would be paternalistic
	 *  and break legitimate use cases (e.g. integrated addresses
	 *  for businesses that legitimately want correlatable receipts
	 *  per customer). */
	const showSubaddressTip = $derived(
		method === 'xmr' && addressLooksValid && trimmedAddress.startsWith('4')
	);

	function selectMethod(m: ChatAssetTicker): void {
		method = m;
		// Don't clear address — user may have pasted XMR while BTC
		// was selected, the validator will catch the mismatch.
		// Part 121: when leaving USDT, drop the pinned network so
		// a future re-pick of USDT forces a fresh explicit choice
		// (no stale value).  Each USDT trade gets a deliberate
		// network commit.
		if (m !== 'usdt') usdtNetwork = null;
	}

	async function handleSubmit(): Promise<void> {
		if (!canSubmit) return;
		sending = true;
		sendError = null;
		try {
			// Q5 — if XMR jitter is enabled and we have a valid
			// jittered amount, send that as the payload.amount; the
			// buyer's wallet will pre-fill it from the QR/payload and
			// the on-chain transfer will carry the jittered value.
			// We use the memoized $state rather than re-calling
			// jitterMoneroAmount so the preview the user saw IS the
			// amount that gets sent (no re-roll between preview and
			// submit).
			const finalAmount =
				method === 'xmr' && jitterXmr && xmrJitteredAmount !== null
					? xmrJitteredAmount
					: trimmedAmount.length > 0
						? trimmedAmount
						: undefined;
			const payload: AddressPayload = {
				v: 1,
				kind: 'morphit_addr',
				method,
				address: trimmedAddress,
				...(finalAmount !== undefined ? { amount: finalAmount } : {}),
				...(orderPermlink !== undefined ? { orderPermlink } : {}),
				...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
				// Phase F.4 — BLURT-only memo for matching incoming
				// transfers.  Only attach when method is blurt AND
				// the user hasn't toggled it off.  The memo is
				// generated client-side; encodeAddressPayload validates
				// the shape one more time as defense in depth.
				...(method === 'blurt' && useMemo && memo !== '' ? { memo } : {}),
				// Part 121 — pin the USDT network on the message
				// itself.  The receiver renders "Tron (TRC-20) USDT
				// address:" as the bold header so cross-network
				// confusion is impossible.  Validated above by the
				// addressLooksValid + usdtNetworkPicked gates.
				...(method === 'usdt' && usdtNetwork !== null ? { network: usdtNetwork } : {})
			};
			const wire = encodeAddressPayload(payload);
			await onShare(wire);
		} catch (err) {
			console.warn('[AddressShareModal] send failed:', err);
			sendError = $_('chat.address.send_failed');
			sending = false;
		}
	}

	// Part 73: dismiss UX parity with PayBlurtModal — Escape and
	// backdrop-click both close.  Pre-fix the modal could only be
	// dismissed via the explicit Cancel button.
	function onBackdropClick(e: MouseEvent): void {
		if (sending) return;
		if (e.target === e.currentTarget) onCancel();
	}

	function onModalKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape' && !sending) onCancel();
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="address-share-heading"
	onclick={onBackdropClick}
	onkeydown={onModalKeydown}
	tabindex="-1"
>
	<div class="card w-full max-w-md">
		<h2 id="address-share-heading" class="font-display text-xl font-bold">
			{$_('chat.address.modal_title')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('chat.address.modal_subtitle')}
		</p>

		<!-- Method tabs -->
		<div class="mt-5 flex gap-2" role="tablist">
			<button
				type="button"
				role="tab"
				aria-selected={method === 'btc'}
				class="flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition {method ===
				'btc'
					? 'border-morphit-emerald bg-morphit-emerald/10 text-morphit-emerald'
					: 'border-ink-200 hover:border-ink-300 dark:border-ink-700 dark:hover:border-ink-600'}"
				onclick={() => selectMethod('btc')}
			>
				{$_('chat.address.method_btc')}
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={method === 'xmr'}
				class="flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition {method ===
				'xmr'
					? 'border-morphit-emerald bg-morphit-emerald/10 text-morphit-emerald'
					: 'border-ink-200 hover:border-ink-300 dark:border-ink-700 dark:hover:border-ink-600'}"
				onclick={() => selectMethod('xmr')}
			>
				{$_('chat.address.method_xmr')}
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={method === 'blurt'}
				class="flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition {method ===
				'blurt'
					? 'border-morphit-emerald bg-morphit-emerald/10 text-morphit-emerald'
					: 'border-ink-200 hover:border-ink-300 dark:border-ink-700 dark:hover:border-ink-600'}"
				onclick={() => selectMethod('blurt')}
			>
				{$_('chat.address.method_blurt')}
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={method === 'usdt'}
				class="flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition {method ===
				'usdt'
					? 'border-morphit-emerald bg-morphit-emerald/10 text-morphit-emerald'
					: 'border-ink-200 hover:border-ink-300 dark:border-ink-700 dark:hover:border-ink-600'}"
				onclick={() => selectMethod('usdt')}
			>
				{$_('chat.address.method_usdt')}
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={method === 'bch'}
				class="flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition {method ===
				'bch'
					? 'border-morphit-emerald bg-morphit-emerald/10 text-morphit-emerald'
					: 'border-ink-200 hover:border-ink-300 dark:border-ink-700 dark:hover:border-ink-600'}"
				onclick={() => selectMethod('bch')}
			>
				{$_('chat.address.method_bch')}
			</button>
		</div>

		<!-- Part 121 — USDT privacy warning + network picker.
		     Renders only when USDT is the active tab.  Sits ABOVE
		     the address input so users see the warning + commit
		     to a network before pasting an address (form
		     validates against the picked network's regex). -->
		{#if method === 'usdt'}
			<div class="mt-4">
				<PrivacyWarningChip privacyWarningKey="usdt_centralized" />
				<div class="mt-3">
					<UsdtNetworkPicker bind:network={usdtNetwork} disabled={sending} />
				</div>
			</div>
		{/if}

		{#if orderPermlink}
			<div
				class="mt-4 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-xs text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
			>
				<span class="font-semibold">{$_('chat.address.pill_for_order')}:</span>
				<code class="ml-1 break-all font-mono">{orderPermlink}</code>
			</div>
		{/if}

		<!-- Address input -->
		<label class="mt-5 block">
			<span class="text-sm font-semibold">{$_('chat.address.address_label')}</span>
			<input
				type="text"
				bind:value={address}
				placeholder={method === 'btc'
					? ($_('chat.address.address_placeholder_btc') as string)
					: method === 'xmr'
						? ($_('chat.address.address_placeholder_xmr') as string)
						: method === 'usdt'
							? ($_('chat.address.address_placeholder_usdt') as string)
							: method === 'bch'
								? ($_('chat.address.address_placeholder_bch') as string)
								: ($_('chat.address.address_placeholder_blurt') as string)}
				autocomplete="off"
				autocapitalize="none"
				autocorrect="off"
				spellcheck="false"
				class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-900"
			/>
			{#if addressErrorKey}
				<p class="mt-1 text-xs text-red-600 dark:text-red-400">
					{$_(addressErrorKey)}
				</p>
			{/if}
			{#if showSubaddressTip}
				<div
					class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
				>
					{$_('chat.address.subaddress_tip_modal')}
				</div>
			{/if}
		</label>

		{#if method === 'blurt'}
			<!-- Phase F.4 — BLURT payment memo.  Auto-generated for
			     this trade so the seller can match incoming transfers
			     even if other unrelated BLURT lands in their account
			     at the same time.  Random + opaque — does NOT leak
			     trade-identifying info to public-chain observers. -->
			<div class="mt-4 rounded-lg border border-morphit-emerald/40 bg-morphit-emerald/5 p-3">
				<div class="flex items-baseline justify-between gap-2">
					<span class="text-sm font-semibold">
						{$_('chat.address.memo_label')}
					</span>
					{#if useMemo}
						<button
							type="button"
							class="text-xs font-semibold text-morphit-emerald hover:underline"
							onclick={regenerateMemo}
						>
							{$_('chat.address.memo_regenerate')}
						</button>
					{/if}
				</div>
				{#if useMemo}
					<code
						class="mt-2 block rounded-md bg-black/10 px-3 py-2 text-center font-mono text-base tracking-widest dark:bg-black/30"
					>
						{memo}
					</code>
					<p class="mt-2 text-xs text-ink-600 dark:text-ink-300">
						{$_('chat.address.memo_explain')}
					</p>
				{/if}
				<label class="mt-2 flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={!useMemo}
						onchange={(e) => {
							useMemo = !(e.currentTarget as HTMLInputElement).checked;
						}}
						class="h-3.5 w-3.5"
					/>
					<span class="text-ink-600 dark:text-ink-300">
						{$_('chat.address.memo_skip')}
					</span>
				</label>
			</div>
		{/if}

		<!-- Amount input (optional) -->
		<label class="mt-4 block">
			<span class="text-sm font-semibold">{$_('chat.address.amount_label')}</span>
			<input
				type="text"
				bind:value={amount}
				inputmode="decimal"
				autocomplete="off"
				class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-900"
			/>
			{#if !amountLooksValid && trimmedAmount.length > 0}
				<p class="mt-1 text-xs text-red-600 dark:text-red-400">
					{$_('chat.address.amount_invalid')}
				</p>
			{/if}
		</label>

		<!-- Q5 — XMR amount-jitter toggle.  Defeats amount-correlation
		     attacks on the Monero chain (see openmonero.com guide on
		     bad-actor tracking).  Default ON; cost is up to ~1
		     microXMR (~$0.0002 at typical XMR price).
		     Sally finding L13 (Part 68): copy made explicit in BOTH
		     ON and OFF states — when ON, show the exact 12-decimal
		     value the buyer's wallet should send; when OFF, show a
		     visible warning that the round amount is what's being
		     shared (the user opted out of privacy, that's the
		     consequence). -->
		{#if method === 'xmr' && trimmedAmount.length > 0 && amountLooksValid}
			<div class="mt-2 rounded-lg border border-morphit-emerald/40 bg-morphit-emerald/5 p-3">
				<label class="flex items-start gap-2 text-sm">
					<input type="checkbox" bind:checked={jitterXmr} class="mt-0.5 h-4 w-4" />
					<span class="flex-1">
						<span class="font-semibold">
							🔐 {$_('chat.address.xmr_jitter_label')}
						</span>
						<span class="block text-xs text-ink-600 dark:text-ink-300">
							{$_('chat.address.xmr_jitter_explain')}
						</span>
					</span>
				</label>
				{#if jitterXmr && xmrJitteredAmount !== null}
					<div
						class="mt-2 rounded-md border border-morphit-emerald/30 bg-white p-2 dark:bg-ink-950"
					>
						<div class="text-xs font-semibold text-morphit-emerald">
							✓ {$_('chat.address.xmr_jitter_will_send')}
						</div>
						<code class="mt-1 block break-all font-mono text-sm font-bold">
							{xmrJitteredAmount} XMR
						</code>
						<p class="mt-1 text-[11px] text-ink-500 dark:text-ink-500">
							{$_('chat.address.xmr_jitter_send_exact_hint')}
						</p>
					</div>
				{:else if !jitterXmr}
					<div
						class="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950"
					>
						<div class="text-xs font-semibold text-amber-900 dark:text-amber-200">
							⚠ {$_('chat.address.xmr_jitter_off_warning_heading')}
						</div>
						<p class="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
							{$_('chat.address.xmr_jitter_off_warning_body')}
						</p>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Note input (optional) -->
		<label class="mt-4 block">
			<span class="text-sm font-semibold">{$_('chat.address.note_label')}</span>
			<input
				type="text"
				bind:value={note}
				placeholder={$_('chat.address.note_placeholder') as string}
				maxlength={PAYLOAD_CONSTANTS.MAX_NOTE_LEN + 1}
				class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
			/>
			{#if !noteLooksValid}
				<p class="mt-1 text-xs text-red-600 dark:text-red-400">
					{$_('chat.address.note_too_long')}
				</p>
			{/if}
		</label>

		<!-- Verify warning -->
		<div
			class="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
		>
			{$_('chat.address.verify_warning')}
		</div>

		{#if sendError}
			<p class="mt-3 text-sm text-red-600 dark:text-red-400">{sendError}</p>
		{/if}

		<div class="mt-5 flex justify-end gap-2">
			<button
				type="button"
				class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
				onclick={onCancel}
				disabled={sending}
			>
				{$_('chat.address.cancel')}
			</button>
			<button
				type="button"
				class="hover:bg-morphit-emerald-dark rounded-lg bg-morphit-emerald px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
				onclick={handleSubmit}
				disabled={!canSubmit}
			>
				{$_('chat.address.send')}
			</button>
		</div>
	</div>
</div>
