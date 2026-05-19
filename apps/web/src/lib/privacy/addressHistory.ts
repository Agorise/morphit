/* Part 122 cp26 — Client-side address-reuse history.
 *
 *  Tracks addresses the user has previously shared from THIS
 *  device through Morphit, so the address-share modal can warn
 *  on reuse.
 *
 *  Privacy posture: PURELY CLIENT-SIDE, localStorage only.  Never
 *  transmitted to any Morphit server.  Morphit's backend has no
 *  visibility into the user's address history; that would be a
 *  privacy regression (the moment Morphit tracks "user X uses
 *  address Y," our non-custodial story is compromised).
 *
 *  Limitations the operator/user should know about:
 *  - History is per-device + per-browser (localStorage scope).
 *    Same user on multiple devices won't see reuse across them.
 *  - Clearing localStorage / using a private window resets the
 *    history.  Acceptable; the alternative (server-side history)
 *    is worse.
 *  - Storage is unencrypted at rest within localStorage.  An
 *    attacker with filesystem access can read the user's address
 *    history.  This is the same trust model as the user's seed-
 *    phrase backup, password manager, etc.; we're not adding a
 *    new attack surface beyond what the browser already exposes.
 *
 *  Storage shape:
 *  ```json
 *  {
 *    "v": 1,
 *    "entries": [
 *      { "asset": "BTC", "address": "1A1z...", "sharedAt": "2026-05-17T20:00:00Z", "orderPermlink": "@alice/abc" }
 *    ]
 *  }
 *  ```
 *
 *  Bounded size: max 200 entries (rolling — oldest dropped when
 *  full).  At ~120 bytes per entry that's ~25KB, well within
 *  localStorage limits.  200 trades' worth of history is plenty
 *  for the warning to be useful without unbounded growth.
 */

const STORAGE_KEY = 'morphit.address-history.v1';
const MAX_ENTRIES = 200;

export interface AddressHistoryEntry {
	readonly asset: string; // uppercase ticker (BTC, BCH, LTC, etc.)
	readonly address: string;
	readonly sharedAt: string; // ISO timestamp
	readonly orderPermlink?: string;
}

interface AddressHistoryFile {
	readonly v: 1;
	readonly entries: readonly AddressHistoryEntry[];
}

/** Load the address-history file from localStorage.  Returns an
 *  empty history on any error (missing key, parse failure, schema
 *  mismatch) — never throws.  The address-history feature is
 *  best-effort; failure to load means "no history available" and
 *  the modal proceeds without the reuse warning, which is the
 *  correct fail-open posture for a UX nudge. */
export function loadAddressHistory(): readonly AddressHistoryEntry[] {
	if (typeof localStorage === 'undefined') {
		return [];
	}
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			(parsed as AddressHistoryFile).v !== 1 ||
			!Array.isArray((parsed as AddressHistoryFile).entries)
		) {
			return [];
		}
		// Filter to entries with valid shape — defends against
		// corrupted/older-version files mixed in.
		return (parsed as AddressHistoryFile).entries.filter(
			(e): e is AddressHistoryEntry =>
				typeof e === 'object' &&
				e !== null &&
				typeof (e as AddressHistoryEntry).asset === 'string' &&
				typeof (e as AddressHistoryEntry).address === 'string' &&
				typeof (e as AddressHistoryEntry).sharedAt === 'string'
		);
	} catch {
		return [];
	}
}

/** Record a new address-share event in the history.  Trims to
 *  MAX_ENTRIES (rolling — oldest first by insertion order, since
 *  we append).  Idempotent: re-recording the same (asset, address)
 *  pair updates `sharedAt` to the latest timestamp rather than
 *  creating a duplicate entry (so the reuse warning surfaces the
 *  most recent share). */
export function recordAddressShare(entry: AddressHistoryEntry): void {
	if (typeof localStorage === 'undefined') return;
	try {
		const current = [...loadAddressHistory()];
		// Dedupe: if (asset, address) already present, remove the
		// old entry — we'll re-add at the end with the new timestamp.
		const filtered = current.filter(
			(e) =>
				!(e.asset === entry.asset && e.address === entry.address)
		);
		filtered.push(entry);
		// Trim oldest entries when over cap (rolling buffer).
		const trimmed =
			filtered.length > MAX_ENTRIES
				? filtered.slice(filtered.length - MAX_ENTRIES)
				: filtered;
		const file: AddressHistoryFile = { v: 1, entries: trimmed };
		localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
	} catch {
		// localStorage may be full or unavailable (private mode in
		// some browsers).  Silent failure is correct: the feature is
		// best-effort and the share itself isn't blocked.
	}
}

/** Look up a prior share of the same (asset, address) pair.
 *  Returns the most-recent matching entry, or `null` if not in
 *  history.  Used by AddressShareModal to render the reuse-
 *  warning chip when the user pastes/types an address they've
 *  shared before. */
export function findPriorShare(
	asset: string,
	address: string
): AddressHistoryEntry | null {
	const all = loadAddressHistory();
	// Search from most-recent backward (entries are appended at
	// the end, so iterate in reverse for the latest match).
	// cp44-J-71 fix: explicit undefined guard.  At runtime
	// all[i] is always defined for i in [0, all.length); strict
	// mode requires the guard for the union type to be sound.
	for (let i = all.length - 1; i >= 0; i--) {
		const e = all[i];
		if (e !== undefined && e.asset === asset && e.address === address) return e;
	}
	return null;
}

/** Clear the entire address history.  Exposed for a "forget my
 *  history" button in settings (not yet wired), and for testing.
 *  No confirmation prompt; callers should add their own. */
export function clearAddressHistory(): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Same fail-silent rationale as recordAddressShare.
	}
}
