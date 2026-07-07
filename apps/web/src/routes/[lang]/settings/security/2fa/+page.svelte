<script lang="ts">
	/**
	 * Morphit — Two-Factor Authentication settings.
	 *
	 * Self-contained route at /[lang]/settings/security/2fa.
	 *
	 * Honest design framing surfaced in the UI itself: this is a
	 * SESSION GATE, not cryptographic 2FA.  An attacker with the
	 * encrypted keystore + cracked password can extract the TOTP
	 * secret directly.  The protection bounds are:
	 *   - shoulder-surfing
	 *   - borrowed-device replay
	 *   - casual local malware
	 *
	 * For cryptographic-strength 2FA, the path forward is FIDO2/
	 * WebAuthn hardware keys (see HardwareKeyCard.svelte and the
	 * yubikey-probe exploratory route).
	 *
	 * Component states:
	 *   - loading              — initial read of identity store + envelope
	 *   - locked               — user must sign in first
	 *   - not_enrolled_init    — show "Set up 2FA" CTA
	 *   - enrolling_secret     — show QR + manual secret + apps + confirm
	 *   - enrolling_backup     — show 10 backup codes; require acknowledgment
	 *   - enrolled_idle        — status view with regen/disable options
	 *   - enrolled_regen       — confirm + generate new backup codes
	 *   - enrolled_disable     — confirm + disable
	 */

	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { _ } from 'svelte-i18n';
	import { localePath } from '$i18n/path';
	import { page } from '$app/stores';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { isUnlocked, updateEnvelope } from '$stores/identity';
	import RequireLiveSession from '$components/RequireLiveSession.svelte';
	import { readEnvelope, writeEnvelope } from '$crypto/persistentKeystore';
	import { decryptIdentity, KeystoreError } from '$crypto/keystore';
	import {
		enrollTotp,
		unenrollTotp,
		regenerateBackupCodes,
		isLayeredEnvelope
	} from '$crypto/keystoreTotpEnroll';
	import { wipeFullIdentity } from '$crypto/keygen';
	import { getUserBlurtAccount } from '$lib/blurt/ops/profile';
	import {
		generateSecret,
		otpauthUri,
		verifyCode as verifyTotpCode,
		base32Encode
	} from '$lib/auth/totp';
	import {
		generatePlaintextCodes,
		displayFormat as displayBackupCode,
		unusedSlotCount
	} from '$lib/auth/backupCodes';
	import {
		RECOMMENDED_AUTHENTICATOR_APPS,
		NOT_RECOMMENDED_AUTHENTICATOR_APPS
	} from '$lib/auth/recommendedAuthenticatorApps';
	import BusyButton from '$components/BusyButton.svelte';

	// Display order = alphabetical by name (Ken's request). The source
	// arrays keep their own documented order for programmatic/smoke use;
	// the picker sorts a copy so neither array is mutated. localeCompare
	// gives a stable, locale-aware order (digits before letters, so
	// "2FAS" sorts ahead of "Aegis").
	const recommendedAppsSorted = [...RECOMMENDED_AUTHENTICATOR_APPS].sort((a, b) =>
		a.name.localeCompare(b.name)
	);
	const notRecommendedAppsSorted = [...NOT_RECOMMENDED_AUTHENTICATOR_APPS].sort((a, b) =>
		a.name.localeCompare(b.name)
	);

	type Phase =
		| 'loading'
		| 'locked'
		| 'not_enrolled_init'
		| 'enrolling_secret'
		| 'enrolling_backup'
		| 'enrolled_idle'
		| 'enrolled_regen'
		| 'enrolled_disable';

	let phase = $state<Phase>('loading');
	let hasTotp = $state(false);
	let backupRemaining = $state(0);
	let backupTotal = $state(0);
	let showNotRecommended = $state(false);

	// Enrollment flow state.
	let pendingSecret = $state<Uint8Array | null>(null);
	let pendingSecretB32 = $state('');
	let pendingQrSvg = $state('');
	let pendingBackupCodes = $state<string[]>([]);
	let backupAcknowledged = $state(false);

	// Form fields.
	let password = $state('');
	let totpCode = $state('');
	let errorMsg = $state('');
	let busy = $state(false);
	let copied = $state(false);
	let layeredKeystoreWarning = $state(false);

	// "I have saved" acknowledgment must be ticked before continuing.

	onMount(async () => {
		if (!browser) return;
		if (!$isUnlocked) {
			phase = 'locked';
			return;
		}
		const env = readEnvelope();
		if (!env) {
			phase = 'locked';
			return;
		}
		if (isLayeredEnvelope(env)) {
			// Layered (YubiKey-protected) keystores aren't supported for
			// TOTP enrollment in this iteration.  Tell the user honestly.
			layeredKeystoreWarning = true;
			phase = 'locked';
			return;
		}
		// We don't have the password here, so we can't inspect the
		// Identity for totpSecret directly without re-prompting.
		// Instead, we'll let the user trigger the "Set up" or "Manage"
		// action which will then prompt for password.
		//
		// To know which view to show, we need to know hasTotp.  The
		// envelope itself doesn't tell us — only the decrypted Identity
		// does.  We could cache a flag in storage, but that's a
		// metadata leak path (someone with read access to localStorage
		// would learn that 2FA is enrolled without decrypting).  Per
		// privacy priority #1, prefer to make the user enter the
		// password to discover state.
		//
		// Compromise: assume "not enrolled" on landing.  If the user
		// clicks "Set up" and decryption reveals an already-enrolled
		// identity, switch to enrolled_idle then.  This means the
		// first-time-enrolling user sees the right CTA without a
		// password prompt; the already-enrolled user sees an extra
		// click but no metadata leak.
		phase = 'not_enrolled_init';
	});

	function backToSettings(): void {
		const lang = ($page.params.lang as LocaleCode | undefined) ?? DEFAULT_LOCALE;
		void goto(localePath('/settings', lang));
	}

	async function startEnrollment(): Promise<void> {
		if (busy) return;
		errorMsg = '';
		const env = readEnvelope();
		if (!env || !$isUnlocked) {
			phase = 'locked';
			return;
		}
		if (password.length < 1) {
			errorMsg = $_('settings.totp.enroll.err_locked');
			return;
		}
		busy = true;
		try {
			const full = await decryptIdentity(env, password);
			try {
				if (full.totpSecret) {
					// Already enrolled — switch to enrolled_idle view.
					hasTotp = true;
					backupTotal = (full.totpBackupCodes ?? []).length;
					backupRemaining = unusedSlotCount(full.totpBackupCodes ?? []);
					phase = 'enrolled_idle';
					password = '';
					return;
				}
				// Generate a fresh secret + QR.
				const secret = await generateSecret();
				pendingSecret = secret;
				pendingSecretB32 = base32Encode(secret);
				const accountLabel = `${getUserBlurtAccount() || 'account'}@morphit`;
				const uri = otpauthUri(accountLabel, pendingSecretB32);
				// Render QR.
				try {
					const qr = await import('qrcode');
					pendingQrSvg = await qr.toString(uri, {
						type: 'svg',
						errorCorrectionLevel: 'M',
						margin: 2
					});
				} catch {
					pendingQrSvg = '';
				}
				phase = 'enrolling_secret';
			} finally {
				wipeFullIdentity(full);
			}
		} catch (err) {
			if (err instanceof KeystoreError) {
				errorMsg =
					err.kind === 'bad_password'
						? $_('login.unlock.wrong_password')
						: $_('settings.totp.enroll.err_internal');
			} else {
				errorMsg = $_('settings.totp.enroll.err_internal');
			}
		} finally {
			busy = false;
		}
	}

	async function confirmEnrollmentCode(): Promise<void> {
		if (busy) return;
		errorMsg = '';
		if (!pendingSecret) {
			errorMsg = $_('settings.totp.enroll.err_internal');
			return;
		}
		const clean = totpCode.replace(/\s/g, '');
		if (!/^\d{6}$/.test(clean)) {
			errorMsg = $_('settings.totp.enroll.err_invalid_code');
			return;
		}
		busy = true;
		try {
			const ok = await verifyTotpCode(pendingSecret, clean);
			if (!ok.valid) {
				errorMsg = $_('settings.totp.enroll.err_invalid_code');
				return;
			}
			// Generate 10 backup codes (plaintext).
			pendingBackupCodes = generatePlaintextCodes();
			phase = 'enrolling_backup';
			totpCode = '';
		} catch {
			errorMsg = $_('settings.totp.enroll.err_internal');
		} finally {
			busy = false;
		}
	}

	async function finalizeEnrollment(): Promise<void> {
		if (busy) return;
		errorMsg = '';
		if (!backupAcknowledged) return;
		if (!pendingSecret || pendingBackupCodes.length === 0) {
			errorMsg = $_('settings.totp.enroll.err_internal');
			return;
		}
		if (password.length < 1) {
			errorMsg = $_('settings.totp.enroll.err_locked');
			return;
		}
		const env = readEnvelope();
		if (!env || !$isUnlocked) {
			phase = 'locked';
			return;
		}
		busy = true;
		try {
			const full = await decryptIdentity(env, password);
			try {
				const result = await enrollTotp(full, password, pendingSecret, pendingBackupCodes);
				writeEnvelope(result.envelope);
				updateEnvelope(result.envelope);
				hasTotp = true;
				backupTotal = 10;
				backupRemaining = 10;
				// Wipe pending material.
				pendingSecret = null;
				pendingSecretB32 = '';
				pendingQrSvg = '';
				pendingBackupCodes = [];
				backupAcknowledged = false;
				password = '';
				phase = 'enrolled_idle';
			} finally {
				wipeFullIdentity(full);
			}
		} catch (err) {
			if (err instanceof KeystoreError && err.kind === 'bad_password') {
				errorMsg = $_('login.unlock.wrong_password');
			} else {
				errorMsg = $_('settings.totp.enroll.err_internal');
			}
		} finally {
			busy = false;
		}
	}

	async function disableTotp(): Promise<void> {
		if (busy) return;
		errorMsg = '';
		if (password.length < 1 || !/^\d{6}$/.test(totpCode.replace(/\s/g, ''))) {
			errorMsg = $_('settings.totp.unenroll.err_invalid_code');
			return;
		}
		const env = readEnvelope();
		if (!env || !$isUnlocked) {
			phase = 'locked';
			return;
		}
		busy = true;
		try {
			const full = await decryptIdentity(env, password);
			try {
				if (!full.totpSecret) {
					errorMsg = $_('settings.totp.enroll.err_internal');
					return;
				}
				const ok = await verifyTotpCode(full.totpSecret, totpCode.replace(/\s/g, ''));
				if (!ok.valid) {
					errorMsg = $_('settings.totp.unenroll.err_invalid_code');
					return;
				}
				const result = await unenrollTotp(full, password);
				writeEnvelope(result.envelope);
				updateEnvelope(result.envelope);
				hasTotp = false;
				backupRemaining = 0;
				backupTotal = 0;
				password = '';
				totpCode = '';
				phase = 'not_enrolled_init';
			} finally {
				wipeFullIdentity(full);
			}
		} catch (err) {
			errorMsg =
				err instanceof KeystoreError && err.kind === 'bad_password'
					? $_('login.unlock.wrong_password')
					: $_('settings.totp.enroll.err_internal');
		} finally {
			busy = false;
		}
	}

	async function regenerateCodes(): Promise<void> {
		if (busy) return;
		errorMsg = '';
		if (password.length < 1 || !/^\d{6}$/.test(totpCode.replace(/\s/g, ''))) {
			errorMsg = $_('settings.totp.regenerate.err_invalid_code');
			return;
		}
		const env = readEnvelope();
		if (!env || !$isUnlocked) {
			phase = 'locked';
			return;
		}
		busy = true;
		try {
			const full = await decryptIdentity(env, password);
			try {
				if (!full.totpSecret) {
					errorMsg = $_('settings.totp.enroll.err_internal');
					return;
				}
				const ok = await verifyTotpCode(full.totpSecret, totpCode.replace(/\s/g, ''));
				if (!ok.valid) {
					errorMsg = $_('settings.totp.regenerate.err_invalid_code');
					return;
				}
				const fresh = generatePlaintextCodes();
				const result = await regenerateBackupCodes(full, password, fresh);
				writeEnvelope(result.envelope);
				updateEnvelope(result.envelope);
				pendingBackupCodes = fresh;
				backupRemaining = 10;
				backupTotal = 10;
				backupAcknowledged = false;
				password = '';
				totpCode = '';
				// Show the new backup codes (re-using enrolling_backup view).
				// The user clicks "Done" to return to enrolled_idle.
				phase = 'enrolling_backup';
			} finally {
				wipeFullIdentity(full);
			}
		} catch (err) {
			errorMsg =
				err instanceof KeystoreError && err.kind === 'bad_password'
					? $_('login.unlock.wrong_password')
					: $_('settings.totp.enroll.err_internal');
		} finally {
			busy = false;
		}
	}

	function ackBackupCodes(): void {
		if (!backupAcknowledged) return;
		pendingBackupCodes = [];
		phase = 'enrolled_idle';
	}

	function cancelEnrollment(): void {
		pendingSecret = null;
		pendingSecretB32 = '';
		pendingQrSvg = '';
		pendingBackupCodes = [];
		backupAcknowledged = false;
		password = '';
		totpCode = '';
		errorMsg = '';
		phase = hasTotp ? 'enrolled_idle' : 'not_enrolled_init';
	}

	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
	function copySecret(): void {
		if (browser && pendingSecretB32) {
			void navigator.clipboard
				.writeText(pendingSecretB32)
				.then(() => {
					copied = true;
					clearTimeout(copyResetTimer);
					copyResetTimer = setTimeout(() => (copied = false), 1500);
				})
				.catch(() => {});
		}
	}

	// The displayed code rotates as "123 456" in some authenticators, and
	// users paste/type it with the space. Strip everything but digits as
	// they type (capped at 6) so the value is always a clean 6-digit code —
	// otherwise the input's native validation silently blocks submit on the
	// space and confirmEnrollmentCode never runs.
	function sanitizeTotpCode(e: Event): void {
		const t = e.currentTarget as HTMLInputElement;
		totpCode = t.value.replace(/\D/g, '').slice(0, 6);
	}
</script>

<svelte:head>
	<title>{$_('settings.totp.heading')} · Morphit</title>
	<meta name="description" content={$_('settings.totp.subtitle')} />
</svelte:head>

<main class="totp-page">
	<RequireLiveSession />
	<header>
		<button class="back" onclick={backToSettings} type="button"
			><span class="nav-arrow nav-arrow-left" aria-hidden="true">⇦</span>
			{$_('settings.title')}</button
		>
		<h1 class="font-display text-3xl font-extrabold md:text-4xl">
			<span class="brand-gradient-text">{$_('settings.totp.heading')}</span>
		</h1>
		<p class="subtitle">{$_('settings.totp.subtitle')}</p>
	</header>

	{#if phase === 'loading'}
		<p class="loading">…</p>
	{:else if phase === 'locked'}
		<section class="locked">
			{#if layeredKeystoreWarning}
				<p>
					{$_('settings.totp.yubikey_protected')}
				</p>
			{:else}
				<p>{$_('settings.totp.enroll.err_locked')}</p>
			{/if}
			<button onclick={backToSettings} type="button">{$_('settings.totp.unenroll.cancel')}</button>
		</section>
	{:else if phase === 'not_enrolled_init'}
		<section>
			<p class="status">{$_('settings.totp.status.not_enrolled')}</p>

			<details class="honest-framing">
				<summary>{$_('settings.totp.honest_framing.title')}</summary>
				<p>{$_('settings.totp.honest_framing.protects_intro')}</p>
				<ul>
					<li>{$_('settings.totp.honest_framing.protects_shoulder_surf')}</li>
					<li>{$_('settings.totp.honest_framing.protects_borrowed')}</li>
					<li>{$_('settings.totp.honest_framing.protects_malware')}</li>
				</ul>
				<p>{$_('settings.totp.honest_framing.limits_intro')}</p>
				<ul>
					<li>{$_('settings.totp.honest_framing.limits_offline')}</li>
				</ul>
				<p>{$_('settings.totp.honest_framing.limits_path_forward')}</p>
			</details>

			<h2>{$_('settings.totp.enroll.step1_title')}</h2>
			<p>{$_('settings.totp.enroll.step1_body')}</p>

			<div class="apps recommended">
				<h3>{$_('settings.totp.recommended_apps.heading')}</h3>
				{#each recommendedAppsSorted as app}
					<article class="app">
						<h4>
							<a
								href={app.officialUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="transition hover:text-morphit-emerald">{app.name}</a
							>
						</h4>
						<p class="license">{app.license} · {app.platforms.join(' · ')}</p>
						<p>{$_(`settings.totp.recommended_apps.${app.i18nKey}.tagline`)}</p>
					</article>
				{/each}
			</div>

			<details class="apps not-recommended">
				<summary
					>{showNotRecommended
						? $_('settings.totp.not_recommended_apps.collapse')
						: $_('settings.totp.not_recommended_apps.expand')}</summary
				>
				<h3>{$_('settings.totp.not_recommended_apps.heading')}</h3>
				{#each notRecommendedAppsSorted as app}
					<article class="app">
						<h4>{$_(`settings.totp.not_recommended_apps.${app.i18nKey}.name`)}</h4>
						<p class="reason">{$_(`settings.totp.not_recommended_apps.${app.i18nKey}.reason`)}</p>
					</article>
				{/each}
			</details>

			<form
				onsubmit={(e) => {
					e.preventDefault();
					void startEnrollment();
				}}
			>
				<label>
					<span>{$_('settings.totp.confirm_password_to_begin')}</span>
					<input
						type="password"
						maxlength="64"
						bind:value={password}
						autocomplete="current-password"
						disabled={busy}
					/>
				</label>
				{#if errorMsg}<p class="error" role="alert">{errorMsg}</p>{/if}
				<BusyButton {busy} type="submit" disabled={password.length < 1}
					>{$_('settings.totp.enroll.cta')}</BusyButton
				>
			</form>
		</section>
	{:else if phase === 'enrolling_secret'}
		<section>
			<h2>{$_('settings.totp.enroll.step2_title')}</h2>
			<p>{$_('settings.totp.enroll.step2_body')}</p>

			{#if pendingQrSvg}
				<div class="qr">{@html pendingQrSvg}</div>
			{/if}

			<div class="manual">
				<p>{$_('settings.totp.enroll.manual_label')}</p>
				<code>{pendingSecretB32}</code>
				<button type="button" class="copy-btn" class:copied onclick={copySecret}
					>{copied ? $_('common.copied') : $_('common.copy')}</button
				>
			</div>

			<h2>{$_('settings.totp.enroll.step3_title')}</h2>
			<p>{$_('settings.totp.enroll.step3_body')}</p>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					void confirmEnrollmentCode();
				}}
			>
				<label>
					<span>{$_('settings.totp.enroll.code_label')}</span>
					<input
						type="text"
						inputmode="numeric"
						maxlength="7"
						placeholder={$_('settings.totp.enroll.code_placeholder')}
						value={totpCode}
						oninput={sanitizeTotpCode}
						autocomplete="one-time-code"
						disabled={busy}
					/>
				</label>
				{#if errorMsg}<p class="error" role="alert">{errorMsg}</p>{/if}
				<BusyButton {busy} type="submit">{$_('settings.totp.enroll.confirm_cta')}</BusyButton>
				<button type="button" onclick={cancelEnrollment} disabled={busy}
					>{$_('common.cancel')}</button
				>
			</form>
		</section>
	{:else if phase === 'enrolling_backup'}
		<section>
			<h2>{$_('settings.totp.enroll.step4_title')}</h2>
			<p>{$_('settings.totp.enroll.step4_body')}</p>

			<ol class="backup-codes">
				{#each pendingBackupCodes as code}
					<li><code>{displayBackupCode(code)}</code></li>
				{/each}
			</ol>

			<label class="ack">
				<input type="checkbox" bind:checked={backupAcknowledged} />
				<span>{$_('settings.totp.enroll.backup_acknowledge')}</span>
			</label>

			{#if !hasTotp}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						void finalizeEnrollment();
					}}
				>
					<label>
						<span>{$_('settings.totp.confirm_password')}</span>
						<input
							type="password"
							maxlength="64"
							bind:value={password}
							autocomplete="current-password"
							disabled={busy}
						/>
					</label>
					{#if errorMsg}<p class="error" role="alert">{errorMsg}</p>{/if}
					<BusyButton {busy} type="submit" disabled={!backupAcknowledged || password.length < 1}>
						{$_('settings.totp.enroll.backup_continue')}
					</BusyButton>
				</form>
			{:else}
				<!-- Regenerate flow: codes already persisted; just acknowledge & go back. -->
				<button onclick={ackBackupCodes} disabled={!backupAcknowledged} type="button"
					>{$_('settings.totp.enroll.backup_continue')}</button
				>
			{/if}
		</section>
	{:else if phase === 'enrolled_idle'}
		<section>
			<p class="status enrolled">{$_('settings.totp.status.enrolled')}</p>
			<p>
				{#if backupTotal > 0}
					{$_('settings.totp.status.backup_codes_remaining', {
						values: { count: backupRemaining }
					})}
				{/if}
			</p>
			{#if backupRemaining <= 2 && backupRemaining > 0}
				<p class="warn">{$_('settings.totp.status.backup_codes_low')}</p>
			{:else if backupRemaining === 0 && backupTotal > 0}
				<p class="warn">{$_('settings.totp.status.backup_codes_exhausted')}</p>
			{/if}

			<details class="lost-device">
				<summary>{$_('settings.totp.lost_device.heading')}</summary>
				<p>{$_('settings.totp.lost_device.body')}</p>
			</details>

			<div class="actions">
				<button type="button" onclick={() => (phase = 'enrolled_regen')}
					>{$_('settings.totp.regenerate.cta')}</button
				>
				<button type="button" class="danger" onclick={() => (phase = 'enrolled_disable')}
					>{$_('settings.totp.unenroll.cta')}</button
				>
			</div>
		</section>
	{:else if phase === 'enrolled_regen'}
		<section>
			<h2>{$_('settings.totp.regenerate.confirm_heading')}</h2>
			<p>{$_('settings.totp.regenerate.confirm_body')}</p>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					void regenerateCodes();
				}}
			>
				<label>
					<span>{$_('settings.totp.confirm_password')}</span>
					<input
						type="password"
						maxlength="64"
						bind:value={password}
						autocomplete="current-password"
						disabled={busy}
					/>
				</label>
				<label>
					<span>{$_('settings.totp.regenerate.code_label')}</span>
					<input
						type="text"
						inputmode="numeric"
						maxlength="7"
						value={totpCode}
						oninput={sanitizeTotpCode}
						autocomplete="one-time-code"
						disabled={busy}
					/>
				</label>
				{#if errorMsg}<p class="error" role="alert">{errorMsg}</p>{/if}
				<BusyButton {busy} type="submit" disabled={password.length < 1 || totpCode.length < 6}>
					{$_('settings.totp.regenerate.submit')}
				</BusyButton>
				<button type="button" onclick={cancelEnrollment} disabled={busy}
					>{$_('common.cancel')}</button
				>
			</form>
		</section>
	{:else if phase === 'enrolled_disable'}
		<section>
			<h2>{$_('settings.totp.unenroll.confirm_heading')}</h2>
			<p>{$_('settings.totp.unenroll.confirm_body')}</p>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					void disableTotp();
				}}
			>
				<label>
					<span>{$_('settings.totp.confirm_password')}</span>
					<input
						type="password"
						maxlength="64"
						bind:value={password}
						autocomplete="current-password"
						disabled={busy}
					/>
				</label>
				<label>
					<span>{$_('settings.totp.unenroll.code_label')}</span>
					<input
						type="text"
						inputmode="numeric"
						maxlength="7"
						value={totpCode}
						oninput={sanitizeTotpCode}
						autocomplete="one-time-code"
						disabled={busy}
					/>
				</label>
				{#if errorMsg}<p class="error" role="alert">{errorMsg}</p>{/if}
				<BusyButton {busy} type="submit" disabled={password.length < 1 || totpCode.length < 6}>
					{$_('settings.totp.unenroll.submit')}
				</BusyButton>
				<button type="button" onclick={cancelEnrollment} disabled={busy}
					>{$_('settings.totp.unenroll.cancel')}</button
				>
			</form>
		</section>
	{/if}
</main>

<style>
	.totp-page {
		max-width: 640px;
		margin: 0 auto;
		padding: 1.5rem;
	}
	.back {
		background: transparent;
		border: none;
		color: #ffffff;
		cursor: pointer;
		padding: 0;
		margin-bottom: 1rem;
		font-size: 0.95rem;
		transition: color 0.15s ease;
	}
	.back:hover {
		color: var(--morphit-emerald, #00da69);
	}
	header {
		margin-bottom: 2rem;
	}
	h1 {
		/* Sizing comes from the Tailwind text-3xl/4xl utilities + the
		   brand-gradient-text span (matches /settings and /backup-keys);
		   only spacing is kept here. */
		margin: 0.5rem 0 0.25rem;
	}
	.subtitle {
		opacity: 0.8;
		margin: 0;
	}
	.status {
		font-weight: 600;
	}
	.status.enrolled {
		color: var(--success, #2bb24c);
	}
	.honest-framing {
		background: var(--surface-2, #1a202b);
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		margin: 1rem 0;
	}
	.honest-framing summary {
		cursor: pointer;
		font-weight: 600;
	}
	.honest-framing p {
		margin: 0.5rem 0;
		font-size: 0.9rem;
		line-height: 1.5;
	}
	.honest-framing ul {
		margin: 0.5rem 0;
		padding-left: 1.5rem;
	}
	.apps.recommended {
		margin: 1rem 0;
	}
	.app {
		padding: 0.75rem;
		border: 1px solid var(--border, #333);
		border-radius: 0.4rem;
		margin: 0.5rem 0;
	}
	.app h4 {
		margin: 0 0 0.25rem;
	}
	.app .license {
		font-size: 0.8rem;
		opacity: 0.7;
		margin: 0 0 0.4rem;
	}
	.app .reason {
		font-size: 0.85rem;
		line-height: 1.4;
	}
	.apps.not-recommended {
		background: var(--surface-2, #1a202b);
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin: 1rem 0;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	input[type='text'],
	input[type='password'] {
		padding: 0.5rem;
		font-size: 1rem;
		font-family: inherit;
		border: 1px solid var(--border, #444);
		background: var(--surface-1, #0e0e10);
		color: inherit;
		border-radius: 0.3rem;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}
	input[type='text']:focus,
	input[type='password']:focus {
		outline: none;
		border-color: var(--morphit-emerald);
		box-shadow: 0 0 0 3px rgba(0, 218, 105, 0.25);
	}
	.qr {
		max-width: 280px;
		margin: 1rem auto;
		background: white;
		padding: 0.5rem;
		border-radius: 0.5rem;
	}
	.qr :global(svg) {
		display: block;
		width: 100%;
		height: auto;
	}
	.manual {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin: 0.5rem 0 1.5rem;
	}
	.manual code {
		font-family: ui-monospace, 'SF Mono', Consolas, monospace;
		background: var(--surface-2, #1a202b);
		padding: 0.4rem 0.6rem;
		border-radius: 0.3rem;
		font-size: 0.95rem;
		word-break: break-all;
	}
	.backup-codes {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.5rem;
		list-style: none;
		padding: 1rem;
		background: var(--surface-2, #1a202b);
		border-radius: 0.5rem;
		margin: 1rem 0;
	}
	.backup-codes code {
		font-family: ui-monospace, 'SF Mono', Consolas, monospace;
		font-size: 1.05rem;
		letter-spacing: 0.05em;
	}
	.ack {
		flex-direction: row;
		align-items: flex-start;
		gap: 0.5rem;
		margin: 1rem 0;
	}
	.actions {
		display: flex;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}
	.actions .danger {
		background: var(--danger, #b73030);
		color: white;
		border: none;
	}
	.error {
		color: var(--danger, #b73030);
		font-size: 0.9rem;
		margin: 0;
	}
	.warn {
		color: var(--warn, #d99000);
		font-weight: 500;
	}
	.lost-device {
		margin: 1.5rem 0;
		padding: 0.75rem 1rem;
		background: var(--surface-2, #1a202b);
		border-radius: 0.5rem;
	}
	.lost-device summary {
		cursor: pointer;
		font-weight: 600;
	}
	.lost-device p {
		margin: 0.5rem 0 0;
		font-size: 0.9rem;
		line-height: 1.5;
	}
	button {
		padding: 0.6rem 1rem;
		font-size: 0.95rem;
		font-family: inherit;
		border: 1px solid var(--border, #444);
		background: var(--surface-1, #18181a);
		color: inherit;
		border-radius: 0.3rem;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			transform 0.06s ease;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	button:hover:not(:disabled) {
		border-color: var(--morphit-emerald);
	}
	button:active:not(:disabled) {
		transform: scale(0.97);
	}
	/* Copy button (manual-entry secret): brand-accented, with a filled
	   "Copied" confirmation state set by copySecret() for ~1.5s. */
	.copy-btn {
		border-color: var(--morphit-emerald);
		color: var(--morphit-emerald);
		font-weight: 600;
		white-space: nowrap;
	}
	.copy-btn:hover:not(:disabled) {
		background: rgba(0, 218, 105, 0.12);
	}
	.copy-btn.copied {
		background: var(--morphit-emerald);
		color: #ffffff;
		border-color: var(--morphit-emerald);
	}

	/* Expand/collapse headers: the native <summary> is already a
	   full-width click target (not just the triangle). Make that
	   discoverable — pointer cursor on the whole line plus a subtle
	   colour shift on hover. Covers all three <details> blocks
	   (honest-framing, the not-recommended apps list, lost-device). */
	details > summary {
		cursor: pointer;
		font-weight: 600;
		transition: color 0.15s ease;
	}
	details > summary:hover {
		color: var(--morphit-emerald);
	}
</style>
