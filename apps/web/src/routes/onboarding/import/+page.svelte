<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { goto } from '$app/navigation';
	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import {
		importIdentityFromSeed,
		importPostingOnlyIdentity,
		formatPublicKeyBLT,
		wipeFullIdentity,
		wipeLiveIdentity,
		type FullIdentity,
		type LiveIdentity
	} from '$crypto/keygen';
	import { blobToEnvelope, encryptIdentity, type KeystoreEnvelope } from '$crypto/keystore';
	import { wifToRawPrivateKey, WifDecodeError, type WifError } from '$crypto/wif';
	import { verifyPostingKey } from '$crypto/postingVerify';
	import { getBlurtClient } from '$blurt/client';
	import { bootFromEnvelope } from '$stores/identity';
	import { setUserBlurtAccount } from '$blurt/ops/profile';
	import sodium from 'libsodium-wrappers-sumo';

	let mode: 'seed' | 'keyfile' | 'posting-only' = $state('seed');
	let seed = $state('');
	let file = $state<File | null>(null);
	let password = $state('');
	// Posting-only fields:
	let postingAccount = $state('');
	let postingWif = $state('');
	let postingNewPassword = $state('');
	let postingNewPasswordConfirm = $state('');
	let working = $state(false);
	let errorMsg = $state('');

	/** Map a WifError code to a localized error message. */
	function wifErrorMessage(code: WifError): string {
		return $_(`onboarding.import.posting_only.error.wif.${code}`);
	}

	const BLURT_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;

	async function unlockSeedOrKeyfile(): Promise<void> {
		let full: FullIdentity | null = null;
		// O2.1 — also track the LiveIdentity returned from
		// importIdentityFromSeed.  Pre-fix this was discarded
		// without wiping; the returned LiveIdentity references the
		// `original` keypairs which are independent of the cloned
		// `full` snapshot.  Wiping `full` alone left the original's
		// posting/memo private bytes in heap until GC.
		let live: LiveIdentity | null = null;
		try {
			let env: KeystoreEnvelope;
			let usedPassword: string;

			if (mode === 'seed') {
				const result = await importIdentityFromSeed(seed);
				full = result.full;
				live = result.live;
				// Seed-path users didn't set a password — generate a session one
				// and keep the envelope in memory only via the identity store.
				// User can export a real keyfile from Settings later.
				const rnd = crypto.getRandomValues(new Uint8Array(24));
				usedPassword = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
				env = await encryptIdentity(full, usedPassword);
			} else {
				if (!file) throw new Error($_('onboarding.import.pick_file_first'));
				env = await blobToEnvelope(file);
				usedPassword = password;
			}

			await bootFromEnvelope(env, usedPassword);
			if (full) {
				wipeFullIdentity(full);
				full = null;
			}
			if (live) {
				wipeLiveIdentity(live);
				live = null;
			}
			// Clear sensitive component state before navigating
			// away.  Component unmount on goto() will release these
			// to GC eventually, but explicit clears shorten the
			// heap-residency window.  `seed` is the user's BIP-39
			// mnemonic; `password` is the keyfile decrypt password.
			seed = '';
			password = '';
			// Local `usedPassword` exits scope at function return.
			// Sally finding H2 (Part 68): seed/keyfile imports don't
			// carry the account name, so we redirect to /settings.
			// Without this flag the user lands on a generic settings
			// page with no idea why — an explanatory banner fires
			// once based on this flag and self-clears.
			try {
				sessionStorage.setItem('morphit.import.needs_account_name', '1');
			} catch {
				// Private/Incognito mode — banner won't fire, but the
				// account-name section on /settings is itself the
				// first card on the page so the user still sees it.
			}
			// Seed/keyfile imports don't carry the account name (the
			// keys themselves don't tell us which Blurt account they
			// belong to).  Route to /settings where the user is
			// prompted to set their account name and we verify it
			// against on-chain posting.key_auths.  Without this step,
			// 70+ surfaces silently treat the user as signed-out.
			await goto('/settings#account-name-heading');
		} catch (err) {
			// Map known error messages to localized keys.  The
			// raw err.message text is English (e.g. "Seed must be
			// 12 words") and shouldn't surface to non-English
			// users.  Any unrecognized message falls back to a
			// generic localized "import failed" string.
			const raw = err instanceof Error ? err.message : String(err); // smoke-ok-raw-local: used only for regex classification + console.warn
			console.warn('[import] seed/keyfile path failed:', raw);
			if (/seed must be 12 words/i.test(raw)) {
				errorMsg = $_('onboarding.import.error.seed_word_count');
			} else if (/invalid seed phrase/i.test(raw)) {
				errorMsg = $_('onboarding.import.error.seed_invalid');
			} else if (/decrypt|password|wrong key/i.test(raw)) {
				errorMsg = $_('onboarding.import.error.keyfile_password_wrong');
			} else if (/parse|json/i.test(raw)) {
				errorMsg = $_('onboarding.import.error.keyfile_corrupt');
			} else {
				errorMsg = $_('onboarding.import.error.generic');
			}
			if (full) wipeFullIdentity(full);
			if (live) wipeLiveIdentity(live);
			// Clear the password input on error too — UX cost is the
			// user has to re-type to retry; security benefit is the
			// password doesn't sit in component state across the
			// retry pause.  Seed stays — the user almost certainly
			// wants to re-submit the same seed (typo correction,
			// brief network glitch, etc).
			password = '';
		}
	}

	async function unlockPostingOnly(): Promise<void> {
		// Up-front validation before we do any crypto.
		const account = postingAccount.trim().toLowerCase();
		if (!BLURT_ACCOUNT_RE.test(account)) {
			errorMsg = $_('onboarding.import.posting_only.error.bad_account');
			return;
		}
		if (postingNewPassword.length < 8) {
			errorMsg = $_('onboarding.import.posting_only.error.password_too_short');
			return;
		}
		if (postingNewPassword !== postingNewPasswordConfirm) {
			errorMsg = $_('onboarding.import.posting_only.error.passwords_mismatch');
			return;
		}

		let scalar: Uint8Array | null = null;
		let full: FullIdentity | null = null;
		let live: LiveIdentity | null = null;

		try {
			// 1. Decode the WIF.
			try {
				scalar = await wifToRawPrivateKey(postingWif);
			} catch (err) {
				if (err instanceof WifDecodeError) {
					errorMsg = wifErrorMessage(err.code);
					return;
				}
				throw err;
			}

			// 2. Build a posting-only FullIdentity from the scalar.  This
			//    derives the public key via secp256k1.
			const pair = await importPostingOnlyIdentity(scalar);
			full = pair.full;
			live = pair.live;
			// Wipe the raw scalar — the FullIdentity owns its own copy now.
			sodium.memzero(scalar);
			scalar = null;

			// 3. Format the derived posting public key for chain comparison.
			const derivedPub = formatPublicKeyBLT(full.keys.posting.publicKey);

			// 4. Fetch the account from chain and classify the key.
			const client = getBlurtClient();
			const fetched = await client.getAccount(account);
			if (!fetched) {
				errorMsg = $_('onboarding.import.posting_only.error.account_not_found', {
					values: { account }
				});
				// Sally finding H1 (Part 68): account-not-found is a
				// user-input error, NOT a credential failure.  Keep
				// the password fields populated so the user only has
				// to fix the typo'd account name and resubmit.
				// Clearing here forced retype-everything-twice loops
				// that pushed users toward weaker passwords.
				return;
			}
			const verdict = verifyPostingKey(fetched, derivedPub);
			if (verdict.kind === 'wrong-role') {
				const key = `onboarding.import.posting_only.error.wrong_role.${verdict.foundIn}`;
				errorMsg = $_(key);
				// Clear the WIF field so the user can paste again, but
				// keep the account name AND the password fields — same
				// rationale as account_not_found: this is a "you pasted
				// the wrong key role" user-input error, not a password
				// problem.  Forcing password re-entry on each WIF fix
				// trains users to pick weaker passwords.
				postingWif = '';
				return;
			}
			if (verdict.kind === 'not-found') {
				errorMsg = $_('onboarding.import.posting_only.error.key_not_on_account', {
					values: { account }
				});
				// Same rationale as wrong-role: clear the WIF, keep
				// account name + passwords.  The user pasted a key
				// that doesn't belong to this account; they fix the
				// WIF or the account name and try again.
				postingWif = '';
				return;
			}

			// 5. Encrypt to the chosen password and boot.
			const env = await encryptIdentity(full, postingNewPassword);
			await bootFromEnvelope(env, postingNewPassword);

			// 6. Persist the account name so the rest of the app
			//    (chat, post creation, my-orders, profile, etc — 72
			//    call sites depend on this) knows whose keys these
			//    are.  The posting-only path is the only import path
			//    where we definitively KNOW the account name from
			//    user input + chain verification.
			setUserBlurtAccount(account);

			// Wipe the keystore-snapshot copy now that the live session
			// has been booted.  bootFromEnvelope decrypts a fresh copy
			// for the session; full and live held here can be discarded.
			wipeFullIdentity(full);
			full = null;
			wipeLiveIdentity(live);
			live = null;
			// Clear sensitive component state before navigation.
			// `postingWif` was the raw posting-key WIF the user
			// pasted — sensitive enough to need explicit clearing.
			// `postingNewPassword*` are the keystore password the
			// user just chose; they're gating real cryptographic
			// material from this point forward.
			postingWif = '';
			postingNewPassword = '';
			postingNewPasswordConfirm = '';
			await goto('/orderbook');
		} catch (err) {
			// Same localization rationale as the seed/keyfile
			// catch above — raw exception text is English.
			const raw = err instanceof Error ? err.message : String(err);
			console.warn('[import] posting-only path failed:', raw);
			errorMsg = $_('onboarding.import.error.generic');
			// Clear passwords on error.  Keep `postingWif` and
			// `postingAccount` so the user can fix typos without
			// re-pasting their key from scratch — the WIF will be
			// cleared on a successful submit by the path above, or
			// when the user navigates away (component unmount).
			postingNewPassword = '';
			postingNewPasswordConfirm = '';
		} finally {
			if (scalar) sodium.memzero(scalar);
			if (full) wipeFullIdentity(full);
			if (live) wipeLiveIdentity(live);
		}
	}

	async function unlock(): Promise<void> {
		working = true;
		errorMsg = '';
		try {
			if (mode === 'posting-only') {
				await unlockPostingOnly();
			} else {
				await unlockSeedOrKeyfile();
			}
		} finally {
			working = false;
		}
	}

	function onFileSelected(e: Event): void {
		const input = e.target as HTMLInputElement;
		file = input.files?.[0] ?? null;
	}

	const submitDisabled = $derived(
		mode === 'seed'
			? !seed.trim()
			: mode === 'keyfile'
				? !file || !password
				: !postingAccount.trim() ||
					!postingWif.trim() ||
					!postingNewPassword ||
					!postingNewPasswordConfirm
	);
</script>

<Head routeKey="onboarding_import" noindex />

<div class="mx-auto max-w-2xl px-4 py-12 md:py-16">
	<header class="mb-8 text-center">
		<h1 class="font-display text-3xl font-extrabold tracking-tight md:text-4xl">
			<span class="brand-gradient-text">{$_('onboarding.import.title')}</span>
		</h1>
		<p class="mx-auto mt-3 max-w-prose text-ink-600 dark:text-ink-300">
			{$_('onboarding.import.body')}
		</p>
	</header>

	{#if errorMsg}
		<div
			class="mb-5 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
			role="alert"
			aria-live="assertive"
		>
			<svg class="mt-0.5 h-5 w-5 flex-none" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<path
					d="M12 3L2 20h20L12 3z"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linejoin="round"
				/>
				<path
					d="M12 10v4M12 17v.5"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
				/>
			</svg>
			<span>{errorMsg}</span>
		</div>
	{/if}

	<div class="mb-6 flex flex-wrap gap-2" role="tablist">
		<button
			type="button"
			role="tab"
			aria-selected={mode === 'seed'}
			class="flex-1 rounded-xl px-4 py-3 font-semibold transition active:scale-[0.98] {mode ===
			'seed'
				? 'bg-morphit-gradient text-white'
				: 'bg-ink-100 dark:bg-ink-800'}"
			onclick={() => (mode = 'seed')}
		>
			{$_('onboarding.import.seed_tab_label')}
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={mode === 'keyfile'}
			class="flex-1 rounded-xl px-4 py-3 font-semibold transition active:scale-[0.98] {mode ===
			'keyfile'
				? 'bg-morphit-gradient text-white'
				: 'bg-ink-100 dark:bg-ink-800'}"
			onclick={() => (mode = 'keyfile')}
		>
			{$_('onboarding.import.keyfile_tab_label')}
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={mode === 'posting-only'}
			class="flex-1 rounded-xl px-4 py-3 font-semibold transition active:scale-[0.98] {mode ===
			'posting-only'
				? 'bg-morphit-gradient text-white'
				: 'bg-ink-100 dark:bg-ink-800'}"
			onclick={() => (mode = 'posting-only')}
		>
			{$_('onboarding.import.posting_only.tab_label')}
		</button>
	</div>

	<div class="card">
		{#if mode === 'seed'}
			<label class="block">
				<span class="mb-2 block font-semibold">{$_('onboarding.import.seed_label')}</span>
				<textarea
					bind:value={seed}
					rows="3"
					autocomplete="off"
					spellcheck="false"
					class="w-full rounded-xl border-2 border-ink-200 bg-white p-3 font-mono text-base focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-950"
				></textarea>
				<span class="mt-2 block text-sm text-ink-500 dark:text-ink-400">
					{$_('onboarding.import.seed_hint')}
				</span>
			</label>
		{:else if mode === 'keyfile'}
			<label class="block">
				<span class="mb-2 block font-semibold">{$_('onboarding.import.keyfile_label')}</span>
				<input
					type="file"
					accept="application/json,.json"
					onchange={onFileSelected}
					class="block w-full text-sm file:me-4 file:cursor-pointer file:rounded-lg file:border-0 file:bg-morphit-emerald file:px-4 file:py-2 file:font-semibold file:text-white hover:file:bg-morphit-teal"
				/>
				<span class="mt-2 block text-sm text-ink-500 dark:text-ink-400">
					{$_('onboarding.import.keyfile_hint')}
				</span>
			</label>
			<label class="mt-4 block">
				<span class="mb-2 block font-semibold">{$_('onboarding.import.password_label')}</span>
				<input
					type="password"
					bind:value={password}
					autocomplete="current-password"
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				/>
			</label>
		{:else}
			<!-- Posting-only mode: existing Blurt user importing with one role-key WIF. -->

			<div
				class="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
				role="note"
			>
				<p class="font-semibold">{$_('onboarding.import.posting_only.warning_title')}</p>
				<p class="mt-1 text-sm">
					{$_('onboarding.import.posting_only.warning_body')}
				</p>
			</div>

			<label class="block">
				<span class="mb-2 block font-semibold"
					>{$_('onboarding.import.posting_only.account_label')}</span
				>
				<input
					type="text"
					bind:value={postingAccount}
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					placeholder={$_('onboarding.import.posting_only.account_placeholder')}
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 font-mono focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				/>
				<span class="mt-1 block text-xs text-ink-500 dark:text-ink-400">
					{$_('onboarding.import.posting_only.account_hint')}
				</span>
			</label>

			<label class="mt-4 block">
				<span class="mb-2 block font-semibold"
					>{$_('onboarding.import.posting_only.wif_label')}</span
				>
				<input
					type="password"
					bind:value={postingWif}
					autocomplete="off"
					spellcheck="false"
					placeholder={$_('onboarding.import.posting_only.wif_placeholder')}
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 font-mono focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				/>
				<span class="mt-1 block text-xs text-ink-500 dark:text-ink-400">
					{$_('onboarding.import.posting_only.wif_hint')}
				</span>
			</label>

			<div class="my-4 border-t border-ink-200 dark:border-ink-800"></div>

			<label class="block">
				<span class="mb-2 block font-semibold"
					>{$_('onboarding.import.posting_only.new_password_label')}</span
				>
				<input
					type="password"
					bind:value={postingNewPassword}
					autocomplete="new-password"
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				/>
				<span class="mt-1 block text-xs text-ink-500 dark:text-ink-400">
					{$_('onboarding.import.posting_only.new_password_hint')}
				</span>
			</label>

			<label class="mt-3 block">
				<span class="mb-2 block font-semibold"
					>{$_('onboarding.import.posting_only.new_password_confirm_label')}</span
				>
				<input
					type="password"
					bind:value={postingNewPasswordConfirm}
					autocomplete="new-password"
					class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
				/>
			</label>
		{/if}

		<div class="mt-6">
			<BusyButton
				variant="primary"
				busy={working}
				disabled={submitDisabled}
				onclick={unlock}
				busyLabel={$_('onboarding.import.submit_pending')}
				fullWidth
			>
				{$_('onboarding.import.submit')}
			</BusyButton>
		</div>
	</div>
</div>
