<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { currentLocale } from '$i18n';
	/**
	 * Morphit — final onboarding step: claim a Blurt account name.
	 *
	 * By the time a user reaches this route they have:
	 *   - Generated a FullIdentity (12-word seed + 4 keypairs)
	 *   - Backed up their seed phrase and confirmed it in the quiz
	 *   - Set a keystore password
	 *   - Booted their LiveIdentity into the session store
	 *
	 * What this route does:
	 *   - Asks them to pick a Blurt account name
	 *   - Checks availability live against the relay
	 *   - Asks the relay to broadcast the account_create op to Blurt,
	 *     paying the chain's account_creation_fee inline from the
	 *     relay's liquid BLURT (Blurt disabled the Account-Creation-
	 *     Token model at HF2 — see ADR-0010 §4 and docs/OPERATIONS.md
	 *     §2).
	 *   - Records the chosen name locally and routes on
	 *
	 * What this route NEVER does:
	 *   - Transmit any private key, ever
	 *   - Store the name remotely (name → pubkey mapping lives on the
	 *     chain itself after registration)
	 *   - Block a user who wants to explore without registering
	 *
	 * The user may also skip and register later via Settings. In that
	 * case the orderbook is read-only for them until they register.
	 */

	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { fetchWithTimeout } from '$net/fetchWithTimeout';
	import { beforeNavigate, goto } from '$app/navigation';
	import { gotoLocale } from '$i18n/navigate';

	import Head from '$components/Head.svelte';
	import SignupProgress from '$components/SignupProgress.svelte';
	import Tooltip from '$components/Tooltip.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	// cp376 byte-budget: ConfirmModal is the leave-guard modal — it only
	// renders if the user tries to navigate away with an unclaimed name
	// (an edge interaction, not part of the Step 1/Step 2 flow), so its
	// JS is deferred out of the initial register-name bundle and loaded
	// only when the guard actually fires (loader defined below).  Same
	// pattern as onboarding/.
	// import ConfirmModal from '$components/ConfirmModal.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import FocusedField from '$components/FocusedField.svelte';
	import { identiconDataUri, identiconDataUriFromString } from '$crypto/identicon';
	import { formatPublicKeyBLT } from '$crypto/keygen';
	import { impersonatesReservedName } from '$crypto/confusables';
	import { liveIdentity, isPairedReadOnly } from '$stores/identity';
	import { setUserBlurtAccount } from '$blurt/ops/profile';
	import { MORPHIT_RELAY_ORIGIN, resolveOrigin } from '$net/config';
	import { splitOnPlaceholder } from '$lib/utils/splitOnPlaceholder';
	import {
		fetchInvite,
		createAccount,
		type SignupPhase,
		type SignupError
	} from '$lib/auth/signupClient';

	// cp376: lazy-loader for the leave-guard ConfirmModal (see import
	// block note).  Gated in the template behind {#if leaveGuard.open}
	// so the dynamic import fires only when the guard actually triggers.
	const loadConfirmModal = () =>
		import('$components/ConfirmModal.svelte').then((m) => m.default);

	// ─── Session identity ────────────────────────────────────────────
	// liveIdentity is a Readable<LiveIdentity | null>. The onboarding-
	// previous-step booted the store; if a user reaches this route
	// directly (e.g. deep-link), the store is null and we bounce them
	// back to the start.
	const live = $derived($liveIdentity);

	onMount(() => {
		// Paired-readonly sessions arrive here only via deep-link (the
		// onboarding flow itself never routes paired users to register-
		// name — they already have an account on chain).  Send them to
		// the orderbook where the paired-readonly experience makes
		// sense.  ADR-0022 Option A: posting key lives on the phone,
		// so a register-name op (account_create_with_delegation, signs
		// with the parent's posting/active key) is not something the
		// paired desktop can do anyway.
		if ($isPairedReadOnly) {
			gotoLocale('/orderbook');
			return;
		}
		if (!live) {
			gotoLocale('/onboarding');
		}
	});

	// ─── State ───────────────────────────────────────────────────────

	type AvailabilityState =
		| { kind: 'idle' }
		| { kind: 'checking' }
		| { kind: 'available' }
		| { kind: 'taken'; reason: string }
		| { kind: 'rejected'; reason: string }
		| { kind: 'unreachable' };

	type SubmitState =
		| { kind: 'ready' }
		| { kind: 'submitting'; phase: SignupPhase }
		| { kind: 'done'; blockNum: number; trxId: string }
		| {
				kind: 'error';
				code: string;
				messageKey: string;
				/** Arguments to interpolate into the i18n message (e.g.
				 *  retry_after_minutes for the spacing_cooldown message). */
				messageArgs?: Record<string, string | number | boolean | Date | null | undefined>;
		  };

	let name = $state('');
	let availability = $state<AvailabilityState>({ kind: 'idle' });
	let submit = $state<SubmitState>({ kind: 'ready' });

	/** Debounce handle for the availability check. */
	let checkTimer: ReturnType<typeof setTimeout> | null = null;

	/** Derived: the normalized lowercased+trimmed name the relay will see. */
	const normalizedName = $derived(name.trim().toLowerCase());

	/** Derived: whether the submit button is actionable right now. */
	const canSubmit = $derived(
		submit.kind === 'ready' && availability.kind === 'available' && normalizedName.length >= 3
	);

	/** Derived: the typed name is invalid — either already taken or
	 *  rejected by the relay (bad format / reserved handle). Drives the
	 *  red field border + the in-field "invalid" badge. */
	const nameInvalid = $derived(availability.kind === 'taken' || availability.kind === 'rejected');

	/** Derived: whether the claim button previews the typed name
	 *  ("Claim my @{name} username now") vs the generic fallback
	 *  ("Claim this name"). Real-time — true as soon as the name is long
	 *  enough and not a hard-rejected reserved handle, so the @name shows
	 *  WHILE availability is still being checked, not only after the relay
	 *  round-trip resolves to 'available'. The button stays disabled until
	 *  canSubmit, so previewing the name on a not-yet-confirmed name is
	 *  safe — it reflects intent, never enables a premature claim. */
	const showNamedClaim = $derived(
		normalizedName.length >= 3 && availability.kind !== 'rejected'
	);

	// ─── Availability polling ────────────────────────────────────────

	async function checkAvailability(candidate: string): Promise<void> {
		if (candidate.length < 3) {
			availability = { kind: 'idle' };
			return;
		}
		// Client-side veto: block names that visually impersonate a
		// reserved operator handle (morphit, agorise, kencode et al).
		// Checked before the network call so the user gets immediate
		// feedback and we don't waste a round-trip on a name we'd
		// refuse to submit anyway. This is a best-effort check — the
		// Blurt chain itself is open, so a user could register an
		// impersonation via a different client, bypassing us. We
		// can't retroactively block already-registered accounts. The
		// display_name impersonation check (in profile.ts +
		// indexer/handlers/profile.ts) is authoritative because that
		// field flows through our custom_json op.
		if (impersonatesReservedName(candidate)) {
			availability = { kind: 'rejected', reason: 'reserved' };
			return;
		}
		availability = { kind: 'checking' };
		try {
			const res = await fetchWithTimeout(`${resolveOrigin(MORPHIT_RELAY_ORIGIN)}/v1/account/availability`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: candidate })
			});
			if (res.status === 429) {
				availability = { kind: 'rejected', reason: 'rate_limited' };
				return;
			}
			if (!res.ok) {
				availability = { kind: 'unreachable' };
				return;
			}
			const body = (await res.json()) as {
				available: boolean;
				reason?: string;
			};
			// Guard against a late response: if the user has since edited
			// the name, ignore this result.
			if (candidate !== normalizedName) return;
			if (body.available) {
				availability = { kind: 'available' };
			} else if (body.reason === 'already_registered') {
				availability = { kind: 'taken', reason: body.reason };
			} else {
				availability = { kind: 'rejected', reason: body.reason ?? 'unknown' };
			}
		} catch {
			availability = { kind: 'unreachable' };
		}
	}

	$effect(() => {
		// Rerun on every keystroke. Debounce by 350ms so we don't hammer
		// the relay while the user is typing.
		const candidate = normalizedName;
		if (checkTimer !== null) clearTimeout(checkTimer);
		if (candidate.length < 3) {
			availability = { kind: 'idle' };
			return;
		}
		availability = { kind: 'checking' };
		checkTimer = setTimeout(() => {
			checkAvailability(candidate);
		}, 350);
		// Cleanup: if the effect re-runs OR the component unmounts
		// mid-debounce, clear the pending timer so we don't fire a
		// query against a superseded name.
		return () => {
			if (checkTimer !== null) {
				clearTimeout(checkTimer);
				checkTimer = null;
			}
		};
	});

	// ─── Registration submit ─────────────────────────────────────────

	async function submitRegistration(): Promise<void> {
		if (!live) {
			gotoLocale('/onboarding');
			return;
		}
		// Posting-only sessions (Batch H) genuinely lack owner/active/memo
		// public keys.  Registering a new on-chain account requires all
		// four; a posting-only user already HAS an account, so this page
		// shouldn't be reachable for them.  If they URL-jumped here
		// anyway, send them home with a polite no-op rather than letting
		// formatPublicKeyBLT crash on null.
		if (live.origin === 'posting-only') {
			gotoLocale('/');
			return;
		}
		if (!canSubmit) return;

		submit = { kind: 'submitting', phase: 'fetching_invite' };

		// Format the four public keys into BLT-prefixed strings. The
		// relay validates these exact strings; any mismatch gets mapped
		// to invalid_pubkey server-side.
		let ownerBLT: string;
		let activeBLT: string;
		let postingBLT: string;
		let memoBLT: string;
		try {
			// At this point origin === 'morphit-seed', so all four slots
			// are guaranteed populated.  The non-null assertions below
			// are safe under that invariant.
			ownerBLT = await formatPublicKeyBLT(live.ownerPublicKey!);
			activeBLT = await formatPublicKeyBLT(live.activePublicKey!);
			postingBLT = await formatPublicKeyBLT(live.posting.publicKey);
			memoBLT = await formatPublicKeyBLT(live.memo!.publicKey);
		} catch (err) {
			// Key-formatting failure means our keygen produced something
			// malformed — should never happen, but fail loudly rather
			// than send garbage to the relay.
			submit = {
				kind: 'error',
				code: 'local_key_error',
				messageKey: 'onboarding.register_name.errors.local_key_error'
			};
			return;
		}

		// Progress hook — the two-step client updates the UI
		// through this callback. The Altcha solver phase triggers
		// the "Verifying you're human…" label.
		const onProgress = (phase: SignupPhase): void => {
			if (submit.kind === 'submitting') {
				submit = { kind: 'submitting', phase };
			}
		};

		try {
			// Step 1: invite. Handles altcha lazy-load transparently.
			const invite_token = await fetchInvite(onProgress);

			// Step 2: create. Passes the invite + op to the relay.
			const result = await createAccount({
				invite_token,
				op: {
					new_account_name: normalizedName,
					owner: {
						weight_threshold: 1,
						account_auths: [],
						key_auths: [[ownerBLT, 1]]
					},
					active: {
						weight_threshold: 1,
						account_auths: [],
						key_auths: [[activeBLT, 1]]
					},
					posting: {
						weight_threshold: 1,
						account_auths: [],
						key_auths: [[postingBLT, 1]]
					},
					memo_key: memoBLT,
					json_metadata: ''
				},
				onProgress
			});

			setUserBlurtAccount(normalizedName);
			submit = {
				kind: 'done',
				blockNum: result.blockNum,
				trxId: result.trxId
			};
			// Give the user a moment to see the success state before
			// we route them on. 3s per UX-STANDARD rule #7 — grandma
			// needs time to register the win.
			setTimeout(() => gotoLocale('/orderbook'), 3000);
		} catch (err) {
			const signupErr = err as SignupError;
			const messageKey = mapErrorCode(signupErr.code);

			// Rename wire fields into the short names the i18n strings
			// use. Relay → client wire uses `retry_after_minutes`;
			// the spacing_cooldown translation interpolates `{minutes}`.
			const args: Record<string, string | number | boolean | Date | null | undefined> = {};
			if (signupErr.details && typeof signupErr.details.retry_after_minutes === 'number') {
				args.minutes = signupErr.details.retry_after_minutes;
			}

			submit = {
				kind: 'error',
				code: signupErr.code,
				messageKey,
				messageArgs: args
			};
		}
	}

	/** Maps the current signup phase to the localized busy-button
	 *  label. Phases come from the two-step signup client:
	 *   - fetching_invite: calling /v1/account/invite (fast)
	 *   - solving_altcha:  Web Worker running PoW (~1s)
	 *   - altcha_solved:   flash state before re-fetching invite
	 *   - broadcasting:    chain broadcast in progress */
	function busyLabelFor(phase: SignupPhase): string {
		switch (phase) {
			case 'solving_altcha':
				return $_('onboarding.register_name.altcha.verifying');
			case 'altcha_solved':
				return $_('onboarding.register_name.altcha.verified');
			case 'broadcasting':
				return $_('onboarding.register_name.submit_pending');
			case 'fetching_invite':
			default:
				return $_('onboarding.register_name.submit_pending');
		}
	}

	function mapErrorCode(code: string): string {
		switch (code) {
			case 'already_registered':
				// Fall through to availability state; user can rename.
				availability = { kind: 'taken', reason: 'already_registered' };
				return 'onboarding.register_name.errors.already_registered';
			case 'name_not_allowed':
				return 'onboarding.register_name.errors.name_not_allowed';
			case 'name_high_value':
				return 'onboarding.register_name.errors.name_high_value';
			case 'name_sequential_pattern':
				return 'onboarding.register_name.errors.name_sequential_pattern';
			case 'invalid_pubkey':
				return 'onboarding.register_name.errors.invalid_pubkey';
			case 'rate_limited':
			case 'invite_rate_limited':
				return 'onboarding.register_name.errors.rate_limited';
			case 'rate_limited_daily':
				return 'onboarding.register_name.errors.rate_limited_daily';
			case 'spacing_cooldown':
				// Uses {minutes} interpolation from messageArgs.
				return 'onboarding.register_name.errors.spacing_cooldown';
			case 'signups_disabled':
				return 'onboarding.register_name.errors.signups_disabled';
			case 'daily_ceiling_reached':
				return 'onboarding.register_name.errors.daily_ceiling_reached';
			case 'relay_out_of_funds':
				return 'onboarding.register_name.errors.relay_out_of_funds';
			case 'chain_unavailable':
				return 'onboarding.register_name.errors.chain_unavailable';
			case 'duplicate_submission':
				return 'onboarding.register_name.errors.duplicate_submission';
			// Invite-token failures — all surface the same user-facing
			// message: "your signup token expired, please try again."
			// The relay's differentiated codes help operators debug
			// server-side; users just need to know "retry and it'll work."
			case 'invite_required':
			case 'invite_malformed':
			case 'invite_bad_signature':
			case 'invite_expired':
			case 'invite_ip_mismatch':
			case 'invite_already_used':
				return 'onboarding.register_name.errors.invite_problem';
			// Altcha failures — similarly folded to one user message.
			case 'altcha_bad_solution':
			case 'altcha_bad_signature':
			case 'altcha_expired':
			case 'altcha_malformed':
			case 'altcha_replayed':
			case 'altcha_unsolvable':
				return 'onboarding.register_name.errors.altcha_problem';
			case 'unreachable':
				return 'onboarding.register_name.errors.unreachable';
			case 'broadcast_failed':
			default:
				return 'onboarding.register_name.errors.broadcast_failed';
		}
	}

	// ─── Skip for now ────────────────────────────────────────────────

	function skipForNow(): void {
		// The user keeps their generated identity and enters a read-only
		// exploration mode. The orderbook (and any write action — post,
		// place order, leave feedback) shows a register prompt, so this is
		// where they finish signup later. (cp308 F-004: Settings has no
		// account-CREATION path — only on-chain name verification for
		// imported accounts — so the register nudge lives on the trade
		// surfaces, NOT in Settings.)
		allowLeave = true; // explicit choice to leave — skip the soft guard
		gotoLocale('/orderbook');
	}

	// ─── Voucher-path link splitter ──────────────────────────────────
	// The shared helper $lib/utils/splitOnPlaceholder is imported at
	// the top of this file; nothing local needed.

	// ─── Navigation guard ────────────────────────────────────────────
	// Two layers: (1) HARD-block while a broadcast is in flight — leaving
	// mid-create would orphan the op. (2) SOFT-confirm a typed-but-not-yet-
	// registered name — pop a modal so the user doesn't silently lose the
	// name they were about to claim by clicking a nav link. The explicit
	// "Skip for now" path and the post-success redirect set `allowLeave`
	// so they bypass the soft guard.

	let allowLeave = $state(false);
	let leaveGuard = $state<{ open: boolean; to: URL | null }>({ open: false, to: null });

	beforeNavigate((nav) => {
		if (submit.kind === 'submitting') {
			// Mid-broadcast — don't let them navigate away before the
			// chain has confirmed either way.
			nav.cancel();
			return;
		}
		// Registered, skipped, or already confirmed in the modal → let go.
		if (allowLeave || submit.kind === 'done') return;
		// Nothing typed yet → nothing to lose, no need to nag.
		if (name.trim().length === 0) return;
		// Already deciding (modal open) → don't stack cancels.
		if (leaveGuard.open) return;
		// Typed-but-unregistered: block this navigation and ask. We stash
		// the intended destination and resume it via goto() on confirm.
		nav.cancel();
		leaveGuard = { open: true, to: nav.to?.url ?? null };
	});

	/** Modal "Leave anyway" → resume the navigation we cancelled. */
	function confirmLeave(): void {
		allowLeave = true;
		const dest = leaveGuard.to;
		leaveGuard = { open: false, to: null };
		// dest is null for tab-close / external 'leave' navigations, which
		// can't be programmatically resumed anyway; internal links carry a
		// concrete URL we can re-navigate to (allowLeave now lets it pass).
		if (dest) void goto(dest);
	}

	/** Modal "Stay" / Escape / backdrop → keep them on the page. */
	function cancelLeave(): void {
		leaveGuard = { open: false, to: null };
	}

	// ─── Derived avatar ──────────────────────────────────────────────
	// Seed the preview from the chosen account NAME so it matches the
	// avatar the user will actually have everywhere AFTER registration —
	// the AvatarMenu, their /@profile hero, and IdentityLabel all seed
	// from the account name (a brand-new account stores empty
	// json_metadata, so the profile hero falls back to the same
	// name-seeded identicon). Before a valid name is typed (< 3 chars,
	// the registration minimum) we fall back to the posting pubkey so the
	// preview isn't blank. (cp323 — previously this always seeded from the
	// pubkey, so the preview didn't match the post-registration avatar.)
	const avatarUri = $derived(
		normalizedName.length >= 3
			? identiconDataUriFromString(normalizedName, 96)
			: live
				? identiconDataUri(live.posting.publicKey, 96)
				: ''
	);

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	// Active-locale STORE (not $page.data.lang) so an in-place language swap
	// on the onboarding routes re-prefixes links without a remount. SSR-safe
	// (layout load sets the locale before render).
	const currentLang = $derived($currentLocale);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="register_name" />

<div class="container mx-auto max-w-2xl px-4 py-10">
	{#if !live}
		<section class="card text-center" aria-live="polite">
			<p class="text-lg">{$_('onboarding.register_name.redirecting')}</p>
		</section>
	{:else if submit.kind === 'done'}
		<!-- Success state — briefly shown before we redirect. -->
		<section class="card animate-fade-up text-center" aria-live="polite">
			<img src={avatarUri} alt="" class="mx-auto mb-4 h-24 w-24 rounded-2xl" loading="lazy" decoding="async" />
			<h2 class="font-display text-2xl font-bold">
				{$_('onboarding.register_name.success.title')}
			</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('onboarding.register_name.success.body', { values: { name: normalizedName } })}
			</p>
			<p class="mt-4 text-sm text-ink-500">
				{$_('onboarding.register_name.success.redirecting')}
			</p>
		</section>
	{:else}
		<SignupProgress current={4} total={4} />
		<section class="animate-fade-up" aria-labelledby="register-heading">
			<div class="card">
				<div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
					<img src={avatarUri} alt="" class="h-24 w-24 flex-none rounded-2xl" loading="lazy" decoding="async" />
					<div class="flex-1 text-center sm:text-left">
						<h1 id="register-heading" class="font-display text-2xl font-bold">
							{$_('onboarding.register_name.title')}
						</h1>
						<p class="mt-2 text-ink-700 dark:text-ink-200">
							{$_('onboarding.register_name.subtitle')}
						</p>
					</div>
				</div>
			</div>

			<!-- Name field + availability state -->
			<div class="card mt-6">
				<label for="blurt-name" class="flex items-center gap-2 font-display text-lg font-bold">
					{$_('onboarding.register_name.field_label')}
					<Tooltip textKey="onboarding.register_name.field_hint" faqKey="signup_requirements" />
				</label>
				<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
					{$_('onboarding.register_name.field_hint')}
				</p>

				<div class="mt-4">
					<div class="relative">
						<FocusedField
							focused={submit.kind !== 'submitting' && availability.kind !== 'available'}
							valid={availability.kind === 'available'}
							invalid={nameInvalid}
						>
							<input
								id="blurt-name"
								type="text"
								bind:value={name}
								maxlength="16"
								autocomplete="off"
								autocorrect="off"
								autocapitalize="none"
								spellcheck="false"
								class="w-full rounded-2xl bg-transparent px-4 py-3 font-mono text-base text-ink-900 outline-none placeholder:text-ink-400 disabled:opacity-60 dark:text-ink-50 {nameInvalid
									? 'pe-24'
									: ''}"
								placeholder={$_('onboarding.register_name.field_placeholder')}
								aria-describedby="availability-msg"
								aria-invalid={nameInvalid}
								disabled={submit.kind === 'submitting'}
							/>
						</FocusedField>
						{#if nameInvalid}
							<!-- In-field invalid badge, right-aligned (RTL-safe via
							     logical end-*/pe-*). Decorative: the StatusLine below
							     carries the screen-reader message, and aria-invalid on
							     the input conveys the state to assistive tech. -->
							<div
								class="pointer-events-none absolute inset-y-0 end-4 flex items-center gap-1.5 text-red-600 dark:text-red-400"
								aria-hidden="true"
							>
								<span>⚠</span>
								<span class="text-xs font-semibold uppercase tracking-wide"
									>{$_('onboarding.import.posting_only.account_bad')}</span
								>
							</div>
						{/if}
					</div>

					{#if availability.kind === 'idle'}
						<StatusLine kind="idle" id="availability-msg" />
					{:else if availability.kind === 'checking'}
						<StatusLine kind="loading" id="availability-msg">
							{$_('onboarding.register_name.availability.checking')}
						</StatusLine>
					{:else if availability.kind === 'available'}
						<StatusLine kind="ok" id="availability-msg">
							{$_('onboarding.register_name.availability.available', {
								values: { name: normalizedName }
							})}
						</StatusLine>
					{:else if availability.kind === 'taken'}
						<StatusLine kind="warn" id="availability-msg">
							{$_('onboarding.register_name.availability.taken')}
						</StatusLine>
					{:else if availability.kind === 'rejected'}
						<StatusLine kind="warn" id="availability-msg">
							{$_(`onboarding.register_name.availability.reasons.${availability.reason}`, {
								default: $_('onboarding.register_name.availability.rejected_generic')
							})}
						</StatusLine>
					{:else if availability.kind === 'unreachable'}
						<StatusLine kind="warn" id="availability-msg">
							{$_('onboarding.register_name.availability.unreachable')}
						</StatusLine>
					{/if}
				</div>
			</div>

			<!-- Cost / fee transparency. -->
			<div class="card mt-6">
				<h3 class="flex items-center gap-2 font-display text-lg font-bold">
					{$_('onboarding.register_name.fee.title')}
					<Tooltip textKey="onboarding.register_name.fee.hint" />
				</h3>
				<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
					{$_('onboarding.register_name.fee.body')}
				</p>
			</div>

			<!-- Submit / skip -->
			{#if submit.kind === 'error'}
				<div
					class="card mt-6 border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950"
					role="alert"
					aria-live="assertive"
				>
					<p class="font-semibold text-amber-900 dark:text-amber-100">
						{$_(submit.messageKey, { values: submit.messageArgs ?? {} })}
					</p>
					<p class="mt-2 text-sm text-amber-800 dark:text-amber-200">
						<a href={lp('/faq#signup_stuck')} class="underline hover:no-underline">
							{$_('common.learn_more')}
						</a>
					</p>
				</div>

				<!-- Voucher fast-path.  Only when the relay's daily
				     ceiling is the reason — for other errors this
				     route is irrelevant.  We deliberately render
				     this as a separate card (not inside the amber
				     warning) so it reads as constructive next-step
				     advice rather than as part of the error.
				     The matrix-open/matrix-close and plugin-open/
				     plugin-close placeholders in each step's i18n
				     string mark where the link text lives;
				     splitOnPlaceholder() pulls out
				     [before, linkText, after] so translators can
				     freely reorder the surrounding sentence. -->
				{#if submit.code === 'daily_ceiling_reached'}
					{@const step1 = splitOnPlaceholder(
						$_('onboarding.register_name.errors.daily_ceiling_voucher_step_1') as string,
						'{matrix_open}',
						'{matrix_close}'
					)}
					{@const step2 = splitOnPlaceholder(
						$_('onboarding.register_name.errors.daily_ceiling_voucher_step_2') as string,
						'{plugin_open}',
						'{plugin_close}'
					)}
					<div
						class="card mt-4 border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950"
					>
						<h3 class="font-display text-base font-bold text-emerald-900 dark:text-emerald-100">
							{$_('onboarding.register_name.errors.daily_ceiling_voucher_heading')}
						</h3>
						<p class="mt-2 text-sm text-emerald-900 dark:text-emerald-100">
							{$_('onboarding.register_name.errors.daily_ceiling_voucher_intro')}
						</p>
						<ol
							class="mt-3 list-decimal space-y-2 pl-5 text-sm text-emerald-900 dark:text-emerald-100"
						>
							<li>
								{step1[0]}<a
									href="https://matrix.to/#/#agorise:matrix.org"
									target="_blank"
									rel="noopener noreferrer"
									class="font-mono underline hover:no-underline"
									>{step1[1] || '#agorise:matrix.org'}</a
								>{step1[2]}
							</li>
							<li>
								{step2[0]}<a
									href="https://blurtplugin.online/account"
									target="_blank"
									rel="noopener noreferrer"
									class="underline hover:no-underline">{step2[1] || 'blurtplugin.online/account'}</a
								>{step2[2]}
							</li>
							<li>
								{$_('onboarding.register_name.errors.daily_ceiling_voucher_step_3')}
							</li>
						</ol>
						<!-- Sally finding H3 follow-up (Part 69):
						     blurtplugin.online is a third-party
						     Blurt-community service, not run by
						     Morphit.  Surface the trust boundary
						     honestly so a user understands they're
						     leaving Morphit, AND provide a plain-
						     text URL fallback so the user has
						     recovery if the link target is dead or
						     they need to type it on another device. -->
						<p
							class="mt-4 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
						>
							⚠ {$_('onboarding.register_name.errors.daily_ceiling_voucher_external_warning')}
							<span class="mt-1 block select-all font-mono">https://blurtplugin.online/account</span
							>
						</p>
					</div>
				{/if}
			{/if}

			<div class="mt-6 flex flex-col gap-3 sm:flex-row-reverse sm:justify-between">
				<BusyButton
					variant="primary"
					busy={submit.kind === 'submitting'}
					disabled={!canSubmit}
					onclick={submitRegistration}
					busyLabel={submit.kind === 'submitting'
						? busyLabelFor(submit.phase)
						: $_('onboarding.register_name.submit_pending')}
				>
					{#if showNamedClaim}
						{$_('onboarding.register_name.submit_named', {
							values: { name: normalizedName }
						})}
					{:else}
						{$_('onboarding.register_name.submit')}
					{/if}
				</BusyButton>
				<BusyButton variant="ghost" disabled={submit.kind === 'submitting'} onclick={skipForNow}>
					{$_('onboarding.register_name.skip')}
				</BusyButton>
			</div>

			<!-- Cross-link for import users who landed here from the
			     accountless banner but already HAVE a Blurt account: this
			     page only CLAIMS a new name (typing an existing one hits
			     "already registered"), so point them at the Settings
			     account-name card, which VERIFIES an existing name against
			     their imported key. -->
			<p class="mt-4 text-center text-sm text-ink-600 dark:text-ink-300">
				<a
					href={lp('/settings#account-name-heading')}
					class="underline underline-offset-2 hover:no-underline"
				>
					{$_('onboarding.register_name.have_account_link')}
				</a>
			</p>

			<!-- Identity recap. Unobtrusive; just a reassurance that the
			     keys about to be broadcast match the identity they just
			     backed up. -->
			<div class="mt-6 text-center">
				<p class="mb-1 text-xs font-semibold uppercase tracking-widest text-ink-500">
					{$_('onboarding.register_name.identity_recap')}
				</p>
				<IdentityLabel publicKey={live.posting.publicKey} weight="bold" />
			</div>
		</section>
	{/if}
</div>

<!-- Leave-guard: pops when the user tries to navigate away with a typed-
     but-unregistered name (see beforeNavigate above). Neutral variant —
     leaving isn't destructive (keys are kept; they can finish later), it's
     just a "wait, you didn't claim it yet" nudge. Focus defaults to the
     safe "Stay" button. -->
{#if leaveGuard.open}
	{#await loadConfirmModal() then ConfirmModal}
		<ConfirmModal
			bind:open={leaveGuard.open}
			variant="neutral"
			title={$_('onboarding.register_name.leave_guard.title')}
			body={$_('onboarding.register_name.leave_guard.body')}
			confirmLabel={$_('onboarding.register_name.leave_guard.confirm')}
			cancelLabel={$_('onboarding.register_name.leave_guard.cancel')}
			onConfirm={confirmLeave}
			onCancel={cancelLeave}
		/>
	{/await}
{/if}
