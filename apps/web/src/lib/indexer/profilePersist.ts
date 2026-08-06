/**
 * Morphit — persistent (cross-reload) backing store for the profile cache.
 *
 * ─── Why this exists ──────────────────────────────────────────────────
 *
 * `profileCache.ts` is a fast in-MEMORY cache, but memory dies with the
 * page. Every hard reload, every fresh tab, every "open the app tomorrow"
 * starts cold — so the orderbook, chat, and feedback lists all wait on the
 * indexer's `/v1/profiles` round-trip again (Ken: "STILL taking up to 7
 * seconds to appear for some accounts") and flash the loading skeleton
 * before a custom avatar / display name resolves.
 *
 * Ken: "cache all avatars and display names the moment they need to be
 * loaded for the first time … for users that have a custom avatar and/or
 * display name set, i do not EVER want to see their identicon and/or
 * @username." The memory cache alone can't deliver that across reloads;
 * this module persists resolved profiles to IndexedDB so the SECOND time a
 * device sees an account — including after a full reload — its avatar and
 * name render from disk in a few milliseconds, with no network wait and no
 * skeleton. `profileCache` reads this through before the network and writes
 * it through after a successful fetch (stale-while-revalidate).
 *
 * ─── Scope + privacy ──────────────────────────────────────────────────
 *
 * Profiles are PUBLIC on-chain data (display name + avatar, already
 * rendered to anyone). This store is therefore DEVICE-tier, not
 * account-tier: it is a property of the browser, shared safely across every
 * account on the device, and is NOT swept on sign-out (see
 * storageKeyRegistry.ts's tiers). Keeping it across an account switch leaks
 * nothing — it only saves the next account from re-fetching the same public
 * avatars. It stores OTHER users' public profiles; it never stores the
 * local user's keys or settings.
 *
 * Not localStorage: avatars are inline data URIs / SVG up to ~8 KB each
 * (MAX_JSONB_BYTES_PROFILE), so a busy device touching hundreds of accounts
 * would blow localStorage's ~5 MB string budget. IndexedDB stores the
 * structured value directly with a far larger quota.
 *
 * ─── Graceful degradation ─────────────────────────────────────────────
 *
 * Every export is best-effort and NEVER throws or rejects: on SSR (no
 * `indexedDB`), in private-mode browsers that block it, on quota errors, or
 * on a corrupt/blocked open, the operation resolves to an empty result or a
 * silent no-op. The caller then behaves exactly as it did before this
 * module existed — memory-cache + network — so persistence can only ever
 * make things faster, never break them.
 */

import type { ProfileResponse } from '@morphit/indexer-client';

/** One persisted profile record. Only POSITIVE profiles (a real row that
 *  exists) are ever written — a "no profile / not indexed yet" negative is
 *  deliberately never persisted, so a just-created profile can't be pinned to
 *  its absence across reloads (the same reasoning as the endpoint's `no-store`
 *  on partial batches and the client soft-null policy). */
export interface PersistedProfile {
	readonly account: string;
	readonly profile: ProfileResponse;
	/** `Date.now()` when this was fetched, for the caller's TTL / revalidation
	 *  decisions. Stored, not derived, so age survives the reload. */
	readonly fetchedAt: number;
}

const DB_NAME = 'morphit-profiles';
const DB_VERSION = 1;
const STORE = 'profiles';

/** Open (and, first time, create) the object store. Resolves to null on any
 *  failure or when IndexedDB is unavailable — callers treat null as "no
 *  persistence layer" and fall back to memory + network. A single shared
 *  open promise is memoised so N concurrent batch calls don't each open the
 *  DB. */
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise<IDBDatabase | null>((resolve) => {
		try {
			if (typeof indexedDB === 'undefined') {
				resolve(null);
				return;
			}
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(STORE)) {
					// keyPath 'account' — the record carries its own key.
					db.createObjectStore(STORE, { keyPath: 'account' });
				}
			};
			req.onsuccess = () => {
				const db = req.result;
				// If a later tab bumps DB_VERSION, this connection would block the
				// upgrade; close it so the upgrade can proceed rather than hang.
				db.onversionchange = () => {
					try {
						db.close();
					} catch {
						/* already closing */
					}
					// Force the next call to reopen at the new version.
					dbPromise = null;
				};
				resolve(db);
			};
			req.onerror = () => resolve(null);
			req.onblocked = () => resolve(null);
		} catch {
			// Some privacy modes throw synchronously from indexedDB.open.
			resolve(null);
		}
	});
	return dbPromise;
}

/** Promisify a single IDBRequest, resolving to a fallback on error instead of
 *  rejecting — keeps the "never throws" contract. */
function reqToPromise<T>(req: IDBRequest<T>, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => resolve(fallback);
	});
}

/**
 * Read persisted profiles for a set of accounts. Returns a Map of only the
 * accounts that were found (a miss is simply absent). Never throws; returns
 * an empty Map if persistence is unavailable or the read fails.
 */
export async function idbGetProfiles(
	accounts: readonly string[]
): Promise<Map<string, PersistedProfile>> {
	const out = new Map<string, PersistedProfile>();
	if (accounts.length === 0) return out;
	const db = await openDb();
	if (!db) return out;
	try {
		const tx = db.transaction(STORE, 'readonly');
		const store = tx.objectStore(STORE);
		await Promise.all(
			accounts.map(async (account) => {
				const rec = await reqToPromise<PersistedProfile | undefined>(
					store.get(account) as IDBRequest<PersistedProfile | undefined>,
					undefined
				);
				if (
					rec &&
					typeof rec === 'object' &&
					rec.account === account &&
					rec.profile &&
					typeof rec.fetchedAt === 'number'
				) {
					out.set(account, rec);
				}
			})
		);
	} catch {
		/* transaction failed mid-flight — return whatever we gathered */
	}
	return out;
}

/**
 * Write (upsert) resolved profiles. Best-effort: resolves when the write
 * transaction completes, or immediately if persistence is unavailable, and
 * never rejects — a quota or write error is swallowed so a full disk can't
 * break rendering. Callers pass ONLY positive profiles.
 */
export async function idbPutProfiles(records: readonly PersistedProfile[]): Promise<void> {
	if (records.length === 0) return;
	const db = await openDb();
	if (!db) return;
	try {
		const tx = db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		for (const rec of records) {
			if (rec.account && rec.profile) {
				try {
					store.put(rec);
				} catch {
					/* one bad record shouldn't abort the rest */
				}
			}
		}
		await new Promise<void>((resolve) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		});
	} catch {
		/* opening the transaction failed — no-op */
	}
}

/**
 * Delete a single account's persisted profile — used when the LOCAL user
 * updates their own profile, so the next viewer-side read doesn't serve the
 * pre-edit avatar from disk before revalidation completes. Best-effort.
 */
export async function idbDeleteProfile(account: string): Promise<void> {
	if (typeof account !== 'string' || account.length === 0) return;
	const db = await openDb();
	if (!db) return;
	try {
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).delete(account);
		await new Promise<void>((resolve) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		});
	} catch {
		/* no-op */
	}
}

/** Test-only reset of the memoised open promise so a fake-IndexedDB harness
 *  can swap implementations between cases. @internal */
export function _resetProfilePersistForTests(): void {
	dbPromise = null;
}
