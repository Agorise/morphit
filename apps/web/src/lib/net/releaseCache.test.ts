/**
 * v1.20.3 — the release check's answer is remembered in the browser for 24 h,
 * so a returning visitor contacts a Blurt node at most once a day instead of
 * once per visit (the one browser→third-party request Morphit makes).
 */
import { describe, expect, it } from 'vitest';

import {
	RELEASE_CACHE_KEY,
	RELEASE_CACHE_TTL_MS,
	readCachedRelease,
	writeCachedRelease,
	type StorageLike
} from './releaseCache';

const HOUR = 3_600_000;
const release = (version = '1.20.3') => ({
	payload: {
		version,
		hash_manifest: { '/index.html': 'sha256-9DrhlgWls108pHfeGxpf2wVhQSeHIJ3PnJ0ThHwkfOs=' }
	},
	trxId: 'ab'.repeat(20),
	blockNumber: 64_200_000,
	timestamp: '2026-10-02T01:00:00',
	signer: 'morphit'
});
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
	it('a fresh answer for the version this browser runs is reused (no node contacted)', () => {
		const s = mem();
		writeCachedRelease(s, 1_000, release() as never);
		expect(readCachedRelease(s, 1_000 + 23 * HOUR, '1.20.3')).toEqual(release());
	});
	it('after 24 hours it is asked again', () => {
		const s = mem();
		writeCachedRelease(s, 1_000, release() as never);
		expect(RELEASE_CACHE_TTL_MS).toBe(24 * HOUR);
		expect(readCachedRelease(s, 1_000 + 24 * HOUR, '1.20.3')).toBeNull();
		expect(s.data.has(RELEASE_CACHE_KEY)).toBe(false);
	});
	it('a site update in the meantime (another running version) asks again at once', () => {
		const s = mem();
		writeCachedRelease(s, 1_000, release('1.20.2') as never);
		expect(readCachedRelease(s, 2_000, '1.20.3')).toBeNull();
	});
	it('a clock set back, garbage, a forged signer or an invalid payload is never trusted', () => {
		const s = mem();
		writeCachedRelease(s, 10 * HOUR, release() as never);
		expect(readCachedRelease(s, 9 * HOUR, '1.20.3')).toBeNull();
		for (const bad of [
			'not json',
			JSON.stringify({ savedAt: 1, release: { ...release(), signer: 'mallory' } }),
			JSON.stringify({ savedAt: 1, release: { ...release(), payload: { version: '1.20.3' } } }),
			JSON.stringify({ savedAt: 'x', release: release() }),
			JSON.stringify({ savedAt: 1, release: { ...release(), blockNumber: 'x' } })
		]) {
			const t = mem();
			t.setItem(RELEASE_CACHE_KEY, bad);
			expect(readCachedRelease(t, 2, '1.20.3')).toBeNull();
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
		expect(() => writeCachedRelease(broken, 1, release() as never)).not.toThrow();
		expect(readCachedRelease(broken, 1, '1.20.3')).toBeNull();
	});
});
