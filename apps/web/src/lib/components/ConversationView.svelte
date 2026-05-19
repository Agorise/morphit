<script lang="ts">
	/**
	 * ConversationView — the primary chat view.
	 *
	 * Wires together:
	 *   - a chat controller (from $lib/chat/chatService) that
	 *     handles polling + state machine + broadcast
	 *   - ChatMessage bubbles for each message
	 *   - ChatComposer for input
	 *
	 * Owns the scroll-to-bottom UX per docs/CHAT-UI-DESIGN.md:
	 *   - On initial load: scroll to bottom.
	 *   - After the user sends: scroll to bottom.
	 *   - When a new incoming message arrives AND user is already
	 *     at the bottom: scroll to bottom.
	 *   - When a new incoming message arrives AND user scrolled
	 *     up reading history: show a floating "N new messages ↓"
	 *     pill; tap to scroll.
	 *
	 * Mobile layout: uses 100svh (small viewport height) + flex
	 * column so the composer stays pinned at the bottom without
	 * `position: fixed`, which misbehaves with iOS Safari's
	 * keyboard.
	 */

	import { onDestroy, onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
	import { _ } from 'svelte-i18n';

	import ChatMessage from '$components/ChatMessage.svelte';
	import ChatComposer from '$components/ChatComposer.svelte';
	import FirstTradeHelper from '$components/FirstTradeHelper.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';
	import {
		createConversationController,
		runtimeDeps,
		type ChatController,
		type LocalMessage
	} from '$lib/chat/chatService';
	import { liveIdentity, isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { showToast } from '$lib/stores/toast';
	import { getProfileCached } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { blockedAccounts, loadBlocks, markBlocked, markUnblocked } from '$lib/chat/blocks';
	import { broadcastBlock, broadcastUnblock } from '$blurt/ops/block';
	import { getChatAdmission } from '$lib/indexer/client';
	import StrangerFeeModal from '$components/StrangerFeeModal.svelte';
	import AddressShareModal from '$components/AddressShareModal.svelte';
	import FundsSentModal from '$components/FundsSentModal.svelte';
	import PayBlurtModal from '$components/PayBlurtModal.svelte';
	import { encodeFundsSentPayload, type FundsSentPayload } from '$lib/chat/payload';
	import {
		isUsdtNetwork,
		type UsdtNetwork,
		isUsdcNetwork,
		type UsdcNetwork,
		isDaiNetwork,
		type DaiNetwork
	} from '$lib/assets/networks';
	import { recordFundsSent } from '$lib/trades/tradeStatus';
	import ConfirmModal from '$components/ConfirmModal.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import VerifyPeerPanel from '$components/VerifyPeerPanel.svelte';
	import type { ProfileResponse } from '@morphit/indexer-client';

	interface Props {
		/** Local user's Blurt account name. */
		me: string;
		/** Counterparty's Blurt account name. */
		peer: string;
		/** Optional order context — when this conversation was
		 *  opened from an order detail page (or via ?order=
		 *  query param), this permlink is pinned to any
		 *  address-share or funds-sent payloads sent from this
		 *  view.  Phase F. */
		orderPermlink?: string;
	}

	let { me, peer, orderPermlink }: Props = $props();

	let controller: ChatController | null = null;
	let messages = $state<LocalMessage[]>([]);

	/** True while the SSE stream is connected; renders a small
	 *  "Live" pip in the header so users know the conversation is
	 *  receiving real-time updates.  Same UX pattern as the
	 *  orderbook + instances pages.  Flips false transiently on
	 *  reconnect; flips back true when the next snapshot arrives. */
	let streaming = $state(false);

	/** Peer profile — used for the header IdentityLabel. Fetched on
	 *  mount via the shared profile cache so we hit cache if the
	 *  user just came from a page that listed this peer. */
	let peerProfile = $state<ProfileResponse | null>(null);

	/** Derived block status for this peer. True iff the blocks
	 *  store contains the peer's account. Drives the Block/Unblock
	 *  button label. The store is loaded on mount below. */
	const isPeerBlocked = $derived($blockedAccounts.has(peer.toLowerCase()));

	/** Set while a block/unblock broadcast is in flight, so the
	 *  button can show a busy state and not double-fire. */
	let blockActionBusy = $state(false);
	/** Transient error message shown inline under the Block
	 *  button after a failed toggle. Cleared automatically
	 *  after a few seconds so the UI returns to a clean state
	 *  without requiring a user dismissal. Empty string means
	 *  "no error visible." */
	let blockActionError = $state('');
	let blockErrorTimeoutId: ReturnType<typeof setTimeout> | null = null;

	function showBlockError(msg: string): void {
		blockActionError = msg;
		// Clear any previous pending-clear so this new error
		// stays visible for the full window.
		if (blockErrorTimeoutId !== null) {
			clearTimeout(blockErrorTimeoutId);
		}
		blockErrorTimeoutId = setTimeout(() => {
			blockActionError = '';
			blockErrorTimeoutId = null;
		}, 5000);
	}

	/** Which block action is pending user confirmation. When
	 *  non-null the confirm modal is shown. Captured at toggle
	 *  time so the confirm handler doesn't re-read isPeerBlocked
	 *  (which could in theory change if the store refreshed
	 *  between toggle and confirm — in practice the modal is
	 *  focus-trapped so this is defense-in-depth). */
	let pendingBlockAction: 'block' | 'unblock' | null = $state(null);

	function onToggleBlock(): void {
		if (blockActionBusy) return;
		if (!$liveIdentity) {
			// Without an unlocked session identity we can't sign.
			// The button is rendered only when $isUnlocked, so
			// reaching here means a lock race. Harmless no-op.
			return;
		}
		pendingBlockAction = isPeerBlocked ? 'unblock' : 'block';
	}

	async function onConfirmBlock(): Promise<void> {
		const action = pendingBlockAction;
		if (!action) return;
		const live = get(liveIdentity);
		if (!live) {
			pendingBlockAction = null;
			return;
		}
		blockActionBusy = true;
		try {
			if (action === 'block') {
				await broadcastBlock(live, peer);
				markBlocked(peer);
			} else {
				await broadcastUnblock(live, peer);
				markUnblocked(peer);
			}
			pendingBlockAction = null;
		} catch (err) {
			// Network / chain failure — leave the store state
			// alone so a retry is possible. Close the dialog and
			// surface a transient inline banner via StatusLine;
			// the banner auto-clears after a few seconds.
			console.error('block toggle failed', err);
			pendingBlockAction = null;
			showBlockError($_('chat.block.failed') as string);
		} finally {
			blockActionBusy = false;
		}
	}

	function onCancelBlock(): void {
		pendingBlockAction = null;
	}

	/** Boolean bound into ConfirmModal — it writes this back to
	 *  false when the dialog closes via Escape or backdrop. We
	 *  derive from pendingBlockAction so opening is
	 *  state-driven (set pendingBlockAction → effect opens the
	 *  modal), and the modal writes back on close. */
	let blockConfirmOpen = $state(false);
	$effect(() => {
		blockConfirmOpen = pendingBlockAction !== null;
	});

	// ─── Verify-peer panel (REVISIT-LIST item 11) ────────────────
	/** Opt-in OOB fingerprint verification.  Hidden by default;
	 *  opened by the user from the conversation overflow menu.
	 *  Closing the panel does NOT persist any state — re-opening
	 *  recomputes the fingerprint from scratch. */
	let verifyPeerOpen = $state(false);
	/** Overflow menu (kebab) open state. */
	let overflowMenuOpen = $state(false);
	/** Reference to the overflow-menu trigger so we can return
	 *  focus on close (a11y). */
	let overflowTriggerEl = $state<HTMLButtonElement | null>(null);
	/** Reference to the overflow-menu dropdown so click-outside
	 *  detection knows what's "inside". */
	let overflowMenuEl = $state<HTMLDivElement | null>(null);

	function closeOverflowMenu(): void {
		overflowMenuOpen = false;
	}

	function openVerifyPeer(): void {
		closeOverflowMenu();
		verifyPeerOpen = true;
	}

	function closeVerifyPeer(): void {
		verifyPeerOpen = false;
		// Return focus to the overflow trigger for keyboard users.
		overflowTriggerEl?.focus();
	}

	// Outside-click + Escape handlers for the overflow menu.
	// Attached only while the menu is open, so the listener doesn't
	// run on every render.  Pattern matches AvatarMenu.svelte.
	$effect(() => {
		if (!overflowMenuOpen) return;
		const onMouseDown = (e: MouseEvent): void => {
			const t = e.target as Node | null;
			if (overflowMenuEl && t && !overflowMenuEl.contains(t) && !overflowTriggerEl?.contains(t)) {
				closeOverflowMenu();
			}
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') {
				closeOverflowMenu();
				overflowTriggerEl?.focus();
			}
		};
		document.addEventListener('mousedown', onMouseDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onMouseDown);
			document.removeEventListener('keydown', onKey);
		};
	});

	// ─── Admission state (Finding H layer 2) ─────────────────────
	/** Whether this peer pair currently satisfies the layer-2
	 *  admission gate. Drives composer vs. pay-to-message pill.
	 *  - unknown: first fetch pending, show composer disabled to
	 *             avoid flashing a pay pill that may flip to
	 *             admitted on arrival.
	 *  - admitted: normal composer.
	 *  - needs_fee: hide composer, show pay-to-message pill.
	 *  - error: admission fetch failed. Fail OPEN — show composer.
	 *           Worst case the indexer rejects stranger_fee_required
	 *           at broadcast time; fail-closed on a transient probe
	 *           error would make chat feel broken. */
	type AdmissionStatus = 'unknown' | 'admitted' | 'needs_fee' | 'error';
	let admissionStatus = $state<AdmissionStatus>('unknown');

	/** True while the modal is open. Controlled by the user
	 *  clicking the pay-to-message pill. */
	let showStrangerFeeModal = $state(false);
	/** Phase F — address-share + funds-sent modal state. */
	let showAddressShareModal = $state(false);
	let showFundsSentModal = $state(false);
	/** Q5 — Mark-as-sent prefill from an incoming address pill
	 *  (BTC/XMR/USDT/USDC/DAI/BCH/LTC/DASH).  Held separately from
	 *  showFundsSentModal so the composer-level "I sent it"
	 *  button (no prefill) and the pill-level Mark-as-sent
	 *  button (with prefill) share the modal but supply
	 *  different starting state. */
	let markSentArgs = $state<{
		method: 'btc' | 'xmr' | 'usdt' | 'usdc' | 'dai' | 'bch' | 'ltc' | 'dash' | 'doge';
		amount?: string;
		orderPermlink?: string;
		// cp26 DD-7 fix + cp30 — pill's "Mark as sent" button now
		// passes the network through to FundsSentModal so the
		// buyer doesn't have to re-pick a network they already saw
		// in the chat header.  USDT, USDC, and DAI are all multi-network
		// trade-only assets that ride a `network` discriminator
		// (cp26 wired this through the AddressPayload wire shape
		// originally for USDT; cp30 extended it to USDC).
		network?: string;
	} | null>(null);
	/** Phase F.3 — pay-now BLURT flow.  When non-null, mounts
	 *  PayBlurtModal with the captured details.  Phase F.4 adds
	 *  the memo field for the on-chain transfer's memo. */
	let payBlurtArgs = $state<{
		recipient: string;
		amount: number;
		memo: string;
		orderPermlink?: string;
	} | null>(null);

	async function fetchAdmission(): Promise<void> {
		const res = await getChatAdmission(me, peer);
		if (!res.ok) {
			// Network / indexer failure. Fail open.
			admissionStatus = 'error';
			return;
		}
		admissionStatus = res.data.admitted ? 'admitted' : 'needs_fee';
	}

	function onPayToMessage(): void {
		showStrangerFeeModal = true;
	}

	function onFeePaid(): void {
		// The on-chain broadcast has landed; the indexer needs a
		// block to ingest it. We optimistically flip to admitted
		// so the user can compose immediately — the composer's
		// own send path will still succeed because the signed fee
		// op + sibling transfer are already on the chain by the
		// time the send's ref_block anchor advances past them.
		//
		// Per Finding A20: do NOT re-fetch admission here.  Doing
		// so races the indexer's block-ingest cycle: the request
		// can win the race against ingestion, return admitted=false,
		// and flip the user back to "pay to message" — at which
		// point opening the modal again sees an escalated quote
		// (2× cost) because the just-paid fee is already in the
		// 5-min window.  Trust the optimistic flip; the next mount
		// of this conversation will re-fetch cleanly once the
		// indexer has caught up.
		admissionStatus = 'admitted';
		showStrangerFeeModal = false;
	}

	function onFeeCancel(): void {
		showStrangerFeeModal = false;
	}

	/** Phase F — share an address payload through the chat.  Modal
	 *  builds the encoded JSON; we pipe it through the same
	 *  controller.sendMessage path as a plaintext message.  The
	 *  optimistic-state machine handles pending → broadcast →
	 *  confirmed, and the SSE stream delivers it to the peer in
	 *  real time.  Modal closes on success; on failure the modal
	 *  stays open and surfaces its own error state. */
	async function handleAddressShare(payload: string): Promise<void> {
		if (!controller) throw new Error('controller_not_ready');
		await controller.sendMessage(payload);
		await tick();
		scrollToBottom(true);
		showAddressShareModal = false;
	}

	async function handleFundsSent(payload: string): Promise<void> {
		if (!controller) throw new Error('controller_not_ready');
		await controller.sendMessage(payload);
		await tick();
		scrollToBottom(true);
		showFundsSentModal = false;
		markSentArgs = null;
	}

	/** Phase F.3 — Pay-now click on a BLURT address pill.  Stages
	 *  the modal args; PayBlurtModal mounts on next render.
	 *  Phase F.4 — `memo` is the BLURT payment memo the seller
	 *  pinned (may be undefined if seller opted out).  We
	 *  normalize undefined → '' here because PayBlurtModal expects
	 *  a string; the signTransferWithKey call accepts empty memo. */
	function handlePayNowClick(args: {
		recipient: string;
		amount: number;
		memo?: string;
		orderPermlink?: string;
	}): void {
		payBlurtArgs = {
			recipient: args.recipient,
			amount: args.amount,
			memo: args.memo ?? '',
			orderPermlink: args.orderPermlink
		};
	}

	/** Q5 — Mark-as-sent click on an incoming address pill
	 *  (BTC/XMR/USDT/USDC/DAI/BCH/LTC/DASH/DOGE).  Captures the
	 *  seller's specified method+amount and opens FundsSentModal
	 *  pre-filled. Critical for the Monero amount-jitter flow:
	 *  the buyer's funds-sent echo MUST carry the same jittered
	 *  amount the seller asked for, otherwise the seller's
	 *  verification false-mismatches.
	 *
	 *  We don't open PayBlurtModal here — Morphit doesn't run an
	 *  external-chain wallet of its own.  The buyer pays from
	 *  their own wallet (scanning the QR / pasting the address),
	 *  then comes back to this modal with the txid in hand. */
	function handleMarkSentClick(args: {
		method: 'btc' | 'xmr' | 'usdt' | 'usdc' | 'dai' | 'bch' | 'ltc' | 'dash' | 'doge';
		amount?: string;
		orderPermlink?: string;
		network?: string;
	}): void {
		markSentArgs = args;
		showFundsSentModal = true;
	}

	/** Pay-now broadcast succeeded.  Auto-publish a
	 *  morphit_funds_sent payload to the chat so the seller sees
	 *  a "Blurt sent" pill without the buyer having to take a
	 *  second action.  Best-effort — if the chat broadcast fails
	 *  the on-chain transfer already landed, so the funds are
	 *  legitimately sent; we just couldn't post the receipt.
	 *
	 *  Phase F.5 audit fix (F-43): in fallback paths (controller
	 *  destroyed via navigation, or sendMessage failed) the
	 *  on-chain payment is settled but no chat receipt was posted.
	 *  Two things we now do for the user:
	 *
	 *    1. Always record the funds-sent in the trade-status
	 *       store, so /my/orders and other surfaces see a
	 *       buyer-side entry for this trade.  The store mutator
	 *       is idempotent — calling it twice (chatService merge
	 *       already called it before broadcast) is harmless.
	 *
	 *    2. Surface the txid prominently in the fallback toast
	 *       so the user can copy it for manual receipt-posting
	 *       later (no need to dig through wallet history).
	 */
	async function handlePaidBlurt(args: { trxId: string; blockNum: number }): Promise<void> {
		const stagedArgs = payBlurtArgs;
		payBlurtArgs = null;
		if (stagedArgs === null) return;

		// F-43 part 1: ensure trade-status reflects the payment
		// regardless of whether the chat broadcast succeeds.  Use
		// the orderPermlink from staged args; if absent (rare —
		// pay-now without an order context), the store can't anchor
		// the entry by permlink and we skip this step.
		if (stagedArgs.orderPermlink !== undefined) {
			recordFundsSent({
				orderPermlink: stagedArgs.orderPermlink,
				peer,
				method: 'blurt',
				txid: args.trxId,
				claimedMemo: stagedArgs.memo !== '' ? stagedArgs.memo : undefined,
				amount: stagedArgs.amount,
				direction: 'outgoing'
			});
		}

		if (!controller) {
			// Component was destroyed mid-flight (browser back, etc.)
			showToast(
				$_('chat.pay_blurt.success_toast_no_chat_with_txid', {
					values: { txid: args.trxId }
				}) as string,
				'success'
			);
			return;
		}

		const fundsSent: FundsSentPayload = {
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'blurt',
			txid: args.trxId,
			amount: String(stagedArgs.amount),
			...(stagedArgs.orderPermlink !== undefined
				? { orderPermlink: stagedArgs.orderPermlink }
				: {}),
			// Phase F.4 — echo the memo we actually used on chain so
			// the seller's verification can compare expected vs
			// actual.  Omit the field entirely if no memo was used
			// (encoder handles undefined as "field absent").
			...(stagedArgs.memo !== '' ? { memo: stagedArgs.memo } : {})
		};

		try {
			const wire = encodeFundsSentPayload(fundsSent);
			await controller.sendMessage(wire);
			await tick();
			scrollToBottom(true);
			showToast($_('chat.pay_blurt.success_toast') as string, 'success');
		} catch {
			// Chat broadcast failed but the on-chain transfer
			// already landed.  Surface the txid for manual recovery.
			showToast(
				$_('chat.pay_blurt.success_toast_no_chat_with_txid', {
					values: { txid: args.trxId }
				}) as string,
				'success'
			);
		}
	}

	function handleCancelPayBlurt(): void {
		payBlurtArgs = null;
	}

	/** Scroll container ref — needed to programmatically scroll to
	 *  bottom + measure whether the user is at the bottom. */
	let scrollEl = $state<HTMLElement | null>(null);

	/** Count of new messages that arrived while the user was
	 *  scrolled up. Zero while the user is at the bottom. Shown as
	 *  a pill when > 0. */
	let unreadWhileScrolledUp = $state(0);
	/** Remember whether the user was at the bottom at the START of
	 *  the last render so we can decide whether to auto-scroll after
	 *  a new message arrives. Updated each scroll event. */
	let userAtBottom = $state(true);

	/** Tolerance in pixels for the "at bottom" check — browsers
	 *  round scroll positions and a user who just scrolled down
	 *  hard may land a pixel short. */
	const BOTTOM_TOLERANCE_PX = 50;

	function isAtBottom(): boolean {
		if (!scrollEl) return true;
		const remaining = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
		return remaining <= BOTTOM_TOLERANCE_PX;
	}

	function scrollToBottom(smooth: boolean = true): void {
		if (!scrollEl) return;
		scrollEl.scrollTo({
			top: scrollEl.scrollHeight,
			behavior: smooth ? 'smooth' : 'auto'
		});
		unreadWhileScrolledUp = 0;
	}

	function onScroll(): void {
		if (!scrollEl) return;
		userAtBottom = isAtBottom();
		if (userAtBottom) {
			unreadWhileScrolledUp = 0;
		}
	}

	async function loadPeerProfile(): Promise<void> {
		peerProfile = await getProfileCached(peer);
	}

	// ─── Controller lifecycle ────────────────────────────────────

	onMount(() => {
		// Build the controller with runtime deps + our state-setting
		// onChange hook. `get(liveIdentity)` reads the current store
		// value on every invocation — if the user unlocks mid-
		// conversation, subsequent sends pick up the new value.
		// Q11: pass orderPermlink so outgoing messages bypass the
		// stranger-fee gate when responding to the peer's order.
		const deps = runtimeDeps(me, peer, () => get(liveIdentity), orderPermlink ?? null);
		// Wire our own onChange over the runtimeDeps default.
		const onChange = (next: readonly LocalMessage[]) => {
			const wasAtBottom = userAtBottom;
			// Count incoming messages (not from me) among the new
			// entries added since the last snapshot. If the user is
			// scrolled up, we'll increment the unread pill.
			const prevMaxSeq = messages.reduce((m, x) => (x.localSeq > m ? x.localSeq : m), 0);
			const newIncoming = next.filter((m) => m.localSeq > prevMaxSeq && m.sender !== me).length;
			messages = [...next];
			// After DOM updates, decide how to handle scroll.
			void tick().then(() => {
				if (wasAtBottom) {
					scrollToBottom(true);
				} else if (newIncoming > 0) {
					unreadWhileScrolledUp += newIncoming;
				}
			});
		};
		const fullDeps = {
			...deps,
			onChange,
			onStreamingChange: (s: boolean) => {
				streaming = s;
			}
		};
		controller = createConversationController(fullDeps);
		controller.start();
		// Kick off peer profile load in parallel.
		void loadPeerProfile();
		// Load the block list too — best-effort. Failure here
		// leaves the header showing "Block" (the optimistic
		// default); a refresh retries.
		void loadBlocks(me);
		// Fetch the Finding H layer-2 admission state for this
		// pair. Determines whether to render the composer or the
		// pay-to-message pill. Fire-and-forget; the initial UI
		// shows `unknown` which renders nothing until resolved.
		void fetchAdmission();

		// NOTE (Part 73): cleanup lives in onDestroy below, NOT in
		// an onMount return.  Returning a cleanup from onMount
		// AND defining onDestroy meant controller.destroy() ran
		// twice — harmless because destroy() is idempotent, but
		// wasteful and harder to reason about.  All cleanup now
		// in one place.
	});

	onDestroy(() => {
		controller?.destroy();
		controller = null;
		if (blockErrorTimeoutId !== null) {
			clearTimeout(blockErrorTimeoutId);
			blockErrorTimeoutId = null;
		}
	});

	const locked = $derived(!$isUnlocked);

	// ─── Derived header ──────────────────────────────────────────

	const peerLabelProps = $derived(extractLabelPropsFromProfile(peerProfile));

	// ─── Send handler ────────────────────────────────────────────

	async function handleSend(text: string): Promise<void> {
		if (!controller) return;
		// Capture "have I sent before" BEFORE the send so we can
		// tell if this is the first reply — the kind of send that
		// transitions the conversation from Requests → Messages
		// on next inbox load.
		//
		// Two conditions must both hold for the toast to fire:
		// 1. Snapshot is non-empty (history has loaded). An empty
		//    snapshot could mean "brand-new conversation" or
		//    "history hasn't arrived yet" — we can't distinguish,
		//    so we don't toast.
		// 2. No prior 'me' messages exist. Failed messages don't
		//    count — they never reached the peer, so this is
		//    still a first real send.
		//
		// The only case we miss is "stranger messaged me, I open
		// the chat and immediately type before history loads."
		// Acceptable — missing the toast is better than firing it
		// wrongly on a re-engagement of an existing conversation.
		// Part 73 fix: was `m.sender !== 'me'` — the string literal
		// 'me' instead of the prop `me`.  `m.sender` holds an
		// actual Blurt account name (e.g. 'alice'), never the
		// literal string 'me'.  The bug made `isFirstReply` always
		// true for any non-empty snapshot, firing the
		// moved-to-messages toast on every re-engagement.  Now
		// uses the prop, so the toast fires only when there are no
		// prior successful messages from the local user.
		const snapshot = controller.snapshot();
		const isFirstReply =
			snapshot.length > 0 && snapshot.every((m) => m.sender !== me || m.state === 'failed');

		await controller.sendMessage(text);

		// After send, always force-scroll to bottom — the user
		// sending IS an expression of attention on the conversation.
		await tick();
		scrollToBottom(true);

		if (isFirstReply) {
			showToast(
				$_('chat.conversation.moved_to_messages', {
					values: { peer }
				}) as string,
				'info'
			);
		}
	}

	function handleRetry(localSeq: number): void {
		if (!controller) return;
		void controller.retryMessage(localSeq);
	}

	// ─── Empty state ─────────────────────────────────────────────

	const hasMessages = $derived(messages.length > 0);
</script>

<!--
	Outer container: a full-height flex column. The message list
	scrolls; the composer is pinned at the bottom. 100svh handles
	iOS keyboard reshaping; the flex layout avoids position: fixed.
-->
<div class="chat-conversation flex h-[100svh] flex-col">
	<!-- Header block: peer identity + block button, plus a
	     transient StatusLine for failure messages that sits
	     below the header row. -->
	<div class="flex-none border-b border-ink-200 bg-white dark:border-ink-800 dark:bg-ink-950">
		<header class="chat-header flex items-center justify-between gap-3 px-4 py-3">
			<div class="flex min-w-0 items-center gap-2">
				<IdentityLabel
					account={peer}
					displayName={peerLabelProps.displayName}
					avatarSvg={peerLabelProps.avatarSvg}
					avatarDataUri={peerLabelProps.avatarDataUri}
					nostrUrl={peerLabelProps.nostrUrl}
					blurtMediaUrl={peerLabelProps.blurtMediaUrl}
					href={`/@${peer}`}
					weight="bold"
					avatarSize={32}
				/>
				{#if streaming}
					<span
						class="inline-flex flex-none items-center gap-1.5 text-xs"
						aria-label={$_('chat.live') as string}
					>
						<span class="relative inline-flex h-2 w-2">
							<span
								class="absolute inline-flex h-full w-full animate-ping rounded-full bg-morphit-emerald opacity-60"
							></span>
							<span class="relative inline-flex h-2 w-2 rounded-full bg-morphit-emerald"></span>
						</span>
						<span class="uppercase tracking-widest text-ink-500 dark:text-ink-500"
							>{$_('chat.live')}</span
						>
					</span>
				{/if}
			</div>
			{#if $isUnlocked}
				<div class="flex flex-none items-center gap-2">
					<button
						type="button"
						class="rounded-xl border-2 px-3 py-1.5 text-sm font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 {isPeerBlocked
							? 'border-red-400 bg-red-50 text-red-800 hover:bg-red-100 dark:border-red-700 dark:bg-red-950 dark:text-red-200'
							: 'border-ink-300 bg-white text-ink-700 hover:bg-ink-100 dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-ink-800'}"
						disabled={blockActionBusy}
						onclick={onToggleBlock}
						aria-label={isPeerBlocked
							? ($_('chat.block.unblock_aria', { values: { peer } }) as string)
							: ($_('chat.block.block_aria', { values: { peer } }) as string)}
					>
						{#if blockActionBusy}
							{$_('chat.block.busy')}
						{:else if isPeerBlocked}
							{$_('chat.block.unblock')}
						{:else}
							{$_('chat.block.block')}
						{/if}
					</button>
					<!-- REVISIT-LIST item 11 — overflow menu.  Hosts
					     the opt-in "Verify peer" item.  Hidden-by-
					     default UX: the menu is collapsed, no
					     badges, no nag. -->
					<div class="relative">
						<button
							type="button"
							bind:this={overflowTriggerEl}
							class="rounded-xl border-2 border-ink-300 bg-white px-2 py-1.5 text-ink-700 hover:bg-ink-100 dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-ink-800"
							aria-haspopup="menu"
							aria-expanded={overflowMenuOpen}
							aria-label={$_('chat.menu.aria_open') as string}
							onclick={() => (overflowMenuOpen = !overflowMenuOpen)}
						>
							<!-- Vertical kebab: 3 dots stacked.  Inline
							     SVG to avoid an icon-component dependency. -->
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 16 16"
								fill="currentColor"
								aria-hidden="true"
							>
								<circle cx="8" cy="3" r="1.5" />
								<circle cx="8" cy="8" r="1.5" />
								<circle cx="8" cy="13" r="1.5" />
							</svg>
						</button>
						{#if overflowMenuOpen}
							<div
								bind:this={overflowMenuEl}
								class="absolute right-0 top-full z-40 mt-1 min-w-[12rem] rounded-lg border border-ink-200 bg-white shadow-lg dark:border-ink-700 dark:bg-ink-900"
								role="menu"
							>
								<button
									type="button"
									role="menuitem"
									class="block w-full px-4 py-2 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
									onclick={openVerifyPeer}
								>
									{$_('chat.menu.verify_peer')}
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</header>
		{#if blockActionError}
			<div class="px-4 pb-2">
				<StatusLine kind="error">{blockActionError}</StatusLine>
			</div>
		{/if}
		{#if orderPermlink}
			<!-- Q10 — order-context banner. When the user reached this
			     chat from an orderbook row's Message button (or via a
			     ?order= deep link), surface the link to the order so
			     they can re-read terms without losing chat scroll. -->
			<div class="border-b border-morphit-emerald/20 bg-morphit-emerald/5 px-4 py-2 text-xs">
				<a
					href={`/@${peer}/${orderPermlink}`}
					class="flex items-center gap-2 text-morphit-emerald hover:underline"
				>
					<span aria-hidden="true">📌</span>
					<span class="font-semibold">{$_('chat.order_context_label')}:</span>
					<code class="font-mono">{orderPermlink}</code>
				</a>
			</div>
		{/if}
	</div>

	<!-- Item 16 phase 4 (Item 1.5 from grandma investigation):
	     first-time-trade helper.  Self-suppressing — only renders
	     when the user has never given feedback before AND this
	     conversation is anchored to a specific order. -->
	<FirstTradeHelper {orderPermlink} />

	<!-- Scrollable message list: the flex-grow child. -->
	<div
		class="chat-scroll flex-1 overflow-y-auto px-3 py-4"
		bind:this={scrollEl}
		onscroll={onScroll}
	>
		{#if !hasMessages}
			<div class="flex h-full items-center justify-center text-center">
				<p class="max-w-sm text-sm text-ink-500 dark:text-ink-400">
					{$_('chat.empty_state', { values: { peer } })}
				</p>
			</div>
		{:else}
			<ul
				class="flex flex-col gap-2"
				role="log"
				aria-live="polite"
				aria-label={$_('chat.messages_aria') as string}
			>
				{#each messages as m (m.localSeq)}
					<ChatMessage
						message={m}
						{me}
						{peer}
						onRetry={handleRetry}
						onPayNow={handlePayNowClick}
						onMarkSent={handleMarkSentClick}
					/>
				{/each}
			</ul>
		{/if}
	</div>

	<!-- "N new messages ↓" pill when the user is scrolled up and new messages arrived. -->
	{#if unreadWhileScrolledUp > 0}
		<div class="chat-unread-pill pointer-events-none relative">
			<button
				type="button"
				class="pointer-events-auto absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-morphit-emerald px-4 py-1.5 text-sm font-semibold text-ink-950 shadow-lg transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
				onclick={() => scrollToBottom(true)}
				aria-label={$_('chat.new_messages_pill_aria', {
					values: { n: unreadWhileScrolledUp }
				}) as string}
			>
				{$_('chat.new_messages_pill', { values: { n: unreadWhileScrolledUp } })} ↓
			</button>
		</div>
	{/if}

	<!-- Pinned composer. Admission state (Finding H layer 2)
	     decides whether to render the composer or a
	     pay-to-message pill.

	     Q11 exception: when the user reached this conversation
	     with an `orderPermlink` (responded to a peer's order via
	     the orderbook's "Message" CTA, or via a deep link with
	     ?order=...), the composer renders even when admission is
	     `needs_fee`.  The chat handler bypasses the stranger-fee
	     gate when an outgoing message carries a valid
	     `order_permlink` field naming a real order owned by the
	     peer.  We surface a short note so the user understands
	     they're getting free first-contact thanks to the order
	     they're responding to. -->
	{#if admissionStatus === 'unknown'}
		<!-- Brief nothing while the admission probe resolves —
		     avoids flashing a pay-pill that may flip to composer
		     on arrival. -->
		<div
			class="flex-none border-t border-ink-200 bg-white px-4 py-3 dark:border-ink-800 dark:bg-ink-950"
		></div>
	{:else if admissionStatus === 'admitted' || admissionStatus === 'error' || (admissionStatus === 'needs_fee' && orderPermlink)}
		{#if $isPairedReadOnly}
			<!-- Paired-readonly session (ADR-0022 QR-pair, Option A).
			     Chat sends, address shares, and funds-sent confirmations
			     all sign with the posting key — which lives on the
			     phone for paired sessions.  Show the WriteBlocked
			     affordance with a phone deep-link instead of the
			     composer; chat history above remains fully readable. -->
			<div
				class="flex-none border-t border-ink-200 bg-white px-4 py-3 dark:border-ink-800 dark:bg-ink-950"
			>
				<div class="mx-auto max-w-2xl">
					<WriteBlockedReadOnly variant="send_chat" {peer} orderPermlink={orderPermlink ?? null} />
				</div>
			</div>
		{:else}
			<!-- Phase F — address-share + funds-sent toolbar.  Sits
			     above the composer.  Only rendered when admitted (or
			     when the order-response bypass applies).  Locked
			     sessions hide the toolbar (it would just dispatch a
			     "please unlock" no-op modal). -->
			{#if !locked}
				<div
					class="dark:bg-ink-925 flex-none border-t border-ink-200 bg-ink-50 px-4 py-2 dark:border-ink-800"
				>
					<div class="mx-auto flex max-w-2xl items-center justify-end gap-2">
						<button
							type="button"
							class="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:border-morphit-emerald hover:text-morphit-emerald dark:border-ink-700 dark:text-ink-200"
							onclick={() => (showAddressShareModal = true)}
							aria-label={$_('chat.address.share_button_aria') as string}
						>
							{$_('chat.address.share_button')}
						</button>
						<button
							type="button"
							class="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:border-morphit-emerald hover:text-morphit-emerald dark:border-ink-700 dark:text-ink-200"
							onclick={() => (showFundsSentModal = true)}
							aria-label={$_('chat.funds_sent.button_aria') as string}
						>
							{$_('chat.funds_sent.button')}
						</button>
					</div>
				</div>
			{/if}
			{#if admissionStatus === 'needs_fee' && orderPermlink}
				<!-- Q11: surface why the composer is open despite the
				     usual stranger-fee gate.  Friendly green note,
				     no CTA — just transparency about the bypass. -->
				<div
					class="flex-none border-t border-morphit-emerald/20 bg-morphit-emerald/5 px-4 py-2 text-xs text-morphit-emerald"
				>
					<p class="mx-auto max-w-2xl">
						🌱 {$_('chat.order_response_no_fee', { values: { peer } })}
					</p>
				</div>
			{/if}
			<ChatComposer {peer} onSend={handleSend} isLocked={locked} />
		{/if}
	{:else}
		<!-- needs_fee (and no order context): show pay-to-message
		     affordance instead of the composer. -->
		<div
			class="flex-none border-t border-ink-200 bg-white px-4 py-3 dark:border-ink-800 dark:bg-ink-950"
		>
			<div class="mx-auto flex max-w-2xl flex-col gap-2">
				<p class="text-sm text-ink-600 dark:text-ink-300">
					{$_('chat.stranger_fee.pill_explain', { values: { peer } })}
				</p>
				<button
					type="button"
					onclick={onPayToMessage}
					disabled={locked}
					class="hover:bg-morphit-green rounded-xl border-2 border-morphit-emerald bg-morphit-emerald px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
				>
					{$_('chat.stranger_fee.pill_cta')}
				</button>
				{#if locked}
					<p class="text-xs text-ink-500 dark:text-ink-500">
						{$_('chat.stranger_fee.pill_locked_hint')}
					</p>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if showStrangerFeeModal && $liveIdentity}
	<StrangerFeeModal live={$liveIdentity} {peer} onPaid={onFeePaid} onCancel={onFeeCancel} />
{/if}

{#if showAddressShareModal}
	<AddressShareModal
		{orderPermlink}
		onShare={handleAddressShare}
		onCancel={() => (showAddressShareModal = false)}
	/>
{/if}

{#if showFundsSentModal}
	<FundsSentModal
		{orderPermlink}
		initialMethod={markSentArgs?.method ?? 'btc'}
		initialAmount={markSentArgs?.amount ?? ''}
		initialUsdtNetwork={
			/* cp26 DD-7 fix — propagate the USDT network from the
			   pill the user tapped, so they don't have to re-pick
			   the network they already saw in the chat header.
			   Validate via isUsdtNetwork to defend against a
			   garbage `network` value somehow arriving here (e.g.
			   from a malformed pre-cp26 payload); fall through to
			   null on mismatch so the picker re-prompts. */
			markSentArgs?.method === 'usdt' &&
			markSentArgs?.network !== undefined &&
			isUsdtNetwork(markSentArgs.network)
				? (markSentArgs.network as UsdtNetwork)
				: null
		}
		initialUsdcNetwork={
			/* Part 122 cp30 — same propagation path for USDC.
			   Guarded by method === 'usdc' so a wire-format
			   `network` value carried on a non-multi-network
			   asset (which the encoder forbids, but defense in
			   depth) can't accidentally route into the USDC
			   picker. */
			markSentArgs?.method === 'usdc' &&
			markSentArgs?.network !== undefined &&
			isUsdcNetwork(markSentArgs.network)
				? (markSentArgs.network as UsdcNetwork)
				: null
		}
		initialDaiNetwork={
			/* Part 122 cp31 — same propagation path for DAI.
			   Guarded by method === 'dai' for the same
			   defense-in-depth reasons.  DAI is the most
			   important case here because all 4 networks share
			   the EVM 0x address format — the network from the
			   pill is the ONLY way the buyer's modal can know
			   which chain to expect a txid on. */
			markSentArgs?.method === 'dai' &&
			markSentArgs?.network !== undefined &&
			isDaiNetwork(markSentArgs.network)
				? (markSentArgs.network as DaiNetwork)
				: null
		}
		onShare={handleFundsSent}
		onCancel={() => {
			showFundsSentModal = false;
			markSentArgs = null;
		}}
	/>
{/if}

{#if payBlurtArgs !== null}
	<PayBlurtModal
		recipient={payBlurtArgs.recipient}
		amount={payBlurtArgs.amount}
		memo={payBlurtArgs.memo}
		onPaid={handlePaidBlurt}
		onCancel={handleCancelPayBlurt}
	/>
{/if}

<!-- Block / unblock confirmation dialog. Replaces the native
     confirm() with Morphit-styled ConfirmModal — native <dialog>
     element gives focus trap + backdrop + Escape dismiss for free.
     Renders only when pendingBlockAction is non-null; the
     pendingBlockAction field also discriminates the copy ("block"
     vs "unblock" subtree of translations). -->
{#if pendingBlockAction !== null}
	{@const action = pendingBlockAction}
	<ConfirmModal
		bind:open={blockConfirmOpen}
		title={$_(`chat.block.confirm.${action}.title`, {
			values: { peer }
		}) as string}
		body={$_(`chat.block.confirm.${action}.body`, {
			values: { peer }
		}) as string}
		confirmLabel={$_(`chat.block.confirm.${action}.yes`, {
			values: { peer }
		}) as string}
		cancelLabel={$_('chat.block.confirm.cancel') as string}
		variant="destructive"
		busyLabel={$_('chat.block.busy') as string}
		onConfirm={onConfirmBlock}
		onCancel={onCancelBlock}
	/>
{/if}

<!-- REVISIT-LIST item 11 — opt-in OOB fingerprint panel.
     Hidden by default; opened by the user from the conversation
     overflow menu.  Closing does NOT persist any verified-state
     anywhere — re-opening recomputes from scratch. -->
{#if verifyPeerOpen}
	<VerifyPeerPanel {me} {peer} onClose={closeVerifyPeer} />
{/if}

<style>
	.chat-conversation {
		/* Keep the flex column constrained. 100svh handles mobile
		   keyboard reshape better than 100vh. */
		min-height: 0; /* critical — prevents the flex child (.chat-scroll)
		                  from overflowing its parent on short screens */
	}

	.chat-scroll {
		/* overflow-y-auto is Tailwind; this lets scrollbars style
		   consistently in WebKit. */
		overscroll-behavior: contain;
	}
</style>
