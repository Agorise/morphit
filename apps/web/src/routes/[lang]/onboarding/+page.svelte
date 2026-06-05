<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import { goto, beforeNavigate } from '$app/navigation';
	import { gotoLocale } from '$i18n/navigate';
	import Tooltip from '$components/Tooltip.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	// cp165 byte-budget: SeedBackupPrint only renders after the user
	// clicks "Show seed" — a one-time onboarding action.  Defer the
	// ~9 KB component until then.
	// import SeedBackupPrint from '$components/SeedBackupPrint.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	// cp165: lazy ConfirmModal (only renders on leave-with-pending-state prompt)
	// import ConfirmModal from '$components/ConfirmModal.svelte';
	import {
		generateIdentity,
		wipeFullIdentity,
		wipeLiveIdentity,
		pickRandomIndices,
		mnemonicForBackup,
		type FullIdentity,
		type LiveIdentity
	} from '$crypto/keygen';
	import { encryptIdentity, envelopeToBlob } from '$crypto/keystore';
	import { writeKeystoreMode, writeEnvelope } from '$crypto/persistentKeystore';
	import { identiconDataUri } from '$crypto/identicon';
	import { bootFromEnvelope } from '$stores/identity';
	import { scorePassword, isPasswordAcceptable } from '$lib/auth/passwordStrength';

	type Stage = 'choose' | 'generating' | 'review' | 'confirm' | 'done';
	type Path = 'reputation' | 'anonymous';

	let stage = $state<Stage>('choose');

	// `full` lives only until it's handed to the keystore; then its owner/
	// active privates are zeroed and `live` is what persists in memory
	// for the session (via the identity store after completion).
	let full = $state<FullIdentity | null>(null);
	let live = $state<LiveIdentity | null>(null);

	let wroteDown = $state(false);
	let understand = $state(false);

	// cp165: lazy SeedBackupPrint (only rendered after Show Seed click)
	const loadSeedBackupPrint = () =>
		import('$components/SeedBackupPrint.svelte').then((m) => m.default);
	const loadConfirmModal = () =>
		import('$components/ConfirmModal.svelte').then((m) => m.default);
	let showSeed = $state(false);
	let password = $state('');
	/** The user's keystore persistence choice. `null` means they
	 *  haven't chosen yet — Continue button is disabled. */
	let keystoreMode: 'password' | 'seed-only' | null = $state(null);
	let downloading = $state(false);
	/** True for ~1500ms immediately after a successful download. Drives
	 *  the "Downloaded ✓" transient confirmation. Per UX-STANDARD #3. */
	let justDownloaded = $state(false);
	let errorMsg = $state('');

	// Confirmation quiz state — generated when entering `confirm` stage.
	let quizIndices: number[] = $state([]);
	let quizAnswers: string[] = $state(['', '', '']);
	let quizAttempted = $state(false);
	/** True while submitQuiz is running its async work (encrypt → boot →
	 *  navigate). Drives the submit button's busy state. */
	let quizSubmitting = $state(false);

	async function pickPath(_path: Path): Promise<void> {
		// `_path` is currently unused — the reputation-vs-anonymous
		// branching is downstream of identity generation (it shows
		// up in the post-onboarding review copy and in whether the
		// user is nudged to register a name).  Kept as a parameter
		// so the call sites remain self-documenting and so a future
		// path-aware generation can wire in without touching the
		// callers.
		stage = 'generating';
		errorMsg = '';
		try {
			// Tier 4.3 (Part 89): 600ms min-visibility on the spinner.
			// On fast machines `generateIdentity()` resolves in <1
			// frame, so the user sees the spinner flash and then the
			// seed phrase appear instantly — which reads as "did
			// something break?" rather than "the device made me a key
			// pair, here's the seed." Holding the spinner for at
			// least 600ms reads as "the device is doing something
			// important." Slower machines proceed at natural rate
			// because Promise.all waits for both.
			const minDelay = new Promise<void>((resolve) => setTimeout(resolve, 600));
			const [result] = await Promise.all([generateIdentity(), minDelay]);
			full = result.full;
			live = result.live;
			stage = 'review';
		} catch (err) {
			console.warn('[onboarding] generateIdentity failed:', err);
			errorMsg = $_('onboarding.error.generate_failed');
			stage = 'choose';
		}
	}

	async function downloadKeyfile(): Promise<void> {
		if (!full) return;
		if (!isPasswordAcceptable(password)) {
			errorMsg = $_('onboarding.backup.password_too_short');
			return;
		}
		errorMsg = '';
		downloading = true;
		try {
			const env = await encryptIdentity(full, password);
			const blob = envelopeToBlob(env);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `morphit-keyfile-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
			// Celebrate the download briefly so grandma sees it happened.
			justDownloaded = true;
			setTimeout(() => {
				justDownloaded = false;
			}, 1500);
		} catch (err) {
			console.warn('[onboarding] keyfile download failed:', err);
			errorMsg = $_('onboarding.error.keyfile_download_failed');
		} finally {
			downloading = false;
		}
	}

	function proceedToConfirm(): void {
		if (!wroteDown || !understand || !full) return;
		// Hide the seed UI now that we're quizzing the user on it.
		showSeed = false;
		// Pick 3 random distinct indices from the 12-word seed.
		quizIndices = pickRandomIndices(12, 3);
		quizAnswers = ['', '', ''];
		quizAttempted = false;
		errorMsg = '';
		stage = 'confirm';
	}

	// K1.2 + M5 — derive the mnemonic on demand from seedBytes only
	// when we actually need to display it.
	//
	// Pre-fix this was `$derived(full ? mnemonicForBackup(full)... )`
	// which fires the moment `full` becomes truthy — even before the
	// user clicked "Show seed."  The full mnemonic string sat in
	// JS-engine heap from then until page unmount, regardless of
	// whether it was ever displayed.
	//
	// Post-fix: gate on `showSeed` too.  If the user never reveals
	// the mnemonic, `mnemonicForBackup(full)` is never called for
	// display, the concatenated string lives only inside the quiz
	// derivation (which re-allocates per check; each instance is
	// short-lived), and only the per-word `<span>` text nodes (each
	// in its own small allocation) touch the DOM after a click.
	const seedWords = $derived(full && showSeed ? mnemonicForBackup(full).split(' ') : []);

	const quizCorrect = $derived.by(() => {
		if (!full) return false;
		// Don't read `seedWords` (which is empty during the quiz
		// because `showSeed` was set false in proceedToConfirm).
		// Compute the expected words inline so the mnemonic string
		// only exists for the duration of this derivation; then it
		// goes out of scope.  Per-call allocation, per-call
		// reclamation.
		const words = mnemonicForBackup(full).split(' ');
		for (let i = 0; i < quizIndices.length; i++) {
			const expected = words[quizIndices[i]!]?.trim().toLowerCase();
			const given = quizAnswers[i]?.trim().toLowerCase() ?? '';
			if (!expected || expected !== given) return false;
		}
		return true;
	});

	async function submitQuiz(): Promise<void> {
		quizAttempted = true;
		if (!quizCorrect || !full || !live) return;
		errorMsg = '';
		quizSubmitting = true;
		try {
			// Session password: user's chosen password when they picked
			// password-mode, or a random in-memory password when they
			// picked seed-only mode (so the envelope is still a valid
			// encrypted blob the identity store can work with, but
			// nobody can reconstruct it across sessions).
			let sessionPassword: string;
			if (keystoreMode === 'password') {
				if (!isPasswordAcceptable(password)) {
					errorMsg = $_('onboarding.backup.password_too_short');
					quizSubmitting = false;
					return;
				}
				sessionPassword = password;
			} else {
				// seed-only mode (or mode not set — shouldn't happen
				// because Continue is gated, but defensive). Generate
				// an ephemeral random password. Envelope stays in
				// memory only.
				const rnd = crypto.getRandomValues(new Uint8Array(24));
				sessionPassword = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
			}
			const env = await encryptIdentity(full, sessionPassword);
			// Boot the session identity store. This keeps posting + memo
			// privates live in memory; owner + active public keys are
			// retained for display; everything else is in `env`.
			await bootFromEnvelope(env, sessionPassword);

			// Persist the mode choice always, so the login page can
			// check it on future visits. Only persist the envelope
			// itself when user picked password-mode.
			if (keystoreMode === 'password') {
				writeKeystoreMode('password');
				// M8 fix: if storage isn't usable (private mode, quota,
				// disabled), we'd boot the in-memory session but lose
				// the envelope on next reload — the user would have to
				// re-import their seed, defeating the point of choosing
				// password mode.  Surface clearly so they can react
				// (e.g. switch to seed-only mode for this session).
				const persisted = writeEnvelope(env);
				if (!persisted) {
					errorMsg = $_('onboarding.backup.persist_failed');
					quizSubmitting = false;
					return;
				}
			} else {
				writeKeystoreMode('seed-only');
			}

			// Wipe the FullIdentity we still held.
			wipeFullIdentity(full);
			full = null;
			// Wipe the local LiveIdentity's posting/memo privates too.
			// O2.1 — the store's live identity is a fresh allocation
			// from bootFromEnvelope's decrypt path, NOT shared with
			// our local `live`.  Without this wipe, the local copy's
			// private key bytes linger in heap until GC — the same
			// session-long-residue class as K1.2.
			wipeLiveIdentity(live);
			live = null;
			// Clear the user's chosen password from component state.
			// `sessionPassword` is a function-local; component-state
			// `password` outlives this function until the component
			// unmounts on the goto() below.  Explicit clear shortens
			// the heap-residency window.
			password = '';
			stage = 'done';
			await gotoLocale('/onboarding/register-name');
		} catch (err) {
			console.warn('[onboarding] quiz submit failed:', err);
			errorMsg = $_('onboarding.error.quiz_submit_failed');
			quizSubmitting = false;
		}
	}

	// ─── Navigation guard ──────────────────────────────────────────────────

	/** URL the user is trying to navigate to when we showed
	 *  the leave-confirmation modal. Captured from the
	 *  beforeNavigate hook so the confirm handler can replay
	 *  the navigation via goto() after wiping sensitive state. */
	let pendingLeaveUrl = $state<URL | null>(null);
	let leaveConfirmOpen = $state(false);

	// Sync pendingLeaveUrl → leaveConfirmOpen. Clearing the URL
	// closes the modal (ConfirmModal writes open=false on
	// Escape/backdrop too, which our cancel handler mirrors).
	$effect(() => {
		leaveConfirmOpen = pendingLeaveUrl !== null;
	});

	beforeNavigate((nav) => {
		// Only warn while we're in a stage where unfinished sensitive state
		// lives in memory. The submitQuiz path flips stage to 'done' BEFORE
		// calling goto(), so that path won't trip this guard.
		const inSensitiveStage = stage === 'review' || stage === 'confirm';
		if (!inSensitiveStage) return;

		// Hash-only or same-page updates (e.g. FAQ deep-linking the URL)
		// aren't navigations we need to warn about.
		if (nav.to && nav.from && nav.to.url.pathname === nav.from.url.pathname) {
			return;
		}

		// 'leave' type is a tab close / hard refresh / external
		// navigation — SvelteKit's nav.cancel() is a no-op for
		// these (the browser's own beforeunload handler takes
		// over). Don't bother opening a modal that navigation
		// will discard anyway.
		if (nav.type === 'leave') return;

		// Don't bother if there's nothing to navigate to — the
		// hook gives null for some refresh types.
		if (!nav.to) return;

		// If user already confirmed, let them through. The confirm
		// handler sets pendingLeaveUrl=null before calling goto(),
		// so when this hook re-fires for that goto the state is
		// clean and we return here.
		if (pendingLeaveUrl !== null) return;

		// Cancel the in-flight navigation and surface the modal
		// instead. The confirm handler will re-issue the
		// navigation via goto() after wiping sensitive state.
		nav.cancel();
		pendingLeaveUrl = nav.to.url;
	});

	async function onConfirmLeave(): Promise<void> {
		const target = pendingLeaveUrl;
		if (!target) return;
		// Wipe sensitive state before the actual navigation. This
		// matches the prior implementation's ordering so recipients
		// of the navigation don't observe leftover identity state.
		// O2.1 — wipe BOTH `full` (snapshot) and `live` (original-
		// derived).  These are independent allocations; wiping
		// `full` alone leaves `live`'s posting/memo private bytes
		// in heap until GC.
		if (full) {
			wipeFullIdentity(full);
			full = null;
		}
		if (live) {
			wipeLiveIdentity(live);
			live = null;
		}
		// Also clear the user's chosen password (if any) — they're
		// abandoning onboarding mid-flow, no reason to keep the
		// password sitting in component state until GC.
		password = '';
		// Clear pending so when the goto() re-enters beforeNavigate
		// we fall through instead of re-prompting.
		pendingLeaveUrl = null;
		await goto(target.pathname + target.search + target.hash);
	}

	function onCancelLeave(): void {
		pendingLeaveUrl = null;
	}

	// Tier 2.3 — back button from `review` stage.  The user has a
	// generated FullIdentity in `full` and a LiveIdentity in `live`;
	// going back to `choose` MUST wipe both per the project's
	// key-handling contract.  Same wipe pattern as onConfirmLeave
	// above — both `full` (snapshot) and `live` (original-derived)
	// are independent allocations; wiping one alone leaks the
	// other's bytes into heap until GC.  Confirmation modal because
	// (a) the user just generated 12 random words they were asked
	// to write down — a misclick that silently discards them
	// would feel like data loss, and (b) generating a fresh
	// identity has a min-visibility 600ms spinner so the round-trip
	// to a new seed is non-trivial.
	let pendingRestartFromReview = $state(false);

	function requestRestartFromReview(): void {
		pendingRestartFromReview = true;
	}

	function confirmRestartFromReview(): void {
		// Wipe sensitive state before resetting.  Same pattern as
		// onConfirmLeave: both `full` and `live` are wiped, then
		// nulled.  The component-state password is cleared because
		// the user is abandoning the post-generation flow before
		// committing to a keystore.
		if (full) {
			wipeFullIdentity(full);
			full = null;
		}
		if (live) {
			wipeLiveIdentity(live);
			live = null;
		}
		password = '';
		// Reset the auxiliary review-stage state so re-entering
		// `review` from a fresh `pickPath` call doesn't carry over
		// stale checkbox or quiz state.
		wroteDown = false;
		understand = false;
		showSeed = false;
		keystoreMode = null;
		errorMsg = '';
		quizIndices = [];
		quizAnswers = ['', '', ''];
		quizAttempted = false;
		// Close the modal and return to choose.
		pendingRestartFromReview = false;
		stage = 'choose';
	}

	function cancelRestartFromReview(): void {
		pendingRestartFromReview = false;
	}

	const avatarUri = $derived(live ? identiconDataUri(live.posting.publicKey, 96) : '');

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="onboarding" />

<div class="mx-auto max-w-3xl px-4 py-12 md:py-16">
	<header class="mb-10 text-center">
		<h1 class="font-display text-4xl font-extrabold tracking-tight md:text-5xl">
			<span class="brand-gradient-text">{$_('onboarding.title')}</span>
		</h1>
		<p class="mx-auto mt-4 max-w-prose text-lg text-ink-700 dark:text-ink-200">
			{$_('onboarding.intro')}
		</p>
	</header>

	{#if errorMsg}
		<div
			class="card mb-6 border-red-300 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
			role="alert"
		>
			{errorMsg}
		</div>
	{/if}

	{#if stage === 'choose'}
		<section class="animate-fade-up" aria-labelledby="paths-heading">
			<h2 id="paths-heading" class="sr-only">{$_('onboarding.paths.heading')}</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				<button
					type="button"
					onclick={() => pickPath('reputation')}
					class="card text-left transition hover:border-morphit-emerald hover:shadow-lg active:scale-[0.99]"
				>
					<h3 class="font-display text-xl font-bold">{$_('onboarding.path_reputation.title')}</h3>
					<p class="mt-2 text-ink-700 dark:text-ink-200">{$_('onboarding.path_reputation.body')}</p>
				</button>
				<button
					type="button"
					onclick={() => pickPath('anonymous')}
					class="card text-left transition hover:border-morphit-emerald hover:shadow-lg active:scale-[0.99]"
				>
					<h3 class="font-display text-xl font-bold">{$_('onboarding.path_anonymous.title')}</h3>
					<p class="mt-2 text-ink-700 dark:text-ink-200">{$_('onboarding.path_anonymous.body')}</p>
				</button>
			</div>

			<div class="mt-8 text-center">
				<a href={lp('/onboarding/import')} class="font-semibold text-morphit-emerald hover:underline">
					{$_('nav.import_account')} →
				</a>
			</div>
		</section>
	{:else if stage === 'generating'}
		<section class="card animate-fade-up text-center" aria-live="polite">
			<div class="mx-auto mb-4 h-12 w-12 animate-pulse-soft rounded-full bg-morphit-gradient"></div>
			<p class="text-lg">{$_('onboarding.generating')}</p>
		</section>
	{:else if stage === 'review' && live && full}
		<section class="animate-fade-up" aria-labelledby="review-heading">
			<div class="card">
				<div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
					<img src={avatarUri} alt="" class="h-24 w-24 flex-none rounded-2xl" loading="lazy" decoding="async" />
					<div class="flex-1 text-center sm:text-left">
						<h2 id="review-heading" class="font-display text-2xl font-bold">
							{$_('onboarding.generated_title')}
						</h2>
						<p class="mt-2 text-ink-700 dark:text-ink-200">{$_('onboarding.generated_body')}</p>
						<div class="mt-3">
							<p class="mb-1 text-xs font-semibold uppercase tracking-widest text-ink-500">
								{$_('onboarding.this_is_you')}
							</p>
							<IdentityLabel publicKey={live.posting.publicKey} weight="bold" />
						</div>
					</div>
				</div>
			</div>

			<div class="card mt-6">
				<h3 class="flex items-center gap-2 font-display text-lg font-bold">
					{$_('onboarding.backup.title')}
					<Tooltip textKey="onboarding.backup.seed_hint" faqKey="lost_keys" />
				</h3>
				<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
					{$_('onboarding.backup.seed_hint')}
				</p>

				<div
					class="relative mt-4 rounded-2xl border-2 border-dashed border-ink-200 bg-ink-50 p-5 dark:border-ink-700 dark:bg-ink-950"
				>
					{#if showSeed}
						<ol class="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-base sm:grid-cols-3">
							{#each seedWords as word, i}
								<li class="flex items-baseline gap-2">
									<span class="w-6 text-right text-xs text-ink-400">{i + 1}.</span>
									<span class="select-all font-semibold">{word}</span>
								</li>
							{/each}
						</ol>
					{:else}
						<div class="flex flex-col items-center gap-3 py-6">
							<p class="text-sm text-ink-500">{$_('onboarding.backup.hidden_hint')}</p>
							<BusyButton variant="secondary" onclick={() => (showSeed = true)}>
								{$_('onboarding.backup.show_seed')}
							</BusyButton>
						</div>
					{/if}
				</div>

				<!-- Tier 1.3 follow-up (Part 92): printable backup
				     card.  Only meaningful when the seed is currently
				     visible (otherwise there's nothing for the user
				     to compare the printout against, and printing an
				     empty grid is pointless).  Pure local rendering;
				     no PDF library, no network — the user's browser's
				     own print machinery handles paper or save-to-PDF. -->
				{#if showSeed}
					<div class="mt-3 flex items-center gap-3">
						{#await loadSeedBackupPrint() then SeedBackupPrint}
							<SeedBackupPrint words={seedWords} />
						{/await}
						<span class="text-xs text-ink-500">
							{$_('onboarding.backup.print_card.helper_hint')}
						</span>
					</div>
				{/if}

				<div class="mt-6 space-y-3">
					<label class="flex cursor-pointer items-start gap-3">
						<input
							type="checkbox"
							bind:checked={wroteDown}
							class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
						/>
						<span class="text-ink-800 dark:text-ink-200"
							>{$_('onboarding.backup.confirm_wrote_down')}</span
						>
					</label>
					<label class="flex cursor-pointer items-start gap-3">
						<input
							type="checkbox"
							bind:checked={understand}
							class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
						/>
						<span class="text-ink-800 dark:text-ink-200"
							>{$_('onboarding.backup.confirm_understand')}</span
						>
					</label>
				</div>
			</div>

			<!-- Unlock-method choice. Explicit radio choice the user
			     has to make before continuing. This is what makes
			     Lock Session meaningfully different from Sign Out on
			     this device. -->
			<div class="card mt-6" role="group" aria-labelledby="unlock-mode-heading">
				<h3 id="unlock-mode-heading" class="font-display text-lg font-bold">
					{$_('onboarding.unlock_mode.heading')}
				</h3>
				<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
					{$_('onboarding.unlock_mode.explain')}
				</p>

				<div class="mt-4 space-y-3">
					<label
						class="flex cursor-pointer items-start gap-3 rounded-2xl border-2 p-4 transition {keystoreMode ===
						'password'
							? 'border-morphit-emerald bg-morphit-emerald/5'
							: 'border-ink-200 dark:border-ink-700'}"
					>
						<input
							type="radio"
							name="unlock-mode"
							value="password"
							checked={keystoreMode === 'password'}
							onchange={() => (keystoreMode = 'password')}
							class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
						/>
						<div class="min-w-0">
							<p class="font-semibold">{$_('onboarding.unlock_mode.password_label')}</p>
							<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
								{$_('onboarding.unlock_mode.password_body')}
							</p>
						</div>
					</label>

					<label
						class="flex cursor-pointer items-start gap-3 rounded-2xl border-2 p-4 transition {keystoreMode ===
						'seed-only'
							? 'border-morphit-emerald bg-morphit-emerald/5'
							: 'border-ink-200 dark:border-ink-700'}"
					>
						<input
							type="radio"
							name="unlock-mode"
							value="seed-only"
							checked={keystoreMode === 'seed-only'}
							onchange={() => (keystoreMode = 'seed-only')}
							class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
						/>
						<div class="min-w-0">
							<p class="font-semibold">{$_('onboarding.unlock_mode.seed_only_label')}</p>
							<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
								{$_('onboarding.unlock_mode.seed_only_body')}
							</p>
						</div>
					</label>
				</div>

				<!-- Password input + keyfile download — only visible
				     when user picked password-mode. The same password
				     encrypts both the localStorage envelope and any
				     downloaded keyfile, so users aren't managing two
				     different passwords for the same keys. -->
				{#if keystoreMode === 'password'}
					<div class="mt-5 space-y-3">
						<label class="block text-sm font-medium">
							{$_('onboarding.backup.password_label')}
							<input
								type="password"
								bind:value={password}
								autocomplete="new-password"
								minlength="8"
								class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-900"
							/>
						</label>
						<p class="text-xs text-ink-500">{$_('onboarding.backup.password_hint')}</p>
						{#if password.length >= 10}
							{@const strength = scorePassword(password)}
							{#if strength === 'too_simple'}
								<p class="text-xs text-red-600 dark:text-red-400">
									⚠ {$_('onboarding.backup.password_strength_too_simple')}
								</p>
							{:else if strength === 'common'}
								<p class="text-xs text-red-600 dark:text-red-400">
									⚠ {$_('onboarding.backup.password_strength_common')}
								</p>
							{:else if strength === 'trivial'}
								<p class="text-xs text-red-600 dark:text-red-400">
									⚠ {$_('onboarding.backup.password_strength_trivial')}
								</p>
							{:else if strength === 'ok'}
								<p class="text-xs text-emerald-700 dark:text-emerald-400">
									✓ {$_('onboarding.backup.password_strength_ok')}
								</p>
							{/if}
						{/if}

						<details>
							<summary class="cursor-pointer text-sm font-semibold text-morphit-emerald">
								{$_('onboarding.backup.download_keyfile')}
							</summary>
							<div
								class="mt-3 rounded-xl border border-ink-200 bg-ink-50 p-3 dark:border-ink-700 dark:bg-ink-950"
							>
								<p class="text-xs text-ink-600 dark:text-ink-300">
									{$_('onboarding.backup.keyfile_explain')}
								</p>
								<div class="mt-3">
									<BusyButton
										variant="secondary"
										busy={downloading}
										done={justDownloaded}
										disabled={!isPasswordAcceptable(password)}
										onclick={downloadKeyfile}
										busyLabel={$_('common.downloading')}
									>
										{#if justDownloaded}
											{$_('common.downloaded')}
										{:else}
											{$_('common.download')}
										{/if}
									</BusyButton>
								</div>
							</div>
						</details>
					</div>
				{/if}
			</div>

			<div class="mt-8 flex flex-col gap-4">
				<p class="text-center text-sm text-ink-500 sm:text-left">
					{#if !wroteDown || !understand}
						{$_('onboarding.backup.blocked')}
					{:else if keystoreMode === null}
						{$_('onboarding.unlock_mode.must_choose')}
					{:else if keystoreMode === 'password' && !isPasswordAcceptable(password)}
						{$_('onboarding.unlock_mode.password_too_short')}
					{/if}
				</p>
				<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<BusyButton variant="ghost" onclick={requestRestartFromReview}>
						← {$_('onboarding.review.back_button')}
					</BusyButton>
					<BusyButton
						variant="primary"
						disabled={!wroteDown ||
							!understand ||
							keystoreMode === null ||
							(keystoreMode === 'password' && !isPasswordAcceptable(password))}
						onclick={proceedToConfirm}
					>
						{$_('onboarding.backup.continue')}
					</BusyButton>
				</div>
			</div>
		</section>
	{:else if stage === 'confirm' && full}
		<section class="animate-fade-up" aria-labelledby="confirm-heading">
			<div class="card">
				<h2 id="confirm-heading" class="font-display text-2xl font-bold">
					{$_('onboarding.confirm.title')}
				</h2>
				<p class="mt-2 text-ink-700 dark:text-ink-200">
					{$_('onboarding.confirm.body')}
				</p>

				<ol class="mt-6 space-y-4">
					{#each quizIndices as qi, idx}
						<li>
							<label class="block">
								<span class="mb-1 block text-sm font-semibold">
									{$_('onboarding.confirm.word_n', { values: { n: qi + 1 } })}
								</span>
								<input
									type="text"
									bind:value={quizAnswers[idx]}
									autocomplete="off"
									autocapitalize="off"
									autocorrect="off"
									spellcheck="false"
									class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 font-mono focus:border-morphit-emerald focus:outline-none dark:border-ink-700 dark:bg-ink-950"
								/>
							</label>
						</li>
					{/each}
				</ol>

				{#if quizAttempted && !quizCorrect}
					<div class="mt-4">
						<StatusLine kind="error">
							{$_('onboarding.confirm.wrong')}
						</StatusLine>
					</div>
				{/if}

				<div class="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<BusyButton
						variant="ghost"
						disabled={quizSubmitting}
						onclick={() => {
							stage = 'review';
							showSeed = true;
						}}
					>
						← {$_('onboarding.confirm.show_again')}
					</BusyButton>
					<BusyButton
						variant="primary"
						busy={quizSubmitting}
						disabled={quizSubmitting}
						busyLabel={$_('onboarding.confirm.finish_pending')}
						onclick={submitQuiz}
					>
						{$_('onboarding.confirm.finish')}
					</BusyButton>
				</div>
			</div>
		</section>
	{/if}
</div>

{#if pendingLeaveUrl !== null}
	{#await loadConfirmModal() then ConfirmModal}
		<ConfirmModal
			bind:open={leaveConfirmOpen}
			title={$_('onboarding.leave_confirm.title') as string}
			body={$_('onboarding.leave_confirm.body') as string}
			confirmLabel={$_('onboarding.leave_confirm.yes') as string}
			cancelLabel={$_('onboarding.leave_confirm.stay') as string}
			variant="destructive"
			onConfirm={onConfirmLeave}
			onCancel={onCancelLeave}
		/>
	{/await}
{/if}

{#if pendingRestartFromReview}
	{#await loadConfirmModal() then ConfirmModal}
		<ConfirmModal
			open={true}
			title={$_('onboarding.review.back_confirm.title') as string}
			body={$_('onboarding.review.back_confirm.body') as string}
			confirmLabel={$_('onboarding.review.back_confirm.confirm') as string}
			cancelLabel={$_('onboarding.review.back_confirm.cancel') as string}
			variant="destructive"
			onConfirm={confirmRestartFromReview}
			onCancel={cancelRestartFromReview}
		/>
	{/await}
{/if}
