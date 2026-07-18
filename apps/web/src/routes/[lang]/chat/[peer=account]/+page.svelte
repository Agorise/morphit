<script lang="ts">
	/**
	 * /chat/[peer] — a single conversation view.
	 *
	 * Layout (cp402 [9]): this is an IMMERSIVE full-viewport route — the
	 * [lang] layout detects it (isImmersiveChat), gives <main> a definite
	 * height as a min-h-0 flex column, and suppresses the marketing footer,
	 * so ConversationView (and this loading shell) fill the space below the
	 * header with the composer pinned + always visible. ConversationView
	 * owns the inner flex-column / scroll-container / composer layout.
	 *
	 * Redirects:
	 *   - No signing identity in this browser (signed out, or never
	 *     onboarded) → /login?next=… (the unlock screen if a keystore is
	 *     remembered, else sign-in/import — which leads to onboarding only
	 *     if they truly need a new account). NOT straight to /onboarding.
	 *   - Fully locked (keystore present, not unlocked) → /login?next=…
	 *     via <RequireLiveSession /> below.
	 *   - Chatting with yourself (peer === me) → /chat (inbox)
	 *
	 * The peer segment is validated by the `account` route matcher,
	 * so garbage URLs 404 before we render anything.
	 *
	 * On mount, this route does two things in the background (both
	 * non-blocking, both best-effort):
	 *
	 *   1. Auto-publish the user's chat identity (ADR-0015) if not
	 *      already published. Opening a specific conversation is the
	 *      signal the user is engaging with chat, so publishing makes
	 *      sense here (vs. the inbox, which is read-only).
	 *
	 *   2. Broadcast a `morphit_chat_read_v1` ack for this peer
	 *      (Phase B read receipts). Also shadow-writes local
	 *      readState so the inbox reflects the read immediately on
	 *      navigate-back without waiting for an indexer roundtrip.
	 *      Same "user engaging with chat" rationale.
	 *
	 * Entry points into this route:
	 *   - From /@{account}/{permlink} (order detail) via "Message
	 *     the poster" button
	 *   - From /@{account} (profile page) via "Message" button
	 *   - Deep links shared between users
	 */

	import { onMount } from 'svelte';
	import type { Component } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { gotoLocale } from '$i18n/navigate';
	import RequireLiveSession from '$components/RequireLiveSession.svelte';
	import { get } from 'svelte/store';

	import Head from '$components/Head.svelte';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { recordRecentPeer } from '$lib/chat/recentPeers';
	import { markConversationRead } from '$lib/chat/readState';
	import { liveIdentity } from '$lib/stores/identity';

	// peer is a route parameter; always defined when this page
	// renders.  The non-null assertion is safe because SvelteKit
	// would not have routed here without it.
	const peer = $derived($page.params.peer!);

	/** Phase F — order context.  When this conversation was opened
	 *  from an order detail page (or a deep link with ?order=...),
	 *  the address-share + funds-sent modals pre-fill the
	 *  order_permlink field so both parties see which trade the
	 *  address is for.  Validated here against the same regex
	 *  payload.ts uses; invalid values silently fall through to
	 *  "no order context" rather than breaking the chat. */
	const ORDER_PERMLINK_RE = /^[a-z0-9][a-z0-9-]{2,255}$/;
	const orderPermlink = $derived.by(() => {
		const raw = $page.url.searchParams.get('order');
		if (raw === null) return undefined;
		if (!ORDER_PERMLINK_RE.test(raw)) return undefined;
		return raw;
	});

	/** Local user's Blurt account — null if they haven't registered
	 *  an account on-chain yet. Without it we can't send or receive. */
	let me: string | null = $state(null);
	let bootError = $state('');

	/** Lazy-loaded ConversationView component.
	 *
	 *  Phase E.5 — chat is lazy-loaded.  ConversationView's
	 *  transitive deps include chatService → crypto.ts →
	 *  libsodium-wrappers-sumo (~250kB), plus the chat stream
	 *  composable, ChatComposer, ChatMessage, IdentityLabel,
	 *  ConfirmModal, etc.  Static-importing here would pull all
	 *  of that into the route's main chunk, which any user landing
	 *  on /chat/[peer] from a deep-link would pay for upfront.
	 *
	 *  Dynamic import means Vite splits ConversationView and its
	 *  deps into a separate chunk, fetched only after this route
	 *  mounts.  The shell renders a minimal skeleton during the
	 *  network round-trip; on a fast connection the user
	 *  perceives no delay.
	 *
	 *  Same lazy-load posture as the inbox /chat — that page
	 *  already documented "doesn't derive chat keys, doesn't
	 *  publish a chat identity, doesn't run libsodium-backed
	 *  crypto."  This route now matches: heavy crypto loads only
	 *  when ConversationView mounts. */
	let ConversationViewComponent: Component<{
		me: string;
		peer: string;
		orderPermlink?: string;
	}> | null = $state(null);
	let lazyLoadError = $state('');

	onMount(() => {
		// Wrap bootstrap in try/catch so any thrown error has a
		// surfaced path (line 71's bootError state was unwired
		// pre-Part 72; now it's actually reachable). The most
		// likely failure mode is `getUserBlurtAccount()` throwing
		// from a corrupt localStorage entry; the user gets a
		// friendly message instead of a blank screen.
		let myAccount: string | null;
		try {
			myAccount = getUserBlurtAccount();
		} catch (err) {
			console.warn('[chat] getUserBlurtAccount threw:', err);
			bootError = $_('chat.boot_failed');
			return;
		}
		if (!myAccount) {
			// No signing identity in this browser (signed out, or never
			// onboarded). Chat needs a sender identity, so send them to the
			// login/unlock hub — NOT onboarding: /login shows the welcome-
			// back unlock screen if a keystore is remembered, or sign-in/
			// import options otherwise (which lead to onboarding only if they
			// genuinely need a new account). Carry ?next= so a successful
			// login forwards them back to this conversation (cp356), mirroring
			// the <RequireLiveSession /> locked-visitor redirect below.
			const here = window.location.pathname + window.location.search + window.location.hash;
			gotoLocale('/login?next=' + encodeURIComponent(here));
			return;
		}
		if (myAccount === peer) {
			// Self-chat. Route to the inbox instead.
			gotoLocale('/chat');
			return;
		}
		me = myAccount;
		// Record this conversation for the inbox fallback list. Idempotent.
		recordRecentPeer(peer);

		// Lazy-load the heavy ConversationView component.  This is
		// the chunk that pulls libsodium + the chat stream composable
		// + the chat service controller.  Done in parallel with the
		// other deferred work below so the user perceives a single
		// shell→ready transition rather than several stalls.
		void import('$components/ConversationView.svelte')
			.then((mod) => {
				ConversationViewComponent = mod.default as Component<{
					me: string;
					peer: string;
					orderPermlink?: string;
				}>;

				// Phase B read-ack — moved INSIDE the lazy-load .then
				// callback (Part 72). Pre-Part-72 this fired in the
				// onMount body unconditionally, so a chunk-load failure
				// would still mark the conversation read despite the
				// user never having seen it. Now the ack only fires
				// once the view has actually loaded and is about to be
				// rendered. The "user is looking at the conversation"
				// claim is now actually true.
				//
				// The local write happens unconditionally; the on-chain
				// broadcast only runs if the user has an unlocked
				// session identity (broadcastChatRead signs with the
				// posting key). If the session is locked, the local
				// state still updates and we'll ack next time the user
				// is unlocked and re-opens.
				//
				// v1.7.7 — this ack CANNOT be clamped, and that is fine.
				// This page is a shell: it lazy-loads ConversationView and holds
				// no messages, so there is no block time here to clamp against
				// (`readAckTimestamp` needs the newest message it is acking).
				// It does not need one, because it is the WEAKEST of three acks
				// and the only unclamped one:
				//   1. inbox `handleOpen` — clamped against the row's
				//      last_message_at, fires on navigation (v1.7.7).
				//   2. this one — a belt-and-braces ack in case ConversationView
				//      never renders.
				//   3. ConversationView `ackRead()` — clamped against
				//      latestConfirmedAt(), and authoritative.
				// A slow clock makes THIS ack a no-op (the cursor lands behind
				// the message, so the thread simply stays unread) rather than
				// wrong — and (1) and (3) both correct it with real block times.
				// Never make this one "smarter" by inventing a timestamp: an
				// unclamped cursor that RUNS AHEAD would silence a message the
				// user never saw, which is the one failure that actually costs
				// something.
				//
				// Ack timestamp is Date.now(): the user is looking at
				// the conversation now, so any message they haven't
				// yet seen would not be in their view either. Slight
				// over-ack if a new message arrives during the mount
				// frame; mitigated by re-opening the conversation
				// (which re-acks).
				// cp446 — the on-chain ack names the discussion, so reading one thread
				// with a peer never silences the others, on this device or any other.
				markConversationRead(peer, orderPermlink ?? '');
				const live = get(liveIdentity);
				if (live) {
					void import('$blurt/ops/chatRead').then(async (m) => {
						try {
							await m.broadcastChatRead(live, peer, orderPermlink ?? '');
						} catch {
							// Network / node error — silent. The local
							// read state is still correct; cross-device
							// sync will catch up when the user next
							// acks successfully.
						}
					});
				}
			})
			.catch((err) => {
				// Network/parse error fetching the chunk.  Surface
				// minimally — the user can refresh.  Most chunk-load
				// failures resolve themselves on retry (transient CDN
				// hiccups).
				console.warn('[chat] ConversationView lazy load failed:', err);
				lazyLoadError = $_('chat.lazy_load_failed');
			});

		// Background auto-publish of our chat identity (ADR-0015).
		// Dynamic import so the crypto module (which pulls in
		// libsodium work for the derivation) only loads on this
		// route, not on any page that statically imports from here.
		// Non-blocking — the user never waits for this. Kept
		// outside the lazy-load .then because identity publication
		// is independent of whether the conversation view loaded
		// (a future revisit could surface a "your chat is
		// receivable" badge in some other route once this resolves).
		void import('$lib/chat/ensureChatIdentity').then((m) => m.ensureChatIdentityPublished());
	});
</script>

<Head routeKey="chat_conversation" noindex />

<RequireLiveSession />

{#if bootError}
	<section class="mx-auto max-w-2xl px-4 py-8">
		<p class="text-red-700 dark:text-red-300">{bootError}</p>
	</section>
{:else if lazyLoadError}
	<section class="mx-auto max-w-2xl px-4 py-8">
		<p class="text-red-700 dark:text-red-300">
			{$_('chat.lazy_load_failed')}
		</p>
		<p class="mt-2 text-sm text-ink-500 dark:text-ink-500">{lazyLoadError}</p>
	</section>
{:else if me && ConversationViewComponent}
	{@const Component = ConversationViewComponent}
	<!-- A conversation's identity is (peer, order). The controller captures
	     `peer` and `orderPermlink` once in onMount (runtimeDeps), so if the
	     ?order= query param changes on the SAME peer without a remount — e.g.
	     navigating between the null-order thread and the order thread — the
	     controller keeps a STALE orderPermlink and outgoing messages get the
	     wrong thread tag (or none), landing them in a different thread than the
	     one the user is viewing. Keying on (peer, order) forces a clean remount
	     whenever either changes, so deps.orderPermlink always matches the URL.
	     Fresh loads already have the right value (the $derived reads the query
	     param synchronously), so this only adds a remount on an actual change.

	     >>> THREADING MODEL INV-5 (client tag point). Read
	     >>> docs/CHAT-THREADING-MODEL.md before removing or changing this key.
	     >>> Guarded by chat-thread-remount-smoke (tamper-tested). -->
	{#key `${peer}\u0000${orderPermlink ?? ''}`}
		<Component {me} {peer} {orderPermlink} />
	{/key}
{:else}
	<!-- Loading shell — same vertical layout as ConversationView so
	     there's no layout shift when the component swaps in.  The
	     skeleton is intentionally minimal: a centered spinner
	     placeholder is loud, an empty bordered box is quiet.  We
	     pick quiet — fast connections see <1 frame of this; slow
	     ones see something purposeful instead of a flash. -->
	<section
		class="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-ink-600 dark:text-ink-400"
	>
		<p class="text-sm">{$_('chat.loading')}</p>
	</section>
{/if}
