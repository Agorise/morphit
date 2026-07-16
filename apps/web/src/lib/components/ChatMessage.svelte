<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { formatDayMonthTime } from '$i18n/formatters';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import { safeContactUrl } from '$lib/utils/safeContactUrl';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * ChatMessage — a single message bubble in a conversation.
	 *
	 * Visual grammar:
	 *   - Outgoing messages align right with brand-emerald tint.
	 *   - Incoming messages align left with neutral surface tint.
	 *   - pending / broadcast: full opacity, NO timestamp line.
	 *     The UI deliberately makes these look LIKE confirmed
	 *     messages because the 3-second block time means the user
	 *     shouldn't be trained to expect a distinct "confirmed"
	 *     transition for normal sends — only failures warrant
	 *     prominence.
	 *   - confirmed: timestamp shown below text.
	 *   - failed: red ring, explicit error line, Retry button.
	 *
	 * The "(encrypted)" placeholder rendered for confirmed messages
	 * is shown in italics + muted color when the chat plaintext
	 * isn't decryptable on this device (e.g. the user is signed in
	 * but doesn't have the recipient's private chat key).  When
	 * decryption succeeds the component renders the real plaintext
	 * unchanged — no template change needed.
	 */

	import { _ } from 'svelte-i18n';
	import type { LocalMessage } from '$lib/chat/chatService';
	import { CHAT_CONSTANTS } from '$lib/chat/chatService';
	import { decodePayload, type ChatAssetTicker } from '$lib/chat/payload';
	import { CARRIERS, buildTrackingUrl } from '$lib/shipping/carriers';

	// cp121: O(1) carrier lookup for shipment-pill rendering.
	// Built once at module init (CARRIERS is a frozen const array).
	const CARRIERS_LOOKUP = new Map(CARRIERS.map((c) => [c.key, c]));
	import {
		externalExplorerUrl,
		externalExplorerUrls,
		morphitExplorerTxUrl,
		usdtExplorerUrl,
		usdcExplorerUrl,
		daiExplorerUrl,
		usdtExplorerUrls,
		usdcExplorerUrls,
		daiExplorerUrls
	} from '$lib/explorer/urls';
	import ExplorerLink from '$lib/components/ExplorerLink.svelte';
	import { isUsdtNetwork, isUsdcNetwork, isDaiNetwork } from '$lib/assets/networks';
	import { verifyBlurtTransfer, type VerifyResult } from '$lib/chat/blurtVerify';
	import { tradeStates } from '$lib/trades/tradeStatus';
	import { triggerBlurtVerification } from '$lib/trades/tradeVerify';
	import { isPairedReadOnly } from '$lib/stores/identity';
	import QrPanel from '$components/QrPanel.svelte';

	interface Props {
		message: LocalMessage;
		/** The local user's account — used to determine whether
		 *  this message is outgoing (align right, emerald) or
		 *  incoming (align left, neutral). */
		me: string;
		/** Phase F.5 audit fix (F-14) — the conversation peer.
		 *  Used by buyer-side self-verification: when this
		 *  message is an outgoing BLURT funds-sent pill, the
		 *  verifier checks that the on-chain transfer's `to`
		 *  field equals `peer` (catching wallet-typo bugs where
		 *  the user's wallet sent to a different account than
		 *  expected).  Optional for back-compat — if absent,
		 *  outgoing verification is skipped. */
		peer?: string;
		/** Called when the user taps Retry on a failed message. */
		onRetry?: (localSeq: number) => void;
		/** Phase F.3 — called when the user taps "Pay now" on a
		 *  BLURT address pill.  Caller (ConversationView) opens
		 *  PayBlurtModal.  Optional; the button only renders
		 *  when this prop is present, the message is incoming,
		 *  the method is blurt, and a valid amount is present.
		 *  Phase F.4 — `memo` is the BLURT payment memo the
		 *  seller pinned to the address pill (if any).  PayBlurt
		 *  uses it as the on-chain transfer's memo. */
		onPayNow?: (args: {
			recipient: string;
			amount: number;
			memo?: string;
			orderPermlink?: string;
		}) => void;
		/** Q5 — invoked when the user taps "Mark as sent" on an
		 *  incoming address pill (BTC, XMR, USDT, BCH, LTC, or
		 *  DASH).  Opens FundsSentModal pre-filled with the
		 *  seller's specified method+amount — critical for the
		 *  Monero amount-jitter flow, since the buyer's
		 *  funds-sent echo needs to reference the same jittered
		 *  value the seller asked for.
		 *
		 *  Optional; the button only renders when this prop is
		 *  present, the message is incoming, and the method is
		 *  one of the seven listed above (BLURT excluded —
		 *  BLURT transfers are single-tx and don't go through
		 *  the mark-sent reconciliation flow). */
		onMarkSent?: (args: {
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
		}) => void;
		/** cp402 [4] — whoami line. When true, a tiny "@sender (BLT…)"
		 *  identity line renders above this bubble. The parent sets this
		 *  only for the FIRST message of a same-sender run, so a burst of
		 *  messages from one party shows the line once. The sender is
		 *  derived from direction (isOutgoing ⇒ `me`, else `peer`), so the
		 *  parent supplies only that sender's avatar + posting key. */
		showWhoami?: boolean;
		/** cp402 [4] — the sender's sanitized avatar SVG (if they set one).
		 *  Rendered via {@html} exactly like IdentityLabel; sanitized
		 *  upstream in profileProps/selfProfile. */
		senderAvatarSvg?: string | null;
		/** cp402 [4] — the sender's raster avatar data URI (mutually
		 *  exclusive with senderAvatarSvg). */
		senderAvatarDataUri?: string | null;
		/** cp402 [4] — the sender's canonical BLT posting key (full base58
		 *  string). Truncated head(9)…tail(4) for the whoami — the SAME
		 *  shape IdentityLabel shows in the header, so the same peer's key
		 *  reads identically in both places. Null ⇒ the "(BLT…)" part is
		 *  omitted (identity still shows @username + avatar). */
		senderPostingKey?: string | null;
	}

	let {
		message,
		me,
		peer,
		onRetry,
		onPayNow,
		onMarkSent,
		showWhoami = false,
		senderAvatarSvg = null,
		senderAvatarDataUri = null,
		senderPostingKey = null
	}: Props = $props();

	const isOutgoing = $derived(message.sender === me);

	/** cp402 [4] — the sender account for the whoami line. message.sender
	 *  is authoritative; the me/peer fallback guarantees it's never empty
	 *  (which would make IdentityLabel seed a blank identicon). */
	const whoamiAccount = $derived(message.sender || (isOutgoing ? me : (peer ?? '')));

	/** v1.4.8 (t.txt) — the broadcast is fast (~3s) but `confirmed` waits on the
	 *  indexer reading the message back, which lags ~45s behind head. So "sending…"
	 *  is shown ONLY while `pending`; the moment the broadcast succeeds the bubble
	 *  goes clean (no tick, no "Sent" — Ken found that annoying). Perceived send
	 *  time is the broadcast latency, decoupled from follower/SSE lag. */
	const isSending = $derived(message.state === 'pending');
	const isFailed = $derived(message.state === 'failed');
	// Placeholder = either the explicit decrypt-failed signal, or
	// the legacy string match (for the "message sent from my other
	// session" case where decryptFailed is false but the text still
	// shows the placeholder).
	const isPlaceholder = $derived(
		message.decryptFailed || message.text === CHAT_CONSTANTS.ENCRYPTED_PLACEHOLDER
	);

	// Part 122 cp29 — closes Part 119 finding B-3 (paired-readonly
	// Bob saw "(encrypted)" with no actionable guidance about why
	// decryption isn't happening on this device).  Three distinct
	// failure modes were previously collapsed into a single
	// "(encrypted)" placeholder; now each gets its own copy:
	//
	//   - 'failed'   → decryption was attempted and failed; could
	//                  be tampered ciphertext, wrong recipient key,
	//                  or a malformed envelope.  Worth flagging
	//                  loudly so the user knows the message is
	//                  suspect, not just temporarily unreadable.
	//   - 'paired'   → user is signed in via ADR-0022 QR-pair on
	//                  this desktop; their posting key (and chat
	//                  decryption material) lives on their phone.
	//                  Tells them to open Morphit on the phone.
	//   - 'default'  → the catch-all (legacy-stub messages with no
	//                  ephemeral_pub, messages we sent from a
	//                  different session of our own, locked-session
	//                  state).  Keeps the original terse
	//                  "(encrypted)" copy.
	//
	// Decryption-failed beats paired-readonly: a corrupt message
	// is corrupt regardless of which device the user is signed in
	// from, and we want the louder warning to surface even on a
	// paired-readonly device.
	const placeholderKind: 'failed' | 'paired' | 'default' = $derived(
		message.decryptFailed ? 'failed' : $isPairedReadOnly ? 'paired' : 'default'
	);
	const placeholderI18nKey = $derived(
		placeholderKind === 'failed'
			? 'chat.message.placeholder_encrypted_failed'
			: placeholderKind === 'paired'
				? 'chat.message.placeholder_encrypted_paired'
				: 'chat.message.placeholder_encrypted'
	);

	/** Decode structured payloads from the plaintext.  Phase F adds
	 *  two payload kinds: `morphit_addr` (receiving address handoff)
	 *  and `morphit_funds_sent` (txid acknowledgment).  Anything
	 *  that doesn't shape-match falls through to plaintext rendering
	 *  — including malformed-but-JSON messages and unknown future
	 *  versions (the latter renders a "newer protocol" notice).
	 *
	 *  Skipped when the message is a placeholder — there's no
	 *  decryptable plaintext to decode, and decodePayload on the
	 *  literal string "(encrypted)" would just return plaintext
	 *  anyway.  Also skipped when the message is in-flight — we
	 *  already know its plaintext (we just sent it), but consistency
	 *  with the recipient's render means an OUTGOING address share
	 *  should render as a pill on the sender's side too. */
	const decoded = $derived(isPlaceholder ? null : decodePayload(message.text));

	/** Split plaintext into text + http(s) link segments so URLs become
	 *  clickable (opening in a new tab) WITHOUT ever using @html on
	 *  peer-controlled text — every segment renders through Svelte's
	 *  normal escaping. The regex matches http(s):// up to whitespace;
	 *  trailing sentence punctuation is peeled back onto the next text
	 *  run so "see https://example.org." links cleanly. Only http/https
	 *  match, so no javascript:/data: scheme can sneak into an href. */
	function linkifySegments(text: string): Array<{ link: boolean; value: string }> {
		const out: Array<{ link: boolean; value: string }> = [];
		const re = /https?:\/\/[^\s]+/g;
		let last = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			let url = m[0];
			let trail = '';
			const tm = /[).,;:!?'"\]}>]+$/.exec(url);
			if (tm) {
				trail = tm[0];
				url = url.slice(0, url.length - trail.length);
			}
			if (m.index > last) out.push({ link: false, value: text.slice(last, m.index) });
			if (url.length > 0) out.push({ link: true, value: url });
			if (trail.length > 0) out.push({ link: false, value: trail });
			last = m.index + m[0].length;
		}
		if (last < text.length) out.push({ link: false, value: text.slice(last) });
		return out;
	}
	const textSegments = $derived(linkifySegments(message.text));

	/** Copy-to-clipboard state for address/txid pills. The pill
	 *  shows "Copied!" briefly after a click before reverting.
	 *  Tracks WHICH item was copied so the right button (address,
	 *  memo, or txid) shows the flash, not all of them. */
	let copiedKind = $state<'address' | 'memo' | 'txid' | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	/** Phase F.2 — QR panel toggle for the address pill.  Closed
	 *  by default to keep the chat scroll compact; user opens
	 *  explicitly via "Show QR" button.  Lazy-loads the qrcode
	 *  library on first open. */
	let showQr = $state(false);

	function copyText(text: string, kind: 'address' | 'memo' | 'txid'): void {
		if (typeof navigator === 'undefined' || !navigator.clipboard) return;
		void navigator.clipboard.writeText(text).then(() => {
			copiedKind = kind;
			if (copyTimer !== null) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => {
				copiedKind = null;
			}, 2000);
		});
	}

	/** Batch K — build the right explorer URL for a funds-sent
	 *  txid.  Transparent external chains (BTC, XMR, BCH, LTC,
	 *  DASH, and each USDT network) go to known-good external
	 *  explorers (link opens in new tab).  Native BLURT transfers
	 *  go to our own /explorer/tx route (same-tab navigation).
	 *  Returns null for unknown methods, malformed txids, or
	 *  USDT payloads missing a network field — caller hides the
	 *  link in that case. */
	function explorerLinkForTxid(
		method: ChatAssetTicker,
		txid: string,
		network?: string
	): string | null {
		if (method === 'btc') return externalExplorerUrl('BTC', txid);
		if (method === 'xmr') return externalExplorerUrl('XMR', txid);
		if (method === 'blurt') {
			const u = morphitExplorerTxUrl(txid);
			return u ? lp(u) : null;
		}
		if (method === 'bch') return externalExplorerUrl('BCH', txid);
		if (method === 'ltc') return externalExplorerUrl('LTC', txid);
		if (method === 'dash') return externalExplorerUrl('DASH', txid);
		if (method === 'doge') return externalExplorerUrl('DOGE', txid);
		if (method === 'zec') return externalExplorerUrl('ZEC', txid);
		if (method === 'arrr') return externalExplorerUrl('ARRR', txid);
		if (method === 'dcr') return externalExplorerUrl('DCR', txid);
		if (method === 'sol') return externalExplorerUrl('SOL', txid);
		if (method === 'eth') return externalExplorerUrl('ETH', txid);
		if (method === 'xrp') return externalExplorerUrl('XRP', txid);
		if (method === 'usdt') {
			// Per-network USDT explorer URL.  Without a network we
			// can't pick the right template — older clients sending
			// USDT payloads without the network field render the
			// txid as plain text (no link).
			if (network !== undefined && isUsdtNetwork(network)) {
				return usdtExplorerUrl(network, txid);
			}
			return null;
		}
		if (method === 'usdc') {
			// Part 122 cp30 — per-network USDC explorer URL.  Same
			// shape as USDT: requires the wire-format `network`
			// field to disambiguate among erc20/spl/base/polygon.
			// Especially important here because ERC-20, Base, and
			// Polygon share the same EVM txid shape, so without the
			// network we can't pick the right scanner.
			if (network !== undefined && isUsdcNetwork(network)) {
				return usdcExplorerUrl(network, txid);
			}
			return null;
		}
		if (method === 'dai') {
			// Part 122 cp31 — per-network DAI explorer URL.  Same
			// shape as USDC.  MOST important here because ALL FOUR
			// DAI networks (ERC-20, Polygon, Base, Arbitrum) share
			// the same EVM 0x[64 hex] txid format — no SPL branch to
			// fall back to.  Without `network` we can't pick the
			// right scanner: etherscan vs polygonscan vs basescan vs
			// arbiscan.
			if (network !== undefined && isDaiNetwork(network)) {
				return daiExplorerUrl(network, txid);
			}
			return null;
		}
		return null;
	}

	/** cp167 — plural counterpart of explorerLinkForTxid.  Returns
	 *  the ordered list of all available explorer URLs for the
	 *  given txid (best→worst).  For BLURT and the per-network
	 *  stablecoin paths there's only one explorer; for the
	 *  bundled-list chains (BTC, XMR, ETH, etc.) returns the full
	 *  list.  Empty array means no link should render.
	 *
	 *  This drives the <ExplorerLink> dropdown: one-element arrays
	 *  render exactly the same single link as today; multi-element
	 *  arrays add a "+N more ▾" progressive-disclosure affordance. */
	function explorerLinksForTxid(
		method: ChatAssetTicker,
		txid: string,
		network?: string
	): readonly string[] {
		if (method === 'btc') return externalExplorerUrls('BTC', txid);
		if (method === 'xmr') return externalExplorerUrls('XMR', txid);
		if (method === 'bch') return externalExplorerUrls('BCH', txid);
		if (method === 'ltc') return externalExplorerUrls('LTC', txid);
		if (method === 'dash') return externalExplorerUrls('DASH', txid);
		if (method === 'doge') return externalExplorerUrls('DOGE', txid);
		if (method === 'zec') return externalExplorerUrls('ZEC', txid);
		if (method === 'arrr') return externalExplorerUrls('ARRR', txid);
		if (method === 'dcr') return externalExplorerUrls('DCR', txid);
		if (method === 'sol') return externalExplorerUrls('SOL', txid);
		if (method === 'eth') return externalExplorerUrls('ETH', txid);
		if (method === 'xrp') return externalExplorerUrls('XRP', txid);
		// cp174 — multi-network tokens now get the same "+N more
		// explorers" dropdown as native-chain assets.  Require the
		// wire-format `network` field to disambiguate (same contract
		// as the singular path); fall through to [] if it's absent or
		// invalid so older clients render the txid as plain text.
		if (method === 'usdt') {
			if (network !== undefined && isUsdtNetwork(network)) return usdtExplorerUrls(network, txid);
			return [];
		}
		if (method === 'usdc') {
			if (network !== undefined && isUsdcNetwork(network)) return usdcExplorerUrls(network, txid);
			return [];
		}
		if (method === 'dai') {
			if (network !== undefined && isDaiNetwork(network)) return daiExplorerUrls(network, txid);
			return [];
		}
		// Single-URL paths fall through to the singular function;
		// wrap the result in a one-element array (or empty if null).
		const single = explorerLinkForTxid(method, txid, network);
		return single === null ? [] : [single];
	}

	/** Phase F.4 — on-chain verification state for incoming BLURT
	 *  funds-sent pills.
	 *
	 *  When the buyer sends a funds_sent payload claiming "I paid
	 *  you X BLURT, txid Y, memo Z," the seller's UI fetches the
	 *  transaction from chain and verifies recipient + sender +
	 *  amount + memo all match.  Result renders as a colored
	 *  badge: green (verified), red (mismatch detail), gray
	 *  (loading or chain RPC down).
	 *
	 *  Phase F.5 routes the result through the tradeStatus store
	 *  so /my/orders and any other surface picks up the same
	 *  state.  Component-local `verifyResult` is retained as a
	 *  fallback for the case where the funds-sent pill arrives
	 *  without a matching tradeStatus entry (e.g. no orderPermlink
	 *  on the payload).
	 *
	 *  null = not yet attempted; set to 'pending' before the
	 *  fetch starts so the UI can show a spinner skeleton. */
	let verifyResultLocal = $state<VerifyResult | 'pending' | null>(null);

	/** If the funds-sent payload carries an orderPermlink, the
	 *  authoritative verification state lives in the tradeStatus
	 *  store; subscribe to it.  Component renders FROM the store
	 *  for cross-page consistency.
	 *
	 *  Phase F.5 audit fix (F-39) — read from the shared map
	 *  directly via $tradeStates.get(permlink) rather than
	 *  allocating a per-permlink derived store. */
	const tradeStateValue = $derived.by(() => {
		if (decoded?.kind !== 'funds_sent') return null;
		const permlink = decoded.payload.orderPermlink;
		if (!permlink) return null;
		return $tradeStates.get(permlink) ?? null;
	});

	/** Effective verify result — store takes precedence over
	 *  component-local. */
	const verifyResult = $derived(tradeStateValue?.verifyResult ?? verifyResultLocal);

	/** Generation counter to defeat stale results — if the
	 *  message changes (rare; messages are immutable post-confirm
	 *  but defensive) we ignore in-flight verifies. */
	let verifyGen = 0;

	$effect(() => {
		// Verify funds-sent BLURT pills.  Phase F.5 audit fix
		// (F-14) extends verification to OUTGOING pills too —
		// the buyer's self-verification catches wallet-typo bugs
		// where the user's wallet sent to a wrong account or with
		// a wrong amount.  Pre-fix, only seller-side verification
		// fired (when message was incoming).
		//
		// The recipient/sender mapping flips by direction:
		//   incoming → local user is seller, peer is buyer
		//   outgoing → local user is buyer, peer is seller
		if (decoded?.kind !== 'funds_sent') return;
		const p = decoded.payload;
		if (p.method !== 'blurt') return; // only BLURT path verifies
		if (!p.amount) return; // can't verify amount-less
		const amountNum = parseFloat(p.amount);
		if (!Number.isFinite(amountNum)) return;

		// Determine recipient (chain `to`) and sender (chain `from`)
		// based on direction.  Outgoing self-verification needs the
		// `peer` prop; if absent, skip self-verification.
		let chainRecipient: string;
		let chainSender: string;
		if (isOutgoing) {
			if (!peer) return; // F-14: caller didn't pass peer
			chainRecipient = peer;
			chainSender = me;
		} else {
			chainRecipient = me;
			chainSender = message.sender;
		}

		if (p.orderPermlink) {
			// Phase F.5 audit fix (F-41) — delegate to the
			// centralized trigger.  Idempotent with the listener +
			// chatService merge.  Same trigger used for both
			// directions.
			triggerBlurtVerification({
				recipient: chainRecipient,
				sender: chainSender,
				amountBlurt: amountNum,
				echoedMemo: p.memo ?? '',
				orderPermlink: p.orderPermlink,
				txid: p.txid
			});
			return;
		}

		// Legacy fallback: funds-sent payload without orderPermlink.
		// Rare — pre-Phase-F.5 versions or hand-crafted payloads.
		// No store entry to update, so we render via
		// `verifyResultLocal` directly.
		const myGen = ++verifyGen;
		verifyResultLocal = 'pending';

		void verifyBlurtTransfer(p.txid, {
			recipient: chainRecipient,
			sender: chainSender,
			amountBlurt: amountNum,
			memo: p.memo ?? ''
		}).then((r) => {
			if (myGen !== verifyGen) return; // stale
			verifyResultLocal = r;
		});
	});

	/** cp402 [5] — full date + time for a confirmed bubble (the persistent
	 *  below-bubble timestamp was removed per Ken's chat batch). Uses the
	 *  canonical Morphit formatter → "14 May, 2026 @ 05:03:22 UTC": day-number,
	 *  translated full month, comma, 4-digit year, @ 24-hour UTC with seconds.
	 *  Empty for pending / broadcast / failed messages (no on-chain createdAt
	 *  yet).
	 *
	 *  cp474 — the example above used to read "@ 8:52:42 PM (localized time)".
	 *  `formatDayMonthTime` emits 24-hour UTC and has for a while; the comment
	 *  had simply drifted. Ordinary bubbles reveal this on tap; a Payment
	 *  Receipt prints it on its face instead (see `timestampRevealable`). */
	const fullTimestamp = $derived.by(() => {
		if (message.state !== 'confirmed' || !message.createdAt) return '';
		return formatDayMonthTime(message.createdAt);
	});

	/** cp474 (t.txt #8) — a Payment Receipt PRINTS its timestamp on the
	 *  SENT/RECEIVED line, so it opts out of the tap-to-reveal popover the other
	 *  bubbles use.
	 *
	 *  Ken: "when you mouseover anywhere on the payment receipt, that date/time
	 *  alt text appears and it's annoying", and "the entire Payment Receipt
	 *  bubble seems to be hyperlinked to nothing". Both are this one mechanism:
	 *  the bubble carried `title={fullTimestamp}` (the native tooltip, which
	 *  fires anywhere on the card and cannot be styled or dismissed) plus
	 *  `cursor-pointer` + an onclick (which is what makes it LOOK like a link
	 *  that goes nowhere — it only toggled a popover showing the very same
	 *  timestamp).
	 *
	 *  A receipt is a document: the time it happened belongs printed on its face,
	 *  not hidden behind a hover. Once it's on the face, the popover is a
	 *  duplicate of information already on screen — so the honest fix is to drop
	 *  the affordance here rather than keep a control whose only output is
	 *  already visible.
	 *
	 *  Ordinary message bubbles keep the popover (cp402 [5]): their timestamp
	 *  ISN'T printed anywhere, so tap-to-reveal is the only way to get it. */
	const isReceipt = $derived(decoded?.kind === 'funds_sent');
	/** The timestamp affordance applies only to bubbles that don't print it. */
	const timestampRevealable = $derived(fullTimestamp !== '' && !isReceipt);

	/** cp402 [5] — whether the tap-to-reveal timestamp popover is
	 *  showing for this bubble. Toggled by tapping the bubble;
	 *  dismissed by tapping again or pressing Escape. */
	let showTimestamp = $state(false);

	/** Toggle the timestamp popover. Guarded so taps on inner
	 *  interactive elements (address-pill Pay-now / Mark-sent
	 *  buttons, the retry button, links) don't also toggle it. */
	function onBubbleActivate(e: MouseEvent | KeyboardEvent): void {
		// cp474 — a receipt prints its own time; nothing to reveal.
		if (!timestampRevealable) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest('button, a, input, textarea, [role="button"]')) return;
		showTimestamp = !showTimestamp;
	}

	/** cp402 [5] — ref to this message row; the popover's dismissal
	 *  effect uses it to tell an outside tap from a re-tap on the bubble. */
	let bubbleRowEl = $state<HTMLElement | null>(null);

	/** cp402 [5] — while the timestamp popover is open, dismiss it on an
	 *  outside tap or Escape. Listeners attach only while open, so they
	 *  don't accumulate across the (potentially many) messages in a
	 *  conversation. The opening tap can't self-close because this effect
	 *  only (re)subscribes after showTimestamp flips true. */
	$effect(() => {
		if (!showTimestamp) return;
		function onDocPointerDown(ev: Event): void {
			const t = ev.target as Node | null;
			if (bubbleRowEl && t && !bubbleRowEl.contains(t)) showTimestamp = false;
		}
		function onKey(ev: KeyboardEvent): void {
			if (ev.key === 'Escape') showTimestamp = false;
		}
		document.addEventListener('pointerdown', onDocPointerDown, true);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('pointerdown', onDocPointerDown, true);
			document.removeEventListener('keydown', onKey);
		};
	});

	// Part 121 cp7 — per-locale internal-link wrapper.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<li class="chat-message flex" class:justify-end={isOutgoing} class:justify-start={!isOutgoing}>
	<div class="relative flex max-w-[85%] flex-col gap-1 sm:max-w-[70%]" bind:this={bubbleRowEl}>
		{#if showWhoami}
			<!-- cp402 [4] — whoami identity line. Rendered once above the
			     FIRST bubble of a same-sender run (the parent gates this),
			     so a burst of messages from one party is labelled once. This
			     is a SAFETY affordance: it shows the sender's avatar, @handle,
			     and truncated BLT posting key so each trader can confirm the
			     counterparty's durable cryptographic identity — the thing an
			     impersonator can't forge — before agreeing to terms or sending
			     funds. Goes through IdentityLabel (not a hand-rolled @handle)
			     to satisfy the identity-label policy AND so the same peer's
			     key reads identically to the header (same head-9…tail-4
			     truncation). No `href`: the header already links to the
			     profile, and omitting it keeps one fewer tab stop per group.
			     For the local user's own runs, IdentityLabel falls back to
			     the selfProfile avatar automatically (isSelf). -->
			<div class="max-w-full" class:self-end={isOutgoing} class:self-start={!isOutgoing}>
				<IdentityLabel
					account={whoamiAccount}
					publicKeyString={senderPostingKey ?? undefined}
					avatarSvg={senderAvatarSvg}
					avatarDataUri={senderAvatarDataUri}
					avatarSize={18}
					weight="normal"
				/>
			</div>
		{/if}
		<!--
			The bubble itself. Tailwind classes handle the color split
			between outgoing (emerald tint) and incoming (ink-surface).
			The failed state adds a red ring that overrides the border.
		-->
		<!-- cp402 [5] — tap/click the bubble to reveal its full send
		     time (fullTimestamp popover below). Pointer/touch reveal;
		     the message text stays fully accessible, and the timestamp
		     is also exposed to assistive tech via the sr-only <time>
		     that follows, so this is a supplementary enhancement (hence
		     the a11y suppressions — the div is intentionally not a
		     button so it never hijacks the message text as its name). -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- t155 (Ken): "all of the green bubbles (the Payment Receipts too) are a
		     bit too bright and it makes the thin black text hard for me to see.
		     maybe dim that green just a bit and make the text on the bubble a bit
		     bolder."
		
		     `font-medium` on the whole bubble is the "a bit bolder" half — it
		     lifts 400 → 500, which thickens the strokes without shouting the way
		     font-semibold would. It applies to the Payment Receipt too, since the
		     receipt renders INSIDE this bubble and inherits both the deepened
		     background and this weight — which is what Ken asked for ("the Payment
		     Receipts too"). -->
		<div
			class="w-fit break-words rounded-2xl px-3 py-2 text-sm font-medium"
			class:self-end={isOutgoing}
			class:self-start={!isOutgoing}
			class:cursor-pointer={timestampRevealable}
			class:bg-morphit-emerald-bubble={isOutgoing && !isFailed}
			class:text-ink-950={isOutgoing && !isFailed}
			class:bg-ink-200={!isOutgoing && !isFailed}
			class:text-ink-900={!isOutgoing && !isFailed}
			class:dark:bg-ink-800={!isOutgoing && !isFailed}
			class:dark:text-ink-100={!isOutgoing && !isFailed}
			class:ring-2={isFailed}
			class:ring-red-500={isFailed}
			class:bg-red-50={isFailed}
			class:dark:bg-red-950={isFailed}
			class:text-red-900={isFailed}
			class:dark:text-red-200={isFailed}
			class:opacity-80={isSending}
			title={timestampRevealable ? fullTimestamp : undefined}
			onclick={onBubbleActivate}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onBubbleActivate(e);
				}
			}}
			aria-label={isOutgoing
				? ($_('chat.message.aria.outgoing') as string)
				: ($_('chat.message.aria.incoming') as string)}
		>
			{#if isPlaceholder}
				<!-- Part 122 cp29: closes Part 119 finding B-3 — the
				     three placeholder cases (decrypt-failed / paired-
				     readonly / default) get distinct copy via the
				     derived placeholderI18nKey above.  Failed
				     decryption gets louder visual treatment (red
				     border + not italic) since it's a real signal
				     the message may be tampered; paired-readonly +
				     default share the muted-italic style. -->
				{#if placeholderKind === 'failed'}
					<span
						class="block rounded border border-red-500/50 bg-red-500/10 px-2 py-1 text-sm text-red-700 dark:border-red-400/40 dark:bg-red-400/10 dark:text-red-200"
					>
						{$_(placeholderI18nKey)}
					</span>
				{:else}
					<span class="italic text-ink-500 dark:text-ink-400">
						{$_(placeholderI18nKey)}
					</span>
				{/if}
			{:else if decoded?.kind === 'address'}
				{@const p = decoded.payload}
				{@const isIncoming = !isOutgoing}
				{@const parsedAmount = p.amount !== undefined ? parseFloat(p.amount) : NaN}
				{@const alreadyPaid =
					p.orderPermlink !== undefined &&
					($tradeStates.get(p.orderPermlink)?.phase ?? 'address_shared') !== 'address_shared'}
				{@const canPayNow =
					onPayNow !== undefined &&
					p.method === 'blurt' &&
					isIncoming &&
					!Number.isNaN(parsedAmount) &&
					parsedAmount > 0 &&
					!alreadyPaid}
				{@const canMarkSent =
					onMarkSent !== undefined &&
					(p.method === 'btc' ||
						p.method === 'xmr' ||
						p.method === 'usdt' ||
						p.method === 'usdc' ||
						p.method === 'dai' ||
						p.method === 'bch' ||
						p.method === 'ltc' ||
						p.method === 'dash' ||
						p.method === 'doge' ||
						p.method === 'zec' ||
						p.method === 'arrr' ||
						p.method === 'dcr' ||
						p.method === 'sol' ||
						p.method === 'eth' ||
						p.method === 'xrp') &&
					isIncoming}
				{@const xmrLooksStandard = p.method === 'xmr' && p.address.startsWith('4')}
				{@const usdtNetworkValid =
					p.method === 'usdt' && p.network !== undefined && isUsdtNetwork(p.network)}
				{@const usdcNetworkValid =
					p.method === 'usdc' && p.network !== undefined && isUsdcNetwork(p.network)}
				{@const daiNetworkValid =
					p.method === 'dai' && p.network !== undefined && isDaiNetwork(p.network)}
				<div class="flex flex-col gap-2">
					<!-- cp474 (t.txt #8) — Ken: 'change that text to say "BLURT
					     SENT|RECEIVED on 14 May, 2026 @ 05:03:22 UTC" and remove that
					     date/time from everywhere else on the Payment Receipt.'
					     `formatDayMonthTime` already emits exactly that shape (the
					     sitewide day-first / full-month / 24h-UTC-with-seconds standard),
					     so this prints the canonical formatter's output rather than
					     inventing a second date format on one card.
					     `normal-case` on the timestamp: the row is `uppercase`, which would
					     otherwise shout "14 MAY, 2026" — the month name is a word, not a
					     label. -->
					<div
						class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-semibold uppercase tracking-wider opacity-70"
					>
						{#if p.method === 'btc'}
							{$_('chat.address.pill_method_btc')}
						{:else if p.method === 'xmr'}
							{$_('chat.address.pill_method_xmr')}
						{:else if p.method === 'bch'}
							{$_('chat.address.pill_method_bch')}
						{:else if p.method === 'ltc'}
							{$_('chat.address.pill_method_ltc')}
						{:else if p.method === 'dash'}
							{$_('chat.address.pill_method_dash')}
						{:else if p.method === 'doge'}
							{$_('chat.address.pill_method_doge')}
						{:else if p.method === 'zec'}
							{$_('chat.address.pill_method_zec')}
						{:else if p.method === 'arrr'}
							{$_('chat.address.pill_method_arrr')}
						{:else if p.method === 'dcr'}
							{$_('chat.address.pill_method_dcr')}
						{:else if p.method === 'sol'}
							{$_('chat.address.pill_method_sol')}
						{:else if p.method === 'eth'}
							{$_('chat.address.pill_method_eth')}
						{:else if p.method === 'xrp'}
							{$_('chat.address.pill_method_xrp')}
						{:else if p.method === 'usdt'}
							<!-- Part 121 — USDT pill header carries the
							     network as a BOLD prefix so the buyer
							     can't miss which chain to send on. -->
							{#if usdtNetworkValid}
								<span class="rounded-md bg-amber-400/20 px-2 py-0.5 font-bold text-amber-300">
									{$_(`assets.usdt.network.${p.network}.displayName`)}
								</span>
							{/if}
							{$_('chat.address.pill_method_usdt')}
						{:else if p.method === 'usdc'}
							<!-- Part 122 cp30 — USDC pill header parallel
							     to USDT.  Circle-blue chip instead of
							     amber so the two stablecoins are
							     visually distinguishable.  Especially
							     important on EVM chains (ERC-20 / Base /
							     Polygon) where the address format alone
							     can't tell them apart. -->
							{#if usdcNetworkValid}
								<span class="rounded-md bg-blue-400/20 px-2 py-0.5 font-bold text-blue-300">
									{$_(`assets.usdc.network.${p.network}.displayName`)}
								</span>
							{/if}
							{$_('chat.address.pill_method_usdc')}
						{:else if p.method === 'dai'}
							<!-- Part 122 cp31 — DAI pill header parallel
							     to USDC.  MakerDAO orange chip to
							     visually distinguish from USDT amber +
							     USDC Circle-blue.  MOST important here
							     because ALL FOUR DAI networks share the
							     EVM 0x address format — the chip is the
							     ONLY visual signal of which chain. -->
							{#if daiNetworkValid}
								<span class="rounded-md bg-orange-400/20 px-2 py-0.5 font-bold text-orange-300">
									{$_(`assets.dai.network.${p.network}.displayName`)}
								</span>
							{/if}
							{$_('chat.address.pill_method_dai')}
						{:else}
							{$_('chat.address.pill_method_blurt')}
						{/if}
						{#if p.amount}
							<span class="font-mono">· {p.amount}</span>
						{/if}
						<!-- cp26 — PayJoin badge.  Renders when the
						     seller's payload carries a PayJoin (BIP-78)
						     endpoint and the asset is BTC.  Tells the
						     buyer "this seller's wallet supports
						     cooperative tx construction — if your
						     wallet also supports PayJoin, scanning the
						     QR / opening the URI will trigger the
						     BIP-78 PSBT exchange." -->
						{#if p.method === 'btc' && p.payjoinEndpoint !== undefined}
							<span
								class="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide {isOutgoing
									? 'bg-ink-950/15 text-ink-950'
									: 'bg-morphit-emerald/20 text-emerald-800 dark:text-morphit-emerald'}"
								title={$_('chat.address.payjoin_badge_tooltip') as string}
							>
								🔐 {$_('chat.address.payjoin_badge')}
							</span>
						{/if}
					</div>
					<div class="flex items-start gap-2">
						<code
							class="flex-1 break-all rounded-md bg-black/10 px-2 py-1.5 font-mono text-xs dark:bg-black/30"
						>
							{p.address}
						</code>
						<button
							type="button"
							class="flex-none rounded-md border px-2 py-1 text-xs font-semibold {copiedKind ===
							'address'
								? 'border-green-600 bg-green-600 text-white opacity-100'
							: 'border-current opacity-70 hover:bg-current/10 hover:opacity-100'}"
							onclick={() => copyText(p.address, 'address')}
							aria-label={$_('common.copy') as string}
						>
							{#if copiedKind === 'address'}<span aria-hidden="true">✓</span>
								{$_('chat.address.pill_copied')}{:else}{$_('common.copy')}{/if}
						</button>
					</div>
					{#if p.method === 'usdt' && usdtNetworkValid}
						<!-- Part 121 — per-message USDT cross-network
						     warning.  Stays on the chat record
						     permanently so a buyer who re-checks an old
						     message before paying still sees the
						     warning.  Red border + body text. -->
						<aside
							class="rounded-md border border-red-400/30 bg-red-400/5 px-2.5 py-2 text-xs text-red-200"
							role="note"
						>
							{$_('assets.usdt.address_share.warning', {
								values: { network: $_(`assets.usdt.network.${p.network}.displayName`) }
							})}
						</aside>
					{/if}
					{#if p.method === 'usdc' && usdcNetworkValid}
						<!-- Part 122 cp30 — per-message USDC cross-network
						     warning.  Same shape as the USDT case but with
						     Circle-blue trim to keep the two stablecoins
						     visually distinct.  Critical here because
						     three of USDC's four networks share the EVM
						     0x[40 hex] shape. -->
						<aside
							class="rounded-md border border-blue-400/30 bg-blue-400/5 px-2.5 py-2 text-xs text-blue-200"
							role="note"
						>
							{$_('assets.usdc.address_share.warning', {
								values: { network: $_(`assets.usdc.network.${p.network}.displayName`) }
							})}
						</aside>
					{/if}
					{#if p.method === 'dai' && daiNetworkValid}
						<!-- Part 122 cp31 — per-message DAI cross-network
						     warning.  Same shape as USDC but with
						     MakerDAO-orange trim.  MOST critical here
						     because ALL FOUR DAI networks share the EVM
						     0x[40 hex] shape — no SPL branch to provide
						     visual cue (USDC at least has SPL/EVM
						     dimorphism).  This is the highest cross-
						     network-confusion surface on Morphit. -->
						<aside
							class="rounded-md border border-orange-400/30 bg-orange-400/5 px-2.5 py-2 text-xs text-orange-200"
							role="note"
						>
							{$_('assets.dai.address_share.warning', {
								values: { network: $_(`assets.dai.network.${p.network}.displayName`) }
							})}
						</aside>
					{/if}
					{#if xmrLooksStandard}
						<!-- Subaddress nudge — XMR addresses starting with
						     `4` (standard or integrated) link every received
						     payment to the same view key, allowing observers
						     to correlate trades on the public chain.
						     Subaddresses (`8`) break that link. -->
						<p class="text-xs italic opacity-70">
							{$_('chat.address.subaddress_tip')}
						</p>
					{/if}
					{#if p.method === 'blurt' && p.memo && isIncoming}
						<!-- Phase F.4 — Required-memo display.  When the
						     seller pinned a memo to this address pill, the
						     buyer MUST include it as their on-chain transfer
						     memo so the seller can match the payment to
						     this trade.  Red-tinted to be unmissable;
						     prominent mono-font for at-a-glance readability;
						     copy button for paste-into-wallet flows. -->
						<div
							class="rounded-lg border-2 border-red-400 bg-red-50 p-3 dark:border-red-600 dark:bg-red-950"
						>
							<p
								class="text-xs font-semibold uppercase tracking-wider text-red-900 dark:text-red-100"
							>
								{$_('chat.address.memo_required')}
							</p>
							<div class="mt-1 flex items-start gap-2">
								<code
									class="flex-1 break-all rounded-md bg-red-100 px-2 py-1.5 font-mono text-base font-bold tracking-widest text-red-900 dark:bg-red-900 dark:text-red-100"
								>
									{p.memo}
								</code>
								<button
									type="button"
									class="flex-none rounded-md border px-2 py-1 text-xs font-semibold {copiedKind ===
									'memo'
										? 'border-green-600 bg-green-600 text-white'
										: 'border-red-700 text-red-900 hover:bg-red-200 dark:border-red-500 dark:text-red-100 dark:hover:bg-red-900'}"
									onclick={() => copyText(p.memo as string, 'memo')}
								>
									{#if copiedKind === 'memo'}<span aria-hidden="true">✓</span>
										{$_('chat.address.pill_copied')}{:else}{$_('common.copy')}{/if}
								</button>
							</div>
							<p class="mt-2 text-xs text-red-900 dark:text-red-100">
								{$_('chat.address.memo_required_explain')}
							</p>
						</div>
					{/if}
					<div class="flex flex-wrap items-center gap-2">
						<button
							type="button"
							class="rounded-md border border-current px-2 py-1 text-xs font-semibold opacity-70 hover:opacity-100"
							onclick={() => (showQr = !showQr)}
							aria-expanded={showQr}
							aria-controls="qr-panel-{message.localSeq}"
						>
							{showQr ? $_('chat.address.pill_hide_qr') : $_('chat.address.pill_show_qr')}
						</button>
						{#if canPayNow}
							<button
								type="button"
								class="rounded-md border-2 border-morphit-btn bg-morphit-btn px-3 py-1 text-xs font-semibold text-white hover:brightness-110"
								onclick={() =>
									onPayNow?.({
										recipient: p.address,
										amount: parsedAmount,
										memo: p.memo,
										orderPermlink: p.orderPermlink
									})}
							>
								{$_('chat.address.pay_now')}
							</button>
						{/if}
						{#if canMarkSent}
							<button
								type="button"
								class="rounded-md border-2 border-morphit-btn bg-morphit-btn px-3 py-1 text-xs font-semibold text-white hover:brightness-110"
								onclick={() =>
									onMarkSent?.({
										method: p.method as
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
											| 'xrp',
										amount: p.amount,
										orderPermlink: p.orderPermlink,
										// cp26 DD-7 fix + cp30 — propagate the network
										// from the address payload to FundsSentModal so
										// the receiver doesn't have to re-pick a network
										// they already saw on the seller's pill.  Both
										// USDT, USDC, and DAI carry a network field; the other
										// single-network assets leave this undefined.
										network: p.network
									})}
							>
								{$_('chat.address.mark_sent')}
							</button>
						{/if}
					</div>
					{#if showQr}
						<div id="qr-panel-{message.localSeq}">
							<QrPanel payload={p} />
						</div>
					{/if}
					{#if p.note}
						<p class="text-xs italic opacity-80">{p.note}</p>
					{/if}
					{#if p.orderPermlink}
						<p class="text-xs opacity-60">
							{$_('chat.address.pill_for_order')}:
							<code class="ml-1 font-mono">{p.orderPermlink}</code>
						</p>
					{/if}
				</div>
			{:else if decoded?.kind === 'funds_sent'}
				{@const p = decoded.payload}
				{@const usdtFundsNetworkValid =
					p.method === 'usdt' && p.network !== undefined && isUsdtNetwork(p.network)}
				{@const usdcFundsNetworkValid =
					p.method === 'usdc' && p.network !== undefined && isUsdcNetwork(p.network)}
				{@const daiFundsNetworkValid =
					p.method === 'dai' && p.network !== undefined && isDaiNetwork(p.network)}
				<div class="flex flex-col gap-2">
					<!-- v1.5.0 — Payment Receipt title header (grandma-friendly:
					     names the bubble before the details). -->
					<div
						class="flex items-center gap-1.5 border-b border-black/10 pb-1.5 text-sm font-bold dark:border-white/10"
					>
						<span aria-hidden="true">🧾</span>
						{$_('chat.funds_sent.receipt_title')}
					</div>
					<div
						class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider opacity-70"
					>
						{#if p.method === 'btc'}
							{$_('chat.funds_sent.pill_title_btc')}
						{:else if p.method === 'xmr'}
							{$_('chat.funds_sent.pill_title_xmr')}
						{:else if p.method === 'bch'}
							{$_('chat.funds_sent.pill_title_bch')}
						{:else if p.method === 'ltc'}
							{$_('chat.funds_sent.pill_title_ltc')}
						{:else if p.method === 'dash'}
							{$_('chat.funds_sent.pill_title_dash')}
						{:else if p.method === 'doge'}
							{$_('chat.funds_sent.pill_title_doge')}
						{:else if p.method === 'zec'}
							{$_('chat.funds_sent.pill_title_zec')}
						{:else if p.method === 'arrr'}
							{$_('chat.funds_sent.pill_title_arrr')}
						{:else if p.method === 'dcr'}
							{$_('chat.funds_sent.pill_title_dcr')}
						{:else if p.method === 'sol'}
							{$_('chat.funds_sent.pill_title_sol')}
						{:else if p.method === 'eth'}
							{$_('chat.funds_sent.pill_title_eth')}
						{:else if p.method === 'xrp'}
							{$_('chat.funds_sent.pill_title_xrp')}
						{:else if p.method === 'usdt'}
							{#if usdtFundsNetworkValid}
								<span class="rounded-md bg-amber-400/20 px-2 py-0.5 font-bold text-amber-300">
									{$_(`assets.usdt.network.${p.network}.displayName`)}
								</span>
							{/if}
							{$_('chat.funds_sent.pill_title_usdt')}
						{:else if p.method === 'usdc'}
							<!-- Part 122 cp30 — USDC funds-sent pill.
							     Mirrors USDT shape but with Circle-blue
							     trim.  Network chip prefixes the title
							     so a glance at the chat tells the seller
							     which chain to scan. -->
							{#if usdcFundsNetworkValid}
								<span class="rounded-md bg-blue-400/20 px-2 py-0.5 font-bold text-blue-300">
									{$_(`assets.usdc.network.${p.network}.displayName`)}
								</span>
							{/if}
							{$_('chat.funds_sent.pill_title_usdc')}
						{:else if p.method === 'dai'}
							<!-- Part 122 cp31 — DAI funds-sent pill.
							     MakerDAO-orange chip to distinguish from
							     USDT amber + USDC Circle-blue.  Visually
							     consistent with the address-pill side. -->
							{#if daiFundsNetworkValid}
								<span class="rounded-md bg-orange-400/20 px-2 py-0.5 font-bold text-orange-300">
									{$_(`assets.dai.network.${p.network}.displayName`)}
								</span>
							{/if}
							{$_('chat.funds_sent.pill_title_dai')}
						{:else}
							{isOutgoing
								? $_('chat.funds_sent.pill_title_blurt')
								: $_('chat.funds_sent.pill_title_blurt_received')}
						{/if}
						{#if fullTimestamp !== ''}
							<span class="font-normal normal-case tracking-normal">
								{$_('chat.funds_sent.receipt_when', { values: { when: fullTimestamp } })}
							</span>
						{/if}
					</div>
					{#if p.amount}
						<div class="font-mono text-lg font-bold leading-tight">{p.amount}</div>
					{/if}
					{#if p.method === 'blurt' && verifyResult !== null}
						<!-- Phase F.4 verification badge, extended in
						     F.5 audit (F-14) to cover self-verification
						     of the user's own outgoing transfers.

						     Incoming (seller checking buyer's claim):
						     "Verified" / "Mismatch — wrong memo" etc.

						     Outgoing (buyer checking own broadcast):
						     "Sent as expected" / "Your wallet sent to
						     a different account" — distinct copy makes
						     wallet-typo bugs unmissable to the user
						     before the seller complains. -->
						{#if verifyResult === 'pending'}
							<div
								class="flex items-center gap-2 rounded-md bg-ink-100 px-2 py-1.5 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300"
							>
								<span class="inline-block h-3 w-3 animate-pulse rounded-full bg-ink-400"></span>
								{isOutgoing
									? $_('chat.funds_sent.self_verify_pending')
									: $_('chat.funds_sent.verify_pending')}
							</div>
						{:else if verifyResult.kind === 'verified'}
							<div
								class="flex items-center gap-2 rounded-md bg-green-100 px-2 py-1.5 text-xs font-semibold text-green-900 dark:bg-green-900/40 dark:text-green-200"
								role="status"
							>
								<span aria-hidden="true">✓</span>
								{isOutgoing
									? $_('chat.funds_sent.self_verify_verified')
									: $_('chat.funds_sent.verify_verified')}
							</div>
						{:else if verifyResult.kind === 'mismatch'}
							<div
								class="rounded-md border border-red-400 bg-red-50 p-2 text-xs text-red-900 dark:border-red-600 dark:bg-red-950 dark:text-red-100"
								role="alert"
							>
								<p class="font-semibold">
									⚠ {isOutgoing
										? $_('chat.funds_sent.self_verify_mismatch_title')
										: $_('chat.funds_sent.verify_mismatch_title')}
								</p>
								<p class="mt-1">
									{#if verifyResult.field === 'to'}
										{isOutgoing
											? $_('chat.funds_sent.self_verify_mismatch_to')
											: $_('chat.funds_sent.verify_mismatch_to')}
									{:else if verifyResult.field === 'from'}
										{isOutgoing
											? $_('chat.funds_sent.self_verify_mismatch_from')
											: $_('chat.funds_sent.verify_mismatch_from')}
									{:else if verifyResult.field === 'amount'}
										{isOutgoing
											? $_('chat.funds_sent.self_verify_mismatch_amount')
											: $_('chat.funds_sent.verify_mismatch_amount')}
									{:else}
										{isOutgoing
											? $_('chat.funds_sent.self_verify_mismatch_memo')
											: $_('chat.funds_sent.verify_mismatch_memo')}
									{/if}
								</p>
							</div>
						{:else if verifyResult.kind === 'not_found'}
							<div
								class="rounded-md bg-ink-100 px-2 py-1.5 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300"
							>
								{isOutgoing
									? $_('chat.funds_sent.self_verify_not_found')
									: $_('chat.funds_sent.verify_not_found')}
							</div>
						{:else if verifyResult.kind === 'wrong_op'}
							<div
								class="rounded-md border border-red-400 bg-red-50 p-2 text-xs text-red-900 dark:border-red-600 dark:bg-red-950 dark:text-red-100"
							>
								⚠ {isOutgoing
									? $_('chat.funds_sent.self_verify_wrong_op')
									: $_('chat.funds_sent.verify_wrong_op')}
							</div>
						{:else if verifyResult.kind === 'rpc_error'}
							<div
								class="rounded-md bg-ink-100 px-2 py-1.5 text-xs text-ink-500 dark:bg-ink-800 dark:text-ink-400"
							>
								{$_('chat.funds_sent.verify_rpc_error')}
							</div>
						{/if}
					{/if}
					<div class="flex items-start gap-2">
						<div class="flex min-w-0 flex-1 flex-col gap-0.5">
							<span class="text-xs opacity-70">
								{$_('chat.funds_sent.pill_txid_label')}
							</span>
							<code
								class="break-all rounded-md bg-black/10 px-2 py-1.5 font-mono text-xs dark:bg-black/30"
							>
								{p.txid}
							</code>
							{#if p.method !== 'blurt' && explorerLinksForTxid(p.method, p.txid, p.network).length > 0}
								<!-- v1.5.0 — external-chain (BTC/XMR/etc) receipts keep their
								     block-explorer link; there is no local explorer for those
								     assets. Blurt uses the local verify link below. -->
								<ExplorerLink urls={explorerLinksForTxid(p.method, p.txid, p.network)} />
							{/if}
							{#if p.method === 'blurt' && verifyResult !== null && verifyResult !== 'pending' && verifyResult.kind === 'verified'}
								<!-- t155 (Ken): "when i click on that text/hyperlink, it takes me
								     to a 404 Not Found page." morphitExplorerTxUrl returns a
								     LOCALE-LESS path (`/explorer/tx/…`); every other caller wraps
								     it in lp() — this one didn't, so the URL had no [lang] segment
								     and matched no route. Same class of bug as the cp470 push
								     click_path 404. -->
								{@const verifyPath = morphitExplorerTxUrl(p.txid)}
								{#if verifyPath}
									<!-- v1.5.0 — THIS instance's explorer only (no off-site
									     explorer; privacy #1 — no IP leak to a third party).
									     Shown only once the transfer is chain-verified. -->
										<!-- t155 (Ken): "I cannot see the text/link that is next to the
										     magnifying glass emoji/icon." It was text-morphit-emerald ON
										     the emerald receipt bubble — emerald on emerald. Now inherits
										     the bubble's own foreground (currentColor) — the convention
										     the Copy button beside it already uses — so it stays legible
										     on every bubble variant instead of being pinned to one
										     background. Underlined so it reads as a link without relying
										     on colour, with a stronger hover per Ken.

										     cp474 (t.txt #8) — Ken: "get rid of the underline that appears
										     under the magnifying glass and its text ... only show that
										     underline (as dots) when i mouseover". So: no underline at
										     rest, a DOTTED one on hover/focus. The link is still
										     discoverable without it — it's a magnifying glass next to the
										     words "Verify on block explorer", inside a receipt, and it
										     keeps its hover background + focus ring. Focus-visible gets the
										     same dots as hover: a keyboard user has no pointer to reveal
										     them with, and the ring alone shouldn't be the only signal. -->
									<a
										href={lp(verifyPath)}
										class="-mx-1 inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-xs font-semibold text-current no-underline decoration-current decoration-dotted underline-offset-2 opacity-90 transition-all hover:bg-current/10 hover:underline hover:opacity-100 focus:outline-none focus-visible:underline focus-visible:ring-2 focus-visible:ring-current"
									>
										<span aria-hidden="true">🔎</span>
										{$_('chat.funds_sent.verify_independently')}
									</a>
								{/if}
							{/if}
						</div>
						<!-- t155 (Ken): "the Copy button is not properly aligned next to the
						     Transaction field". The row is `items-start`, so Copy pinned to
						     the TOP while the Transaction column beside it is three stacked
						     lines (label → txid → verify link) — so it sat level with the
						     label instead of the field. self-center overrides just this
						     child; the row keeps items-start for the address pill above, whose
						     column is a different height. -->
						<button
							type="button"
							class="flex-none self-center rounded-md border px-2 py-1 text-xs font-semibold transition-all {copiedKind ===
							'txid'
								? 'border-green-600 bg-green-600 text-white opacity-100'
							: 'border-current opacity-70 hover:bg-current/10 hover:opacity-100'}"
							onclick={() => copyText(p.txid, 'txid')}
							aria-label={$_('common.copy') as string}
						>
							{#if copiedKind === 'txid'}<span aria-hidden="true">✓</span>
								{$_('chat.address.pill_copied')}{:else}{$_('common.copy')}{/if}
						</button>
					</div>
					{#if p.note}
						<p class="text-xs italic opacity-80">{p.note}</p>
					{/if}
					{#if p.orderPermlink}
						<p class="text-xs opacity-60">
							{$_('chat.address.pill_for_order')}:
							<code class="ml-1 font-mono">{p.orderPermlink}</code>
						</p>
					{/if}
				</div>
			{:else if decoded?.kind === 'mailing_address'}
				<!-- cp121: mailing-address pill.  Renders the full
				     address (recipient may need it to ship).  Copy
				     button copies the formatted multi-line address.
				     PRIVACY: address stays in E2E chat only. -->
				<div
					class="rounded-lg border border-morphit-emerald/40 bg-emerald-50/40 p-3 dark:border-morphit-emerald/30 dark:bg-emerald-950/20"
				>
					<div class="mb-1 flex items-center gap-2">
						<span aria-hidden="true">✉️</span>
						<span class="text-sm font-semibold text-emerald-800 dark:text-morphit-emerald">
							{$_('chat.mailing_address.pill_heading')}
						</span>
					</div>
					{#if decoded.payload.recipientName}
						<p class="font-mono text-sm">{decoded.payload.recipientName}</p>
					{/if}
					<p class="font-mono text-sm">{decoded.payload.street}</p>
					{#if decoded.payload.street2}
						<p class="font-mono text-sm">{decoded.payload.street2}</p>
					{/if}
					<p class="font-mono text-sm">
						{decoded.payload.city}{decoded.payload.state ? `, ${decoded.payload.state}` : ''}
						{decoded.payload.postalCode}
					</p>
					<p class="font-mono text-sm">{decoded.payload.country}</p>
					{#if decoded.payload.note}
						<p class="mt-2 text-xs italic opacity-75">{decoded.payload.note}</p>
					{/if}
					<button
						type="button"
						class="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 hover:underline dark:text-morphit-emerald"
						onclick={() => {
							const p = decoded.kind === 'mailing_address' ? decoded.payload : null;
							if (!p) return;
							const lines: string[] = [];
							if (p.recipientName) lines.push(p.recipientName);
							lines.push(p.street);
							if (p.street2) lines.push(p.street2);
							lines.push(`${p.city}${p.state ? `, ${p.state}` : ''} ${p.postalCode}`);
							lines.push(p.country);
							void navigator.clipboard?.writeText(lines.join('\n'));
						}}
					>
						<span aria-hidden="true">📋</span>
						{$_('chat.mailing_address.copy_button')}
					</button>
					{#if decoded.payload.orderPermlink}
						<p class="mt-2 text-xs opacity-60">
							{$_('chat.mailing_address.for_order')}:
							<code class="ml-1 font-mono">{decoded.payload.orderPermlink}</code>
						</p>
					{/if}
				</div>
			{:else if decoded?.kind === 'shipment'}
				<!-- cp121: shipment pill.  Carrier + tracking + optional
				     clickable "Track package" link.  Recipient's click
				     goes to carrier's tracking page in a new tab
				     (rel=noopener so referrer is suppressed). -->
				{@const sh = decoded.payload}
				{@const carrierEntry = sh.carrier === 'other' ? null : CARRIERS_LOOKUP.get(sh.carrier)}
				{@const carrierDisplay = carrierEntry?.name ?? sh.customCarrierName ?? sh.carrier}
				{@const trackingUrl =
					sh.carrier === 'other'
						? (sh.customTrackingUrl ?? null)
						: carrierEntry?.trackingUrlTemplate
							? buildTrackingUrl(carrierEntry.trackingUrlTemplate, sh.tracking)
							: null}
				<div
					class="rounded-lg border border-blue-400/40 bg-blue-50/40 p-3 dark:border-blue-400/30 dark:bg-blue-950/20"
				>
					<div class="mb-1 flex items-center gap-2">
						<span aria-hidden="true">📦</span>
						<span class="text-sm font-semibold text-blue-700 dark:text-blue-300">
							{$_('chat.shipment.pill_heading', { values: { carrier: carrierDisplay } })}
						</span>
					</div>
					<p class="font-mono text-sm">{sh.tracking}</p>
					{#if sh.note}
						<p class="mt-2 text-xs italic opacity-75">{sh.note}</p>
					{/if}
					<div class="mt-2 flex flex-wrap items-center gap-3 text-xs">
						<button
							type="button"
							class="inline-flex items-center gap-1 font-semibold text-blue-700 hover:underline dark:text-blue-300"
							onclick={() => void navigator.clipboard?.writeText(sh.tracking)}
						>
							<span aria-hidden="true">📋</span>
							{$_('chat.shipment.copy_button')}
						</button>
						{#if trackingUrl}
							<a
								href={trackingUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 font-semibold text-blue-700 hover:underline dark:text-blue-300"
							>
								<span aria-hidden="true">🔗</span>
								{$_('chat.shipment.track_button')}
							</a>
						{/if}
					</div>
					{#if sh.orderPermlink}
						<p class="mt-2 text-xs opacity-60">
							{$_('chat.shipment.for_order')}:
							<code class="ml-1 font-mono">{sh.orderPermlink}</code>
						</p>
					{/if}
				</div>
			{:else if decoded?.kind === 'unknown_version'}
				<span class="italic text-ink-500 dark:text-ink-400">
					{$_('chat.unknown_version')}
				</span>
			{:else if decoded?.kind === 'unknown_kind'}
				<!-- Phase F.5 audit fix (F-2) — same UI treatment as
				     unknown_version: surfaces "old client, please
				     update" rather than raw JSON. -->
				<span class="italic text-ink-500 dark:text-ink-400">
					{$_('chat.unknown_version')}
				</span>
			{:else}
				<span class="whitespace-pre-wrap"
					>{#each textSegments as seg}{#if seg.link}<a
								href={safeContactUrl(seg.value)}
								target="_blank"
								rel="noopener noreferrer nofollow"
								class="break-all underline">{seg.value}</a
							>{:else}{seg.value}{/if}{/each}</span
				>
			{/if}
		</div>

		<!-- cp402 [5] — screen-reader-only send time, always present for
		     confirmed messages so assistive tech has the timestamp without
		     needing the pointer/touch reveal below. -->
		{#if fullTimestamp}
			<time class="sr-only" datetime={message.createdAt?.toISOString()}>{fullTimestamp}</time>
		{/if}

		<!-- cp402 [5] — tap-to-reveal timestamp popover. Appears when the
		     user taps/clicks the bubble; dismissed by tapping again, tapping
		     outside, or Escape. Anchored just below the bubble, on the
		     sender's side. pointer-events-none so it never eats the
		     dismiss tap. -->
		{#if showTimestamp && fullTimestamp}
			<div
				data-ts-tip
				role="tooltip"
				class="pointer-events-none absolute top-full z-30 mt-1 whitespace-nowrap rounded-lg bg-ink-900 px-2 py-1 text-xs font-medium text-ink-50 shadow-lg dark:bg-ink-100 dark:text-ink-900"
				class:right-0={isOutgoing}
				class:left-0={!isOutgoing}
			>
				{fullTimestamp}
			</div>
		{/if}

		<!-- Meta line: sending indicator for in-flight, error + retry for
		     failed. cp402 [5] removed the persistent confirmed-message
		     timestamp (now tap-to-reveal above), so this line renders only
		     when there's in-flight or failed status to show — a confirmed
		     bubble carries no meta line at all. -->
		{#if isSending || isFailed}
			<div
				class="flex items-center gap-2 text-xs text-ink-500 dark:text-ink-400"
				class:justify-end={isOutgoing}
				class:justify-start={!isOutgoing}
			>
				{#if isSending}
					<span aria-live="polite">{$_('chat.message.sending')}</span>
				{:else if isFailed}
					<span class="text-red-700 dark:text-red-300">
						{$_('chat.message.failed_label')}
					</span>
					<button
						type="button"
						class="rounded font-semibold text-morphit-emerald hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
						onclick={() => onRetry?.(message.localSeq)}
						aria-label={$_('chat.message.retry_aria') as string}
					>
						{$_('chat.message.retry')}
					</button>
				{/if}
			</div>
		{/if}

		<!-- Detailed error message on failed, below the meta line. Present
		     only if the controller captured one; some failure paths leave
		     error null (e.g. locked identity was caught before capture).
		     Sentinel error codes (like 'peer_not_ready' or the four
		     pub_pin_* security codes from Option 5) get localized
		     prose; unrecognized error strings are shown as-is because
		     they're useful technical details. -->
		{#if isFailed && message.error}
			<p class="break-words text-xs text-red-700 dark:text-red-300">
				{#if message.error === 'peer_not_ready'}
					{$_('chat.message.peer_not_ready')}
				{:else if message.error === 'pub_pin_tampered_same_ref'}
					{$_('chat.security.pub_pin_tampered_same_ref')}
				{:else if message.error === 'pub_pin_older_indexer_ref'}
					{$_('chat.security.pub_pin_older_indexer_ref')}
				{:else if message.error === 'pub_pin_chain_reports_none'}
					{$_('chat.security.pub_pin_chain_reports_none')}
				{:else if message.error === 'pub_pin_chain_older_than_pin'}
					{$_('chat.security.pub_pin_chain_older_than_pin')}
				{:else if message.error === 'pub_pin_malformed_indexer_response'}
					{$_('chat.security.pub_pin_malformed_indexer_response')}
				{:else}
					{message.error}
				{/if}
			</p>
			<!-- Deep-link to the FAQ explainer for any pub_pin_* error.
			     The four security codes share one FAQ entry
			     (chat_key_changed) so a single link works for all of
			     them. -->
			{#if typeof message.error === 'string' && message.error.startsWith('pub_pin_')}
				<a
					href={lp('/faq#chat_key_changed')}
					class="text-xs text-red-700 underline hover:no-underline dark:text-red-300"
				>
					{$_('common.learn_more')}
				</a>
			{/if}
		{/if}
	</div>
</li>
