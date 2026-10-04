/**
 * Morphit — every browser storage key (localStorage, sessionStorage, IndexedDB
 * databases), classified.
 *
 * ─── Why this file exists ─────────────────────────────────────────────
 *
 * A user signed out of one account, signed into another, and found the first
 * account's region setting waiting. The cause was not one bad key but
 * the absence of a RULE: keys were added over two years with no shared answer
 * to "does this belong to the person or to the browser?", so some were
 * account-suffixed, some were mirrored to chain, and some were plain globals
 * that every account on the device shared.
 *
 * Fixing the keys that happened to be wrong in July 2026 would leave the next
 * one to chance. So the classification is written down here, and
 * `storage-key-classification-smoke` fails the build when a key is introduced
 * that this file does not mention. A new key must be classified deliberately.
 *
 * ─── The two tiers ────────────────────────────────────────────────────
 *
 * ACCOUNT — a property of the PERSON. Should follow them to a new browser,
 *   must never be visible to the next account on a shared machine. Resolution
 *   order:
 *
 *       chain  →  local mirror  →  factory default
 *
 *   Local is the WORKING copy so the UI is instant; chain is the durable
 *   truth, restored on sign-in. Absence of a chain value means DEFAULT, never
 *   "inherit whoever was here last" — that inversion was the original bug.
 *
 * DEVICE — a property of the BROWSER, not the person. Never mirrored, because
 *   syncing it would actively harm: your laptop's auto-lock timeout has no
 *   business on your phone, and a hardware-key registration is bound to the
 *   authenticator physically present. Resolution order:
 *
 *       local  →  factory default
 *
 * SESSION — credentials and the identity of the current sign-in. Cleared on
 *   sign-out by the keystore/paired-session paths, not by the storage sweep.
 *
 * ─── How each ACCOUNT key is protected ────────────────────────────────
 *
 * Two mechanisms, deliberately overlapping, because each covers a case the
 * other misses:
 *
 *   MIRRORED  — carried in the encrypted `morphit_settings_v1` blob, so it
 *               follows the user across devices AND is reset-then-restored on
 *               every sign-in. Preferred for real settings.
 *   SUFFIXED  — stored under `<key>.<account>`, so two accounts on one device
 *               cannot read each other's copy. Right for drafts and
 *               per-account UI state that has no business on the chain.
 *
 * Everything in the ACCOUNT tier is additionally swept on explicit sign-out
 * (see `signOutSweep.ts`), which is what protects a shared machine even for
 * keys that are neither mirrored nor suffixed yet — except SEALED keys:
 * per-account slots encrypted under that account's own key, which name nobody
 * and must survive another account's sign-out.
 */

/** How a key is scoped to its owner. */
export type StorageTier = 'account' | 'device' | 'session';

/** How an ACCOUNT-tier key is kept from leaking between accounts. */
export type AccountProtection =
	/** In the encrypted on-chain settings blob; reset-then-restored on sign-in. */
	| 'mirrored'
	/** Key carries an `.<account>` suffix. */
	| 'suffixed'
	/** Neither yet — protected ONLY by the sign-out sweep. Anything here is a
	 *  candidate for promotion to mirrored or suffixed; the comment on the
	 *  entry says why it has not been promoted. */
	| 'sweep-only'
	/** `<key>.<slot>`, encrypted under a key only that account's own keys give.
	 *  It names nobody, so the sign-out sweep leaves it: one account's Sign Out
	 *  must not strip another account's sealed state. */
	| 'sealed';

export interface StorageKeySpec {
	/** The literal key, or its stable prefix when a suffix is appended. */
	readonly key: string;
	readonly tier: StorageTier;
	/** Required for ACCOUNT keys; meaningless for device/session. */
	readonly protection?: AccountProtection;
}

export const STORAGE_KEYS: readonly StorageKeySpec[] = [
	// ─── SESSION ──────────────────────────────────────────────────────
	// Who is signed in. Cleared by broadcastSignOut.
	{ key: 'morphit.blurtAccount', tier: 'session' },
	// Encrypted key material. Cleared by clearKeystore.
	{ key: 'morphit.keystore.envelope', tier: 'session' },
	// Unlock mode for the envelope above.
	{ key: 'morphit.keystore.mode', tier: 'session' },
	// When the envelope was first written.
	{ key: 'morphit.keystore.first_persist_at', tier: 'session' },
	// Paired read-only session marker.
	{ key: 'morphit.paired.session', tier: 'session' },
	// In-flight import/login state: the key was accepted but the account name is still needed.
	// Belongs to the sign-in attempt, not the person.
	{ key: 'morphit.import.needs_account_name', tier: 'session' },
	// Per-tab sessionStorage: the Remember-me session ENCRYPTED for a same-tab reload
	// ($lib/auth/reloadStash); its key is held only in the service worker's memory, for 30 s, handed
	// out once. Written at pagehide only when the session's keystore is the remembered one; always
	// removed on the next load.
	{ key: 'morphit.session.reload-stash-v2', tier: 'session' },
	// Written by older builds with the session in plaintext; deleted on sight, never read.
	{ key: 'morphit.session.reload-stash-v1', tier: 'session' },

	// ─── DEVICE ───────────────────────────────────────────────────────
	// Kept on an explicit sign-out. Nothing here may name a person or their
	// content — `signOutSweep.test.ts` asserts exactly that.
	// Which language THIS browser renders in.
	{ key: 'morphit.locale', tier: 'device' },
	// Idle-lock timing is a property of the machine you are sitting at, not of you. Syncing a laptop
	// value onto a phone would be wrong.
	{ key: 'morphit.autoLock.timeoutMinutes', tier: 'device' },
	// Which nodes THIS browser can reach; network-dependent.
	{ key: 'morphit.rpcEndpoints', tier: 'device' },
	// Which build version this browser was told about.
	{ key: 'morphit.updateDismissed', tier: 'device' },
	// The outcome of the last release check (a signature-verified @morphit release record, public
	// chain data, or the kind of failure) and when it was made, so this browser asks the Blurt nodes
	// at most once a day. Names no person.
	{ key: 'morphit.releaseCheck.v2', tier: 'device' },
	// This browser dismissed the "install the app" banner. A flag; names no person. (Its colon puts
	// it outside the sign-out sweep's `morphit.` prefix, which is right for a device key.)
	{ key: 'morphit:install-banner-dismissed', tier: 'device' },
	// The treasury BTC keys of releases this browser verified, and when — public chain data, kept
	// 30 days, so an order numbered under an older key is checked with no request. Names no person.
	{ key: 'morphit.releaseCheck.v2.btcKeys', tier: 'device' },
	// Transient sessionStorage handoff flag: this tab already accepted a running
	// service-worker update, so the "Load it now" prompt is not offered twice before the reload
	// lands. Removed once applied — belongs to the in-flight update handoff, not to the person or
	// durably to the device.
	{ key: 'morphit.updateAcceptedRunning', tier: 'session' },
	// Browser-level permission bookkeeping. Re-prompting someone who declined at the OS level is
	// noise, and the decision is per-browser anyway.
	{ key: 'morphit.notifications.declineState', tier: 'device' },

	// ─── ACCOUNT — mirrored to chain ──────────────────────────────────
	// Fiat + region. THE ORIGINAL LEAK: a global key, so one account's region showed up in the
	// next account's fresh session.
	{ key: 'morphit.userPreferences.v1', tier: 'account', protection: 'mirrored' },
	// Local copy of the on-chain profile's preferred_langs (primary first). Not in the settings
	// blob and not re-seeded from the chain, so only the sign-out sweep protects it.
	{ key: 'morphit.preferredLangs.v1', tier: 'account', protection: 'sweep-only' },
	// v1.15.0 — the last language used to post an order on THIS browser; the default for the next
	// post. Browser-local convenience.
	{ key: 'morphit.lastPostLang.v1', tier: 'device' },
	// v1.20.0 (F-9) — sessionStorage flag: this browser tab dismissed the "plain-HTTP I2P turns some
	// features off" notice. Whether a page is a secure context is a property of the browser and the
	// address it is on, not of the person; it resets when the browser session ends.
	{ key: 'morphit.insecureContextNotice.dismissed', tier: 'device' },

	// Categories, channels, quiet hours.
	{ key: 'morphit.notifications.prefs.v1', tier: 'account', protection: 'mirrored' },
	// IndexedDB database (not localStorage): a copy of the quiet-hours / mute fields of
	// notifications.prefs.v1 for the service worker, so Web Push obeys them
	// ($lib/notifications/silenceState). Rewritten from those prefs on every load and change,
	// so it follows them (including the reset to defaults on sign-in).
	{ key: 'morphit-notify', tier: 'account', protection: 'mirrored' },
	// Accounts hidden from the user's own views.
	{ key: 'morphit.hiddenAccounts.v1', tier: 'account', protection: 'mirrored' },
	// Privacy-affecting opt-in; defaults OFF on reset so it is never inherited.
	{ key: 'morphit.crossPageTradeEvents.enabled', tier: 'account', protection: 'mirrored' },
	// v1.8.11 — publishes on the user's behalf. Was a global key; now mirrored and reset to OFF.
	{ key: 'morphit.syndication.firstTradeAnnounce', tier: 'account', protection: 'mirrored' },
	// v1.8.11 — as above.
	{ key: 'morphit.syndication.orderBlogDefault', tier: 'account', protection: 'mirrored' },

	// ─── ACCOUNT — suffixed with the account name ─────────────────────
	// Draft of the profile field; the durable copy is the morphit_profile_v1 record.
	{ key: 'morphit.displayName', tier: 'account', protection: 'suffixed' },
	// As above.
	{ key: 'morphit.shortBio', tier: 'account', protection: 'suffixed' },
	// As above.
	{ key: 'morphit.websiteUrl', tier: 'account', protection: 'suffixed' },
	// As above.
	{ key: 'morphit.streamingUrl', tier: 'account', protection: 'suffixed' },
	// As above.
	{ key: 'morphit.nostrUrl', tier: 'account', protection: 'suffixed' },
	// Per-account chat key-change policy.
	{ key: 'morphit.chatSecurity.mode', tier: 'account', protection: 'suffixed' },
	// Per-account one-shot nudge.
	{ key: 'morphit.chatSecurity.nudgeSeen', tier: 'account', protection: 'suffixed' },
	// One-shot milestone marker, per account.
	{ key: 'morphit.syndication.firstTradeFired', tier: 'account', protection: 'suffixed' },

	// ─── ACCOUNT — sweep-only (candidates for promotion) ──────────────
	// Safe between accounts because sign-out clears them, but they do NOT
	// follow the user to a new browser. Promote when the cost of losing them
	// on a new device outweighs the size they add to the blob.
	// Chat organisation. Genuinely account data; sizeable, so mirroring it needs its own design
	// (chatFolders.ts already has a chain path of its own).
	{ key: 'morphit.chat.folders', tier: 'account', protection: 'sweep-only' },
	// Bookkeeping for the above.
	{ key: 'morphit.chat.folders.lastAdoptedAt', tier: 'account', protection: 'sweep-only' },
	// Bookkeeping for the above.
	{ key: 'morphit.chat.folders.localChangedAt', tier: 'account', protection: 'sweep-only' },
	// Pinned counterparty keys — names peers, so it must never survive sign-out.
	{ key: 'morphit.chat.pub_pins', tier: 'account', protection: 'sweep-only' },
	// The user dismissed the one-time "the safety number is longer now, compare once more" note on
	// Verify peer. A flag; after a sign-out the next person sees the note once.
	{ key: 'morphit.chat.safetyNumberV2Seen', tier: 'account', protection: 'sweep-only' },
	// Which crypto addresses this person shared from this browser, as keyed one-way tags under a
	// per-install salt (no address, date or order id), so the share dialog can warn about reuse
	// ($lib/privacy/addressHistory). Their history, so it goes with them on sign-out; Settings →
	// Privacy also forgets it.
	{ key: 'morphit.address-history.v2', tier: 'account', protection: 'sweep-only' },
	// Written by older builds with the addresses in plaintext, with dates and order ids; converted
	// to the tag form and deleted at boot, and swept on sign-out.
	{ key: 'morphit.address-history.v1', tier: 'account', protection: 'sweep-only' },
	// Written by builds that did not verify the release signature; deleted on sight by
	// $net/releaseCache (and swept on sign-out). Holds no person data; filed here only so the device
	// tier stays the deliberate list of what survives a sign-out.
	{ key: 'morphit.releaseCheck.v1', tier: 'account', protection: 'sweep-only' },
	// Prefix: each tab about to run the release check writes `<this>.<random id>` = time (browsers
	// without Web Locks); the earliest claim runs it and the other tabs wait for its answer instead of
	// asking the nodes too ($net/onceAcrossTabs). Gone within minutes; names no person.
	{ key: 'morphit.releaseCheck.v2.claim', tier: 'account', protection: 'sweep-only' },
	// IndexedDB database (not localStorage): other accounts' public profiles this browser looked up,
	// so avatars render instantly ($lib/indexer/profilePersist). WHICH accounts are in it is the
	// person's history, so every record is filed under the signed-in account, expired records are
	// deleted when read, and an explicit Sign Out deletes the whole store (broadcastSignOut).
	// Outside the localStorage sweep, hence its own clear.
	{ key: 'morphit-profiles', tier: 'account', protection: 'suffixed' },
	// Changed counterparty keys waiting for the user to confirm the new safety number — names peers,
	// so it must never survive sign-out.
	{ key: 'morphit.chat.pub_pin_pending', tier: 'account', protection: 'sweep-only' },
	// The chat-key pins of a session locked with Lock, one slot per account (`.<id>`, derived one-way
	// from its posting key), encrypted under a posting-key-derived key so they name nobody while
	// locked; restored and removed at that account's next unlock. Kept on sign-out: another account
	// signing out must not strip this account's protection against a substituted key.
	{ key: 'morphit.chat.pub_pin_sealed', tier: 'account', protection: 'sealed' },
	// Per-conversation read cursors; names peers.
	{ key: 'morphit.chat.read_state', tier: 'account', protection: 'sweep-only' },
	// Names peers directly.
	{ key: 'morphit.chat.recent_peers', tier: 'account', protection: 'sweep-only' },
	// One-shot UI nudge.
	{ key: 'morphit.chatNotifNudge.dismissed', tier: 'account', protection: 'sweep-only' },
	// One-shot UI nudge.
	{ key: 'morphit.chatComposer.acctReminderSeen', tier: 'account', protection: 'sweep-only' },
	// Unsent drafts, including feedback drafts naming counterparties.
	{ key: 'morphit.draft', tier: 'account', protection: 'sweep-only' },
	// Half-written order form.
	{ key: 'morphit.post.prefill', tier: 'account', protection: 'sweep-only' },
	// Whether THIS user has seen the key-backup screen. Mirroring would wrongly mark a new device as
	// already-backed-up.
	{ key: 'morphit.backupKeysVisited', tier: 'account', protection: 'sweep-only' },
	// One-shot banner dismissal.
	{
		key: 'morphit.my_orders.fee_status_banner.dismissed.v1',
		tier: 'account',
		protection: 'sweep-only'
	},
	// One-shot migration marker for the chat-notification default.
	{ key: 'morphit.notif.chatDefaultOn.v1', tier: 'account', protection: 'sweep-only' },
	// One-shot UI collapse state.
	{ key: 'morphit.welcomeFirstBuyHero.collapsed', tier: 'account', protection: 'sweep-only' },
	// Legacy key, migrated into notifications.prefs.v1; kept classified so the sweep still clears an
	// old browser.
	{ key: 'morphit.tradeNotifications.enabled', tier: 'account', protection: 'sweep-only' },
	// Session-scoped by name; classified so the sweep covers it.
	{ key: 'morphit.feedbackReminders.firedThisSession', tier: 'account', protection: 'sweep-only' },
	// As above.
	{
		key: 'morphit.firstTradeHelper.dismissedThisSession',
		tier: 'account',
		protection: 'sweep-only'
	},
	// ── Found by the classification smoke on its first run (v1.8.11). All four
	//    were GLOBAL keys holding account state, i.e. the same shape as the
	//    userPreferences leak, just never reported.
	// Order permlinks THIS user recently cancelled — their trading activity. Was global.
	{ key: 'morphit.recent_cancels_v1', tier: 'account', protection: 'sweep-only' },
	// Order permlinks THIS user recently completed. Was global.
	{ key: 'morphit.recent_completes_v1', tier: 'account', protection: 'sweep-only' },
	// Whether THIS user has un-backed-up key material. A boolean, not the material itself — but
	// leaving it global told the NEXT account it had keys to back up.
	{ key: 'morphit.backup_material_pending', tier: 'account', protection: 'sweep-only' },
	// One-shot dismissal of the key-backup nudge; per person, not per browser.
	{ key: 'morphit.keystore.backup_nudge_dismissed', tier: 'account', protection: 'sweep-only' }
];

/** Keys kept on an explicit sign-out: exactly the device tier. Derived, so the
 *  sweep and this classification can never disagree. */
export function deviceKeys(): readonly string[] {
	return STORAGE_KEYS.filter((k) => k.tier === 'device').map((k) => k.key);
}

/** True when `key` is covered by this registry — exact match, or a declared
 *  prefix for the suffixed/namespaced families. */
export function isClassified(key: string): boolean {
	return STORAGE_KEYS.some((s) => key === s.key || key.startsWith(`${s.key}.`));
}
