/**
 * Morphit — profile op broadcaster.
 *
 * Builds a `morphit_profile_v1` custom_json payload, signs it with the
 * user's posting key (from the LiveIdentity store), and broadcasts it
 * same-origin through this instance's indexer. Indexers read the latest
 * op from the signing account and treat it as canonical.
 *
 * The broadcast needs the user's Blurt account name; with none on file
 * this function throws a clear error. Settings catches and shows the
 * message; the display name is already saved locally.
 *
 * Security note: every free-text field (display_name, nostr_url,
 * streaming_url) is run through redactPrivateKeys() before broadcast.
 * Same defense-in-depth pattern as buildOrderPayload — no order op or
 * profile op can leak a private key to chain, regardless of what the
 * UI layer did. URL fields are already URL-validated at form time, so
 * reaching this path with a key embedded would itself be a bug; the
 * redaction is a safety backstop for that bug.
 */

import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
// Byte budget: `broadcastCustomJson` is dynamically imported
// inside `broadcastProfile` (which is only called on user action).
// A static import of '../sign' here transitively pulled dblurt into
// the eager-load graph of any route that imports profile.ts for the
// read-only helper `getUserBlurtAccount` (used by /my/orders,
// /chat/*, /settings, etc.).  Switching to dynamic import keeps the
// 2 MB dblurt chunk out of those routes' first paint — the chunk
// loads only when the user actually triggers a profile broadcast.
import { OP_IDS } from '$net/config';
import { BroadcastError } from '../broadcastTransport';
import type { LiveIdentity } from '$crypto/keygen';
import { redactPrivateKeys } from '$lib/security/privateKeyDetector';
import { isOrderLang } from '$i18n/locales';
import { clearProfileCache, setProfileCacheScope } from '$lib/indexer/profileCache';
import { hasPersistedKeystore } from '$crypto/persistentKeystore';
import { readPairedSession } from '$crypto/pairedSession';

/** Legacy, origin-wide. Read for migration; never written for a keyed session. */
const ACCOUNT_STORAGE_KEY = 'morphit.blurtAccount';

/**
 * the account name is a property of the KEY, not of the browser origin.
 *
 * One origin-wide key meant tab A (signed in as @tester2) and tab B (@tester3)
 * shared a single name, and a `storage` listener rewrote it under whichever tab
 * lost the race. Tab A then signed with tester2's posting key while declaring
 * `required_posting_auths: ["tester3"]`, and the chain answered "Missing Posting
 * Authority tester3". Scoping the key to the session's posting pubkey removes
 * the collision at the source, with no network call and no lookup to trust.
 *
 * The suffix is a hex prefix of the session's posting PUBLIC key — unique in
 * practice, never secret (it is published on-chain in the account's authorities).
 * It is deliberately not the BLT-formatted string: the formatter lives in
 * `$crypto/keygen`, and the identity store that supplies this value is on the
 * every-page baseline.
 */
function scopedAccountKey(sessionKeyId: string): string {
	return `morphit.blurtAccount.${sessionKeyId.slice(0, 16)}`;
}

/** Id of the posting key this session holds, or null when locked. */
function currentSessionKeyId(): string | null {
	return get(sessionKeyIdStore);
}

/** Set once per unlock by `bindSessionPostingKey()`; cleared on lock/sign-out. */
const sessionKeyIdStore = writable<string | null>(null);

/** True while this tab's session is the one remembered on this device
 *  ("Remember me"). Only then does the account name go to localStorage;
 *  a "just this session" sign-in keeps it in this tab's sessionStorage, so
 *  closing the tab forgets it and a later anonymous visit cannot announce
 *  it (orders, chat stream, settings all read it). */
let sessionRemembered = false;

/**
 * Bind account storage to the keys this tab actually holds. Called from the
 * identity store whenever a session becomes unlocked (and when Remember-me
 * is committed for it), and with `null` on lock.
 */
export function bindSessionPostingKey(keyId: string | null, remembered = false): void {
	sessionKeyIdStore.set(keyId);
	sessionRemembered = keyId !== null && remembered;
	if (keyId !== null && sessionRemembered) promoteSessionAccountName(keyId);
	blurtAccountName.set(readAccountFromStorage());
}

/** Remember-me was committed for a session whose name so far lived only in
 *  this tab: move it to localStorage. */
function promoteSessionAccountName(keyId: string): void {
	if (!browser) return;
	try {
		const name =
			window.sessionStorage.getItem(scopedAccountKey(keyId)) ??
			window.sessionStorage.getItem(ACCOUNT_STORAGE_KEY);
		if (name) {
			window.localStorage.setItem(scopedAccountKey(keyId), name);
			window.localStorage.setItem(ACCOUNT_STORAGE_KEY, name);
		}
		window.sessionStorage.removeItem(scopedAccountKey(keyId));
		window.sessionStorage.removeItem(ACCOUNT_STORAGE_KEY);
	} catch {
		/* storage unavailable */
	}
}

function readAccountFromStorage(): string | null {
	if (!browser) return null;
	try {
		const pub = currentSessionKeyId();
		// This tab's "just this session" name first, then the remembered one.
		for (const store of [window.sessionStorage, window.localStorage]) {
			if (pub) {
				const scoped = store.getItem(scopedAccountKey(pub));
				if (scoped) return scoped;
			}
		}
		if (pub) {
			// One-time migration: an origin-wide name written before names were
			// scoped belongs to whichever key is unlocked when it is first read.
			const legacy = window.localStorage.getItem(ACCOUNT_STORAGE_KEY);
			if (legacy) {
				window.localStorage.setItem(scopedAccountKey(pub), legacy);
				return legacy;
			}
			return window.sessionStorage.getItem(ACCOUNT_STORAGE_KEY);
		}
		// Locked / pre-unlock (the avatar seeds from this): the origin-wide value.
		return (
			window.sessionStorage.getItem(ACCOUNT_STORAGE_KEY) ??
			window.localStorage.getItem(ACCOUNT_STORAGE_KEY)
		);
	} catch {
		return null;
	}
}

/** Boot: an account name in localStorage with nothing on this device to sign
 *  in with — no remembered keystore, no paired session — was left by a "just
 *  this session" sign-in of an older build. Forget it, so anonymous visits
 *  stop announcing it. */
function forgetOrphanedAccountName(): void {
	if (!browser) return;
	try {
		if (hasPersistedKeystore() || readPairedSession() !== null) return;
		const doomed: string[] = [];
		for (let i = 0; i < window.localStorage.length; i++) {
			const k = window.localStorage.key(i);
			if (k !== null && (k === ACCOUNT_STORAGE_KEY || k.startsWith(`${ACCOUNT_STORAGE_KEY}.`))) {
				doomed.push(k);
			}
		}
		for (const k of doomed) window.localStorage.removeItem(k);
	} catch {
		/* storage unavailable */
	}
}
forgetOrphanedAccountName();

/**
 * Reactive mirror of the persisted Blurt account name.
 *
 * Why this exists (beta.29): the always-visible AvatarMenu seeds the
 * user's identicon from this name. It read `getUserBlurtAccount()` —
 * an imperative localStorage read — inside a `$derived` whose only
 * reactive deps were the keystore stores, NEITHER of which changes
 * when registration writes the name (the keypair is identical before
 * and after). Because the avatar `<img>` is always on screen, that
 * `$derived` computed once during onboarding — before a name existed —
 * cached the pubkey-seeded fallback heart, and never recomputed within
 * the session. The result: the avatar showed a heart that mismatched
 * the name-seeded heart every freshly-loaded page renders (profile
 * hero, /settings cards, register-name preview). Subscribing to this
 * store makes every consumer recompute the instant the name is set.
 *
 * Source of truth is still localStorage (survives reloads, shared
 * across tabs); this store mirrors it. `set`/`clearUserBlurtAccount`
 * keep it current in-tab, and the `storage` listener below syncs
 * changes made by OTHER tabs (registering or signing out elsewhere).
 */
export const blurtAccountName = writable<string | null>(readAccountFromStorage());

// The on-disk profile cache is filed under the signed-in account, so another
// account on this device never reads the list of accounts this one looked at.
blurtAccountName.subscribe((account) => setProfileCacheScope(account));

if (browser) {
	// Cross-tab: a `storage` event fires in every OTHER tab when this key
	// changes, so registering / signing out in one tab keeps the avatar correct
	// everywhere without a reload.
	//
	// BUT NOT WHILE THIS TAB HOLDS KEYS. The account name is origin-wide; the
	// KEYS are per-session and in memory. Letting another tab's sign-in rewrite
	// this tab's account name gave us a session holding @tester2's posting key
	// while believing it was @tester3 — every broadcast then declared tester3,
	// was signed by tester2, and the chain answered "Missing Posting Authority
	// tester3". An account name that can be changed out from under a live key is
	// not a name, it's a race.
	window.addEventListener('storage', (e) => {
		if (e.key !== ACCOUNT_STORAGE_KEY && e.key !== null) return;
		// If this tab holds keys, its account name is already scoped to them and
		// no other tab may move it. Only an unbound (locked) tab follows along.
		if (currentSessionKeyId() !== null) return;
		blurtAccountName.set(e.key === null ? readAccountFromStorage() : e.newValue);
	});
}

/** Return the Blurt account name the user registered, or null.
 *
 *  Reads the in-memory store first: while a session is unlocked, that value is
 *  bound to the keys this tab actually holds, and another tab's sign-in cannot
 *  move it. localStorage is the cold-start fallback.
 *
 *  This is still only a HINT for broadcasting — see `accountBinding.ts`, which
 *  resolves the authoritative account from the posting key itself. */
export function getUserBlurtAccount(): string | null {
	const inMemory = get(blurtAccountName);
	return inMemory ?? readAccountFromStorage();
}

/** Record the Blurt account name after registration / sign-in. */
export function setUserBlurtAccount(name: string): void {
	if (!browser) return;
	try {
		const pub = currentSessionKeyId();
		// A remembered session's name goes to localStorage; a "just this
		// session" one stays in this tab (see sessionRemembered).
		const store = sessionRemembered ? window.localStorage : window.sessionStorage;
		// Write under the key that owns this name. The legacy origin-wide slot is
		// kept in step ONLY so a locked tab still has an identicon to seed from;
		// it is never the source of truth for a broadcast.
		if (pub) store.setItem(scopedAccountKey(pub), name);
		store.setItem(ACCOUNT_STORAGE_KEY, name);
	} catch {
		// Privacy Mode; the account name will need to be re-entered next
		// session.
	}
	// Update the reactive mirror regardless of whether the persistent
	// write succeeded — even in Privacy Mode the name is valid for THIS
	// session, so the avatar should reflect it immediately.
	blurtAccountName.set(name);
}

/** Forget the persisted account name.  Call this on a DELIBERATE
 *  account switch/sign-out (e.g. the login page's "sign out first"
 *  confirm) — NOT from the identity store's `reset()`, which also runs
 *  on `pagehide` (tab close) where wiping this cache would needlessly
 *  force the user to re-type their account name every session.
 *
 *  Why this exists: the login page gates its "sign you out of
 *  @NNN first" modal on `getUserBlurtAccount()`, which reads this
 *  persistent key.  `reset()` clears the in-memory keystore but leaves
 *  this name, so after confirming the switch the gate still saw an
 *  account and the modal re-fired on the next attempt — looking like
 *  the sign-out hadn't happened.  Clearing the name here closes that. */
export function clearUserBlurtAccount(): void {
	if (!browser) return;
	for (const store of [() => window.localStorage, () => window.sessionStorage]) {
		try {
			store().removeItem(ACCOUNT_STORAGE_KEY);
		} catch {
			// Privacy Mode / storage unavailable — nothing persisted to clear.
		}
	}
	try {
		const pub = currentSessionKeyId();
		if (pub) window.sessionStorage.removeItem(scopedAccountKey(pub));
	} catch {
		/* storage unavailable */
	}
	blurtAccountName.set(null);
}

export interface ProfilePayload {
	/** Optional human-readable display name, validated by caller when
	 *  present. May be omitted (or empty) so a user can set an avatar
	 *  or links without first picking a name; an empty value never
	 *  overwrites a name already on-chain (indexer-side guard). */
	display_name?: string;
	/** Optional Nostr profile URL (nostr:npub1... or https://...).
	 *  Stored in json_metadata.nostr_url on-chain; surfaces as a
	 *  link icon next to every rendered username when populated.
	 *  Validated client-side at render time — see IdentityLabel's
	 *  validateNostrUrl helper. */
	nostr_url?: string;
	/** Optional streaming-profile URL (YouTube, Rumble, Blurt.media,
	 *  Twitch, …). Stored in json_metadata.streaming_url on-chain;
	 *  surfaces as a play glyph next to the username when populated.
	 *  Validated client-side via validateWebUrl — any http/https host. */
	streaming_url?: string;
	/** Optional website / blog URL (any http/https host). Stored in
	 *  json_metadata.website_url on-chain; surfaces as a globe link icon
	 *  next to the username when populated. Validated client-side via
	 *  validateWebUrl — http/https only, any host, no dangerous schemes. */
	website_url?: string;
	/** Optional short bio / tagline (≤128 codepoints, validated by
	 *  caller via validateShortBio). Stored in json_metadata.short_bio
	 *  on-chain; surfaces on the account profile page. Free text. */
	short_bio?: string;
	/** v1.15.0 — ordered preferred languages (first = primary). Array of
	 *  SUPPORTED_LOCALES codes. Stored in json_metadata.preferred_langs on-chain;
	 *  drives the order-language default + the orderbook language filter default.
	 *  Empty array clears; omitted keeps the prior value. */
	preferred_langs?: readonly string[];
	/** Optional sanitized SVG text for a custom avatar. Stored in
	 *  json_metadata.avatar_svg on-chain. MUST have been produced
	 *  by `sanitizeSvg` in $lib/avatar — the broadcast path does
	 *  NOT re-sanitize (that would be duplicated work). Avatars render
	 *  through an `<img>` data URI, which runs no script, but other
	 *  readers of the chain may not be so careful.
	 *  At most one of avatar_svg / avatar_data_uri should be set.
	 *  Empty string explicitly clears a previously-set avatar. */
	avatar_svg?: string;
	/** Optional base64 data URI (image/webp) for a custom avatar.
	 *  Stored in json_metadata.avatar_data_uri on-chain. MUST have
	 *  been produced by `reencodeRaster` — the 96×96 WebP encoding
	 *  is what the renderer expects.
	 *  At most one of avatar_svg / avatar_data_uri should be set.
	 *  Empty string explicitly clears a previously-set avatar. */
	avatar_data_uri?: string;
	/** Schema version marker so the indexer can handle future migrations. */
	v?: 1;
	/** Unix seconds at which the payload was produced. Indexer uses this
	 *  as a tiebreaker when multiple ops arrive in the same block. */
	ts?: number;
}

/**
 * Broadcast a profile update. Returns `{ ok: true, broadcast: ... }` on
 * chain broadcast, `{ ok: false, reason: 'no_account' }` if the user has
 * no Blurt account yet (local-only save is still fine in that case).
 */
// BroadcastError moved to ../broadcastTransport (v1.16.5) so the pure
// broadcast-error classifier can import it without profile.ts's $app deps.
// Re-exported here so existing `import { BroadcastError } from '$blurt/ops/profile'`
// call sites keep working.
export { BroadcastError };
// (imported at the top for internal `throw new BroadcastError(...)`; re-exported
//  here so existing `import { BroadcastError } from '$blurt/ops/profile'` works.)

/** Pure body-builder for a profile op. Takes the payload plus
 *  an explicit `ts` (unix seconds) and returns the wire body
 *  with redaction applied to every free-text field.
 *
 *  Extracted from `broadcastProfile` so redaction behavior is
 *  testable as a pure function. Caller supplies `ts` so tests
 *  can pin the timestamp for deterministic assertions; the
 *  broadcast wrapper supplies `Math.floor(Date.now() / 1000)`.
 */
export function buildProfileBody(
	payload: ProfilePayload,
	ts: number
): ProfilePayload & { json_metadata?: Record<string, unknown> } {
	// Build the json_metadata freeform bag from optional profile
	// fields. The indexer preserves this as opaque JSON; consumers
	// (profile page, IdentityLabel) read specific keys out of it.
	// Every free-text value is passed through redactPrivateKeys
	// as a safety backstop — a key embedded here is almost
	// certainly a user mistake (URL fields are pre-validated
	// upstream; a WIF doesn't parse as a URL), but the chokepoint
	// discipline means no op leaves this module unredacted.
	const jsonMetadata: Record<string, unknown> = {};
	// Text link/bio fields. Match the avatar convention below: an
	// explicit empty string is a deliberate CLEAR signal (the indexer
	// merge drops the key), while `undefined` means "not part of this
	// update" and is omitted so the prior on-chain value is preserved.
	// (Prior to v1.4.8 these used a truthy check that swallowed the
	// empty string, so tapping Clear + Save silently kept the old value.)
	if (payload.nostr_url !== undefined) {
		const t = payload.nostr_url.trim();
		jsonMetadata.nostr_url = t.length > 0 ? redactPrivateKeys(t) : '';
	}
	if (payload.streaming_url !== undefined) {
		const t = payload.streaming_url.trim();
		jsonMetadata.streaming_url = t.length > 0 ? redactPrivateKeys(t) : '';
	}
	if (payload.website_url !== undefined) {
		const t = payload.website_url.trim();
		jsonMetadata.website_url = t.length > 0 ? redactPrivateKeys(t) : '';
	}
	if (payload.short_bio !== undefined) {
		const t = payload.short_bio.trim();
		jsonMetadata.short_bio = t.length > 0 ? redactPrivateKeys(t) : '';
	}
	// Avatar fields. We trust the sanitizer/encoder output — that's
	// the chokepoint for safety — but still run redactPrivateKeys
	// as a belt-and-suspenders check. A WIF embedded in an SVG text
	// node would be a very unusual attack shape, but if it happened,
	// the redactor would catch it. An empty string is a deliberate
	// clear-the-avatar signal; we pass it through so the indexer
	// overwrites any prior avatar.
	if (payload.avatar_svg !== undefined) {
		jsonMetadata.avatar_svg = redactPrivateKeys(payload.avatar_svg);
	}
	if (payload.avatar_data_uri !== undefined) {
		// Data URIs don't meaningfully contain private keys — the
		// base64 payload is image bytes — but keep the redaction
		// pass uniform for audit clarity.
		jsonMetadata.avatar_data_uri = redactPrivateKeys(payload.avatar_data_uri);
	}
	// v1.15.0 — preferred languages (ordered: first = primary). An array of
	// SUPPORTED_LOCALES codes. Present + non-empty ⇒ set (validated/deduped by the
	// indexer merge); an explicit empty array ⇒ clear. Omitted ⇒ prior kept.
	if (payload.preferred_langs !== undefined) {
		jsonMetadata.preferred_langs = payload.preferred_langs.filter((c) => isOrderLang(c));
	}

	const body: ProfilePayload & { json_metadata?: Record<string, unknown> } = {
		v: 1,
		display_name: payload.display_name ? redactPrivateKeys(payload.display_name) : '',
		ts
	};
	if (Object.keys(jsonMetadata).length > 0) {
		body.json_metadata = jsonMetadata;
	}
	return body;
}

export async function broadcastProfile(
	live: LiveIdentity,
	payload: ProfilePayload
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered yet.');
	}
	// pre-flight REMOVED. Chat messages (morphit_chat_v1) broadcast
	// fine with the same posting key through the same broadcastCustomJson, but
	// they go STRAIGHT to it. The profile broadcast used to run a pre-flight
	// first (a dblurt import via formatPublicKeyBLT + an account-keys fetch);
	// that was the ONLY code-path difference between a WORKING chat broadcast
	// and a FAILING profile broadcast ("Missing Posting Authority" despite a
	// valid key). We now take the identical path chat does — build the op and
	// broadcast. If a real identity↔account mismatch ever occurs, the chain's
	// own rejection is surfaced via broadcastErrCopy, same as every other op.
	const body = buildProfileBody(payload, Math.floor(Date.now() / 1000));
	// dynamic import of '../sign' keeps dblurt out of the
	// eager-load graph for read-only routes that pull profile.ts.
	const { broadcastCustomJson } = await import('../sign');
	const result = await broadcastCustomJson(live, OP_IDS.profile, body, account);
	// Invalidate the client-side profile cache for this account so
	// the user sees their own updated display_name / avatar
	// immediately on subsequent navigations, rather than waiting up
	// to 90 seconds for the TTL to expire. The indexer usually
	// catches up within a block or two; the next cache lookup for
	// this account will refetch and populate with the new data.
	clearProfileCache(account);
	return result;
}
