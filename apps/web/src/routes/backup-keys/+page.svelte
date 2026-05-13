<script lang="ts">
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import { currentEnvelope, isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { markBackupVisited } from '$utils/backupVisited';
	import { envelopeToBlob, decryptIdentity, KeystoreError } from '$crypto/keystore';
	import { mnemonicForBackup, wipeFullIdentity } from '$crypto/keygen';

	let downloading = $state(false);
	let downloaded = $state(false);
	let downloadError = $state('');

	// Sally finding H6 (Part 68): seed-display flow.  The seed
	// lives in the encrypted envelope (`seedBytes`); a Sally who
	// rushed past the onboarding seed display has no second
	// chance without this surface.  Gated by password re-entry
	// because showing the seed is a high-sensitivity operation
	// that should not be available behind a single-tap (e.g.
	// shoulder-surfer or someone who walked up to an unlocked
	// laptop).
	type SeedPhase =
		| { kind: 'idle' }
		| { kind: 'prompting' }
		| { kind: 'verifying' }
		| { kind: 'shown'; words: readonly string[] }
		| { kind: 'error'; messageKey: string };

	let seedPhase = $state<SeedPhase>({ kind: 'idle' });
	let seedPassword = $state('');

	// Mark the page as visited on mount. This is idempotent and
	// clears the avatar-menu badge on first visit. If the user bails
	// without actually backing up, that's fine — we've discharged
	// our nudge duty; nagging them further would be obnoxious.
	onMount(() => {
		markBackupVisited();
	});

	async function downloadKeyfile(): Promise<void> {
		const env = $currentEnvelope;
		if (!env) {
			downloadError = $_('backup_keys.keyfile_download_err_locked');
			return;
		}
		downloading = true;
		downloadError = '';
		try {
			const blob = envelopeToBlob(env);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `morphit-keyfile-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
			// Brief visual acknowledgement so the user sees the click worked.
			downloaded = true;
			setTimeout(() => (downloaded = false), 3000);
		} catch (err) {
			console.warn('[backup-keys] keyfile download failed:', err);
			downloadError = $_('backup_keys.error_download_failed');
		} finally {
			downloading = false;
		}
	}

	function startShowSeed(): void {
		seedPassword = '';
		seedPhase = { kind: 'prompting' };
	}

	async function verifyAndShowSeed(): Promise<void> {
		const env = $currentEnvelope;
		if (!env) {
			seedPhase = { kind: 'error', messageKey: 'backup_keys.show_seed.error.locked' };
			return;
		}
		if (seedPassword.length === 0) {
			seedPhase = { kind: 'error', messageKey: 'backup_keys.show_seed.error.password_required' };
			return;
		}
		seedPhase = { kind: 'verifying' };
		// We decrypt a fresh FullIdentity copy here purely to
		// access seedBytes.  Wipe immediately after extracting
		// the mnemonic so the private-key bytes from the same
		// FullIdentity don't linger.  The mnemonic string itself
		// is a JS-string immutable — same K1.2 constraint
		// SECURITY.md §1b documents — and lives until GC, but
		// the on-screen display already lifts it into the DOM
		// regardless.
		try {
			const id = await decryptIdentity(env, seedPassword);
			if (id.seedBytes === null) {
				// Posting-only identity — no seed exists to show.
				seedPhase = {
					kind: 'error',
					messageKey: 'backup_keys.show_seed.error.no_seed_posting_only'
				};
				// Clear the password before returning.
				seedPassword = '';
				return;
			}
			const mnemonic = mnemonicForBackup(id);
			// Wipe the FullIdentity copy now that we have the
			// mnemonic.  Per Part 67 audit, the mnemonic string
			// returned here is a JS-immutable; this wipe covers
			// the seedBytes / keypairs only.
			wipeFullIdentity(id);
			seedPhase = { kind: 'shown', words: Object.freeze(mnemonic.split(' ')) };
			// Clear the password from component state immediately
			// — same hygiene posture as login/+page.svelte and
			// PayBlurtModal.
			seedPassword = '';
		} catch (err) {
			if (err instanceof KeystoreError && err.kind === 'bad_password') {
				seedPhase = {
					kind: 'error',
					messageKey: 'backup_keys.show_seed.error.wrong_password'
				};
			} else {
				console.warn('[backup-keys] show-seed decrypt failed:', err);
				seedPhase = {
					kind: 'error',
					messageKey: 'backup_keys.show_seed.error.generic'
				};
			}
			// Clear the password on error too — same posture as
			// every other active-key call site (Part 67 audit).
			seedPassword = '';
		}
	}

	function hideSeed(): void {
		// Note: the displayed mnemonic words are JS strings rooted
		// in the DOM.  Setting seedPhase back to 'idle' drops our
		// reference, making them GC-eligible.  See SECURITY.md §1b
		// for the JS-string immutability discussion.
		seedPhase = { kind: 'idle' };
		seedPassword = '';
	}

	function retryFromError(): void {
		seedPassword = '';
		seedPhase = { kind: 'prompting' };
	}
</script>

<Head routeKey="backup_keys" noindex />

<div class="mx-auto max-w-3xl px-4 py-12 md:py-16">
	<header class="mb-10 text-center">
		<h1 class="font-display text-4xl font-extrabold md:text-5xl">
			<span class="brand-gradient-text">{$_('backup_keys.title')}</span>
		</h1>
		<p class="mx-auto mt-4 max-w-2xl text-ink-600 dark:text-ink-300">
			{$_('backup_keys.subtitle')}
		</p>
	</header>

	<!-- The reality check. This section exists because the single
	     most common catastrophic outcome in crypto is "I lost access
	     to my keys." We make damn sure the user understands what
	     that means before they walk away from this page. Red border
	     + alert role so screen readers announce the severity. -->
	<section
		class="card mb-8 border-red-500/60 bg-red-50/50 dark:border-red-600/40 dark:bg-red-950/20"
		role="alert"
	>
		<h2 class="font-display text-2xl font-bold text-red-700 dark:text-red-400">
			{$_('backup_keys.reality_heading')}
		</h2>
		<p class="mt-3 font-semibold text-ink-900 dark:text-ink-100">
			{$_('backup_keys.reality_lead')}
		</p>
		<p class="mt-3 whitespace-pre-line text-ink-800 dark:text-ink-200">
			{$_('backup_keys.reality_body')}
		</p>
		<p
			class="mt-4 border-t border-red-300 pt-4 font-display text-lg font-bold italic text-red-700 dark:border-red-800 dark:text-red-400"
		>
			{$_('backup_keys.reality_slogan')}
		</p>
	</section>

	{#if $isPairedReadOnly}
		<!-- Bob finding B-2 (Part 119): paired-readonly users have no
		     keys on THIS device — they're on the phone.  Pre-fix, the
		     page silently hid the seed/keyfile sections because
		     $isUnlocked is false for paired sessions, leaving Bob on
		     a "Title + Reality slogan" stub with no actionable next
		     step.  Now we explicitly tell him: your keys are on the
		     phone, do your backup there.  Deep-link to the phone's
		     own backup-keys surface preserves the standard
		     WriteBlockedReadOnly pattern. -->
		<section
			class="card mb-6 border-morphit-emerald/40 bg-morphit-emerald/5"
			aria-labelledby="backup-paired-heading"
		>
			<h2
				id="backup-paired-heading"
				class="font-display text-2xl font-bold text-morphit-emerald"
			>
				{$_('backup_keys.paired.heading')}
			</h2>
			<p class="mt-3 text-ink-800 dark:text-ink-200">
				{$_('backup_keys.paired.body')}
			</p>
			<p class="mt-3 text-ink-700 dark:text-ink-300">
				{$_('backup_keys.paired.deeplink_hint')}
			</p>
			<div class="mt-5">
				<a
					href="web+morphit://backup-keys"
					class="btn-primary inline-flex items-center gap-2"
				>
					<span aria-hidden="true">📱</span>
					{$_('backup_keys.paired.deeplink_cta')}
				</a>
			</div>
		</section>
	{/if}

	<!-- What to back up, and where. Three methods, most important
	     listed first: the seed phrase (works with any BIP-39 wallet)
	     above the Morphit-specific encrypted keyfile. -->
	<section class="card mb-6">
		<h2 class="font-display text-2xl font-bold">{$_('backup_keys.what_heading')}</h2>

		<div class="mt-6 space-y-6">
			<!-- Seed phrase — the gold standard. Universal, offline,
			     doesn't require any Morphit-specific software to
			     recover from. -->
			<article>
				<h3 class="font-display text-lg font-bold">{$_('backup_keys.seed_heading')}</h3>
				<p class="mt-2 whitespace-pre-line text-ink-700 dark:text-ink-200">
					{$_('backup_keys.seed_body')}
				</p>
				<ul class="mt-3 list-inside list-disc space-y-1 text-sm text-ink-700 dark:text-ink-200">
					<li>{$_('backup_keys.seed_tip_paper')}</li>
					<li>{$_('backup_keys.seed_tip_steel')}</li>
					<li>{$_('backup_keys.seed_tip_split')}</li>
					<li>{$_('backup_keys.seed_tip_digital_warning')}</li>
				</ul>

				<!-- Sally finding H6 (Part 68): show-my-seed flow.
				     The seed lives in the encrypted envelope and
				     can be recovered with the user's password.
				     Gated behind a password re-prompt because
				     showing the seed phrase is high-sensitivity:
				     someone who walks up to an unlocked device
				     should NOT be able to read the recovery
				     phrase by tapping a button.  Mirrors the
				     useActiveKey JIT pattern conceptually. -->
				{#if $isUnlocked && $currentEnvelope}
					<div class="mt-5 rounded-xl border border-morphit-emerald/30 bg-morphit-emerald/5 p-4">
						<h4 class="font-display text-base font-bold">
							{$_('backup_keys.show_seed.heading')}
						</h4>
						<p class="mt-1 text-sm text-ink-700 dark:text-ink-200">
							{$_('backup_keys.show_seed.body')}
						</p>

						{#if seedPhase.kind === 'idle'}
							<div class="mt-3">
								<BusyButton variant="secondary" onclick={startShowSeed}>
									{$_('backup_keys.show_seed.cta')}
								</BusyButton>
							</div>
						{:else if seedPhase.kind === 'prompting' || seedPhase.kind === 'verifying'}
							<label class="mt-3 block">
								<span class="block text-sm font-semibold">
									{$_('backup_keys.show_seed.password_label')}
								</span>
								<input
									type="password"
									bind:value={seedPassword}
									autocomplete="current-password"
									disabled={seedPhase.kind === 'verifying'}
									onkeydown={(e) => {
										if (e.key === 'Enter' && seedPassword.length > 0) {
											void verifyAndShowSeed();
										}
									}}
									class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
								/>
							</label>
							<p class="mt-2 text-xs text-ink-500 dark:text-ink-400">
								{$_('backup_keys.show_seed.password_hint')}
							</p>
							<div class="mt-3 flex flex-wrap gap-2">
								<BusyButton
									variant="primary"
									busy={seedPhase.kind === 'verifying'}
									busyLabel={$_('backup_keys.show_seed.verifying') as string}
									disabled={seedPassword.length === 0}
									onclick={verifyAndShowSeed}
								>
									{$_('backup_keys.show_seed.reveal')}
								</BusyButton>
								<BusyButton
									variant="ghost"
									disabled={seedPhase.kind === 'verifying'}
									onclick={hideSeed}
								>
									{$_('common.cancel')}
								</BusyButton>
							</div>
						{:else if seedPhase.kind === 'shown'}
							<div
								class="mt-4 rounded-xl border-2 border-dashed border-amber-400 bg-white p-4 dark:bg-ink-950"
							>
								<p
									class="mb-3 text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400"
								>
									⚠ {$_('backup_keys.show_seed.shoulder_warning')}
								</p>
								<ol class="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-base sm:grid-cols-3">
									{#each seedPhase.words as word, i}
										<li class="flex items-baseline gap-2">
											<span class="w-6 text-right text-xs text-ink-400">{i + 1}.</span>
											<span class="select-all font-semibold">{word}</span>
										</li>
									{/each}
								</ol>
							</div>
							<div class="mt-3">
								<BusyButton variant="secondary" onclick={hideSeed}>
									{$_('backup_keys.show_seed.hide')}
								</BusyButton>
							</div>
						{:else if seedPhase.kind === 'error'}
							<div class="mt-3">
								<StatusLine kind="error">
									{$_(seedPhase.messageKey)}
								</StatusLine>
							</div>
							<div class="mt-3 flex flex-wrap gap-2">
								<BusyButton variant="primary" onclick={retryFromError}>
									{$_('common.retry')}
								</BusyButton>
								<BusyButton variant="ghost" onclick={hideSeed}>
									{$_('common.cancel')}
								</BusyButton>
							</div>
						{/if}
					</div>
				{:else}
					<div class="mt-4">
						<StatusLine kind="idle">
							{$_('backup_keys.show_seed.locked_hint')}
						</StatusLine>
					</div>
				{/if}
			</article>

			<!-- Encrypted keyfile — password-protected JSON download.
			     Good as a secondary backup. If the user forgets the
			     password, the keyfile is useless. -->
			<article>
				<h3 class="font-display text-lg font-bold">{$_('backup_keys.keyfile_heading')}</h3>
				<p class="mt-2 whitespace-pre-line text-ink-700 dark:text-ink-200">
					{$_('backup_keys.keyfile_body')}
				</p>

				{#if $isUnlocked}
					<div class="mt-4 flex flex-wrap items-center gap-3">
						<BusyButton
							variant="primary"
							busy={downloading}
							done={downloaded}
							busyLabel={$_('backup_keys.keyfile_downloading')}
							onclick={downloadKeyfile}
						>
							{#if downloaded}
								{$_('backup_keys.keyfile_downloaded')}
							{:else}
								{$_('backup_keys.keyfile_download')}
							{/if}
						</BusyButton>
						<p class="text-xs text-ink-500 dark:text-ink-400">
							{$_('backup_keys.keyfile_filename_hint')}
						</p>
					</div>
					{#if downloadError}
						<div class="mt-3">
							<StatusLine kind="error">{downloadError}</StatusLine>
						</div>
					{/if}
				{:else}
					<div class="mt-4">
						<StatusLine kind="idle">
							{$_('backup_keys.keyfile_locked_hint')}
						</StatusLine>
					</div>
				{/if}
			</article>

			<!-- Redundancy reminder. Two locations, two formats, two
			     people (trusted heir / estate plan). Crypto survivors
			     are the ones who did this. -->
			<article>
				<h3 class="font-display text-lg font-bold">{$_('backup_keys.redundancy_heading')}</h3>
				<p class="mt-2 whitespace-pre-line text-ink-700 dark:text-ink-200">
					{$_('backup_keys.redundancy_body')}
				</p>
			</article>
		</div>
	</section>

	<!-- What NOT to do. Reciprocal to the advice above — spelling out
	     the most common ways people lose crypto. -->
	<section class="card mb-6">
		<h2 class="font-display text-2xl font-bold">{$_('backup_keys.antipatterns_heading')}</h2>
		<ul class="mt-4 space-y-3">
			<li class="flex gap-3">
				<span class="flex-none text-red-500" aria-hidden="true">✕</span>
				<span class="text-ink-700 dark:text-ink-200">{$_('backup_keys.anti_email')}</span>
			</li>
			<li class="flex gap-3">
				<span class="flex-none text-red-500" aria-hidden="true">✕</span>
				<span class="text-ink-700 dark:text-ink-200">{$_('backup_keys.anti_cloud')}</span>
			</li>
			<li class="flex gap-3">
				<span class="flex-none text-red-500" aria-hidden="true">✕</span>
				<span class="text-ink-700 dark:text-ink-200">{$_('backup_keys.anti_photo')}</span>
			</li>
			<li class="flex gap-3">
				<span class="flex-none text-red-500" aria-hidden="true">✕</span>
				<span class="text-ink-700 dark:text-ink-200">{$_('backup_keys.anti_share')}</span>
			</li>
			<li class="flex gap-3">
				<span class="flex-none text-red-500" aria-hidden="true">✕</span>
				<span class="text-ink-700 dark:text-ink-200">{$_('backup_keys.anti_support')}</span>
			</li>
		</ul>
	</section>

	<!-- FAQ pointers for users who want to dig deeper. -->
	<section class="card">
		<h2 class="font-display text-2xl font-bold">{$_('backup_keys.learn_more_heading')}</h2>
		<p class="mt-2 text-ink-700 dark:text-ink-200">{$_('backup_keys.learn_more_body')}</p>
		<div class="mt-4 flex flex-wrap gap-3">
			<a href="/faq#lost_keys" class="btn-secondary">{$_('backup_keys.faq_lost_keys')}</a>
			<a href="/faq#privacy_practices" class="btn-ghost">{$_('backup_keys.faq_privacy')}</a>
			<a href="/security" class="btn-ghost">{$_('backup_keys.security_page')}</a>
		</div>
	</section>
</div>
