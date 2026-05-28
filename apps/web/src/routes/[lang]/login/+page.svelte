<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { goto } from '$app/navigation';
	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import {
		bootFromEnvelope,
		bootFromEnvelopeWithYubikey,
		isUnlocked,
		isPairedReadOnly,
		pairedReadOnly,
		reset
	} from '$stores/identity';
	import { hasPersistedKeystore, readEnvelope, readKeystoreMode } from '$crypto/persistentKeystore';
	import { hasYubikeyWrap, isYubikeyOnly, classifyYubikeyError } from '$crypto/keystoreYubikey';
	import { KeystoreError } from '$crypto/keystore';
	import { isWebHidSupported, requestYubikey, type YubikeyDevice } from '$crypto/yubikey/transport';
	import { DEFAULT_YUBIKEY_SLOT } from '$crypto/yubikey/protocol';

	/** Which form to render. Computed on mount because the localStorage
	 *  check needs browser context. Four states:
	 *   - 'paired-readonly-welcome': user has a paired-readonly session
	 *     persisted (ADR-0022 QR-pair, Option A).  Show a welcome-back
	 *     card that points them at the orderbook for browsing, and
	 *     offers a "sign in with keys instead" affordance if they want
	 *     to upgrade this device to a full unlocked session.
	 *   - 'welcome-back': user has a persisted keystore on this device,
	 *     show unlock-with-password form.
	 *   - 'import-needed': no persisted keystore (fresh device, seed-only
	 *     user, or post-sign-out). Show choice between import + new account.
	 *   - 'checking': initial state until onMount resolves. */
	let formMode:
		| 'paired-readonly-welcome'
		| 'welcome-back'
		| 'import-needed'
		| 'checking' = $state('checking');

	let password = $state('');
	let busy = $state(false);
	let errorMsg = $state('');
	/** True if the persisted envelope has at least one YubiKey wrap. */
	let envelopeHasYubikey = $state(false);
	/** True if the persisted envelope is YubiKey-only (state B). */
	let envelopeIsYubikeyOnly = $state(false);
	/** Phase indicator during YubiKey unlock so the user knows to tap. */
	let ykPhase: 'idle' | 'requesting' | 'tap' | 'finalizing' = $state('idle');

	/** 2FA gate state.  When the persisted envelope has TOTP enrolled,
	 *  decryptIdentity succeeds with the password BUT bootFromEnvelope
	 *  throws KeystoreError 'totp_required'.  The login form then
	 *  transitions to showing a TOTP entry field, keeping the password
	 *  in memory for the re-call.  Failed TOTP attempts are
	 *  rate-limited via `totpFailCount` to thwart brute force. */
	let needTotp = $state(false);
	let totpCode = $state('');
	let totpFailCount = $state(0);
	/** Lock-out timestamp: Date.now() when locked out until.  0 if
	 *  not locked out.  Recomputed on each submit. */
	let totpLockedUntil = $state(0);

	const webhidSupported = $derived(isWebHidSupported());

	onMount(() => {
		// If the user is already unlocked (e.g. navigated to /login by
		// mistake while signed in), send them home.
		if ($isUnlocked) {
			void goto('/');
			return;
		}

		// Paired-readonly session is auto-restored from disk by the
		// identity store at module load.  If we're already in that
		// state, show the paired welcome-back card — NOT the import-
		// needed form, which would suggest the user isn't signed in.
		if ($isPairedReadOnly) {
			formMode = 'paired-readonly-welcome';
			return;
		}

		if (hasPersistedKeystore()) {
			formMode = 'welcome-back';
			const env = readEnvelope();
			if (env) {
				envelopeHasYubikey = hasYubikeyWrap(env);
				envelopeIsYubikeyOnly = isYubikeyOnly(env);
			}
		} else if (readKeystoreMode() === 'seed-only') {
			// User previously chose seed-only — they explicitly opted
			// out of persistent unlock. Send straight to the import
			// route, which handles seed-phrase entry.
			void goto('/onboarding/import');
		} else {
			// No mode recorded at all → this is a fresh device or
			// someone who signed out completely. Offer import + new
			// account as two clear paths.
			formMode = 'import-needed';
		}
	});

	/** Handler for the "sign in with keys instead" affordance on the
	 *  paired-readonly welcome card.  Wipes the paired marker and
	 *  routes the user into the keystore import flow — Bob can then
	 *  enter his Blurt posting key on this device to gain full write
	 *  capability locally.  Posting-only mode is the right destination
	 *  because that's the path a Blurt-user-with-paired-phone would
	 *  follow to upgrade. */
	function upgradeWithKeys(): void {
		reset();
		void goto('/onboarding/import');
	}

	/** Handler for the "continue" affordance on the paired-readonly
	 *  welcome card.  Bob is already signed in for reading — just
	 *  send him to the orderbook (same destination as a successful
	 *  fresh QR-pair). */
	function continuePaired(): void {
		void goto('/orderbook');
	}

	async function handleUnlock(): Promise<void> {
		if (busy) return;
		errorMsg = '';
		// Lock-out check: if the user has burned through 5 invalid
		// TOTP attempts, refuse further submissions for 30s.  This
		// is a SESSION-local rate limit (lives in component state),
		// not a server-side one — bots can sidestep it by reloading
		// the page.  That's fine; the threat model here is humans
		// at the keyboard, not automated cracking (which would have
		// to also break the keystore encryption).
		if (totpLockedUntil > Date.now()) {
			const secondsLeft = Math.ceil((totpLockedUntil - Date.now()) / 1000);
			errorMsg = $_('settings.totp.unlock_prompt.err_locked_out', {
				values: { seconds: secondsLeft }
			});
			return;
		}
		if (totpLockedUntil > 0 && totpLockedUntil <= Date.now()) {
			// Lock-out elapsed.  Reset the counter and allow a fresh
			// burst of 5 attempts.
			totpLockedUntil = 0;
			totpFailCount = 0;
		}
		if (password.length < 1) {
			errorMsg = $_('login.unlock.password_required');
			return;
		}
		busy = true;
		try {
			const env = readEnvelope();
			if (!env) {
				// Race: envelope disappeared between mount and submit.
				// Possible if the user wiped storage in another tab.
				// Hygiene: clear password on this early-exit branch
				// too, same as the success/error paths below.
				password = '';
				errorMsg = $_('login.unlock.no_keystore');
				formMode = 'import-needed';
				return;
			}
			await bootFromEnvelope(env, password, needTotp ? totpCode.replace(/\s/g, '') : undefined);
			// Successful unlock — identity store now holds live keys.
			// Clear the password before navigating away. The component
			// will unmount on goto(), but explicitly clearing now
			// shortens the heap-residency window.
			password = '';
			totpCode = '';
			needTotp = false;
			totpFailCount = 0;
			// Send them home.
			await goto('/');
		} catch (err) {
			// Audit 2026-05 finding 1-10: typed dispatch on
			// KeystoreError.kind instead of regex on the message
			// text.  Pre-fix, the regex `/decrypt|auth|tag|integrity/i`
			// was fragile to wording changes and a non-classified
			// path echoed `err.message` verbatim into the UI — could
			// surface internal detail.
			if (err instanceof KeystoreError) {
				switch (err.kind) {
					case 'bad_password':
						errorMsg = $_('login.unlock.wrong_password');
						password = ''; // clear the failed password
						break;
					case 'envelope_corrupt':
						errorMsg = $_('login.unlock.envelope_corrupt');
						password = '';
						break;
					case 'identity_mismatch':
						errorMsg = $_('crypto.error.identity_mismatch');
						password = '';
						break;
					case 'no_passphrase_wrap':
						errorMsg = $_('login.unlock.yubikey_required');
						password = '';
						break;
					case 'unsupported':
						errorMsg = $_('login.unlock.unsupported_envelope');
						password = '';
						break;
					case 'totp_required':
						// Password worked; switch UI to TOTP entry.
						// Do NOT clear the password — we'll re-submit
						// with both password and totpCode in the next
						// call.  Per Argon2id KDF the password
						// re-derives each time; that's intentional —
						// no plaintext keys hang around between
						// submissions.
						needTotp = true;
						errorMsg = '';
						break;
					case 'totp_invalid':
						// Wrong TOTP code (or wrong backup code).
						// Increment fail count; lock out after 5
						// consecutive failures for 30 seconds.
						totpFailCount += 1;
						totpCode = '';
						if (totpFailCount >= 5) {
							totpLockedUntil = Date.now() + 30_000;
							errorMsg = $_('settings.totp.unlock_prompt.err_locked_out', {
								values: { seconds: 30 }
							});
						} else {
							errorMsg = $_('settings.totp.unlock_prompt.err_invalid_code');
						}
						break;
				}
			} else {
				// Non-keystore error (e.g. store-update bug).  Don't
				// echo internal text — show a generic message.
				errorMsg = $_('login.unlock.generic_error');
				password = '';
			}
		} finally {
			busy = false;
		}
	}

	function switchToImport(): void {
		void goto('/onboarding/import');
	}

	async function handleUnlockYubikey(): Promise<void> {
		if (busy) return;
		errorMsg = '';
		busy = true;
		let device: YubikeyDevice | null = null;
		try {
			const env = readEnvelope();
			if (!env) {
				errorMsg = $_('login.unlock.no_keystore');
				formMode = 'import-needed';
				return;
			}
			ykPhase = 'requesting';
			// Use the slot of the first enrolled YubiKey on the
			// envelope, falling back to the default if for some reason
			// the envelope has no yubikey wrap (shouldn't happen — the
			// CTA only renders when envelopeHasYubikey).
			const slot =
				env.scheme === 'layered-cek'
					? (env.wraps.find((w) => w.kind === 'yubikey')?.slot ?? DEFAULT_YUBIKEY_SLOT)
					: DEFAULT_YUBIKEY_SLOT;
			device = await requestYubikey(slot);
			ykPhase = 'tap';
			await bootFromEnvelopeWithYubikey(env, device.hmac);
			ykPhase = 'finalizing';
			await goto('/');
		} catch (err) {
			// REVISIT-LIST item 3 — classifier-driven branching.
			// Covers transport errors (webhid_unsupported, no_device,
			// open_failed, timeout, protocol_violation) and wrap
			// errors (unsafe_kdf_params, wrap_schema_unsupported,
			// unwrap_failed) plus keystore-shape errors via the
			// `instanceof YubikeyKeystoreError` short-circuit inside
			// classifyYubikeyError.  Unrecognized errors land on
			// `error.unknown` rather than leaking raw exception text.
			const kind = classifyYubikeyError(err);
			errorMsg =
				kind !== null
					? ($_(`login.unlock.yubikey.error.${kind}`) as string)
					: ($_('login.unlock.yubikey.error.unknown') as string);
		} finally {
			if (device) {
				try {
					await device.close();
				} catch {
					// device.close() can fail if already removed.
				}
			}
			busy = false;
			ykPhase = 'idle';
		}
	}

	function ykPhaseText(phase: 'idle' | 'requesting' | 'tap' | 'finalizing'): string {
		switch (phase) {
			case 'requesting':
				return $_('login.unlock.yubikey.phase.requesting');
			case 'tap':
				return $_('login.unlock.yubikey.phase.tap');
			case 'finalizing':
				return $_('login.unlock.yubikey.phase.finalizing');
			default:
				return '';
		}
	}

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="login" />

<section class="mx-auto max-w-2xl px-4 py-12 md:px-6 md:py-20">
	{#if formMode === 'checking'}
		<div class="text-center text-ink-500 dark:text-ink-400">
			<p>{$_('login.checking')}</p>
		</div>
	{:else if formMode === 'paired-readonly-welcome' && $pairedReadOnly !== null}
		<!-- Paired-readonly welcome-back (ADR-0022 QR-pair, Option A).
		     Bob's tab was closed; on reopen the identity store auto-
		     restored the paired session from disk; we land here and
		     greet him.  Two paths forward:
		       1. Continue browsing in read-only mode (primary path —
		          this is what most paired-device users want)
		       2. Upgrade this device with keys (secondary — signs out
		          of paired and routes to /onboarding/import) -->
		<header class="text-center">
			<h1 class="font-display text-3xl font-extrabold leading-tight md:text-4xl">
				{$_('paired_readonly.welcome_back_heading', {
					values: { account: $pairedReadOnly.account }
				})}
			</h1>
			<p class="mt-3 text-ink-600 dark:text-ink-300">
				{$_('paired_readonly.welcome_back_body')}
			</p>
		</header>
		<div class="card mt-8 space-y-3">
			<BusyButton variant="primary" onclick={continuePaired}>
				{$_('paired_readonly.welcome_back_continue')}
			</BusyButton>
			<BusyButton variant="ghost" onclick={upgradeWithKeys}>
				{$_('paired_readonly.welcome_back_use_keys_instead')}
			</BusyButton>
		</div>
	{:else if formMode === 'welcome-back'}
		<!-- Returning user with persisted keystore — fast path. -->
		<header class="text-center">
			<h1 class="font-display text-3xl font-extrabold leading-tight md:text-4xl">
				{$_('login.welcome_back.title')}
			</h1>
			<p class="mt-3 text-ink-600 dark:text-ink-300">
				{$_('login.welcome_back.body')}
			</p>
		</header>

		{#if envelopeIsYubikeyOnly}
			<!-- State B: hardened to YubiKey-only.  No password form;
			     YubiKey unlock is the only path. -->
			<div class="card mt-8 text-center">
				<img
					src="/icons/icon-yubikey.svg"
					alt=""
					aria-hidden="true"
					loading="lazy"
					decoding="async"
					class="mx-auto h-28 w-auto opacity-90"
				/>
				<p class="mt-4 text-ink-600 dark:text-ink-300">
					{$_('login.welcome_back.yubikey_only_body')}
				</p>

				{#if ykPhase !== 'idle'}
					<p
						class="mt-4 text-sm font-medium text-morphit-teal dark:text-morphit-emerald"
						role="status"
						aria-live="polite"
					>
						{ykPhaseText(ykPhase)}
					</p>
				{/if}

				{#if errorMsg}
					<div class="mt-4">
						<StatusLine kind="error">{errorMsg}</StatusLine>
					</div>
				{/if}

				<div class="mt-5">
					<BusyButton
						variant="primary"
						{busy}
						disabled={!webhidSupported}
						onclick={handleUnlockYubikey}
					>
						{$_('login.welcome_back.unlock_with_yubikey')}
					</BusyButton>
				</div>

				{#if !webhidSupported}
					<p class="mt-3 text-xs text-ink-500 dark:text-ink-400">
						{$_('login.welcome_back.yubikey_browser_unsupported')}
					</p>
				{/if}
			</div>
		{:else}
			<!-- State A or no YubiKey: passphrase form is the primary
			     unlock path; YubiKey appears as a secondary option if
			     enrolled. -->
			<form
				class="card mt-8 space-y-4"
				onsubmit={(e) => {
					e.preventDefault();
					void handleUnlock();
				}}
			>
				<div>
					<label for="unlock-password" class="mb-1 block text-sm font-semibold">
						{$_('login.welcome_back.password_label')}
					</label>
					<input
						id="unlock-password"
						type="password"
						bind:value={password}
						autocomplete="current-password"
						class="block w-full rounded-xl border border-ink-200 bg-white px-4 py-3 focus:border-morphit-emerald focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						required
						disabled={needTotp}
					/>
				</div>

				{#if needTotp}
					<div>
						<label for="unlock-totp" class="mb-1 block text-sm font-semibold">
							{$_('settings.totp.unlock_prompt.code_label')}
						</label>
						<p class="mb-2 text-xs text-ink-700 dark:text-ink-300">
							{$_('settings.totp.unlock_prompt.body')}
						</p>
						<input
							id="unlock-totp"
							type="text"
							inputmode="numeric"
							bind:value={totpCode}
							autocomplete="one-time-code"
							placeholder={$_('settings.totp.unlock_prompt.code_placeholder')}
							class="block w-full rounded-xl border border-ink-200 bg-white px-4 py-3 font-mono tracking-wide focus:border-morphit-emerald focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
							required
						/>
					</div>
				{/if}

				{#if ykPhase !== 'idle'}
					<p
						class="text-sm font-medium text-morphit-teal dark:text-morphit-emerald"
						role="status"
						aria-live="polite"
					>
						{ykPhaseText(ykPhase)}
					</p>
				{/if}

				{#if errorMsg}
					<StatusLine kind="error">{errorMsg}</StatusLine>
				{/if}

				<BusyButton
					variant="primary"
					{busy}
					busyLabel={$_('login.welcome_back.unlocking')}
					onclick={handleUnlock}
				>
					{$_('login.welcome_back.unlock')}
				</BusyButton>

				{#if envelopeHasYubikey && webhidSupported}
					<button
						type="button"
						onclick={handleUnlockYubikey}
						disabled={busy}
						class="block w-full rounded-xl border border-ink-300 px-4 py-2.5 text-sm font-semibold transition hover:bg-ink-50 active:scale-[0.99] disabled:opacity-50 dark:border-ink-700 dark:hover:bg-ink-900"
					>
						<span class="inline-flex items-center justify-center gap-2">
							<img
								src="/icons/icon-yubikey.svg"
								alt=""
								aria-hidden="true"
								loading="lazy"
								decoding="async"
								class="h-5 w-auto opacity-90"
							/>
							{$_('login.welcome_back.unlock_with_yubikey')}
						</span>
					</button>
				{/if}
			</form>
		{/if}

		<!-- Escape hatch: use seed phrase instead (for users who
		     forgot their password but have the seed written down). -->
		<aside class="card mt-10 border border-ink-100 text-center dark:border-ink-800">
			<h2 class="font-display text-xl font-bold">
				{$_('login.welcome_back.alternatives_heading')}
			</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('login.welcome_back.alternatives_body')}
			</p>
			<div class="mt-5 flex flex-wrap justify-center gap-3">
				<button type="button" onclick={switchToImport} class="btn-secondary">
					{$_('login.welcome_back.use_seed_instead')}
				</button>
				<a href={lp('/login/qr-pair')} class="btn-secondary">
					{$_('login.welcome_back.use_phone_instead')}
				</a>
			</div>
		</aside>
	{:else}
		<!-- No persisted keystore — offer import or onboarding. -->
		<header class="text-center">
			<h1 class="font-display text-3xl font-extrabold leading-tight md:text-4xl">
				{$_('login.title')}
			</h1>
			<p class="mt-3 text-ink-600 dark:text-ink-300">{$_('login.body')}</p>
		</header>

		<div class="mt-8 flex flex-col gap-4 sm:flex-row">
			<a href={lp('/onboarding/import')} class="btn-primary flex-1 text-center">
				{$_('login.import_existing')}
			</a>
			<a href={lp('/onboarding')} class="btn-secondary flex-1 text-center">
				{$_('login.register_cta')}
			</a>
		</div>

		<!-- ADR-0022: QR-pairing offered as a third path for users
		     who already have Morphit on their phone.  Lower-key
		     than the import/register choices since it requires the
		     phone to be set up first; surfaced as a tertiary
		     option below the primary CTAs. -->
		<div class="mt-4 text-center">
			<a
				href={lp('/login/qr-pair')}
				class="text-sm text-morphit-emerald underline hover:text-morphit-emerald/80"
			>
				{$_('login.qr_pair_cta')}
			</a>
		</div>

		<aside class="card mt-10 border border-ink-100 text-center dark:border-ink-800">
			<h2 class="font-display text-xl font-bold">{$_('login.no_account_heading')}</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('login.no_account_body')}</p>
		</aside>
	{/if}
</section>
