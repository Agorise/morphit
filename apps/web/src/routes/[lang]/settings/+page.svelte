<script lang="ts">
	import { page } from '$app/stores';
	import LazyLoadError from '$components/LazyLoadError.svelte';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import { installPrompt, isInstalled, promptInstall } from '$lib/pwa/installPrompt';
	import {
		validateDisplayName,
		DISPLAY_NAME_MAX_LENGTH,
		validateShortBio,
		SHORT_BIO_MAX_LENGTH
	} from '$crypto/profile';
	import { validateNostrUrl } from '$utils/nostrUrl';
	import { validateWebUrl } from '$utils/webUrl';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import EndpointList from '$components/EndpointList.svelte';
	import Head from '$components/Head.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import ConfirmModal from '$components/ConfirmModal.svelte';
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
	import { hiddenAccounts, unhideAccount, clearAllHidden, refreshHidden } from '$lib/utils/hiddenAccounts';
	import {
		firstTradeAnnounce,
		setFirstTradeAnnounce,
		hasFiredFirstTrade,
		orderBlogDefault,
		setOrderBlogDefault
	} from '$lib/utils/syndicationPrefs';
	import { liveIdentity, isUnlocked, isPairedReadOnly } from '$stores/identity';
	import { getProfile } from '$lib/indexer/client';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import {
		broadcastProfile,
		BroadcastError,
		getUserBlurtAccount,
		setUserBlurtAccount
	} from '$blurt/ops/profile';
	import { formatPublicKeyBLT } from '$crypto/keygen';
	import { AccountBindingError } from '$blurt/accountBinding';
	import { verifyPostingKey } from '$crypto/postingVerify';
	import { fetchAccountKeys } from '$blurt/accountKeys';
	import { ChainRejectedError } from '$blurt/broadcastTransport';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import { checkWaiverEligibility } from '$lib/orders/listingFee';
	import { setSelfAvatar, setSelfDisplayName } from '$lib/stores/selfProfile';
	import { primeProfile } from '$lib/indexer/profileCache';
	import { broadcastUnblock } from '$blurt/ops/block';
	import { blockedAccounts, refreshBlocks, markUnblocked } from '$lib/chat/blocks';
	import { showToast } from '$lib/stores/toast';
	import RequireLiveSession from '$components/RequireLiveSession.svelte';
	import VisibilityBadge from '$components/VisibilityBadge.svelte';

	// cp346: profile-field DRAFTS are scoped per account. These keys used to
	// be global (`morphit.displayName` etc.), so signing out of one account
	// and into another showed the previous account's cached field values in
	// the form (a correctness + privacy bug).
	//
	// v1.8.11 (Ken) — this was a `const` resolved ONCE at component init, on
	// the assumption that "sign-out navigates away → the component remounts on
	// the next login". That assumption is false in an SPA: sign out and sign
	// back in as someone else WITHOUT a page reload and this component is
	// never torn down, so the suffix stays pinned to the PREVIOUS account and
	// the new person is shown the old person's drafts. Exactly what Ken hit
	// going kentest3 → kencode, and the same "captured once, never re-derived"
	// shape as the profile-page reputation bug.
	//
	// Now derived from the session: `$isUnlocked` / `$isPairedReadOnly` flip on
	// both sign-out and sign-in, so the suffix re-resolves at each transition
	// without needing localStorage itself to be reactive. Signed out resolves
	// to '' (the bare legacy key), which is harmless — the rehydrate effect
	// purges those, and sign-out now sweeps them anyway.
	const PROFILE_KEY_SCOPE = $derived.by((): string => {
		if (!browser) return '';
		if (!$isUnlocked && !$isPairedReadOnly) return '';
		return getUserBlurtAccount() ?? '';
	});
	// Syndication card phase. Two signals flip it to the post-first-trade
	// (Phase 2) state, OR'd because they cover different cases:
	//   • hasFiredFirstTrade — the local "first feedback fired" marker, set
	//     by LeaveFeedbackForm once a COMPLETED trade is reviewed. Covers
	//     trading via someone else's order (you have no order of your own).
	//   • hasPlacedOrderOnChain — the account has at least one order in the
	//     index (its free first-buy waiver is consumed). Chain-derived, so
	//     it's robust across devices and covers the common "placed my first
	//     order, haven't completed a trade yet" case. Determined once on
	//     mount via the same /v1/orders check the order form uses for waiver
	//     eligibility; null = not yet known.
	const syndicationAccount = getUserBlurtAccount();
	let hasPlacedOrderOnChain = $state<boolean | null>(null);
	const firstTradeMilestonePast = $derived(
		hasFiredFirstTrade(syndicationAccount) || hasPlacedOrderOnChain === true
	);
	// True once the right phase can render without a wrong-phase flash: no
	// account (nothing to query), the local marker already says "past", or
	// the chain check has resolved.
	const syndicationPhaseKnown = $derived(
		!syndicationAccount || hasFiredFirstTrade(syndicationAccount) || hasPlacedOrderOnChain !== null
	);
	// Resolve the chain-side "has this account placed an order" signal once
	// on mount (browser only; no reactive deps → runs a single time). Drives
	// the syndication phase switch above.
	$effect(() => {
		if (!browser || !syndicationAccount) return;
		let cancelled = false;
		void (async () => {
			try {
				const origin = resolveOrigin(MORPHIT_INDEXER_ORIGIN);
				const result = await checkWaiverEligibility(origin, syndicationAccount);
				if (!cancelled) hasPlacedOrderOnChain = result.kind === 'ineligible_has_orders';
			} catch {
				// Conservative on error: leave Phase 1 so the first-trade
				// announcement opt-in stays offered rather than vanishing.
				if (!cancelled) hasPlacedOrderOnChain = false;
			}
		})();
		return () => {
			cancelled = true;
		};
	});
	// All five must be $derived, not plain consts: they are built FROM the
	// reactive scope above, and a const would freeze at whichever account was
	// signed in when this component first rendered — reintroducing the exact
	// cross-account bug the scope fix removes, one layer down.
	const PROFILE_KEY_SUFFIX = $derived(PROFILE_KEY_SCOPE ? `.${PROFILE_KEY_SCOPE}` : '');
	const STORAGE_KEY = $derived(`morphit.displayName${PROFILE_KEY_SUFFIX}`);
	const NOSTR_URL_STORAGE_KEY = $derived(`morphit.nostrUrl${PROFILE_KEY_SUFFIX}`);
	const STREAMING_URL_STORAGE_KEY = $derived(`morphit.streamingUrl${PROFILE_KEY_SUFFIX}`);
	const WEBSITE_URL_STORAGE_KEY = $derived(`morphit.websiteUrl${PROFILE_KEY_SUFFIX}`);
	const SHORT_BIO_STORAGE_KEY = $derived(`morphit.shortBio${PROFILE_KEY_SUFFIX}`);
	/** The pre-cp346 GLOBAL keys, purged on mount so the leaked drafts don't
	 *  linger (they are never read again once scoping is in effect). */
	const LEGACY_GLOBAL_PROFILE_KEYS = [
		'morphit.displayName',
		'morphit.nostrUrl',
		'morphit.streamingUrl',
		'morphit.websiteUrl',
		'morphit.shortBio'
	] as const;

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

	/** Localized message for a failed "Save & broadcast", shared by every
	 *  broadcast handler on this page. A ChainRejectedError (cp344) carries the
	 *  chain's OWN reason — "missing required posting authority", "insufficient
	 *  mana", etc. — so we surface it instead of the opaque generic copy; that
	 *  is the difference between a user knowing their account is out of resource
	 *  credits vs. staring at "couldn't broadcast, try again". */
	function broadcastErrCopy(err: unknown): string {
		// cp445 — an identity↔account mismatch is a HUMAN problem ("you have two
		// accounts open in two tabs"), not a cryptographic one. It must never
		// reach the user as a chain rejection with three key authorities dumped
		// into a red box. Checked BEFORE ChainRejectedError, because the whole
		// point is that the chain never sees this transaction.
		if (err instanceof AccountBindingError) {
			const owner = err.candidates[0] ?? '';
			if (err.kind === 'key_not_in_authority' || err.kind === 'ambiguous') {
				return $_('settings.display_name.broadcast_err.wrong_account', {
					values: { account: owner }
				});
			}
			if (err.kind === 'no_account_for_key') {
				return $_('settings.display_name.broadcast_err.no_account_for_key');
			}
			return $_('settings.display_name.broadcast_err.lookup_failed');
		}
		if (err instanceof ChainRejectedError) {
			return $_('settings.display_name.broadcast_err.rejected', {
				values: { reason: err.message }
			});
		}
		if (err instanceof BroadcastError && err.code === 'key_mismatch') {
			return $_('settings.display_name.broadcast_err.key_mismatch', {
				values: { account: getUserBlurtAccount() ?? '' }
			});
		}
		if (err instanceof BroadcastError && (err.code === 'no_account' || err.code === 'locked')) {
			return $_(`settings.display_name.broadcast_err.${err.code}`);
		}
		return $_('settings.display_name.broadcast_err.generic');
	}

	// ── Short bio (≤128 chars, optional) — same local/broadcast model ──
	let bioInput = $state('');
	let bioSaved = $state('');
	let bioSaving = $state(false);
	let bioSavedToast = $state(false);
	let bioBroadcasting = $state(false);
	let bioBroadcastError = $state('');
	let bioBroadcastOk = $state(false);

	/** Tier 3.2 (Part 99) — a two-step confirm (like the preferences Clear), but
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
	// Live red-border check: flag any character outside the Blurt
	// account-name charset [a-z0-9.-] so the field paints red as the user
	// types (a half-typed valid name stays green). Tested on the
	// lowercased value since the name is lowercased on verify anyway, so
	// typing/pasting uppercase isn't treated as an error.
	const ACCOUNT_INVALID_CHAR = /[^a-z0-9.-]/;
	const accountInputInvalid = $derived(
		accountInput.trim().length > 0 && ACCOUNT_INVALID_CHAR.test(accountInput.trim().toLowerCase())
	);
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
	let streamingInput = $state('');
	let streamingSaved = $state('');
	let streamingSaving = $state(false);
	let streamingSavedToast = $state(false);
	let streamingBroadcasting = $state(false);
	let streamingBroadcastError = $state('');
	let streamingBroadcastOk = $state(false);
	let websiteInput = $state('');
	let websiteSaved = $state('');
	let websiteSaving = $state(false);
	let websiteSavedToast = $state(false);
	let websiteBroadcasting = $state(false);
	let websiteBroadcastError = $state('');
	let websiteBroadcastOk = $state(false);
	// Streaming URL field placeholder — an animated "someone is typing" cycle of
	// example streaming URLs (same treatment as the orderbook search fields), so
	// grandma sees the KIND of link that belongs here. Pauses while the user has
	// typed something; collapses to one static example under reduced-motion.
	const STREAMING_PLACEHOLDERS = [
		'https://youtube.com/username',
		'https://blurt.media/@username',
		'https://twitch.tv/username',
		'https://rumble.com/c/username'
	] as const;
	let streamingPlaceholder = $state<string>(STREAMING_PLACEHOLDERS[0]);
	const streamingHasText = $derived(streamingInput.trim().length > 0);
	$effect(() => {
		if (streamingHasText) return;
		if (
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			streamingPlaceholder = STREAMING_PLACEHOLDERS[0];
			return;
		}
		const TYPE_MS = 70;
		const DELETE_MS = 35;
		const HOLD_MS = 1600;
		const GAP_MS = 450;
		let urlIdx = 0;
		let charIdx = 0;
		let phase: 'typing' | 'holding' | 'deleting' = 'typing';
		let timer: ReturnType<typeof setTimeout>;
		const tick = (): void => {
			const url = STREAMING_PLACEHOLDERS[urlIdx] ?? STREAMING_PLACEHOLDERS[0];
			if (phase === 'typing') {
				charIdx += 1;
				streamingPlaceholder = url.slice(0, charIdx);
				if (charIdx >= url.length) {
					phase = 'holding';
					timer = setTimeout(tick, HOLD_MS);
				} else {
					timer = setTimeout(tick, TYPE_MS);
				}
			} else if (phase === 'holding') {
				phase = 'deleting';
				timer = setTimeout(tick, DELETE_MS);
			} else {
				charIdx -= 1;
				streamingPlaceholder = url.slice(0, Math.max(charIdx, 0));
				if (charIdx <= 0) {
					phase = 'typing';
					charIdx = 0;
					urlIdx = (urlIdx + 1) % STREAMING_PLACEHOLDERS.length;
					timer = setTimeout(tick, GAP_MS);
				} else {
					timer = setTimeout(tick, DELETE_MS);
				}
			}
		};
		streamingPlaceholder = '';
		timer = setTimeout(tick, GAP_MS);
		return () => clearTimeout(timer);
	});

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
	/** Avatar size thresholds, MIRRORED from `$lib/avatar` (MAX_AVATAR_BYTES /
	 *  SOFT_WARN_AVATAR_BYTES).
	 *
	 *  Mirrored rather than imported because `$lib/avatar` carries the SVG
	 *  sanitizer, minifier and raster encoder, and is deliberately lazy-imported
	 *  so none of that lands in the initial bundle just to render a settings
	 *  page. `avatar-size-thresholds-smoke` pins these two numbers to the
	 *  module's exports so the mirror cannot drift.
	 *
	 *  v1.8.10 (Ken) — these were previously hardcoded as 2048 (warn) and 3072
	 *  (cap), and BOTH were wrong. The real cap is 6144, so the preview told
	 *  users "of 3.0 KB maximum" for a limit that did not exist, and a 3.5 KB
	 *  image was reported as over a maximum it was comfortably under. The warn
	 *  threshold sat at 2048 — 33% of the actual cap — so a perfectly fine
	 *  2.9 KB avatar was shown a red error saying it was near a limit it was
	 *  nowhere near. Ken hit both. */
	const AVATAR_CAP_BYTES = 6144;
	const AVATAR_SOFT_WARN_BYTES = 4096;
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
	/** The avatar currently on chain (mirrors hasCustomAvatar). Used to
	 *  show a thumbnail next to the "Remove avatar" button so the user
	 *  sees exactly what they're about to remove. */
	let currentAvatarSvg = $state<string | null>(null);
	let currentAvatarDataUri = $state<string | null>(null);
	/** Drives the "Remove avatar?" confirmation modal. */
	let confirmRemoveAvatarOpen = $state(false);
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
			const bm = window.localStorage.getItem(STREAMING_URL_STORAGE_KEY);
			if (bm) {
				streamingSaved = bm;
				streamingInput = bm;
			}
			const ws = window.localStorage.getItem(WEBSITE_URL_STORAGE_KEY);
			if (ws) {
				websiteSaved = ws;
				websiteInput = ws;
			}
			const bio = window.localStorage.getItem(SHORT_BIO_STORAGE_KEY);
			if (bio) {
				bioSaved = bio;
				bioInput = bio;
			}
			const n = window.localStorage.getItem(NOSTR_URL_STORAGE_KEY);
			if (n) {
				nostrSaved = n;
				nostrInput = n;
			}
			// cp346: which fields have NO local draft for this account? Those get
			// hydrated from the on-chain profile below — so a freshly-imported
			// account (or this account on a new device) shows its real on-chain
			// values instead of blanks. A local draft is a pending edit and wins.
			const noLocalName = !s;
			const noLocalStreaming = !bm;
			const noLocalWebsite = !ws;
			const noLocalBio = !bio;
			const noLocalNostr = !n;
			// Hydrate the account-name section.  If posting-WIF
			// import was used, this is already set; otherwise
			// it's null and the user sees the empty input.
			const acct = getUserBlurtAccount();
			if (acct) {
				accountSaved = acct;
				accountInput = acct;
				// cp346: purge the pre-scoping GLOBAL profile keys so a previous
				// account's leaked drafts don't linger. Safe — the scoped keys
				// above (which carry `.${acct}`) are never these bare names while
				// logged in, so this never deletes the current account's draft.
				for (const legacy of LEGACY_GLOBAL_PROFILE_KEYS) {
					try {
						window.localStorage.removeItem(legacy);
					} catch {
						// Privacy Mode — nothing to purge.
					}
				}
				// One-shot, best-effort profile fetch: drives the "Remove avatar"
				// button (only shown when an avatar exists on chain) AND hydrates
				// the editable fields that have no local draft (cp346). Failure
				// leaves the avatar button hidden + the fields empty — safe.
				if (!avatarExistenceChecked) {
					avatarExistenceChecked = true;
					void (async () => {
						try {
							const r = await getProfile(acct);
							if (r.ok) {
								const props = extractLabelPropsFromProfile(r.data);
								hasCustomAvatar = !!(props.avatarSvg || props.avatarDataUri);
								currentAvatarSvg = props.avatarSvg;
								currentAvatarDataUri = props.avatarDataUri;
								// Only fill from on-chain where the user has no pending
								// local draft for this account.
								if (noLocalName && props.displayName) {
									saved = props.displayName;
									input = props.displayName;
								}
								if (noLocalStreaming && props.streamingUrl) {
									streamingSaved = props.streamingUrl;
									streamingInput = props.streamingUrl;
								}
								if (noLocalWebsite && props.websiteUrl) {
									websiteSaved = props.websiteUrl;
									websiteInput = props.websiteUrl;
								}
								if (noLocalBio && props.shortBio) {
									bioSaved = props.shortBio;
									bioInput = props.shortBio;
								}
								if (noLocalNostr && props.nostrUrl) {
									nostrSaved = props.nostrUrl;
									nostrInput = props.nostrUrl;
								}
							}
						} catch {
							// Indexer unreachable / no profile — leave hidden + empty.
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

	// v1.8.10 (Ken): pass the signed-in account so the reserved-name guard can
	// exempt its rightful owner — @agorise setting "Agorise" is not
	// impersonation. `?? undefined` keeps the strict behaviour for a signed-out
	// or unknown session rather than passing an empty string that matches
	// nothing. The indexer re-checks against the chain-authenticated signer and
	// is the authority; this only stops the FORM rejecting what the chain allows.
	const validation = $derived(validateDisplayName(input, getUserBlurtAccount() ?? undefined));
	/** v1.5.0 (t.txt line 5): the field has been emptied while a name is still
	 *  saved — a "remove my display name" intent. An empty name is otherwise
	 *  invalid (too short), so this gates the Save buttons + handlers to allow
	 *  saving the removal. */
	const clearing = $derived(input.trim().length === 0 && saved.length > 0);
	const remaining = $derived(DISPLAY_NAME_MAX_LENGTH - [...input].length);

	const bioValidation = $derived(validateShortBio(bioInput));
	/** v1.5.0 (t.txt line 5): bio counterpart of `clearing`. */
	const bioClearing = $derived(bioInput.trim().length === 0 && bioSaved.length > 0);
	const bioRemaining = $derived(SHORT_BIO_MAX_LENGTH - [...bioInput].length);

	// Blurt.media URL validation. Same contract as Nostr —
	// null = empty/unset, { ok: true } = valid, { ok: false } = error.
	const streamingValidation = $derived(validateWebUrl(streamingInput));
	const streamingIsEmpty = $derived(streamingInput.trim().length === 0);
	const streamingIsValid = $derived(
		streamingIsEmpty ||
			(streamingValidation !== null && 'ok' in streamingValidation && streamingValidation.ok)
	);
	const streamingCleaned = $derived(
		streamingValidation && 'ok' in streamingValidation && streamingValidation.ok
			? streamingValidation.cleaned
			: ''
	);
	const streamingErrorReason = $derived(
		streamingValidation && 'ok' in streamingValidation && !streamingValidation.ok
			? streamingValidation.reason
			: null
	);

	// Website / blog URL validation. Same contract as the streaming field —
	// null = empty/unset, { ok: true } = valid, { ok: false } = error. Any
	// http/https host is accepted (the only rule: a valid URL).
	const websiteValidation = $derived(validateWebUrl(websiteInput));
	const websiteIsEmpty = $derived(websiteInput.trim().length === 0);
	const websiteIsValid = $derived(
		websiteIsEmpty ||
			(websiteValidation !== null && 'ok' in websiteValidation && websiteValidation.ok)
	);
	const websiteCleaned = $derived(
		websiteValidation && 'ok' in websiteValidation && websiteValidation.ok
			? websiteValidation.cleaned
			: ''
	);
	const websiteErrorReason = $derived(
		websiteValidation && 'ok' in websiteValidation && !websiteValidation.ok
			? websiteValidation.reason
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

	/** cp452 (t.txt 2 + 3) — optimistically publish the user's CURRENT profile
	 *  (all fields, from the just-saved component state) into the shared profile
	 *  cache after a CONFIRMED broadcast, so the orderbook + every self
	 *  IdentityLabel reflect the edit within a frame instead of after the 90s
	 *  cache TTL. Held through indexer catch-up by profileCache's PRIME_HOLD_MS,
	 *  then normal fetches re-confirm from chain. Every broadcast path below
	 *  writes the WHOLE profile on-chain, so priming the whole profile keeps the
	 *  cached entry complete (a partial prime would blank the untouched fields). */
	function primeSelfProfile(): void {
		primeProfile(getUserBlurtAccount() ?? '', {
			displayName: saved,
			avatarSvg: currentAvatarSvg,
			avatarDataUri: currentAvatarDataUri,
			shortBio: bioSaved || null,
			nostrUrl: nostrSaved || null,
			streamingUrl: streamingSaved || null,
			websiteUrl: websiteSaved || null
		});
	}

	async function saveLocal(): Promise<void> {
		if (!validation.ok && !clearing) return;
		saving = true;
		const cleaned = validation.cleaned;
		try {
			if (cleaned.length === 0) window.localStorage.removeItem(STORAGE_KEY);
			else window.localStorage.setItem(STORAGE_KEY, cleaned);
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
			// Include nostr_url and streaming_url in the broadcast
			// so all profile fields stay in sync on-chain. The
			// indexer stores the whole json_metadata blob, and
			// IdentityLabel reads specific keys out of it on every
			// render site.
			await broadcastProfile(live, {
				display_name: saved,
				nostr_url: nostrCleaned || undefined,
				streaming_url: streamingCleaned || undefined,
				website_url: websiteCleaned || undefined,
				short_bio: bioSaved
			});
			broadcastOk = true;
			// v1.8.15 (t.txt #2) — confirmed on-chain: publish the new name to the
			// shared self-profile store so the avatar menu + every IdentityLabel of
			// self show it INSTANTLY (the avatar-save path already does this via
			// setSelfAvatar; the name path didn't, so a new name only appeared once
			// the indexer caught up ~45-63s later).
			setSelfDisplayName(getUserBlurtAccount() ?? '', saved);
			primeSelfProfile();
			setTimeout(() => (broadcastOk = false), 3000);
		} catch (err) {
			console.warn('[settings] display-name broadcast failed:', err);
			broadcastError = broadcastErrCopy(err);
		} finally {
			broadcasting = false;
		}
	}

	// ── Short bio — save locally, or save + broadcast ──────────────
	async function saveBioLocal(): Promise<void> {
		if (!bioValidation.ok && !bioClearing) return;
		bioSaving = true;
		const cleaned = bioValidation.cleaned;
		try {
			if (cleaned) window.localStorage.setItem(SHORT_BIO_STORAGE_KEY, cleaned);
			else window.localStorage.removeItem(SHORT_BIO_STORAGE_KEY);
		} catch {
			// Privacy Mode; keeps the change in memory only.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		bioSaved = cleaned;
		bioInput = cleaned;
		bioSaving = false;
		bioSavedToast = true;
		setTimeout(() => (bioSavedToast = false), 1800);
	}

	async function saveAndBroadcastBio(): Promise<void> {
		await saveBioLocal();
		const live = $liveIdentity;
		if (!live) return;
		bioBroadcasting = true;
		bioBroadcastError = '';
		bioBroadcastOk = false;
		try {
			// Carry every profile field so the whole json_metadata blob
			// stays in sync on-chain (same discipline as the display-name
			// broadcast).
			await broadcastProfile(live, {
				display_name: saved,
				nostr_url: nostrSaved,
				streaming_url: streamingSaved,
				website_url: websiteSaved,
				short_bio: bioSaved
			});
			bioBroadcastOk = true;
			primeSelfProfile();
			setTimeout(() => (bioBroadcastOk = false), 3000);
		} catch (err) {
			console.warn('[settings] short-bio broadcast failed:', err);
			bioBroadcastError = broadcastErrCopy(err);
		} finally {
			bioBroadcasting = false;
		}
	}

	// ── Blurt.media URL — save locally, or save + broadcast ─────────
	async function saveStreamingLocal(): Promise<void> {
		if (!streamingIsValid) return;
		streamingSaving = true;
		const cleaned = streamingIsEmpty ? '' : streamingCleaned;
		try {
			if (cleaned) {
				window.localStorage.setItem(STREAMING_URL_STORAGE_KEY, cleaned);
			} else {
				window.localStorage.removeItem(STREAMING_URL_STORAGE_KEY);
			}
		} catch {
			// Privacy Mode; in-memory only.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		streamingSaved = cleaned;
		streamingInput = cleaned;
		streamingSaving = false;
		streamingSavedToast = true;
		setTimeout(() => (streamingSavedToast = false), 1800);
	}

	async function saveAndBroadcastStreaming(): Promise<void> {
		await saveStreamingLocal();
		const live = $liveIdentity;
		if (!live) return;
		const displayName = saved || (validation.ok ? validation.cleaned : '');
		streamingBroadcasting = true;
		streamingBroadcastError = '';
		streamingBroadcastOk = false;
		try {
			// Broadcast ALL known profile fields together so the
			// indexer's stored json_metadata reflects the user's full
			// intent. Omitting nostr_url here would orphan any
			// previously-broadcast Nostr URL.
			await broadcastProfile(live, {
				display_name: displayName,
				nostr_url: nostrSaved,
				streaming_url: streamingSaved,
				website_url: websiteSaved,
				short_bio: bioSaved
			});
			streamingBroadcastOk = true;
			primeSelfProfile();
			setTimeout(() => (streamingBroadcastOk = false), 3000);
		} catch (err) {
			console.warn('[settings] broadcast failed:', err);
			streamingBroadcastError = broadcastErrCopy(err);
		} finally {
			streamingBroadcasting = false;
		}
	}

	// ── Website / blog URL — save locally, or save + broadcast ──────────
	async function saveWebsiteLocal(): Promise<void> {
		if (!websiteIsValid) return;
		websiteSaving = true;
		const cleaned = websiteIsEmpty ? '' : websiteCleaned;
		try {
			if (cleaned) {
				window.localStorage.setItem(WEBSITE_URL_STORAGE_KEY, cleaned);
			} else {
				window.localStorage.removeItem(WEBSITE_URL_STORAGE_KEY);
			}
		} catch {
			// Privacy Mode; in-memory only.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		websiteSaved = cleaned;
		websiteInput = cleaned;
		websiteSaving = false;
		websiteSavedToast = true;
		setTimeout(() => (websiteSavedToast = false), 1800);
	}

	async function saveAndBroadcastWebsite(): Promise<void> {
		await saveWebsiteLocal();
		const live = $liveIdentity;
		if (!live) return;
		const displayName = saved || (validation.ok ? validation.cleaned : '');
		websiteBroadcasting = true;
		websiteBroadcastError = '';
		websiteBroadcastOk = false;
		try {
			await broadcastProfile(live, {
				display_name: displayName,
				nostr_url: nostrSaved,
				streaming_url: streamingSaved,
				website_url: websiteSaved,
				short_bio: bioSaved
			});
			websiteBroadcastOk = true;
			primeSelfProfile();
			setTimeout(() => (websiteBroadcastOk = false), 3000);
		} catch (err) {
			console.warn('[settings] broadcast failed:', err);
			websiteBroadcastError = broadcastErrCopy(err);
		} finally {
			websiteBroadcasting = false;
		}
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

	async function saveAndBroadcastNostr(): Promise<void> {
		await saveNostrLocal();
		const live = $liveIdentity;
		if (!live) return;
		// Broadcast requires a display_name (indexer validates
		// min length 1). Use the saved one, or fall back to the
		// Broadcast the full profile bag so we don't orphan any
		// previously-set field. A missing display name is fine —
		// the field is simply omitted from json_metadata.
		const displayName = saved || (validation.ok ? validation.cleaned : '');
		nostrBroadcasting = true;
		nostrBroadcastError = '';
		nostrBroadcastOk = false;
		try {
			await broadcastProfile(live, {
				display_name: displayName,
				nostr_url: nostrSaved,
				streaming_url: streamingSaved,
				website_url: websiteSaved,
				short_bio: bioSaved
			});
			nostrBroadcastOk = true;
			primeSelfProfile();
			setTimeout(() => (nostrBroadcastOk = false), 3000);
		} catch (err) {
			console.warn('[settings] broadcast failed:', err);
			nostrBroadcastError = broadcastErrCopy(err);
		} finally {
			nostrBroadcasting = false;
		}
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
		const displayName = saved || (validation.ok ? validation.cleaned : '');
		avatarBroadcasting = true;
		avatarBroadcastError = '';
		avatarBroadcastOk = false;
		try {
			await broadcastProfile(live, {
				display_name: displayName,
				nostr_url: nostrSaved,
				streaming_url: streamingSaved,
				website_url: websiteSaved,
				short_bio: bioSaved,
				// Pass BOTH fields explicitly so the indexer knows
				// exactly which one is active; empty string clears
				// the other half of the pair.
				avatar_svg: avatarStagedSvg,
				avatar_data_uri: avatarStagedDataUri
			});
			hasCustomAvatar = true;
			currentAvatarSvg = avatarStagedSvg || null;
			currentAvatarDataUri = avatarStagedDataUri || null;
			// Confirmed on-chain — publish to the shared self-profile
			// store so the avatar menu + every IdentityLabel of self
			// update instantly (don't wait for the indexer to catch up).
			setSelfAvatar(
				getUserBlurtAccount() ?? '',
				avatarStagedSvg || null,
				avatarStagedDataUri || null
			);
			avatarBroadcastOk = true;
			primeSelfProfile();
			setTimeout(() => (avatarBroadcastOk = false), 3000);
		} catch (err) {
			console.warn('[settings] broadcast failed:', err);
			avatarBroadcastError = broadcastErrCopy(err);
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
		avatarBroadcasting = true;
		avatarBroadcastError = '';
		avatarBroadcastOk = false;
		try {
			await broadcastProfile(live, {
				display_name: displayName,
				nostr_url: nostrSaved,
				streaming_url: streamingSaved,
				website_url: websiteSaved,
				short_bio: bioSaved,
				avatar_svg: '',
				avatar_data_uri: ''
			});
			hasCustomAvatar = false;
			currentAvatarSvg = null;
			currentAvatarDataUri = null;
			// Confirmed removal on-chain — clear the shared self avatar
			// so menu + labels fall back to the identicon immediately.
			setSelfAvatar(getUserBlurtAccount() ?? '', null, null);
			// Clear any local staging — the on-chain state is now
			// "no avatar", and the UI should reflect that.
			avatarStagedSvg = '';
			avatarStagedDataUri = '';
			avatarStagedBytes = 0;
			avatarBroadcastOk = true;
			primeSelfProfile();
			setTimeout(() => (avatarBroadcastOk = false), 3000);
		} catch (err) {
			console.warn('[settings] broadcast failed:', err);
			avatarBroadcastError = broadcastErrCopy(err);
		} finally {
			avatarBroadcasting = false;
		}
	}

	/** Format a byte count for the UI ("2,048 B / 3 KB cap"). */
	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		return `${(n / 1024).toFixed(1)} KB`;
	}

	// Auto-lock timeout handler. Parses the <select> value — the
	// 'never' option maps to the NEVER_LOCK sentinel, all others are
	// numeric minutes. Setting immediately persists via
	// writeTimeoutMinutes and the store reflects the change.
	// Transient "Changed to …" confirmation shown next to the auto-lock
	// select. Lives only while this page is mounted — navigating away
	// (component unmount) clears it, which is exactly the desired
	// "gone once you leave the page" behavior.
	let autoLockChanged = $state('');
	function autoLockLabelKey(v: string): string {
		switch (v) {
			case '15':
				return 'settings.session.autolock_15min';
			case '30':
				return 'settings.session.autolock_30min';
			case '60':
				return 'settings.session.autolock_1h';
			case '240':
				return 'settings.session.autolock_4h';
			case '540':
				return 'settings.session.autolock_9h';
			case '1440':
				return 'settings.session.autolock_24h';
			case 'never':
				return 'settings.session.autolock_never';
			default:
				return '';
		}
	}
	function setAutoLock(event: Event): void {
		const v = (event.target as HTMLSelectElement).value;
		if (v === 'never') {
			writeTimeoutMinutes(NEVER_LOCK);
		} else {
			const n = parseInt(v, 10);
			if (!isNaN(n)) writeTimeoutMinutes(n);
		}
		// The change is applied immediately above (no submit button);
		// surface a confirmation with the new option's label.
		const key = autoLockLabelKey(v);
		if (key) {
			autoLockChanged = $_('settings.session.autolock_changed', {
				values: { label: $_(key) }
			});
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
	/** v1.5.0 — briefly true after a manual refresh so the Hidden card can
	 *  flash a "Refreshed!" confirmation (~2s), mirroring the Blocked card. */
	let hiddenRefreshed = $state(false);
	let hiddenRefreshedTimer: ReturnType<typeof setTimeout> | null = null;
	function onRefreshHidden(): void {
		refreshHidden();
		hiddenRefreshed = true;
		if (hiddenRefreshedTimer) clearTimeout(hiddenRefreshedTimer);
		hiddenRefreshedTimer = setTimeout(() => (hiddenRefreshed = false), 2000);
	}

	// ─── Blocked accounts (Finding H layer 1) ───────────────────
	/** Sorted alphabetically so the list is stable across unblocks.
	 *  An effect below calls refreshBlocks on every mount so the list
	 *  reflects the indexer's current truth by the time the user scrolls
	 *  to it (not a stale session cache). */
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
		// Force a fresh fetch on every mount — NOT loadBlocks(), which
		// early-returns once the store has loaded once in the session, so
		// after navigating away and back the card would show the stale
		// cached set (e.g. empty, or a block the indexer has since
		// confirmed/dropped) until the user hit Refresh manually. The
		// store's own contract documents refreshBlocks() as the
		// Settings-mount entry point; the previous loadBlocks() defeated
		// it. refreshBlocks keeps the current value visible during the
		// in-flight fetch (it only .set()s on success), so there's no
		// empty flash. Best-effort: on failure the list stays as-is and
		// the manual Refresh retries.
		void refreshBlocks(me);
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
	<RequireLiveSession />
	<header class="mb-8">
		<h1 class="font-display text-3xl font-extrabold md:text-4xl">
			<span class="brand-gradient-text">{$_('settings.title')}</span>
		</h1>
		<p class="mt-2 text-ink-600 dark:text-ink-300">{$_('settings.subtitle')}</p>
	</header>

	{#if $isPairedReadOnly}
		<!-- Paired-readonly session (ADR-0022 QR-pair, Option A).  The
		     edit forms on this page all sign with the posting key
		     (display-name, website, streaming, nostr, avatar, syndication,
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
		<div class="mt-1"><VisibilityBadge scope="device" /></div>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.account_name.explain')}
		</p>

		{#if accountSaved}
			<div class="mt-4 rounded-2xl bg-ink-50 p-4 dark:bg-ink-950">
				<p class="mb-1 text-xs font-semibold uppercase tracking-widest text-ink-500">
					{$_('settings.account_name.current_label')}
				</p>
				<IdentityLabel account={accountSaved} weight="bold" avatarSize={40} showCopy={false} />
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
					oninput={(e) => {
						const el = e.currentTarget;
						const stripped = el.value.replace(/@/g, '');
						if (stripped !== el.value) {
							const removed = el.value.length - stripped.length;
							const caret = (el.selectionStart ?? stripped.length) - removed;
							el.value = stripped;
							accountInput = stripped;
							const p = Math.max(0, caret);
							el.setSelectionRange(p, p);
						}
					}}
					maxlength="16"
					type="text"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					placeholder={$_('settings.account_name.input_placeholder')}
					class="input w-full font-mono {accountInputInvalid
						? 'border-red-400 focus:ring-red-400 dark:border-red-500'
						: ''}"
					disabled={!$isUnlocked || accountVerifying}
				/>
			</label>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_('settings.account_name.input_hint')}
			</p>
			<!-- Reciprocal cross-link: this card VERIFIES an existing name
			     (the import path). A brand-new user who skipped signup
			     step 4 has no account to verify — send them to claim one. -->
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				<a
					href={lp('/onboarding/register-name')}
					class="underline underline-offset-2 hover:no-underline"
				>
					{$_('settings.account_name.no_account_link')}
				</a>
			</p>
			{#if !$isUnlocked}
				<p class="mt-3 text-sm text-red-700 dark:text-red-300">
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
					size="sm"
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

	<!-- ─── Avatar ─── -->
	<section class="card mt-6" aria-labelledby="avatar-heading">
		<h2 id="avatar-heading" class="font-display text-xl font-bold">
			{$_('settings.avatar.heading')}
		</h2>
		<div class="mt-1"><VisibilityBadge scope="public" /></div>
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
		     delete, no takedown. cp512 [S3]: once a custom avatar is
		     already on chain the user has crossed this bridge, so the
		     warning is just noise — hide it. -->
		{#if !hasCustomAvatar}
			<div
				class="mt-4 rounded-xl border-2 border-red-500/60 bg-red-50 p-4 text-sm dark:border-red-500/50 dark:bg-red-900/20"
				role="note"
			>
				<p class="font-semibold text-red-900 dark:text-red-200">
					⚠ {$_('settings.avatar.permanence_heading')}
				</p>
				<p class="mt-1 text-red-900 dark:text-red-100">
					{$_('settings.avatar.permanence_body')}
				</p>
			</div>
		{/if}

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
				<div class="flex flex-wrap items-center gap-4">
					<IdentityLabel
						displayName={saved || $_('settings.avatar.preview_display_name_placeholder')}
						publicKey={previewPubkey}
						avatarSvg={avatarStagedSvg || null}
						avatarDataUri={avatarStagedDataUri || null}
						avatarSize={96}
					/>
					<!-- v1.8.10 (Ken): `min-w-0 flex-1` stops this column being squeezed
					     into a two-words-per-line ribbon beside the 96px avatar. It had
					     no width basis at all, so the flex row gave it whatever was
					     left; on a narrow card that was almost nothing. flex-wrap on the
					     row lets it drop below the avatar rather than shrink to
					     unreadable. -->
					<div class="min-w-0 flex-1 text-sm text-ink-500">
						<p>
							{$_('settings.avatar.preview_size', {
								values: {
									bytes: formatBytes(avatarStagedBytes),
									cap: formatBytes(AVATAR_CAP_BYTES)
								}
							})}
						</p>
						<!-- Three distinct states, because they call for three different
						     actions. Previously ONE message ("getting close to the size
						     limit") covered every case above a 2048 threshold that bore no
						     relation to the real 6144 cap — so it fired on files that were
						     comfortably fine, and said the same reassuring "getting close"
						     about a file that was actually OVER the limit and could not be
						     broadcast at all. -->
						{#if avatarStagedBytes > AVATAR_CAP_BYTES}
							<p class="mt-1 text-red-600 dark:text-red-400">
								{$_('settings.avatar.preview_too_large', {
									values: { cap: formatBytes(AVATAR_CAP_BYTES) }
								})}
							</p>
						{:else if avatarStagedBytes > AVATAR_SOFT_WARN_BYTES}
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
					size="sm"
					busy={avatarBroadcasting}
					done={avatarBroadcastOk}
					busyLabel={$_('common.broadcasting')}
					onclick={broadcastAvatar}
				>
					{#if avatarBroadcastOk}
						{$_('common.broadcasted')}
					{:else}
						{$_('settings.avatar.broadcast')}
					{/if}
				</BusyButton>
				<BusyButton variant="ghost" onclick={cancelAvatar}>
					{$_('settings.avatar.cancel')}
				</BusyButton>
			{/if}
			{#if $isUnlocked && !avatarStagedSvg && !avatarStagedDataUri && hasCustomAvatar}
				<div class="flex items-center gap-3">
					{#if currentAvatarSvg}
						<span
							class="h-12 w-12 flex-none overflow-hidden rounded-full bg-ink-100 ring-1 ring-ink-200 dark:bg-ink-800 dark:ring-ink-700 [&>svg]:h-full [&>svg]:w-full"
							aria-hidden="true"
						>
							{@html currentAvatarSvg}
						</span>
					{:else if currentAvatarDataUri}
						<img
							src={currentAvatarDataUri}
							alt=""
							width="48"
							height="48"
							class="h-12 w-12 flex-none rounded-full bg-ink-100 object-cover ring-1 ring-ink-200 dark:bg-ink-800 dark:ring-ink-700"
							aria-hidden="true"
							decoding="async"
						/>
					{/if}
					<BusyButton
						variant="ghost"
						busy={avatarBroadcasting}
						busyLabel={$_('settings.avatar.remove_pending')}
						onclick={() => (confirmRemoveAvatarOpen = true)}
					>
						{$_('settings.avatar.remove')}
					</BusyButton>
				</div>
			{/if}
		</div>

		{#if avatarBroadcastError}
			<div class="mt-3">
				<StatusLine kind="error">{avatarBroadcastError}</StatusLine>
			</div>
		{/if}

		<ConfirmModal
			bind:open={confirmRemoveAvatarOpen}
			title={$_('settings.avatar.remove_confirm_title')}
			body={$_('settings.avatar.remove_confirm_body')}
			confirmLabel={$_('settings.avatar.remove')}
			cancelLabel={$_('settings.avatar.cancel')}
			variant="destructive"
			busyLabel={$_('settings.avatar.remove_pending')}
			onConfirm={async () => {
				await broadcastRemoveAvatar();
				confirmRemoveAvatarOpen = false;
			}}
			onCancel={() => (confirmRemoveAvatarOpen = false)}
		/>
	</section>

	<!-- ─── Display name ─── -->
	<section class="card mt-6" aria-labelledby="display-name-heading">
		<h2 id="display-name-heading" class="font-display text-xl font-bold">
			{$_('settings.display_name.heading')}
		</h2>
		<div class="mt-1"><VisibilityBadge scope="public" /></div>
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
				class="w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-base focus:outline-none dark:border-ink-700 dark:bg-ink-950"
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
				variant="secondary-quiet"
				size="sm"
				busy={saving}
				done={savedToast}
				disabled={!clearing && (!validation.ok || validation.cleaned === saved)}
				busyLabel={$_('common.saving')}
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
					variant="primary"
					size="sm"
					busy={broadcasting}
					done={broadcastOk}
					disabled={!clearing && !validation.ok}
					busyLabel={$_('settings.display_name.broadcast_pending')}
					onclick={saveAndBroadcast}
				>
					{#if broadcastOk}
						{$_('common.broadcasted')}
					{:else}
						{$_('settings.display_name.save_and_broadcast')}
					{/if}
				</BusyButton>
			{/if}
		</div>

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

	<!-- ─── Short bio ─── -->
	<section class="card mt-6" aria-labelledby="short-bio-heading">
		<h2 id="short-bio-heading" class="font-display text-xl font-bold">
			{$_('settings.short_bio.heading')}
		</h2>
		<div class="mt-1"><VisibilityBadge scope="public" /></div>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.short_bio.explain')}
		</p>

		<label class="mt-5 block">
			<span class="mb-2 block font-semibold">{$_('settings.short_bio.input_label')}</span>
			<textarea
				bind:value={bioInput}
				dir="auto"
				rows="2"
				maxlength={SHORT_BIO_MAX_LENGTH * 4}
				autocomplete="off"
				placeholder={$_('settings.short_bio.placeholder')}
				class="w-full resize-none rounded-xl border border-ink-200 bg-white px-3 py-2 text-base focus:outline-none dark:border-ink-700 dark:bg-ink-950"
			></textarea>
		</label>

		<div class="mt-2 flex items-center justify-between text-sm">
			<p class="text-ink-500">
				{#if bioInput && !bioValidation.ok}
					<span class="text-red-600 dark:text-red-400">{$_(bioValidation.reasonKey)}</span>
				{:else if bioInput}
					<span class="text-ink-500">{$_('settings.short_bio.hint')}</span>
				{/if}
			</p>
			<p class="text-ink-500" class:text-red-600={bioRemaining < 0}>
				{bioRemaining}
			</p>
		</div>

		<div class="mt-6 flex flex-wrap items-center gap-3">
			<BusyButton
				variant="secondary-quiet"
				size="sm"
				busy={bioSaving}
				done={bioSavedToast}
				disabled={!bioClearing && (!bioValidation.ok || bioValidation.cleaned === bioSaved)}
				busyLabel={$_('common.saving')}
				onclick={saveBioLocal}
			>
				{#if bioSavedToast}
					{$_('settings.display_name.saved_toast')}
				{:else}
					{$_('settings.display_name.save')}
				{/if}
			</BusyButton>
			{#if $isUnlocked}
				<BusyButton
					variant="primary"
					size="sm"
					busy={bioBroadcasting}
					done={bioBroadcastOk}
					disabled={!bioClearing && !bioValidation.ok}
					busyLabel={$_('settings.display_name.broadcast_pending')}
					onclick={saveAndBroadcastBio}
				>
					{#if bioBroadcastOk}
						{$_('common.broadcasted')}
					{:else}
						{$_('settings.display_name.save_and_broadcast')}
					{/if}
				</BusyButton>
			{/if}
		</div>

		{#if bioBroadcastError}
			<div class="mt-3">
				<StatusLine kind="error">{bioBroadcastError}</StatusLine>
			</div>
		{/if}

		{#if bioBroadcastOk}
			<p class="mt-3 text-sm text-ink-600 dark:text-ink-300" aria-live="polite">
				{$_('settings.short_bio.broadcast_ok_detail')}
			</p>
		{/if}
	</section>

	<!-- ─── Website / Blog URL ─── -->
	<!-- Rendered ABOVE the Streaming card: a personal site/blog is the most
	     general "who am I" link, so it leads. New on-chain field website_url;
	     a globe glyph shows next to the avatar on the profile page. -->
	<section
		class="card card-watermark mt-6"
		style="--card-watermark: url('/icons/icon-globe.svg')"
		aria-labelledby="website-url-heading"
	>
		<h2 id="website-url-heading" class="font-display text-xl font-bold">
			{$_('settings.website_url.heading')}
		</h2>
		<div class="mt-1"><VisibilityBadge scope="public" /></div>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.website_url.explain')}
		</p>

		<label for="website-url-input" class="sr-only">
			{$_('settings.website_url.label')}
		</label>
		<input
			id="website-url-input"
			type="text"
			autocomplete="url"
			inputmode="url"
			spellcheck="false"
			bind:value={websiteInput}
			maxlength="512"
			placeholder={$_('settings.website_url.placeholder')}
			aria-invalid={!websiteIsValid}
			aria-describedby="website-url-help"
			class="mt-4 w-full rounded-xl border bg-white px-3 py-2 font-mono text-sm transition-colors focus:outline-none dark:bg-ink-900 {!websiteIsValid
				? 'border-red-500 focus:ring-2 focus:ring-red-500 dark:border-red-500'
				: 'border-ink-300 dark:border-ink-700'}"
		/>

		<p id="website-url-help" class="mt-2 text-sm">
			{#if websiteErrorReason === 'too_long'}
				<span class="text-red-600">
					{$_('settings.website_url.error.too_long')}
				</span>
			{:else if websiteErrorReason === 'invalid_scheme'}
				<span class="text-red-600">
					{$_('settings.website_url.error.invalid_scheme')}
				</span>
			{:else if websiteErrorReason === 'malformed'}
				<span class="text-red-600">
					{$_('settings.website_url.error.malformed')}
				</span>
			{:else if websiteIsEmpty}
				<span class="text-ink-500">
					{$_('settings.website_url.hint_empty')}
				</span>
			{:else}
				<span class="text-ink-500">
					{$_('settings.website_url.hint_ok')}
				</span>
			{/if}
		</p>

		<div class="mt-6 flex flex-wrap items-center gap-3">
			<BusyButton
				variant="secondary-quiet"
				size="sm"
				busy={websiteSaving}
				done={websiteSavedToast}
				disabled={!websiteIsValid ||
					(websiteIsEmpty ? '' : websiteCleaned) === websiteSaved}
				busyLabel={$_('common.saving')}
				onclick={saveWebsiteLocal}
			>
				{#if websiteSavedToast}
					{$_('settings.display_name.saved_toast')}
				{:else}
					{$_('settings.display_name.save')}
				{/if}
			</BusyButton>
			{#if $isUnlocked}
				<BusyButton
					variant="primary"
					size="sm"
					busy={websiteBroadcasting}
					done={websiteBroadcastOk}
					disabled={!websiteIsValid}
					busyLabel={$_('common.broadcasting')}
					onclick={saveAndBroadcastWebsite}
				>
					{#if websiteBroadcastOk}
						{$_('common.broadcasted')}
					{:else}
						{$_('settings.website_url.save_and_broadcast')}
					{/if}
				</BusyButton>
			{/if}
			{#if websiteSavedToast}
				<span class="text-sm font-medium text-morphit-emerald" role="status">
					{$_('settings.website_url.saved_toast')}
				</span>
			{/if}
		</div>

		{#if websiteBroadcastError}
			<div class="mt-3">
				<StatusLine kind="error">{websiteBroadcastError}</StatusLine>
			</div>
		{/if}

		<div
			class="mt-6 rounded-xl border border-ink-200 bg-white p-4 text-sm text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
		>
			<strong>{$_('settings.website_url.reminder_title')}</strong>
			<p class="mt-1">{$_('settings.website_url.reminder_body')}</p>
		</div>
	</section>

	<!-- ─── Streaming URL ─── -->
	<!-- The former Blurt.media card, generalized to any streaming profile
	     (YouTube, Rumble, Blurt.media, Twitch, …). Still stored on-chain as
	     streaming_url (field name unchanged); a play-triangle glyph shows
	     on the profile page. Rendered after Website, before Nostr. -->
	<section
		class="card card-watermark mt-6"
		style="--card-watermark: url('/icons/icon-play.svg')"
		aria-labelledby="streaming-heading"
	>
		<h2 id="streaming-heading" class="font-display text-xl font-bold">
			{$_('settings.streaming_url.heading')}
		</h2>
		<div class="mt-1"><VisibilityBadge scope="public" /></div>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.streaming_url.explain')}
		</p>

		<label for="streaming-url-input" class="sr-only">
			{$_('settings.streaming_url.label')}
		</label>
		<input
			id="streaming-url-input"
			type="text"
			autocomplete="url"
			inputmode="url"
			spellcheck="false"
			bind:value={streamingInput}
			maxlength="512"
			placeholder={streamingPlaceholder}
			aria-invalid={!streamingIsValid}
			aria-describedby="streaming-url-help"
			class="mt-4 w-full rounded-xl border bg-white px-3 py-2 font-mono text-sm transition-colors focus:outline-none dark:bg-ink-900 {!streamingIsValid
				? 'border-red-500 focus:ring-2 focus:ring-red-500 dark:border-red-500'
				: 'border-ink-300 dark:border-ink-700'}"
		/>

		<p id="streaming-url-help" class="mt-2 text-sm">
			{#if streamingErrorReason === 'too_long'}
				<span class="text-red-600">
					{$_('settings.streaming_url.error.too_long')}
				</span>
			{:else if streamingErrorReason === 'invalid_scheme'}
				<span class="text-red-600">
					{$_('settings.streaming_url.error.invalid_scheme')}
				</span>
			{:else if streamingErrorReason === 'malformed'}
				<span class="text-red-600">
					{$_('settings.streaming_url.error.malformed')}
				</span>
			{:else if streamingIsEmpty}
				<span class="text-ink-500">
					{$_('settings.streaming_url.hint_empty')}
				</span>
			{:else}
				<span class="text-ink-500">
					{$_('settings.streaming_url.hint_ok')}
				</span>
			{/if}
		</p>

		<div class="mt-6 flex flex-wrap items-center gap-3">
			<BusyButton
				variant="secondary-quiet"
				size="sm"
				busy={streamingSaving}
				done={streamingSavedToast}
				disabled={!streamingIsValid ||
					(streamingIsEmpty ? '' : streamingCleaned) === streamingSaved}
				busyLabel={$_('common.saving')}
				onclick={saveStreamingLocal}
			>
				{#if streamingSavedToast}
					{$_('settings.display_name.saved_toast')}
				{:else}
					{$_('settings.display_name.save')}
				{/if}
			</BusyButton>
			{#if $isUnlocked}
				<BusyButton
					variant="primary"
					size="sm"
					busy={streamingBroadcasting}
					done={streamingBroadcastOk}
					disabled={!streamingIsValid}
					busyLabel={$_('common.broadcasting')}
					onclick={saveAndBroadcastStreaming}
				>
					{#if streamingBroadcastOk}
						{$_('common.broadcasted')}
					{:else}
						{$_('settings.streaming_url.save_and_broadcast')}
					{/if}
				</BusyButton>
			{/if}
			{#if streamingSavedToast}
				<span class="text-sm font-medium text-morphit-emerald" role="status">
					{$_('settings.streaming_url.saved_toast')}
				</span>
			{/if}
		</div>

		{#if streamingBroadcastError}
			<div class="mt-3">
				<StatusLine kind="error">{streamingBroadcastError}</StatusLine>
			</div>
		{/if}

		<div
			class="mt-6 rounded-xl border border-ink-200 bg-white p-4 text-sm text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
		>
			<strong>{$_('settings.streaming_url.reminder_title')}</strong>
			<p class="mt-1">{$_('settings.streaming_url.reminder_body')}</p>
		</div>
	</section>

	<!-- ─── Nostr URL ─── -->
	<section
		class="card card-watermark mt-6"
		style="--card-watermark: url('/icons/icon-nostr.svg')"
		aria-labelledby="nostr-heading"
	>
		<h2 id="nostr-heading" class="font-display text-xl font-bold">
			{$_('settings.nostr_url.heading')}
		</h2>
		<div class="mt-1"><VisibilityBadge scope="public" /></div>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.nostr_url.explain')}
		</p>

		<label for="nostr-url-input" class="sr-only">
			{$_('settings.nostr_url.label')}
		</label>
		<input
			id="nostr-url-input"
			type="text"
			name="nostr-profile-url"
			autocomplete="url"
			data-1p-ignore
			data-lpignore="true"
			data-bwignore
			inputmode="url"
			spellcheck="false"
			bind:value={nostrInput}
			maxlength="512"
			placeholder={$_('settings.nostr_url.placeholder')}
			aria-invalid={!nostrIsValid}
			aria-describedby="nostr-url-help"
			class="mt-4 w-full rounded-xl border bg-white px-3 py-2 font-mono text-sm transition-colors focus:outline-none dark:bg-ink-900 {!nostrIsValid
				? 'border-red-500 focus:ring-2 focus:ring-red-500 dark:border-red-500'
				: 'border-ink-300 dark:border-ink-700'}"
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

		<div class="mt-6 flex flex-wrap items-center gap-3">
			<BusyButton
				variant="secondary-quiet"
				size="sm"
				busy={nostrSaving}
				done={nostrSavedToast}
				disabled={!nostrIsValid || (nostrIsEmpty ? '' : nostrCleaned) === nostrSaved}
				busyLabel={$_('common.saving')}
				onclick={saveNostrLocal}
			>
				{#if nostrSavedToast}
					{$_('settings.display_name.saved_toast')}
				{:else}
					{$_('settings.display_name.save')}
				{/if}
			</BusyButton>
			{#if $isUnlocked}
				<BusyButton
					variant="primary"
					size="sm"
					busy={nostrBroadcasting}
					done={nostrBroadcastOk}
					disabled={!nostrIsValid}
					busyLabel={$_('settings.nostr_url.broadcast_pending')}
					onclick={saveAndBroadcastNostr}
				>
					{#if nostrBroadcastOk}
						{$_('common.broadcasted')}
					{:else}
						{$_('settings.nostr_url.save_and_broadcast')}
					{/if}
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
						<a
							href={lp('/faq#iphone_install')}
							class="group underline transition hover:text-morphit-emerald"
						>
							{$_('settings.install.iphone_link')}
							<span class="nav-arrow nav-arrow-right" aria-hidden="true">⇨</span>
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
		<div class="mt-1"><VisibilityBadge scope="device" /></div>
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
		<div class="mt-1"><VisibilityBadge scope="private" /></div>
		{#if !syndicationPhaseKnown}
			<!-- Determining whether the first-trade milestone is past (one
			     indexer round-trip on mount). Show only the heading meanwhile
			     so an order-placer never sees a flash of the Phase-1 "announce
			     my first trade" copy before it resolves to Phase 2. -->
		{:else if !firstTradeMilestonePast}
			<!-- Phase 1: one-time first-trade announcement opt-in (default off). -->
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('settings.syndication.explain')}
			</p>
			<!-- Sally finding H9 (Part 68): selling-point pitch so a user landing here understands the privacy-vs-reach tradeoff. -->
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
		{:else}
			<!-- Phase 2: first trade done — the announcement opt-in is spent; this card now sets the per-order blog-post default. -->
			<p class="mt-2 text-ink-600 dark:text-ink-300">
				{$_('settings.syndication.blog_default_explain')}
			</p>
			<label
				class="mt-4 flex items-start gap-3 rounded-xl border border-ink-200 p-4 dark:border-ink-700"
			>
				<input
					type="checkbox"
					checked={$orderBlogDefault}
					onchange={(e) => setOrderBlogDefault(e.currentTarget.checked)}
					class="mt-1 h-5 w-5 flex-none accent-morphit-emerald"
				/>
				<div class="min-w-0">
					<p class="font-semibold">
						{$_('settings.syndication.blog_default_label')}
					</p>
				</div>
			</label>
		{/if}
	</section>

	<!-- ─── Hidden accounts (client-side moderation, Q1.4) ─── -->
	<section class="card mt-6" aria-labelledby="hidden-accounts-heading">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<h2 id="hidden-accounts-heading" class="min-w-0 font-display text-xl font-bold">
				{$_('settings.hidden_accounts.heading')}
			</h2>
				<div class="mt-1"><VisibilityBadge scope="private" /></div>
			</div>
			<div class="flex flex-none items-center gap-2">
				{#if hiddenRefreshed}
					<span
						class="text-xs font-medium text-emerald-600 dark:text-emerald-400"
						role="status"
						aria-live="polite"
					>
						✓ {$_('settings.hidden_accounts.refreshed')}
					</span>
				{/if}
				<button
					type="button"
					onclick={onRefreshHidden}
					class="rounded-lg border border-ink-300 px-3 py-1 text-xs font-semibold transition-colors hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:border-ink-700"
					aria-label={$_('settings.hidden_accounts.refresh_aria') as string}
				>
					{$_('settings.hidden_accounts.refresh')}
				</button>
			</div>
		</div>
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
						class="rounded-xl border-2 border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950"
						role="alertdialog"
						aria-live="polite"
					>
						<p class="text-sm text-red-900 dark:text-red-100">
							{$_('settings.hidden_accounts.unhide_all_confirm', {
								values: { count: hiddenList.length }
							})}
						</p>
						<div class="mt-3 flex flex-wrap gap-2">
							<BusyButton
								variant="primary"
								size="sm"
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
				<h2 id="blocked-accounts-heading" class="min-w-0 font-display text-xl font-bold">
				{$_('settings.blocked_accounts.heading')}
			</h2>
				<div class="mt-1"><VisibilityBadge scope="private" /></div>
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
		<!-- Explain + scope note span the full card width (matching the
		     Preferences card below). Previously they were nested in the
		     flex row's left column, so the width allocated to them — and
		     therefore their wrapping — shifted whenever the "✓ Refreshed!"
		     flash appeared/disappeared in the button column on refresh. -->
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.blocked_accounts.explain')}
		</p>
		<p class="mt-2 text-sm text-ink-500">
			{$_('settings.blocked_accounts.scope_note')}
		</p>

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
		<div class="mt-1"><VisibilityBadge scope="private" /></div>
		<p class="mt-2 text-ink-600 dark:text-ink-300">
			{$_('settings.preferences.explain')}
		</p>

		{#if !$userPreferences.fiat && !$userPreferences.region}
			<p
				class="mt-4 rounded-xl bg-ink-50 p-4 text-sm text-ink-600 dark:bg-ink-950 dark:text-ink-300"
			>
				{$_('settings.preferences.empty')}
			</p>
		{:else}
			<dl
				class="mt-4 divide-y divide-ink-200 overflow-hidden rounded-xl border border-ink-200 dark:divide-ink-800 dark:border-ink-700"
			>
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
						class="rounded-xl border-2 border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950"
						role="alertdialog"
						aria-live="polite"
					>
						<p class="text-sm text-red-900 dark:text-red-100">
							{$_('settings.preferences.clear_confirm_body')}
						</p>
						<div class="mt-3 flex flex-wrap gap-2">
							<BusyButton
								variant="primary"
								size="sm"
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
			<div class="mt-1"><VisibilityBadge scope="device" /></div>
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
						href={localePath(
							'/settings/security/2fa',
							($page.params.lang as LocaleCode) ?? DEFAULT_LOCALE
						)}
						class="mt-3 inline-block rounded-xl border border-ink-300 px-4 py-2 text-sm font-semibold transition hover:border-morphit-emerald hover:bg-morphit-emerald/5 hover:text-morphit-emerald dark:border-ink-700 dark:hover:border-morphit-emerald dark:hover:bg-morphit-emerald/10"
					>
						{$_('settings.totp.enroll.cta')}
						<span class="nav-arrow nav-arrow-right" aria-hidden="true">⇨</span>
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
								class="mt-1 w-full rounded-xl border border-ink-200 bg-white px-3 py-2 focus:outline-none dark:border-ink-700 dark:bg-ink-900"
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
								class="mt-1 w-full rounded-xl border border-ink-200 bg-white px-3 py-2 focus:outline-none dark:border-ink-700 dark:bg-ink-900"
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
								<p class="mt-1 text-xs text-red-700 dark:text-red-400">
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
								class="mt-1 w-full rounded-xl border border-ink-200 bg-white px-3 py-2 focus:outline-none dark:border-ink-700 dark:bg-ink-900"
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
							size="sm"
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
						class="mt-3 rounded-xl border border-ink-200 bg-white px-3 py-2 focus:outline-none dark:border-ink-700 dark:bg-ink-900"
					>
						<option value="15">{$_('settings.session.autolock_15min')}</option>
						<option value="30">{$_('settings.session.autolock_30min')}</option>
						<option value="60">{$_('settings.session.autolock_1h')}</option>
						<option value="240">{$_('settings.session.autolock_4h')}</option>
						<option value="540">{$_('settings.session.autolock_9h')}</option>
						<option value="1440">{$_('settings.session.autolock_24h')}</option>
						<option value="never">{$_('settings.session.autolock_never')}</option>
					</select>
					{#if autoLockChanged}
						<p
							class="mt-2 flex items-center gap-1.5 text-sm font-medium text-morphit-emerald"
							aria-live="polite"
						>
							<svg
								class="h-4 w-4 flex-shrink-0"
								viewBox="0 0 20 20"
								fill="currentColor"
								aria-hidden="true"
							>
								<path
									fill-rule="evenodd"
									d="M16.704 5.29a1 1 0 0 1 .006 1.414l-7.5 7.6a1 1 0 0 1-1.42.006l-3.5-3.5a1 1 0 1 1 1.414-1.414l2.79 2.79 6.792-6.886a1 1 0 0 1 1.418-.006Z"
									clip-rule="evenodd"
								/>
							</svg>
							{autoLockChanged}
						</p>
					{/if}
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
		{:catch}
			<LazyLoadError />
		{/await}
	{/if}
</div>
