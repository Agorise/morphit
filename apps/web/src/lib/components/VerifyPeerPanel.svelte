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
	 * POSTING KEYS ONLY (v1.21.14): every message is sent to the peer's
	 * posting keys and proved by them, so the number is made from them —
	 * ours as the chain lists them (what the peer pins for us), theirs as
	 * pinned here (opening the panel pins nothing). Chat keys are not
	 * compared any more: nothing is sent to one.
	 *
	 * 1. Read both accounts' posting keys (this instance's indexer).
	 * 2. computeSafetyNumber(me, peer) — each party's 30 digits
	 *    come from that party's own account + keys, so a
	 *    substituted key changes its half (see fingerprint.ts).
	 * 3. Display the 12 groups of 5 digits in a stable layout.
	 *
	 * Failure modes surfaced to the UI:
	 *   - no such account on chain → "no such account"; an account
	 *     with no posting key of its own → said so.
	 *   - locked / no live identity → "unlock first" prompt.
	 *   - the peer's posting keys CHANGED against the pin → the NEW
	 *     number, to compare before accepting (nothing is sent to the
	 *     new keys until then).
	 *   - the chain could not be asked → retry, never a security alarm.
	 *
	 * Closing the modal does NOT persist any state.  Re-opening
	 * recomputes from scratch.  This is by design — the
	 * fingerprint is cheap to compute and we don't want a
	 * stale value sitting in memory if keys rotated.
	 */

	import { _ } from 'svelte-i18n';
	import { onDestroy, onMount } from 'svelte';
	import { computeSafetyNumber } from '$lib/chat/fingerprint';
	import { orderPostingPubs } from '$lib/chat/chatService';
	import { fetchAccountKeys } from '$blurt/accountKeys';
	import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
	import { acceptPostingKeysShown, peekPostingKeyPin } from '$lib/chat/pubPin';
	import { identity, isUnlocked } from '$stores/identity';
	import { get } from 'svelte/store';
	import { safeLocal } from '$lib/utils/safeStorage';
	import { formatPublicKeyBLT } from '$lib/crypto/keygen';

	/** The posting public key this session signed in with, or null (locked,
	 *  a paired read-only desktop). */
	function ownPostingPublicKey(): Uint8Array | null {
		const s = get(identity) as { state?: string; live?: { posting?: { publicKey?: unknown } } };
		const pk = s.state === 'unlocked' ? s.live?.posting?.publicKey : undefined;
		return pk instanceof Uint8Array && pk.length === 33 ? pk : null;
	}

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
		/** Called after the user accepted the keys whose number was shown. */
		readonly onAccepted?: () => void;
		readonly onClose: () => void;
	}

	let { me, peer, onAccepted, onClose }: Props = $props();

	// ─── State ────────────────────────────────────────────────
	type State =
		| { kind: 'computing' }
		| { kind: 'locked' }
		/** The chain has no account by this name. */
		| { kind: 'no_account' }
		/** The account has no posting key of its own (other accounts manage
		 *  it): nothing is encrypted to it, so there is nothing to compare. */
		| { kind: 'no_posting_key' }
		/** The peer's posting keys changed: the NEW safety number, to compare
		 *  before accepting (nothing is sent to the new keys until then).
		 *  `posting`: the keys shown, which Accept pins exactly (W-M2). */
		| {
				kind: 'key_changed';
				words: readonly string[];
				posting: readonly string[];
				ownExtra?: readonly string[];
		  }
		| { kind: 'error'; message: string }
		/** This instance does not list the posting key this session signed in
		 *  with among the account's keys (review C, H1): no number to show. */
		| { kind: 'own_key_missing' }
		/** `firstUse`: posting keys not pinned yet — the number is made from
		 *  these, and "use these keys" pins exactly them (so what the user
		 *  compared is what messages go to). */
		| {
				kind: 'ready';
				words: readonly string[];
				firstUse?: readonly string[];
				/** Posting keys this instance lists for OUR account besides the
				 *  one this session holds (review C, H1), as BLT strings. */
				ownExtra?: readonly string[];
		  };

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

		const unreachable = (): void => {
			// NOT a security event: the chain could not be asked at all, which
			// on a Tor/I2P instance is ordinary and transient. A red banner
			// would teach the user to dismiss it, and it has to mean something.
			panelState = {
				kind: 'error',
				message: $_('chat.verify_peer.error_chain_unreachable') as string
			};
		};
		const b64 = (k: Uint8Array): string => btoa(String.fromCharCode(...k));
		const bytes = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
		// Posting keys: ours as the chain lists them (what the peer pins for
		// us), theirs as PINNED here — read, never changed: opening this panel
		// pins nothing. The keys every message is sent to and proved by
		// (chatService.seal), so both sides compare the number of the keys in
		// use (v1.21.14 full chat audit, W-L8; posting-key-only chat).
		let mineKeys: Uint8Array[] | null;
		let theirKeys: Uint8Array[] | null;
		try {
			const origin = resolveOrigin(MORPHIT_INDEXER_ORIGIN);
			[mineKeys, theirKeys] = await Promise.all([
				fetchAccountKeys(origin, me).then(orderPostingPubs),
				fetchAccountKeys(origin, peer).then(orderPostingPubs)
			]);
		} catch {
			if (!aborted) unreachable();
			return;
		}
		if (aborted) return;
		if (theirKeys === null) {
			panelState = { kind: 'no_account' };
			return;
		}
		if (theirKeys.length === 0) {
			panelState = { kind: 'no_posting_key' };
			return;
		}
		if (mineKeys === null || mineKeys.length === 0) {
			panelState = { kind: 'error', message: $_('chat.verify_peer.error_unknown') as string };
			return;
		}
		// Our half comes from what this instance says our keys are; check that
		// against the key this session actually holds (v1.21.14 review C, H1).
		// An instance serving both people could add a key of its own to our
		// list: the peer pins it at first contact and encrypts to it too, and a
		// half built from the same list matched theirs. So: our own key must be
		// listed, and any OTHER key listed for us is named, as a warning.
		let ownExtra: string[] = [];
		const ownPub = ownPostingPublicKey();
		if (ownPub !== null) {
			const same = (a: Uint8Array) =>
				a.length === ownPub.length && a.every((v, i) => v === ownPub[i]);
			if (!mineKeys.some(same)) {
				panelState = { kind: 'own_key_missing' };
				return;
			}
			try {
				ownExtra = await Promise.all(mineKeys.filter((k) => !same(k)).map(formatPublicKeyBLT));
			} catch {
				ownExtra = mineKeys.filter((k) => !same(k)).map(b64);
			}
			if (aborted) return;
		}
		try {
			const view = peekPostingKeyPin(peer, theirKeys.map(b64));
			const shown = view.kind === 'changed' ? view.chain : view.keys;
			const words = await computeSafetyNumber(
				{ account: me, postingKeys: mineKeys },
				{ account: peer, postingKeys: shown.map(bytes) }
			);
			if (aborted) return;
			// Only a CHANGE of a pinned set is one to accept. A first set is
			// trusted on first use like the conversation does (since v1.21.14
			// whatever chat key of theirs is pinned here: that used to make a
			// normal first conversation a "change").
			const extra = ownExtra.length > 0 ? { ownExtra } : {};
			panelState =
				view.kind === 'changed'
					? { kind: 'key_changed', words, posting: shown, ...extra }
					: {
							kind: 'ready',
							words,
							...(view.kind === 'first_use' ? { firstUse: shown } : {}),
							...extra
						};
		} catch {
			if (!aborted) {
				panelState = { kind: 'error', message: $_('chat.verify_peer.error_unknown') as string };
			}
		}
	}

	/** The user compared the new number with the peer and it matched: the
	 *  keys that number was made from become the pin — exactly those, and
	 *  only that kind. */
	/** First use: the numbers matched — pin exactly the keys they were made from. */
	function useTheseKeys(): void {
		if (panelState.kind !== 'ready' || panelState.firstUse === undefined) return;
		if (acceptPostingKeysShown(peer, panelState.firstUse)) {
			void compute();
			onAccepted?.();
		}
	}

	function acceptNewKey(): void {
		if (panelState.kind !== 'key_changed') return;
		// Exactly the keys the number was made from (W-M2); a key_changed state
		// always holds some, so this always pins.
		acceptPostingKeysShown(peer, panelState.posting);
		void compute();
		onAccepted?.();
	}

	function handleBackdropClick(e: MouseEvent): void {
		if (e.target === e.currentTarget) onClose();
	}
</script>

{#snippet ownExtraNote(extra: readonly string[])}
	<!-- Keys this instance lists for OUR account besides the one this session
	     holds (review C, H1): messages to us are encrypted to them too. -->
	<div
		class="mt-4 rounded-lg border-2 border-amber-500 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100"
		role="alert"
	>
		<p class="font-bold">{$_('chat.verify_peer.own_extra_heading')}</p>
		<p class="mt-1">{$_('chat.verify_peer.own_extra_body')}</p>
		<ul class="mt-2 space-y-1 break-all font-mono text-xs" dir="ltr">
			{#each extra as k (k)}<li>{k}</li>{/each}
		</ul>
	</div>
{/snippet}

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
		{:else if panelState.kind === 'no_account' || panelState.kind === 'no_posting_key'}
			<div
				class="mt-5 rounded-lg border border-ink-300 bg-ink-50 p-4 text-sm text-ink-700 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200"
			>
				{panelState.kind === 'no_account'
					? $_('chat.verify_peer.no_account')
					: $_('chat.verify_peer.no_posting_key')}
			</div>
		{:else if panelState.kind === 'own_key_missing'}
			<div
				class="mt-5 rounded-lg border-2 border-amber-500 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100"
				role="alert"
			>
				{$_('chat.verify_peer.own_key_missing')}
			</div>
		{:else if panelState.kind === 'key_changed'}
			{#if panelState.ownExtra !== undefined}{@render ownExtraNote(panelState.ownExtra)}{/if}
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
			{#if panelState.ownExtra !== undefined}{@render ownExtraNote(panelState.ownExtra)}{/if}
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

			{#if panelState.firstUse !== undefined}
				<!-- Posting keys not pinned yet: comparing pins nothing until the
				     user says the numbers matched. -->
				<div class="mt-3">
					<p class="text-sm text-ink-600 dark:text-ink-300">
						{$_('chat.verify_peer.first_use_note', { values: { peer } })}
					</p>
					<button
						type="button"
						class="mt-2 rounded-lg border-2 border-ink-300 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-ink-100 dark:border-ink-600 dark:bg-ink-900 dark:hover:bg-ink-800"
						onclick={useTheseKeys}
					>
						{$_('chat.verify_peer.first_use_accept')}
					</button>
				</div>
			{/if}

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
