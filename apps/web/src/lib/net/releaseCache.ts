/**
 * The release check's outcome, remembered in this browser for 24 h.
 *
 * The release check (./releaseFetch.ts) is the one request a visitor's browser
 * makes to third parties: public Blurt nodes, which see the visitor's IP. Its
 * outcome — a verified release OR a failure — is kept in localStorage for 24
 * hours, so a browser contacts the nodes at most once a day, even when the
 * nodes are unreachable or the instance runs an older version than the one
 * announced.
 *
 * An outcome is reused only while it can still mean what it meant:
 *   - it is younger than 24 h (and not from the future: a clock set back);
 *   - it was recorded by the build THIS browser is running. After the site
 *     updates (a different running version) the chain is asked again at once,
 *     so the build-integrity check never compares a new build with an old
 *     answer;
 *   - a remembered release is still a valid, @morphit-signed release payload
 *     (re-validated: the stored copy is never trusted blindly), and a
 *     remembered failure is one of the known kinds.
 * A verified release OLDER than the running build is not the current release
 * (a node may serve an old genuine one while the other is down or agrees): it
 * is never remembered as the outcome. The newest release this browser has
 * verified is kept alongside (`newest`, past the 24 h) and stands in for it;
 * with none newer, the outcome is the failure 'older_release'. Either way it
 * is re-checked within the hour (RELEASE_UNCONFIRMED_TTL_MS), not a day.
 *
 * Only what fetchVerifiedRelease proved is ever stored. The key name changed
 * when the check started verifying signatures (v1 → v2): anything an older
 * build stored under the old name — which a single RPC node could have forged
 * — is deleted, never read.
 *
 * Pure (storage and clock injected). Storage errors (private mode) mean "no
 * cache", never a failure.
 */
import { validateReleasePayload, type ReleasePayloadV1 } from '@morphit/release-schema';
import { compareReleaseVersions } from './releaseVersion';

/** The signer account whose release ops are followed (re-exported by
 *  ./releaseFetch.ts, which owns the chain read). */
export const RELEASE_SIGNER_ACCOUNT = 'morphit';

export const RELEASE_CACHE_KEY = 'morphit.releaseCheck.v2';
/** Written by builds that did not verify the release signature. Deleted on
 *  sight. */
export const LEGACY_RELEASE_CACHE_KEYS: readonly string[] = ['morphit.releaseCheck.v1'];
export const RELEASE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an answer older than the running build is remembered. */
export const RELEASE_UNCONFIRMED_TTL_MS = 60 * 60 * 1000;
/** Prefix of the per-tab claims (`<prefix>.<id>`) that elect the one tab
 *  running the check, when the browser has no Web Locks ($net/onceAcrossTabs). */
export const RELEASE_CHECK_CLAIM_KEY = 'morphit.releaseCheck.v2.claim';

export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** The shape ./releaseFetch.ts returns (kept structural to avoid importing the
 *  chain client into this module). */
export interface CachedRelease {
	readonly payload: ReleasePayloadV1;
	readonly trxId: string;
	readonly blockNumber: number;
	readonly signedExpiration: string;
	readonly signer: string;
}

/** A remembered failure. Only the kind is kept — enough to show the same
 *  state again; the details (e.g. the keys a mismatching op was signed with)
 *  are not needed for that. */
export type CachedFailure =
	| { readonly kind: 'rpc_failed'; readonly cause: string }
	| { readonly kind: 'no_release' }
	| {
			readonly kind: 'pubkey_mismatch';
			readonly pinned: string;
			readonly chain_keys: readonly string[];
	  }
	| { readonly kind: 'invalid_payload'; readonly reason: string }
	/** The only verified release read is older than the running build, and
	 *  this browser has verified no newer one. */
	| { readonly kind: 'older_release'; readonly announced: string };

export type CachedOutcome =
	| { readonly ok: true; readonly value: CachedRelease }
	| { readonly ok: false; readonly error: CachedFailure };

function drop(storage: StorageLike, key: string): void {
	try {
		storage.removeItem(key);
	} catch {
		/* nothing to do */
	}
}

function validRelease(r: unknown): r is CachedRelease {
	if (r === null || typeof r !== 'object') return false;
	const c = r as Partial<CachedRelease>;
	return (
		c.signer === RELEASE_SIGNER_ACCOUNT &&
		typeof c.trxId === 'string' &&
		/^[0-9a-f]{40}$/.test(c.trxId) &&
		typeof c.blockNumber === 'number' &&
		Number.isSafeInteger(c.blockNumber) &&
		typeof c.signedExpiration === 'string' &&
		validateReleasePayload(c.payload).ok
	);
}

function validFailure(e: unknown): CachedFailure | null {
	if (e === null || typeof e !== 'object') return null;
	const k = (e as { kind?: unknown }).kind;
	if (k === 'no_release') return { kind: 'no_release' };
	if (k === 'rpc_failed') return { kind: 'rpc_failed', cause: 'remembered' };
	if (k === 'pubkey_mismatch') {
		const pinned = (e as { pinned?: unknown }).pinned;
		return {
			kind: 'pubkey_mismatch',
			pinned: typeof pinned === 'string' ? pinned : '',
			chain_keys: []
		};
	}
	if (k === 'invalid_payload') return { kind: 'invalid_payload', reason: 'remembered' };
	if (k === 'older_release') {
		const announced = (e as { announced?: unknown }).announced;
		return typeof announced === 'string' && announced.length <= 64
			? { kind: 'older_release', announced }
			: null;
	}
	return null;
}

interface StoredRecord {
	savedAt?: unknown;
	ttlMs?: unknown;
	running?: unknown;
	ok?: unknown;
	release?: unknown;
	error?: unknown;
	newest?: unknown;
}

function readRecord(storage: StorageLike): StoredRecord | null {
	let raw: string | null;
	try {
		raw = storage.getItem(RELEASE_CACHE_KEY);
	} catch {
		return null;
	}
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed !== null && typeof parsed === 'object' ? (parsed as StoredRecord) : null;
	} catch {
		return null;
	}
}

/** The newest release this browser has verified, whatever its age. */
export function readNewestVerified(storage: StorageLike): CachedRelease | null {
	const n = readRecord(storage)?.newest;
	return validRelease(n) ? n : null;
}

const newerRelease = (a: CachedRelease, b: CachedRelease): boolean =>
	(compareReleaseVersions(a.payload.version, b.payload.version) ||
		(a.signedExpiration > b.signedExpiration
			? 1
			: a.signedExpiration < b.signedExpiration
				? -1
				: 0)) > 0;

/** What to show and remember for a fresh answer — see the file header. */
export function decideReleaseOutcome(
	fetched: CachedOutcome,
	newest: CachedRelease | null,
	runningVersion: string
): { outcome: CachedOutcome; ttlMs: number; newest: CachedRelease | null } {
	if (!fetched.ok) return { outcome: fetched, ttlMs: RELEASE_CACHE_TTL_MS, newest };
	const r = fetched.value;
	if (compareReleaseVersions(r.payload.version, runningVersion) >= 0) {
		return {
			outcome: fetched,
			ttlMs: RELEASE_CACHE_TTL_MS,
			newest: newest !== null && newerRelease(newest, r) ? newest : r
		};
	}
	// Older than this build: not the current release.
	if (
		newest !== null &&
		compareReleaseVersions(newest.payload.version, runningVersion) >= 0 &&
		newerRelease(newest, r)
	) {
		return { outcome: { ok: true, value: newest }, ttlMs: RELEASE_UNCONFIRMED_TTL_MS, newest };
	}
	return {
		outcome: { ok: false, error: { kind: 'older_release', announced: r.payload.version } },
		ttlMs: RELEASE_UNCONFIRMED_TTL_MS,
		newest
	};
}

export function readCachedOutcome(
	storage: StorageLike,
	now: number,
	runningVersion: string
): CachedOutcome | null {
	for (const legacy of LEGACY_RELEASE_CACHE_KEYS) drop(storage, legacy);
	let raw: string | null;
	try {
		raw = storage.getItem(RELEASE_CACHE_KEY);
	} catch {
		return null;
	}
	if (raw === null) return null;
	const parsed = readRecord(storage);
	if (parsed === null) {
		drop(storage, RELEASE_CACHE_KEY);
		return null;
	}
	const savedAt = parsed.savedAt;
	const ttl =
		typeof parsed.ttlMs === 'number' &&
		Number.isFinite(parsed.ttlMs) &&
		parsed.ttlMs > 0 &&
		parsed.ttlMs <= RELEASE_CACHE_TTL_MS
			? parsed.ttlMs
			: RELEASE_CACHE_TTL_MS;
	let outcome: CachedOutcome | null = null;
	if (parsed.ok === true && validRelease(parsed.release)) {
		outcome = { ok: true, value: parsed.release };
	} else if (parsed.ok === false) {
		const f = validFailure(parsed.error);
		if (f !== null) outcome = { ok: false, error: f };
	}
	// Expired, or unusable: the outcome is gone; the newest verified release
	// (if any) stays for the next answer to be weighed against.
	const keepNewest = validRelease(parsed.newest);
	if (
		outcome === null ||
		typeof savedAt !== 'number' ||
		!Number.isFinite(savedAt) ||
		typeof parsed.running !== 'string'
	) {
		if (!keepNewest) drop(storage, RELEASE_CACHE_KEY);
		return null;
	}
	const age = now - savedAt;
	if (age < 0 || age >= ttl) {
		if (!keepNewest) drop(storage, RELEASE_CACHE_KEY);
		return null;
	}
	if (parsed.running !== runningVersion) return null;
	return outcome;
}

export function writeCachedOutcome(
	storage: StorageLike,
	now: number,
	runningVersion: string,
	outcome: CachedOutcome,
	opts: { readonly ttlMs?: number; readonly newest?: CachedRelease | null } = {}
): void {
	const base = {
		savedAt: now,
		...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
		running: runningVersion,
		...(opts.newest ? { newest: opts.newest } : {})
	};
	const record = outcome.ok
		? { ...base, ok: true, release: outcome.value }
		: { ...base, ok: false, error: outcome.error };
	try {
		storage.setItem(RELEASE_CACHE_KEY, JSON.stringify(record));
	} catch {
		/* private mode / quota: no cache */
	}
}

/** Forget the remembered outcome (a manual retry), keeping the newest
 *  verified release. */
export function forgetCachedOutcome(storage: StorageLike): void {
	const newest = readNewestVerified(storage);
	if (newest === null) {
		drop(storage, RELEASE_CACHE_KEY);
		return;
	}
	try {
		storage.setItem(RELEASE_CACHE_KEY, JSON.stringify({ newest }));
	} catch {
		/* nothing to do */
	}
}
