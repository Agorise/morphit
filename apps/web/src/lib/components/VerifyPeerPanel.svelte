<script lang="ts">
	/**
	 * VerifyPeerPanel — opt-in out-of-band safety-number check.
	 *
	 * Lets a user compare the conversation's 60-digit safety number
	 * ($lib/chat/fingerprint) with their counterparty's over a channel
	 * they already trust (voice, in person, another platform), as a
	 * defense against an indexer substituting chat keys.
	 *
	 * ─── UX principles ────────────────────────────────────────
	 *
	 * - Opt-in: only renders when explicitly opened from the
	 *   conversation overflow menu.
	 * - Hidden by default: no badge, no banner, no popup.
	 *   Default conversation UX is identical to before.
	 * - No telemetry: we don't track that the user tapped it.
	 * - No verified-state persistence: comparing successfully
	 *   does NOT change any UI state going forward.  We
	 *   deliberately avoid a "verified" badge because that
	 *   creates a two-tier system that pressures everyone.  The
	 *   only thing remembered (per device) is that the one-time
	 *   "the number is longer now, compare once more" note was
	 *   dismissed — the old 8-word fingerprint was too short.
	 * - Stays in-app: no external links.  FAQ excerpt shown
	 *   inline so users who want to read more don't get
	 *   redirected to an external page that could fingerprint
	 *   them.
	 *
	 * ─── Computation flow ────────────────────────────────────
	 *
	 * 1. On mount, derive my chat keypair from the live
	 *    posting key (same path the chat send uses).
	 * 2. Fetch the peer's chat pub via the chain-anchored
	 *    fetcher in $lib/chat/peerPubFetch — same path the
	 *    chat-send flow uses, so the fingerprint reflects the
	 *    key actually being used to encrypt messages.
	 * 3. computeSafetyNumber(me, peer) — each party's 30 digits
	 *    come from that party's own account + chat key, so a
	 *    substituted key changes its half (see fingerprint.ts).
	 * 4. Display the 12 groups of 5 digits in a stable layout.
	 *
	 * Failure modes surfaced to the UI:
	 *   - peer hasn't published their chat key yet → "peer
	 *     not ready" message + "try again later".
	 *   - locked / no live identity → "unlock first" prompt.
	 *   - chain-verified fetcher detects tampering → strong
	 *     red "DO NOT continue chatting" banner with stable
	 *     error code.  The fingerprint is INTENTIONALLY not
	 *     computed in this state — comparing fingerprints of
	 *     a key the chain has rejected would mislead the user.
	 *   - any other error → generic "couldn't compute" with
	 *     a retry button.
	 *
	 * Closing the modal does NOT persist any state.  Re-opening
	 * recomputes from scratch.  This is by design — the
	 * fingerprint is cheap to compute and we don't want a
	 * stale value sitting in memory if keys rotated.
	 */

	import { _ } from 'svelte-i18n';
	import { onDestroy, onMount } from 'svelte';
	import { computeSafetyNumber } from '$lib/chat/fingerprint';
	import { deriveChatIdentity, decodeChatPub } from '$lib/chat/crypto';
	import { fetchPeerChatPubChainVerified } from '$lib/chat/peerPubFetch';
	import { PUB_PIN_ERROR, acceptKeyChange, pendingKeyChange } from '$lib/chat/pubPin';
	import { identity, isUnlocked } from '$stores/identity';
	import { get } from 'svelte/store';
	import { safeLocal } from '$lib/utils/safeStorage';

	/** Device flag: the one-time "compare once more" note was dismissed. */
	const REVERIFY_SEEN_KEY = 'morphit.chat.safetyNumberV2Seen';
	let showReverify = $state(false);
	function dismissReverify(): void {
		showReverify = false;
		safeLocal.set(REVERIFY_SEEN_KEY, '1');
	}

	interface Props {
		readonly me: string;
		readonly peer: string;
		readonly onClose: () => void;
	}

	let { me, peer, onClose }: Props = $props();

	// ─── State ────────────────────────────────────────────────
	type State =
		| { kind: 'computing' }
		| { kind: 'locked' }
		| { kind: 'peer_not_ready' }
		| { kind: 'tamper_detected'; code: string }
		/** The peer's key changed: the NEW safety number, to compare before
		 *  accepting (nothing is sent to the new key until then). */
		| { kind: 'key_changed'; words: readonly string[] }
		| { kind: 'error'; message: string }
		| { kind: 'ready'; words: readonly string[] };

	let panelState = $state<State>({ kind: 'computing' });
	let showWhy = $state(false);

	// ─── Cancellation (Finding C-4) ────────────────────────────
	/** Set true when the component unmounts.  In-flight compute()
	 *  branches consult this before writing to state, so a fast
	 *  close-during-fetch doesn't leave async work writing into a
	 *  destroyed component or accumulating stale buffers. */
	let aborted = false;

	onMount(() => {
		showReverify = safeLocal.get(REVERIFY_SEEN_KEY) !== '1';
		void compute();
		// Esc-key dismiss.
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	onDestroy(() => {
		aborted = true;
	});

	async function compute(): Promise<void> {
		panelState = { kind: 'computing' };

		// Must be unlocked: we need the posting priv key to derive
		// our own chat identity.  Stays-locked path: surface
		// "unlock first" rather than computing over noise.
		if (!get(isUnlocked)) {
			panelState = { kind: 'locked' };
			return;
		}
		const id = get(identity);
		if (id.state !== 'unlocked') {
			panelState = { kind: 'locked' };
			return;
		}

		let myPriv: Uint8Array | null = null;
		try {
			// Derive my chat identity.  This is the same derivation
			// the chat send path uses; deterministic from posting
			// key + account name.  Note: deriveChatIdentity returns
			// LIVE priv-key material — wipe it after we're done in
			// the finally.
			const mine = await deriveChatIdentity(id.live.posting.privateKey, me);
			myPriv = mine.priv;
			if (aborted) return;

			// Fetch peer's chat pub via the SAME chain-anchored
			// path the chat-send flow uses.  This guarantees the
			// fingerprint reflects the key actually being used to
			// encrypt messages.  See peerPubFetch.ts for the
			// threat-model rationale.
			const peerResult = await fetchPeerChatPubChainVerified(peer);
			if (aborted) return;
			switch (peerResult.kind) {
				case 'not_published':
					panelState = { kind: 'peer_not_ready' };
					return;
				case 'tamper_detected': {
					const pending =
						peerResult.code === PUB_PIN_ERROR.key_changed ? pendingKeyChange(peer) : null;
					if (pending !== null) {
						const words = await computeSafetyNumber(
							{ account: me, pub: mine.pub },
							{ account: peer, pub: decodeChatPub(pending.pubB64) }
						);
						if (aborted) return;
						panelState = { kind: 'key_changed', words };
						return;
					}
					// Pub-pin or chain check FIRED.  We surface a
					// specific state because this is a real
					// security event the user should know about
					// regardless of whether they were going to
					// compare fingerprints.
					panelState = { kind: 'tamper_detected', code: peerResult.code };
					return;
				}
				case 'malformed_key':
					panelState = {
						kind: 'error',
						message: $_('chat.verify_peer.error_bad_key') as string
					};
					return;
				case 'chain_unreachable':
					// NOT a security event. We could not reach the chain to check
					// at all, which on a Tor/I2P instance is an ordinary, transient
					// thing. Rendering the red tamper banner here would teach the
					// user to dismiss it, and that banner has to mean something.
					panelState = {
						kind: 'error',
						message: $_('chat.verify_peer.error_chain_unreachable') as string
					};
					return;
				case 'indexer_error':
					panelState = {
						kind: 'error',
						message: $_('chat.verify_peer.error_indexer') as string
					};
					return;
				case 'ok':
					break;
			}

			// libsodium's SHA-512, so this works on plain-HTTP I2P addresses too.
			const words = await computeSafetyNumber(
				{ account: me, pub: mine.pub },
				{ account: peer, pub: peerResult.pub }
			);
			if (aborted) return;
			panelState = { kind: 'ready', words };
		} catch (_err) {
			if (aborted) return;
			panelState = {
				kind: 'error',
				message: $_('chat.verify_peer.error_unknown') as string
			};
		} finally {
			// Wipe the priv-key material as soon as we're done with
			// it.  The pub is not secret; no need.  This runs even
			// when aborted — cleanup must never be skipped.
			if (myPriv) {
				myPriv.fill(0);
			}
		}
	}

	/** The user compared the new number with the peer and it matched. */
	function acceptNewKey(): void {
		if (acceptKeyChange(peer)) void compute();
	}

	function handleBackdropClick(e: MouseEvent): void {
		if (e.target === e.currentTarget) onClose();
	}
</script>

<!-- Modal scaffold matches the codebase's other modal components
     (FundsSentModal, AddressShareModal, etc.) -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="verify-peer-heading"
	onclick={handleBackdropClick}
	onkeydown={(e) => {
		if (e.key === 'Escape') onClose();
	}}
	tabindex="-1"
>
	<div
		class="card max-h-[95dvh] w-full max-w-lg overflow-y-auto overscroll-contain"
		role="document"
	>
		<h2 id="verify-peer-heading" class="font-display text-xl font-bold">
			{$_('chat.verify_peer.title')}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('chat.verify_peer.subtitle', { values: { peer } })}
		</p>

		<!-- ── Body branches on state ─────────────────────────── -->

		{#if panelState.kind === 'computing'}
			<div class="mt-6 flex items-center justify-center py-8">
				<span class="text-sm text-ink-500 dark:text-ink-400">
					{$_('chat.verify_peer.computing')}
				</span>
			</div>
		{:else if panelState.kind === 'locked'}
			<div
				class="mt-5 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
			>
				{$_('chat.verify_peer.locked')}
			</div>
		{:else if panelState.kind === 'peer_not_ready'}
			<div
				class="mt-5 rounded-lg border border-ink-300 bg-ink-50 p-4 text-sm text-ink-700 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200"
			>
				{$_('chat.verify_peer.peer_not_ready')}
			</div>
		{:else if panelState.kind === 'tamper_detected'}
			<!-- This is a real security event.  Pub-pin or chain
			     verification refused this fetch — either someone
			     tampered with the indexer's chat-pub response, or
			     the chain itself disagrees with the indexer's
			     reference.  We render a strong red banner because
			     the user is already in a vulnerable position; we
			     don't want them dismissing this as a routine
			     warning.  The fingerprint is INTENTIONALLY not
			     computed in this state — comparing fingerprints
			     of a key the chain has rejected would mislead the
			     user into thinking everything's fine. -->
			<div
				class="mt-5 rounded-lg border-2 border-red-500 bg-red-50 p-4 text-sm text-red-900 dark:border-red-500 dark:bg-red-950 dark:text-red-100"
			>
				<p class="font-bold">{$_('chat.verify_peer.tamper_heading')}</p>
				<p class="mt-1">{$_('chat.verify_peer.tamper_body')}</p>
				<p class="mt-2 text-xs text-red-700 dark:text-red-300">
					<span class="font-mono">code: {panelState.code}</span>
				</p>
			</div>
		{:else if panelState.kind === 'key_changed'}
			<div
				class="mt-5 rounded-lg border-2 border-amber-500 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100"
			>
				<p class="font-bold">{$_('chat.verify_peer.key_changed_heading')}</p>
				<p class="mt-1">{$_('chat.verify_peer.key_changed_body', { values: { peer } })}</p>
			</div>
			<div
				class="mt-4 grid grid-cols-3 gap-x-6 gap-y-2 rounded-lg border border-ink-300 p-4 font-mono text-base dark:border-ink-700 sm:grid-cols-4"
				dir="ltr"
				aria-label={$_('chat.verify_peer.fingerprint_aria') as string}
			>
				{#each panelState.words as group, i (i)}
					<span
						class="text-center font-semibold"
						aria-label={`${$_('chat.verify_peer.word_n', { values: { n: i + 1 } })}: ${group}`}
						>{group}</span
					>
				{/each}
			</div>
			<div class="mt-3">
				<button
					type="button"
					class="rounded-lg border-2 border-ink-300 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-ink-100 dark:border-ink-600 dark:bg-ink-900 dark:hover:bg-ink-800"
					onclick={acceptNewKey}
				>
					{$_('chat.verify_peer.key_changed_accept')}
				</button>
			</div>
		{:else if panelState.kind === 'error'}
			<div
				class="mt-5 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
			>
				{panelState.message}
			</div>
			<div class="mt-3">
				<button
					type="button"
					class="rounded-lg border-2 border-ink-300 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-ink-100 dark:border-ink-600 dark:bg-ink-900 dark:hover:bg-ink-800"
					onclick={() => void compute()}
				>
					{$_('chat.verify_peer.retry')}
				</button>
			</div>
		{:else if panelState.kind === 'ready'}
			{#if showReverify}
				<div
					class="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
				>
					<p class="font-semibold">{$_('chat.verify_peer.reverify_heading')}</p>
					<p class="mt-1">{$_('chat.verify_peer.reverify_body')}</p>
					<button
						type="button"
						class="mt-2 text-sm font-semibold underline underline-offset-2"
						onclick={dismissReverify}
					>
						{$_('chat.verify_peer.reverify_ok')}
					</button>
				</div>
			{/if}
			<!-- The number: 12 groups of 5 digits, monospace, large enough to
			     read aloud cleanly. Equal visual weight for every group — we
			     don't want users skimming and missing a tampered middle group. -->
			<div
				class="mt-5 rounded-lg border-2 border-morphit-emerald bg-morphit-emerald/5 p-4"
				aria-label={$_('chat.verify_peer.fingerprint_aria') as string}
			>
				<div class="grid grid-cols-3 gap-x-6 gap-y-2 font-mono text-base sm:grid-cols-4" dir="ltr">
					{#each panelState.words as word, i (i)}
						<div
							class="break-words text-center"
							aria-label={`${$_('chat.verify_peer.word_n', { values: { n: i + 1 } })}: ${word}`}
						>
							<span
								class="block text-[10px] uppercase tracking-widest text-ink-400 dark:text-ink-500"
							>
								{i + 1}
							</span>
							<span class="font-semibold">{word}</span>
						</div>
					{/each}
				</div>
			</div>

			<!-- Instruction copy.  Emphasizes OOB channel. -->
			<div
				class="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm text-ink-700 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200"
			>
				<p class="font-semibold">{$_('chat.verify_peer.compare_heading')}</p>
				<p class="mt-1">{$_('chat.verify_peer.compare_body')}</p>
			</div>

			<!-- Why-this-matters expander — kept inline (no external
			     link) and collapsed by default to avoid wall-of-text. -->
			<button
				type="button"
				class="mt-3 text-xs text-morphit-emerald hover:underline"
				onclick={() => (showWhy = !showWhy)}
				aria-expanded={showWhy}
			>
				{showWhy ? $_('chat.verify_peer.why_hide') : $_('chat.verify_peer.why_show')}
			</button>
			{#if showWhy}
				<div
					class="mt-2 rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
				>
					{$_('chat.verify_peer.why_body')}
				</div>
			{/if}
		{/if}

		<!-- Close button: same affordance regardless of state. -->
		<div class="mt-6 flex justify-end">
			<button
				type="button"
				class="rounded-lg border-2 border-ink-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-ink-100 dark:border-ink-600 dark:bg-ink-900 dark:hover:bg-ink-800"
				onclick={onClose}
			>
				{$_('common.close')}
			</button>
		</div>
	</div>
</div>
