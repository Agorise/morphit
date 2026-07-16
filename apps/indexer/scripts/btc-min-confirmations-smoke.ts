/**
 * Morphit indexer — BTC explorer min-confirmations depth smoke.
 *
 * Audit BATCH19C-btc-depth: the minConfirmations config knob was
 * dead before this work; it now drives an active depth check via
 * a /blocks/tip/height fetch when minConfirmations > 1.
 *
 * Scenarios:
 *   1. minConfirmations=1, confirmed=true → verified (no tip fetch)
 *   2. minConfirmations=3, confirmed at tip-2 → depth=3, verified
 *   3. minConfirmations=3, confirmed at tip → depth=1, pending_external
 *   4. minConfirmations=3, confirmed but no block_height → pending
 *   5. minConfirmations=3, tip fetch transport-fails → pending
 *   6. minConfirmations=3, tip fetch returns garbage → pending
 *   7. minConfirmations=6, depth exactly at threshold → verified
 *
 * No unmocked network — all fetch is stubbed.
 */

import { BitcoinExplorerFeeVerifier } from '../src/indexer/fee/bitcoinExplorerVerifier.ts';
import type { FeeClaim } from '../src/indexer/fee/verifier.ts';

const FEE_ADDRESS = 'bc1qfeeaddrexample000000000000000000000000';
const VALID_TXID = 'a'.repeat(64);

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, why = ''): void {
	if (cond) {
		passed++;
		return;
	}
	failures.push(`✗ ${name}${why ? ': ' + why : ''}`);
}

function makeFetch(txBody: unknown, tipBody?: string, tipFails?: boolean): typeof fetch {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (url.includes('/blocks/tip/height')) {
			if (tipFails) {
				return {
					ok: false,
					status: 503,
					text: async () => 'Service Unavailable'
				} as unknown as Response;
			}
			return {
				ok: true,
				status: 200,
				text: async () => tipBody ?? '0'
			} as unknown as Response;
		}
		if (url.includes('/tx/')) {
			return {
				ok: true,
				status: 200,
				json: async () => txBody
			} as unknown as Response;
		}
		throw new Error(`smoke: unmocked URL ${url}`);
	}) as unknown as typeof fetch;
}

function baseClaim(): FeeClaim {
	return {
		feeMethod: 'btc',
		expectedAmount: 2_500,
		externalTxId: VALID_TXID,
		// cp474 — REQUIRED by FeeClaim. Omitted here the field was `undefined`,
		// not `null`; moneroProofVerifier gates on `txProof === null` and would
		// fall through to `.length` on undefined. BTC claims carry no proof.
		txProof: null,
		permlink: 'my-order-01',
		signer: 'alice'
	};
}

async function run(): Promise<void> {
	// ─── Scenario 1: minConfirmations=1, confirmed → verified ──
	{
		const txBody = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true, block_height: 800_000 }
		};
		const v = new BitcoinExplorerFeeVerifier(
			{
				feeAddress: FEE_ADDRESS,
				explorerUrls: ['https://blockstream.info/api'],
				minConfirmations: 1,
				requestTimeoutMs: 5_000,
				// cp474 — Part 109 quorum gate; required by the config type.
				minSuccessfulResponses: 1
			},
			makeFetch(txBody)
		);
		const r = await v.verify(baseClaim());
		ok('minConf=1 + confirmed → verified', r.kind === 'verified', `got ${r.kind}`);
	}

	// ─── Scenario 2: minConf=3, depth=3 → verified ─────────────
	{
		const txBody = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true, block_height: 800_000 }
		};
		const v = new BitcoinExplorerFeeVerifier(
			{
				feeAddress: FEE_ADDRESS,
				explorerUrls: ['https://blockstream.info/api'],
				minConfirmations: 3,
				requestTimeoutMs: 5_000,
				// cp474 — Part 109 quorum gate; required by the config type.
				minSuccessfulResponses: 1
			},
			// tip = 800_002 → depth = 800_002 + 1 - 800_000 = 3
			makeFetch(txBody, '800002')
		);
		const r = await v.verify(baseClaim());
		ok('minConf=3 + depth=3 → verified', r.kind === 'verified', `got ${r.kind}`);
	}

	// ─── Scenario 3: minConf=3, depth=1 → pending ──────────────
	{
		const txBody = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true, block_height: 800_000 }
		};
		const v = new BitcoinExplorerFeeVerifier(
			{
				feeAddress: FEE_ADDRESS,
				explorerUrls: ['https://blockstream.info/api'],
				minConfirmations: 3,
				requestTimeoutMs: 5_000,
				// cp474 — Part 109 quorum gate; required by the config type.
				minSuccessfulResponses: 1
			},
			// tip = 800_000 → depth = 1
			makeFetch(txBody, '800000')
		);
		const r = await v.verify(baseClaim());
		ok('minConf=3 + depth=1 → pending_external', r.kind === 'pending_external', `got ${r.kind}`);
	}

	// ─── Scenario 4: confirmed without block_height → pending ──
	{
		const txBody = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true } // no block_height
		};
		const v = new BitcoinExplorerFeeVerifier(
			{
				feeAddress: FEE_ADDRESS,
				explorerUrls: ['https://blockstream.info/api'],
				minConfirmations: 3,
				requestTimeoutMs: 5_000,
				// cp474 — Part 109 quorum gate; required by the config type.
				minSuccessfulResponses: 1
			},
			makeFetch(txBody, '800002')
		);
		const r = await v.verify(baseClaim());
		ok(
			'minConf=3 + missing block_height → pending_external',
			r.kind === 'pending_external',
			`got ${r.kind}`
		);
	}

	// ─── Scenario 5: tip fetch fails → pending ─────────────────
	{
		const txBody = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true, block_height: 800_000 }
		};
		const v = new BitcoinExplorerFeeVerifier(
			{
				feeAddress: FEE_ADDRESS,
				explorerUrls: ['https://blockstream.info/api'],
				minConfirmations: 3,
				requestTimeoutMs: 5_000,
				// cp474 — Part 109 quorum gate; required by the config type.
				minSuccessfulResponses: 1
			},
			makeFetch(txBody, undefined, true)
		);
		const r = await v.verify(baseClaim());
		ok(
			'minConf=3 + tip transport_failure → pending_external',
			r.kind === 'pending_external',
			`got ${r.kind}`
		);
	}

	// ─── Scenario 6: tip body is garbage → pending ─────────────
	{
		const txBody = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true, block_height: 800_000 }
		};
		const v = new BitcoinExplorerFeeVerifier(
			{
				feeAddress: FEE_ADDRESS,
				explorerUrls: ['https://blockstream.info/api'],
				minConfirmations: 3,
				requestTimeoutMs: 5_000,
				// cp474 — Part 109 quorum gate; required by the config type.
				minSuccessfulResponses: 1
			},
			makeFetch(txBody, 'NOT-AN-INTEGER')
		);
		const r = await v.verify(baseClaim());
		ok(
			'minConf=3 + tip data_malformed → pending_external',
			r.kind === 'pending_external',
			`got ${r.kind}`
		);
	}

	// ─── Scenario 7: depth exactly at minConf → verified ───────
	{
		const txBody = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true, block_height: 800_000 }
		};
		const v = new BitcoinExplorerFeeVerifier(
			{
				feeAddress: FEE_ADDRESS,
				explorerUrls: ['https://blockstream.info/api'],
				minConfirmations: 6,
				requestTimeoutMs: 5_000,
				// cp474 — Part 109 quorum gate; required by the config type.
				minSuccessfulResponses: 1
			},
			// tip = 800_005 → depth = 6
			makeFetch(txBody, '800005')
		);
		const r = await v.verify(baseClaim());
		ok('minConf=6 + depth=6 (exact) → verified', r.kind === 'verified', `got ${r.kind}`);
	}

	if (failures.length > 0) {
		for (const f of failures) console.log(f);
		console.log(`\n✗ ${failures.length} failure(s), ${passed} pass`);
		process.exit(1);
	}
	console.log(`✓ all ${passed} scenarios passed`);
}

void run();
