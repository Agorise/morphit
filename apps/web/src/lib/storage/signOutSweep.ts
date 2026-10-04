/**
 * Morphit — what an explicit Sign Out forgets.
 *
 * ─── The bug this exists to kill ──────────────────────────────────────
 *
 * Sign Out cleared five things: the keystore envelope, the paired-session
 * marker, the in-memory keys, `morphit.blurtAccount`, and the cached
 * self-avatar. Everything else in localStorage survived — including a pile of
 * keys derived from WHO YOU WERE:
 *
 *   morphit.displayName.<acct>      morphit.shortBio.<acct>
 *   morphit.websiteUrl.<acct>       morphit.streamingUrl.<acct>
 *   morphit.nostrUrl.<acct>         morphit.chatSecurity.mode.<acct>
 *   morphit.syndication.firstTradeFired.<acct>
 *   morphit.userPreferences.v1      ← NOT account-scoped at all
 *   morphit.chat.*                  ← peer names, pins, read state, folders
 *   morphit.draft.feedback.*        ← unsent review drafts naming counterparties
 *
 * Most are account-SUFFIXED, so in principle they can't be read by the next
 * account. Two things broke that in practice:
 *
 *   1. `morphit.userPreferences.v1` (fiat + region) has NO suffix, so it is
 *      simply shared. The maintainer watched his tester3 region ("Your place or mine,
 *      whatever.") carry straight into a fresh testowner session.
 *   2. The suffix is resolved from `getUserBlurtAccount()` at COMPONENT INIT.
 *      Sign out and back in without a reload and the component never
 *      remounts, so the new account reads the OLD account's suffix.
 *
 * And regardless of scoping, leaving a signed-out person's bio, links, chat
 * peers and unsent drafts on a shared machine is wrong on its own terms. When
 * someone says "sign me out", the honest reading is "forget who I was."
 *
 * ─── The rule ─────────────────────────────────────────────────────────
 *
 * An explicit Sign Out forgets WHO YOU WERE. It keeps HOW THIS DEVICE
 * BEHAVES — locale, auto-lock timeout, RPC endpoints, debug flags — because
 * those are properties of the browser, not of the person, and wiping them
 * would punish the next sign-in for no privacy gain.
 *
 * Implemented as an ALLOW-LIST of device keys rather than a block-list of
 * account keys. A block-list silently fails open: add a new per-account key
 * and it survives sign-out until someone remembers to list it. An allow-list
 * fails CLOSED — a new key is forgotten by default, which is the safe
 * direction for anything holding user data.
 */

/** Keys that describe the DEVICE, not the person. Everything else under the
 *  `morphit.` prefix is cleared on an explicit sign-out.
 *
 *  DERIVED from `storageKeyRegistry`, never hand-maintained: the registry is
 *  the single place a key's tier is decided, so the sweep and the
 *  classification cannot drift apart. Moving a key into the device tier there
 *  means "this is safe to leave behind on a shared machine after someone signs
 *  out" — if it holds anything about a person, it does not belong there. */
export const DEVICE_KEYS: readonly string[] = deviceKeys();

/** Per-account sealed slots (`<family>.<slot>`): encrypted under that account's
 *  own key and naming nobody, so the sweep leaves them — one account's Sign Out
 *  must not strip another's sealed state (registry protection 'sealed'). */
export const SEALED_FAMILIES: readonly string[] = STORAGE_KEYS.filter(
	(k) => k.protection === 'sealed'
).map((k) => k.key);

import { deviceKeys, STORAGE_KEYS } from './storageKeyRegistry';

/** Prefix every Morphit-owned key shares. Anything outside it belongs to
 *  another app on the origin and is none of our business. */
const MORPHIT_PREFIX = 'morphit.';

/**
 * Forget every account-derived key. Called ONLY from the explicit Sign Out
 * path — never from `reset()`, `lockSession()` or `pagehide`, all of which
 * are "this tab is going away", not "this person is leaving".
 *
 * Best-effort and never throws: some browsers deny localStorage in private or
 * storage-restricted contexts, and a sign-out must complete regardless.
 */
export function sweepAccountStorageOnSignOut(storage?: Storage): void {
	let store: Storage;
	try {
		store = storage ?? window.localStorage;
	} catch {
		return; // storage unavailable (private mode / blocked) — nothing to do
	}

	const device = new Set(DEVICE_KEYS);
	const doomed: string[] = [];
	const sealed = (key: string): boolean =>
		SEALED_FAMILIES.some((p) => key === p || key.startsWith(`${p}.`));
	try {
		for (let i = 0; i < store.length; i++) {
			const key = store.key(i);
			if (key === null) continue;
			if (!key.startsWith(MORPHIT_PREFIX)) continue;
			if (device.has(key) || sealed(key)) continue;
			doomed.push(key);
		}
	} catch {
		return; // enumeration failed — leave storage untouched rather than half-clear
	}

	// Collect first, delete second: removing during enumeration shifts the
	// indices and silently skips keys.
	for (const key of doomed) {
		try {
			store.removeItem(key);
		} catch {
			// Isolated: one failed removal must not abort the rest.
		}
	}
}

/** What a tab may hold about the person in its OWN sessionStorage: the account
 *  name of a "just this session" sign-in (`morphit.blurtAccount`, and its
 *  per-key `.<id>` form) and the account-tier keys such a sign-in keeps there
 *  instead of on disk (chat read state, recent peers). */
const SESSION_PERSON_KEYS: readonly string[] = [
	'morphit.blurtAccount',
	...STORAGE_KEYS.filter((k) => k.tier === 'account').map((k) => k.key)
];

/**
 * Explicit Sign Out, this tab's sessionStorage. Each tab has its own, so the
 * tab that signed out cannot reach a sibling's: every tab runs this when it
 * learns of the sign-out ($stores/identity). Only the person's keys go —
 * per-tab UI state (a dismissed banner, the reload guard of an update) stays.
 * Best-effort and never throws, like the localStorage sweep.
 */
export function sweepSessionAccountKeysOnSignOut(storage?: Storage): void {
	let store: Storage;
	try {
		store = storage ?? window.sessionStorage;
	} catch {
		return;
	}
	const doomed: string[] = [];
	try {
		for (let i = 0; i < store.length; i++) {
			const key = store.key(i);
			if (key === null) continue;
			if (SESSION_PERSON_KEYS.some((p) => key === p || key.startsWith(`${p}.`))) doomed.push(key);
		}
	} catch {
		return;
	}
	for (const key of doomed) {
		try {
			store.removeItem(key);
		} catch {
			// Isolated, as above.
		}
	}
}
