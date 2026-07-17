<script lang="ts">
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { page } from '$app/stores';

	// cp242 — per-locale internal-link wrapper (cp7 design: every
	// internal link is locale-prefixed; bare 2-segment paths 404).
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
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
	import { markConversationRead, readAckTimestamp } from '$lib/chat/readState';
	import { chatFolders, isStarred, toggleStar } from '$lib/chat/chatFolders';
	import { pinToBottom } from '$lib/ui/pinToBottom';
	import { truncatePublicKey } from '$lib/crypto/publicKeyDisplay';
	import { get } from 'svelte/store';
	import { _ } from 'svelte-i18n';

	import ChatMessage from '$components/ChatMessage.svelte';
	import LeaveFeedbackForm from '$components/LeaveFeedbackForm.svelte';
	import ChatComposer from '$components/ChatComposer.svelte';
	import FirstTradeHelper from '$components/FirstTradeHelper.svelte';
	import ChatNotificationNudge from '$components/ChatNotificationNudge.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import NewTraderChip from '$components/NewTraderChip.svelte';
	import TradeRepCluster from '$components/TradeRepCluster.svelte';
	import { formatCountCompact, formatDayMonth } from '$lib/i18n/formatters';
	import { daySeparatorAt } from '$lib/chat/daySeparator';
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
	import { selfProfile } from '$lib/stores/selfProfile';
	import {
		writeChatSecurityMode,
		readChatSecurityNudgeSeen,
		markChatSecurityNudgeSeen
	} from '$stores/chatSecurity';
	import { blockedAccounts, loadBlocks, markBlocked, markUnblocked } from '$lib/chat/blocks';
	import { broadcastBlock, broadcastUnblock } from '$blurt/ops/block';
	import {
		getChatAdmission,
		getOrdersByAccount,
		getReputationReceipt,
		getFeedbackGiven
	} from '$lib/indexer/client';
	import { chatMoneyFlow } from '$lib/chat/orderRole';
	import { fetchAccountKeys } from '$blurt/accountKeys';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import { orderTitleParts } from '$lib/utils/orderTitle';
	import { formatDayMonthTime } from '$i18n/formatters';
	import StrangerFeeModal from '$components/StrangerFeeModal.svelte';
	import AddressShareModal from '$components/AddressShareModal.svelte';
	import FundsSentModal from '$components/FundsSentModal.svelte';
	import MailingAddressModal from '$components/MailingAddressModal.svelte';
	import ShipmentModal from '$components/ShipmentModal.svelte';
	import PayBlurtModal from '$components/PayBlurtModal.svelte';
	import { encodeFundsSentPayload, type FundsSentPayload } from '$lib/chat/payload';
	import type { ChatAssetTicker } from '$lib/chat/payload';
	import { chatAssetFromTicker, getAsset } from '$lib/assets/registry';
	import { isGoodsAsset } from '@morphit/asset-registry';
	import { computeOrderPayAmount } from '$lib/orders/payAmount';
	import { fetchFxRates } from '$lib/orders/fx';
	import { getPrice, priceStore, type PricedSymbol } from '$lib/prices';
	import type { FxResponse } from '@morphit/indexer-client';
	import { orderUsesShippableMethod } from '$lib/payments/registry';
	import {
		isUsdtNetwork,
		type UsdtNetwork,
		isUsdcNetwork,
		type UsdcNetwork,
		isDaiNetwork,
		type DaiNetwork
	} from '$lib/assets/networks';
	import { recordFundsSent, tradeStates } from '$lib/trades/tradeStatus';
	import ConfirmModal from '$components/ConfirmModal.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import VerifyPeerPanel from '$components/VerifyPeerPanel.svelte';
	import type { ProfileResponse, OrderRecord, FeedbackRecord } from '@morphit/indexer-client';

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
	/** v1.4.8 (t.txt) — false until the controller delivers its first snapshot,
	 *  so the empty area can say "…is loading" while connecting and only switch to
	 *  "No messages yet" once we KNOW the conversation is genuinely empty. */
	let hasLoadedOnce = $state(false);

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

	/** cp402 [2] — the peer's canonical BLT posting-key string, fetched
	 *  best-effort from the indexer's /keys proxy (same-origin, no
	 *  dblurt). Feeds the header IdentityLabel's `publicKeyString` so the
	 *  header shows "@peer BLT7gHu…A9bb" — the durable cryptographic
	 *  identity anchor that survives display-name changes and helps
	 *  expose impersonation. NOTE: this is the POSTING pubkey (what signs
	 *  messages / appears on block explorers), NOT the peer's X25519 chat
	 *  encryption key — different key, different purpose. Null until
	 *  resolved or if the fetch fails (IdentityLabel then just omits it). */
	let peerPostingKey = $state<string | null>(null);

	/** #4 — the peer's public reputation cluster for the header (new-trader
	 *  sprout + emerald ★ rating + trade count), mirroring the order card so
	 *  you can size up who you're chatting with at a glance. Derived from the
	 *  same reputation the order cards show (reputation-receipt summary, which
	 *  runs the identical score computation). Best-effort, same-origin; the
	 *  reputation is public on-chain data, so no privacy exposure. Null until
	 *  resolved / on failure (the cluster then just doesn't render). */
	let peerReputation = $state<{
		score: number | null;
		/** COMPLETED TRADES — what the "{count} trades" line and the 🌱 sprout
		 *  read. cp473: this line used to be fed the RATING count, so the header
		 *  stated "9 trades" for someone with 9 reviews and no trades. */
		trades: number;
		/** RATINGS that back the star average — a different number on purpose. */
		ratings: number;
		isNewTrader: boolean;
	} | null>(null);

	/** cp402 [4] — the local user's OWN canonical posting key, for the
	 *  whoami line above the user's own message runs. Same POSTING pubkey
	 *  as above (not the X25519 chat key); resolved once on mount. Shows
	 *  the counterparty the exact key that signs the user's messages, so
	 *  they can confirm it against what they see on-chain. Null until
	 *  resolved / on failure (IdentityLabel then omits the key). */
	let myPostingKey = $state<string | null>(null);

	/** cp402 [4] — the local user's own avatar, guarded to `me` so a stale
	 *  selfProfile from a just-switched account can't render on this
	 *  user's whoami. When null, IdentityLabel falls back to the heart
	 *  identicon (and, for isSelf, its own selfProfile lookup). */
	const myAvatarSvg = $derived($selfProfile.account === me ? $selfProfile.avatarSvg : null);
	const myAvatarDataUri = $derived(
		$selfProfile.account === me ? $selfProfile.avatarDataUri : null
	);

	/** cp402 [2] — when this conversation was opened about a specific
	 *  order (orderPermlink set), the resolved order record, fetched via
	 *  the peer's live orders and matched on permlink (same approach as
	 *  the order-detail page — there's no single-order endpoint). Drives
	 *  the header "RE: <order summary>" line. Null when there's no order
	 *  context, or the order is no longer live (cancelled / filled /
	 *  expired) and thus not in the peer's current book — in which case
	 *  the RE: line is simply omitted. */
	let orderRecord = $state<OrderRecord | null>(null);

	/** cp406 — which account POSTED the resolved order (peer or me). The chat
	 *  may be about the peer's order (the common case) OR our own order (the
	 *  peer opened the chat about it). Drives the RE: link author, the PDF
	 *  subject URL, and — via orderIsMine — the peer-side money-flow gating.
	 *  Null when there's no resolved order. */
	let orderOwner = $state<string | null>(null);
	/** True when the resolved order is OURS (we posted it). Flips the peer's
	 *  trade side, so Pay-now / Share-address gate correctly either way. */
	const orderIsMine = $derived(orderOwner !== null && orderOwner === me);

	// ─── v1.5.0 bidirectional feedback ──────────────────────────
	//  After a trade settles (a Payment Receipt has landed), EITHER party
	//  can review the other right here in the chat. We show the form only
	//  when the current user can review this peer for this order (a real,
	//  paid trade) AND hasn't already — the "already reviewed" check reads
	//  /feedback-given for the current user, which works in BOTH trade
	//  directions (the counterparties endpoint is owner-keyed and only
	//  answers owner→counterparty).
	let myFeedbackForPeer = $state<FeedbackRecord | null>(null);
	let feedbackChecked = $state(false);
	let justSubmittedFeedback = $state(false);
	let feedbackFetchStarted = false;
	$effect(() => {
		if (feedbackFetchStarted || orderPermlink === undefined || !me || !peer) return;
		feedbackFetchStarted = true;
		void (async () => {
			try {
				const r = await getFeedbackGiven(me, { limit: 100 });
				if (r.ok) {
					myFeedbackForPeer =
						r.data.items.find(
							(f) => f.subject === peer && f.order_permlink === orderPermlink
						) ?? null;
				}
			} catch {
				/* best-effort — the form's submit + the indexer still gate correctly */
			}
			feedbackChecked = true;
		})();
	});
	/** A funds-sent (Payment Receipt) has landed for this order — the trade
	 *  has progressed past address-sharing, so it's reviewable. */
	const tradeSettled = $derived(
		orderPermlink !== undefined &&
			(($tradeStates.get(orderPermlink)?.phase ?? 'address_shared') !== 'address_shared')
	);
	const canLeaveFeedback = $derived(
		orderPermlink !== undefined &&
			tradeSettled &&
			feedbackChecked &&
			myFeedbackForPeer === null &&
			!justSubmittedFeedback &&
			$isUnlocked &&
			!$isPairedReadOnly
	);
	function onChatFeedbackSuccess(): void {
		justSubmittedFeedback = true;
		// t155 (Ken): "that 'Feedback left:' card (or row, whatever it is) does
		// not look good. after a feedback is left, then just show a nice toast or
		// snackbar for a few seconds that says 'Feedback sent'."
		//
		// The card it replaced is gone from the markup below. Losing nothing:
		// the standing record of a review belongs on the profile and on the
		// inbox row ("I rated @x: ★★★★★"), not pinned to the top of the
		// chatroom forever — and it was showing on every reload of an old
		// conversation, long after "you just did this" stopped being news.
		showToast($_('chat.feedback.sent_toast') as string, 'success');
	}

	/** Derived block status for this peer. True iff the blocks
	 *  store contains the peer's account. Drives the Block/Unblock
	 *  button label. The store is loaded on mount below. */
	const isPeerBlocked = $derived($blockedAccounts.has(peer.toLowerCase()));

	/** t.txt item 13 — is THIS discussion (same (peer, order) key the inbox uses)
	 *  starred? Reading `$chatFolders` makes the kebab star reflect the state
	 *  live, and stay in sync with a star toggled on the inbox. */
	const threadStarred = $derived.by(() => {
		void $chatFolders;
		return isStarred(peer, orderPermlink ?? '');
	});

	/** Toggle the gold star for this discussion. Same store as the inbox, so
	 *  leaving the chatroom lands the thread under the right tab. Does NOT close
	 *  the kebab menu — the user sees the ☆ ⇄ ★ flip in place. */
	function handleToggleThreadStar(): void {
		toggleStar(peer, orderPermlink ?? '');
	}

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

	// cp406 — Chat Security (self-copy / "destroy on leave" opt-in).
	/** One-time nudge: a red dot on the kebab until the user opens Chat
	 *  Security once. Initialised safe (no dot) and corrected from storage in
	 *  the $effect below, so a seen user never sees a false dot flash. */
	let chatSecurityNudgeSeen = $state(true);
	/** Confirm modal ("destroy after you leave this chat?"). */
	let chatSecurityConfirmOpen = $state(false);
	/** Follow-up "grab your PDF" reminder, shown only after choosing destroy. */
	let pdfReminderOpen = $state(false);
	$effect(() => {
		chatSecurityNudgeSeen = readChatSecurityNudgeSeen(me);
	});

	/** Kebab → "Chat Security": close the menu, clear the one-time dot, and
	 *  open the confirm modal. */
	function openChatSecurity(): void {
		overflowMenuOpen = false;
		markChatSecurityNudgeSeen(me);
		chatSecurityNudgeSeen = true;
		chatSecurityConfirmOpen = true;
	}
	/** "Yes, destroy them" → PFS mode + the PDF reminder. */
	function onChatSecurityConfirm(): void {
		chatSecurityConfirmOpen = false;
		writeChatSecurityMode(me, 'destroy');
		pdfReminderOpen = true;
	}
	/** "No, keep them" → the default keep-history mode. */
	function onChatSecurityCancel(): void {
		chatSecurityConfirmOpen = false;
		writeChatSecurityMode(me, 'keep');
	}
	/** "Get my PDF now" → export, then close. */
	async function onPdfReminderConfirm(): Promise<void> {
		pdfReminderOpen = false;
		await exportChatToPdf();
	}
	/** "Later" → just close; destroy mode is already saved. */
	function onPdfReminderCancel(): void {
		pdfReminderOpen = false;
	}

	function openVerifyPeer(): void {
		closeOverflowMenu();
		verifyPeerOpen = true;
	}

	/** cp404 — export this conversation as a printable transcript. Chat is
	 *  E2EE, so the document is built entirely client-side from the
	 *  already-decrypted in-memory messages: a self-contained HTML page is
	 *  opened in a new window and handed to the browser's print dialog,
	 *  where the user chooses "Save as PDF". Zero added dependencies (the
	 *  tiny-footprint priority) and no plaintext ever leaves the browser.
	 *  Timestamps use the canonical UTC formatter; labels are localized. */
	/** cp404 — export this conversation as a LOCKED, courtroom-grade
	 *  legal record. Chat is E2EE, so the document is built entirely
	 *  client-side from the already-decrypted in-memory messages; no
	 *  plaintext leaves the browser.
	 *
	 *  Tamper-resistance has two layers:
	 *    1. The PDF is locked (a random owner password + a permission set
	 *       that allows view / print / copy but NOT modification or
	 *       annotation), so it can't be casually edited.
	 *    2. The REAL evidence: every message cites its Blurt transaction
	 *       id, so the record's integrity is anchored to the public,
	 *       immutable blockchain — anyone can re-verify each line against
	 *       any Blurt explorer, and altering the text here would no longer
	 *       match the chain.
	 *
	 *  jsPDF is dynamically imported so it is code-split and only fetched
	 *  when a user actually exports (footprint + lazy-load). */
	async function exportChatToPdf(): Promise<void> {
		closeOverflowMenu();
		const { jsPDF } = await import('jspdf');

		const t = (k: string, v?: Record<string, string | number>): string =>
			(v ? $_(k, { values: v }) : $_(k)) as string;

		// Lock against edits: random owner password, view/print/copy only.
		const ownerPassword = Array.from(crypto.getRandomValues(new Uint8Array(24)))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		const doc = new jsPDF({
			unit: 'pt',
			format: 'a4',
			encryption: { ownerPassword, userPermissions: ['print', 'copy'] }
		});

		// cp406 [D1] — Document Properties surfaced by PDF readers. Title
		// mirrors the visible heading (localized, = "Morphit chat with @peer");
		// Author is the exporting account; Subject is the canonical order URL
		// when this chat is about an order. The order owner may be either party,
		// and we use this instance's own origin so a federated node's export
		// links back to itself.
		doc.setDocumentProperties({
			title: t('chat.export.title', { peer }),
			author: `@${me}`,
			...(orderOwner && orderPermlink
				? { subject: `${window.location.origin}${lp(`/@${orderOwner}/${orderPermlink}`)}` }
				: {})
		});

		const PAGE_W = doc.internal.pageSize.getWidth();
		const PAGE_H = doc.internal.pageSize.getHeight();
		const M = 48;
		const CW = PAGE_W - M * 2;
		let y = M;
		let pageNo = 1;

		const footer = (): void => {
			doc.setFont('helvetica', 'normal');
			doc.setFontSize(7);
			doc.setTextColor(140);
			doc.text(t('chat.export.footer'), M, PAGE_H - 24);
			doc.text(String(pageNo), PAGE_W - M, PAGE_H - 24, { align: 'right' });
			doc.setTextColor(20);
			pageNo += 1;
		};

		const ensure = (need: number): void => {
			if (y + need > PAGE_H - M - 28) {
				footer();
				doc.addPage();
				y = M;
			}
		};

		const para = (
			text: string,
			size: number,
			opts: { font?: string; style?: string; gap?: number; color?: number } = {}
		): void => {
			doc.setFont(opts.font ?? 'helvetica', opts.style ?? 'normal');
			doc.setFontSize(size);
			doc.setTextColor(opts.color ?? 20);
			const lh = size * 1.42;
			for (const ln of doc.splitTextToSize(text, CW) as string[]) {
				ensure(lh);
				doc.text(ln, M, y);
				y += lh;
			}
			y += opts.gap ?? 0;
		};

		// ─── Header ───
		para(t('chat.export.title', { peer }), 16, { style: 'bold', gap: 2 });
		para(t('chat.export.subtitle'), 9, { color: 90, gap: 12 });

		// ─── Parties (accounts + the posting keys that sign their messages) ───
		para(t('chat.export.parties_heading'), 10, { style: 'bold', gap: 3 });
		para(`${t('chat.export.you')} \u2014 @${me}`, 9.5, { style: 'bold' });
		if (myPostingKey)
			para(`${t('chat.export.posting_key_label')}: ${myPostingKey}`, 8, {
				font: 'courier',
				color: 90,
				gap: 3
			});
		para(`@${peer}`, 9.5, { style: 'bold' });
		if (peerPostingKey)
			para(`${t('chat.export.posting_key_label')}: ${peerPostingKey}`, 8, {
				font: 'courier',
				color: 90,
				gap: 3
			});

		if (orderSummary) para(t('chat.export.regarding', { summary: orderSummary }), 9, { gap: 2 });
		para(t('chat.export.exported_at', { datetime: formatDayMonthTime(new Date().toISOString()) }), 8, {
			color: 90,
			gap: 12
		});

		// ─── Plain-language verification explainer ───
		para(t('chat.export.verify_heading'), 10, { style: 'bold', gap: 3 });
		para(t('chat.export.verify_body'), 8.5, { color: 60, gap: 12 });

		ensure(16);
		doc.setDrawColor(205);
		doc.line(M, y, PAGE_W - M, y);
		y += 14;

		// ─── The conversation ───
		if (messages.length === 0) {
			para(t('chat.export.no_messages'), 9.5, { color: 120 });
		} else {
			for (const m of messages) {
				const when = m.createdAt ? formatDayMonthTime(m.createdAt.toISOString()) : '';
				const who = m.sender === me ? `${t('chat.export.you')} (@${me})` : `@${peer}`;
				// Sender + timestamp line.
				ensure(13 * 1.42);
				doc.setFont('helvetica', 'bold');
				doc.setFontSize(9);
				doc.setTextColor(20);
				doc.text(who, M, y);
				doc.setFont('helvetica', 'normal');
				doc.setFontSize(8);
				doc.setTextColor(120);
				doc.text(when, PAGE_W - M, y, { align: 'right' });
				y += 13 * 1.42;
				// Message body (decrypted plaintext, or an encrypted-marker).
				para(m.decryptFailed ? t('chat.export.encrypted') : m.text, 9.5, { color: 25, gap: 1 });
				// On-chain proof — the verifiable anchor for this line.
				const proof = m.trxId
					? `${t('chat.export.proof_label')}: ${m.trxId}`
					: `${t('chat.export.proof_label')}: ${t('chat.export.pending_label')}`;
				para(proof, 7.5, { font: 'courier', color: 110, gap: 10 });
			}
		}

		footer();

		const dateStr = new Date().toISOString().slice(0, 10);
		doc.save(`Morphit-chat-${peer}-${dateStr}.pdf`);
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
	/** cp121 — physical-shipment + mailing-address modal state.
	 *  Generic across cash-by-mail and goods-by-mail flows. */
	let showMailingAddressModal = $state(false);
	let showShipmentModal = $state(false);
	/** Q5 — Mark-as-sent prefill from an incoming address pill
	 *  (BTC/XMR/USDT/USDC/DAI/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/SOL/
	 *  ETH/XRP — all 15 single-side methods; BLURT pays via the
	 *  separate PayBlurtModal path).  Held separately from
	 *  showFundsSentModal so the composer-level "I sent it"
	 *  button (no prefill) and the pill-level Mark-as-sent
	 *  button (with prefill) share the modal but supply
	 *  different starting state. */
	let markSentArgs = $state<{
		method:
			| 'btc'
			| 'xmr'
			| 'usdt'
			| 'usdc'
			| 'dai'
			| 'bch'
			| 'ltc'
			| 'dash'
			| 'doge'
			| 'zec'
			| 'arrr'
			| 'dcr'
			| 'sol'
			| 'eth'
			| 'xrp';
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
		/** cp402 [7b] — true when opened from the composer "Pay now"
		 *  (no pill), so PayBlurtModal shows a validated amount input. */
		amountEditable?: boolean;
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

	// cp121: handlers for the two new modal types.  Same shape
	// as handleAddressShare — sendMessage(payload) routes through
	// the existing chat-send path (E2E encrypted by the conv
	// controller before it reaches the relay).
	async function handleMailingAddressShare(payload: string): Promise<void> {
		if (!controller) throw new Error('controller_not_ready');
		await controller.sendMessage(payload);
		await tick();
		scrollToBottom(true);
		showMailingAddressModal = false;
	}

	async function handleShipmentShare(payload: string): Promise<void> {
		if (!controller) throw new Error('controller_not_ready');
		await controller.sendMessage(payload);
		await tick();
		scrollToBottom(true);
		showShipmentModal = false;
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
	 *  (BTC/XMR/USDT/USDC/DAI/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/SOL/
	 *  ETH/XRP).  Captures the seller's specified method+amount
	 *  and opens FundsSentModal pre-filled. Critical for the
	 *  Monero amount-jitter flow: the buyer's funds-sent echo
	 *  MUST carry the same jittered amount the seller asked for,
	 *  otherwise the seller's verification false-mismatches.
	 *
	 *  We don't open PayBlurtModal here — Morphit doesn't run an
	 *  external-chain wallet of its own.  The buyer pays from
	 *  their own wallet (scanning the QR / pasting the address),
	 *  then comes back to this modal with the txid in hand. */
	function handleMarkSentClick(args: {
		method:
			| 'btc'
			| 'xmr'
			| 'usdt'
			| 'usdc'
			| 'dai'
			| 'bch'
			| 'ltc'
			| 'dash'
			| 'doge'
			| 'zec'
			| 'arrr'
			| 'dcr'
			| 'sol'
			| 'eth'
			| 'xrp';
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
	async function handlePaidBlurt(args: {
		trxId: string;
		blockNum: number;
		amount: number;
	}): Promise<void> {
		const stagedArgs = payBlurtArgs;
		payBlurtArgs = null;
		if (stagedArgs === null) return;

		// F-43 part 1: ensure trade-status reflects the payment
		// regardless of whether the chat broadcast succeeds.  Use
		// the orderPermlink from staged args; if absent (rare —
		// pay-now without an order context), the store can't anchor
		// the entry by permlink and we skip this step.
		//
		// cp402 [7b] — the AMOUNT comes from `args` (what PayBlurtModal
		// actually broadcast), NOT stagedArgs: in the composer flow the
		// staged amount is a 0 placeholder and the real value was entered
		// in-modal. For the pill flow the two are identical.
		if (stagedArgs.orderPermlink !== undefined) {
			recordFundsSent({
				orderPermlink: stagedArgs.orderPermlink,
				peer,
				method: 'blurt',
				txid: args.trxId,
				claimedMemo: stagedArgs.memo !== '' ? stagedArgs.memo : undefined,
				amount: args.amount,
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
			amount: String(args.amount),
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
	/** tt.txt #8 — the first batch of messages must land the user at the NEWEST
	 *  message. Smooth-scrolling to a scrollHeight measured before the list has
	 *  laid out drops them in the middle of the history. Jump instantly, then
	 *  re-pin while the content settles. */
	let initialScrollDone = false;
	let cancelPin: (() => void) | null = null;

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
		// cp474 (t.txt #7) — cancel the pin only when the scroll LEAVES the bottom.
		//
		// This used to cancel on ANY scroll event, which meant the pin killed
		// itself: `pinToBottom` works by assigning `scrollTop`, the browser fires a
		// scroll event for that assignment on the next frame, and this handler tore
		// the pin down before it had re-pinned even once. The "keep it pinned while
		// the content settles" window was therefore never real — first load was a
		// single instant jump, and anything that grew the list afterwards (web-font
		// swap, the Payment Receipt bubble, decrypted bodies, avatars) pushed the
		// newest message back below the fold. That is Ken's "STILL does not always
		// scroll to the last message".
		//
		// Testing the POSITION instead of the event source needs no flags or
		// timers and is what we actually mean: our own pin always lands AT the
		// bottom, so it can never cancel itself; a user scrolling UP leaves the
		// bottom and cancels instantly, which is the property that matters (never
		// fight a user who scrolled); and a user scrolling DOWN to the bottom is
		// asking for the bottom, so leaving the pin alone is correct there too.
		if (!userAtBottom) {
			cancelPin?.();
			cancelPin = null;
		}
		if (userAtBottom) {
			unreadWhileScrolledUp = 0;
		}
	}

	/** Ken — day separators in the message log. Grouping + the pending-message
	 *  rule live in `$lib/chat/daySeparator` so they can be unit-tested; this
	 *  wrapper just turns the returned Date into the sitewide label. */
	function daySeparatorLabelAt(i: number): string | null {
		const at = daySeparatorAt(messages, i);
		return at ? formatDayMonth(at) : null;
	}

	async function loadPeerProfile(): Promise<void> {
		peerProfile = await getProfileCached(peer);
	}

	/** #4 — fetch the peer's public reputation for the header cluster. The
	 *  reputation-receipt summary carries the SAME composite `reputation_score`
	 *  the order cards show, the received-RATING count that backs the star
	 *  average, and (cp473) the COMPLETED-TRADE count the 🌱 sprout keys off —
	 *  the same rule the order cards use since v1.5.5.
	 *  Best-effort + silent on failure — the cluster is a nice-to-have, never a
	 *  blocker for the conversation.
	 *
	 *  cp473 — this previously read `isNewTrader: count_total < 4`, which was
	 *  wrong twice over, on the surface where it matters most (the chat header
	 *  is where you size up a stranger before handing them money):
	 *
	 *    1. `count_total` counts RATINGS, so the sprout meant "<4 reviews" here
	 *       while the order card next to it meant "<4 trades".
	 *    2. Worse, `count_total` is the receipt's deliberately UNFILTERED total
	 *       — it includes the rows the indexer threw out as suspicious_
	 *       reciprocity / related_accounts / one_way_pile_on / review_
	 *       concentration fraud. So four sock-puppet reviews that contributed
	 *       NOTHING to the score still cleared the sprout, quietly retiring the
	 *       "new trader, be careful" warning for an account whose real
	 *       reputation was zero. The score stayed null; only the warning went.
	 */
	async function loadPeerReputation(): Promise<void> {
		try {
			const r = await getReputationReceipt(peer);
			if (!r.ok) return;
			// The count that backs the star average is the INCLUDED one, not the
			// receipt's raw total (which deliberately counts excluded fraud).
			const ratings = r.data.summary.count_included;
			const trades = r.data.summary.trade_count ?? 0;
			peerReputation = {
				score: r.data.summary.reputation_score ?? null,
				trades,
				ratings,
				isNewTrader: trades < 4
			};
		} catch {
			peerReputation = null;
		}
	}

	/** cp402 [2] — fetch the peer's canonical posting key for the header
	 *  identity anchor. Best-effort, same-origin (indexer /keys proxy —
	 *  no browser→RPC, no dblurt). Silent on failure. */
	async function loadPeerPostingKey(): Promise<void> {
		try {
			const keys = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), peer, fetch);
			const k = keys?.posting?.key_auths?.[0]?.[0];
			peerPostingKey = typeof k === 'string' ? k : null;
		} catch {
			peerPostingKey = null;
		}
	}

	/** cp402 [4] — same as loadPeerPostingKey but for the local user, so
	 *  the whoami above the user's own message runs shows their real
	 *  posting-key anchor. Same-origin, best-effort, silent on failure. */
	async function loadMyPostingKey(): Promise<void> {
		if (!me) return;
		try {
			const keys = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), me, fetch);
			const k = keys?.posting?.key_auths?.[0]?.[0];
			myPostingKey = typeof k === 'string' ? k : null;
		} catch {
			myPostingKey = null;
		}
	}

	/** cp402 [2] — when opened about an order, resolve it for the header
	 *  "RE:" line. No single-order endpoint exists, so (like the
	 *  order-detail page) we fetch the peer's live orders and match on
	 *  permlink. Best-effort: on failure or a no-longer-live order the
	 *  RE: line is just omitted. */
	async function loadOrderContext(): Promise<void> {
		if (!orderPermlink) return;
		// The order may belong to EITHER party: usually the peer (we opened the
		// chat from their order), but also us (they opened the chat about OUR
		// order). Try the peer's book first, then our own, and remember whose it
		// is so the RE: link, the PDF subject, and the trade-role gating point at
		// the right author. Best-effort: on failure / no-longer-live order the
		// RE: line is just omitted.
		for (const owner of [peer, me]) {
			try {
				const r = await getOrdersByAccount(owner, { limit: 100 });
				if (!r.ok) continue;
				const found = r.data.items.find((o) => o.permlink === orderPermlink);
				if (found) {
					orderRecord = found;
					orderOwner = owner;
					return;
				}
			} catch {
				/* try the next book */
			}
		}
		orderRecord = null;
		orderOwner = null;
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
			hasLoadedOnce = true;
			// After DOM updates, decide how to handle scroll.
			void tick().then(() => {
				if (!initialScrollDone && messages.length > 0) {
					// FIRST paint of this conversation: be at the bottom, don't
					// animate toward where the bottom used to be.
					initialScrollDone = true;
					cancelPin?.();
					cancelPin = pinToBottom(scrollEl);
					unreadWhileScrolledUp = 0;
				} else if (wasAtBottom) {
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
		// #4 — peer reputation cluster for the header.
		void loadPeerReputation();
		// cp402 [2] — header identity anchor + order-context "RE:" line.
		void loadPeerPostingKey();
		void loadMyPostingKey();
		void loadOrderContext();
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

	/** #19 (Ken) — the inbox card stayed lit green (and bordered) for a peer he
	 *  had *just* been chatting with.
	 *
	 *  The conversation was acknowledged as read exactly ONCE, on mount, from the
	 *  /chat/[peer] route. Every message exchanged afterwards — his own included —
	 *  carries a chain timestamp LATER than that ack, so the moment he returned to
	 *  the inbox `isUnread()` said yes.
	 *
	 *  Worse, the ack stored the browser's `Date.now()` while `last_message_at`
	 *  comes from the chain. Any clock skew in the wrong direction pinned the
	 *  conversation to "unread" permanently, no matter how many times he opened it.
	 *
	 *  So: acknowledge with the newest CONFIRMED message we've actually rendered
	 *  (clock-independent), and keep acknowledging as the conversation proceeds —
	 *  not just when it opens, but every time a message lands while the tab is
	 *  visible, and once more on the way out. */
	function latestConfirmedAt(): Date | null {
		let newest: Date | null = null;
		for (const m of messages) {
			const at = m.createdAt;
			if (at === null) continue; // still pending: the chain hasn't stamped it
			if (newest === null || at.getTime() > newest.getTime()) newest = at;
		}
		return newest;
	}

	function ackRead(): void {
		if (!peer) return;
		// cp446 — ack THIS discussion. `orderPermlink` is the thread's identity;
		// `''` is the thread that cites no order, which is a real thread of its own.
		markConversationRead(peer, orderPermlink ?? '', readAckTimestamp(latestConfirmedAt()));
	}

	$effect(() => {
		// Re-runs whenever the message list changes. Acking while the tab is
		// hidden would mark messages read that the user never saw.
		void messages.length;
		if (typeof document !== 'undefined' && document.hidden) return;
		ackRead();
	});

	onDestroy(() => {
		cancelPin?.();
		cancelPin = null;
		// Leaving the conversation: everything on screen has been seen.
		ackRead();
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

	/** cp402 [2] — the header "RE:" order summary, e.g. "I'm buying 500
	 *  MXN or more worth of BLURT". Built from the resolved order via the
	 *  shared orderTitleParts helper (identical phrasing to the orderbook
	 *  + order-detail pages). Empty when there's no order context (no
	 *  orderPermlink, or the order is no longer live). */
	/** Ken — show the order's CURRENT status beside the RE: line, so a trader who
	 *  opens an old conversation can see at a glance whether the thing they are
	 *  negotiating over still exists. Reuses `order_detail.status_*`, which is
	 *  already translated in all ten locales; no new strings. */
	const orderStatusLabel = $derived.by(() => {
		if (!orderRecord) return '';
		switch (orderRecord.status) {
			case 'live':
				return $_('order_detail.status_live') as string;
			case 'cancelled':
				return $_('order_detail.status_cancelled') as string;
			case 'expired':
				return $_('order_detail.status_expired') as string;
			default:
				return '';
		}
	});

	const orderSummary = $derived.by(() => {
		if (!orderRecord) return '';
		const parts = orderTitleParts(
			{
				side: orderRecord.side,
				asset: orderRecord.asset,
				fiat_currency: orderRecord.fiat_currency,
				amount_min: orderRecord.amount_min,
				amount_max: orderRecord.amount_max
			},
			undefined,
			$_('order_title.goods_services')
		);
		return $_(parts.key, { values: parts.values }) as string;
	});

	// ─── cp402 [6] / cp406 — crypto-payment direction ────────────
	//
	// The chat's button gating is expressed from the PEER's side: peer BUYS the
	// asset ⇒ the peer receives the crypto and I send it (I'm the crypto-SENDER,
	// I use "Pay now"); peer SELLS ⇒ the peer sends the crypto and I receive it
	// (I'm the crypto-RECEIVER, I share a receiving address). An order's raw
	// `side` is the POSTER's perspective, so we translate it to the peer's side
	// via peerCryptoSide (inside chatMoneyFlow): as-is when the order is the
	// peer's, flipped when the order is ours (orderIsMine). cp406 (Ken): with
	// NO live-order context — an unsolicited chat opened from a profile's
	// Message button, or a chat whose order is no longer live (cancelled /
	// filled) — none of these money-flow controls belong on screen at all, so
	// chatMoneyFlow returns both false and every button below is hidden. The
	// physical mailing/shipment controls are gated the same way (they depend on
	// these + orderCanShip, which also needs a live order — see below).
	// Both crypto buttons come from the one tested pure helper (chatMoneyFlow):
	// no live order ⇒ both false; a live order ⇒ exactly one true.
	const cryptoButtons = $derived(chatMoneyFlow(orderRecord, orderIsMine));
	/** I send the crypto ⇒ show "Pay now". Only when a live order is connected
	 *  AND the peer is buying the asset. Hidden with no live order. */
	const showPayNowButton = $derived(cryptoButtons.payNow);
	/** I receive the crypto ⇒ show "Share crypto address". Only when a live
	 *  order is connected AND the peer is selling. Hidden with no live order. */
	const showShareAddressButton = $derived(cryptoButtons.shareAddress);

	// cp406 (Ken) — the "Share mailing address" + "Record shipment" controls
	// only matter when the trade moves a PHYSICAL thing that can be posted:
	// barter goods, precious metals, or cash-by-mail. A plain crypto↔fiat trade
	// paid in person / online / on-chain never ships anything, so those two
	// buttons stay hidden to keep the composer grandma-simple. Cash-in-person is
	// physical but face-to-face only → not shippable.
	//
	// WHICH of the two each party sees follows a hard invariant: the physical
	// thing IS the payment for the crypto. So whoever RECEIVES the crypto is the
	// one paying physically — they SHIP it ("Record shipment"); whoever SENDS
	// the crypto is receiving that physical payment — they say where to send it
	// ("Share mailing address"). This holds identically for barter, precious
	// metals, and cash-by-mail. It maps straight onto the crypto-direction
	// gating above: crypto receiver (showShareAddressButton) ships; crypto
	// sender (showPayNowButton) shares a mailing address.
	const orderCanShip = $derived(
		orderRecord !== null && orderUsesShippableMethod(orderRecord.payment_methods)
	);
	/** I RECEIVE crypto ⇒ I'm paying with the physical item ⇒ I ship it. */
	const showRecordShipmentButton = $derived(orderCanShip && showShareAddressButton);
	/** I SEND crypto ⇒ I'm receiving the physical payment ⇒ I share where. */
	const showShareMailingButton = $derived(orderCanShip && showPayNowButton);

	/** cp406 (Ken) — the whole money-flow toolbar shows only when at least one
	 *  of its buttons would. Since every button above requires a live order,
	 *  this collapses to "a live order is connected" — an unsolicited chat
	 *  (profile Message button) or a chat whose order went non-live renders no
	 *  toolbar strip at all, rather than an empty bordered bar. */
	const showChatActionToolbar = $derived(
		showPayNowButton || showShareAddressButton || showShareMailingButton || showRecordShipmentButton
	);

	/** cp402 [7a] / cp406 — when the composer "Pay now" (no pill context, so
	 *  `markSentArgs === null`) is opened about an order, the funds-sent / pay
	 *  modal locks its asset to the order's asset so a user cannot send the
	 *  wrong coin, and BLURT is routed to PayBlurtModal. `undefined` (free
	 *  picker) when there's no order, the asset isn't a tradable chat asset, or
	 *  a pill drove the modal.
	 *
	 *  cp406 FIX: `OrderRecord.asset` is the canonical UPPERCASE AssetTicker
	 *  ('BLURT') while ChatAssetTicker is lower-case ('blurt'); the old inline
	 *  check compared them directly and ALWAYS failed, so the lock never engaged
	 *  and every order fell back to the free 16-coin picker. `chatAssetFromTicker`
	 *  folds the case. */
	const composerPayNowAsset = $derived(
		markSentArgs === null && orderRecord && !isGoodsAsset(orderRecord.asset)
			? (chatAssetFromTicker(orderRecord.asset) ?? undefined)
			: undefined
	);

	// cp425 — for a BARTER order, the settlement modals restrict their coin
	// picker to the cryptos the seller ACCEPTS (the order's accepted_assets),
	// mapped to lower-case ChatAssetTickers. Undefined for a crypto order (no
	// restriction). This is what keeps a barter trade settling in an accepted
	// coin instead of any of the 16.
	const barterAcceptedMethods = $derived.by((): readonly ChatAssetTicker[] | undefined => {
		const o = orderRecord;
		if (!o || !isGoodsAsset(o.asset)) return undefined;
		const out: ChatAssetTicker[] = [];
		for (const t of o.accepted_assets ?? []) {
			const m = chatAssetFromTicker(t);
			if (m !== null && !out.includes(m)) out.push(m);
		}
		return out;
	});

	// ─── cp406: Pay-now amount pre-fill ──────────────────────────
	// Seed the "Pay now" modal with the crypto amount equal to the order's fiat
	// minimum, at the order's price, so a non-technical user doesn't have to do
	// the conversion by hand. A FIXED-price order resolves with no live data;
	// a market/spread order needs the FX table + the asset's live USD price,
	// fetched below ONLY for that case. computeOrderPayAmount returns null (→
	// leave the field blank) whenever it can't be derived safely — for a money
	// field, blank always beats a confidently-wrong seed.
	let fxTable = $state<FxResponse | null>(null);

	$effect(() => {
		const o = orderRecord;
		if (!o) return;
		// cp425 — barter has no crypto price (valued in fiat directly); never
		// fetch a price for a goods asset (o.asset='BARTER' isn't a PricedSymbol).
		if (isGoodsAsset(o.asset)) return;
		const pm = o.price_model as Record<string, unknown> | null;
		// Only market/spread orders need live data; fixed prices are exact.
		if (!pm || pm.kind !== 'spread') return;
		void getPrice(o.asset as PricedSymbol).catch(() => {});
		if (fxTable === null) {
			void fetchFxRates(resolveOrigin(MORPHIT_INDEXER_ORIGIN), fetch).then((res) => {
				if (res.kind === 'ok') fxTable = res.table;
			});
		}
	});

	const payPrefill = $derived.by(() => {
		const o = orderRecord;
		if (!o) return null;
		// cp425 — no crypto pay-amount to seed for a barter order.
		if (isGoodsAsset(o.asset)) return null;
		const marketUsd = $priceStore[o.asset as PricedSymbol]?.usd ?? null;
		return computeOrderPayAmount(o, fxTable, marketUsd);
	});

	/** payPrefill rounded to the order asset's native decimals (capped at 8 for
	 *  a sane input) as a positive number; null when there is nothing to seed
	 *  (uncomputable price, or the composer isn't locked to a chat asset). */
	const payPrefillAmount = $derived.by((): number | null => {
		const pre = payPrefill;
		const asset = composerPayNowAsset;
		if (pre === null || !asset) return null;
		const decimals = Math.min(getAsset(asset).decimals, 8);
		const rounded = Number(pre.amount.toFixed(decimals));
		return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
	});
	/** String form for FundsSentModal.initialAmount (empty = no seed). */
	const payPrefillStr = $derived(payPrefillAmount !== null ? String(payPrefillAmount) : '');

	/** cp406 — one-line caption for the modal explaining the seeded amount: the
	 *  order's fiat minimum + its crypto equivalent, with a market-price caveat
	 *  when the estimate rides on a live price. Empty unless there's a pre-fill
	 *  (composer flow only), so the pill flow shows no caption. */
	const payPrefillHint = $derived.by((): string => {
		const pre = payPrefill;
		const amt = payPrefillAmount;
		const o = orderRecord;
		if (pre === null || amt === null || !o || o.amount_min === null || markSentArgs !== null) {
			return '';
		}
		return $_(pre.approximate ? 'chat.pay_prefill.hint_market' : 'chat.pay_prefill.hint', {
			values: {
				min: String(o.amount_min),
				fiat: o.fiat_currency,
				amount: String(amt),
				asset: o.asset
			}
		}) as string;
	});

	// ─── Send handler ────────────────────────────────────────────

	async function handleSend(text: string): Promise<void> {
		if (!controller) return;

		await controller.sendMessage(text);

		// After send, always force-scroll to bottom — the user
		// sending IS an expression of attention on the conversation.
		await tick();
		scrollToBottom(true);
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
<div class="chat-conversation flex min-h-0 flex-1 flex-col">
	<!-- Header block: peer identity + block button, plus a
	     transient StatusLine for failure messages that sits
	     below the header row. -->
	<div class="flex-none border-b border-ink-200 bg-white dark:border-ink-800 dark:bg-ink-950">
		<!-- Ken — the header row wears the same dim emerald the FAQ entries use on
		     hover (`.card-hover-emerald`: `bg-emerald-50/30` /
		     `dark:bg-morphit-emerald/[0.05]`). Reusing those exact tokens rather than
		     eyeballing a new green keeps one dim-emerald in the palette, and it
		     separates the header from the sticky bar above and the transcript below. -->
		<header
			class="chat-header flex items-start justify-between gap-3 bg-emerald-50/30 px-4 py-3 dark:bg-morphit-emerald/[0.05]"
		>
			<!-- cp402 [2] / tt.txt #7 — peer identity + context. "Chatting with:"
			     lead-in, then an order-card-shaped identity cluster (avatar, name +
			     sprout, posting key + trades + reputation, RE: line), then the kebab
			     as the last item of that same row. Replaces the old 📌 banner that
			     used to sit below the header. -->
			<div class="flex min-w-0 flex-1 flex-col gap-1">
				<span class="text-xs text-ink-500 dark:text-ink-400"
					>{$_('chat.header.chatting_with')}:</span
				>

				<!-- tt.txt #7 (Ken) — laid out like the order cards, and for the same
				     reason: on a phone the old single-line IdentityLabel left no room
				     for the sprout / trade count / reputation, so they wrapped or were
				     squeezed against the kebab.

				     avatar │ line 1: display name + 🌱 sprout
				            │ line 2: posting key · ★ rating · trades  (TradeRepCluster)
				            │ line 3: RE: <order title>   (when there's an order)

				     The kebab is the last flex item of THIS row, so `items-start` makes
				     its top sit level with the display name — not with the "Chatting
				     with:" lead-in above it. -->
				<div class="flex items-start gap-3">
					<!-- v1.7.5 (t.txt #8) — `self-center` on the AVATAR only.
					     Ken: "the avatar image is not properly vertically aligned with the
					     3 (sometimes 2) lines of text that appear to the right of it. i love
					     its current size though, so please do not change that." — so the size
					     stays 48 and only the alignment moves.
					     The row keeps `items-start` because the KEBAB depends on it: it is the
					     last flex item of this same row, and its top must sit level with the
					     display name rather than drift to the middle of a 2- or 3-line block.
					     Centring the row would fix the avatar and break the kebab. `self-center`
					     overrides the alignment for this one item, which is exactly the ask —
					     and it self-adjusts between the 2-line (no order) and 3-line (RE: line)
					     cases with no measuring. -->
					<div class="flex-none self-center">
						<IdentityLabel
							account={peer}
							avatarSvg={peerLabelProps.avatarSvg}
							avatarDataUri={peerLabelProps.avatarDataUri}
							avatarSize={48}
							hideHandle
						/>
					</div>

					<div class="min-w-0 flex-1">
						<!-- Line 1 — display name, then the sprout at the END of the name,
						     exactly as the order cards do it. -->
						<div class="flex items-center gap-x-2">
							<a
								href={lp(`/@${peer}`)}
								class="truncate font-bold text-ink-900 hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-white"
							>
								{peerLabelProps.displayName || `@${peer}`}
							</a>
							{#if peerReputation?.isNewTrader}
								<NewTraderChip />
							{/if}
							{#if peerReputation}
								<!-- Ken: the reputation must NEVER wrap. On a narrow viewport line 2
								     (key · trades · rating) is the line that runs out of room, so the
								     cluster moves up here instead. `sm:hidden` / `hidden sm:inline-flex`
								     is a deterministic split — no measuring, no layout thrash, and the
								     posting key (the trust anchor) never gets truncated to make room
								     for it. The name beside it truncates, so the cluster always fits.
								
								     v1.7.5 (t.txt #8) — this was a hand-rolled `⭐ 3.42`, and being
								     hand-rolled is exactly why it was wrong in BOTH ways Ken reported:
								     the emoji renders GOLD (the app's star convention is the emerald ★,
								     settled in v1.5.5), and it printed the score alone — so the trade
								     count and the rating count were simply absent, on the screen where
								     you decide whether to trust a stranger with money. TradeRepCluster
								     is what the order cards already use: emerald, both counts, one
								     unbreakable chunk. -->
								<span class="sm:hidden">
									<TradeRepCluster
										tradeCount={peerReputation.trades}
										rating={peerReputation.score}
										ratingCount={peerReputation.ratings}
									/>
								</span>
							{/if}
						</div>

						<!-- Line 2 — the durable identity anchor (posting key), then the
						     two reputation signals a trader actually decides on. -->
						<!-- `flex-nowrap`: this line must never break. The key truncates (it
						     already renders truncated), the trade count and score never do. -->
						<div
							class="mt-0.5 flex min-w-0 flex-nowrap items-center gap-x-2 text-xs text-ink-500 dark:text-ink-400"
						>
							{#if peerPostingKey}
								<span class="truncate font-mono">({truncatePublicKey(peerPostingKey)})</span>
							{/if}
							{#if peerReputation}
								<!-- v1.7.5 (t.txt #8) — ONE cluster, replacing a hand-rolled trades
								     span PLUS a hand-rolled `⭐ score`. Same component as the order
								     cards, so the star is emerald rather than the gold emoji and the
								     RATING count "(34)" finally appears beside the average it backs —
								     Ken reported both as wrong/missing here.
								     cp473's distinction survives inside the component: trades are
								     completed ORDERS, ratings are reviews, and fusing them would make the
								     chip lie (this line once announced "9 trades" for 9 reviews and no
								     trades). Zero trades still renders nothing.
								     `hidden sm:inline-flex`: on a phone this line is just the key, and the
								     cluster rides line 1 instead. -->
								<span class="hidden sm:inline-flex">
									<TradeRepCluster
										tradeCount={peerReputation.trades}
										rating={peerReputation.score}
										ratingCount={peerReputation.ratings}
									/>
								</span>
							{/if}
						</div>

						<!-- Line 3 — RE: <order>. Whole line is the tap target (mobile +
						     grandma friendly); the label stays put while the summary
						     truncates, full text in the hover title. -->
						{#if orderSummary}
							<a
								href={lp(`/@${orderOwner ?? peer}/${orderPermlink}`)}
								class="mt-0.5 flex min-w-0 items-baseline gap-1 text-xs text-ink-500 hover:text-morphit-emerald hover:underline dark:text-ink-400"
								title={orderSummary}
							>
								<span class="flex-none font-medium">{$_('chat.header.re')}:</span>
								<span class="truncate">{orderSummary}</span>
								{#if orderStatusLabel}
									<!-- Status last and `flex-none`: the title truncates, the status
									     never does. A trader deciding whether to keep negotiating
									     needs "(Cancelled)" more than the tail of the title. -->
									<span class="flex-none">({orderStatusLabel})</span>
								{/if}
							</a>
						{/if}
					</div>

					<!-- Kebab: last item of the identity row, so its top is level with
					     the display name. LIVE now lives INSIDE this menu (see below). -->
					<div class="flex-none">
						{#if $isUnlocked}
							<!-- Overflow (kebab) menu. Single home for every peer action:
							     Chat Security / Verify peer / Block / Export, with the LIVE
							     indicator pinned above them. cp402: the standalone Block
							     button was removed from the header row. -->
							<div class="relative">
						<button
							type="button"
							bind:this={overflowTriggerEl}
							class="relative rounded-xl bg-white px-2 py-1.5 text-ink-700 hover:bg-ink-100 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-ink-800"
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
							{#if !chatSecurityNudgeSeen}
								<!-- cp406 — one-time nudge dot inviting discovery of Chat
								     Security. Cleared for good the first time the item is opened. -->
								<span
									class="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white dark:ring-ink-900"
									aria-hidden="true"
								></span>
							{/if}
						</button>
						{#if overflowMenuOpen}
							<div
								bind:this={overflowMenuEl}
								class="absolute right-0 top-full z-40 mt-1 min-w-[12rem] rounded-lg border border-ink-200 bg-white shadow-lg dark:border-ink-700 dark:bg-ink-900"
								role="menu"
							>
								<!-- t.txt item 13 (Ken) — top row of the kebab menu: the star
								     toggle pinned top-RIGHT (always present so it's always
								     reachable and always shows the current ☆/★ state), with the
								     animated LIVE readout to its LEFT when the thread is streaming.
								     Toggling the star flips it in place (the menu stays open) and
								     writes the SAME per-discussion folder the inbox reads, so
								     leaving the chatroom lands this thread under the right tab. -->
								<div class="flex items-center justify-between gap-2 px-4 py-2">
									{#if streaming}
										<span
											class="flex items-center gap-1.5 text-xs"
											aria-label={$_('chat.live') as string}
										>
											<span class="relative inline-flex h-2 w-2" aria-hidden="true">
												<span
													class="absolute inline-flex h-full w-full animate-ping rounded-full bg-morphit-emerald opacity-60"
												></span>
												<span class="relative inline-flex h-2 w-2 rounded-full bg-morphit-emerald"
												></span>
											</span>
											<span class="uppercase tracking-widest text-ink-500 dark:text-ink-500">
												{$_('chat.live')}
											</span>
										</span>
									{:else}
										<span></span>
									{/if}
									<button
										type="button"
										onclick={handleToggleThreadStar}
										aria-pressed={threadStarred}
										aria-label={threadStarred
											? ($_('chat.menu.unstar_aria') as string)
											: ($_('chat.menu.star_aria') as string)}
										class="flex-none rounded p-0.5 text-lg leading-none transition-colors {threadStarred
											? 'text-amber-400 hover:text-amber-500'
											: 'text-ink-300 hover:text-amber-400 dark:text-ink-600 dark:hover:text-amber-400'}"
									>
										{threadStarred ? '★' : '☆'}
									</button>
								</div>
								<!-- Hairline divider under the status/star row. -->
								<div class="border-t border-ink-200 dark:border-ink-700"></div>

								<!-- cp406 — Chat Security: opt into "destroy on leave" (PFS) or
								     keep the default readable history. Opening clears the dot. -->
								<button
									type="button"
									role="menuitem"
									class="flex w-full items-center gap-1.5 px-4 py-2 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
									onclick={openChatSecurity}
								>
									<span>{$_('chat.security.menu_label')}</span>
									{#if !chatSecurityNudgeSeen}
										<!-- cp407 — matching one-time nudge dot at the end of the
										     item; clears together with the kebab dot the first time
										     Chat Security is opened (openChatSecurity → seen). -->
										<span class="h-2 w-2 flex-none rounded-full bg-red-500" aria-hidden="true"></span>
									{/if}
								</button>

								<button
									type="button"
									role="menuitem"
									class="block w-full px-4 py-2 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
									onclick={openVerifyPeer}
								>
									{$_('chat.menu.verify_peer')}
								</button>

								<!-- cp402: Block/Unblock moved here from a standalone header
								     button. Reuses the confirm modal's named block/unblock label
								     (it interpolates the peer, so it reads "Block @username"); the
								     click closes the menu and opens the existing confirm modal
								     (onToggleBlock → pendingBlockAction). Destructive (block) is
								     tinted red; unblock is neutral. Disabled while in flight. -->
								<button
									type="button"
									role="menuitem"
									class="block w-full px-4 py-2 text-left text-sm hover:bg-ink-100 disabled:cursor-wait disabled:opacity-60 dark:hover:bg-ink-800 {isPeerBlocked
										? 'text-ink-700 dark:text-ink-200'
										: 'text-red-700 dark:text-red-400'}"
									disabled={blockActionBusy}
									onclick={() => {
										closeOverflowMenu();
										onToggleBlock();
									}}
								>
									{isPeerBlocked
										? $_('chat.block.confirm.unblock.yes', { values: { peer } })
										: $_('chat.block.confirm.block.yes', { values: { peer } })}
								</button>

								<!-- cp404 — export the conversation to a printable PDF (browser
								     Save-as-PDF; built client-side from decrypted messages, no deps). -->
								<button
									type="button"
									role="menuitem"
									class="block w-full px-4 py-2 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
									onclick={exportChatToPdf}
								>
									{$_('chat.export.menu_label')}
								</button>
							</div>
						{/if}
							</div>
						{/if}
					</div>
				</div>
			</div>
		</header>
		{#if blockActionError}
			<div class="px-4 pb-2">
				<StatusLine kind="error">{blockActionError}</StatusLine>
			</div>
		{/if}
	</div>

	<!-- One-time nudge to enable web-push chat notifications so the user
	     is pinged when the counterparty replies (tab closed = still
	     delivered). Self-suppressing; rides the existing push system only
	     (opaque endpoint, no PII). -->
	<ChatNotificationNudge {peer} />

	<!-- Scrollable message list: the flex-grow child. -->
	<div
		class="chat-scroll flex-1 overflow-y-auto px-3 py-4"
		bind:this={scrollEl}
		onscroll={onScroll}
	>
		<!-- Item 16 phase 4 — first-time-trade helper. Lives INSIDE the
		     scroll region (not as a flex-none sibling) so on mobile a
		     touch-drag anywhere over it scrolls the conversation instead
		     of being a dead zone. Self-suppressing (only for users who
		     have never given feedback), collapsed by default. -->
		<FirstTradeHelper {orderPermlink} />
		{#if !hasMessages}
			<div class="flex h-full items-center justify-center text-center">
				<p class="max-w-sm text-sm text-ink-500 dark:text-ink-400">
					{#if hasLoadedOnce}
						{$_('chat.empty_state', { values: { peer } })}
					{:else}
						{$_('chat.empty_state_loading', { values: { peer } })}
					{/if}
				</p>
			</div>
		{:else}
			<ul
				class="flex flex-col gap-2"
				role="log"
				aria-live="polite"
				aria-label={$_('chat.messages_aria') as string}
			>
				{#each messages as m, i (m.localSeq)}
					{@const daySep = daySeparatorLabelAt(i)}
					{#if daySep}
						<!-- Ken — day divider: a hairline all the way across the log with
						     the date centred just above it. Deliberately quiet (11px,
						     muted, non-interactive): it's a scroll landmark for finding
						     "that day" in a long lazy-loaded history, not a UI element. -->
						<li class="chat-day-separator mt-2 select-none first:mt-0">
							<div class="text-center text-[11px] leading-none text-ink-400 dark:text-ink-500">
								<!-- tt.txt v1.5.0 — the divider marks the midnight-UTC day boundary. -->
								<span class="cursor-help" title={$_('chat.day_separator_tooltip') as string}
									>{daySep}</span
								>
							</div>
							<div
								class="mt-1 h-px w-full bg-ink-200 dark:bg-ink-800"
								role="separator"
								aria-label={daySep}
							></div>
						</li>
					{/if}
					<ChatMessage
						message={m}
						{me}
						{peer}
						onRetry={handleRetry}
						onPayNow={handlePayNowClick}
						onMarkSent={handleMarkSentClick}
						showWhoami={messages[i - 1]?.sender !== m.sender}
						senderAvatarSvg={m.sender === me ? myAvatarSvg : peerLabelProps.avatarSvg}
						senderAvatarDataUri={m.sender === me
							? myAvatarDataUri
							: peerLabelProps.avatarDataUri}
						senderPostingKey={m.sender === me ? myPostingKey : peerPostingKey}
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
				class="pointer-events-auto absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-[var(--morphit-btn-face)] px-4 py-1.5 text-sm font-semibold text-white shadow-lg transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
				onclick={() => scrollToBottom(true)}
				aria-label={$_('chat.new_messages_pill_aria', {
					values: { n: unreadWhileScrolledUp }
				}) as string}
			>
				{$_('chat.new_messages_pill', { values: { n: unreadWhileScrolledUp } })} ↓
			</button>
		</div>
	{/if}

	<!-- v1.5.0 — bidirectional feedback: once a trade has settled (a Payment
	     Receipt landed), either party can review the other right from the
	     chat. Sits directly below the last message, above the composer. -->
	{#if orderPermlink}
		{#if canLeaveFeedback}
			<div class="mx-2 mb-2 rounded-xl border-2 border-morphit-emerald bg-morphit-emerald/5 p-3">
				<!-- v1.5.5 — completeOwnedOrder: this panel is headed "Mark this
				     trade complete", so when the cited order is OURS, submitting
				     must actually mark it complete (naming the peer as the
				     counterparty so both sides get trade credit). Gated on
				     orderIsMine because a chat may equally be about the PEER's
				     order — completing is owner-only, and in that direction it's
				     the peer's job. Ken's kentest3 owned the order and reviewed
				     from here, which is exactly why it sat "Live" forever. -->
				<LeaveFeedbackForm
					{orderPermlink}
					prefillSubject={peer}
					lockSubject={true}
					completeOwnedOrder={orderIsMine}
					onSuccess={onChatFeedbackSuccess}
				/>
			</div>
		{/if}
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
			     "please unlock" no-op modal). cp406: also hidden when
			     there's no live order to act on (showChatActionToolbar). -->
			{#if !locked && showChatActionToolbar}
				<div
					class="flex-none border-t border-ink-200 bg-emerald-50/30 px-4 py-2 dark:border-ink-800 dark:bg-morphit-emerald/[0.05]"
				>
					<div
						class="mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-2"
					>
					<!-- cp402 [6] — "Share address" shares MY crypto receiving
					     address, so it's only relevant when I'm the one RECEIVING
					     the crypto (the peer is selling the asset). Hidden when
					     I'm the sender, and hidden entirely when there's no live
					     order (cp406 — unsolicited / non-live chats). -->
					{#if showShareAddressButton}
						<button
							type="button"
							class="rounded-lg border border-morphit-teal/40 px-3 py-1.5 text-xs font-semibold text-morphit-teal transition-colors hover:border-morphit-teal hover:bg-morphit-teal/5 dark:border-morphit-emerald/40 dark:text-morphit-emerald dark:hover:bg-morphit-emerald/10"
							onclick={() => (showAddressShareModal = true)}
							aria-label={$_('chat.address.share_button_aria') as string}
						>
							{$_('chat.address.share_button')}
						</button>
					{/if}
					<!-- cp402 [6] — the funds-sent / "Pay now" button initiates
					     (or records) MY crypto payment, so it's only relevant when
					     I'm the one SENDING the crypto (the peer is buying the
					     asset). Hidden when I'm the receiver, and hidden entirely
					     when there's no live order (cp406). ([7] reflows the click
					     below.) -->
					{#if showPayNowButton}
						<button
							type="button"
							class="rounded-lg border border-morphit-teal/40 px-3 py-1.5 text-xs font-semibold text-morphit-teal transition-colors hover:border-morphit-teal hover:bg-morphit-teal/5 dark:border-morphit-emerald/40 dark:text-morphit-emerald dark:hover:bg-morphit-emerald/10"
							onclick={() => {
								// cp402 [7] — composer "Pay now". Clear any stale
								// pill context first. BLURT is sent by the app
								// itself (broadcast, no manual txid), so route it to
								// PayBlurtModal with a validated in-modal amount;
								// every other asset records an external payment
								// (amount + txid) via FundsSentModal, with the asset
								// locked to the order's asset.
								markSentArgs = null;
								if (composerPayNowAsset === 'blurt') {
									payBlurtArgs = {
										recipient: peer,
										// cp406 — pre-fill the order's fiat-minimum
										// equivalent in BLURT (0 when uncomputable);
										// the field stays editable.
										amount: payPrefillAmount ?? 0,
										memo: '',
										orderPermlink: orderPermlink ?? undefined,
										amountEditable: true
									};
								} else {
									showFundsSentModal = true;
								}
							}}
							aria-label={$_('chat.funds_sent.button_aria') as string}
						>
							{$_('chat.funds_sent.button')}
						</button>
					{/if}
						<!-- cp121 / cp402 [6] / cp406: physical-shipment +
						     mailing-address controls, shown only for a shippable trade
						     (barter / precious metals / cash-by-mail) and split by
						     direction: the crypto SENDER receives the physical payment
						     so they "Share mailing address"; the crypto RECEIVER is
						     paying with the physical item so they "Record shipment". A
						     plain crypto↔fiat in-person/online trade shows neither. -->
						{#if showShareMailingButton}
							<button
								type="button"
								class="rounded-lg border border-morphit-teal/40 px-3 py-1.5 text-xs font-semibold text-morphit-teal transition-colors hover:border-morphit-teal hover:bg-morphit-teal/5 dark:border-morphit-emerald/40 dark:text-morphit-emerald dark:hover:bg-morphit-emerald/10"
								onclick={() => (showMailingAddressModal = true)}
								aria-label={$_('chat.mailing_address.button_aria') as string}
							>
								{$_('chat.mailing_address.button')}
							</button>
						{/if}
						{#if showRecordShipmentButton}
							<button
								type="button"
								class="rounded-lg border border-morphit-teal/40 px-3 py-1.5 text-xs font-semibold text-morphit-teal transition-colors hover:border-morphit-teal hover:bg-morphit-teal/5 dark:border-morphit-emerald/40 dark:text-morphit-emerald dark:hover:bg-morphit-emerald/10"
								onclick={() => (showShipmentModal = true)}
								aria-label={$_('chat.shipment.button_aria') as string}
							>
								{$_('chat.shipment.button')}
							</button>
						{/if}
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
					class="rounded-xl border-2 border-morphit-emerald bg-[var(--morphit-btn-face)] px-4 py-2 font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
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
		allowedMethods={barterAcceptedMethods}
		onShare={handleAddressShare}
		onCancel={() => (showAddressShareModal = false)}
	/>
{/if}

{#if showFundsSentModal}
	<FundsSentModal
		{orderPermlink}
		initialMethod={markSentArgs?.method ?? 'btc'}
		initialAmount={markSentArgs !== null ? (markSentArgs.amount ?? '') : payPrefillStr}
		lockedMethod={composerPayNowAsset}
		allowedMethods={barterAcceptedMethods}
		amountRequired={markSentArgs === null}
		payHint={payPrefillHint}
		{peer}
		initialUsdtNetwork={/* cp26 DD-7 fix — propagate the USDT network from the
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
			: null}
		initialUsdcNetwork={/* Part 122 cp30 — same propagation path for USDC.
			   Guarded by method === 'usdc' so a wire-format
			   `network` value carried on a non-multi-network
			   asset (which the encoder forbids, but defense in
			   depth) can't accidentally route into the USDC
			   picker. */
		markSentArgs?.method === 'usdc' &&
		markSentArgs?.network !== undefined &&
		isUsdcNetwork(markSentArgs.network)
			? (markSentArgs.network as UsdcNetwork)
			: null}
		initialDaiNetwork={/* Part 122 cp31 — same propagation path for DAI.
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
			: null}
		onShare={handleFundsSent}
		onCancel={() => {
			showFundsSentModal = false;
			markSentArgs = null;
		}}
	/>
{/if}

<!-- cp121: physical-shipment + mailing-address modals.  See
     MailingAddressModal.svelte and ShipmentModal.svelte for the
     privacy + safety asides that surface to the user. -->
{#if showMailingAddressModal}
	<MailingAddressModal
		{orderPermlink}
		onShare={handleMailingAddressShare}
		onCancel={() => (showMailingAddressModal = false)}
	/>
{/if}

{#if showShipmentModal}
	<ShipmentModal
		{orderPermlink}
		onShare={handleShipmentShare}
		onCancel={() => (showShipmentModal = false)}
	/>
{/if}

{#if payBlurtArgs !== null}
	<PayBlurtModal
		recipient={payBlurtArgs.recipient}
		amount={payBlurtArgs.amount}
		amountEditable={payBlurtArgs.amountEditable ?? false}
		memo={payBlurtArgs.memo}
		payHint={payPrefillHint}
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
		cancelLabel={$_('common.cancel') as string}
		variant="destructive"
		busyLabel={$_('chat.block.busy') as string}
		onConfirm={onConfirmBlock}
		onCancel={onCancelBlock}
	/>
{/if}

<!-- cp406 — Chat Security confirm: "destroy after you leave this chat?".
     Yes → PFS "destroy" mode + the PDF reminder below; No → the default
     keep-history mode (self-copy, readable own history). -->
<ConfirmModal
	bind:open={chatSecurityConfirmOpen}
	title={$_('chat.security.confirm.title') as string}
	body={$_('chat.security.confirm.body') as string}
	confirmLabel={$_('chat.security.confirm.yes') as string}
	cancelLabel={$_('chat.security.confirm.no') as string}
	variant="neutral"
	onConfirm={onChatSecurityConfirm}
	onCancel={onChatSecurityCancel}
/>

<!-- cp406 — follow-up reminder, shown only after choosing destroy: grab a PDF
     before your own history becomes unrecoverable. "Get my PDF now" exports;
     "Later" just closes (destroy mode is already saved either way). -->
<ConfirmModal
	bind:open={pdfReminderOpen}
	title={$_('chat.security.pdf_reminder.title') as string}
	body={$_('chat.security.pdf_reminder.body') as string}
	confirmLabel={$_('chat.security.pdf_reminder.get_now') as string}
	cancelLabel={$_('chat.security.pdf_reminder.later') as string}
	variant="neutral"
	onConfirm={onPdfReminderConfirm}
	onCancel={onPdfReminderCancel}
/>

<!-- REVISIT-LIST item 11 — opt-in OOB fingerprint panel.
     Hidden by default; opened by the user from the conversation
     overflow menu.  Closing does NOT persist any verified-state
     anywhere — re-opening recomputes from scratch. -->
{#if verifyPeerOpen}
	<VerifyPeerPanel {me} {peer} onClose={closeVerifyPeer} />
{/if}

<style>
	.chat-conversation {
		/* cp402 [9] — this fills the immersive layout's flex-column
		   <main> (flex-1 min-h-0) instead of a fixed 100svh, so the sticky
		   header above it no longer pushes the composer below the fold.
		   min-height: 0 is critical — it lets the flex child (.chat-scroll)
		   scroll instead of forcing this column taller than its parent. */
		min-height: 0;
	}

	.chat-scroll {
		/* overflow-y-auto is Tailwind; this lets scrollbars style
		   consistently in WebKit. */
		overscroll-behavior: contain;
	}
</style>
