/**
 * v1.20.3 — the release check's answer, remembered in this browser for 24 h.
 *
 * The release check (./releaseFetch.ts) is the ONE request a visitor's browser
 * makes to a third party: a public Blurt node, which sees the visitor's IP. It
 * used to run once per browser session — in practice on every visit. A
 * successful answer is now kept in localStorage and reused for 24 hours, so a
 * returning visitor contacts a node at most once a day.
 *
 * The answer is reused only while it can still mean what it meant:
 *   - it is younger than 24 h (and not from the future: a clock set back);
 *   - it announced the version THIS browser is running. After the site updates
 *     (a different running version) the chain is asked again at once, so the
 *     build-integrity check never compares a new build with an old announcement;
 *   - it is still a valid, @morphit-signed release payload (re-validated: the
 *     stored copy is never trusted blindly).
 * What it gives up: a release broadcast while an instance stays on the old
 * version is seen up to 24 h later by a returning visitor ("a newer version
 * exists"); the update prompt and the integrity check are unaffected.
 *
 * Pure (storage and clock injected). Storage errors (private mode) mean "no
 * cache", never a failure.
 */
import { validateReleasePayload, type ReleasePayloadV1 } from '@morphit/release-schema';

/** The signer account whose release ops are followed (re-exported by
 *  ./releaseFetch.ts, which owns the chain read). */
export const RELEASE_SIGNER_ACCOUNT = 'morphit';

export const RELEASE_CACHE_KEY = 'morphit.releaseCheck.v1';
export const RELEASE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
	readonly timestamp: string;
	readonly signer: string;
}

function drop(storage: StorageLike): void {
	try {
		storage.removeItem(RELEASE_CACHE_KEY);
	} catch {
		/* nothing to do */
	}
}

export function readCachedRelease(
	storage: StorageLike,
	now: number,
	runningVersion: string
): CachedRelease | null {
	let raw: string | null;
	try {
		raw = storage.getItem(RELEASE_CACHE_KEY);
	} catch {
		return null;
	}
	if (raw === null) return null;
	let parsed: { savedAt?: unknown; release?: Partial<CachedRelease> };
	try {
		parsed = JSON.parse(raw) as typeof parsed;
	} catch {
		drop(storage);
		return null;
	}
	const r = parsed?.release;
	const savedAt = parsed?.savedAt;
	const valid =
		typeof savedAt === 'number' &&
		Number.isFinite(savedAt) &&
		r !== undefined &&
		r !== null &&
		r.signer === RELEASE_SIGNER_ACCOUNT &&
		typeof r.trxId === 'string' &&
		typeof r.blockNumber === 'number' &&
		typeof r.timestamp === 'string' &&
		validateReleasePayload(r.payload).ok;
	if (!valid) {
		drop(storage);
		return null;
	}
	const age = now - (savedAt as number);
	if (age < 0 || age >= RELEASE_CACHE_TTL_MS) {
		drop(storage);
		return null;
	}
	const release = r as CachedRelease;
	if (release.payload.version !== runningVersion) return null;
	return release;
}

export function writeCachedRelease(
	storage: StorageLike,
	now: number,
	release: CachedRelease
): void {
	try {
		storage.setItem(RELEASE_CACHE_KEY, JSON.stringify({ savedAt: now, release }));
	} catch {
		/* private mode / quota: no cache */
	}
}
