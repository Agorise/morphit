<script lang="ts">
	/**
	 * FundsSentModal — record that the user sent crypto for a trade.
	 *
	 * Companion to AddressShareModal.  After a user has received the
	 * counterparty's receiving address and broadcast an actual on-
	 * chain payment with their own wallet, they tell their trade
	 * partner "I sent it; here's the txid."  This modal builds a
	 * `morphit_funds_sent` v1 payload and sends it through the
	 * normal chat send path.
	 *
	 * Validation is lighter than AddressShareModal — the txid is a
	 * 64-hex string, that's it.  We don't try to look up the txid
	 * on the chain (would require a BTC/XMR RPC dependency we
	 * don't ship; counterparty's own wallet/explorer will do that).
	 *
	 * The recipient's ChatMessage decodes the payload and renders
	 * a "Bitcoin sent" / "Monero sent" pill with the txid and a
	 * "View on explorer" link via explorerLinkForTxid (BTC →
	 * mempool.space, XMR → xmrchain.net, BLURT → /explorer).
	 */

	import { _ } from 'svelte-i18n';
	import {
		encodeFundsSentPayload,
		isValidTxid,
		PAYLOAD_CONSTANTS,
		type FundsSentPayload,
		type ChatAssetTicker
	} from '$lib/chat/payload';
	import { validateUsdtTxid, isUsdtNetwork, type UsdtNetwork } from '$lib/assets/networks';
	import UsdtNetworkPicker from './UsdtNetworkPicker.svelte';

	interface Props {
		/** Initial method tab.  Pre-selected when the modal was
		 *  triggered from a received address pill (we know the
		 *  method); free-choice when launched from the composer
		 *  without context. */
		initialMethod?: ChatAssetTicker;
		/** Part 121 — initial USDT network.  When the modal is
		 *  triggered from a received USDT address pill, the
		 *  network is already pinned and the picker is read-only
		 *  so the buyer can't accidentally pick a different one. */
		initialUsdtNetwork?: UsdtNetwork | null;
		/** Q5 — Initial amount, pre-filled when the modal was
		 *  triggered from an incoming BTC/XMR address pill that
		 *  carried an amount. The buyer types the txid; the
		 *  amount field starts populated with whatever the seller
		 *  asked for (which, for jittered XMR amounts, is the
		 *  exact 12-decimal value the buyer's wallet should have
		 *  sent). User can still edit if they paid a different
		 *  value. */
		initialAmount?: string;
		/** Pre-filled order permlink, same role as in
		 *  AddressShareModal. */
		orderPermlink?: string;
		/** Called with the encoded JSON payload. */
		onShare: (payload: string) => Promise<void> | void;
		/** Called when the user cancels. */
		onCancel: () => void;
	}

	let {
		initialMethod = 'btc',
		initialUsdtNetwork = null,
		initialAmount = '',
		orderPermlink,
		onShare,
		onCancel
	}: Props = $props();

	// Modal state initialized from props on first paint.  The
	// modal mounts when triggered, captures current prop values,
	// and dismisses after submit/cancel — there is no flow where
	// the parent updates these props while the modal is open.
	// svelte-ignore state_referenced_locally
	let method = $state<ChatAssetTicker>(initialMethod);
	// svelte-ignore state_referenced_locally
	let usdtNetwork = $state<UsdtNetwork | null>(initialUsdtNetwork);
	// True if the parent pinned a USDT network up front (came
	// from an address pill).  Locks the picker as read-only so
	// the buyer can't accidentally pick a different network.
	const networkPinned = initialUsdtNetwork !== null;
	let txid = $state('');
	// svelte-ignore state_referenced_locally
	let amount = $state(initialAmount);
	let note = $state('');
	let sending = $state(false);
	let sendError = $state<string | null>(null);

	const trimmedTxid = $derived(txid.trim().toLowerCase());
	const trimmedAmount = $derived(amount.trim());
	const trimmedNote = $derived(note.trim());

	const txidLooksValid = $derived(
		trimmedTxid.length > 0 &&
			(method === 'usdt'
				? usdtNetwork !== null && validateUsdtTxid(usdtNetwork, trimmedTxid)
				: isValidTxid(method, trimmedTxid))
	);
	const amountLooksValid = $derived(
		trimmedAmount.length === 0 || /^\d{1,12}(?:\.\d{1,12})?$/.test(trimmedAmount)
	);
	const noteLooksValid = $derived(trimmedNote.length <= PAYLOAD_CONSTANTS.MAX_NOTE_LEN);

	/** USDT-specific gate: network must be picked. */
	const usdtNetworkPicked = $derived(method !== 'usdt' || usdtNetwork !== null);

	const canSubmit = $derived(
		txidLooksValid && amountLooksValid && noteLooksValid && usdtNetworkPicked && !sending
	);

	const txidError = $derived.by(() => {
		if (trimmedTxid.length === 0) return null;
		// BLURT txids are 40 hex chars; BTC/XMR/BCH are 64; USDT
		// varies by network (32-88 chars depending on chain).
		const minTyped = method === 'blurt' ? 20 : 32;
		if (trimmedTxid.length < minTyped) return null;
		if (txidLooksValid) return null;
		if (method === 'usdt') return 'chat.funds_sent.txid_invalid_usdt';
		return 'chat.funds_sent.txid_invalid';
	});

	function selectMethod(m: ChatAssetTicker): void {
		method = m;
		// Part 121: clear the picked network when leaving USDT.
		// On re-pick, the user must explicitly choose again.
		// Don't clear when networkPinned — the parent pinned it
		// for a reason.
		if (m !== 'usdt' && !networkPinned) usdtNetwork = null;
	}

	// Part 73: bring dismiss UX up to parity with the sibling
	// PayBlurtModal — Escape and backdrop-click both close.
	// Pre-fix the modal could only be dismissed via the explicit
	// Cancel button.
	function onBackdropClick(e: MouseEvent): void {
		// Don't dismiss while the share is in flight — the parent
		// is mid-broadcast and a stray backdrop click shouldn't
		// abort.  PayBlurtModal applies the same gate.
		if (sending) return;
		if (e.target === e.currentTarget) onCancel();
	}

	function onModalKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape' && !sending) onCancel();
	}

	async function handleSubmit(): Promise<void> {
		if (!canSubmit) return;
		sending = true;
		sendError = null;
		try {
			const payload: FundsSentPayload = {
				v: 1,
				kind: 'morphit_funds_sent',
				method,
				txid: trimmedTxid,
				...(trimmedAmount.length > 0 ? { amount: trimmedAmount } : {}),
				...(orderPermlink !== undefined ? { orderPermlink } : {}),
				...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
				// Part 121 — pin the USDT network on the message
				// so the receiver's chat renders the right
				// per-network explorer link.
				...(method === 'usdt' && usdtNetwork !== null ? { network: usdtNetwork } : {})
			};
			const wire = encodeFundsSentPayload(payload);
			await onShare(wire);
		} catch (err) {
			console.warn('[FundsSentModal] send failed:', err);
			sendError = $_('chat.funds_sent.send_failed');
			sending = false;
		}
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="funds-sent-heading"
	onclick={onBackdropClick}
	onkeydown={onModalKeydown}
	tabindex="-1"
>
	<div class="card w-full max-w-md">
		<h2 id="funds-sent-heading" class="font-display text-xl font-bold">
			{$_('chat.funds_sent.modal_title')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('chat.funds_sent.modal_subtitle')}
		</p>

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
			<button
				type="button"
				role="tab"
				aria-selected={method === 'ltc'}
				class="flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition {method ===
				'ltc'
					? 'border-morphit-emerald bg-morphit-emerald/10 text-morphit-emerald'
					: 'border-ink-200 hover:border-ink-300 dark:border-ink-700 dark:hover:border-ink-600'}"
				onclick={() => selectMethod('ltc')}
			>
				{$_('chat.address.method_ltc')}
			</button>
		</div>

		<!-- Part 121 — USDT network picker.  When the parent
		     pinned a network (came from an address pill we
		     received), the picker is read-only so the buyer
		     can't accidentally pick a different one and tell
		     the seller they sent USDT on the wrong chain. -->
		{#if method === 'usdt'}
			<div class="mt-4">
				{#if networkPinned && usdtNetwork !== null}
					<div
						class="rounded-lg border-2 border-morphit-emerald bg-morphit-emerald/5 p-3 text-sm"
						role="note"
					>
						<div class="font-semibold text-morphit-emerald">
							{$_(`assets.usdt.network.${usdtNetwork}.displayName`)}
						</div>
						<div class="mt-1 text-xs text-ink-300">
							{$_('chat.funds_sent.network_pinned_hint')}
						</div>
					</div>
				{:else}
					<UsdtNetworkPicker bind:network={usdtNetwork} disabled={sending} />
				{/if}
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

		<label class="mt-5 block">
			<span class="text-sm font-semibold">{$_('chat.funds_sent.txid_label')}</span>
			<input
				type="text"
				bind:value={txid}
				placeholder={$_('chat.funds_sent.txid_placeholder') as string}
				autocomplete="off"
				autocapitalize="none"
				autocorrect="off"
				spellcheck="false"
				class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-xs dark:border-ink-700 dark:bg-ink-900"
			/>
			<!-- Sally finding S-11 (Part 119): label says "Transaction ID"
			     which is jargon to a grandma who's never sent crypto.  Inline
			     help explains where to find it (Memory #21: teach jargon
			     inline).  Always rendered — even experienced users don't
			     mind one line of context, and it keeps the height stable
			     across error/no-error states. -->
			<p class="mt-1 text-xs text-ink-600 dark:text-ink-300">
				{$_('chat.funds_sent.txid_help')}
			</p>
			{#if txidError}
				<p class="mt-1 text-xs text-red-600 dark:text-red-400">
					{$_(txidError)}
				</p>
			{/if}
		</label>

		<label class="mt-4 block">
			<span class="text-sm font-semibold">{$_('chat.funds_sent.amount_label')}</span>
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

		<label class="mt-4 block">
			<span class="text-sm font-semibold">{$_('chat.address.note_label')}</span>
			<input
				type="text"
				bind:value={note}
				maxlength={PAYLOAD_CONSTANTS.MAX_NOTE_LEN + 1}
				class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
			/>
			{#if !noteLooksValid}
				<p class="mt-1 text-xs text-red-600 dark:text-red-400">
					{$_('chat.address.note_too_long')}
				</p>
			{/if}
		</label>

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
				{$_('chat.funds_sent.cancel')}
			</button>
			<button
				type="button"
				class="hover:bg-morphit-emerald-dark rounded-lg bg-morphit-emerald px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
				onclick={handleSubmit}
				disabled={!canSubmit}
			>
				{$_('chat.funds_sent.send')}
			</button>
		</div>
	</div>
</div>
