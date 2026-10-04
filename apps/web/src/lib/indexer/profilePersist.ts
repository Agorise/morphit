/**
 * Morphit — persistent (cross-reload) backing store for the profile cache.
 *
 * ─── Why this exists ──────────────────────────────────────────────────
 *
 * `profileCache.ts` is a fast in-MEMORY cache, but memory dies with the
 * page. Every hard reload, every fresh tab, every "open the app tomorrow"
 * starts cold — so the orderbook, chat, and feedback lists all wait on the
 * indexer's `/v1/profiles` round-trip again (up to several seconds on a
 * slow instance) and flash the loading skeleton
 * before a custom avatar / display name resolves.
 *
 * The requirement: once a custom avatar or display name has been loaded, it
 * should never again be shown as an identicon or @username first. The memory
 * cache alone can't deliver that across reloads;
 * this module persists resolved profiles to IndexedDB so the SECOND time a
 * device sees an account — including after a full reload — its avatar and
 * name render from disk in a few milliseconds, with no network wait and no
 * skeleton. `profileCache` reads this through before the network and writes
 * it through after a successful fetch (stale-while-revalidate).
 *
 * ─── Scope + privacy ──────────────────────────────────────────────────
 *
 * The profiles themselves are public, but WHICH accounts are in here is not:
 * it is the list of people this browser's user looked at or traded with. So
 * the store is ACCOUNT-tier:
 *   - every record is filed under the account signed in when it was written
 *     (`setProfilePersistScope`), so another account on the same device never
 *     reads the previous one's list;
 *   - with nobody signed in, nothing is read or written (a record left by an
 *     older build is deleted when its account comes up). A logged-out
 *     visitor's requests must not depend on what this browser saw before:
 *     disk hits change which accounts are asked for and when, and that
 *     links visits from different IPs (Tor circuits, VPN exits) — an
 *     operator could even plant accounts on a page to test for them;
 *   - an explicit Sign Out deletes every record (`idbClearProfiles`, from
 *     broadcastSignOut);
 *   - a record past its TTL is deleted when it is next read, not kept.
 * It stores other users' public profiles; never the local user's keys or
 * settings.
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
/** v2 files every record under the signed-in account; v1's unscoped store is
 *  dropped on upgrade. */
const DB_VERSION = 2;
const STORE = 'profiles';

/** The stored row: a PersistedProfile filed under the account it was written
 *  for. */
interface StoredProfile extends PersistedProfile {
	readonly scope: string;
}

const ANON_SCOPE = 'anon';
let scope = ANON_SCOPE;

/** File reads and writes under `account` (the signed-in Blurt account);
 *  with nobody signed in ('anon') the store is not used. */
export function setProfilePersistScope(account: string | null): void {
	scope = typeof account === 'string' && account.length > 0 ? `@${account}` : ANON_SCOPE;
}

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
				// v1 kept one unscoped list for every account on the device; it
				// is dropped, not migrated (it is only a cache).
				if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
				db.createObjectStore(STORE, { keyPath: ['scope', 'account'] });
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
 * Read persisted profiles for a set of accounts, in the current scope.
 * Returns a Map of only the accounts that were found and are younger than
 * `maxAgeMs` (a miss is simply absent); an older record is deleted. Never
 * throws; returns an empty Map if persistence is unavailable or the read
 * fails.
 */
export async function idbGetProfiles(
	accounts: readonly string[],
	maxAgeMs: number = Number.POSITIVE_INFINITY
): Promise<Map<string, PersistedProfile>> {
	const out = new Map<string, PersistedProfile>();
	if (accounts.length === 0) return out;
	const db = await openDb();
	if (!db) return out;
	if (scope === ANON_SCOPE) {
		// Logged out: never served from disk; drop what an older build filed.
		try {
			const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
			for (const account of accounts) store.delete([ANON_SCOPE, account]);
		} catch {
			/* best-effort */
		}
		return out;
	}
	const now = Date.now();
	try {
		const tx = db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		await Promise.all(
			accounts.map(async (account) => {
				const rec = await reqToPromise<StoredProfile | undefined>(
					store.get([scope, account]) as IDBRequest<StoredProfile | undefined>,
					undefined
				);
				if (
					rec &&
					typeof rec === 'object' &&
					rec.account === account &&
					rec.profile &&
					typeof rec.fetchedAt === 'number'
				) {
					const age = now - rec.fetchedAt;
					if (age >= 0 && age < maxAgeMs) {
						out.set(account, { account, profile: rec.profile, fetchedAt: rec.fetchedAt });
					} else {
						try {
							store.delete([scope, account]);
						} catch {
							/* best-effort eviction */
						}
					}
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
 * break rendering. Callers pass ONLY positive profiles. Nothing is written
 * while nobody is signed in.
 */
export async function idbPutProfiles(records: readonly PersistedProfile[]): Promise<void> {
	if (records.length === 0 || scope === ANON_SCOPE) return;
	const db = await openDb();
	if (!db) return;
	try {
		const tx = db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		for (const rec of records) {
			if (rec.account && rec.profile) {
				try {
					const row: StoredProfile = {
						scope,
						account: rec.account,
						profile: rec.profile,
						fetchedAt: rec.fetchedAt
					};
					store.put(row);
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
		tx.objectStore(STORE).delete([scope, account]);
		await new Promise<void>((resolve) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		});
	} catch {
		/* no-op */
	}
}

/**
 * Delete every persisted profile, in every scope. Called on an explicit Sign
 * Out: the list of accounts this browser looked at belongs to the person
 * leaving. Best-effort; never rejects.
 */
export async function idbClearProfiles(): Promise<void> {
	const db = await openDb();
	if (!db) return;
	try {
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).clear();
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
	scope = ANON_SCOPE;
}
