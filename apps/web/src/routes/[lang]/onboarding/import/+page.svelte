<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { gotoLocale } from '$i18n/navigate';
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
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
	import {
		blobToEnvelope,
		decryptIdentity,
		encryptIdentity,
		type KeystoreEnvelope
	} from '$crypto/keystore';
	import { writeKeystoreMode, writeEnvelope } from '$crypto/persistentKeystore';
	import { scorePassword, isPasswordAcceptable } from '$lib/auth/passwordStrength';
	import { wifToRawPrivateKey, WifDecodeError, type WifError } from '$crypto/wif';
	import { verifyPostingKey } from '$crypto/postingVerify';
	import { normalizeSeedPhrase, seedWordCount } from '$crypto/seedNormalize';
	import { fetchAccountKeys } from '$blurt/accountKeys';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';
	import { bootFromEnvelope, liveIdentity } from '$stores/identity';
	import { setUserBlurtAccount } from '$blurt/ops/profile';
	import { resolveAccountsByPublicKeys } from '$blurt/accountByKey';
	import * as secp256k1 from '@noble/secp256k1';
	import { get } from 'svelte/store';
	import sodium from 'libsodium-wrappers-sumo';

	let mode: 'seed' | 'keyfile' | 'posting-only' = $state('seed');
	let seed = $state('');
	let file = $state<File | null>(null);
	let password = $state('');
	// Posting-only fields:
	let postingWif = $state('');
	let postingNewPassword = $state('');
	let postingNewPasswordConfirm = $state('');
	// H (cp295): has the user blurred the Confirm-password field at least
	// once? The red mismatch border only appears after a blur (and only
	// while the two differ), per Ken's spec — not while still typing.
	let postingConfirmBlurred = $state(false);
	let working = $state(false);
	let errorMsg = $state('');
	// Per-field "this input is wrong" flags that paint the field's border
	// red until the user changes it (cleared on input/focus of that field).
	// Pairs with the detailed error banner so the user sees BOTH which
	// field is wrong and why. Grandma needs the field pointed at, not just
	// a paragraph at the top of the form.
	let wifKeyInvalid = $state(false);
	let seedInvalid = $state(false);
	let keyfilePwInvalid = $state(false);
	// The error banner's element, so we can scroll it into view when an
	// error appears (it renders at the top of the form; without this a
	// user who submitted from the bottom never sees why it failed).
	let errorEl = $state<HTMLDivElement>();
	$effect(() => {
		if (errorMsg && errorEl) errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
	});

	// I (cp295): when the import flow advances to the "remember me" card
	// (after a successful posting-key login), scroll the page back to the
	// top so the card's heading is in view — the user submitted from the
	// bottom of the form and would otherwise be left scrolled down.
	$effect(() => {
		if (importStage === 'remember_me_choice' && typeof window !== 'undefined') {
			window.scrollTo({ top: 0, behavior: 'smooth' });
		}
	});

	/** Heuristic: did a failure come from the network / RPC layer (all Blurt
	 *  endpoints unreachable, CORS-blocked, or timed out) rather than bad
	 *  input? Drives a clearer "couldn't reach Blurt" message instead of the
	 *  misleading "check your input". */
	function looksLikeNetworkError(raw: string): boolean {
		const m = raw.toLowerCase();
		return (
			m.includes('fetch') ||
			m.includes('network') ||
			m.includes('load failed') ||
			m.includes('failed to load') ||
			m.includes('timeout') ||
			m.includes('timed out') ||
			m.includes('econn') ||
			m.includes('cors') ||
			m.includes('rpc') ||
			m.includes('endpoint') ||
			m.includes('abort')
		);
	}

	// ── Posting-only account field: locale-correct body link + animated
	//    placeholder + char validation + on-blur on-chain existence check ──

	// Locale-prefixed internal links (the import body's "go back" → /login).
	// Using lp() keeps the user on their current locale; a bare /login would
	// bounce through the locale-less redirect and could land them elsewhere.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));

	// The import body carries an inline [[…]] marker around the "go back"
	// phrase (in every locale). Split it so we can render that span as a real
	// <a>. If the marker is ever missing we fall back to the plain string.
	const importBodyParts = $derived.by(() => {
		const text = $_('onboarding.import.body');
		const m = text.match(/^([\s\S]*?)\[\[([\s\S]*?)\]\]([\s\S]*)$/);
		return m ? { before: m[1], link: m[2], after: m[3] } : null;
	});

	// Live structural check for the posting-key (WIF) field: a Blurt private
	// key is an uncompressed Bitcoin-style WIF — 51 base58 chars beginning
	// with '5'. This flags obviously-wrong input (too short/long, wrong
	// prefix, non-base58 chars, or a pasted master password) with a red
	// border as the user types. The full checksum + secp256k1 validation
	// still runs at submit (wifToRawPrivateKey) and sets wifKeyInvalid for a
	// structurally-valid but cryptographically-bad key.
	const BASE58_ALPHABET_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
	function looksLikeBlurtWif(s: string): boolean {
		const t = s.trim();
		return t.length === 51 && t.startsWith('5') && BASE58_ALPHABET_RE.test(t);
	}
	const wifLooksInvalid = $derived(postingWif.trim().length > 0 && !looksLikeBlurtWif(postingWif));

	// On-blur verdict for the posting-key (WIF) field — drives the inline
	// icon at the field's end (green check if the key looks structurally
	// valid, red triangle if not, nothing while empty/untouched). Mirrors
	// the account-name field's tri-state. The live red border above
	// (wifLooksInvalid) still flags as the user types; this only adds the
	// affirm/deny ICON on blur. (cp323)
	let wifStatus = $state<'idle' | 'valid' | 'invalid'>('idle');
	function checkWifLooksOk(): void {
		const v = postingWif.trim();
		if (v.length === 0) {
			wifStatus = 'idle';
			return;
		}
		wifStatus = looksLikeBlurtWif(v) ? 'valid' : 'invalid';
	}

	// ── cp434 — prefork-key manual account name ─────────────────────
	// Some accounts predate Blurt (created on Steem before the fork). Their
	// posting key still logs in fine, but the reverse key→account lookup
	// (get_key_references) can't find them, so the username can't be
	// auto-detected. Rather than dead-end with an error, reveal a Username
	// field ONLY in that case, validate the typed name against the pasted
	// key in real time, and block submit until the two match.
	const BLURT_ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/; // blurt-account-regex-parity sentinel
	let detectedAccount = $state<string | null>(null);
	let accountFieldNeeded = $state(false);
	let manualAccount = $state('');
	let manualAccountStatus = $state<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
	let derivedPubCache = $state<string | null>(null);
	// Monotonic guards so a slow reply for an OLD wif/name can't clobber the
	// current one.
	let detectSeq = 0;
	let validateSeq = 0;
	let manualDebounce: ReturnType<typeof setTimeout> | null = null;

	/** Derive the BLT posting public key from a WIF WITHOUT building a full
	 *  identity — scalar → point → BLT. Scalar is wiped. null on failure. */
	async function derivePostingPubBLT(wif: string): Promise<string | null> {
		let scalar: Uint8Array | null = null;
		try {
			scalar = await wifToRawPrivateKey(wif);
			const pub = secp256k1.getPublicKey(scalar, true);
			return await formatPublicKeyBLT(pub);
		} catch {
			return null;
		} finally {
			if (scalar) sodium.memzero(scalar);
		}
	}

	/** Reset all manual-account state — called when the WIF changes so a
	 *  stale username can't linger against a different key. */
	function resetAccountDetection(): void {
		detectSeq++;
		validateSeq++;
		if (manualDebounce) clearTimeout(manualDebounce);
		detectedAccount = null;
		accountFieldNeeded = false;
		manualAccount = '';
		manualAccountStatus = 'idle';
		derivedPubCache = null;
	}

	/** On WIF blur: if the key looks valid, derive its pubkey and try to
	 *  auto-resolve the account. A unique match hides the manual field;
	 *  anything else (prefork / ambiguous / lookup down) reveals it. */
	async function detectAccountFromWif(): Promise<void> {
		const wif = postingWif.trim();
		if (!looksLikeBlurtWif(wif)) {
			resetAccountDetection();
			return;
		}
		const seq = ++detectSeq;
		const pub = await derivePostingPubBLT(wif);
		if (seq !== detectSeq) return; // superseded by a newer key
		derivedPubCache = pub;
		if (!pub) {
			detectedAccount = null;
			accountFieldNeeded = false;
			return;
		}
		let matches: string[] = [];
		try {
			matches = await resolveAccountsByPublicKeys([pub]);
		} catch {
			matches = [];
		}
		if (seq !== detectSeq) return;
		if (matches.length === 1) {
			detectedAccount = matches[0] ?? null;
			accountFieldNeeded = false;
			manualAccount = '';
			manualAccountStatus = 'idle';
		} else {
			detectedAccount = null;
			accountFieldNeeded = true;
		}
	}

	/** Validate the typed username against the pasted key: it must EXIST and
	 *  carry this key in its POSTING authority. Debounced by the caller. */
	async function validateManualAccount(): Promise<void> {
		const name = manualAccount.trim().toLowerCase();
		if (!accountFieldNeeded || name.length === 0) {
			manualAccountStatus = 'idle';
			return;
		}
		if (!BLURT_ACCOUNT_RE.test(name) || !derivedPubCache) {
			manualAccountStatus = 'invalid';
			return;
		}
		const seq = ++validateSeq;
		manualAccountStatus = 'checking';
		let fetched;
		try {
			fetched = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), name);
		} catch {
			fetched = null;
		}
		if (seq !== validateSeq) return;
		if (!fetched) {
			manualAccountStatus = 'invalid'; // no such account
			return;
		}
		const verdict = verifyPostingKey(fetched, derivedPubCache);
		if (seq !== validateSeq) return;
		manualAccountStatus = verdict.kind === 'ok' ? 'valid' : 'invalid';
	}

	/** Debounced entry point for the Username input. */
	function onManualAccountInput(): void {
		manualAccountStatus = manualAccount.trim().length === 0 ? 'idle' : 'checking';
		if (manualDebounce) clearTimeout(manualDebounce);
		manualDebounce = setTimeout(() => void validateManualAccount(), 450);
	}

	/** cp137 H-1 — post-seed-import "remember me on this device" step.
	 *  After a successful seed-mode import, instead of redirecting to
	 *  /settings immediately, we show a small intermediate screen that
	 *  asks the user whether to persist the encrypted envelope on this
	 *  device behind a password OR keep the privacy-positive default
	 *  (session-only, ephemeral random key — envelope vanishes when
	 *  the tab closes).
	 *
	 *  Default is UNCHECKED — explicit opt-in to persistence preserves
	 *  the prior behavior for users on shared/public computers.  The
	 *  checkbox wording carries the qualifier "(assuming nobody else
	 *  uses it)" so the privacy implication is visible at the click.
	 *
	 *  Keyfile + posting-only modes don't use this step: keyfile
	 *  already has a user-set password from when the file was made,
	 *  and posting-only asks for a new password earlier in the form.
	 *  Only seed-mode lacks an explicit password capture, which is
	 *  what makes the original session-only default a UX trap. */
	type ImportStage = 'form' | 'remember_me_choice';
	let importStage = $state<ImportStage>('form');
	let rememberMe = $state(false);
	let rememberPassword = $state('');
	let rememberPasswordConfirm = $state('');
	// ALL three import modes (seed / keyfile / posting-only) now pause on the
	// remember-me choice so the user always sees the (default-unchecked,
	// prominent) persist option. These describe the pending choice:
	//   passwordAlreadyChosen — true for keyfile + posting-only (the envelope
	//     is already encrypted with a password the user knows, so the choice
	//     is a plain checkbox with no password sub-form); false for seed (the
	//     session envelope uses an ephemeral key, so the choice collects one).
	//   pendingNeedsAccountName — seed + keyfile don't carry the account name
	//     (route to /settings to capture it); posting-only already did.
	//   pendingDestination — where to go after the choice resolves.
	let passwordAlreadyChosen = $state(false);
	let pendingNeedsAccountName = $state(true);
	let pendingDestination = $state('/settings#account-name-heading');
	/** Held envelope + random session password from the seed import,
	 *  waiting on the user's choice in the remember-me step.  Wiped
	 *  after the choice is made (either path consumes them). */
	let pendingEnvelope: KeystoreEnvelope | null = $state(null);
	let pendingSessionPassword = $state('');
	/** BLT-format public keys (owner/active/posting) captured from the
	 *  imported seed BEFORE the FullIdentity is wiped, so we can reverse-
	 *  look-up the account name on-chain (Task 6d) without re-deriving or
	 *  holding any private material. Public keys only — safe to retain. */
	let pendingPubKeysBLT = $state<string[]>([]);

	// Gate the "Remember me & continue" button on a valid, matching
	// password — only when the seed path is collecting a NEW password.
	// Keyfile / posting-only already supplied one (passwordAlreadyChosen),
	// and the session-only choice (rememberMe = false) needs no password.
	// Mirrors the checks in finalizeImportChoice so the button can't be
	// pressed into a state that just errors out.
	const rememberPwValid = $derived(
		rememberPassword.length >= 8 &&
			rememberPassword === rememberPasswordConfirm &&
			isPasswordAcceptable(rememberPassword)
	);
	const rememberContinueDisabled = $derived(
		rememberMe && !passwordAlreadyChosen && !rememberPwValid
	);
	// Red-border the Confirm field once the user has typed something there
	// that doesn't match the password above.
	const rememberConfirmMismatch = $derived(
		rememberPasswordConfirm.length > 0 && rememberPassword !== rememberPasswordConfirm
	);

	/** Map a WifError code to a localized error message. */
	function wifErrorMessage(code: WifError): string {
		return $_(`onboarding.import.posting_only.error.wif.${code}`);
	}

	/** Tidy the seed phrase the user typed/pasted, on blur. BIP-39
	 *  mnemonics are always lowercase, space-separated words — so commas
	 *  (with or without spaces) and capital letters are always user-input
	 *  noise we can safely fix for them rather than rejecting. Replaces
	 *  commas with spaces (handles "a,b" AND "a, b"), collapses any run of
	 *  whitespace/newlines to a single space, trims, and lowercases. A
	 *  no-op when the text is already clean, so it never fights the user
	 *  mid-edit. */
	function normalizeSeedInput(): void {
		const cleaned = normalizeSeedPhrase(seed);
		if (cleaned !== seed) seed = cleaned;
	}

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
				// Seed-path users haven't picked a password yet.  Encrypt
				// with a random session key for now; the remember-me
				// choice step (cp137 H-1) will either re-encrypt with the
				// user's password and persist, OR keep this session-only
				// random-key envelope (privacy-positive default).
				const rnd = crypto.getRandomValues(new Uint8Array(24));
				usedPassword = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
				env = await encryptIdentity(full, usedPassword);
			} else {
				if (!file) throw new Error($_('onboarding.import.pick_file_first'));
				env = await blobToEnvelope(file);
				usedPassword = password;
			}

			await bootFromEnvelope(env, usedPassword);
			// Capture the POSTING public key from the just-booted session so we
			// can reverse-resolve the account name on-chain — NEITHER a seed nor
			// a keyfile carries the account name. Reading it from the live
			// identity (not `full`) covers BOTH modes: seed (where `full` is in
			// hand) AND keyfile (where the envelope decrypts INSIDE
			// bootFromEnvelope without ever surfacing the FullIdentity to this
			// page) — both are cases where auto-resolution is possible and useful.
			// Posting only — the owner/active slots are gated by the active/owner
			// key invariant and aren't needed here: a standard account has this
			// posting key in its posting authority, so get_key_references finds
			// it. (A rotated posting key falls back to manual entry.) Public key
			// only — no private material is retained.
			const booted = get(liveIdentity);
			if (booted?.posting.publicKey) {
				try {
					pendingPubKeysBLT = [await formatPublicKeyBLT(booted.posting.publicKey)];
				} catch {
					// Couldn't format — fall back to manual account-name entry.
				}
			}
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

			// cp137 H-1 — for seed-mode imports, pause here and ask
			// the user whether to persist the envelope.  Stash env +
			// session-password until the choice is made.  For
			// keyfile-mode imports (and posting-only via its own
			// path), the envelope is already persistent by virtue of
			// the user-set password, so we proceed straight to the
			// redirect.
			// cp137 H-1 (cp290 extended) — pause on the remember-me choice
			// so the user ALWAYS sees the (default-unchecked) persist option.
			// Seed: the session env uses an ephemeral random key, so the
			// choice collects a real password (passwordAlreadyChosen=false).
			// Keyfile: the user already supplied the keyfile password (env is
			// encrypted with it), so the choice is a plain checkbox with no
			// password sub-form (passwordAlreadyChosen=true). Neither carries
			// the account name, so after the choice we route to /settings to
			// capture + verify it.
			pendingEnvelope = env;
			// Only the seed path needs the pending session password (the
			// ephemeral random key, used to re-decrypt before persisting).
			// Keyfile's envelope is already encrypted with the user's keyfile
			// password, so persist is a direct writeEnvelope — don't hold the
			// real password in component state any longer than necessary.
			pendingSessionPassword = mode === 'seed' ? usedPassword : '';
			passwordAlreadyChosen = mode !== 'seed';
			pendingNeedsAccountName = true;
			pendingDestination = '/settings#account-name-heading';
			importStage = 'remember_me_choice';
			return;
		} catch (err) {
			// Map known error messages to localized keys.  The
			// raw err.message text is English (e.g. "Seed must be
			// 12 words") and shouldn't surface to non-English
			// users.  Any unrecognized message falls back to a
			// generic localized "import failed" string.
			const raw = err instanceof Error ? err.message : String(err); // smoke-ok-raw-local: used only for regex classification + console.warn
			console.warn('[import] seed/keyfile path failed:', raw);
			if (/seed must be 12 words/i.test(raw)) {
				const count = seed.trim().split(/\s+/).filter(Boolean).length;
				errorMsg = $_('onboarding.import.error.seed_word_count', { values: { count } });
				seedInvalid = true;
			} else if (/invalid seed phrase/i.test(raw)) {
				errorMsg = $_('onboarding.import.error.seed_invalid');
				seedInvalid = true;
			} else if (/decrypt|password|wrong key/i.test(raw)) {
				errorMsg = $_('onboarding.import.error.keyfile_password_wrong');
				keyfilePwInvalid = true;
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

	/** cp137 H-1 — finalize the "remember me on this device" choice
	 *  for seed-mode imports.
	 *
	 *  When `rememberMe` is FALSE (default): the envelope stays in
	 *  memory only via the identity store, exactly as the original
	 *  seed-mode behavior.  When the tab closes, the envelope is
	 *  gone; the user re-enters their seed next visit.  No
	 *  localStorage write, no keystore-mode marker.  Privacy-
	 *  positive default — preserves the prior session-only posture
	 *  for users on public/shared computers.
	 *
	 *  When `rememberMe` is TRUE: the user picked a password.
	 *  We re-decrypt the session envelope (which is encrypted with
	 *  the random ephemeral key from the import step), then re-
	 *  encrypt the FullIdentity with the user's password, persist
	 *  the new envelope via `writeEnvelope`, and write keystore
	 *  mode = 'password' so future sessions know to show the
	 *  unlock form.  The re-decrypt path is the cleanest way to
	 *  do this: it avoids exposing the FullIdentity outside of
	 *  this scoped block. */
	async function finalizeImportChoice(): Promise<void> {
		if (working) return;
		errorMsg = '';

		// Common post-choice continuation: flag the account-name prompt
		// when the mode didn't carry it, wipe pending secrets, navigate to
		// the mode's destination.
		const continueAfterChoice = async (): Promise<void> => {
			// Task 6d — auto-resolve the account name from the imported
			// seed's public keys so the user skips the manual entry step.
			// Only when we don't already know the name AND captured keys.
			// A UNIQUE on-chain match is authoritative (the key is in that
			// account's authorities, so it's inherently verified) → set it
			// and send the user home. Ambiguous (a key shared by multiple
			// accounts), no match, or any RPC error falls through to the
			// existing manual /settings capture below.
			if (pendingNeedsAccountName && pendingPubKeysBLT.length > 0) {
				const accounts = await resolveAccountsByPublicKeys(pendingPubKeysBLT);
				const resolved = accounts.length === 1 ? accounts[0] : undefined;
				if (resolved) {
					setUserBlurtAccount(resolved);
					pendingNeedsAccountName = false;
					pendingDestination = '/';
				}
			}
			if (pendingNeedsAccountName) {
				// Sally finding H2 (Part 68): seed/keyfile imports don't carry
				// the account name, so we flag the one-shot /settings banner
				// that explains why the user landed there to set + verify it.
				try {
					sessionStorage.setItem('morphit.import.needs_account_name', '1');
				} catch {
					// Private/Incognito — the /settings account-name card is
					// the first thing on the page anyway; only the one-shot
					// explanatory banner is skipped.
				}
			}
			const dest = pendingDestination;
			pendingEnvelope = null;
			pendingSessionPassword = '';
			rememberPassword = '';
			rememberPasswordConfirm = '';
			await gotoLocale(dest);
		};

		if (!rememberMe) {
			// Session-only (privacy-positive default). The identity store
			// already holds the live session from the earlier boot; nothing
			// is written to disk. When the last tab closes the keys are gone.
			await continueAfterChoice();
			return;
		}

		// rememberMe === true.
		if (!pendingEnvelope) {
			errorMsg = $_('onboarding.import.error.generic');
			return;
		}

		if (passwordAlreadyChosen) {
			// Keyfile / posting-only: the envelope is already encrypted with
			// a password the user knows (the keyfile password, or the one
			// they just set). Persist it directly — no re-encrypt, no new
			// password. The identity store is already booted with this env.
			working = true;
			try {
				writeEnvelope(pendingEnvelope);
				writeKeystoreMode('password');
				await continueAfterChoice();
			} catch (err) {
				console.warn('[import] remember-me persist failed:', err);
				errorMsg = $_('onboarding.import.error.generic');
			} finally {
				working = false;
			}
			return;
		}

		// Seed: the session envelope uses an ephemeral random key, so collect
		// + validate a real password and re-encrypt the identity with it.
		if (rememberPassword.length < 8) {
			errorMsg = $_('common.password_too_short');
			return;
		}
		if (rememberPassword !== rememberPasswordConfirm) {
			errorMsg = $_('onboarding.import.remember_me.error.passwords_mismatch');
			return;
		}
		if (!isPasswordAcceptable(rememberPassword)) {
			errorMsg = $_('onboarding.import.remember_me.error.password_weak');
			return;
		}

		working = true;
		let full: FullIdentity | null = null;
		try {
			// Re-decrypt the session envelope so we have the FullIdentity to
			// re-encrypt with the user's password.
			full = (await decryptIdentity(pendingEnvelope, pendingSessionPassword)) as FullIdentity;
			const persistedEnv = await encryptIdentity(full, rememberPassword);
			writeEnvelope(persistedEnv);
			writeKeystoreMode('password');
			// Re-boot so the store's envelope reference matches what's on
			// disk (Settings/Backup-keys surfaces show the right state).
			await bootFromEnvelope(persistedEnv, rememberPassword);
			wipeFullIdentity(full);
			full = null;
			await continueAfterChoice();
		} catch (err) {
			console.warn('[import] remember-me persist failed:', err);
			errorMsg = $_('onboarding.import.error.generic');
			if (full) {
				wipeFullIdentity(full);
				full = null;
			}
		} finally {
			working = false;
		}
	}

	async function unlockPostingOnly(): Promise<void> {
		// Up-front validation before we do any crypto. cp406 — there's no account
		// field: we reverse-resolve the account from the posting key's PUBLIC key
		// on-chain (the same same-origin get_key_references lookup the seed/keyfile
		// imports use) after deriving it. A posting key uniquely identifies its
		// account in the normal case, so asking for the name is redundant friction.
		if (postingNewPassword.length < 8) {
			errorMsg = $_('common.password_too_short');
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
					wifKeyInvalid = true;
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
			const derivedPub = await formatPublicKeyBLT(full.keys.posting.publicKey);

			// ─── [morphit-diag cp440] TEMP — remove after the bug hunt ───
			// Compare the RAW derived posting pubkey (ground truth, straight from
			// secp256k1) against the formatPublicKeyBLT() output used for the
			// account lookup below. If they don't correspond, the canonical
			// formatter is corrupting the key in THIS browser build — the same bug
			// behind a blank/wrong username field here AND the settings
			// "Missing Posting Authority". Public keys only; nothing secret.
			try {
				const rawPub = full.keys.posting.publicKey;
				let rawB64 = '';
				for (const b of rawPub) rawB64 += String.fromCharCode(b);
				rawB64 = btoa(rawB64).replace(/=+$/, '');
				const rawHex = Array.from(rawPub)
					.map((b) => b.toString(16).padStart(2, '0'))
					.join('');
				// eslint-disable-next-line no-console
				console.info('[morphit-diag] posting-only login → derived posting pubkey', {
					rawPubB64: rawB64,
					rawPubHex: rawHex,
					rawLen: rawPub.length,
					formattedBLT: derivedPub
				});
			} catch (e) {
				// eslint-disable-next-line no-console
				console.warn('[morphit-diag] posting-only login diag failed', e);
			}
			// ─── end diag ───

			// 3b. Resolve the account name. Prefer the manually-entered +
			//     validated username (prefork accounts the reverse lookup can't
			//     find); otherwise reverse-resolve from the derived public key via
			//     the same same-origin get_key_references lookup the seed/keyfile
			//     imports use — a UNIQUE match IS the account (the key is in exactly
			//     that account's posting authority, so it's inherently verified).
			//     Either way, step 4 re-fetches + re-verifies the key on-chain.
			let account: string | undefined;
			if (accountFieldNeeded && manualAccountStatus === 'valid') {
				account = manualAccount.trim().toLowerCase();
			} else {
				const matches = await resolveAccountsByPublicKeys([derivedPub]);
				account = matches.length === 1 ? matches[0] : undefined;
			}
			if (!account) {
				// cp434 — couldn't auto-detect and no valid manual name (e.g. the
				// user hit submit before blurring the key). Reveal the Username
				// field so they can supply it, rather than dead-ending.
				accountFieldNeeded = true;
				derivedPubCache = derivedPub;
				errorMsg = $_('onboarding.import.posting_only.error.could_not_resolve');
				return;
			}

			// 4. Fetch the account from chain and classify the key.
			const fetched = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), account);
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
				wifKeyInvalid = true;
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
				wifKeyInvalid = true;
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
			// cp290 — pause on the remember-me choice (the env is already
			// encrypted with the password the user just set, so it's a plain
			// checkbox, no password sub-form). The account name is already
			// captured, so the post-choice destination is /orderbook. Hold
			// the env + password in the pending slots until the choice
			// resolves; clear the raw key + the form's password fields now.
			pendingEnvelope = env;
			// Envelope is already encrypted with the password the user just
			// set, so persist is a direct writeEnvelope — no need to hold the
			// real password pending (passwordAlreadyChosen path never uses it).
			pendingSessionPassword = '';
			passwordAlreadyChosen = true;
			pendingNeedsAccountName = false;
			pendingDestination = '/orderbook';
			postingWif = '';
			postingNewPassword = '';
			postingNewPasswordConfirm = '';
			importStage = 'remember_me_choice';
			return;
		} catch (err) {
			// Same localization rationale as the seed/keyfile
			// catch above — raw exception text is English.
			const raw = err instanceof Error ? err.message : String(err); // smoke-ok-raw-local: used only for console.warn + looksLikeNetworkError classification (errorMsg is always a localized $_ key)
			console.warn('[import] posting-only path failed:', raw);
			errorMsg = looksLikeNetworkError(raw)
				? $_('onboarding.import.error.network')
				: $_('onboarding.import.error.generic');
			// Clear passwords on error.  Keep `postingWif` so the user
			// can fix typos without re-pasting their key from scratch —
			// the WIF is cleared on a successful submit by the path above,
			// or when the user navigates away (component unmount).
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

	// H (cp295): show the Confirm-password mismatch border once the field
	// has been blurred and has content but doesn't match.
	const postingConfirmMismatch = $derived(
		postingConfirmBlurred &&
			postingNewPasswordConfirm.length > 0 &&
			postingNewPassword !== postingNewPasswordConfirm
	);

	const submitDisabled = $derived(
		mode === 'seed'
			? // cp338: stay disabled until exactly 12 words are present (Morphit
				// only accepts 12-word BIP-39 mnemonics). Counted on the normalized
				// form so comma-separated input counts before the on-blur tidy;
				// checksum validity is enforced on submit, not here (a one-word
				// typo gives a clear "invalid seed phrase" error, not a dead button).
				seedWordCount(seed) !== 12
			: mode === 'keyfile'
				? !file || !password
				: // posting-only (N + H, cp295): the "Unlock my account" button
					// stays disabled until the key + password fields hold
					// proper-looking values — a WIF that passes the Blurt-WIF shape
					// check (not a 1-char stub), a device password of at least the
					// 8-char floor the handler enforces, and a confirmation that
					// actually MATCHES. cp406 — the account name is auto-detected
					// from the key, so there's no account field to gate the button.
					!postingWif.trim() ||
					wifLooksInvalid ||
					(accountFieldNeeded && manualAccountStatus !== 'valid') ||
					postingNewPassword.length < 8 ||
					postingNewPassword !== postingNewPasswordConfirm
	);
</script>

<Head routeKey="onboarding_import" noindex />

<div class="mx-auto max-w-2xl px-4 py-12 md:py-16">
	<header class="mb-8 text-center">
		<h1 class="font-display text-3xl font-extrabold tracking-tight md:text-4xl">
			<span class="brand-gradient-text"
				>{importStage === 'remember_me_choice'
					? $_('onboarding.import.remember_me.welcome_title')
					: $_('onboarding.import.title')}</span
			>
		</h1>
		{#if importStage !== 'remember_me_choice'}
			<p class="mx-auto mt-3 max-w-prose text-ink-600 dark:text-ink-300">
				{#if importBodyParts}{importBodyParts.before}<a
						href={lp('/login')}
						class="font-semibold text-morphit-emerald underline underline-offset-2 hover:text-morphit-emerald/80"
						>{importBodyParts.link}</a
					>{importBodyParts.after}{:else}{$_('onboarding.import.body')}{/if}
			</p>
		{/if}
	</header>

	{#if errorMsg}
		<div
			bind:this={errorEl}
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

	{#if importStage === 'form'}
		<div class="mb-6 flex flex-wrap gap-2" role="tablist">
			<button
				type="button"
				role="tab"
				aria-selected={mode === 'seed'}
				class="flex-1 rounded-xl px-4 py-3 font-semibold transition active:scale-[0.98] {mode ===
				'seed'
					? 'bg-morphit-emerald text-ink-950 shadow-sm'
					: 'bg-ink-100 text-ink-700 hover:bg-morphit-emerald/10 hover:text-morphit-emerald dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-morphit-emerald/10'}"
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
					? 'bg-morphit-emerald text-ink-950 shadow-sm'
					: 'bg-ink-100 text-ink-700 hover:bg-morphit-emerald/10 hover:text-morphit-emerald dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-morphit-emerald/10'}"
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
					? 'bg-morphit-emerald text-ink-950 shadow-sm'
					: 'bg-ink-100 text-ink-700 hover:bg-morphit-emerald/10 hover:text-morphit-emerald dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-morphit-emerald/10'}"
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
						maxlength="120"
						onblur={normalizeSeedInput}
						oninput={() => (seedInvalid = false)}
						class="w-full rounded-xl border-2 bg-white p-3 font-mono text-base focus:outline-none focus:ring-2 dark:bg-ink-950 {seedInvalid
							? 'border-red-400 focus:ring-red-400 dark:border-red-500'
							: 'border-ink-200 focus:ring-morphit-emerald dark:border-ink-700'}"
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
						class="block w-full text-sm file:me-4 file:cursor-pointer file:rounded-lg file:border-0 file:bg-morphit-btn file:px-4 file:py-2 file:font-semibold file:text-white hover:file:brightness-110"
					/>
					<span class="mt-2 block text-sm text-ink-500 dark:text-ink-400">
						{$_('onboarding.import.keyfile_hint')}
					</span>
				</label>
				<label class="mt-4 block">
					<span class="mb-2 block font-semibold">{$_('onboarding.import.password_label')}</span>
					<input
						type="password"
						maxlength="64"
						bind:value={password}
						autocomplete="current-password"
						oninput={() => (keyfilePwInvalid = false)}
						class="w-full rounded-xl border-2 bg-white px-3 py-2 focus:outline-none focus:ring-2 dark:bg-ink-900 {keyfilePwInvalid
							? 'border-red-400 focus:ring-red-400 dark:border-red-500'
							: 'border-ink-200 focus:ring-morphit-emerald dark:border-ink-700'}"
					/>
				</label>
			{:else}
				<!-- Posting-only mode: existing Blurt user importing with one role-key WIF. -->

				<div
					class="mb-5 rounded-xl border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
					role="note"
				>
					<p class="font-semibold">{$_('onboarding.import.posting_only.warning_title')}</p>
					<p class="mt-1 text-sm">
						{$_('onboarding.import.posting_only.warning_body')}
					</p>
				</div>

				<label class="mt-4 block">
					<span class="mb-2 block font-semibold"
						>{$_('onboarding.import.posting_only.wif_label')}</span
					>
					<div class="relative">
						<input
							type="password"
							maxlength="64"
							bind:value={postingWif}
							autocomplete="off"
							spellcheck="false"
							oninput={() => {
								wifKeyInvalid = false;
								wifStatus = 'idle';
								resetAccountDetection();
							}}
							onfocus={() => {
								wifKeyInvalid = false;
								wifStatus = 'idle';
							}}
							onblur={() => {
								checkWifLooksOk();
								void detectAccountFromWif();
							}}
							placeholder={$_('onboarding.import.posting_only.wif_placeholder')}
							class="w-full rounded-xl border-2 bg-white px-3 py-2 pe-10 font-mono focus:outline-none focus:ring-2 dark:bg-ink-900 {wifKeyInvalid ||
							wifLooksInvalid
								? 'border-red-400 focus:ring-red-400 dark:border-red-500'
								: 'border-ink-200 focus:ring-morphit-emerald dark:border-ink-700'}"
						/>
						{#if wifStatus === 'valid'}
							<span
								class="pointer-events-none absolute end-3 top-1/2 inline-flex -translate-y-1/2 items-center text-morphit-emerald"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="3"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M20 6 9 17l-5-5" />
								</svg>
							</span>
						{:else if wifStatus === 'invalid'}
							<span
								class="pointer-events-none absolute end-3 top-1/2 inline-flex -translate-y-1/2 items-center text-red-500 dark:text-red-400"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path
										d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"
									/>
									<path d="M12 9v4" />
									<path d="M12 17h.01" />
								</svg>
							</span>
						{/if}
					</div>
					<span class="mt-1 block text-xs text-ink-500 dark:text-ink-400">
						{$_('onboarding.import.posting_only.wif_hint')}
					</span>
				</label>

				{#if accountFieldNeeded}
					<!-- cp434 — shown ONLY when the account can't be auto-detected from
					     the key (typically a pre-Blurt/prefork account). Required, and
					     validated in real time against the pasted key. -->
					<label class="mt-4 block">
						<span class="mb-2 block font-semibold"
							>{$_('onboarding.import.posting_only.manual_account_label')}</span
						>
						<div class="relative">
							<input
								type="text"
								bind:value={manualAccount}
								autocomplete="off"
								autocapitalize="none"
								spellcheck="false"
								maxlength="16"
								oninput={onManualAccountInput}
								onblur={() => void validateManualAccount()}
								placeholder={$_('onboarding.import.posting_only.manual_account_placeholder')}
								class="w-full rounded-xl border-2 bg-white px-3 py-2 pe-10 lowercase focus:outline-none focus:ring-2 dark:bg-ink-900 {manualAccountStatus ===
								'invalid'
									? 'border-red-400 focus:ring-red-400 dark:border-red-500'
									: 'border-ink-200 focus:ring-morphit-emerald dark:border-ink-700'}"
							/>
							{#if manualAccountStatus === 'valid'}
								<span
									class="pointer-events-none absolute end-3 top-1/2 inline-flex -translate-y-1/2 items-center text-morphit-emerald"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="3"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg
									>
								</span>
							{:else if manualAccountStatus === 'checking'}
								<span
									class="pointer-events-none absolute end-3 top-1/2 inline-flex -translate-y-1/2 items-center text-ink-400"
								>
									<svg
										class="animate-spin"
										xmlns="http://www.w3.org/2000/svg"
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2.5"
										stroke-linecap="round"
										aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg
									>
								</span>
							{:else if manualAccountStatus === 'invalid'}
								<span
									class="pointer-events-none absolute end-3 top-1/2 inline-flex -translate-y-1/2 items-center text-red-500 dark:text-red-400"
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2.5"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
										><path
											d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"
										/><path d="M12 9v4" /><path d="M12 17h.01" /></svg
									>
								</span>
							{/if}
						</div>
						<span
							class="mt-1 block text-xs {manualAccountStatus === 'invalid'
								? 'text-red-500 dark:text-red-400'
								: 'text-ink-500 dark:text-ink-400'}"
						>
							{manualAccountStatus === 'invalid'
								? $_('onboarding.import.posting_only.manual_account_invalid')
								: $_('onboarding.import.posting_only.manual_account_hint')}
						</span>
					</label>
				{/if}

				<div class="my-4 border-t border-ink-200 dark:border-ink-800"></div>

				<label class="block">
					<span class="mb-2 block font-semibold"
						>{$_('onboarding.import.posting_only.new_password_label')}</span
					>
					<input
						type="password"
						maxlength="64"
						bind:value={postingNewPassword}
						autocomplete="new-password"
						class="w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
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
						maxlength="64"
						bind:value={postingNewPasswordConfirm}
						onblur={() => (postingConfirmBlurred = true)}
						autocomplete="new-password"
						aria-invalid={postingConfirmMismatch}
						class="w-full rounded-xl border-2 bg-white px-3 py-2 focus:outline-none focus:ring-2 dark:bg-ink-900 {postingConfirmMismatch
							? 'border-red-400 focus:ring-red-400 dark:border-red-500'
							: 'border-ink-200 focus:ring-morphit-emerald dark:border-ink-700'}"
					/>
					{#if postingConfirmMismatch}
						<span class="mt-1 block text-xs text-red-600 dark:text-red-400">
							{$_('onboarding.import.posting_only.password_mismatch')}
						</span>
					{/if}
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
	{:else if importStage === 'remember_me_choice'}
		<!-- cp137 H-1 — post-seed-import "remember me on this device"
		     choice.  Default is UNCHECKED (privacy-positive).  The
		     qualifier in the checkbox label ("assuming nobody else
		     uses it") makes the privacy implication visible at the
		     point of decision. -->
		<div class="card">
			<h2 class="font-display text-xl font-bold">
				{$_('onboarding.import.remember_me.heading')}
			</h2>
			<p class="mt-3 text-ink-700 dark:text-ink-200">
				{passwordAlreadyChosen
					? $_('onboarding.import.remember_me.body_password_set')
					: $_('onboarding.import.remember_me.body')}
			</p>

			<label
				class="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border-2 border-morphit-emerald/40 bg-morphit-emerald/5 p-4 transition-colors hover:border-morphit-emerald/70"
			>
				<input
					type="checkbox"
					bind:checked={rememberMe}
					class="mt-0.5 h-6 w-6 flex-none accent-morphit-emerald"
				/>
				<span class="font-semibold text-ink-900 dark:text-ink-50">
					{$_('onboarding.import.remember_me.checkbox_label')}
				</span>
			</label>

			{#if rememberMe && !passwordAlreadyChosen}
				<div
					class="mt-5 space-y-4 rounded-xl border-2 border-morphit-emerald bg-morphit-emerald/5 p-4"
				>
					<p class="text-sm text-ink-700 dark:text-ink-200">
						{$_('onboarding.import.remember_me.password_intro')}
					</p>
					<label class="block">
						<span class="block text-sm font-semibold">
							{$_('onboarding.import.remember_me.password_label')}
						</span>
						<input
							type="password"
							maxlength="64"
							bind:value={rememberPassword}
							autocomplete="new-password"
							minlength="8"
							class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
						/>
						<span class="mt-1 block text-xs text-ink-500">
							{$_('onboarding.import.remember_me.password_hint')}
						</span>
					</label>
					{#if rememberPassword.length >= 10}
						{@const strength = scorePassword(rememberPassword)}
						{#if strength === 'too_simple'}
							<p class="text-xs text-red-600 dark:text-red-400">
								⚠ {$_('onboarding.import.remember_me.password_strength_too_simple')}
							</p>
						{:else if strength === 'common'}
							<p class="text-xs text-red-600 dark:text-red-400">
								⚠ {$_('onboarding.import.remember_me.password_strength_common')}
							</p>
						{/if}
					{/if}
					<label class="block">
						<span class="block text-sm font-semibold">
							{$_('onboarding.import.remember_me.password_confirm_label')}
						</span>
						<input
							type="password"
							maxlength="64"
							bind:value={rememberPasswordConfirm}
							autocomplete="new-password"
							class="mt-1 w-full rounded-xl border-2 bg-white px-3 py-2 focus:outline-none focus:ring-2 dark:bg-ink-900 {rememberConfirmMismatch
								? 'border-red-400 focus:ring-red-400 dark:border-red-500'
								: 'border-ink-200 focus:ring-morphit-emerald dark:border-ink-700'}"
						/>
					</label>
					{#if rememberConfirmMismatch}
						<p class="text-xs text-red-600 dark:text-red-400">
							{$_('onboarding.import.remember_me.error.passwords_mismatch')}
						</p>
					{/if}
				</div>
			{/if}

			<div class="mt-6">
				<BusyButton
					variant="primary"
					busy={working}
					disabled={rememberContinueDisabled}
					onclick={finalizeImportChoice}
					busyLabel={$_('common.saving')}
					fullWidth
				>
					{rememberMe
						? $_('onboarding.import.remember_me.submit_remembered')
						: $_('onboarding.import.remember_me.submit_session_only')}
				</BusyButton>
			</div>
		</div>
	{/if}
</div>
