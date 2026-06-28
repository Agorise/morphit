<!--
	Morphit — Settings → Hardware key (Batch I, ADR-0017).

	Inserted between the "Session control" card (which owns
	change-password) and the "Advanced" / sign-out region.  Visible
	only when the user is unlocked AND keystore mode is 'password'
	(seed-only users don't have a persistent envelope to bind a
	hardware key to — they re-enter their seed every session).

	UI states:
	  - No YubiKey: enrollment CTA, gated behind a backup-confirmed
	    checkbox.  Shows the YubiKey illustration.
	  - State A (passphrase + yubikey): list of enrolled keys, "add
	    another", "harden to YubiKey-only" toggle.
	  - State B (yubikey-only): list of enrolled keys, "add another",
	    "soften (also accept passphrase)" toggle.

	WebHID is Chromium-only.  Firefox/Safari users see a clear
	"not supported in this browser" card with the same illustration.
-->

<script lang="ts">
	import { _ } from 'svelte-i18n';
	import BusyButton from '$components/BusyButton.svelte';
	import { currentEnvelope, bootFromEnvelope } from '$stores/identity';
	import { writeEnvelope } from '$crypto/persistentKeystore';
	import {
		enrollYubikey,
		unenrollWrap,
		hardenToYubikeyOnly,
		softenToAlsoPassphrase,
		listYubikeyWraps,
		isLayered,
		hasYubikeyWrap,
		isYubikeyOnly,
		yubikeyErrorI18nKey,
		classifyYubikeyError
	} from '$crypto/keystoreYubikey';
	import { isWebHidSupported, requestYubikey, type YubikeyDevice } from '$crypto/yubikey/transport';
	import {
		DEFAULT_YUBIKEY_SLOT,
		type YubikeySlot
	} from '$crypto/yubikey/protocol';
	import { showToast } from '$lib/stores/toast';

	// ─── reactive view of the persisted envelope ──────────────
	const envelope = $derived($currentEnvelope);
	const layered = $derived(envelope && isLayered(envelope) ? envelope : null);
	const enrolledKeys = $derived(envelope ? listYubikeyWraps(envelope) : []);
	const stateA = $derived(
		envelope !== null && hasYubikeyWrap(envelope) && !isYubikeyOnly(envelope)
	);
	const stateB = $derived(envelope !== null && isYubikeyOnly(envelope));
	const supported = $derived(isWebHidSupported());

	// ─── enrollment flow state ────────────────────────────────
	let enrollOpen = $state(false);
	let enrollPassword = $state('');
	let enrollSlot = $state<YubikeySlot>(DEFAULT_YUBIKEY_SLOT);
	let enrollLabel = $state('');
	let backupConfirmed = $state(false);
	let enrollBusy = $state(false);
	let enrollError = $state('');
	let enrollPhase: 'idle' | 'requesting' | 'tap' | 'finalizing' = $state('idle');

	// ─── soft/harden flow state ───────────────────────────────
	let hardenOpen = $state(false);
	let hardenAck = $state(false);
	let hardenBusy = $state(false);
	let hardenError = $state('');

	let softenOpen = $state(false);
	let softenPassword = $state('');
	let softenPasswordConfirm = $state('');
	let softenBusy = $state(false);
	let softenError = $state('');
	let softenPhase: 'idle' | 'requesting' | 'tap' | 'finalizing' = $state('idle');

	function resetEnrollForm(): void {
		enrollPassword = '';
		enrollLabel = '';
		enrollSlot = DEFAULT_YUBIKEY_SLOT;
		backupConfirmed = false;
		enrollError = '';
		enrollPhase = 'idle';
		enrollBusy = false;
	}

	function resetSoftenForm(): void {
		softenPassword = '';
		softenPasswordConfirm = '';
		softenError = '';
		softenPhase = 'idle';
		softenBusy = false;
	}

	async function doEnroll(): Promise<void> {
		if (!envelope) return;
		if (!backupConfirmed) {
			enrollError = $_('settings.hardware_key.error.confirm_backup');
			return;
		}
		if (enrollPassword.length < 8) {
			enrollError = $_('common.password_too_short');
			return;
		}
		enrollBusy = true;
		enrollError = '';
		let device: YubikeyDevice | null = null;
		try {
			enrollPhase = 'requesting';
			device = await requestYubikey(enrollSlot);
			enrollPhase = 'tap';
			const newEnv = await enrollYubikey(
				envelope,
				enrollPassword,
				device.hmac,
				enrollSlot,
				enrollLabel
			);
			enrollPhase = 'finalizing';
			// M8 fix: check the persist return BEFORE telling the user
			// enrollment succeeded.  If localStorage isn't available
			// (quota, private mode, disabled), the in-memory boot
			// would still appear to work, but on next reload the
			// enrollment would be gone.  Refuse and surface clearly.
			const persisted = writeEnvelope(newEnv);
			if (!persisted) {
				enrollError = $_('settings.hardware_key.error.persist_failed');
				return;
			}
			await bootFromEnvelope(newEnv, enrollPassword);
			showToast($_('settings.hardware_key.enroll_success'), 'success');
			enrollOpen = false;
			resetEnrollForm();
		} catch (err) {
			enrollError = classifyToText(err);
			// Hygiene: clear the password immediately on error so it
			// doesn't linger in component state if the user navigates
			// away or leaves the form open. UX cost: user has to
			// re-type to retry. Security benefit: shorter window
			// during which the password sits in JS heap.
			enrollPassword = '';
		} finally {
			if (device) {
				try {
					await device.close();
				} catch {
					// transport close errors are harmless at this point
				}
			}
			enrollBusy = false;
			enrollPhase = 'idle';
		}
	}

	async function doRemoveKey(wrapIndex: number): Promise<void> {
		if (!layered) return;
		try {
			const newEnv = unenrollWrap(layered, wrapIndex);
			// M8 fix: surface persist failure rather than swallowing.
			const persisted = writeEnvelope(newEnv);
			if (!persisted) {
				showToast($_('settings.hardware_key.error.persist_failed'), 'error');
				return;
			}
			// Live identity already in memory — re-write only updates the
			// persisted envelope, not the running session.  No re-boot
			// required; the envelope's CEK still decrypts the running
			// session in memory.  Next unlock uses the new envelope.
			showToast($_('settings.hardware_key.remove_success'), 'success');
		} catch (err) {
			// REVISIT-LIST item 3 — classifier covers transport,
			// wrap, AND keystore-shape errors (the latter via the
			// `instanceof YubikeyKeystoreError` short-circuit inside
			// classifyYubikeyError).  Unrecognized errors land on
			// the localized "unknown" copy.
			showToast(classifyToText(err), 'error');
		}
	}

	async function doHarden(): Promise<void> {
		if (!layered) return;
		if (!hardenAck) return;
		hardenBusy = true;
		hardenError = '';
		try {
			const newEnv = hardenToYubikeyOnly(layered);
			// M8 fix: hardening is an irrecoverable state transition.
			// If persistence fails, we'd have an in-memory state-B
			// envelope but the OLD on-disk state-A — confusing on
			// next reload.  Refuse and surface.
			const persisted = writeEnvelope(newEnv);
			if (!persisted) {
				hardenError = $_('settings.hardware_key.error.persist_failed');
				return;
			}
			showToast($_('settings.hardware_key.harden_success'), 'success');
			hardenOpen = false;
			hardenAck = false;
		} catch (err) {
			hardenError = classifyToText(err);
		} finally {
			hardenBusy = false;
		}
	}

	async function doSoften(): Promise<void> {
		if (!layered) return;
		if (softenPassword.length < 8) {
			softenError = $_('common.password_too_short');
			return;
		}
		if (softenPassword !== softenPasswordConfirm) {
			softenError = $_('settings.hardware_key.error.passwords_mismatch');
			return;
		}
		softenBusy = true;
		softenError = '';
		let device: YubikeyDevice | null = null;
		try {
			softenPhase = 'requesting';
			// Use the slot of the first enrolled YubiKey by default.
			const slotToUse = enrolledKeys[0]?.wrap.slot ?? DEFAULT_YUBIKEY_SLOT;
			device = await requestYubikey(slotToUse);
			softenPhase = 'tap';
			const newEnv = await softenToAlsoPassphrase(layered, device.hmac, softenPassword);
			softenPhase = 'finalizing';
			// M8 fix: surface persist failure.
			const persisted = writeEnvelope(newEnv);
			if (!persisted) {
				softenError = $_('settings.hardware_key.error.persist_failed');
				return;
			}
			showToast($_('settings.hardware_key.soften_success'), 'success');
			softenOpen = false;
			resetSoftenForm();
		} catch (err) {
			softenError = classifyToText(err);
			// Hygiene: clear passwords on error too. See doEnroll for
			// rationale.
			softenPassword = '';
			softenPasswordConfirm = '';
		} finally {
			if (device) {
				try {
					await device.close();
				} catch {
					// device.close() can fail if the device was already
					// removed; we're in cleanup so there's nothing to do.
				}
			}
			softenBusy = false;
			softenPhase = 'idle';
		}
	}

	/** Convert a caught error to localized user-facing copy.  Used
	 *  by every catch-site in this component so error UX is uniform.
	 *  See classifyYubikeyError + yubikeyErrorI18nKey for the
	 *  taxonomy.  Unrecognized errors surface the localized
	 *  "unknown" copy rather than leaking raw exception text. */
	function classifyToText(err: unknown): string {
		const kind = classifyYubikeyError(err);
		return kind !== null
			? ($_(yubikeyErrorI18nKey(kind)) as string)
			: ($_('settings.hardware_key.error.unknown') as string);
	}

	function formatEnrolledAt(ts: number): string {
		try {
			return new Intl.DateTimeFormat(undefined, {
				year: 'numeric',
				month: 'short',
				day: 'numeric'
			}).format(new Date(ts));
		} catch {
			return '';
		}
	}

	// Phase-banner text for the enrollment / soften flows.
	function phaseText(phase: 'idle' | 'requesting' | 'tap' | 'finalizing'): string {
		switch (phase) {
			case 'requesting':
				return $_('settings.hardware_key.phase.requesting');
			case 'tap':
				return $_('settings.hardware_key.phase.tap');
			case 'finalizing':
				return $_('settings.hardware_key.phase.finalizing');
			default:
				return '';
		}
	}
</script>

<section class="card mt-6" aria-labelledby="hardware-key-heading">
	<div class="flex items-start gap-5">
		<!-- YubiKey illustration sits beside the heading.  Static
		     image; static path is served from /icons/icon-yubikey.svg. -->
		<img
			src="/icons/icon-yubikey.svg"
			alt=""
			aria-hidden="true"
			loading="lazy"
			decoding="async"
			class="hidden h-24 w-auto flex-none opacity-90 sm:block"
		/>

		<div class="flex-1">
			<h2 id="hardware-key-heading" class="font-display text-xl font-bold">
				{$_('settings.hardware_key.heading')}
			</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('settings.hardware_key.explain')}
			</p>

			<!-- WebHID feature-detect.  Firefox/Safari fall through here. -->
			{#if !supported}
				<div
					class="mt-4 rounded-xl border border-ink-200 bg-ink-50 p-4 text-ink-700 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
				>
					<p class="font-semibold">
						{$_('settings.hardware_key.unsupported_title')}
					</p>
					<p class="mt-1 text-sm">
						{$_('settings.hardware_key.unsupported_body')}
					</p>
				</div>
			{:else if !envelope}
				<!-- Seed-only user — no envelope to bind to.  Shouldn't
				     reach here under the parent's gating, but defended. -->
				<p class="mt-4 text-sm text-ink-500 dark:text-ink-400">
					{$_('settings.hardware_key.seed_only_note')}
				</p>
			{:else}
				<!-- ─── Enrolled YubiKeys list ─── -->
				{#if enrolledKeys.length > 0}
					<ul class="mt-4 space-y-2">
						{#each enrolledKeys as { index, wrap } (index)}
							<li
								class="flex items-center justify-between gap-3 rounded-xl border border-ink-200 bg-white px-4 py-3 dark:border-ink-700 dark:bg-ink-900"
							>
								<div class="min-w-0 flex-1">
									<p class="truncate font-semibold">
										{wrap.label || $_('settings.hardware_key.unnamed_key')}
									</p>
									<p class="text-xs text-ink-500 dark:text-ink-400">
										{$_('settings.hardware_key.slot_label', {
											values: { slot: wrap.slot }
										})}
										&nbsp;·&nbsp;
										{$_('settings.hardware_key.enrolled_on', {
											values: { date: formatEnrolledAt(wrap.enrolledAt) }
										})}
									</p>
								</div>
								<button
									type="button"
									onclick={() => doRemoveKey(index)}
									class="rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-medium hover:bg-ink-100 active:scale-95 dark:border-ink-600 dark:hover:bg-ink-800"
									aria-label={$_('settings.hardware_key.remove_aria', {
										values: { label: wrap.label || $_('settings.hardware_key.unnamed_key') }
									})}
								>
									{$_('settings.hardware_key.remove')}
								</button>
							</li>
						{/each}
					</ul>
				{/if}

				<!-- ─── State chip ─── -->
				{#if stateB}
					<div
						class="mt-4 inline-flex items-center gap-2 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200"
					>
						<span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
						{$_('settings.hardware_key.state_b_chip')}
					</div>
				{:else if stateA}
					<div
						class="mt-4 inline-flex items-center gap-2 rounded-full border border-ink-300 bg-ink-100 px-3 py-1 text-xs font-semibold text-ink-700 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-200"
					>
						<span class="h-1.5 w-1.5 rounded-full bg-ink-400"></span>
						{$_('settings.hardware_key.state_a_chip')}
					</div>
				{/if}

				<!-- ─── Action buttons ─── -->
				<div class="mt-5 flex flex-wrap gap-2">
					{#if !enrollOpen && !hardenOpen && !softenOpen}
						<BusyButton variant="primary" onclick={() => (enrollOpen = true)}>
							{enrolledKeys.length === 0
								? $_('settings.hardware_key.enroll_first_cta')
								: $_('settings.hardware_key.enroll_another_cta')}
						</BusyButton>
						{#if stateA}
							<BusyButton variant="ghost" onclick={() => (hardenOpen = true)}>
								{$_('settings.hardware_key.harden_cta')}
							</BusyButton>
						{/if}
						{#if stateB}
							<BusyButton variant="ghost" onclick={() => (softenOpen = true)}>
								{$_('settings.hardware_key.soften_cta')}
							</BusyButton>
						{/if}
					{/if}
				</div>

				<!-- ─── Enrollment form ─── -->
				{#if enrollOpen}
					<div class="mt-5 rounded-xl border-2 border-morphit-emerald bg-white p-4 dark:bg-ink-950">
						<h3 class="text-base font-semibold">
							{$_('settings.hardware_key.enroll_form_title')}
						</h3>

						<!-- Backup precondition.  Hard gate. -->
						<div
							class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
						>
							<p class="text-sm font-semibold">
								{$_('settings.hardware_key.backup_warning_title')}
							</p>
							<p class="mt-1 text-sm">
								{$_('settings.hardware_key.backup_warning_body')}
							</p>
							<label class="mt-3 flex items-start gap-2 text-sm">
								<input type="checkbox" bind:checked={backupConfirmed} class="mt-0.5" />
								<span>{$_('settings.hardware_key.backup_confirm_label')}</span>
							</label>
						</div>

						<label class="mt-4 block">
							<span class="block text-sm font-semibold">
								{$_('settings.hardware_key.current_password_label')}
							</span>
							<input
								type="password"
								maxlength="64"
								bind:value={enrollPassword}
								autocomplete="current-password"
								class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
							/>
						</label>

						<label class="mt-3 block">
							<span class="block text-sm font-semibold">
								{$_('settings.hardware_key.label_label')}
							</span>
							<input
								type="text"
								bind:value={enrollLabel}
								placeholder={$_('settings.hardware_key.label_placeholder')}
								maxlength={64}
								class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
							/>
						</label>

						<fieldset class="mt-3">
							<legend class="text-sm font-semibold">
								{$_('settings.hardware_key.slot_picker_label')}
							</legend>
							<div class="mt-2 flex gap-3">
								<label class="flex items-center gap-2 text-sm">
									<input type="radio" bind:group={enrollSlot} value={1} />
									<span>{$_('settings.hardware_key.slot_1')}</span>
								</label>
								<label class="flex items-center gap-2 text-sm">
									<input type="radio" bind:group={enrollSlot} value={2} />
									<span>{$_('settings.hardware_key.slot_2')}</span>
								</label>
							</div>
							<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
								{$_('settings.hardware_key.slot_hint')}
							</p>
						</fieldset>

						{#if enrollPhase !== 'idle'}
							<p
								class="mt-4 text-sm font-medium text-morphit-teal dark:text-morphit-emerald"
								role="status"
								aria-live="polite"
							>
								{phaseText(enrollPhase)}
							</p>
						{/if}

						{#if enrollError}
							<p
								class="mt-3 text-sm text-red-600 dark:text-red-400"
								role="alert"
								aria-live="assertive"
							>
								{enrollError}
							</p>
						{/if}

						<div class="mt-4 flex gap-2">
							<BusyButton
								variant="primary"
								busy={enrollBusy}
								disabled={!backupConfirmed || enrollPassword.length < 8}
								onclick={doEnroll}
							>
								{$_('settings.hardware_key.enroll_submit')}
							</BusyButton>
							<BusyButton
								variant="ghost"
								disabled={enrollBusy}
								onclick={() => {
									enrollOpen = false;
									resetEnrollForm();
								}}
							>
								{$_('common.cancel')}
							</BusyButton>
						</div>
					</div>
				{/if}

				<!-- ─── Harden form ─── -->
				{#if hardenOpen}
					<div class="mt-5 rounded-xl border-2 border-amber-400 bg-white p-4 dark:bg-ink-950">
						<h3 class="text-base font-semibold">
							{$_('settings.hardware_key.harden_form_title')}
						</h3>
						<div
							class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
						>
							<p class="text-sm font-semibold">
								{$_('settings.hardware_key.harden_warning_title')}
							</p>
							<p class="mt-1 text-sm">
								{$_('settings.hardware_key.harden_warning_body')}
							</p>
							<label class="mt-3 flex items-start gap-2 text-sm">
								<input type="checkbox" bind:checked={hardenAck} class="mt-0.5" />
								<span>{$_('settings.hardware_key.harden_confirm_label')}</span>
							</label>
						</div>

						{#if hardenError}
							<p
								class="mt-3 text-sm text-red-600 dark:text-red-400"
								role="alert"
								aria-live="assertive"
							>
								{hardenError}
							</p>
						{/if}

						<div class="mt-4 flex gap-2">
							<BusyButton
								variant="primary"
								busy={hardenBusy}
								disabled={!hardenAck}
								onclick={doHarden}
							>
								{$_('settings.hardware_key.harden_submit')}
							</BusyButton>
							<BusyButton
								variant="ghost"
								disabled={hardenBusy}
								onclick={() => {
									hardenOpen = false;
									hardenAck = false;
									hardenError = '';
								}}
							>
								{$_('common.cancel')}
							</BusyButton>
						</div>
					</div>
				{/if}

				<!-- ─── Soften form ─── -->
				{#if softenOpen}
					<div class="mt-5 rounded-xl border-2 border-morphit-emerald bg-white p-4 dark:bg-ink-950">
						<h3 class="text-base font-semibold">
							{$_('settings.hardware_key.soften_form_title')}
						</h3>
						<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
							{$_('settings.hardware_key.soften_explain')}
						</p>

						<label class="mt-4 block">
							<span class="block text-sm font-semibold">
								{$_('settings.hardware_key.new_password_label')}
							</span>
							<input
								type="password"
								maxlength="64"
								bind:value={softenPassword}
								autocomplete="new-password"
								minlength="8"
								class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
							/>
						</label>

						<label class="mt-3 block">
							<span class="block text-sm font-semibold">
								{$_('settings.hardware_key.confirm_password_label')}
							</span>
							<input
								type="password"
								maxlength="64"
								bind:value={softenPasswordConfirm}
								autocomplete="new-password"
								class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
							/>
						</label>

						{#if softenPhase !== 'idle'}
							<p
								class="mt-4 text-sm font-medium text-morphit-teal dark:text-morphit-emerald"
								role="status"
								aria-live="polite"
							>
								{phaseText(softenPhase)}
							</p>
						{/if}

						{#if softenError}
							<p
								class="mt-3 text-sm text-red-600 dark:text-red-400"
								role="alert"
								aria-live="assertive"
							>
								{softenError}
							</p>
						{/if}

						<div class="mt-4 flex gap-2">
							<BusyButton
								variant="primary"
								busy={softenBusy}
								disabled={softenPassword.length < 8 || softenPassword !== softenPasswordConfirm}
								onclick={doSoften}
							>
								{$_('settings.hardware_key.soften_submit')}
							</BusyButton>
							<BusyButton
								variant="ghost"
								disabled={softenBusy}
								onclick={() => {
									softenOpen = false;
									resetSoftenForm();
								}}
							>
								{$_('common.cancel')}
							</BusyButton>
						</div>
					</div>
				{/if}
			{/if}
		</div>
	</div>
</section>
