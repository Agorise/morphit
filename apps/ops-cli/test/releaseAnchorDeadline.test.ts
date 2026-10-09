/**
 * v1.21.4 review (A8a): the wait for a release record that no node lists yet
 * is bounded by its deadline. A round that began just before the deadline used
 * to ask EVERY source, each with its own timeout, so slow sources could hold
 * the upgrade far past the three minutes it promises under the spinner.
 */
import { describe, it, expect } from 'vitest';
import { findSignedReleaseAnchor, readSignedReleaseAnchor } from '../src/lib/releaseAnchor.ts';
import { OFFICIAL_PUB, OTHER, signedRelease } from './helpers/releaseChain.ts';

const args = {
	tag: 'v1.18.0',
	signer: 'morphit',
	pinnedPubkey: OFFICIAL_PUB,
	chainId: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f'
};

describe('waiting for the release record', () => {
	it('no source is started after the deadline, however slow each one is', async () => {
		let t = 0;
		let asked = 0;
		// A node that takes 50 s to answer, and does not list the record.
		const slow = async (method: string): Promise<unknown> => {
			if (method !== 'get_account_history') throw new Error(`unexpected ${method}`);
			asked++;
			t += 50_000;
			return [];
		};
		const r = await findSignedReleaseAnchor(
			{
				sources: [slow, slow, slow],
				waitMs: 180_000,
				intervalMs: 10_000,
				now: () => t,
				sleep: async (ms) => void (t += ms)
			},
			args
		);
		expect(r.ok).toBe(false);
		// The first round asks every source; after that, a source starts only
		// before the deadline, so the wait ends within one source of it.
		expect(t).toBeLessThanOrEqual(180_000 + 50_000);
		expect(asked).toBeGreaterThanOrEqual(4);
	});

	it('the first round always asks every source, even with no wait', async () => {
		let t = 0;
		let asked = 0;
		const slow = async (): Promise<unknown> => (asked++, (t += 50_000), []);
		await findSignedReleaseAnchor(
			{ sources: [slow, slow, slow], waitMs: 0, now: () => t, sleep: async () => undefined },
			args
		);
		expect(asked).toBe(3);
	});
});

// v1.21.4 review: a node a few blocks behind answers `get_block` with nothing
// for a record another node's history already lists. On a Tor/I2P-only server
// the indexer relays each read to whichever node answers first, so the upgrade
// refused at once — the same lag this release waits out for the history. Both
// callers wait exactly when the answer says `notListed`.
describe('a listed record whose block a lagging node does not have yet', () => {
	const f = signedRelease('1.18.0', {
		source_sha256: 'a'.repeat(64),
		gpg_fingerprint: 'c'.repeat(40)
	});

	it('tells the upgrade to wait, like a record not listed yet', async () => {
		for (const block of [
			async () => null,
			async () => ({ transactions: [] }),
			async () => {
				throw new Error('timeout');
			}
		]) {
			const r = await readSignedReleaseAnchor(
				async (m: string) => (m === 'get_account_history' ? f.history : block()),
				args
			);
			expect(r.ok).toBe(false);
			expect('notListed' in r && r.notListed, JSON.stringify(r)).toBe(true);
		}
	});

	it('and the wait then finds it once the node has the block', async () => {
		let t = 0;
		let blockReads = 0;
		const lagging = async (method: string, params: readonly unknown[]): Promise<unknown> => {
			if (method === 'get_account_history') return f.history;
			blockReads++;
			return blockReads <= 2 ? null : (f.blocks[Number(params[0])] ?? null);
		};
		const r = await findSignedReleaseAnchor(
			{
				sources: [lagging],
				waitMs: 180_000,
				intervalMs: 10_000,
				now: () => t,
				sleep: async (ms) => void (t += ms)
			},
			args
		);
		expect(r).toMatchObject({ ok: true, anchor: { sourceSha256: 'a'.repeat(64) } });
	});

	it('a block that holds a record signed by someone else is not a reason to wait', async () => {
		const forged = signedRelease(
			'1.18.0',
			{ source_sha256: 'd'.repeat(64), gpg_fingerprint: 'c'.repeat(40) },
			{ key: OTHER }
		);
		const r = await readSignedReleaseAnchor(
			async (m: string, p: readonly unknown[]) =>
				m === 'get_account_history' ? forged.history : (forged.blocks[Number(p[0])] ?? null),
			args
		);
		expect(r.ok).toBe(false);
		expect('notListed' in r ? r.notListed : undefined).not.toBe(true);
	});
});
