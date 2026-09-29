/**
 * v1.20.0 (MK-H2) — watching a per-order BTC fee address.
 *
 * The verifier asks the configured Esplora explorers (the same set, clearnet
 * or onion, the txid path uses) for `/address/<addr>` and needs a quorum of
 * them to agree on the CONFIRMED total received before an order counts as
 * paid. All HTTP is mocked; the response bodies are the Esplora
 * `GET /address/:address` shape (blockstream/esplora API docs:
 * { address, chain_stats: { funded_txo_sum, … }, mempool_stats: { … } }).
 */
import { describe, expect, it, vi } from 'vitest';

import {
	BitcoinExplorerFeeVerifier,
	type BitcoinExplorerFeeVerifierConfig
} from '$indexer/fee/bitcoinExplorerVerifier';

const ADDR = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const A = 'https://blockstream.info/api';
const B = 'https://mempool.space/api';
const C = 'http://explorerzydxu5ecjrkwceayqybizmpjjznk5izmitf2modhcusuqlid.onion/api';

function cfg(o: Partial<BitcoinExplorerFeeVerifierConfig> = {}): BitcoinExplorerFeeVerifierConfig {
	return {
		feeAddress: 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk',
		explorerUrls: [A],
		minConfirmations: 1,
		requestTimeoutMs: 2_000,
		minSuccessfulResponses: 1,
		...o
	};
}

function stats(confirmed: number, mempool = 0, address = ADDR) {
	return {
		address,
		chain_stats: {
			funded_txo_count: confirmed > 0 ? 1 : 0,
			funded_txo_sum: confirmed,
			spent_txo_count: 0,
			spent_txo_sum: 0,
			tx_count: confirmed > 0 ? 1 : 0
		},
		mempool_stats: {
			funded_txo_count: mempool > 0 ? 1 : 0,
			funded_txo_sum: mempool,
			spent_txo_count: 0,
			spent_txo_sum: 0,
			tx_count: mempool > 0 ? 1 : 0
		}
	};
}

type Reply = { body?: unknown; status?: number; text?: string; throws?: Error };
function fetchBy(routes: Record<string, Reply>) {
	const calls: string[] = [];
	const f = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
		const url = typeof input === 'string' ? input : input.toString();
		calls.push(url);
		// longest matching key wins, so `${A}/address/x/txs` beats `${A}/address/x`
		const key = Object.keys(routes)
			.filter((k) => url === k || url.startsWith(k))
			.sort((a, b) => b.length - a.length)[0];
		if (key === undefined) throw new Error(`unmocked ${url}`);
		const r = routes[key]!;
		if (r.throws) throw r.throws;
		const status = r.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => r.body,
			text: async () => r.text ?? JSON.stringify(r.body)
		};
	}) as unknown as typeof fetch;
	return { f, calls };
}

describe('per-order BTC fee address: payment check', () => {
	it('is paid once the confirmed total reaches the amount', async () => {
		const { f, calls } = fetchBy({ [`${A}/address/${ADDR}`]: { body: stats(1000) } });
		const v = new BitcoinExplorerFeeVerifier(cfg(), f);
		expect(await v.checkAddressPayment(ADDR, 1000)).toEqual({
			kind: 'paid',
			confirmedSats: 1000,
			unconfirmedSats: 0
		});
		expect(calls).toEqual([`${A}/address/${ADDR}`]);
	});

	it('applies the same 15% price tolerance as the txid path, and no more', async () => {
		const at850 = new BitcoinExplorerFeeVerifier(
			cfg(),
			fetchBy({ [`${A}/address/${ADDR}`]: { body: stats(850) } }).f
		);
		expect((await at850.checkAddressPayment(ADDR, 1000)).kind).toBe('paid');
		const at849 = new BitcoinExplorerFeeVerifier(
			cfg(),
			fetchBy({ [`${A}/address/${ADDR}`]: { body: stats(849) } }).f
		);
		expect(await at849.checkAddressPayment(ADDR, 1000)).toEqual({
			kind: 'not_yet',
			confirmedSats: 849,
			unconfirmedSats: 0
		});
	});

	it('reports an unconfirmed payment as seen but not yet paid', async () => {
		const v = new BitcoinExplorerFeeVerifier(
			cfg(),
			fetchBy({ [`${A}/address/${ADDR}`]: { body: stats(0, 1000) } }).f
		);
		expect(await v.checkAddressPayment(ADDR, 1000)).toEqual({
			kind: 'not_yet',
			confirmedSats: 0,
			unconfirmedSats: 1000
		});
	});

	it('needs a quorum: one explorer claiming payment cannot outvote two that see none', async () => {
		const { f } = fetchBy({
			[`${A}/address/${ADDR}`]: { body: stats(5000) },
			[`${B}/address/${ADDR}`]: { body: stats(0) },
			[`${C}/address/${ADDR}`]: { body: stats(0) }
		});
		const v = new BitcoinExplorerFeeVerifier(
			cfg({ explorerUrls: [A, B, C], minSuccessfulResponses: 2 }),
			f
		);
		const r = await v.checkAddressPayment(ADDR, 1000);
		expect(r).toEqual({ kind: 'not_yet', confirmedSats: 0, unconfirmedSats: 0 });
	});

	it('gives no answer when explorers disagree without a quorum', async () => {
		const { f } = fetchBy({
			[`${A}/address/${ADDR}`]: { body: stats(5000) },
			[`${B}/address/${ADDR}`]: { body: stats(0) }
		});
		const v = new BitcoinExplorerFeeVerifier(
			cfg({ explorerUrls: [A, B], minSuccessfulResponses: 2 }),
			f
		);
		expect((await v.checkAddressPayment(ADDR, 1000)).kind).toBe('no_answer');
	});

	it('ignores an explorer that answers for a different address', async () => {
		const { f } = fetchBy({
			[`${A}/address/${ADDR}`]: {
				body: stats(5000, 0, 'bc1qsomeoneelse000000000000000000000000000')
			}
		});
		const v = new BitcoinExplorerFeeVerifier(cfg(), f);
		expect((await v.checkAddressPayment(ADDR, 1000)).kind).toBe('no_answer');
	});

	it('gives no answer when every explorer is unreachable', async () => {
		const { f } = fetchBy({ [`${A}/address/${ADDR}`]: { throws: new Error('ECONNREFUSED') } });
		const v = new BitcoinExplorerFeeVerifier(cfg(), f);
		expect((await v.checkAddressPayment(ADDR, 1000)).kind).toBe('no_answer');
	});

	it('refuses malformed amounts rather than crediting them', async () => {
		const bad = stats(0);
		(bad.chain_stats as Record<string, unknown>).funded_txo_sum = 'lots';
		const v = new BitcoinExplorerFeeVerifier(
			cfg(),
			fetchBy({ [`${A}/address/${ADDR}`]: { body: bad } }).f
		);
		expect((await v.checkAddressPayment(ADDR, 1000)).kind).toBe('no_answer');
	});

	it('with minConfirmations 3, does not count a payment only 1 block deep', async () => {
		const tx = {
			txid: 'b'.repeat(64),
			vout: [{ value: 1000, scriptpubkey_address: ADDR }],
			status: { confirmed: true, block_height: 800_000 }
		};
		const shallow = fetchBy({
			[`${A}/address/${ADDR}/txs`]: { body: [tx] },
			[`${A}/address/${ADDR}`]: { body: stats(1000) },
			[`${A}/blocks/tip/height`]: { text: '800000' }
		});
		const v1 = new BitcoinExplorerFeeVerifier(cfg({ minConfirmations: 3 }), shallow.f);
		expect(await v1.checkAddressPayment(ADDR, 1000)).toEqual({
			kind: 'not_yet',
			confirmedSats: 0,
			unconfirmedSats: 0
		});
		const deep = fetchBy({
			[`${A}/address/${ADDR}/txs`]: { body: [tx] },
			[`${A}/address/${ADDR}`]: { body: stats(1000) },
			[`${A}/blocks/tip/height`]: { text: '800002' }
		});
		const v3 = new BitcoinExplorerFeeVerifier(cfg({ minConfirmations: 3 }), deep.f);
		expect((await v3.checkAddressPayment(ADDR, 1000)).kind).toBe('paid');
	});
});
