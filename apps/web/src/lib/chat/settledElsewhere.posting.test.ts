/**
 * The "settled with someone else" auto-reply is sent exactly like a
 * conversation's messages (chatService.seal): since v1.21.14 ALWAYS the
 * posting-key envelope (v3) to the inquirer's PINNED posting keys, every one
 * of them — chat relies on the posting key only. Trusted on first use whatever
 * chat key of theirs is pinned; never a silent move off a changed set (review
 * M7).
 */
import { describe, expect, it, vi } from 'vitest';
import type { LiveIdentity } from '$crypto/keygen';
import { announceSettledElsewhere, type SettledElsewhereDeps } from './settledElsewhere';

const LIVE = {} as LiveIdentity;
const K = (n: number) => new Uint8Array(33).fill(n);

function setup(over: Partial<SettledElsewhereDeps> = {}) {
	const sent: Record<string, unknown>[] = [];
	const encryptPosting = vi.fn(async (_pt: string, keys: readonly Uint8Array[]) => ({
		v: 3 as const,
		ciphertext: 'c',
		ephemeralPub: 'e',
		nonce: 'n',
		senderKey: 's',
		recipientKeys: keys.map((k) => String(k[0])),
		wraps: keys.map(() => 'w')
	}));
	const deps: SettledElsewhereDeps = {
		fetchOrderInquirers: async () => ['ann', 'ben', 'cy'],
		broadcast: async (_l, payload) => {
			sent.push(payload);
			return { block_num: null, trx_id: 't' };
		},
		generateClientTag: () => '0'.repeat(32),
		fetchPostingPubs: async () => [K(1), K(2)],
		encryptPosting,
		...over
	};
	return { deps, sent, encryptPosting };
}
const run = (deps: SettledElsewhereDeps) =>
	announceSettledElsewhere(deps, {
		orderPermlink: 'sell-btc-usd-abc123',
		counterparty: 'zed',
		me: 'me',
		live: LIVE
	});

describe('announceSettledElsewhere — the posting-key envelope, always', () => {
	it('v3 to every posting key of every inquirer (none in the chat-key format)', async () => {
		const t = setup();
		expect(await run(t.deps)).toEqual({ sent: 3, skipped: 0, failed: 0 });
		const by = Object.fromEntries(
			t.sent.map((p) => [p.recipient, p.header as Record<string, unknown>])
		);
		for (const who of ['ann', 'ben', 'cy']) {
			expect(by[who]!.v).toBe(3);
			expect(by[who]!.rk).toEqual(['1', '2']);
			expect(by[who]!.wk).toEqual(['w', 'w']);
		}
		expect(t.sent.every((p) => p.order_permlink === 'sell-btc-usd-abc123')).toBe(true);
	});

	it('the posting keys go through the pins: a changed set is not written to', async () => {
		const pinPostingKey = vi.fn(async (peer: string, keys: readonly Uint8Array[]) => {
			if (peer === 'cy') throw new Error('changed');
			return [keys[1]!];
		});
		const t = setup({ pinPostingKey });
		expect(await run(t.deps)).toEqual({ sent: 2, skipped: 0, failed: 1 });
		const ben = t.sent.find((p) => p.recipient === 'ben')!.header as Record<string, unknown>;
		expect(ben.rk).toEqual(['2']); // the pinned keys, not the chain's first
		expect(pinPostingKey.mock.calls.map((c) => c.length)).toEqual([2, 2, 2]);
	});

	it('no such account, or no posting key of its own: skipped', async () => {
		const t = setup({
			fetchPostingPubs: async (p) => (p === 'ben' ? null : p === 'cy' ? [] : [K(1)])
		});
		expect(await run(t.deps)).toEqual({ sent: 1, skipped: 2, failed: 0 });
	});
});
