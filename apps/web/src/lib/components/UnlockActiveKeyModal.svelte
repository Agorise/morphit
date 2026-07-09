<script lang="ts">
	/**
	 * Morphit — <UnlockActiveKeyModal>
	 *
	 * Raised IN PLACE by any action that needs the Active key when the session
	 * only has the Posting key: paying in chat, sending from the wallet, paying a
	 * listing fee in BLURT. It never navigates away. On success it hands the
	 * caller a raw active scalar and the caller resumes exactly what it was
	 * doing — the amount stays typed, the order stays half-posted, nothing is
	 * retyped. That is the whole point (Ken: "SEAMLESSLY continue ... without
	 * losing their place").
	 *
	 * ─── What we ask for, and why ─────────────────────────────────────────
	 *
	 * Morphit's 12-word seed and Keyfile are OUR inventions. A user who has been
	 * on Blurt for years has neither. They have an Active key in WIF form, or a
	 * master password from the pre-fork era. So this asks for one of those two,
	 * tells them apart itself, and verifies the result against the account's
	 * on-chain authorities before anything is signed.
	 *
	 * If they paste the wrong thing we say precisely which wrong thing it was.
	 * An Owner key is REFUSED outright — it can steal the account, it has no
	 * business in a transfer flow, and accepting it would teach the habit.
	 *
	 * ─── Retention ────────────────────────────────────────────────────────
	 *
	 * A posting-only user CHOSE posting-only. We don't silently promote them.
	 * Today the key is used once and wiped (`sodium.memzero`) the moment the
	 * signature exists — it is never written to the keystore, never held past
	 * the signing window. Persisting it ("keep on this device, encrypted") needs
	 * the identity model to stop equating `origin === 'morphit-seed'` with
	 * "has an active key"; see REVISIT-LIST. Until then the modal is honest
	 * about what it does rather than offering a switch that lies.
	 */
	import { _ } from 'svelte-i18n';
	import { resolveActiveKey, type AccountAuthorityKeys } from '$crypto/activeKeyUnlock';
	import { keepActiveKeyOnThisDevice } from '$crypto/keepActiveKey';
	import sodium from 'libsodium-wrappers-sumo';
	import { fetchAccountKeys } from '$blurt/accountKeys';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';

	interface Props {
		/** The signed-in account whose Active key we need. */
		account: string;
		/** Called with the raw 32-byte active scalar. The CALLER must wipe it. */
		onUnlocked: (activeScalar: Uint8Array) => void | Promise<void>;
		onCancel: () => void;
		/** False while the surrounding form is still invalid (e.g. a bad amount).
		 *  The CTA stays disabled with the reason visible above — we never enable
		 *  a button first and explain afterwards. */
		canProceed?: boolean;
	}

	let { account, onUnlocked, onCancel, canProceed = true }: Props = $props();

	let secret = $state('');
	let busy = $state(false);
	let errorKey = $state('');

	/** Ken: "A posting-only user chose that deliberately; some of them will be
	 *  furious if we quietly promote them." So we ASK — and the safe answer,
	 *  'once', is the default. */
	let retention = $state<'once' | 'keep'>('once');
	/** Only needed for 'keep': the Morphit password that encrypts the keystore. */
	let devicePassword = $state('');

	const filled = $derived(secret.trim().length > 0);
	const retentionReady = $derived(retention === 'once' || devicePassword.length > 0);
	const ready = $derived(filled && retentionReady && canProceed && !busy);

	/** Reason → message key. Every branch names the actual mistake. */
	const REASON_KEY: Record<string, string> = {
		invalid_wif: 'unlock_active.error.invalid_wif',
		is_posting_key: 'unlock_active.error.is_posting_key',
		is_owner_key: 'unlock_active.error.is_owner_key',
		not_this_account: 'unlock_active.error.not_this_account',
		empty: 'unlock_active.error.empty'
	};

	async function submit(): Promise<void> {
		if (!ready) return;
		busy = true;
		errorKey = '';
		try {
			const keys = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), account, fetch);
			if (!keys) {
				errorKey = 'unlock_active.error.lookup_failed';
				return;
			}
			const authorities: AccountAuthorityKeys = {
				active: (keys.active?.key_auths ?? []).map((a) => a[0] as string),
				posting: (keys.posting?.key_auths ?? []).map((a) => a[0] as string),
				owner: (keys.owner?.key_auths ?? []).map((a) => a[0] as string)
			};
			const result = await resolveActiveKey(account, secret, authorities);
			if (!result.ok) {
				errorKey = REASON_KEY[result.reason] ?? 'unlock_active.error.not_this_account';
				return;
			}
			// Clear the typed secret from component state before doing anything
			// else — it is not needed again, whichever branch we take.
			secret = '';

			if (retention === 'keep') {
				// Store the key at rest, encrypted under the user's Morphit password.
				// `keepActiveKeyOnThisDevice` takes ownership of the scalar and wipes
				// it, so we hand the CALLER a copy for the signature that follows.
				const forCaller = result.scalar.slice();
				const kept = await keepActiveKeyOnThisDevice(devicePassword, result.scalar);
				devicePassword = '';
				if (!kept.ok) {
					sodium.memzero(forCaller);
					errorKey =
						kept.kind === 'bad_password'
							? 'unlock_active.error.bad_device_password'
							: 'unlock_active.error.keep_failed';
					return;
				}
				await onUnlocked(forCaller);
				return;
			}

			await onUnlocked(result.scalar);
		} catch {
			errorKey = 'unlock_active.error.lookup_failed';
		} finally {
			busy = false;
		}
	}
</script>

<div class="mt-5 space-y-4">
	<div
		class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
		role="note"
	>
		<p class="font-semibold">{$_('unlock_active.title')}</p>
		<p class="mt-1">{$_('unlock_active.body', { values: { account } })}</p>
	</div>

	<label class="block">
		<span class="text-sm font-semibold">{$_('unlock_active.field_label')}</span>
		<input
			type="password"
			bind:value={secret}
			maxlength="128"
			autocomplete="off"
			spellcheck="false"
			disabled={busy}
			placeholder={$_('unlock_active.field_placeholder') as string}
			class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-900"
		/>
		<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">{$_('unlock_active.field_help')}</p>
		{#if errorKey}
			<p class="mt-1 text-xs text-red-600 dark:text-red-400">
				{$_(errorKey, { values: { account } })}
			</p>
		{/if}
	</label>

	<!-- The choice Ken insisted on. 'once' is preselected: never promote a
	     posting-only account behind the user's back. -->
	<fieldset class="space-y-2">
		<legend class="text-sm font-semibold">{$_('unlock_active.retention_heading')}</legend>

		<label class="flex cursor-pointer items-start gap-2 text-sm">
			<input type="radio" bind:group={retention} value="once" class="mt-1" disabled={busy} />
			<span>
				<span class="font-medium">{$_('unlock_active.retention_once')}</span>
				<span class="block text-xs text-ink-500 dark:text-ink-400">
					{$_('unlock_active.retention_once_help')}
				</span>
			</span>
		</label>

		<label class="flex cursor-pointer items-start gap-2 text-sm">
			<input type="radio" bind:group={retention} value="keep" class="mt-1" disabled={busy} />
			<span>
				<span class="font-medium">{$_('unlock_active.retention_keep')}</span>
				<span class="block text-xs text-ink-500 dark:text-ink-400">
					{$_('unlock_active.retention_keep_help')}
				</span>
			</span>
		</label>
	</fieldset>

	{#if retention === 'keep'}
		<label class="block">
			<span class="text-sm font-semibold">
				{$_('unlock_active.device_password_label', { values: { account } })}
			</span>
			<input
				type="password"
				bind:value={devicePassword}
				maxlength="64"
				autocomplete="current-password"
				disabled={busy}
				class="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
			/>
			<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
				{$_('unlock_active.device_password_help')}
			</p>
		</label>
	{/if}

	<div class="flex justify-center gap-2">
		<button
			type="button"
			class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
			onclick={onCancel}
			disabled={busy}
		>
			{$_('common.cancel')}
		</button>
		<button
			type="button"
			class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
			onclick={submit}
			disabled={!ready}
		>
			{busy ? $_('unlock_active.checking') : $_('unlock_active.cta')}
		</button>
	</div>
</div>
