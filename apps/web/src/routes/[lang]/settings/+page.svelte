<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import { installPrompt, isInstalled, promptInstall } from '$lib/pwa/installPrompt';
	import { validateDisplayName, DISPLAY_NAME_MAX_LENGTH } from '$crypto/profile';
	import { validateNostrUrl } from '$utils/nostrUrl';
	import { validateBlurtMediaUrl } from '$utils/blurtMediaUrl';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import EndpointList from '$components/EndpointList.svelte';
	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte';
	import NotificationSettings from '$components/NotificationSettings.svelte';
	// cp165 byte-budget: HardwareKeyCard is lazy-imported below.
	// It's only rendered for unlocked users with a persisted
	// keystore (excludes paired-readonly + seed-only + locked
	// visitors) and pulls webhid + yubikey transport code (~22 KB
	// of component source plus transitive helpers).  Lazy import
	// keeps it out of the eager-load chunk for the majority of
	// visitors who'll never trigger the condition.
	// import HardwareKeyCard from '$components/HardwareKeyCard.svelte';
	import { autoLockTimeoutMinutes, writeTimeoutMinutes, NEVER_LOCK } from '$stores/autoLock';
	import { userPreferences, clearPreferences } from '$stores/userPreferences';
	import { hasPersistedKeystore } from '$crypto/persistentKeystore';
	import { changePassword } from '$crypto/changePassword';
	import { scorePassword, isPasswordAcceptable } from '$lib/auth/passwordStrength';
	import { hiddenAccounts, unhideAccount, clearAllHidden } from '$lib/utils/hiddenAccounts';
	import { firstTradeAnnounce, setFirstTradeAnnounce } from '$lib/utils/syndicationPrefs';
	import {
		liveIdentity,
		isUnlocked,
		isPairedReadOnly
	} from '$stores/identity';
	import { getProfile } from '$lib/indexer/client';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import {
		broadcastProfile,
		BroadcastError,
		getUserBlurtAccount,
		setUserBlurtAccount
	} from '$blurt/ops/profile';
	import { formatPublicKeyBLT } from '$crypto/keygen';
	import { verifyPostingKey } from '$crypto/postingVerify';
	import { fetchAccountKeys } from '$blurt/accountKeys';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import { broadcastUnblock } from '$blurt/ops/block';
	import { blockedAccounts, loadBlocks, refreshBlocks, markUnblocked } from '$lib/chat/blocks';
	import { showToast } from '$lib/stores/toast';
	import { gotoLocale } from '$i18n/navigate';

	const STORAGE_KEY = 'morphit.displayName';
	const NOSTR_URL_STORAGE_KEY = 'morphit.nostrUrl';
	const BLURT_MEDIA_URL_STORAGE_KEY = 'morphit.blurtMediaUrl';

	// Fallback public key used only when the session is locked, for the
	// preview swatch.
	const DEMO_PUBKEY = new Uint8Array([
		0x8e, 0xef, 0x26, 0x00, 0xda, 0x69, 0x02, 0xa6, 0xb2, 0x7f, 0xed, 0x2d, 0x01, 0x23, 0x45, 0x67,
		0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10, 0x11, 0x22, 0x33, 0x44
	]);

	let input = $state('');
	let saved = $state('');
	let saving = $state(false);

	// cp165 byte-budget: lazy-load HardwareKeyCard.  The
	// `HardwareKeyCardPromise` starts null and gets populated on
	// first render of the gated card (see {#await} block below).
	// Once the import resolves, Svelte's {#await} replaces the
	// loading state with the actual component.  For visitors who
	// never satisfy the gate ($isUnlocked && hasPersistedKeystore),
	// the import never fires — the chunk is never downloaded.
	const loadHardwareKeyCard = () =>
		import('$components/HardwareKeyCard.svelte').then((m) => m.default);
	let savedToast = $state(false);
	let broadcasting = $state(false);
	let broadcastError = $state('');
	let broadcastOk = $state(false);
	/** True when the user has tapped Clear and we're waiting for them
	 *  to confirm. Per UX-STANDARD rule #5 — destructive actions get
	 *  one (and only one) confirmation. */
	let confirmingClear = $state(false);

	/** Tier 3.2 (Part 99) — same pattern as confirmingClear, but
	 *  scoped to clearing the user's stored fiat / region
	 *  preferences in the new "Preferences" settings section.
	 *  Two-step confirm so a misclick doesn't silently wipe the
	 *  values the user has built up over multiple successful
	 *  posts. */
	let confirmingClearPrefs = $state(false);

	// ── Account name (closes C-24) ──────────────────────────────────
	// The seed-import and keyfile-import flows don't ask for the
	// account name (a Blurt seed/keyfile carries keys, not the
	// account name).  Without an account name set, 70+ surfaces
	// (chat, post creation, my-orders, profile broadcast, banners)
	// silently fail to recognize the user.  This section lets a
	// seed-imported user supply their account name + verifies the
	// match against on-chain posting.key_auths before saving.
	//
	// Posting-WIF imports already set this at import time, so the
	// section appears as already-set for those users (read-only
	// display).  Only seed/keyfile users will see the empty input.
	let accountInput = $state('');
	let accountSaved = $state<string | null>(null);
	let accountVerifying = $state(false);
	let accountVerifyError = $state('');
	let accountSavedToast = $state(false);
	/** Sally finding H2 (Part 68): true when the user just landed
	 *  here from a seed/keyfile import, which doesn't carry an
	 *  account name.  Triggers an explanatory banner above the
	 *  account-name section so the user knows why they're here.
	 *  Cleared the moment the section is rendered (one-shot). */
	let needsAccountNameBanner = $state(false);

	// ── Blurt.media URL — same shape as nostr_url state ─────────────
	// Rendered BEFORE the Nostr section per UX directive: Blurt is
	// the native platform for Morphit, and most users will have a
	// Blurt.media profile before they ever look at Nostr.
	let blurtMediaInput = $state('');
	let blurtMediaSaved = $state('');
	let blurtMediaSaving = $state(false);
	let blurtMediaSavedToast = $state(false);
	let blurtMediaBroadcasting = $state(false);
	let blurtMediaBroadcastError = $state('');
	let blurtMediaBroadcastOk = $state(false);

	// ── Nostr URL — same shape as display_name state ────────────────
	// The form stores the URL locally for pre-population across
	// sessions; the same value is included in the profile broadcast
	// so it lands on-chain and surfaces next to every username render
	// via IdentityLabel.
	let nostrInput = $state('');
	let nostrSaved = $state('');
	let nostrSaving = $state(false);
	let nostrSavedToast = $state(false);
	let nostrBroadcasting = $state(false);
	let nostrBroadcastError = $state('');
	let nostrBroadcastOk = $state(false);

	// ── Custom avatar — sanitized SVG text OR base64 WebP data URI ─
	// Unlike the other profile fields, we do NOT persist a draft in
	// localStorage: the source file is in session (user just picked
	// it), and a stale data URI taking up localStorage space across
	// reboots isn't worth it. On reload the user re-uploads.
	// Staged but not yet broadcast: the user has picked + processed
	// a file successfully. Broadcast turns this into the on-chain
	// value. Clearing either Resets both states to empty.
	let avatarStagedSvg = $state('');
	let avatarStagedDataUri = $state('');
	/** Byte size of the staged payload. Drives the "getting large"
	 *  soft-warning hint. Zero means nothing staged. */
	let avatarStagedBytes = $state(0);
	/** Non-empty while the user is resizing / encoding. Blocks the
	 *  form during the brief (<500ms typical) browser work. */
	let avatarProcessing = $state(false);
	/** User-facing error from the last avatar upload attempt. */
	let avatarError = $state('');
	let avatarBroadcasting = $state(false);
	let avatarBroadcastError = $state('');
	let avatarBroadcastOk = $state(false);
	/** The file-input element ref, so we can reset its value after
	 *  a failed upload (some browsers remember the last selection
	 *  and refuse a repeat of the same file). */
	let avatarFileInput = $state<HTMLInputElement | null>(null);
	/** True when the account currently has a custom avatar broadcast on
	 *  chain. Drives whether the "Remove avatar" button is shown — there's
	 *  no point offering to remove an avatar that was never set. Defaults
	 *  false (button hidden) until a profile fetch confirms one exists, so
	 *  a failed/slow fetch errs toward hiding rather than a no-op button. */
	let hasCustomAvatar = $state(false);
	let avatarExistenceChecked = false;
	// Rehydrate from localStorage on mount.
	$effect(() => {
		if (!browser) return;
		try {
			const s = window.localStorage.getItem(STORAGE_KEY);
			if (s) {
				saved = s;
				input = s;
			}
			const bm = window.localStorage.getItem(BLURT_MEDIA_URL_STORAGE_KEY);
			if (bm) {
				blurtMediaSaved = bm;
				blurtMediaInput = bm;
			}
			const n = window.localStorage.getItem(NOSTR_URL_STORAGE_KEY);
			if (n) {
				nostrSaved = n;
				nostrInput = n;
			}
			// Hydrate the account-name section.  If posting-WIF
			// import was used, this is already set; otherwise
			// it's null and the user sees the empty input.
			const acct = getUserBlurtAccount();
			if (acct) {
				accountSaved = acct;
				accountInput = acct;
				// One-shot, best-effort: find out whether this account already
				// has a custom avatar on chain so we only show "Remove avatar"
				// when there's actually one to remove. Failure leaves the flag
				// false (button stays hidden), which is the safe default.
				if (!avatarExistenceChecked) {
					avatarExistenceChecked = true;
					void (async () => {
						try {
							const r = await getProfile(acct);
							if (r.ok) {
								const props = extractLabelPropsFromProfile(r.data);
								hasCustomAvatar = !!(props.avatarSvg || props.avatarDataUri);
							}
						} catch {
							// Indexer unreachable / no profile — leave hidden.
						}
					})();
				}
			}
			// Sally finding H2 (Part 68): one-shot banner trigger
			// for users redirected here from seed/keyfile import.
			// Read-and-clear: the banner shows once, then disappears
			// forever for this session.  If the import flow couldn't
			// write the flag (private mode), the banner just doesn't
			// appear — the account-name section is still the first
			// card on the page, so the user isn't lost.
			try {
				if (window.sessionStorage.getItem('morphit.import.needs_account_name') === '1') {
					needsAccountNameBanner = true;
					window.sessionStorage.removeItem('morphit.import.needs_account_name');
				}
			} catch {
				// no-op
			}
		} catch {
			// Privacy Mode; fall through.
		}
	});

	const validation = $derived(validateDisplayName(input));
	const remaining = $derived(DISPLAY_NAME_MAX_LENGTH - [...input].length);

	// Blurt.media URL validation. Same contract as Nostr —
	// null = empty/unset, { ok: true } = valid, { ok: false } = error.
	const blurtMediaValidation = $derived(validateBlurtMediaUrl(blurtMediaInput));
	const blurtMediaIsEmpty = $derived(blurtMediaInput.trim().length === 0);
	const blurtMediaIsValid = $derived(
		blurtMediaIsEmpty ||
			(blurtMediaValidation !== null && 'ok' in blurtMediaValidation && blurtMediaValidation.ok)
	);
	const blurtMediaCleaned = $derived(
		blurtMediaValidation && 'ok' in blurtMediaValidation && blurtMediaValidation.ok
			? blurtMediaValidation.cleaned
			: ''
	);
	const blurtMediaErrorReason = $derived(
		blurtMediaValidation && 'ok' in blurtMediaValidation && !blurtMediaValidation.ok
			? blurtMediaValidation.reason
			: null
	);

	// Nostr URL validation. A null result means "empty/unset" —
	// that's fine and becomes "no link." An { ok: false } result
	// is a real error shown next to the input.
	const nostrValidation = $derived(validateNostrUrl(nostrInput));
	const nostrIsEmpty = $derived(nostrInput.trim().length === 0);
	const nostrIsValid = $derived(
		nostrIsEmpty || (nostrValidation !== null && 'ok' in nostrValidation && nostrValidation.ok)
	);
	const nostrCleaned = $derived(
		nostrValidation && 'ok' in nostrValidation && nostrValidation.ok ? nostrValidation.cleaned : ''
	);
	const nostrErrorReason = $derived(
		nostrValidation && 'ok' in nostrValidation && !nostrValidation.ok
			? nostrValidation.reason
			: null
	);

	// Public key shown next to the display name — use the live identity's
	// posting key when unlocked, a demo otherwise.
	const previewPubkey = $derived($liveIdentity ? $liveIdentity.posting.publicKey : DEMO_PUBKEY);

	async function saveLocal(): Promise<void> {
		if (!validation.ok) return;
		saving = true;
		const cleaned = validation.cleaned;
		try {
			window.localStorage.setItem(STORAGE_KEY, cleaned);
		} catch {
			// Privacy Mode; keeps the change in memory only.
		}
		// Visible busy state for at least 250ms so grandma sees the
		// transition. The localStorage write itself is ~free.
		await new Promise((resolve) => setTimeout(resolve, 250));
		saved = cleaned;
		input = cleaned;
		saving = false;
		savedToast = true;
		setTimeout(() => (savedToast = false), 1800);
	}

	// ── Account-name verify + save (closes C-24) ────────────────────
	const BLURT_ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

	async function verifyAndSaveAccountName(): Promise<void> {
		const live = $liveIdentity;
		if (!live) {
			accountVerifyError = $_('settings.account_name.error_locked');
			return;
		}
		const candidate = accountInput.trim().toLowerCase();
		if (!BLURT_ACCOUNT_RE.test(candidate)) {
			accountVerifyError = $_('settings.account_name.error_bad_format');
			return;
		}
		accountVerifying = true;
		accountVerifyError = '';
		try {
			const derivedPub = await formatPublicKeyBLT(live.posting.publicKey);
			const fetched = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), candidate);
			if (!fetched) {
				accountVerifyError = $_('settings.account_name.error_not_found', {
					values: { account: candidate }
				});
				return;
			}
			const verdict = verifyPostingKey(fetched, derivedPub);
			if (verdict.kind === 'wrong-role' || verdict.kind === 'not-found') {
				// User's posting key isn't the one authorized for this
				// account.  Either typo, wrong account, or rotated keys.
				accountVerifyError = $_('settings.account_name.error_key_mismatch', {
					values: { account: candidate }
				});
				return;
			}
			// Verified: posting key matches account's posting authority.
			setUserBlurtAccount(candidate);
			accountSaved = candidate;
			accountInput = candidate;
			accountSavedToast = true;
			setTimeout(() => (accountSavedToast = false), 1800);
		} catch (err) {
			accountVerifyError = $_('settings.account_name.error_chain_unreachable');
			void err;
		} finally {
			accountVerifying = false;
		}
	}

	async function saveAndBroadcast(): Promise<void> {
		await saveLocal();
		const live = $liveIdentity;
		if (!live) return;
		broadcasting = true;
		broadcastError = '';
		broadcastOk = false;
		try {
			// Include nostr_url and blurt_media_url in the broadcast
			// so all profile fields stay in sync on-chain. The
			// indexer stores the whole json_metadata blob, and
			// IdentityLabel reads specific keys out of it on every
			// render site.
			await broadcastProfile(live, {
				display_name: saved,
				nostr_url: nostrCleaned || undefined,
				blurt_media_url: blurtMediaCleaned || undefined
			});
			broadcastOk = true;
			setTimeout(() => (broadcastOk = false), 3000);
		} catch (err) {
			const be = err instanceof BroadcastError ? err : null;
			console.warn('[settings] display-name broadcast failed:', err);
			if (be !== null && (be.code === 'no_account' || be.code === 'locked')) {
				broadcastError = $_(`settings.display_name.broadcast_err.${be.code}`);
			} else {
				// Unknown BroadcastError code, generic Error, or non-Error
				// throw all fall to the localized generic copy.  Raw text
				// is logged above for debugging.
				broadcastError = $_('settings.display_name.broadcast_err.generic');
			}
		} finally {
			broadcasting = false;
		}
	}

	// ── Blurt.media URL — save locally, or save + broadcast ─────────
	async function saveBlurtMediaLocal(): Promise<void> {
		if (!blurtMediaIsValid) return;
		blurtMediaSaving = true;
		const cleaned = blurtMediaIsEmpty ? '' : blurtMediaCleaned;
		try {
			if (cleaned) {
				window.localStorage.setItem(BLURT_MEDIA_URL_STORAGE_KEY, cleaned);
			} else {
				window.localStorage.removeItem(BLURT_MEDIA_URL_STORAGE_KEY);
			}
		} catch {
			// Privacy Mode; in-memory only.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		blurtMediaSaved = cleaned;
		blurtMediaInput = cleaned;
		blurtMediaSaving = false;
		blurtMediaSavedToast = true;
		setTimeout(() => (blurtMediaSavedToast = false), 1800);
	}

	/** Auto-save the Blurt.media URL locally when the field loses focus.
	 *  Silent (no spinner, no artificial delay) and a no-op when the value
	 *  hasn't actually changed, so tabbing through the form doesn't spam a
	 *  "Saved" toast. Invalid input is left untouched for the user to fix
	 *  (the inline error stays visible). This is why the field no longer
	 *  needs an explicit "Save locally" button — broadcasting to chain stays
	 *  a deliberate, separate action. */
	function persistBlurtMediaOnBlur(): void {
		if (!blurtMediaIsValid) return;
		const cleaned = blurtMediaIsEmpty ? '' : blurtMediaCleaned;
		if (cleaned === blurtMediaSaved) {
			blurtMediaInput = cleaned; // normalize display only
			return;
		}
		try {
			if (cleaned) window.localStorage.setItem(BLURT_MEDIA_URL_STORAGE_KEY, cleaned);
			else window.localStorage.removeItem(BLURT_MEDIA_URL_STORAGE_KEY);
		} catch {
			// Private mode — in-memory only.
		}
		blurtMediaSaved = cleaned;
		blurtMediaInput = cleaned;
		blurtMediaSavedToast = true;
		setTimeout(() => (blurtMediaSavedToast = false), 1800);
	}

	async function saveAndBroadcastBlurtMedia(): Promise<void> {
		await saveBlurtMediaLocal();
		const live = $liveIdentity;
		if (!live) return;
		const displayName = saved || (validation.ok ? validation.cleaned : '');
		if (!displayName) {
			blurtMediaBroadcastError = $_('settings.blurt_media_url.need_display_name');
			return;
		}
		blurtMediaBroadcasting = true;
		blurtMediaBroadcastError = '';
		blurtMediaBroadcastOk = false;
		try {
			// Broadcast ALL known profile fields together so the
			// indexer's stored json_metadata reflects the user's full
			// intent. Omitting nostr_url here would orphan any
			// previously-broadcast Nostr URL.
			await broadcastProfile(live, {
				display_name: displayName,
				nostr_url: nostrSaved || undefined,
				blurt_media_url: blurtMediaSaved || undefined
			});
			blurtMediaBroadcastOk = true;
			setTimeout(() => (blurtMediaBroadcastOk = false), 3000);
		} catch (err) {
			const be = err instanceof BroadcastError ? err : null;
			console.warn('[settings] broadcast failed:', err);
			if (be !== null && (be.code === 'no_account' || be.code === 'locked')) {
				blurtMediaBroadcastError = $_(`settings.display_name.broadcast_err.${be.code}`);
			} else {
				// Unknown BroadcastError code, generic Error, or non-Error
				// throw all fall to the localized generic copy.  Raw text
				// is logged above for debugging.
				blurtMediaBroadcastError = $_(`settings.display_name.broadcast_err.generic`);
			}
		} finally {
			blurtMediaBroadcasting = false;
		}
	}

	function clearBlurtMedia(): void {
		try {
			window.localStorage.removeItem(BLURT_MEDIA_URL_STORAGE_KEY);
		} catch {
			// ignore
		}
		blurtMediaSaved = '';
		blurtMediaInput = '';
	}

	// ── Nostr URL — save locally, or save + broadcast ───────────────
	async function saveNostrLocal(): Promise<void> {
		if (!nostrIsValid) return;
		nostrSaving = true;
		const cleaned = nostrIsEmpty ? '' : nostrCleaned;
		try {
			if (cleaned) {
				window.localStorage.setItem(NOSTR_URL_STORAGE_KEY, cleaned);
			} else {
				window.localStorage.removeItem(NOSTR_URL_STORAGE_KEY);
			}
		} catch {
			// Privacy Mode; in-memory only.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		nostrSaved = cleaned;
		nostrInput = cleaned;
		nostrSaving = false;
		nostrSavedToast = true;
		setTimeout(() => (nostrSavedToast = false), 1800);
	}

	/** Auto-save the Nostr URL locally on blur. Same contract as
	 *  persistBlurtMediaOnBlur — silent, change-detected, invalid input
	 *  left for the user to fix. Removes the need for a "Save locally"
	 *  button; "Save & broadcast" stays a deliberate action. */
	function persistNostrOnBlur(): void {
		if (!nostrIsValid) return;
		const cleaned = nostrIsEmpty ? '' : nostrCleaned;
		if (cleaned === nostrSaved) {
			nostrInput = cleaned; // normalize display only
			return;
		}
		try {
			if (cleaned) window.localStorage.setItem(NOSTR_URL_STORAGE_KEY, cleaned);
			else window.localStorage.removeItem(NOSTR_URL_STORAGE_KEY);
		} catch {
			// Private mode — in-memory only.
		}
		nostrSaved = cleaned;
		nostrInput = cleaned;
		nostrSavedToast = true;
		setTimeout(() => (nostrSavedToast = false), 1800);
	}

	async function saveAndBroadcastNostr(): Promise<void> {
		await saveNostrLocal();
		const live = $liveIdentity;
		if (!live) return;
		// Broadcast requires a display_name (indexer validates
		// min length 1). Use the saved one, or fall back to the
		// user's current input if they haven't saved yet. If
		// neither is set, surface an error — they need a display
		// name before they can broadcast any profile fields.
		const displayName = saved || (validation.ok ? validation.cleaned : '');
		if (!displayName) {
			nostrBroadcastError = $_('settings.nostr_url.need_display_name');
			return;
		}
		nostrBroadcasting = true;
		nostrBroadcastError = '';
		nostrBroadcastOk = false;
		try {
			await broadcastProfile(live, {
				display_name: displayName,
				nostr_url: nostrSaved || undefined,
				blurt_media_url: blurtMediaSaved || undefined
			});
			nostrBroadcastOk = true;
			setTimeout(() => (nostrBroadcastOk = false), 3000);
		} catch (err) {
			const be = err instanceof BroadcastError ? err : null;
			console.warn('[settings] broadcast failed:', err);
			if (be !== null && (be.code === 'no_account' || be.code === 'locked')) {
				nostrBroadcastError = $_(`settings.display_name.broadcast_err.${be.code}`);
			} else {
				// Unknown BroadcastError code, generic Error, or non-Error
				// throw all fall to the localized generic copy.  Raw text
				// is logged above for debugging.
				nostrBroadcastError = $_(`settings.display_name.broadcast_err.generic`);
			}
		} finally {
			nostrBroadcasting = false;
		}
	}

	function clearNostr(): void {
		try {
			window.localStorage.removeItem(NOSTR_URL_STORAGE_KEY);
		} catch {
			// ignore
		}
		nostrSaved = '';
		nostrInput = '';
	}

	// ─── Avatar upload / broadcast ──────────────────────────────────
	// Imported lazily at call time so SSR and test environments
	// without a DOM don't trip on the Canvas / DOMParser imports
	// at module-load. The settings page is browser-only anyway,
	// so the lazy pattern just narrows the surface.

	async function handleAvatarFileSelected(e: Event): Promise<void> {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;
		avatarError = '';
		avatarProcessing = true;
		avatarBroadcastOk = false;
		avatarBroadcastError = '';
		try {
			const mod = await import('$lib/avatar');
			const result = await mod.processAvatarFile(file);
			if (!result.ok) {
				avatarError = $_(`settings.avatar.error.${result.code}`);
				// Reset the input so the same file can be re-selected
				// after the user addresses the error.
				if (avatarFileInput) avatarFileInput.value = '';
				return;
			}
			// Stage the processed result. Mutually exclusive — only
			// one of the two staged fields is ever populated at once.
			if (result.kind === 'svg') {
				avatarStagedSvg = result.value;
				avatarStagedDataUri = '';
			} else {
				avatarStagedSvg = '';
				avatarStagedDataUri = result.value;
			}
			avatarStagedBytes = result.byteLength;
		} catch (err) {
			console.warn('[settings] avatar processing failed:', err);
			avatarError = $_('settings.avatar.error.processing_failed');
			if (avatarFileInput) avatarFileInput.value = '';
		} finally {
			avatarProcessing = false;
		}
	}

	function cancelAvatar(): void {
		// Discard the staged avatar without broadcasting. Restores
		// the identicon preview; does NOT touch any previously
		// broadcast avatar that's already on-chain.
		avatarStagedSvg = '';
		avatarStagedDataUri = '';
		avatarStagedBytes = 0;
		avatarError = '';
		if (avatarFileInput) avatarFileInput.value = '';
	}

	async function broadcastAvatar(): Promise<void> {
		const live = $liveIdentity;
		if (!live) return;
		// Need a display_name on-chain first; same gating as
		// nostr_url / blurt_media_url.
		const displayName = saved || (validation.ok ? validation.cleaned : '');
		if (!displayName) {
			avatarBroadcastError = $_('settings.avatar.need_display_name');
			return;
		}
		avatarBroadcasting = true;
		avatarBroadcastError = '';
		avatarBroadcastOk = false;
		try {
			await broadcastProfile(live, {
				display_name: displayName,
				nostr_url: nostrSaved || undefined,
				blurt_media_url: blurtMediaSaved || undefined,
				// Pass BOTH fields explicitly so the indexer knows
				// exactly which one is active; empty string clears
				// the other half of the pair.
				avatar_svg: avatarStagedSvg,
				avatar_data_uri: avatarStagedDataUri
			});
			hasCustomAvatar = true;
			avatarBroadcastOk = true;
			setTimeout(() => (avatarBroadcastOk = false), 3000);
		} catch (err) {
			const be = err instanceof BroadcastError ? err : null;
			console.warn('[settings] broadcast failed:', err);
			if (be !== null && (be.code === 'no_account' || be.code === 'locked')) {
				avatarBroadcastError = $_(`settings.display_name.broadcast_err.${be.code}`);
			} else {
				// Unknown BroadcastError code, generic Error, or non-Error
				// throw all fall to the localized generic copy.  Raw text
				// is logged above for debugging.
				avatarBroadcastError = $_(`settings.display_name.broadcast_err.generic`);
			}
		} finally {
			avatarBroadcasting = false;
		}
	}

	async function broadcastRemoveAvatar(): Promise<void> {
		// Explicit "remove my avatar" — broadcasts empty strings for
		// both fields so the indexer overwrites any prior avatar
		// state with "intentionally empty". Omitting the field would
		// leave the prior avatar on-chain; that's the wrong
		// semantic.
		const live = $liveIdentity;
		if (!live) return;
		const displayName = saved || (validation.ok ? validation.cleaned : '');
		if (!displayName) {
			avatarBroadcastError = $_('settings.avatar.need_display_name');
			return;
		}
		avatarBroadcasting = true;
		avatarBroadcastError = '';
		avatarBroadcastOk = false;
		try {
			await broadcastProfile(live, {
				display_name: displayName,
				nostr_url: nostrSaved || undefined,
				blurt_media_url: blurtMediaSaved || undefined,
				avatar_svg: '',
				avatar_data_uri: ''
			});
			hasCustomAvatar = false;
			// Clear any local staging — the on-chain state is now
			// "no avatar", and the UI should reflect that.
			avatarStagedSvg = '';
			avatarStagedDataUri = '';
			avatarStagedBytes = 0;
			avatarBroadcastOk = true;
			setTimeout(() => (avatarBroadcastOk = false), 3000);
		} catch (err) {
			const be = err instanceof BroadcastError ? err : null;
			console.warn('[settings] broadcast failed:', err);
			if (be !== null && (be.code === 'no_account' || be.code === 'locked')) {
				avatarBroadcastError = $_(`settings.display_name.broadcast_err.${be.code}`);
			} else {
				// Unknown BroadcastError code, generic Error, or non-Error
				// throw all fall to the localized generic copy.  Raw text
				// is logged above for debugging.
				avatarBroadcastError = $_(`settings.display_name.broadcast_err.generic`);
			}
		} finally {
			avatarBroadcasting = false;
		}
	}

	/** Format a byte count for the UI ("2,048 B / 3 KB cap"). */
	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		return `${(n / 1024).toFixed(1)} KB`;
	}

	function beginClear(): void {
		// Stage 1 of the destructive action. Opens the inline
		// confirmation prompt; does not yet mutate state.
		confirmingClear = true;
	}

	function cancelClear(): void {
		confirmingClear = false;
	}

	function confirmClear(): void {
		try {
			window.localStorage.removeItem(STORAGE_KEY);
		} catch {
			// ignore
		}
		saved = '';
		input = '';
		confirmingClear = false;
	}


	// Auto-lock timeout handler. Parses the <select> value — the
	// 'never' option maps to the NEVER_LOCK sentinel, all others are
	// numeric minutes. Setting immediately persists via
	// writeTimeoutMinutes and the store reflects the change.
	function setAutoLock(event: Event): void {
		const v = (event.target as HTMLSelectElement).value;
		if (v === 'never') {
			writeTimeoutMinutes(NEVER_LOCK);
		} else {
			const n = parseInt(v, 10);
			if (!isNaN(n)) writeTimeoutMinutes(n);
		}
	}

	/** Only show the auto-lock timeout widget when the user actually
	 *  chose password-mode at onboarding. Seed-only users don't have
	 *  a persisted keystore — Lock Session and Sign Out collapse to
	 *  the same action for them, and a timeout wouldn't mean anything
	 *  different from "session expires when tab closes." */
	const canConfigureAutoLock = $derived(hasPersistedKeystore());

	// ─── Change password (K1.3) ──────────────────────────────────
	/** Same gate as auto-lock: only password-mode users have a
	 *  persisted envelope to re-encrypt.  Seed-only users have no
	 *  persistent keystore and rotate their seed (a different,
	 *  bigger operation) if they want a clean break. */
	const canChangePassword = $derived(hasPersistedKeystore());

	let pwOldInput = $state('');
	let pwNewInput = $state('');
	let pwConfirmInput = $state('');
	let pwBusy = $state(false);
	/** Localized error message for the change-password form, or
	 *  empty when there's no error.  Set by the submit handler
	 *  based on the discriminated union from changePassword(). */
	let pwError = $state('');
	/** Transient success state for the "Password changed" toast
	 *  inside the form.  Cleared automatically after a few seconds. */
	let pwSuccess = $state(false);

	/** Strength advisory for the new password.  Surfaces 'common'
	 *  and 'trivial' as warnings but does NOT block submission —
	 *  same UX policy as onboarding.  null when the field is empty
	 *  or below the 8-char minimum. */
	const pwNewStrength = $derived.by(() => {
		if (pwNewInput.length < 10) return null;
		return scorePassword(pwNewInput);
	});

	const pwCanSubmit = $derived(
		!pwBusy &&
			pwOldInput.length > 0 &&
			isPasswordAcceptable(pwNewInput) &&
			pwConfirmInput.length > 0 &&
			pwNewInput === pwConfirmInput &&
			pwNewInput !== pwOldInput
	);

	async function submitChangePassword(): Promise<void> {
		if (!pwCanSubmit) return;
		pwBusy = true;
		pwError = '';
		pwSuccess = false;
		// Snapshot the inputs locally so we can clear the bindings
		// before the await (defensive: if the user navigates away
		// mid-operation, the password fields are already empty).
		const oldPw = pwOldInput;
		const newPw = pwNewInput;
		try {
			const r = await changePassword(oldPw, newPw);
			if (r.ok) {
				pwSuccess = true;
				setTimeout(() => (pwSuccess = false), 3000);
			} else {
				// Map error kind to a localized i18n key.  Each
				// kind has a dedicated string so the user gets a
				// specific message rather than a generic "failed."
				pwError = $_(`settings.change_password.err.${r.kind}`);
			}
		} catch (err) {
			// changePassword shouldn't throw (it returns errors as
			// values), but defensively map to the generic 'internal'
			// message if it does.  Raw err.message would be English
			// network/library output and shouldn't reach non-English
			// users.
			console.warn('[settings] changePassword threw:', err);
			pwError = $_('settings.change_password.err.internal');
		} finally {
			// Always clear all three password fields, regardless of
			// outcome.  Memory hygiene: don't leave the user's
			// password sitting in a let binding longer than needed.
			pwOldInput = '';
			pwNewInput = '';
			pwConfirmInput = '';
			pwBusy = false;
		}
	}

	// ─── Hidden accounts (Q1.4 client-side moderation) ──────────
	/** Sorted alphabetically so the list doesn't reorder when the
	 *  user unhides one in the middle. Derived from the store so it
	 *  reacts to mutations in other tabs too (storage event). */
	const hiddenList = $derived([...$hiddenAccounts].sort());
	let confirmingUnhideAll = $state(false);

	// ─── Blocked accounts (Finding H layer 1) ───────────────────
	/** Sorted alphabetically so the list is stable across unblocks.
	 *  Store is lazy-loaded on first access; we kick off loadBlocks
	 *  in an effect below so the list is populated by the time the
	 *  user scrolls to it. */
	const blockedList = $derived([...$blockedAccounts].sort());
	/** Account-name keyed busy flags — one unblock op might be in
	 *  flight while the user clicks another. A simple Set tracks
	 *  which names are pending. */
	let unblockingSet = $state<Set<string>>(new Set());

	/** Briefly true after a manual refresh so the card can flash a
	 *  "Refreshed!" confirmation (~2s). The timer is cleared on a
	 *  re-click so rapid taps restart the window instead of stacking. */
	let blockedRefreshed = $state(false);
	let blockedRefreshedTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (!browser) return;
		const me = getUserBlurtAccount();
		if (!me) return;
		// Best-effort: if this fails, the list is empty but visible,
		// and a refresh retries.
		void loadBlocks(me);
	});

	async function onUnblock(account: string): Promise<void> {
		const live = $liveIdentity;
		if (!live) return; // button disabled in this case anyway
		if (unblockingSet.has(account)) return;
		const next = new Set(unblockingSet);
		next.add(account);
		unblockingSet = next;
		try {
			await broadcastUnblock(live, account);
			markUnblocked(account);
		} catch (err) {
			console.error('unblock failed', account, err);
			showToast($_('settings.blocked_accounts.unblock_failed') as string, 'error');
		} finally {
			const after = new Set(unblockingSet);
			after.delete(account);
			unblockingSet = after;
		}
	}

	async function onRefreshBlocked(): Promise<void> {
		const me = getUserBlurtAccount();
		if (!me) return;
		await refreshBlocks(me);
		blockedRefreshed = true;
		if (blockedRefreshedTimer) clearTimeout(blockedRefreshedTimer);
		blockedRefreshedTimer = setTimeout(() => (blockedRefreshed = false), 2000);
	}

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="settings" noindex />

<div class="mx-auto max-w-2xl px-4 py-12 md:py-16">
	<header class="mb-8">
		<h1 class="font-display text-3xl font-extrabold md:text-4xl">
			<span class="brand-gradient-text">{$_('settings.title')}</span>
		</h1>
		<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('settings.subtitle')}</p>
	</header>

	{#if $isPairedReadOnly}
		<!-- Paired-readonly session (ADR-0022 QR-pair, Option A).  The
		     edit forms on this page all sign with the posting key
		     (display-name, blurt-media, nostr, avatar, syndication,
		     blocklist — every account_update op).  Paired sessions
		     don't hold posting key material on this device, so all
		     those edit affordances are already disabled by their
		     existing `disabled={!$isUnlocked}` gates.  Surface a
		     single page-level explanation up front so the user
		     understands WHY everything looks disabled, with a deep-
		     link affordance back to their phone. -->
		<section class="mb-6">
			<WriteBlockedReadOnly variant="profile" />
		</section>
	{/if}

	<!-- ─── Blurt account name ─── -->
	<!-- Closes C-24 (Sally walkthrough finding): seed and keyfile
	     imports don't ask for account name (a Blurt seed/keyfile
	     carries keys, not the account name).  Without an account
	     name set, 70+ surfaces silently fail to recognize the
	     user.  This section lets a seed-imported user supply
	     their account name and verifies the match against on-
	     chain posting.key_auths before saving. -->
	{#if needsAccountNameBanner}
		<!-- Sally finding H2 (Part 68): one-shot landing banner for
		     users who just imported via seed or keyfile.  Without
		     this they land on a generic "settings" page with no
		     idea why and may close the tab thinking the import
		     failed. -->
		<section
			class="card mb-4 border-morphit-emerald/40 bg-morphit-emerald/5"
			role="status"
			aria-live="polite"
		>
			<div class="flex items-start gap-3">
				<span class="text-2xl" aria-hidden="true">👋</span>
				<div class="flex-1">
					<p class="font-semibold text-morphit-emerald">
						{$_('settings.import_landing_banner.title')}
					</p>
					<p class="mt-1 text-sm text-ink-700 dark:text-ink-200">
						{$_('settings.import_landing_banner.body')}
					</p>
				</div>
				<button
					type="button"
					onclick={() => (needsAccountNameBanner = false)}
					class="flex-none rounded p-1 text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
					aria-label={$_('settings.import_landing_banner.dismiss_aria') as string}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M18 6 6 18" />
						<path d="m6 6 12 12" />
					</svg>
				</button>
			</div>
		</section>
	{/if}
	<section class="card" aria-labelledby="account-name-heading">
		<h2 id="account-name-heading" class="font-display text-xl font-bold">
			{$_('settings.account_name.heading')}
		</h2>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.account_name.explain')}
		</p>

		{#if accountSaved}
			<div class="mt-4 rounded-2xl bg-ink-50 p-4 dark:bg-ink-950">
				<p class="mb-1 text-xs font-semibold uppercase tracking-widest text-ink-500">
					{$_('settings.account_name.current_label')}
				</p>
				<IdentityLabel
					account={accountSaved}
					weight="bold"
					avatarSize={40}
					showCopy={false}
				/>
				<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
					{$_('settings.account_name.locked_explain')}
				</p>
			</div>
		{:else}
			<label class="mt-5 block">
				<span class="mb-2 block font-semibold">
					{$_('settings.account_name.input_label')}
				</span>
				<input
					bind:value={accountInput}
					type="text"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					placeholder={$_('settings.account_name.input_placeholder')}
					class="input w-full font-mono"
					disabled={!$isUnlocked || accountVerifying}
				/>
			</label>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_('settings.account_name.input_hint')}
			</p>
			{#if !$isUnlocked}
				<p class="mt-3 text-sm text-amber-700 dark:text-amber-300">
					{$_('settings.account_name.error_locked')}
				</p>
			{/if}
			{#if accountVerifyError}
				<p class="mt-3 text-sm text-red-700 dark:text-red-300" role="alert">
					{accountVerifyError}
				</p>
			{/if}
			<div class="mt-4 flex flex-wrap gap-3">
				<BusyButton
					variant="primary"
					busy={accountVerifying}
					disabled={!$isUnlocked || !accountInput.trim()}
					onclick={verifyAndSaveAccountName}
				>
					{$_('settings.account_name.verify_save_cta')}
				</BusyButton>
			</div>
		{/if}

		{#if accountSavedToast}
			<p class="mt-4 text-sm text-morphit-emerald" aria-live="polite">
				✓ {$_('settings.account_name.saved_toast')}
			</p>
		{/if}
	</section>

	<!-- ─── Display name ─── -->
	<section class="card mt-6" aria-labelledby="display-name-heading">
		<h2 id="display-name-heading" class="font-display text-xl font-bold">
			{$_('settings.display_name.heading')}
		</h2>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.display_name.explain')}
		</p>

		<div class="mt-5 rounded-2xl bg-ink-50 p-4 dark:bg-ink-950">
			<p class="mb-2 text-xs font-semibold uppercase tracking-widest text-ink-500">
				{$_('settings.display_name.preview_label')}
			</p>
			<IdentityLabel
				account={accountSaved ?? undefined}
				publicKey={previewPubkey}
				displayName={validation.ok ? validation.cleaned : saved}
				weight="bold"
			/>
		</div>

		<label class="mt-5 block">
			<span class="mb-2 block font-semibold">{$_('settings.display_name.input_label')}</span>
			<input
				bind:value={input}
				type="text"
				maxlength={DISPLAY_NAME_MAX_LENGTH * 4}
				autocomplete="off"
				spellcheck="false"
				placeholder={$_('settings.display_name.placeholder')}
				class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-950"
			/>
		</label>

		<div class="mt-2 flex items-center justify-between text-sm">
			<p class="text-ink-500">
				{#if input && !validation.ok}
					<span class="text-red-600 dark:text-red-400">{$_(validation.reasonKey)}</span>
				{:else if input}
					<span class="text-ink-500">{$_('settings.display_name.hint')}</span>
				{/if}
			</p>
			<p class="text-ink-500" class:text-red-600={remaining < 0}>
				{remaining}
			</p>
		</div>

		<div class="mt-6 flex flex-wrap items-center gap-3">
			<BusyButton
				variant="primary"
				busy={saving}
				done={savedToast}
				disabled={!validation.ok || validation.cleaned === saved}
				busyLabel={$_('settings.display_name.save_pending')}
				onclick={saveLocal}
			>
				{#if savedToast}
					{$_('settings.display_name.saved_toast')}
				{:else}
					{$_('settings.display_name.save')}
				{/if}
			</BusyButton>
			{#if $isUnlocked}
				<BusyButton
					variant="secondary"
					busy={broadcasting}
					done={broadcastOk}
					disabled={!validation.ok}
					busyLabel={$_('settings.display_name.broadcast_pending')}
					onclick={saveAndBroadcast}
				>
					{#if broadcastOk}
						{$_('settings.display_name.broadcast_ok')}
					{:else}
						{$_('settings.display_name.save_and_broadcast')}
					{/if}
				</BusyButton>
			{/if}
			{#if saved && !confirmingClear}
				<BusyButton variant="ghost" onclick={beginClear}>
					{$_('settings.display_name.clear')}
				</BusyButton>
			{/if}
		</div>

		{#if confirmingClear}
			<!-- Inline destructive-action confirmation prompt. Per
			     UX-STANDARD rule #5: one confirmation, not two; the
			     confirming action is the heavier of the pair. -->
			<div
				class="mt-4 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950"
				role="alertdialog"
				aria-live="polite"
			>
				<p class="text-sm text-amber-900 dark:text-amber-100">
					{$_('settings.display_name.clear_confirm_prompt')}
				</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<BusyButton variant="primary" onclick={confirmClear}>
						{$_('settings.display_name.clear_confirm_yes')}
					</BusyButton>
					<BusyButton variant="ghost" onclick={cancelClear}>
						{$_('settings.display_name.clear_confirm_cancel')}
					</BusyButton>
				</div>
			</div>
		{/if}

		{#if broadcastError}
			<div class="mt-3">
				<StatusLine kind="error">{broadcastError}</StatusLine>
			</div>
		{/if}

		{#if broadcastOk}
			<p class="mt-3 text-sm text-ink-600 dark:text-ink-300" aria-live="polite">
				{$_('settings.display_name.broadcast_ok_detail')}
			</p>
		{/if}

		<div
			class="mt-6 rounded-xl border border-ink-200 bg-white p-4 text-sm text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
		>
			<strong>{$_('settings.display_name.reminder_title')}</strong>
			<p class="mt-1">{$_('settings.display_name.reminder_body')}</p>
		</div>
	</section>

	<!-- ─── Blurt.media URL ─── -->
	<!-- Rendered BEFORE the Nostr section per UX directive: Blurt is
	     the native platform for Morphit, so a Blurt.media link is
	     the more common case than a Nostr link for most users. -->
	<section class="card mt-6" aria-labelledby="blurt-media-heading">
		<h2 id="blurt-media-heading" class="font-display text-xl font-bold">
			{$_('settings.blurt_media_url.heading')}
		</h2>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.blurt_media_url.explain')}
		</p>

		<label for="blurt-media-url-input" class="sr-only">
			{$_('settings.blurt_media_url.label')}
		</label>
		<input
			id="blurt-media-url-input"
			type="text"
			autocomplete="url"
			inputmode="url"
			spellcheck="false"
			bind:value={blurtMediaInput}
			onblur={persistBlurtMediaOnBlur}
			placeholder={$_('settings.blurt_media_url.placeholder')}
			aria-invalid={!blurtMediaIsValid}
			aria-describedby="blurt-media-url-help"
			class="mt-4 w-full rounded-xl border-2 border-ink-300 bg-white px-3 py-2 font-mono text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900 {!blurtMediaIsValid
				? 'border-red-500 dark:border-red-500'
				: ''}"
		/>

		<p id="blurt-media-url-help" class="mt-2 text-sm">
			{#if blurtMediaErrorReason === 'too_long'}
				<span class="text-red-600">
					{$_('settings.blurt_media_url.error.too_long')}
				</span>
			{:else if blurtMediaErrorReason === 'invalid_scheme'}
				<span class="text-red-600">
					{$_('settings.blurt_media_url.error.invalid_scheme')}
				</span>
			{:else if blurtMediaErrorReason === 'wrong_host'}
				<span class="text-red-600">
					{$_('settings.blurt_media_url.error.wrong_host')}
				</span>
			{:else if blurtMediaErrorReason === 'malformed'}
				<span class="text-red-600">
					{$_('settings.blurt_media_url.error.malformed')}
				</span>
			{:else if blurtMediaIsEmpty}
				<span class="text-ink-500">
					{$_('settings.blurt_media_url.hint_empty')}
				</span>
			{:else}
				<span class="text-ink-500">
					{$_('settings.blurt_media_url.hint_ok')}
				</span>
			{/if}
		</p>

		<!-- Preview — mirrors the Nostr preview, showing the user
		     what their Blurt.media link will look like next to their
		     display name everywhere. Updates live as they type. -->
		{#if blurtMediaCleaned && saved}
			<div
				class="mt-4 rounded-xl border border-ink-200 bg-white p-4 dark:border-ink-700 dark:bg-ink-900"
			>
				<p class="mb-2 text-xs uppercase tracking-wider text-ink-500">
					{$_('settings.blurt_media_url.preview_label')}
				</p>
				<IdentityLabel
					account={accountSaved ?? undefined}
					displayName={saved}
					publicKey={previewPubkey}
					blurtMediaUrl={blurtMediaCleaned}
				/>
			</div>
		{/if}

		<div class="mt-6 flex flex-wrap items-center gap-3">
			{#if $isUnlocked}
				<BusyButton
					variant="secondary"
					busy={blurtMediaBroadcasting}
					done={blurtMediaBroadcastOk}
					disabled={!blurtMediaIsValid}
					busyLabel={$_('settings.blurt_media_url.broadcast_pending')}
					onclick={saveAndBroadcastBlurtMedia}
				>
					{#if blurtMediaBroadcastOk}
						{$_('settings.blurt_media_url.broadcast_ok')}
					{:else}
						{$_('settings.blurt_media_url.save_and_broadcast')}
					{/if}
				</BusyButton>
			{/if}
			{#if blurtMediaSaved}
				<BusyButton variant="ghost" onclick={clearBlurtMedia}>
					{$_('settings.blurt_media_url.clear')}
				</BusyButton>
			{/if}
			{#if blurtMediaSavedToast}
				<span class="text-sm font-medium text-morphit-emerald" role="status">
					{$_('settings.blurt_media_url.saved_toast')}
				</span>
			{/if}
		</div>

		{#if blurtMediaBroadcastError}
			<div class="mt-3">
				<StatusLine kind="error">{blurtMediaBroadcastError}</StatusLine>
			</div>
		{/if}

		<div
			class="mt-6 rounded-xl border border-ink-200 bg-white p-4 text-sm text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
		>
			<strong>{$_('settings.blurt_media_url.reminder_title')}</strong>
			<p class="mt-1">{$_('settings.blurt_media_url.reminder_body')}</p>
		</div>
	</section>

	<!-- ─── Nostr URL ─── -->
	<section class="card mt-6" aria-labelledby="nostr-heading">
		<h2 id="nostr-heading" class="font-display text-xl font-bold">
			{$_('settings.nostr_url.heading')}
		</h2>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.nostr_url.explain')}
		</p>

		<label for="nostr-url-input" class="sr-only">
			{$_('settings.nostr_url.label')}
		</label>
		<input
			id="nostr-url-input"
			type="text"
			autocomplete="url"
			inputmode="url"
			spellcheck="false"
			bind:value={nostrInput}
			onblur={persistNostrOnBlur}
			placeholder={$_('settings.nostr_url.placeholder')}
			aria-invalid={!nostrIsValid}
			aria-describedby="nostr-url-help"
			class="mt-4 w-full rounded-xl border-2 border-ink-300 bg-white px-3 py-2 font-mono text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900 {!nostrIsValid
				? 'border-red-500 dark:border-red-500'
				: ''}"
		/>

		<p id="nostr-url-help" class="mt-2 text-sm">
			{#if nostrErrorReason === 'too_long'}
				<span class="text-red-600">
					{$_('settings.nostr_url.error.too_long')}
				</span>
			{:else if nostrErrorReason === 'invalid_scheme'}
				<span class="text-red-600">
					{$_('settings.nostr_url.error.invalid_scheme')}
				</span>
			{:else if nostrErrorReason === 'malformed'}
				<span class="text-red-600">
					{$_('settings.nostr_url.error.malformed')}
				</span>
			{:else if nostrIsEmpty}
				<span class="text-ink-500">
					{$_('settings.nostr_url.hint_empty')}
				</span>
			{:else}
				<span class="text-ink-500">
					{$_('settings.nostr_url.hint_ok')}
				</span>
			{/if}
		</p>

		<!-- Preview — reuses IdentityLabel so the user sees exactly
		     what their Nostr link looks like beside their display
		     name everywhere on the site. Updates live as they type. -->
		{#if nostrCleaned && saved}
			<div
				class="mt-4 rounded-xl border border-ink-200 bg-white p-4 dark:border-ink-700 dark:bg-ink-900"
			>
				<p class="mb-2 text-xs uppercase tracking-wider text-ink-500">
					{$_('settings.nostr_url.preview_label')}
				</p>
				<IdentityLabel account={accountSaved ?? undefined} displayName={saved} publicKey={previewPubkey} nostrUrl={nostrCleaned} />
			</div>
		{/if}

		<div class="mt-6 flex flex-wrap items-center gap-3">
			{#if $isUnlocked}
				<BusyButton
					variant="secondary"
					busy={nostrBroadcasting}
					done={nostrBroadcastOk}
					disabled={!nostrIsValid}
					busyLabel={$_('settings.nostr_url.broadcast_pending')}
					onclick={saveAndBroadcastNostr}
				>
					{#if nostrBroadcastOk}
						{$_('settings.nostr_url.broadcast_ok')}
					{:else}
						{$_('settings.nostr_url.save_and_broadcast')}
					{/if}
				</BusyButton>
			{/if}
			{#if nostrSaved}
				<BusyButton variant="ghost" onclick={clearNostr}>
					{$_('settings.nostr_url.clear')}
				</BusyButton>
			{/if}
			{#if nostrSavedToast}
				<span class="text-sm font-medium text-morphit-emerald" role="status">
					{$_('settings.nostr_url.saved_toast')}
				</span>
			{/if}
		</div>

		{#if nostrBroadcastError}
			<div class="mt-3">
				<StatusLine kind="error">{nostrBroadcastError}</StatusLine>
			</div>
		{/if}

		<div
			class="mt-6 rounded-xl border border-ink-200 bg-white p-4 text-sm text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
		>
			<strong>{$_('settings.nostr_url.reminder_title')}</strong>
			<p class="mt-1">{$_('settings.nostr_url.reminder_body')}</p>
		</div>
	</section>

	<!-- ─── Avatar ─── -->
	<section class="card mt-6" aria-labelledby="avatar-heading">
		<h2 id="avatar-heading" class="font-display text-xl font-bold">
			{$_('settings.avatar.heading')}
		</h2>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.avatar.explain')}
		</p>

		<!-- Upfront guidance — shown BEFORE the file picker so the
		     user knows what to prepare instead of uploading, getting
		     an error, and trying again. Covers: supported filetypes,
		     ideal source size, what we'll do to the file. -->
		<div
			class="mt-4 rounded-xl border border-ink-200 bg-ink-50 p-4 text-sm dark:border-ink-700 dark:bg-ink-900"
		>
			<p class="font-semibold text-ink-800 dark:text-ink-100">
				{$_('settings.avatar.guidance_heading')}
			</p>
			<ul class="mt-2 space-y-1 text-ink-600 dark:text-ink-300">
				<li>{$_('settings.avatar.guidance_filetypes')}</li>
				<li>{$_('settings.avatar.guidance_dimensions')}</li>
				<li>{$_('settings.avatar.guidance_filesize')}</li>
				<li>{$_('settings.avatar.guidance_size')}</li>
				<li>{$_('settings.avatar.guidance_svg_tips')}</li>
			</ul>
		</div>

		<!-- Permanence warning — high-contrast callout so it doesn't
		     get skimmed past. On-chain means public forever, no
		     delete, no takedown. -->
		<div
			class="mt-4 rounded-xl border-2 border-amber-500/60 bg-amber-50 p-4 text-sm dark:border-amber-500/50 dark:bg-amber-900/20"
			role="note"
		>
			<p class="font-semibold text-amber-900 dark:text-amber-200">
				⚠ {$_('settings.avatar.permanence_heading')}
			</p>
			<p class="mt-1 text-amber-900 dark:text-amber-100">
				{$_('settings.avatar.permanence_body')}
			</p>
		</div>

		<!-- File input -->
		<div class="mt-6">
			<label for="avatar-file-input" class="sr-only">
				{$_('settings.avatar.file_input_label')}
			</label>
			<input
				id="avatar-file-input"
				bind:this={avatarFileInput}
				type="file"
				accept="image/svg+xml,image/webp,image/jpeg,image/png,image/gif"
				onchange={handleAvatarFileSelected}
				disabled={avatarProcessing || avatarBroadcasting}
				class="block w-full text-sm text-ink-600 file:me-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-morphit-btn file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-300"
			/>
			{#if avatarProcessing}
				<p class="mt-2 text-sm text-ink-500">
					{$_('settings.avatar.processing')}
				</p>
			{/if}
			{#if avatarError}
				<div class="mt-3">
					<StatusLine kind="error">{avatarError}</StatusLine>
				</div>
			{/if}
		</div>

		<!-- Staged preview — shows what the user is about to broadcast.
		     Uses IdentityLabel so the preview matches the real app
		     rendering exactly. -->
		{#if avatarStagedSvg || avatarStagedDataUri}
			<div
				class="mt-6 rounded-xl border border-ink-200 bg-white p-4 dark:border-ink-700 dark:bg-ink-900"
			>
				<p class="mb-3 text-xs uppercase tracking-wider text-ink-500">
					{$_('settings.avatar.preview_label')}
				</p>
				<div class="flex items-center gap-4">
					<IdentityLabel
						displayName={saved || $_('settings.avatar.preview_display_name_placeholder')}
						publicKey={previewPubkey}
						avatarSvg={avatarStagedSvg || null}
						avatarDataUri={avatarStagedDataUri || null}
						avatarSize={96}
					/>
					<div class="text-sm text-ink-500">
						<p>
							{$_('settings.avatar.preview_size', {
								values: {
									bytes: formatBytes(avatarStagedBytes),
									cap: formatBytes(3072)
								}
							})}
						</p>
						{#if avatarStagedBytes > 2048}
							<p class="mt-1 text-amber-600 dark:text-amber-400">
								{$_('settings.avatar.preview_getting_large')}
							</p>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		<!-- Action buttons -->
		<div class="mt-6 flex flex-wrap items-center gap-3">
			{#if $isUnlocked && (avatarStagedSvg || avatarStagedDataUri)}
				<BusyButton
					variant="primary"
					busy={avatarBroadcasting}
					done={avatarBroadcastOk}
					busyLabel={$_('settings.avatar.broadcast_pending')}
					onclick={broadcastAvatar}
				>
					{#if avatarBroadcastOk}
						{$_('settings.avatar.broadcast_ok')}
					{:else}
						{$_('settings.avatar.broadcast')}
					{/if}
				</BusyButton>
				<BusyButton variant="ghost" onclick={cancelAvatar}>
					{$_('settings.avatar.cancel')}
				</BusyButton>
			{/if}
			{#if $isUnlocked && !avatarStagedSvg && !avatarStagedDataUri && hasCustomAvatar}
				<BusyButton
					variant="ghost"
					busy={avatarBroadcasting}
					busyLabel={$_('settings.avatar.remove_pending')}
					onclick={broadcastRemoveAvatar}
				>
					{$_('settings.avatar.remove')}
				</BusyButton>
			{/if}
		</div>

		{#if avatarBroadcastError}
			<div class="mt-3">
				<StatusLine kind="error">{avatarBroadcastError}</StatusLine>
			</div>
		{/if}
	</section>

	<!-- ─── Notifications ─── -->
	<!-- Self-contained component — owns its own section card, its
	     own state via the preferences store, and its own event
	     handlers. Lives here because it belongs in Settings but is
	     substantial enough that inlining would bloat this file.
	     Wrapped in an id="notifications" anchor (cp233) so the
	     AvatarMenu "Notification settings" link (/settings#notifications)
	     actually scrolls here instead of landing at the page top. -->
	<div id="notifications">
		<NotificationSettings />
	</div>

	<!-- ─── Install as app ─────────────────────────────────────
	     Item 16 phase 5.  Surfaces the "install Morphit on this
	     device" affordance without showing a pushy banner.  Hidden
	     entirely if the page is already running as a PWA. -->
	{#if !$isInstalled}
		<section class="card mt-6" aria-labelledby="install-heading">
			<h2 id="install-heading" class="font-display text-xl font-bold">
				{$_('settings.install.heading')}
			</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('settings.install.explain')}
			</p>
			{#if $installPrompt}
				<button type="button" class="btn-primary mt-4" onclick={() => void promptInstall()}>
					{$_('settings.install.cta')}
				</button>
			{:else}
				<!-- No deferred prompt available — Safari, iOS, Firefox.
				     Surface manual instructions with a link to the
				     iphone_install FAQ for iOS specifics. -->
				<div
					class="mt-4 rounded-xl border border-ink-200 bg-ink-50 p-4 text-sm dark:border-ink-700 dark:bg-ink-900"
				>
					<p>{$_('settings.install.manual_intro')}</p>
					<ul class="mt-2 list-disc space-y-1 pl-6 text-ink-600 dark:text-ink-300">
						<li>{$_('settings.install.manual_chrome')}</li>
						<li>{$_('settings.install.manual_safari')}</li>
						<li>{$_('settings.install.manual_firefox')}</li>
					</ul>
					<p class="mt-3 text-xs text-ink-500">
						<a href={lp('/faq#iphone_install')} class="underline hover:text-morphit-emerald">
							{$_('settings.install.iphone_link')}
						</a>
					</p>
				</div>
			{/if}
		</section>
	{/if}

	<!-- ─── RPC endpoints ─── -->
	<section class="card mt-6" aria-labelledby="endpoints-heading">
		<h2 id="endpoints-heading" class="font-display text-xl font-bold">
			{$_('settings.endpoints.heading')}
		</h2>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.endpoints.explain')}
		</p>

		<div class="mt-4">
			<EndpointList />
		</div>
	</section>

	<!-- ─── Syndication preferences ─────────────────────────── -->
	<section class="card mt-6" id="syndication" aria-labelledby="syndication-heading">
		<h2 id="syndication-heading" class="font-display text-xl font-bold">
			{$_('settings.syndication.heading')}
		</h2>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.syndication.explain')}
		</p>
		<!-- Sally finding H9 (Part 68): selling-point pitch on the
		     settings card so a user who navigates here directly to
		     toggle the preference understands what they're trading
		     off (privacy vs. additional earnings + reach). -->
		<p
			class="mt-3 rounded-xl border border-morphit-emerald/30 bg-morphit-emerald/5 p-3 text-sm text-ink-700 dark:border-morphit-emerald/40 dark:text-ink-200"
		>
			<span class="font-semibold text-morphit-emerald"
				>📣 {$_('settings.syndication.pitch_heading')}</span
			>
			<span class="mt-1 block">{$_('settings.syndication.pitch_body')}</span>
		</p>

		<label
			class="mt-4 flex items-start gap-3 rounded-xl border border-ink-200 p-4 dark:border-ink-700"
		>
			<input
				type="checkbox"
				checked={$firstTradeAnnounce}
				onchange={(e) => setFirstTradeAnnounce(e.currentTarget.checked)}
				class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
			/>
			<div class="min-w-0">
				<p class="font-semibold">
					{$_('settings.syndication.first_trade_label')}
				</p>
				<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
					{$_('settings.syndication.first_trade_help')}
				</p>
			</div>
		</label>
	</section>

	<!-- ─── Hidden accounts (client-side moderation, Q1.4) ─── -->
	<section class="card mt-6" aria-labelledby="hidden-accounts-heading">
		<h2 id="hidden-accounts-heading" class="font-display text-xl font-bold">
			{$_('settings.hidden_accounts.heading')}
		</h2>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.hidden_accounts.explain')}
		</p>
		<p class="mt-2 text-sm text-ink-500">
			{$_('settings.hidden_accounts.scope_note')}
		</p>

		{#if hiddenList.length === 0}
			<div
				class="mt-4 rounded-xl border border-ink-200 bg-ink-50 p-4 text-center text-sm text-ink-500 dark:border-ink-700 dark:bg-ink-900"
			>
				{$_('settings.hidden_accounts.empty')}
			</div>
		{:else}
			<ul
				class="mt-4 divide-y divide-ink-200 overflow-hidden rounded-xl border border-ink-200 dark:divide-ink-800 dark:border-ink-700"
			>
				{#each hiddenList as account (account)}
					<li class="flex items-center justify-between gap-3 bg-ink-50 px-4 py-3 dark:bg-ink-900">
						<IdentityLabel {account} weight="semibold" showCopy={false} />
						<button
							type="button"
							onclick={() => unhideAccount(account)}
							class="rounded-lg border border-ink-300 px-3 py-1 text-xs font-semibold hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-700"
						>
							{$_('settings.hidden_accounts.unhide')}
						</button>
					</li>
				{/each}
			</ul>

			<div class="mt-4">
				{#if !confirmingUnhideAll}
					<button
						type="button"
						onclick={() => (confirmingUnhideAll = true)}
						class="text-sm font-semibold text-red-600 hover:underline dark:text-red-400"
					>
						{$_('settings.hidden_accounts.unhide_all')}
					</button>
				{:else}
					<div
						class="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950"
						role="alertdialog"
						aria-live="polite"
					>
						<p class="text-sm text-amber-900 dark:text-amber-100">
							{$_('settings.hidden_accounts.unhide_all_confirm', {
								values: { count: hiddenList.length }
							})}
						</p>
						<div class="mt-3 flex flex-wrap gap-2">
							<BusyButton
								variant="primary"
								onclick={() => {
									clearAllHidden();
									confirmingUnhideAll = false;
								}}
							>
								{$_('settings.hidden_accounts.unhide_all_confirm_yes')}
							</BusyButton>
							<BusyButton variant="ghost" onclick={() => (confirmingUnhideAll = false)}>
								{$_('settings.hidden_accounts.unhide_all_confirm_cancel')}
							</BusyButton>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</section>

	<!-- ─── Blocked accounts (Finding H layer 1) ─── -->
	<section class="card mt-6" aria-labelledby="blocked-accounts-heading">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<h2 id="blocked-accounts-heading" class="font-display text-xl font-bold">
					{$_('settings.blocked_accounts.heading')}
				</h2>
				<p class="mt-2 text-ink-600 dark:text-ink-300">
					{$_('settings.blocked_accounts.explain')}
				</p>
				<p class="mt-2 text-sm text-ink-500">
					{$_('settings.blocked_accounts.scope_note')}
				</p>
			</div>
			<div class="flex flex-none items-center gap-2">
				{#if blockedRefreshed}
					<span
						class="text-xs font-medium text-emerald-600 dark:text-emerald-400"
						role="status"
						aria-live="polite"
					>
						✓ {$_('settings.blocked_accounts.refreshed')}
					</span>
				{/if}
				<button
					type="button"
					onclick={onRefreshBlocked}
					class="rounded-lg border border-ink-300 px-3 py-1 text-xs font-semibold transition-colors hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-700"
					aria-label={$_('settings.blocked_accounts.refresh_aria') as string}
				>
					{$_('settings.blocked_accounts.refresh')}
				</button>
			</div>
		</div>

		{#if blockedList.length === 0}
			<div
				class="mt-4 rounded-xl border border-ink-200 bg-ink-50 p-4 text-center text-sm text-ink-500 dark:border-ink-700 dark:bg-ink-900"
			>
				{$_('settings.blocked_accounts.empty')}
			</div>
		{:else}
			<ul
				class="mt-4 divide-y divide-ink-200 overflow-hidden rounded-xl border border-ink-200 dark:divide-ink-800 dark:border-ink-700"
			>
				{#each blockedList as account (account)}
					<li class="flex items-center justify-between gap-3 bg-ink-50 px-4 py-3 dark:bg-ink-900">
						<IdentityLabel {account} weight="semibold" showCopy={false} />
						<button
							type="button"
							onclick={() => onUnblock(account)}
							disabled={!$isUnlocked || unblockingSet.has(account)}
							class="rounded-lg border border-ink-300 px-3 py-1 text-xs font-semibold hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald disabled:cursor-not-allowed disabled:opacity-50 dark:border-ink-700"
						>
							{#if unblockingSet.has(account)}
								{$_('settings.blocked_accounts.unblocking')}
							{:else}
								{$_('settings.blocked_accounts.unblock')}
							{/if}
						</button>
					</li>
				{/each}
			</ul>
			{#if !$isUnlocked}
				<p class="mt-3 text-xs text-ink-500">
					{$_('settings.blocked_accounts.locked_hint')}
				</p>
			{/if}
		{/if}
	</section>

	<!-- ─── Preferences (Tier 3.2, Part 99) ─── -->
	<section class="card mt-6" aria-labelledby="preferences-heading">
		<h2 id="preferences-heading" class="font-display text-xl font-bold">
			{$_('settings.preferences.heading')}
		</h2>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.preferences.explain')}
		</p>

		{#if !$userPreferences.fiat && !$userPreferences.region}
			<p class="mt-4 rounded-xl bg-ink-50 p-4 text-sm text-ink-600 dark:bg-ink-950 dark:text-ink-300">
				{$_('settings.preferences.empty')}
			</p>
		{:else}
			<dl class="mt-4 divide-y divide-ink-200 overflow-hidden rounded-xl border border-ink-200 dark:divide-ink-800 dark:border-ink-700">
				{#if $userPreferences.fiat}
					<div class="flex items-center justify-between gap-3 bg-ink-50 px-4 py-3 dark:bg-ink-900">
						<dt class="text-sm font-semibold text-ink-700 dark:text-ink-200">
							{$_('settings.preferences.fiat_label')}
						</dt>
						<dd class="font-mono text-sm">{$userPreferences.fiat}</dd>
					</div>
				{/if}
				{#if $userPreferences.region}
					<div class="flex items-center justify-between gap-3 bg-ink-50 px-4 py-3 dark:bg-ink-900">
						<dt class="text-sm font-semibold text-ink-700 dark:text-ink-200">
							{$_('settings.preferences.region_label')}
						</dt>
						<dd class="font-mono text-sm">{$userPreferences.region}</dd>
					</div>
				{/if}
			</dl>

			<div class="mt-4">
				{#if !confirmingClearPrefs}
					<button
						type="button"
						onclick={() => (confirmingClearPrefs = true)}
						class="text-sm font-semibold text-red-600 hover:underline dark:text-red-400"
					>
						{$_('settings.preferences.clear_button')}
					</button>
				{:else}
					<div
						class="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950"
						role="alertdialog"
						aria-live="polite"
					>
						<p class="text-sm text-amber-900 dark:text-amber-100">
							{$_('settings.preferences.clear_confirm_body')}
						</p>
						<div class="mt-3 flex flex-wrap gap-2">
							<BusyButton
								variant="primary"
								onclick={() => {
									clearPreferences();
									confirmingClearPrefs = false;
								}}
							>
								{$_('settings.preferences.clear_confirm_yes')}
							</BusyButton>
							<BusyButton variant="ghost" onclick={() => (confirmingClearPrefs = false)}>
								{$_('settings.preferences.clear_confirm_cancel')}
							</BusyButton>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</section>

	<!-- ─── Session control ─── -->
	{#if $isUnlocked}
		<section class="card mt-6" aria-labelledby="session-heading">
			<h2 id="session-heading" class="font-display text-xl font-bold">
				{$_('settings.session.heading')}
			</h2>
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('settings.session.explain')}
			</p>

			{#if canChangePassword}
				<!-- Two-factor authentication — sub-route for the full
				     enrollment flow.  Card here is just a link with
				     a one-line summary.  Sub-routes are cleaner than
				     inlining 600 lines of state machine into this
				     already-long settings page. -->
				<div class="mt-6">
					<h3 class="text-base font-semibold">
						{$_('settings.totp.heading')}
					</h3>
					<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
						{$_('settings.totp.subtitle')}
					</p>
					<a
						href={localePath('/settings/security/2fa', ($page.params.lang as LocaleCode) ?? DEFAULT_LOCALE)}
						class="mt-3 inline-block rounded-xl border border-ink-300 px-4 py-2 text-sm font-semibold transition hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-900"
					>
						{$_('settings.totp.enroll.cta')} →
					</a>
				</div>

				<!-- Change password (K1.3).  Only shown to users who
				     chose password-mode at onboarding — seed-only
				     users have no persisted envelope to re-encrypt
				     and rotate their identity by re-importing a
				     fresh seed instead. -->
				<div class="mt-6">
					<h3 class="text-base font-semibold">
						{$_('settings.change_password.heading')}
					</h3>
					<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
						{$_('settings.change_password.help')}
					</p>

					<div class="mt-3 grid gap-3">
						<label class="block">
							<span class="block text-sm font-semibold">
								{$_('settings.change_password.old_label')}
							</span>
							<input
								type="password"
								maxlength="64"
								bind:value={pwOldInput}
								autocomplete="current-password"
								class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
							/>
						</label>

						<label class="block">
							<span class="block text-sm font-semibold">
								{$_('settings.change_password.new_label')}
							</span>
							<input
								type="password"
								maxlength="64"
								bind:value={pwNewInput}
								autocomplete="new-password"
								minlength="8"
								class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
							/>
							{#if pwNewStrength === 'common'}
								<p class="mt-1 text-xs text-red-600 dark:text-red-400">
									⚠ {$_('settings.change_password.strength_common')}
								</p>
							{:else if pwNewStrength === 'trivial'}
								<p class="mt-1 text-xs text-red-600 dark:text-red-400">
									⚠ {$_('settings.change_password.strength_trivial')}
								</p>
							{:else if pwNewStrength === 'short'}
								<p class="mt-1 text-xs text-amber-700 dark:text-amber-400">
									{$_('settings.change_password.strength_short')}
								</p>
							{:else if pwNewStrength === 'ok'}
								<p class="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
									✓ {$_('settings.change_password.strength_ok')}
								</p>
							{/if}
						</label>

						<label class="block">
							<span class="block text-sm font-semibold">
								{$_('settings.change_password.confirm_label')}
							</span>
							<input
								type="password"
								maxlength="64"
								bind:value={pwConfirmInput}
								autocomplete="new-password"
								class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
							/>
							{#if pwConfirmInput.length > 0 && pwNewInput !== pwConfirmInput}
								<p class="mt-1 text-xs text-red-600 dark:text-red-400">
									{$_('settings.change_password.err.mismatch')}
								</p>
							{/if}
						</label>
					</div>

					{#if pwError}
						<p class="mt-3 text-sm text-red-600 dark:text-red-400" role="alert" aria-live="polite">
							{pwError}
						</p>
					{/if}
					{#if pwSuccess}
						<p
							class="mt-3 text-sm text-emerald-700 dark:text-emerald-400"
							role="status"
							aria-live="polite"
						>
							✓ {$_('settings.change_password.success')}
						</p>
					{/if}

					<div class="mt-3">
						<BusyButton
							variant="primary"
							busy={pwBusy}
							disabled={!pwCanSubmit}
							onclick={submitChangePassword}
						>
							{$_('settings.change_password.submit')}
						</BusyButton>
					</div>
				</div>

				<div class="mt-6 border-t border-ink-100 dark:border-ink-800"></div>
			{/if}

			{#if canConfigureAutoLock}
				<!-- Auto-lock timeout. Only shown to users who chose
				     password-mode at onboarding. Default 9 hours per
				     Q5.2 ratification — deliberately long for a
				     trading app where users might walk away for a
				     meal and return to an offer. -->
				<div class="mt-6">
					<label for="autolock-select" class="block text-sm font-semibold">
						{$_('settings.session.autolock_label')}
					</label>
					<p class="mt-1 text-xs text-ink-500 dark:text-ink-400">
						{$_('settings.session.autolock_help')}
					</p>
					<select
						id="autolock-select"
						value={$autoLockTimeoutMinutes === NEVER_LOCK
							? 'never'
							: String($autoLockTimeoutMinutes)}
						onchange={setAutoLock}
						class="mt-3 rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
					>
						<option value="15">{$_('settings.session.autolock_15min')}</option>
						<option value="30">{$_('settings.session.autolock_30min')}</option>
						<option value="60">{$_('settings.session.autolock_1h')}</option>
						<option value="240">{$_('settings.session.autolock_4h')}</option>
						<option value="540">{$_('settings.session.autolock_9h')}</option>
						<option value="1440">{$_('settings.session.autolock_24h')}</option>
						<option value="never">{$_('settings.session.autolock_never')}</option>
					</select>
				</div>

			{/if}
		</section>
	{/if}

	<!-- ─── Hardware key (Batch I, ADR-0017) ─── -->
	<!-- Sits between "Session control" (account credentials) and the
	     end of the page.  Visible to unlocked, password-mode users
	     only — seed-only users have no envelope to bind a hardware
	     key to.  The component itself feature-detects WebHID and
	     renders an "unsupported" card on Firefox/Safari. -->
	{#if $isUnlocked && hasPersistedKeystore()}
		{#await loadHardwareKeyCard() then HardwareKeyCard}
			<HardwareKeyCard />
		{/await}
	{/if}
</div>
