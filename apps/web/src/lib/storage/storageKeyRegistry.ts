/**
 * Morphit — every localStorage key, classified.
 *
 * ─── Why this file exists ─────────────────────────────────────────────
 *
 * Ken signed out of @kentest3, signed into @kencode, and found his previous
 * account's region setting waiting for him. The cause was not one bad key but
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
 *   order, per Ken's model:
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
 * keys that are neither mirrored nor suffixed yet.
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
	 *  candidate for promotion to mirrored or suffixed; the note says why it
	 *  has not been promoted. */
	| 'sweep-only';

export interface StorageKeySpec {
	/** The literal key, or its stable prefix when a suffix is appended. */
	readonly key: string;
	readonly tier: StorageTier;
	/** Required for ACCOUNT keys; meaningless for device/session. */
	readonly protection?: AccountProtection;
	/** Why this classification is right. Read this before changing a tier. */
	readonly note: string;
}

export const STORAGE_KEYS: readonly StorageKeySpec[] = [
	// ─── SESSION ──────────────────────────────────────────────────────
	{ key: 'morphit.blurtAccount', tier: 'session', note: 'Who is signed in. Cleared by broadcastSignOut.' },
	{ key: 'morphit.keystore.envelope', tier: 'session', note: 'Encrypted key material. Cleared by clearKeystore.' },
	{ key: 'morphit.keystore.mode', tier: 'session', note: 'Unlock mode for the envelope above.' },
	{ key: 'morphit.keystore.first_persist_at', tier: 'session', note: 'When the envelope was first written.' },
	{ key: 'morphit.paired.session', tier: 'session', note: 'Paired read-only session marker.' },
	{ key: 'morphit.import.needs_account_name', tier: 'session', note: 'In-flight import/login state: the key was accepted but the account name is still needed. Belongs to the sign-in attempt, not the person.' },

	// ─── DEVICE ───────────────────────────────────────────────────────
	// Kept on an explicit sign-out. Nothing here may name a person or their
	// content — `signOutSweep.test.ts` asserts exactly that.
	{ key: 'morphit.locale', tier: 'device', note: 'Which language THIS browser renders in.' },
	{ key: 'morphit.autoLock.timeoutMinutes', tier: 'device', note: 'Idle-lock timing is a property of the machine you are sitting at, not of you. Syncing a laptop value onto a phone would be wrong.' },
	{ key: 'morphit.rpcEndpoints', tier: 'device', note: 'Which nodes THIS browser can reach; network-dependent.' },
	{ key: 'morphit.updateDismissed', tier: 'device', note: 'Which build version this browser was told about.' },
	{ key: 'morphit.notifications.declineState', tier: 'device', note: 'Browser-level permission bookkeeping. Re-prompting someone who declined at the OS level is noise, and the decision is per-browser anyway.' },

	// ─── ACCOUNT — mirrored to chain ──────────────────────────────────
	{ key: 'morphit.userPreferences.v1', tier: 'account', protection: 'mirrored', note: 'Fiat + region. THE ORIGINAL LEAK: a global key, so Ken saw his kentest3 region in a fresh kencode session.' },
	{ key: 'morphit.notifications.prefs.v1', tier: 'account', protection: 'mirrored', note: 'Categories, channels, quiet hours.' },
	{ key: 'morphit.hiddenAccounts.v1', tier: 'account', protection: 'mirrored', note: 'Accounts hidden from the user\'s own views.' },
	{ key: 'morphit.crossPageTradeEvents.enabled', tier: 'account', protection: 'mirrored', note: 'Privacy-affecting opt-in; defaults OFF on reset so it is never inherited.' },
	{ key: 'morphit.syndication.firstTradeAnnounce', tier: 'account', protection: 'mirrored', note: 'v1.8.11 — publishes on the user\'s behalf. Was a global key; now mirrored and reset to OFF.' },
	{ key: 'morphit.syndication.orderBlogDefault', tier: 'account', protection: 'mirrored', note: 'v1.8.11 — as above.' },

	// ─── ACCOUNT — suffixed with the account name ─────────────────────
	{ key: 'morphit.displayName', tier: 'account', protection: 'suffixed', note: 'Draft of the profile field; the durable copy is the morphit_profile_v1 record.' },
	{ key: 'morphit.shortBio', tier: 'account', protection: 'suffixed', note: 'As above.' },
	{ key: 'morphit.websiteUrl', tier: 'account', protection: 'suffixed', note: 'As above.' },
	{ key: 'morphit.streamingUrl', tier: 'account', protection: 'suffixed', note: 'As above.' },
	{ key: 'morphit.nostrUrl', tier: 'account', protection: 'suffixed', note: 'As above.' },
	{ key: 'morphit.chatSecurity.mode', tier: 'account', protection: 'suffixed', note: 'Per-account chat key-change policy.' },
	{ key: 'morphit.chatSecurity.nudgeSeen', tier: 'account', protection: 'suffixed', note: 'Per-account one-shot nudge.' },
	{ key: 'morphit.syndication.firstTradeFired', tier: 'account', protection: 'suffixed', note: 'One-shot milestone marker, per account.' },

	// ─── ACCOUNT — sweep-only (candidates for promotion) ──────────────
	// Safe between accounts because sign-out clears them, but they do NOT
	// follow the user to a new browser. Promote when the cost of losing them
	// on a new device outweighs the size they add to the blob.
	{ key: 'morphit.chat.folders', tier: 'account', protection: 'sweep-only', note: 'Chat organisation. Genuinely account data; sizeable, so mirroring it needs its own design (chatFolders.ts already has a chain path of its own).' },
	{ key: 'morphit.chat.folders.lastAdoptedAt', tier: 'account', protection: 'sweep-only', note: 'Bookkeeping for the above.' },
	{ key: 'morphit.chat.folders.localChangedAt', tier: 'account', protection: 'sweep-only', note: 'Bookkeeping for the above.' },
	{ key: 'morphit.chat.pub_pins', tier: 'account', protection: 'sweep-only', note: 'Pinned counterparty keys — names peers, so it must never survive sign-out.' },
	{ key: 'morphit.chat.read_state', tier: 'account', protection: 'sweep-only', note: 'Per-conversation read cursors; names peers.' },
	{ key: 'morphit.chat.recent_peers', tier: 'account', protection: 'sweep-only', note: 'Names peers directly.' },
	{ key: 'morphit.chatNotifNudge.dismissed', tier: 'account', protection: 'sweep-only', note: 'One-shot UI nudge.' },
	{ key: 'morphit.chatComposer.acctReminderSeen', tier: 'account', protection: 'sweep-only', note: 'One-shot UI nudge.' },
	{ key: 'morphit.draft', tier: 'account', protection: 'sweep-only', note: 'Unsent drafts, including feedback drafts naming counterparties.' },
	{ key: 'morphit.post.prefill', tier: 'account', protection: 'sweep-only', note: 'Half-written order form.' },
	{ key: 'morphit.backupKeysVisited', tier: 'account', protection: 'sweep-only', note: 'Whether THIS user has seen the key-backup screen. Mirroring would wrongly mark a new device as already-backed-up.' },
	{ key: 'morphit.my_orders.fee_status_banner.dismissed.v1', tier: 'account', protection: 'sweep-only', note: 'One-shot banner dismissal.' },
	{ key: 'morphit.notif.chatDefaultOn.v1', tier: 'account', protection: 'sweep-only', note: 'One-shot migration marker for the chat-notification default.' },
	{ key: 'morphit.welcomeFirstBuyHero.collapsed', tier: 'account', protection: 'sweep-only', note: 'One-shot UI collapse state.' },
	{ key: 'morphit.tradeNotifications.enabled', tier: 'account', protection: 'sweep-only', note: 'Legacy key, migrated into notifications.prefs.v1; kept classified so the sweep still clears an old browser.' },
	{ key: 'morphit.feedbackReminders.firedThisSession', tier: 'account', protection: 'sweep-only', note: 'Session-scoped by name; classified so the sweep covers it.' },
	{ key: 'morphit.firstTradeHelper.dismissedThisSession', tier: 'account', protection: 'sweep-only', note: 'As above.' },
	{ key: 'morphit.debug.chat', tier: 'account', protection: 'sweep-only', note: 'Debug toggle. Not user content, but its NAME reads as chat state, so it is swept rather than sitting in the device allow-list — see signOutSweep.ts.' },
	// ── Found by the classification smoke on its first run (v1.8.11). All four
	//    were GLOBAL keys holding account state, i.e. the same shape as the
	//    userPreferences leak, just never reported.
	{ key: 'morphit.recent_cancels_v1', tier: 'account', protection: 'sweep-only', note: 'Order permlinks THIS user recently cancelled — their trading activity. Was global.' },
	{ key: 'morphit.recent_completes_v1', tier: 'account', protection: 'sweep-only', note: 'Order permlinks THIS user recently completed. Was global.' },
	{ key: 'morphit.backup_material_pending', tier: 'account', protection: 'sweep-only', note: 'Whether THIS user has un-backed-up key material. A boolean, not the material itself — but leaving it global told the NEXT account it had keys to back up.' },
	{ key: 'morphit.keystore.backup_nudge_dismissed', tier: 'account', protection: 'sweep-only', note: 'One-shot dismissal of the key-backup nudge; per person, not per browser.' }
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
