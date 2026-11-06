<script lang="ts">
	/**
	 * WitnessVoteModal — vote for a Blurt witness, or take the vote back
	 * (v1.23.0, the /witnesses page).
	 *
	 *   prepare unsigned account_witness_vote → sign with the ACTIVE key → broadcast
	 *
	 * A witness vote needs active authority (dblurt: "should be the Active key at
	 * least"), so this is PowerModal's flow, not a posting-key one:
	 *   - a session holding the active key: the Morphit password unlocks it for
	 *     the one synchronous signature (runWithActiveKey), then it is wiped;
	 *   - a posting-only session: the same UnlockActiveKeyModal the "Pay now" and
	 *     Power Up/Down flows use — the user pastes the Active key, it is checked
	 *     against the account's on-chain authorities, used once and wiped.
	 * The op moves no funds and changes only the signer's own vote.
	 */
	import { _ } from 'svelte-i18n';
	import sodium from 'libsodium-wrappers-sumo';
	import { runWithActiveKey } from '$crypto/runWithActiveKey';
	import { liveIdentity } from '$stores/identity';
	import UnlockActiveKeyModal from '$components/UnlockActiveKeyModal.svelte';
	import PasswordScope from '$components/PasswordScope.svelte';
	import {
		prepareUnsignedAccountWitnessVote,
		signTransferWithKey,
		broadcastSignedTransaction
	} from '$blurt/sign';
	import { ChainRejectedError, BroadcastUnavailableError } from '$blurt/broadcastTransport';
	import { classifyChainReason } from '$blurt/broadcastErrorClass';

	interface Props {
		/** The signed-in account (the voter). */
		account: string;
		/** The witness voted for. */
		witness: string;
		/** true = vote; false = take the vote back. */
		approve: boolean;
		/** The vote is on the chain. */
		onDone: () => void;
		onCancel: () => void;
	}

	const { account, witness, approve, onDone, onCancel }: Props = $props();

	type Phase =
		| { kind: 'ready' }
		| { kind: 'working' }
		| { kind: 'error'; messageKey: string; reason?: string };

	let phase = $state<Phase>({ kind: 'ready' });
	let passwordInput = $state('');
	let passwordError = $state('');

	/** Posting-only sessions hold no active key: they paste it instead. */
	const hasActiveKey = $derived(($liveIdentity?.activePublicKey ?? null) !== null);

	async function prepare(): Promise<import('@beblurt/dblurt').Transaction | null> {
		try {
			return await prepareUnsignedAccountWitnessVote(account, witness, approve);
		} catch (err) {
			console.warn('[witness-vote] prepare failed:', err);
			phase =
				err instanceof BroadcastUnavailableError
					? { kind: 'error', messageKey: 'profile.wallet.error_unreachable' }
					: { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
			return null;
		}
	}

	async function broadcastSigned(
		signed: import('@beblurt/dblurt').SignedTransaction
	): Promise<void> {
		try {
			await broadcastSignedTransaction(signed);
			onDone();
		} catch (err) {
			console.warn('[witness-vote] broadcast rejected:', err);
			if (err instanceof ChainRejectedError && classifyChainReason(err.message) === 'low_blurt') {
				phase = { kind: 'error', messageKey: 'common.broadcast_err.low_blurt' };
			} else if (err instanceof ChainRejectedError) {
				phase = {
					kind: 'error',
					messageKey: 'profile.wallet.error_chain_rejected',
					reason: err.message
				};
			} else if (err instanceof BroadcastUnavailableError) {
				phase = { kind: 'error', messageKey: 'profile.wallet.error_unreachable' };
			} else {
				phase = { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
			}
		}
	}

	// Password path: the session holds an active-key envelope.
	async function confirm(): Promise<void> {
		if (phase.kind === 'working') return;
		if (passwordInput.length === 0) {
			passwordError = $_('profile.wallet.error_password_required') as string;
			return;
		}
		passwordError = '';
		phase = { kind: 'working' };
		const unsignedTx = await prepare();
		if (unsignedTx === null) {
			passwordInput = '';
			return;
		}
		const r = await runWithActiveKey(passwordInput, async (activePriv) =>
			signTransferWithKey(unsignedTx, activePriv)
		);
		passwordInput = '';
		if (r.ok) {
			await broadcastSigned(r.value);
			return;
		}
		if (r.kind === 'bad_password') {
			phase = { kind: 'ready' };
			passwordError = $_('profile.wallet.error_bad_password') as string;
		} else if (r.kind === 'identity_mismatch') {
			phase = { kind: 'error', messageKey: 'crypto.error.identity_mismatch' };
		} else if (r.kind === 'locked') {
			phase = { kind: 'error', messageKey: 'profile.wallet.error_no_active_key' };
		} else if (r.kind === 'password_empty') {
			phase = { kind: 'ready' };
		} else {
			phase = { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
		}
	}

	// Posting-only path: UnlockActiveKeyModal verified the pasted key and hands
	// over the raw scalar; sign, then wipe it whatever happens.
	async function voteWithEphemeralActiveKey(activeScalar: Uint8Array): Promise<void> {
		phase = { kind: 'working' };
		try {
			const unsignedTx = await prepare();
			if (unsignedTx === null) return;
			const signed = signTransferWithKey(unsignedTx, activeScalar);
			await broadcastSigned(signed);
		} catch (err) {
			console.warn('[witness-vote] ephemeral sign/broadcast failed:', err);
			phase = { kind: 'error', messageKey: 'profile.wallet.error_broadcast' };
		} finally {
			sodium.memzero(activeScalar);
		}
	}

	// Focus (accessibility review, v1.23.0): the dialog takes it when it opens,
	// so Escape works at once and a screen reader starts inside; Tab stays
	// inside; on close it goes back to the vote button that opened it.
	let dialogEl: HTMLDivElement | undefined = $state();
	$effect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialogEl?.focus();
		return () => opener?.focus();
	});

	function trapTab(e: KeyboardEvent): void {
		if (e.key !== 'Tab' || dialogEl === undefined) return;
		const items = [
			...dialogEl.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled])'
			)
		].filter((el) => el.offsetParent !== null);
		if (items.length === 0) return;
		const first = items[0]!;
		const last = items[items.length - 1]!;
		if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogEl)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	function onBackdropClick(e: MouseEvent): void {
		if (phase.kind === 'working') return;
		if (e.target === e.currentTarget) onCancel();
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="witness-vote-heading"
	onclick={onBackdropClick}
	onkeydown={(e) => {
		if (e.key === 'Escape' && phase.kind !== 'working') onCancel();
		else trapTab(e);
	}}
	tabindex="-1"
	bind:this={dialogEl}
>
	<div class="card max-h-[95dvh] w-full max-w-md overflow-y-auto overscroll-contain">
		<h2 id="witness-vote-heading" class="font-display text-xl font-bold">
			{approve
				? $_('witnesses.modal_vote_title', { values: { owner: witness } })
				: $_('witnesses.modal_unvote_title', { values: { owner: witness } })}
		</h2>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">{$_('witnesses.modal_body')}</p>

		{#if phase.kind === 'error'}
			<div
				class="mt-5 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
			>
				{phase.reason
					? $_(phase.messageKey, { values: { reason: phase.reason } })
					: $_(phase.messageKey)}
			</div>
			<div class="mt-5 flex justify-end">
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold transition-colors hover:border-ink-400 hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800"
					onclick={onCancel}
				>
					{$_('common.close')}
				</button>
			</div>
		{:else if hasActiveKey}
			<PasswordScope {account}>
				<label class="mt-5 block">
					<span class="text-sm font-semibold">
						{$_('profile.wallet.password_label', { values: { account } })}
					</span>
					<input
						type="password"
						maxlength="64"
						bind:value={passwordInput}
						autocomplete="current-password"
						disabled={phase.kind === 'working'}
						class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
					/>
					{#if passwordError}
						<p class="mt-1 text-xs text-red-600 dark:text-red-400">{passwordError}</p>
					{/if}
				</label>
			</PasswordScope>
			<div class="mt-5 flex justify-end gap-2">
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold transition-colors hover:border-ink-400 hover:bg-ink-50 disabled:opacity-50 dark:border-ink-700 dark:hover:bg-ink-800"
					onclick={onCancel}
					disabled={phase.kind === 'working'}
				>
					{$_('common.cancel')}
				</button>
				<button
					type="button"
					class="btn-primary-sm px-4"
					onclick={confirm}
					disabled={phase.kind === 'working'}
				>
					{#if phase.kind === 'working'}
						{$_('common.broadcasting')}
					{:else if approve}
						{$_('witnesses.modal_vote_action')}
					{:else}
						{$_('witnesses.modal_unvote_action')}
					{/if}
				</button>
			</div>
		{:else}
			<div class="mt-5">
				<UnlockActiveKeyModal
					{account}
					purpose="vote"
					onUnlocked={voteWithEphemeralActiveKey}
					{onCancel}
				/>
			</div>
		{/if}
	</div>
</div>
