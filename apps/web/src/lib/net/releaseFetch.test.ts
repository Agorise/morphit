/**
 * v1.20.3 — the release check reads @morphit's LAST 100 history entries first
 * (a few KB) and walks further back only when the release op is not among
 * them. It used to read 10,000 entries (~115 KB on the wire) on every visit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: number[] = [];
let releaseAt: number | null = 40; // how many entries back the release op sits
vi.mock('$blurt/client', () => ({
	getDirectChainClient: () => ({
		getLatestCustomJson: async (_account: string, _id: string, limit: number) => {
			calls.push(limit);
			if (releaseAt === null || releaseAt > limit) return null;
			return {
				payload: { version: '1.20.3', hash_manifest: {} },
				blockNumber: 1,
				trxId: 'ab'.repeat(20),
				timestamp: '2026-10-02T01:00:00'
			};
		},
		getAccount: async () => ({
			posting: { key_auths: [[(await import('$net/config')).MORPHIT_OFFICIAL_POSTING_PUBKEY, 1]] }
		})
	})
}));

import { RELEASE_HISTORY_WINDOWS, fetchVerifiedRelease } from './releaseFetch';

beforeEach(() => {
	calls.length = 0;
});

describe('how far back the release check reads', () => {
	it('starts with 100 entries and stops there when the release is in them', async () => {
		releaseAt = 40;
		const r = await fetchVerifiedRelease();
		expect(r.ok).toBe(true);
		expect(calls).toEqual([100]);
	});
	it('walks further back only when it must', async () => {
		releaseAt = 3_000;
		const r = await fetchVerifiedRelease();
		expect(r.ok).toBe(true);
		expect(calls).toEqual([100, 10_000]);
		expect(RELEASE_HISTORY_WINDOWS).toEqual([100, 10_000]);
	});
	it('no release anywhere: no_release after the full window', async () => {
		releaseAt = null;
		const r = await fetchVerifiedRelease();
		expect(r).toEqual({ ok: false, error: { kind: 'no_release' } });
		expect(calls).toEqual([100, 10_000]);
	});
});
