/**
 * Morphit — profile op broadcaster.
 *
 * Builds a `morphit_profile_v1` custom_json payload, signs it with the
 * user's posting key (from the LiveIdentity store), and broadcasts via
 * the endpoint rotator. Indexers read the latest op from the signing
 * account and treat it as canonical.
 *
 * The broadcast path requires the user to have a Blurt account on-chain
 * — Phase 2a has no registration flow yet, so this function throws a
 * clear error if no account name is on file. Settings catches and shows
 * the message; the display name is already saved locally.
 *
 * Security note: every free-text field (display_name, nostr_url,
 * blurt_media_url) is run through redactPrivateKeys() before broadcast.
 * Same defense-in-depth pattern as buildOrderPayload — no order op or
 * profile op can leak a private key to chain, regardless of what the
 * UI layer did. URL fields are already URL-validated at form time, so
 * reaching this path with a key embedded would itself be a bug; the
 * redaction is a safety backstop for that bug.
 */

import { browser } from '$app/environment';
import { writable } from 'svelte/store';
// cp165 byte-budget: `broadcastCustomJson` is dynamically imported
// inside `broadcastProfile` (which is only called on user action).
// A static import of '../sign' here transitively pulled dblurt into
// the eager-load graph of any route that imports profile.ts for the
// read-only helper `getUserBlurtAccount` (used by /my/orders,
// /chat/*, /settings, etc.).  Switching to dynamic import keeps the
// 2 MB dblurt chunk out of those routes' first paint — the chunk
// loads only when the user actually triggers a profile broadcast.
import { OP_IDS } from '$net/config';
import type { LiveIdentity } from '$crypto/keygen';
import { redactPrivateKeys } from '$lib/security/privateKeyDetector';
import { clearProfileCache } from '$lib/indexer/profileCache';

const ACCOUNT_STORAGE_KEY = 'morphit.blurtAccount';

function readAccountFromStorage(): string | null {
	if (!browser) return null;
	try {
		return window.localStorage.getItem(ACCOUNT_STORAGE_KEY);
	} catch {
		return null;
	}
}

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

if (browser) {
	// Cross-tab: a `storage` event fires in every OTHER tab when this
	// key changes, so registering / signing out in one tab keeps the
	// avatar correct everywhere without a reload.
	window.addEventListener('storage', (e) => {
		if (e.key === ACCOUNT_STORAGE_KEY) blurtAccountName.set(e.newValue);
		// A full localStorage.clear() reports key === null.
		else if (e.key === null) blurtAccountName.set(readAccountFromStorage());
	});
}

/** Return the Blurt account name the user registered, or null. */
export function getUserBlurtAccount(): string | null {
	return readAccountFromStorage();
}

/** Record the Blurt account name after registration. */
export function setUserBlurtAccount(name: string): void {
	if (!browser) return;
	try {
		window.localStorage.setItem(ACCOUNT_STORAGE_KEY, name);
	} catch {
		// Privacy Mode; the account name will need to be re-entered next
		// session. A real solution is Phase 3 — indexer lookup by pubkey.
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
 *  Why this exists (cp312): the login page gates its "sign you out of
 *  @NNN first" modal on `getUserBlurtAccount()`, which reads this
 *  persistent key.  `reset()` clears the in-memory keystore but leaves
 *  this name, so after confirming the switch the gate still saw an
 *  account and the modal re-fired on the next attempt — looking like
 *  the sign-out hadn't happened.  Clearing the name here closes that. */
export function clearUserBlurtAccount(): void {
	if (!browser) return;
	try {
		window.localStorage.removeItem(ACCOUNT_STORAGE_KEY);
	} catch {
		// Privacy Mode / storage unavailable — nothing persisted to clear.
	}
	blurtAccountName.set(null);
}

export interface ProfilePayload {
	/** Human-readable display name, already validated by caller. */
	display_name: string;
	/** Optional Nostr profile URL (nostr:npub1... or https://...).
	 *  Stored in json_metadata.nostr_url on-chain; surfaces as a
	 *  link icon next to every rendered username when populated.
	 *  Validated client-side at render time — see IdentityLabel's
	 *  validateNostrUrl helper. */
	nostr_url?: string;
	/** Optional Blurt.media profile URL (https://blurt.media/@…).
	 *  Stored in json_metadata.blurt_media_url on-chain; surfaces
	 *  alongside the Nostr link when populated. Validated client-
	 *  side via validateBlurtMediaUrl — host must be exactly
	 *  blurt.media, HTTPS only. */
	blurt_media_url?: string;
	/** Optional short bio / tagline (≤128 codepoints, validated by
	 *  caller via validateShortBio). Stored in json_metadata.short_bio
	 *  on-chain; surfaces on the account profile page. Free text. */
	short_bio?: string;
	/** Optional sanitized SVG text for a custom avatar. Stored in
	 *  json_metadata.avatar_svg on-chain. MUST have been produced
	 *  by `sanitizeSvg` in $lib/avatar — the broadcast path does
	 *  NOT re-sanitize (that would be duplicated work). Rendered
	 *  by IdentityLabel via {@html} so it MUST be safe at the
	 *  point of broadcast.
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
/**
 * Thrown when a broadcast can't proceed because of a structural issue
 * (not a transport failure). UI code catches this and maps `code` to a
 * localized message.
 */
export class BroadcastError extends Error {
	constructor(
		public readonly code: 'no_account' | 'locked' | 'missing_external_tx_id',
		message: string
	) {
		super(message);
		this.name = 'BroadcastError';
	}
}

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
	if (payload.nostr_url && payload.nostr_url.trim().length > 0) {
		jsonMetadata.nostr_url = redactPrivateKeys(payload.nostr_url.trim());
	}
	if (payload.blurt_media_url && payload.blurt_media_url.trim().length > 0) {
		jsonMetadata.blurt_media_url = redactPrivateKeys(payload.blurt_media_url.trim());
	}
	if (payload.short_bio && payload.short_bio.trim().length > 0) {
		jsonMetadata.short_bio = redactPrivateKeys(payload.short_bio.trim());
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

	const body: ProfilePayload & { json_metadata?: Record<string, unknown> } = {
		v: 1,
		display_name: redactPrivateKeys(payload.display_name),
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
	const body = buildProfileBody(payload, Math.floor(Date.now() / 1000));
	// cp165: dynamic import of '../sign' keeps dblurt out of the
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
