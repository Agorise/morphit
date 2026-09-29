/**
 * v1.20.0 fix wave, D12 — the laptop broadcast scripts sign ONCE and fall back
 * through health-ranked nodes with that same transaction.
 *
 * Before: each script called dblurt's `customJson` per node in a fixed order,
 * which builds and signs a NEW transaction against each node's head. A node that
 * accepted but whose answer was lost was followed by a different transaction
 * carrying the same op — a second release op on chain from one ceremony.
 */
import { describe, expect, it } from 'vitest';
import { PrivateKey } from '@beblurt/dblurt';
import {
	candidateNodes,
	rankNodes,
	signOnceAndBroadcast,
	type NodeHealth
} from '../../scripts/lib/signOnceBroadcast';

const key = PrivateKey.fromSeed('d12-test');
const props = (n: number) => ({
	head_block_number: n,
	head_block_id: `${n.toString(16).padStart(8, '0')}aabbccdd${'0'.repeat(24)}`,
	time: '2026-09-27T12:00:00'
});
const ok = (url: string, ms: number, head = 100): NodeHealth => ({
	url,
	ok: true,
	ms,
	headBlock: head,
	props: props(head)
});
const op = [
	[
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: ['morphit'],
			id: 'morphit_release_v1',
			json: '{}'
		}
	]
] as never;

describe('sign once, broadcast to ranked nodes (D12)', () => {
	it('clearnet only by default; hidden nodes only when asked; --node pins one', () => {
		const d = candidateNodes({ nodeOverride: null, includeHidden: false });
		expect(d.length).toBe(6);
		expect(d.some((u) => /\.onion|\.i2p/.test(u))).toBe(false);
		expect(candidateNodes({ nodeOverride: null, includeHidden: true }).length).toBe(20);
		expect(candidateNodes({ nodeOverride: 'https://x.example', includeHidden: true })).toEqual([
			'https://x.example'
		]);
	});

	it('ranks current, fast nodes first and silent ones last', async () => {
		const table: Record<string, NodeHealth> = {
			a: { url: 'a', ok: false, ms: 1, headBlock: null, reason: 'down' },
			b: ok('b', 50),
			c: ok('c', 10),
			d: ok('d', 5, 90)
		};
		const r = await rankNodes(['a', 'b', 'c', 'd'], { probe: async (u) => table[u]! });
		expect(r.map((h) => h.url)).toEqual(['c', 'b', 'd', 'a']);
	});

	it('the SAME signed transaction goes to every node tried — never a re-sign', async () => {
		const got: Array<{ url: string; tx: unknown }> = [];
		const res = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2), ok('c', 3)], {
			log: () => undefined,
			send: async (url, tx) => {
				got.push({ url, tx: JSON.parse(JSON.stringify(tx)) });
				if (url !== 'c') throw new Error('socket hang up');
				return { block_num: 7 };
			}
		});
		expect(got.map((g) => g.url)).toEqual(['a', 'b', 'c']);
		expect(got[1]!.tx, 'a fallback node was handed a different transaction').toEqual(got[0]!.tx);
		expect(got[2]!.tx).toEqual(got[0]!.tx);
		expect(res).toMatchObject({ via: 'c', blockNum: 7, duplicate: false });
	});

	it('"duplicate transaction" from a later node means an earlier attempt landed: success, same id', async () => {
		const res = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: () => undefined,
			send: async (url) => {
				if (url === 'a') throw new Error('timeout');
				throw new Error('Duplicate transaction check failed');
			}
		});
		expect(res.duplicate).toBe(true);
		expect(res.via).toBe('b');
	});

	it('an expired transaction stops the run — it is never re-signed automatically', async () => {
		let t = 0;
		const sent: number[] = [];
		await expect(
			signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
				log: () => undefined,
				now: () => t,
				send: async () => {
					sent.push(t);
					t += 60_000;
					throw new Error('timeout');
				}
			})
		).rejects.toThrow(/expired before any node confirmed/);
		expect(sent.length).toBe(1);
	});
});
