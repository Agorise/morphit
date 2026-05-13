/**
 * Morphit — draft persistence helper.
 *
 * Lets forms save the user's in-progress state so a crash, offline
 * event, or reboot doesn't throw away their work. The user can
 * pick up right where they left off.
 *
 * ─── Design invariants ──────────────────────────────────────────
 *
 * **Storage medium.** safeLocal (localStorage wrapped to survive
 * Private Mode, Tor high-security, quota-exceeded, and storage
 * disabled). If safeLocal is unavailable, every draft call silently
 * no-ops — the feature degrades to nothing rather than crashing
 * the form.
 *
 * **Private-key redaction.** Every string field — top-level or
 * nested inside a persisted object — is passed through
 * redactPrivateKeys before write. Same defense-in-depth rule as
 * the op-builder chokepoints: if the user pastes a key and crashes
 * before clearing it, the key must not end up readable on disk.
 *
 * **TTL.** Drafts carry an expires_at timestamp. Reads past the
 * expiry return null and clear the slot. Default 14 days (matches
 * the default order expiration window — if you're not going to
 * send the order for two weeks, the draft isn't useful anymore).
 *
 * **Schema + version.** Drafts are JSON envelopes:
 *   { v: 1, exp: <ms-epoch>, value: T }
 * `v` lets us evolve the shape. Unknown version → treat as
 * corrupt and discard, so an old draft from a pre-upgrade version
 * of the app never attempts to hydrate the new UI and break it.
 *
 * **Key discipline.** Caller passes a fully-qualified key like
 * 'post.compose' or `post.edit.${permlink}`. We prefix with
 * 'morphit.draft.' so draft keys don't collide with other
 * localStorage entries (keystore, account name, endpoints, i18n).
 *
 * ─── What this is NOT ───────────────────────────────────────────
 *
 * Not a general-purpose key-value store. Callers use it for
 * "save the form while the user composes; throw it away when the
 * broadcast succeeds." It's not a place to stash long-lived
 * settings.
 *
 * Not signed or encrypted at rest. Anyone with physical access
 * to the device can read draft JSON from browser storage. For a
 * user who wants no persistence at all, a settings toggle will
 * be added in a follow-up and will set every new draft to
 * expire immediately (or, equivalently, skip writes).
 */

import { safeLocal } from '$utils/safeStorage';
import { redactPrivateKeys } from '$lib/security/privateKeyDetector';

const KEY_PREFIX = 'morphit.draft.';
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const CURRENT_VERSION = 1;

interface DraftEnvelope<T> {
	readonly v: number;
	/** ms since epoch when this draft was written. Used by the
	 *  caller UI to show "saved Xm ago" in a restore banner. */
	readonly savedAt: number;
	readonly exp: number; // ms since epoch
	readonly value: T;
}

/** Metadata returned alongside a loaded draft. Lets the caller
 *  render "restored from X ago" without having to parse envelopes
 *  themselves. */
export interface DraftMeta {
	readonly savedAt: number; // ms since epoch
}

/**
 * Recursively walk a JSON-serializable value and run
 * redactPrivateKeys on every string leaf. Objects and arrays are
 * traversed; primitives other than strings pass through unchanged.
 *
 * Exported for tests; most callers use saveDraft which calls
 * this internally.
 */
export function redactValue<T>(value: T): T {
	if (typeof value === 'string') {
		return redactPrivateKeys(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((v) => redactValue(v)) as unknown as T;
	}
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = redactValue(v);
		}
		return out as T;
	}
	return value;
}

/** Full storage key for a draft, with the 'morphit.draft.' prefix. */
function storageKey(key: string): string {
	return KEY_PREFIX + key;
}

/**
 * Save a draft. Returns true on successful write, false if storage
 * is unavailable or write failed. Callers should NOT treat false
 * as an error condition — the feature is best-effort and most
 * users never hit a storage failure.
 *
 * Every string in `value` (top-level or nested) is redacted for
 * private-key material before write.
 */
export function saveDraft<T>(key: string, value: T, ttlMs: number = DEFAULT_TTL_MS): boolean {
	const now = Date.now();
	const envelope: DraftEnvelope<T> = {
		v: CURRENT_VERSION,
		savedAt: now,
		exp: now + ttlMs,
		value: redactValue(value)
	};
	try {
		return safeLocal.set(storageKey(key), JSON.stringify(envelope));
	} catch {
		// JSON.stringify can throw on circular references. Unlikely
		// in a form state, but if it happens, fail gracefully —
		// the form continues to work, just without persistence.
		return false;
	}
}

/** Internal: parse + validate a stored envelope, returning the
 *  full envelope if usable, or null (with side-effect slot-clear)
 *  if expired/corrupt/wrong-version. */
function parseAndValidate<T>(storageKeyFull: string): DraftEnvelope<T> | null {
	const raw = safeLocal.get(storageKeyFull);
	if (raw === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		safeLocal.remove(storageKeyFull);
		return null;
	}

	if (
		!parsed ||
		typeof parsed !== 'object' ||
		!('v' in parsed) ||
		!('exp' in parsed) ||
		!('value' in parsed)
	) {
		safeLocal.remove(storageKeyFull);
		return null;
	}

	const env = parsed as DraftEnvelope<T>;
	if (env.v !== CURRENT_VERSION) {
		safeLocal.remove(storageKeyFull);
		return null;
	}
	if (typeof env.exp !== 'number' || env.exp < Date.now()) {
		safeLocal.remove(storageKeyFull);
		return null;
	}

	return env;
}

/**
 * Load a draft. Returns null if:
 *   - no draft for this key
 *   - draft has expired (slot is cleared as a side effect)
 *   - draft JSON is corrupt or wrong version (slot is cleared)
 *   - storage is unavailable
 *
 * Callers treat null as "no draft — start fresh."
 */
export function loadDraft<T>(key: string): T | null {
	const env = parseAndValidate<T>(storageKey(key));
	return env ? env.value : null;
}

/**
 * Load a draft together with its metadata (savedAt timestamp).
 * Useful for callers that want to render "restored from X ago"
 * in a banner. Same null-semantics as loadDraft.
 *
 * If the stored envelope predates the savedAt field (older than
 * this code), savedAt defaults to now — the banner will show
 * "<1m" which is a graceful fallback.
 */
export function loadDraftWithMeta<T>(key: string): { value: T; meta: DraftMeta } | null {
	const env = parseAndValidate<T>(storageKey(key));
	if (!env) return null;
	const savedAt = typeof env.savedAt === 'number' && env.savedAt > 0 ? env.savedAt : Date.now();
	return { value: env.value, meta: { savedAt } };
}

/**
 * Discard a draft, typically after a successful broadcast. Also
 * safe to call when no draft exists — silently no-ops.
 */
export function clearDraft(key: string): boolean {
	return safeLocal.remove(storageKey(key));
}

/**
 * Clear every draft whose key starts with the given sub-prefix.
 * Used by the explicit-lock cleanup flow to wipe a whole category
 * of drafts (e.g. all `feedback.<permlink>` drafts, all
 * `feedback_response.<trxId>` drafts) without the caller needing
 * to enumerate which keys actually exist.
 *
 * Sub-prefix is matched literally against the caller-facing key
 * space (without the internal `morphit.draft.` storage prefix).
 * So `clearDraftsMatching('feedback')` removes
 * `feedback.orderA`, `feedback.orderB`, but NOT
 * `feedback_response.*` (no cross-category leakage). A trailing
 * dot is appended automatically so `feedback` matches only the
 * `feedback.` namespace, not e.g. `feedback_response`.
 *
 * Returns the number of draft slots removed. Silently no-ops to
 * zero if storage is unavailable, matching the rest of this
 * module's contract.
 */
export function clearDraftsMatching(subPrefix: string): number {
	if (!safeLocal.available()) return 0;
	// Reach through to the underlying storage to enumerate keys.
	// This is the one place in the drafts module that needs the
	// raw iterator; everywhere else uses the safeLocal
	// get/set/remove API.
	if (typeof window === 'undefined') return 0;
	let storage: Storage;
	try {
		storage = window.localStorage;
	} catch {
		return 0;
	}
	const fullPrefix = `${KEY_PREFIX}${subPrefix}.`;
	// Collect matching keys first, then remove — iterating while
	// mutating is fragile across browsers.
	const toRemove: string[] = [];
	for (let i = 0; i < storage.length; i += 1) {
		const key = storage.key(i);
		if (key !== null && key.startsWith(fullPrefix)) {
			toRemove.push(key);
		}
	}
	let removed = 0;
	for (const key of toRemove) {
		try {
			storage.removeItem(key);
			removed += 1;
		} catch {
			// Ignore per-key remove failures; keep going.
		}
	}
	return removed;
}

/**
 * Check whether drafts are usable at all. Returns false if the
 * underlying storage layer is broken (Private Mode, quota, etc).
 * Forms can use this to decide whether to show a "Draft saved"
 * indicator in the UI.
 */
export function draftsAvailable(): boolean {
	return safeLocal.available();
}
