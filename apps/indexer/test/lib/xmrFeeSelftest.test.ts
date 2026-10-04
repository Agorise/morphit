/**
 * v1.20.0 (MK-H2) — the pre-pin self-test the maintainer runs on one real bound payment.
 * Explorer bodies follow onion-monero-blockchain-explorer's JSON API (see
 * test/indexer/fee/xmrBoundFee.test.ts); the payment (tx key, extra,
 * encrypted payment ID) is a PyPI-`monero`-generated vector for the order
 * alice/order-kx2mq7p4n8za.
 */
import { describe, expect, it } from 'vitest';

import {
	runXmrFeeSelftest,
	runXmrUnboundFeeSelftest,
	xmrSelftestPayTo
} from '../../src/lib/xmrFeeSelftest';

const PRIMARY =
	'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy';
const TXKEY = 'e5b4fe26ae0a3a2f7d2bbed8a0c2a1c6d66925ccdbcb6bcef67a0ad66a9b9807';
const ENC = 'e75f39371458536e';
const EXTRA =
	'01795b5d51f7d7ed6459559babccb0cc4943a56c79f58a90e9b250246fe749b1b5020901e75f39371458536e';
const TXID = 'c'.repeat(64);

function explorers(pid8: string, extra: string) {
	return (async (input: Parameters<typeof fetch>[0]) => {
		const url = String(input);
		const body = url.includes('/api/outputs')
			? {
					status: 'success',
					data: {
						tx_hash: TXID,
						outputs: [
							{ output_pubkey: 'aa'.repeat(32), amount: 781_250_000, match: true, output_idx: 0 }
						],
						tx_confirmations: 5,
						tx_prove: true
					}
				}
			: {
					status: 'success',
					data: { tx_hash: TXID, payment_id: '', payment_id8: pid8, extra, confirmations: 5 }
				};
		return Response.json(body);
	}) as typeof fetch;
}

const opts = {
	txid: TXID,
	txKey: TXKEY.toUpperCase(),
	account: 'alice',
	permlink: 'order-kx2mq7p4n8za',
	primary: PRIMARY,
	piconero: 781_250_000n,
	explorers: ['https://a.example', 'https://b.example']
};

describe('xmr fee self-test', () => {
	it('passes on a payment made for the order, and shows each step', async () => {
		const lines: string[] = [];
		expect(await runXmrFeeSelftest(opts, explorers(ENC, EXTRA), (l) => lines.push(l))).toBe(true);
		const out = lines.join('\n');
		expect(out).toContain('decrypts to      : ');
		expect(out).toContain('✓ this order');
		expect(out).toContain('proven amount    : 781250000 piconero');
		expect(out).toMatch(/3\. Indexer verdict[^\n]*\n {3}verified/);
		expect(out).toMatch(/4\. [^\n]*\n {3}rejected — payment_id_mismatch/);
		expect(out).toContain('✓ PASS');
	});

	it("fails when the explorer's payment_id8 is not the one in the raw transaction", async () => {
		const lines: string[] = [];
		expect(
			await runXmrFeeSelftest(opts, explorers('21ef5479a14c4508', EXTRA), (l) => lines.push(l))
		).toBe(false);
		expect(lines.join('\n')).toContain('NO — explorer field does not match the raw tx');
		expect(lines.join('\n')).toContain('✗ FAIL');
	});

	it('fails for a payment made for another order', async () => {
		const lines: string[] = [];
		expect(
			await runXmrFeeSelftest({ ...opts, permlink: 'something-else' }, explorers(ENC, EXTRA), (l) =>
				lines.push(l)
			)
		).toBe(false);
		expect(lines.join('\n')).toContain('✗ not this order');
	});

	it('refuses a subaddress as the treasury main address before asking anyone', async () => {
		let asked = 0;
		const f = (async () => {
			asked++;
			throw new Error('no');
		}) as typeof fetch;
		const sub =
			'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
		expect(await runXmrFeeSelftest({ ...opts, primary: sub }, f, () => {})).toBe(false);
		expect(asked).toBe(0);
	});

	it('prints where to send the test payment (PyPI-monero integrated address)', () => {
		expect(xmrSelftestPayTo(PRIMARY, 'morphit', 'treasury-check')).toBe(
			'4Dp9BhCqXPR8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL4D3cDChHXgvUDJCUPuP'
		);
	});

	it('checks the pre-pin (unbound) path with the tx key at the shared fee address', async () => {
		const lines: string[] = [];
		const sub =
			'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
		const urls: string[] = [];
		const base = explorers(ENC, EXTRA);
		const f = (async (u: Parameters<typeof fetch>[0]) => {
			urls.push(String(u));
			return base(u);
		}) as typeof fetch;
		expect(
			await runXmrUnboundFeeSelftest(
				{
					txid: TXID,
					txKey: TXKEY,
					feeAddress: sub,
					piconero: 781_250_000n,
					explorers: ['https://a.example']
				},
				f,
				(l) => lines.push(l)
			)
		).toBe(true);
		expect(
			urls.every(
				(u) =>
					u.includes('/api/outputs') &&
					u.includes(`address=${sub}`) &&
					u.includes(`viewkey=${TXKEY}`)
			)
		).toBe(true);
	});

	it('(wave 4) passes against a raw-tx explorer, verifying the raw transaction locally', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const V = JSON.parse(
			readFileSync(resolve(__dirname, '../fixtures/xmr-rawtx-vectors.json'), 'utf8')
		);
		const v = V.vectors.find((x: { name: string }) => x.name === 'integrated-primary+change');
		const f = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			let body: unknown = null;
			let text = '';
			if (url.endsWith(`/api/get_transaction_data/${v.txid}`))
				body = { status: 'OK', transaction_data: v.tx };
			else if (url.endsWith(`/tx/${v.txid}`)) text = '<a href="/block/100">100</a>';
			else if (url.endsWith('/api/get_block_data/100'))
				body = {
					status: 'OK',
					block_data: { result: { block_header: { height: 100, depth: 3 }, tx_hashes: [v.txid] } }
				};
			else if (url.includes('/api/get_transaction_data/'))
				body = { status: 'ERROR', error: 'Transaction not found' };
			// A real Response: explorer answers are read as a size-capped stream.
			return new Response(body !== null || text === '' ? JSON.stringify(body) : text);
		}) as typeof fetch;
		const lines: string[] = [];
		const ok = await runXmrFeeSelftest(
			{
				txid: v.txid,
				txKey: v.tx_key,
				account: 'alice',
				permlink: 'order-kx2mq7p4n8za',
				primary: V.treasury.primary,
				piconero: 781_250_000n,
				explorers: ['raw-tx+https://moneroblocks.info']
			},
			f,
			(l) => lines.push(l)
		);
		expect(lines.join('\n')).toContain('content hashes to the txid: yes');
		expect(lines.join('\n')).toContain(
			'proven amount    : 781250000 piconero (outputs 1; commitments open)'
		);
		expect(ok).toBe(true);
	});

	it('(v1.20.2) passes against a pruned public NODE, verifying its transaction locally', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const V = JSON.parse(
			readFileSync(resolve(__dirname, '../fixtures/xmr-rawtx-vectors.json'), 'utf8')
		);
		const v = V.vectors.find((x: { name: string }) => x.name === 'integrated-primary+change');
		const pruned = { ...v.tx };
		delete pruned.rctsig_prunable;
		const posts: string[] = [];
		const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = String(input);
			let body: unknown = null;
			if (url === 'https://node.example/get_transactions' && init?.method === 'POST') {
				posts.push(String(init.body));
				body = {
					status: 'OK',
					untrusted: false,
					txs: [
						{
							tx_hash: v.txid,
							as_json: JSON.stringify(pruned),
							// computed separately (Python Keccak over the prunable part)
							prunable_hash: 'ff6340d559948c296f2cc07e92bffabeb6cf3cd27f4865b95d1839fca067c47a',
							in_pool: false,
							confirmations: 7
						}
					]
				};
			}
			return Response.json(body);
		}) as typeof fetch;
		const lines: string[] = [];
		const ok = await runXmrFeeSelftest(
			{
				txid: v.txid,
				txKey: v.tx_key,
				account: 'alice',
				permlink: 'order-kx2mq7p4n8za',
				primary: V.treasury.primary,
				piconero: 781_250_000n,
				explorers: ['node+https://node.example']
			},
			f,
			(l) => lines.push(l)
		);
		const out = lines.join('\n');
		expect(out).toContain('confirmations    : 7');
		expect(out).toContain('content hashes to the txid: yes');
		expect(out).toContain('proven amount    : 781250000 piconero (outputs 1; commitments open)');
		expect(ok).toBe(true);
		expect(posts.join('')).not.toContain(v.tx_key);
	});
});
