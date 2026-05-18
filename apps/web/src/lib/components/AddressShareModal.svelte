<script lang="ts">
	/**
	 * AddressShareModal — share a receiving address through the
	 * chat for any tradable asset (BTC, XMR, BLURT, USDT, BCH,
	 * LTC, DASH).
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
		jitterAmountForAsset,
		PAYLOAD_CONSTANTS,
		type AddressPayload,
		type ChatAssetTicker
	} from '$lib/chat/payload';
	import { validateUsdtAddress, type UsdtNetwork, validateUsdcAddress, type UsdcNetwork } from '$lib/assets/networks';
	import PrivacyWarningChip from './PrivacyWarningChip.svelte';
	import UsdtNetworkPicker from './UsdtNetworkPicker.svelte';
	import UsdcNetworkPicker from './UsdcNetworkPicker.svelte';
	import {
		findPriorShare,
		recordAddressShare,
		type AddressHistoryEntry
	} from '$lib/privacy/addressHistory';

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
	/** Part 122 cp30 — USDC sub-network (ERC-20/SPL/Base/Polygon).
	 *  Same shape as usdtNetwork above: null when method !== 'usdc',
	 *  required pre-submit otherwise.  Note ERC-20, Base, and
	 *  Polygon all share the EVM 0x[40-hex] address format, so
	 *  per-network shape validation is mostly a no-op for choosing
	 *  among those three (validateUsdcAddress returns true for all
	 *  of them given a 0x... value); the picker exists to tell
	 *  the SENDER which chain to broadcast on, since the same
	 *  address can receive USDC on any of the three EVM chains
	 *  but the wallet has to send on the matching chain. */
	let usdcNetwork = $state<UsdcNetwork | null>(null);
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

	/** cp26 — BTC PayJoin (BIP-78) endpoint URL.  Optional, BTC-
	 *  only.  When non-empty, the generated bitcoin: URI gains
	 *  a `pj=<url>` parameter and the wire payload carries
	 *  `payjoin_endpoint`.  Wallets that support PayJoin will
	 *  switch to the BIP-78 PSBT exchange flow with this URL;
	 *  wallets without support ignore the parameter and fall
	 *  back to a normal payment (zero footgun).
	 *
	 *  Morphit doesn't host the endpoint — the seller supplies
	 *  it from their own wallet/BTCPayServer/equivalent.  We
	 *  validate it parses as a URL but don't enforce HTTPS or
	 *  .onion (operator may run trusted plain-HTTP on a LAN). */
	let payjoinEndpoint = $state('');

	/** Q5 — privacy: randomize amount for transparent chains.
	 *  Default ON for XMR (cp3) AND all transparent assets
	 *  (BTC/BCH/LTC/BLURT) from cp26.  XMR uses 6 trailing
	 *  decimals of jitter to defeat amount-correlation on the
	 *  Monero chain (see jitterMoneroAmount).  BTC/BCH/LTC/DASH use
	 *  satoshi-precision jitter (up to 999 sat ≈ $0.001-$0.50
	 *  trivial cost — see jitterUtxoAmount).  BLURT uses
	 *  milliblurt-precision jitter (see jitterBlurtAmount).
	 *  USDT and USDC (cp30, reversing cp26's USDT-no-jitter
	 *  decision per ADR-0028 Decision 2): 6-decimal precision,
	 *  0-999 microunit jitter ≈ $0.001 (jitterStablecoinAmount).
	 *  The cp26 rationale "centralization is the issue, not
	 *  amount-correlation" correctly observed that jitter doesn't
	 *  help against Circle/Tether freezes, but did NOT refute the
	 *  SEPARATE amount-correlation linkability threat.  Both
	 *  threats are real and independent; jitter addresses one.
	 *  See jitterAmountForAsset in payload.ts for the dispatcher. */
	let jitterAmount = $state(true);
	/** Memoized jittered amount.  Recomputed each time the user
	 *  edits the amount, switches asset, or toggles jitter; held
	 *  stable so re-rendering the preview doesn't re-roll the
	 *  random low-order digits (which would be confusing — the
	 *  user expects the number they see to be the number that
	 *  gets sent). */
	let jitteredAmount = $state<string | null>(null);
	/** Returns true when amount-jitter is available for the
	 *  currently-selected asset.  Every tradable asset is jitter-
	 *  eligible as of cp30 (USDT was excluded in cp26 but the
	 *  exclusion was reverted in cp30; see jitterAmount comment
	 *  above for the design rationale). */
	const jitterEligible = $derived(true);
	$effect(() => {
		if (
			!jitterEligible ||
			!jitterAmount ||
			amount.trim() === '' ||
			!/^\d{1,12}(?:\.\d{1,12})?$/.test(amount.trim())
		) {
			jitteredAmount = null;
			return;
		}
		try {
			jitteredAmount = jitterAmountForAsset(method, amount.trim());
		} catch {
			jitteredAmount = null;
		}
	});

	// cp26-back-compat aliases for any existing references to the
	// XMR-specific names; remove once all sites use the generic ones.
	const jitterXmr = $derived(jitterAmount);
	const xmrJitteredAmount = $derived(method === 'xmr' ? jitteredAmount : null);

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
				: method === 'usdc'
					? usdcNetwork !== null && validateUsdcAddress(usdcNetwork, trimmedAddress)
					: isValidAddress(method, trimmedAddress))
	);
	/** cp26 — Address-reuse detection.  Reads the local-only
	 *  address-history (see lib/privacy/addressHistory.ts) and
	 *  surfaces a warning chip when the user is about to share an
	 *  address they've shared from this device before.  Reuse leaks
	 *  the operator's on-chain identity to the counterparty's
	 *  observers + builds a counterparty graph against the same
	 *  address over time. */
	const priorShare = $derived(
		addressLooksValid
			? findPriorShare(method.toUpperCase(), trimmedAddress)
			: null
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
	/** USDC-specific gate (cp30, mirror of USDT): network MUST be
	 *  picked before submit, no default — especially important
	 *  here because ERC-20 / Base / Polygon look identical at the
	 *  address-format level (all 0x[40 hex]). */
	const usdcNetworkPicked = $derived(method !== 'usdc' || usdcNetwork !== null);

	const canSubmit = $derived(
		addressLooksValid &&
			amountLooksValid &&
			noteLooksValid &&
			usdtNetworkPicked &&
			usdcNetworkPicked &&
			!sending
	);

	/** Address-error inline message.  Empty when the address looks
	 *  valid OR is empty.  Showing an error pre-emptively (before
	 *  the user has typed enough chars) is jarring, so only flag
	 *  invalid AFTER they've typed something substantial.  BLURT
	 *  account names are short (3-16 chars) so the threshold is
	 *  lower than for the other assets (BTC, XMR, USDT, USDC, BCH,
	 *  LTC, DASH, all of which use the same 10-char threshold). */
	const addressErrorKey = $derived.by(() => {
		if (trimmedAddress.length === 0) return null;
		// Method-aware "still typing" threshold.
		const minTyped = method === 'blurt' ? 3 : 10;
		if (trimmedAddress.length < minTyped) return null;
		if (addressLooksValid) return null;
		if (method === 'btc') return 'chat.address.address_invalid_btc';
		if (method === 'xmr') return 'chat.address.address_invalid_xmr';
		if (method === 'usdt') return 'chat.address.address_invalid_usdt';
		if (method === 'usdc') return 'chat.address.address_invalid_usdc';
		if (method === 'bch') return 'chat.address.address_invalid_bch';
		if (method === 'ltc') return 'chat.address.address_invalid_ltc';
		if (method === 'dash') return 'chat.address.address_invalid_dash';
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
		// Part 121 / cp30: when leaving a multi-network asset (USDT
		// or USDC), drop the pinned network so a future re-pick
		// forces a fresh explicit choice (no stale value).  Each
		// multi-network trade gets a deliberate network commit.
		if (m !== 'usdt') usdtNetwork = null;
		if (m !== 'usdc') usdcNetwork = null;
	}

	async function handleSubmit(): Promise<void> {
		if (!canSubmit) return;
		sending = true;
		sendError = null;
		try {
			// cp26 — if amount jitter is enabled for an eligible asset
			// and we have a valid jittered amount, send that as
			// payload.amount; the buyer's wallet will pre-fill it from
			// the QR/payload and the on-chain transfer carries the
			// jittered value.  We use the memoized $state rather than
			// re-calling jitterAmountForAsset so the preview the user
			// saw IS the amount that gets sent (no re-roll between
			// preview and submit).  USDT is no-jitter (its privacy
			// issue is centralization, not amount-correlation).
			const finalAmount =
				jitterEligible && jitterAmount && jitteredAmount !== null
					? jitteredAmount
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
				...(method === 'usdt' && usdtNetwork !== null ? { network: usdtNetwork } : {}),
				// Part 122 cp30 — pin the USDC network the same way.
				// Especially critical because ERC-20 / Base / Polygon
				// all use the EVM 0x[40 hex] address shape, so without
				// the network field the receiver couldn't tell which
				// chain to expect.
				...(method === 'usdc' && usdcNetwork !== null ? { network: usdcNetwork } : {}),
				// cp26 — BTC PayJoin (BIP-78) endpoint URL.  Only
				// propagates when method is btc AND the seller
				// supplied a non-empty endpoint.  Encoder enforces
				// the BTC-only invariant as defense in depth.
				...(method === 'btc' && payjoinEndpoint.trim().length > 0
					? { payjoinEndpoint: payjoinEndpoint.trim() }
					: {})
			};
			const wire = encodeAddressPayload(payload);
			// cp26 — Record this share in the local-only address
			// history so subsequent uses of the same address surface
			// a reuse warning.  Best-effort: failure to record
			// (localStorage full, private mode) does NOT block the
			// share itself.
			const historyEntry: AddressHistoryEntry = {
				asset: method.toUpperCase(),
				address: trimmedAddress,
				sharedAt: new Date().toISOString(),
				...(orderPermlink !== undefined ? { orderPermlink } : {})
			};
			recordAddressShare(historyEntry);
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
				aria-selected={method === 'usdc'}
				class="flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition {method ===
				'usdc'
					? 'border-morphit-emerald bg-morphit-emerald/10 text-morphit-emerald'
					: 'border-ink-200 hover:border-ink-300 dark:border-ink-700 dark:hover:border-ink-600'}"
				onclick={() => selectMethod('usdc')}
			>
				{$_('chat.address.method_usdc')}
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
			<button
				type="button"
				role="tab"
				aria-selected={method === 'dash'}
				class="flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition {method ===
				'dash'
					? 'border-morphit-emerald bg-morphit-emerald/10 text-morphit-emerald'
					: 'border-ink-200 hover:border-ink-300 dark:border-ink-700 dark:hover:border-ink-600'}"
				onclick={() => selectMethod('dash')}
			>
				{$_('chat.address.method_dash')}
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

		<!-- Part 122 cp30 — USDC privacy warning + network picker.
		     Same shape as USDT: privacy chip above the picker, picker
		     enforces network commit before submit.  Extra emphasis
		     on the cross-network warning because ERC-20 / Base /
		     Polygon all use the EVM 0x[40 hex] address shape —
		     visually indistinguishable, only the picker tells the
		     sender's wallet which chain to broadcast on. -->
		{#if method === 'usdc'}
			<div class="mt-4">
				<PrivacyWarningChip privacyWarningKey="usdc_centralized" />
				<div class="mt-3">
					<UsdcNetworkPicker bind:network={usdcNetwork} disabled={sending} />
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
							: method === 'usdc'
								? ($_('chat.address.address_placeholder_usdc') as string)
								: method === 'bch'
									? ($_('chat.address.address_placeholder_bch') as string)
									: method === 'ltc'
										? ($_('chat.address.address_placeholder_ltc') as string)
										: method === 'dash'
											? ($_('chat.address.address_placeholder_dash') as string)
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
			<!-- cp26 — Address-reuse warning.  Surfaced when the
			     user is about to share an address they've shared
			     from this device before.  Renders BELOW the error
			     row (errors take priority) but ABOVE the optional
			     subaddress tip.  Privacy posture: localStorage-only,
			     never transmitted to any server. -->
			{#if priorShare !== null && !addressErrorKey}
				<div
					class="mt-2 rounded-lg border border-amber-400 bg-amber-50 p-2 text-xs dark:border-amber-600 dark:bg-amber-950"
					role="alert"
				>
					<div class="font-semibold text-amber-900 dark:text-amber-100">
						⚠ {$_('chat.address.reuse_warning_heading')}
					</div>
					<p class="mt-1 text-amber-800 dark:text-amber-200">
						{$_('chat.address.reuse_warning_body', {
							values: {
								date: new Date(priorShare.sharedAt).toLocaleDateString()
							}
						})}
					</p>
					{#if priorShare.orderPermlink !== undefined}
						<p class="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
							{$_('chat.address.reuse_warning_prior_order', {
								values: { permlink: priorShare.orderPermlink }
							})}
						</p>
					{/if}
				</div>
			{/if}
		</label>

		<!-- cp26 — BTC PayJoin (BIP-78) endpoint URL.  Optional
		     advanced field — most sellers won't use this.  Surfaces
		     only on the BTC tab.  When the seller's wallet supports
		     PayJoin (BIP-78), they paste the endpoint URL here; the
		     buyer's wallet (if it also supports PayJoin) will use
		     the URL to negotiate a cooperative PSBT that defeats
		     the common-input-ownership heuristic.  No effect on
		     wallets without PayJoin support — they fall back to a
		     normal payment. -->
		{#if method === 'btc'}
			<details class="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-2 text-sm dark:border-ink-700 dark:bg-ink-900">
				<summary class="cursor-pointer font-semibold text-ink-700 dark:text-ink-200">
					🔐 {$_('chat.address.payjoin_summary')}
				</summary>
				<div class="mt-2">
					<label class="block">
						<span class="text-xs font-semibold">{$_('chat.address.payjoin_label')}</span>
						<input
							type="url"
							bind:value={payjoinEndpoint}
							placeholder="https://payjoin.example.org/bip78"
							autocomplete="off"
							autocapitalize="none"
							autocorrect="off"
							spellcheck="false"
							class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-ink-700 dark:bg-ink-950"
						/>
						<p class="mt-1 text-[11px] text-ink-600 dark:text-ink-400">
							{$_('chat.address.payjoin_explain')}
						</p>
					</label>
				</div>
			</details>
		{/if}

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

		<!-- Q5 — Amount-jitter toggle.  Defeats amount-correlation
		     attacks on transparent chains (any 3rd party can match
		     order book + chain to identify the trade).  XMR shipped
		     this in cp3 with deep Monero-specific copy (Sally finding
		     L13 — Part 68 — explicit ON/OFF state copy).  cp26
		     extended to BTC/BCH/LTC (satoshi precision) and BLURT
		     (milliblurt precision).  USDT excluded — its privacy
		     issue is centralization (Tether freeze), not amount-
		     correlation; jitter doesn't address the actual threat. -->
		{#if jitterEligible && trimmedAmount.length > 0 && amountLooksValid}
			{@const unit = method.toUpperCase()}
			{@const labelKey = method === 'xmr'
				? 'chat.address.xmr_jitter_label'
				: 'chat.address.amount_jitter_label'}
			{@const explainKey = method === 'xmr'
				? 'chat.address.xmr_jitter_explain'
				: 'chat.address.amount_jitter_explain'}
			{@const willSendKey = method === 'xmr'
				? 'chat.address.xmr_jitter_will_send'
				: 'chat.address.amount_jitter_will_send'}
			{@const sendExactKey = method === 'xmr'
				? 'chat.address.xmr_jitter_send_exact_hint'
				: 'chat.address.amount_jitter_send_exact_hint'}
			{@const offHeadingKey = method === 'xmr'
				? 'chat.address.xmr_jitter_off_warning_heading'
				: 'chat.address.amount_jitter_off_warning_heading'}
			{@const offBodyKey = method === 'xmr'
				? 'chat.address.xmr_jitter_off_warning_body'
				: 'chat.address.amount_jitter_off_warning_body'}
			<div class="mt-2 rounded-lg border border-morphit-emerald/40 bg-morphit-emerald/5 p-3">
				<label class="flex items-start gap-2 text-sm">
					<input type="checkbox" bind:checked={jitterAmount} class="mt-0.5 h-4 w-4" />
					<span class="flex-1">
						<span class="font-semibold">
							🔐 {$_(labelKey)}
						</span>
						<span class="block text-xs text-ink-600 dark:text-ink-300">
							{$_(explainKey)}
						</span>
					</span>
				</label>
				{#if jitterAmount && jitteredAmount !== null}
					<div
						class="mt-2 rounded-md border border-morphit-emerald/30 bg-white p-2 dark:bg-ink-950"
					>
						<div class="text-xs font-semibold text-morphit-emerald">
							✓ {$_(willSendKey)}
						</div>
						<code class="mt-1 block break-all font-mono text-sm font-bold">
							{jitteredAmount} {unit}
						</code>
						<p class="mt-1 text-[11px] text-ink-500 dark:text-ink-500">
							{$_(sendExactKey)}
						</p>
					</div>
				{:else if !jitterAmount}
					<div
						class="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950"
					>
						<div class="text-xs font-semibold text-amber-900 dark:text-amber-200">
							⚠ {$_(offHeadingKey)}
						</div>
						<p class="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
							{$_(offBodyKey)}
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
