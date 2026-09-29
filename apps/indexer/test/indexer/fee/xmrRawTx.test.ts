/**
 * v1.20.0 (wave 4) — verifying an XMR fee from the RAW transaction, locally.
 *
 * moneroblocks.info serves the raw transaction (get_transaction_data) but no
 * txprove. The indexer checks it itself with the payer's tx key:
 *   - the transaction hash of the served content equals the txid claimed
 *     (so the explorer cannot serve other content) — checked against a REAL
 *     mainnet transaction (0323898c…, fetched from moneroblocks.info and
 *     cross-checked with xmrchain.net / moneroexplorer.org);
 *   - output match P = Hs(8·r·A ‖ varint(i))·G + B (view tag as a filter);
 *   - amount = ecdhInfo XOR Keccak("amount" ‖ Hs)[0..8] AND the Pedersen
 *     commitment mask·G + amount·H equals outPk (H from rctTypes.h);
 *   - the encrypted payment ID from the same extra bytes.
 * Synthetic transactions: built with PyPI `monero` 1.1.1 primitives and
 * decoded by PyPI's OWN wallet-side scanner (Transaction.outputs(wallet),
 * view key + every tx pubkey) — see test/fixtures/xmr-rawtx-vectors.json
 * (`pyscan` = what PyPI found: output index → [address, piconero]).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MONERO_H_HEX, moneroTxHash, scanRawTxForAddress } from '$indexer/fee/xmrRawTx';
import { parseXmrAddress } from '@morphit/release-schema';

const V = JSON.parse(
	readFileSync(resolve(__dirname, '../../fixtures/xmr-rawtx-vectors.json'), 'utf8')
);
const MAINNET = JSON.parse(
	readFileSync(resolve(__dirname, '../../fixtures/xmr-rawtx-mainnet-0323898c.json'), 'utf8')
).transaction_data;

function keysOf(addr: string) {
	const p = parseXmrAddress(addr);
	if (!p.ok) throw new Error('bad vector address');
	return { viewPub: p.value.viewPub, spendPub: p.value.spendPub };
}
const byName = (n: string) => V.vectors.find((v: { name: string }) => v.name === n);

describe('raw-tx verification', () => {
	it("uses Monero's H (rctTypes.h) — the same constant PyPI monero uses", () => {
		expect(MONERO_H_HEX).toBe('8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94');
		expect(V.H).toBe(MONERO_H_HEX);
	});

	it('reproduces the txid of a real mainnet transaction from the served JSON', () => {
		expect(moneroTxHash(MAINNET)).toBe(
			'0323898c1e355ed3b1939a4ab617611d95bdf8f22777cdab44c6dfd4cc537d3e'
		);
		// one flipped byte anywhere → another hash
		const t = JSON.parse(JSON.stringify(MAINNET));
		t.rct_signatures.ecdhInfo[0].amount = '7356d5ced197b60e';
		expect(moneroTxHash(t)).not.toBe(
			'0323898c1e355ed3b1939a4ab617611d95bdf8f22777cdab44c6dfd4cc537d3e'
		);
		const u = JSON.parse(JSON.stringify(MAINNET));
		u.rctsig_prunable.CLSAGs[0].D = '00'.repeat(32);
		expect(moneroTxHash(u)).not.toBe(
			'0323898c1e355ed3b1939a4ab617611d95bdf8f22777cdab44c6dfd4cc537d3e'
		);
	});

	it("matches the PyPI-built synthetic transactions' hashes", () => {
		for (const v of V.vectors) expect(moneroTxHash(v.tx)).toBe(v.txid);
	});

	for (const name of [
		'integrated-primary+change',
		'subaddress+change',
		'two-outputs-same-primary+change'
	]) {
		it(`finds exactly what PyPI's scanner found: ${name}`, () => {
			const v = byName(name);
			const r = scanRawTxForAddress(v.tx, v.tx_key, keysOf(v.dest));
			expect(r).toMatchObject({ outputs: v.expect.outputs, amount: BigInt(v.expect.amount) });
			const py = Object.entries(v.pyscan as Record<string, [string, string]>);
			expect(py.map(([i]) => Number(i))).toEqual(v.expect.outputs);
			expect(py.reduce((s, [, [, amt]]) => s + BigInt(amt), 0n)).toBe(BigInt(v.expect.amount));
		});
	}

	it('returns the encrypted payment ID from the same extra bytes', () => {
		const v = byName('integrated-primary+change');
		expect(scanRawTxForAddress(v.tx, v.tx_key, keysOf(V.treasury.primary))).toMatchObject({
			encryptedPaymentIds: [v.expect.payment_id8]
		});
	});

	it('a wrong tx key, or another address, proves nothing', () => {
		const v = byName('subaddress+change');
		expect(
			scanRawTxForAddress(v.tx, byName('integrated-primary+change').tx_key, keysOf(v.dest))
		).toMatchObject({
			outputs: [],
			amount: 0n
		});
		expect(scanRawTxForAddress(v.tx, v.tx_key, keysOf(V.treasury.primary))).toMatchObject({
			outputs: [],
			amount: 0n
		});
	});

	it('refuses an amount that does not match the output commitment (a lying explorer)', () => {
		const v = byName('integrated-primary+change');
		const t = JSON.parse(JSON.stringify(v.tx));
		// flip one bit of the encrypted amount: decodes to another amount, commitment disagrees
		const e = t.rct_signatures.ecdhInfo[1].amount as string;
		t.rct_signatures.ecdhInfo[1].amount =
			(parseInt(e.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + e.slice(2);
		expect(scanRawTxForAddress(t, v.tx_key, keysOf(V.treasury.primary))).toEqual({
			error: 'commitment_mismatch'
		});
	});

	it('additional tx keys: the main key alone finds nothing (PyPI, with every pubkey, finds output 1)', () => {
		const v = byName('additional-keys');
		expect(scanRawTxForAddress(v.tx, v.tx_key, keysOf(v.dest))).toMatchObject({
			outputs: [],
			amount: 0n
		});
		expect(Object.keys(v.pyscan)).toEqual(['1']);
	});

	it('refuses malformed input without throwing', () => {
		expect(
			scanRawTxForAddress({}, byName('subaddress+change').tx_key, keysOf(V.treasury.primary))
		).toEqual({ error: 'malformed' });
		expect(
			scanRawTxForAddress(
				byName('subaddress+change').tx,
				'ff'.repeat(32),
				keysOf(V.treasury.primary)
			)
		).toEqual({ error: 'bad_key' });
		expect(
			scanRawTxForAddress(byName('subaddress+change').tx, 'zz', keysOf(V.treasury.primary))
		).toEqual({ error: 'bad_key' });
		expect(moneroTxHash({ version: 2 })).toBeNull();
	});
});
