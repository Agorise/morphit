/**
 * The "settled with someone else" auto-reply chooses its envelope by the same
 * rule as a conversation (chatService.seal, v1.21.13): v2 only when our chat
 * key is current and the inquirer has one; otherwise v3 to the inquirer's
 * PINNED posting keys, every one of them. Never a silent move off checked keys
 * (review M7).
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
	const encrypt = vi.fn(async () => ({
		v: 2 as const,
		ciphertext: 'c',
		ephemeralPub: 'e',
		nonce: 'n'
	}));
	const deps: SettledElsewhereDeps = {
		fetchOrderInquirers: async () => ['ann', 'ben', 'cy'],
		fetchPeerChatPub: async (p) => (p === 'ann' ? new Uint8Array(32).fill(1) : null),
		deriveMyChatIdentity: async () => ({ priv: new Uint8Array(32), pub: new Uint8Array(32) }),
		encrypt,
		broadcast: async (_l, payload) => {
			sent.push(payload);
			return { block_num: null, trx_id: 't' };
		},
		generateClientTag: () => '0'.repeat(32),
		fetchPostingPubs: async () => [K(1), K(2)],
		myChatKeyStatus: async () => 'current',
		encryptPosting,
		...over
	};
	return { deps, sent, encrypt, encryptPosting };
}
const run = (deps: SettledElsewhereDeps) =>
	announceSettledElsewhere(deps, {
		orderPermlink: 'sell-btc-usd-abc123',
		counterparty: 'zed',
		me: 'me',
		live: LIVE
	});

describe('announceSettledElsewhere — which envelope', () => {
	it('ours current: v2 to an inquirer with a chat key; v3 to every posting key of the others', async () => {
		const t = setup();
		expect(await run(t.deps)).toEqual({ sent: 3, skipped: 0, failed: 0 });
		const by = Object.fromEntries(
			t.sent.map((p) => [p.recipient, p.header as Record<string, unknown>])
		);
		expect(by.ann!.v).toBe(2);
		expect(by.ben!.v).toBe(3);
		expect(by.ben!.rk).toEqual(['1', '2']);
		expect(by.ben!.wk).toEqual(['w', 'w']);
	});

	it('ours none: v3 to everyone, and no inquirer’s chat key is asked for', async () => {
		const fetchPeerChatPub = vi.fn(async () => new Uint8Array(32).fill(1));
		const t = setup({ myChatKeyStatus: async () => 'none', fetchPeerChatPub });
		expect(await run(t.deps)).toEqual({ sent: 3, skipped: 0, failed: 0 });
		expect(t.sent.every((p) => (p.header as Record<string, unknown>).v === 3)).toBe(true);
		expect(fetchPeerChatPub).not.toHaveBeenCalled();
	});

	it('ours unknown: nothing is sent to anyone', async () => {
		const t = setup({
			myChatKeyStatus: async () => {
				throw new Error('down');
			}
		});
		expect(await run(t.deps)).toEqual({ sent: 0, skipped: 0, failed: 3 });
		expect(t.sent).toHaveLength(0);
	});

	it('an inquirer whose chat key is pinned, and the indexer says has none: not written to', async () => {
		const t = setup({ pinnedPeerPubs: (p) => (p === 'ben' ? [new Uint8Array(32)] : []) });
		expect(await run(t.deps)).toEqual({ sent: 2, skipped: 0, failed: 1 });
		expect(t.sent.map((p) => p.recipient)).not.toContain('ben');
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
	});

	it('an inquirer whose chat key is pinned gets no posting keys on first use (consent asked)', async () => {
		const pinPostingKey = vi.fn(
			async (_p: string, keys: readonly Uint8Array[], opts?: { needsConsent?: boolean }) => {
				if (opts?.needsConsent === true) throw new Error('posting keys not checked yet');
				return [...keys];
			}
		);
		const t = setup({
			myChatKeyStatus: async () => 'none',
			pinPostingKey,
			pinnedPeerPubs: (p) => (p === 'cy' ? [new Uint8Array(32)] : [])
		});
		expect(await run(t.deps)).toEqual({ sent: 2, skipped: 0, failed: 1 });
		expect(t.sent.map((p) => p.recipient)).not.toContain('cy');
	});

	it('no such account, or no posting key of its own: skipped', async () => {
		const t = setup({ fetchPostingPubs: async (p) => (p === 'ben' ? null : []) });
		expect(await run(t.deps)).toEqual({ sent: 1, skipped: 2, failed: 0 });
	});
});
