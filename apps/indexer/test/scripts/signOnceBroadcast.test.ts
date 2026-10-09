/**
 * the laptop broadcast scripts sign ONCE and fall back
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
	const clock = () => {
		let t = 1_000_000;
		return { now: () => t, sleep: async (ms: number) => void (t += ms) };
	};
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
			...clock(),
			getTx: async () => null,
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

	it('one node claiming a higher head is not used for TaPoS unless another node confirms that block', async () => {
		const liar: NodeHealth = { url: 'liar', ok: true, ms: 1, headBlock: 5000, props: props(5000) };
		const sent: Array<{ ref_block_num: number }> = [];
		await signOnceAndBroadcast(op, key, [liar, ok('b', 2, 101), ok('c', 3, 100)], {
			log: () => undefined,
			// b knows block 100 with the id c reported; nobody has the liar's block 5000.
			getBlock: async (url, num) =>
				num === 100 && url === 'b' ? { block_id: props(100).head_block_id } : null,
			sleep: async () => undefined,
			send: async (_url, tx) => {
				sent.push(tx as { ref_block_num: number });
				return { block_num: 102 };
			}
		});
		expect(sent[0]!.ref_block_num, 'built on the unconfirmed head of one node').toBe(100);
	});

	it('"accepted" is checked on another node; a lone claim is reported as not confirmed', async () => {
		const lines: string[] = [];
		const lone = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: (l) => void lines.push(l),
			getBlock: async () => ({ block_id: 'x', transaction_ids: [] }),
			sleep: async () => undefined,
			send: async () => ({ block_num: 101 })
		});
		expect(lone.confirmedBy).toBeNull();
		expect(lines.join('\n')).toMatch(/NOT confirmed by a second node/);
		const seen = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: () => undefined,
			getBlock: async (url) =>
				url === 'b' ? { block_id: 'x', transaction_ids: [lone.trxId] } : null,
			sleep: async () => undefined,
			send: async () => ({ block_num: 101 })
		});
		expect(seen.confirmedBy).toBe('b');
	});
	// 2026-10-07 (snapshot anchor): dblurt's send uses the asynchronous
	// broadcast_transaction, which answers without a block number, so nothing
	// was checked and the run said "NOT confirmed by a second node" for a
	// transaction that was in a block. Now the other nodes are asked for the
	// transaction by its id, and the block they name is checked for it.

	it('accepted without a block number: found by id on another node, then seen in that block', async () => {
		const lines: string[] = [];
		const c = clock();
		let id = '';
		const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2), ok('c', 3)], {
			log: (l) => void lines.push(l),
			...c,
			getTx: async (url, trx) => {
				id = trx;
				return url === 'b' ? { block_num: 105, transaction_id: trx } : null;
			},
			getBlock: async (url, num) =>
				num === 105
					? { block_id: 'x', transaction_ids: [id] }
					: { block_id: 'x', transaction_ids: [] },
			send: async () => ({})
		});
		expect(r.blockNum).toBe(105);
		expect(r.confirmedBy).not.toBeNull();
		expect(r.confirmedBy).not.toBe('a');
		expect(lines.join('\n')).toMatch(/Confirmed: .* has transaction .* in block 105/);
		expect(lines.join('\n')).not.toMatch(/NOT confirmed/);
	});

	it('an answer without the id, with a block before the head, or whose block lacks it is not a confirmation', async () => {
		// Each case breaks one rule only: in the first three the block the answer
		// names lists the transaction, so only the answer itself can reject it.
		for (const [answer, blockLists] of [
			[(_trx: string) => ({ block_num: 105, transaction_id: 'f'.repeat(40) }), true], // another id
			[(trx: string) => ({ block_num: 90, transaction_id: trx }), true], // before the head it was built on
			[(trx: string) => ({ block_num: 5_000, transaction_id: trx }), true], // after it expired
			[(trx: string) => ({ block_num: 105, transaction_id: trx }), false] // the block does not list it
		] as const) {
			const lines: string[] = [];
			let id = '';
			const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
				log: (l) => void lines.push(l),
				...clock(),
				getTx: async (_url, trx) => {
					id = trx;
					return answer(trx);
				},
				// Only the block the answer names exists (no new block yet for the
				// scan of new blocks), and it lists the id unless this case says not.
				getBlock: async (_u, num) =>
					num === answer(id).block_num
						? { block_id: 'x', transaction_ids: blockLists ? [id] : [] }
						: null,
				send: async () => ({})
			});
			expect(r.confirmedBy).toBeNull();
			expect(lines.join('\n')).toMatch(/NOT confirmed by a second node/);
		}
	});

	it('the block is checked on a node other than the one that answered, when there is one', async () => {
		let id = '';
		const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2), ok('c', 3)], {
			log: () => undefined,
			...clock(),
			getTx: async (url, trx) => {
				id = trx;
				return url === 'b' ? { block_num: 104, transaction_id: trx } : null;
			},
			getBlock: async (_u, num) => (num === 104 ? { block_id: 'x', transaction_ids: [id] } : null),
			send: async () => ({})
		});
		expect(r.blockNum).toBe(104);
		expect(r.confirmedBy, 'b confirmed its own answer').toBe('c');
	});

	it('the other nodes are asked in parallel each round, and the wait ends when the transaction has expired', async () => {
		const c = clock();
		const start = c.now();
		const calls: string[] = [];
		const nodes = [ok('a', 1), ok('b', 2), ok('c', 3), ok('d', 4)];
		await signOnceAndBroadcast(op, key, nodes, {
			log: () => undefined,
			...c,
			getTx: async (url) => {
				calls.push(url);
				return null;
			},
			getBlock: async () => ({ block_id: 'x', transaction_ids: [] }),
			send: async () => ({})
		});
		const waited = c.now() - start;
		expect(waited).toBeLessThanOrEqual(60_000 + 6_000 + 3_000);
		// Every round asks all three other nodes.
		expect(calls.length % 3).toBe(0);
		expect(calls.filter((u) => u === 'a').length).toBe(0);
	});

	// 2026-10-08 (v1.21.2 release broadcast): in block 64,311,469 within ~12 s,
	// but the look-up by id found it only after ~55 s, close to the give-up time.
	it('found in a new block as soon as another node serves it, without waiting for the look-up by id', async () => {
		const lines: string[] = [];
		let id = '';
		const c = clock();
		const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2), ok('c', 3)], {
			log: (l) => void lines.push(l),
			...c,
			// The look-up by id never knows it (its index lags).
			getTx: async (_u, trx) => {
				id = trx;
				return null;
			},
			// Blocks 101 and 102 are out without it; 103 lists it; 104 is not out yet.
			getBlock: async (_u, num) =>
				num <= 102
					? { block_id: 'x', transaction_ids: [] }
					: num === 103
						? { block_id: 'x', transaction_ids: [id] }
						: null,
			send: async () => ({})
		});
		expect(r.blockNum).toBe(103);
		expect(r.confirmedBy).not.toBeNull();
		expect(r.confirmedBy, 'the node it was sent to confirmed itself').not.toBe('a');
		expect(lines.join('\n')).toMatch(/Confirmed: .* in block 103/);
		expect(
			lines.filter((l) => /round \d+:/.test(l)).length,
			'it waited rounds for the look-up'
		).toBe(0);
	});

	it('a block only the node it was sent to serves is not a confirmation', async () => {
		let id = '';
		const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: () => undefined,
			...clock(),
			getTx: async (_u, trx) => {
				id = trx;
				return null;
			},
			getBlock: async (u, num) =>
				u === 'a' && num === 101 ? { block_id: 'x', transaction_ids: [id] } : null,
			send: async () => ({})
		});
		expect(r.confirmedBy).toBeNull();
	});

	it('no block after the last one the transaction can be in is read', async () => {
		const asked: number[] = [];
		await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: () => undefined,
			...clock(),
			getTx: async () => null,
			getBlock: async (_u, num) => {
				asked.push(num);
				return { block_id: 'x', transaction_ids: [] };
			},
			send: async () => ({})
		});
		// Built on head 100; it expires 60 s (20 blocks) later, plus two.
		expect(Math.max(...asked)).toBeLessThanOrEqual(100 + 20 + 2);
		expect(Math.min(...asked)).toBe(101);
	});

	it('"duplicate transaction": the block is looked up by id too', async () => {
		let id = '';
		const r = await signOnceAndBroadcast(op, key, [ok('a', 1), ok('b', 2)], {
			log: () => undefined,
			...clock(),
			getTx: async (_url, trx) => {
				id = trx;
				return { block_num: 103, transaction_id: trx };
			},
			getBlock: async (_u, num) => (num === 103 ? { block_id: 'x', transaction_ids: [id] } : null),
			send: async () => {
				throw new Error('Duplicate transaction check failed');
			}
		});
		expect(r.duplicate).toBe(true);
		expect(r.blockNum).toBe(103);
	});
});
