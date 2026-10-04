/**
 * The release check's outcome — a verified release or a failure — is
 * remembered in the browser for 24 h, so a browser contacts the Blurt nodes
 * (the one browser→third-party request Morphit makes) at most once a day.
 */
import { describe, expect, it } from 'vitest';
import { RUNNING_VERSION, olderThan } from './releaseTestVersions';

import {
	RELEASE_CACHE_KEY,
	RELEASE_CACHE_TTL_MS,
	RELEASE_UNCONFIRMED_TTL_MS,
	readCachedOutcome,
	writeCachedOutcome,
	readNewestVerified,
	decideReleaseOutcome,
	forgetCachedOutcome,
	type StorageLike
} from './releaseCache';

const HOUR = 3_600_000;
const OLDER = olderThan();
const release = (version = RUNNING_VERSION) => ({
	payload: {
		version,
		hash_manifest: { '/index.html': 'sha256-9DrhlgWls108pHfeGxpf2wVhQSeHIJ3PnJ0ThHwkfOs=' }
	},
	trxId: 'ab'.repeat(20),
	blockNumber: 64_200_000,
	signedExpiration: '2026-10-02T01:00:00',
	signer: 'morphit'
});
const ok = (version = RUNNING_VERSION) => ({ ok: true as const, value: release(version) as never });
const mem = (): StorageLike & { data: Map<string, string> } => {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k)
	};
};

describe('the remembered release check', () => {
	it('a fresh answer recorded by this build is reused (no node contacted)', () => {
		const s = mem();
		writeCachedOutcome(s, 1_000, RUNNING_VERSION, ok());
		expect(readCachedOutcome(s, 1_000 + 23 * HOUR, RUNNING_VERSION)).toEqual({
			ok: true,
			value: release()
		});
	});
	it('reused even when the chain announces another version than this build runs', () => {
		const s = mem();
		writeCachedOutcome(s, 1_000, OLDER, ok(RUNNING_VERSION));
		expect(readCachedOutcome(s, 2_000, OLDER)?.ok).toBe(true);
	});
	it('a failure is remembered for the same 24 h', () => {
		const s = mem();
		writeCachedOutcome(s, 1_000, RUNNING_VERSION, {
			ok: false,
			error: { kind: 'rpc_failed', cause: 'x' }
		});
		expect(readCachedOutcome(s, 1_000 + 23 * HOUR, RUNNING_VERSION)).toEqual({
			ok: false,
			error: { kind: 'rpc_failed', cause: 'remembered' }
		});
	});
	it('after 24 hours it is asked again', () => {
		const s = mem();
		writeCachedOutcome(s, 1_000, RUNNING_VERSION, ok());
		expect(RELEASE_CACHE_TTL_MS).toBe(24 * HOUR);
		expect(readCachedOutcome(s, 1_000 + 24 * HOUR, RUNNING_VERSION)).toBeNull();
		expect(s.data.has(RELEASE_CACHE_KEY)).toBe(false);
	});
	it('a site update in the meantime (another running build) asks again at once', () => {
		const s = mem();
		writeCachedOutcome(s, 1_000, OLDER, ok(OLDER));
		expect(readCachedOutcome(s, 2_000, RUNNING_VERSION)).toBeNull();
	});
	it('a clock set back, garbage, a foreign signer or an invalid payload is never trusted', () => {
		const s = mem();
		writeCachedOutcome(s, 10 * HOUR, RUNNING_VERSION, ok());
		expect(readCachedOutcome(s, 9 * HOUR, RUNNING_VERSION)).toBeNull();
		const rec = (r: unknown) =>
			JSON.stringify({ savedAt: 1, running: RUNNING_VERSION, ok: true, release: r });
		for (const bad of [
			'not json',
			rec({ ...release(), signer: 'mallory' }),
			rec({ ...release(), payload: { version: RUNNING_VERSION } }),
			rec({ ...release(), blockNumber: 'x' }),
			rec({ ...release(), trxId: 'zz' }),
			JSON.stringify({ savedAt: 'x', running: RUNNING_VERSION, ok: true, release: release() }),
			JSON.stringify({
				savedAt: 1,
				running: RUNNING_VERSION,
				ok: false,
				error: { kind: 'made_up' }
			})
		]) {
			const t = mem();
			t.setItem(RELEASE_CACHE_KEY, bad);
			expect(readCachedOutcome(t, 2, RUNNING_VERSION)).toBeNull();
			expect(t.data.has(RELEASE_CACHE_KEY)).toBe(false);
		}
	});
	it('storage that throws (private mode) just means no cache', () => {
		const broken: StorageLike = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			},
			removeItem: () => {
				throw new Error('denied');
			}
		};
		expect(() => writeCachedOutcome(broken, 1, RUNNING_VERSION, ok())).not.toThrow();
		expect(readCachedOutcome(broken, 1, RUNNING_VERSION)).toBeNull();
	});
});

describe('an answer older than this build', () => {
	const older = { ok: true as const, value: release(OLDER) as never };
	it('with no newer release verified here: "older_release", kept for an hour only', () => {
		const s = mem();
		const d = decideReleaseOutcome(older, readNewestVerified(s), RUNNING_VERSION);
		expect(d.outcome).toEqual({ ok: false, error: { kind: 'older_release', announced: OLDER } });
		writeCachedOutcome(s, 1_000, RUNNING_VERSION, d.outcome, { ttlMs: d.ttlMs, newest: d.newest });
		expect(d.ttlMs).toBe(RELEASE_UNCONFIRMED_TTL_MS);
		expect(readCachedOutcome(s, 1_000 + HOUR - 1, RUNNING_VERSION)?.ok).toBe(false);
		expect(readCachedOutcome(s, 1_000 + HOUR, RUNNING_VERSION)).toBeNull();
	});
	it('the newest release verified here outlives the day and stands in for it', () => {
		const s = mem();
		const first = decideReleaseOutcome(ok(RUNNING_VERSION), null, RUNNING_VERSION);
		writeCachedOutcome(s, 1_000, RUNNING_VERSION, first.outcome, { newest: first.newest });
		expect(readCachedOutcome(s, 1_000 + 25 * HOUR, RUNNING_VERSION)).toBeNull(); // the day is over
		const d = decideReleaseOutcome(older, readNewestVerified(s), RUNNING_VERSION);
		expect(d.outcome).toEqual({ ok: true, value: release(RUNNING_VERSION) });
		expect(d.ttlMs).toBe(RELEASE_UNCONFIRMED_TTL_MS);
	});
	it('a manual retry forgets the outcome, never the newest verified release', () => {
		const s = mem();
		writeCachedOutcome(
			s,
			1_000,
			RUNNING_VERSION,
			{ ok: false, error: { kind: 'rpc_failed', cause: 'x' } },
			{
				newest: release(RUNNING_VERSION) as never
			}
		);
		forgetCachedOutcome(s);
		expect(readCachedOutcome(s, 2_000, RUNNING_VERSION)).toBeNull();
		expect(readNewestVerified(s)?.payload.version).toBe(RUNNING_VERSION);
	});
});
