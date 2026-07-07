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
	 * on the chain (would require a per-asset RPC dependency we
	 * don't ship for any of the external chains; the counterparty's
	 * own wallet/explorer will do that).
	 *
	 * The recipient's ChatMessage decodes the payload and renders
	 * a per-asset "X sent" pill with the txid and a "View on
	 * explorer" link via explorerLinkForTxid (BTC → mempool.space,
	 * XMR → xmrchain.net, BCH/LTC/DASH/USDT → per-asset external
	 * explorers, BLURT → /explorer).
	 */

	import { _ } from 'svelte-i18n';
	import {
		encodeFundsSentPayload,
		isValidTxid,
		PAYLOAD_CONSTANTS,
		type FundsSentPayload,
		type ChatAssetTicker
	} from '$lib/chat/payload';
	import {
		validateUsdtTxid,
		isUsdtNetwork,
		type UsdtNetwork,
		validateUsdcTxid,
		isUsdcNetwork,
		type UsdcNetwork,
		validateDaiTxid,
		isDaiNetwork,
		type DaiNetwork
	} from '$lib/assets/networks';
	import UsdtNetworkPicker from './UsdtNetworkPicker.svelte';
	import UsdcNetworkPicker from './UsdcNetworkPicker.svelte';
	import DaiNetworkPicker from './DaiNetworkPicker.svelte';

	interface Props {
		/** Initial method tab.  Pre-selected when the modal was
		 *  triggered from a received address pill (we know the
		 *  method); free-choice when launched from the composer
		 *  without context. */
		initialMethod?: ChatAssetTicker;
		/** cp402 [7a] — when set, the asset is LOCKED to this ticker
		 *  (the modal was opened from the composer "Pay now" about an
		 *  order, so the coin is fixed to the order's asset). The method
		 *  picker is replaced by a read-only "Paying with X" line so the
		 *  user (grandma) can't accidentally send the wrong coin. */
		lockedMethod?: ChatAssetTicker;
		/** cp402 [7a] — when true, the amount is REQUIRED (not optional):
		 *  the send stays disabled until a valid positive number is
		 *  entered. Set for the composer "Pay now" flow. */
		amountRequired?: boolean;
		/** Part 121 — initial USDT network.  When the modal is
		 *  triggered from a received USDT address pill, the
		 *  network is already pinned and the picker is read-only
		 *  so the buyer can't accidentally pick a different one. */
		initialUsdtNetwork?: UsdtNetwork | null;
		/** Part 122 cp30 — initial USDC network.  Same role as
		 *  initialUsdtNetwork: pre-pins the network when the modal
		 *  is launched from a received USDC address pill so the
		 *  buyer cannot accidentally pick a different chain when
		 *  reporting the txid. */
		initialUsdcNetwork?: UsdcNetwork | null;
		/** Part 122 cp31 — initial DAI network.  Same role as
		 *  initialUsdtNetwork and initialUsdcNetwork: pre-pins the
		 *  network when the modal is launched from a received DAI
		 *  address pill so the buyer cannot accidentally pick a
		 *  different chain when reporting the txid.  DAI is the
		 *  multi-network asset where this matters MOST because all
		 *  4 networks share the EVM 0x address format. */
		initialDaiNetwork?: DaiNetwork | null;
		/** Q5 — Initial amount, pre-filled when the modal was
		 *  triggered from an incoming external-asset address pill
		 *  (BTC/XMR/USDT/USDC/DAI/BCH/LTC/DASH) that carried an amount.
		 *  The buyer types the txid; the amount field starts
		 *  populated with whatever the seller asked for (which,
		 *  for jittered XMR/UTXO/stablecoin amounts, is the exact
		 *  value the buyer's wallet should have sent). User can
		 *  still edit if they paid a different value. */
		initialAmount?: string;
		/** Pre-filled order permlink, same role as in
		 *  AddressShareModal. */
		orderPermlink?: string;
		/** cp406 — the counterparty's account name, for grandma-clear,
		 *  peer-aware modal titles ("Confirm your payment to @peer"). */
		peer: string;
		/** Called with the encoded JSON payload. */
		onShare: (payload: string) => Promise<void> | void;
		/** Called when the user cancels. */
		onCancel: () => void;
		/** cp406 — optional one-line caption under the amount field explaining a
		 *  pre-filled amount (the order's fiat minimum + its crypto equivalent).
		 *  Empty string renders nothing. */
		payHint?: string;
		/** cp425 — restrict the method tabs to this set (a BARTER order's
		 *  accepted_assets). Undefined → all methods. Ignored when
		 *  `lockedMethod` is set (the tabs aren't shown then). */
		allowedMethods?: readonly ChatAssetTicker[];
	}

	let {
		initialMethod = 'btc',
		lockedMethod = undefined,
		amountRequired = false,
		initialUsdtNetwork = null,
		initialUsdcNetwork = null,
		initialDaiNetwork = null,
		initialAmount = '',
		orderPermlink,
		peer,
		onShare,
		onCancel,
		payHint = '',
		allowedMethods
	}: Props = $props();

	/** cp425 — every method tab in on-screen order; `visibleMethods` filters
	 *  it to `allowedMethods` when the modal is restricted (barter). */
	const ALL_METHODS: readonly ChatAssetTicker[] = [
		'btc',
		'xmr',
		'blurt',
		'usdt',
		'usdc',
		'dai',
		'bch',
		'ltc',
		'dash',
		'doge',
		'zec',
		'arrr',
		'dcr',
		'sol',
		'eth',
		'xrp'
	];
	const visibleMethods = $derived(
		allowedMethods && allowedMethods.length > 0
			? ALL_METHODS.filter((m) => allowedMethods.includes(m))
			: ALL_METHODS
	);

	/** cp402 [7a] — is the asset locked to the order's asset? Computed
	 *  once from the prop (the parent never changes it mid-session). */
	// svelte-ignore state_referenced_locally
	const methodLocked = lockedMethod !== undefined && lockedMethod !== null;

	// Modal state initialized from props on first paint.  The
	// modal mounts when triggered, captures current prop values,
	// and dismisses after submit/cancel — there is no flow where
	// the parent updates these props while the modal is open.
	// svelte-ignore state_referenced_locally
	// svelte-ignore state_referenced_locally
	let method = $state<ChatAssetTicker>(lockedMethod ?? initialMethod);
	// cp425 — when the tabs are restricted (barter accepted_assets) and not
	// locked, keep the selection inside the allowed set (default may not be in
	// it). No-op when locked (tabs hidden) or unrestricted.
	$effect(() => {
		if (methodLocked) return;
		const first = visibleMethods[0];
		if (first !== undefined && !visibleMethods.includes(method)) {
			method = first;
		}
	});
	// svelte-ignore state_referenced_locally
	let usdtNetwork = $state<UsdtNetwork | null>(initialUsdtNetwork);
	// svelte-ignore state_referenced_locally
	let usdcNetwork = $state<UsdcNetwork | null>(initialUsdcNetwork);
	// svelte-ignore state_referenced_locally
	let daiNetwork = $state<DaiNetwork | null>(initialDaiNetwork);
	// True if the parent pinned a USDT, USDC, or DAI network up
	// front (came from an address pill).  Locks the matching
	// picker as read-only so the buyer can't accidentally pick a
	// different network when reporting the txid.
	// cp138 — `xNetworkPinned` is computed ONCE at mount on purpose.
	// We want to know whether the parent pinned the network at the
	// beginning of this modal session.  If the parent later updates
	// the prop, the user has already committed to the picker shape;
	// changing pinned-ness mid-session would be confusing UX.  The
	// `svelte-ignore` matches the pattern used by the underlying
	// $state declarations above.
	// svelte-ignore state_referenced_locally
	const networkPinned = initialUsdtNetwork !== null;
	// svelte-ignore state_referenced_locally
	const usdcNetworkPinned = initialUsdcNetwork !== null;
	// svelte-ignore state_referenced_locally
	const daiNetworkPinned = initialDaiNetwork !== null;
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
				: method === 'usdc'
					? usdcNetwork !== null && validateUsdcTxid(usdcNetwork, trimmedTxid)
					: method === 'dai'
						? daiNetwork !== null && validateDaiTxid(daiNetwork, trimmedTxid)
						: isValidTxid(method, trimmedTxid))
	);
	const amountLooksValid = $derived.by(() => {
		const wellFormed = /^\d{1,12}(?:\.\d{1,12})?$/.test(trimmedAmount);
		if (amountRequired) {
			// cp402 [7a] — required: a valid, strictly-positive number.
			// (The regex alone would accept "0" / "0.00"; a payment of
			// zero is never valid, so guard > 0 explicitly.)
			return wellFormed && Number(trimmedAmount) > 0;
		}
		// Optional: blank is fine, otherwise must be well-formed.
		return trimmedAmount.length === 0 || wellFormed;
	});
	const noteLooksValid = $derived(trimmedNote.length <= PAYLOAD_CONSTANTS.MAX_NOTE_LEN);

	/** USDT-specific gate: network must be picked. */
	const usdtNetworkPicked = $derived(method !== 'usdt' || usdtNetwork !== null);
	/** USDC-specific gate (cp30): mirror of USDT — network must
	 *  be picked.  Even more important than USDT's gate because
	 *  ERC-20 / Base / Polygon all share the EVM 0x[64 hex] txid
	 *  shape, so without a pinned network we couldn't tell which
	 *  explorer to link to. */
	const usdcNetworkPicked = $derived(method !== 'usdc' || usdcNetwork !== null);
	/** DAI-specific gate (cp31): mirror of USDC — network must be
	 *  picked.  MOST important of the three because ALL FOUR DAI
	 *  networks share the EVM 0x[64 hex] txid shape (no SPL
	 *  branch to distinguish like USDC has). */
	const daiNetworkPicked = $derived(method !== 'dai' || daiNetwork !== null);

	const canSubmit = $derived(
		txidLooksValid &&
			amountLooksValid &&
			noteLooksValid &&
			usdtNetworkPicked &&
			usdcNetworkPicked &&
			daiNetworkPicked &&
			!sending
	);

	const txidError = $derived.by(() => {
		if (trimmedTxid.length === 0) return null;
		// BLURT txids are 40 hex chars; BTC/XMR/BCH are 64; USDT,
		// USDC, and DAI vary by network (32-88 chars depending on
		// chain — DAI is all 64-hex EVM-family so on the lower end).
		const minTyped = method === 'blurt' ? 20 : 32;
		if (trimmedTxid.length < minTyped) return null;
		if (txidLooksValid) return null;
		if (method === 'usdt') return 'chat.funds_sent.txid_invalid_usdt';
		if (method === 'usdc') return 'chat.funds_sent.txid_invalid_usdc';
		if (method === 'dai') return 'chat.funds_sent.txid_invalid_dai';
		return 'chat.funds_sent.txid_invalid';
	});

	function selectMethod(m: ChatAssetTicker): void {
		// cp402 [7a] — never change the asset when it's locked to the
		// order's asset (the picker is hidden in that mode, but guard the
		// handler too so no path can flip the coin out from under a send).
		if (methodLocked) return;
		method = m;
		// Part 121 / cp30 / cp31: clear the picked network when
		// leaving a multi-network method.  On re-pick, the user
		// must explicitly choose again.  Don't clear when the
		// corresponding network was pinned by the parent — the
		// parent pinned it for a reason (the buyer is responding
		// to an address pill that already named the network).
		if (m !== 'usdt' && !networkPinned) usdtNetwork = null;
		if (m !== 'usdc' && !usdcNetworkPinned) usdcNetwork = null;
		if (m !== 'dai' && !daiNetworkPinned) daiNetwork = null;
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
				...(method === 'usdt' && usdtNetwork !== null ? { network: usdtNetwork } : {}),
				// Part 122 cp30 — same for USDC.  Especially critical
				// because ERC-20 / Base / Polygon share the same EVM
				// txid shape, so the network is the ONLY way to pick
				// the right explorer URL (etherscan vs basescan vs
				// polygonscan).
				...(method === 'usdc' && usdcNetwork !== null ? { network: usdcNetwork } : {}),
				// Part 122 cp31 — same for DAI.  MOST critical of the
				// three stablecoins because ALL FOUR DAI networks
				// (ERC-20, Polygon, Base, Arbitrum) share the same
				// EVM 0x[64 hex] txid shape — the network field is
				// the ONLY way to pick the right explorer URL
				// (etherscan vs polygonscan vs basescan vs arbiscan).
				...(method === 'dai' && daiNetwork !== null ? { network: daiNetwork } : {})
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
			{$_('chat.funds_sent.modal_title', { values: { peer } })}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('chat.funds_sent.modal_subtitle', { values: { peer } })}
		</p>

		{#if methodLocked}
			<!-- cp402 [7a] — asset locked to the order's asset. The picker
			     is replaced by this read-only line so the wrong coin can
			     never be selected for a payment. -->
			<div
				class="mt-5 rounded-lg border-2 border-morphit-emerald bg-morphit-emerald/10 px-3 py-2 text-center text-sm font-semibold text-morphit-emerald"
			>
				{$_('chat.funds_sent.locked_method_label', {
					values: { asset: method.toUpperCase() }
				})}
			</div>
		{:else}
			<div class="mt-5 flex flex-wrap gap-2" role="tablist">
				{#each visibleMethods as m (m)}
					<button
						type="button"
						role="tab"
						aria-selected={method === m}
						class="flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition {method === m
							? 'border-morphit-emerald bg-morphit-emerald/10 text-morphit-emerald'
							: 'border-ink-200 hover:border-ink-300 dark:border-ink-700 dark:hover:border-ink-600'}"
						onclick={() => selectMethod(m)}
					>
						{$_(`chat.address.method_${m}`)}
					</button>
				{/each}
			</div>
		{/if}

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

		<!-- Part 122 cp30 — USDC network picker.  Same pinning
		     semantics as USDT: when the parent triggered this
		     modal from a received USDC address pill, the network
		     is pinned and the picker renders as a read-only
		     confirmation card so the buyer can't accidentally
		     report the txid on the wrong chain. -->
		{#if method === 'usdc'}
			<div class="mt-4">
				{#if usdcNetworkPinned && usdcNetwork !== null}
					<div
						class="rounded-lg border-2 border-morphit-emerald bg-morphit-emerald/5 p-3 text-sm"
						role="note"
					>
						<div class="font-semibold text-morphit-emerald">
							{$_(`assets.usdc.network.${usdcNetwork}.displayName`)}
						</div>
						<div class="mt-1 text-xs text-ink-300">
							{$_('chat.funds_sent.network_pinned_hint')}
						</div>
					</div>
				{:else}
					<UsdcNetworkPicker bind:network={usdcNetwork} disabled={sending} />
				{/if}
			</div>
		{/if}

		<!-- Part 122 cp31 — DAI network picker.  Same pinning
		     semantics as USDC: when the parent triggered this
		     modal from a received DAI address pill, the network
		     is pinned and the picker renders as a read-only
		     confirmation card so the buyer can't accidentally
		     report the txid on the wrong chain.  DAI is MOST
		     critical here because ALL FOUR networks (ERC-20,
		     Polygon, Base, Arbitrum) share the same EVM 0x[64 hex]
		     txid format — without the network pin the receiver's
		     chat couldn't pick the right explorer (etherscan vs
		     polygonscan vs basescan vs arbiscan). -->
		{#if method === 'dai'}
			<div class="mt-4">
				{#if daiNetworkPinned && daiNetwork !== null}
					<div
						class="rounded-lg border-2 border-morphit-emerald bg-morphit-emerald/5 p-3 text-sm"
						role="note"
					>
						<div class="font-semibold text-morphit-emerald">
							{$_(`assets.dai.network.${daiNetwork}.displayName`)}
						</div>
						<div class="mt-1 text-xs text-ink-300">
							{$_('chat.funds_sent.network_pinned_hint')}
						</div>
					</div>
				{:else}
					<DaiNetworkPicker bind:network={daiNetwork} disabled={sending} />
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
				maxlength="128"
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
			<span class="text-sm font-semibold"
				>{amountRequired
					? $_('chat.funds_sent.amount_label_required')
					: $_('chat.funds_sent.amount_label')}</span
			>
			<input
				type="text"
				bind:value={amount}
				maxlength="32"
				inputmode="decimal"
				autocomplete="off"
				class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-900"
			/>
			{#if payHint}
				<p class="mt-1 text-xs text-morphit-teal dark:text-morphit-emerald">{payHint}</p>
			{/if}
			{#if !amountLooksValid && trimmedAmount.length > 0}
				<p class="mt-1 text-xs text-red-600 dark:text-red-400">
					{$_('chat.address.amount_invalid')}
				</p>
			{:else if amountRequired && trimmedAmount.length === 0}
				<!-- cp402 [7a] — neutral (non-error) nudge so grandma knows
				     the field is required before she's typed anything. -->
				<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
					{$_('chat.funds_sent.amount_required_hint')}
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
				{$_('common.cancel')}
			</button>
			<button
				type="button"
				class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
				onclick={handleSubmit}
				disabled={!canSubmit}
			>
				{$_('chat.funds_sent.send')}
			</button>
		</div>
	</div>
</div>
