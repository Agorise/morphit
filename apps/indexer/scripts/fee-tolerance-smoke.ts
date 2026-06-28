/**
 * fee-tolerance-smoke (cp372) — Model-A verification tolerance.
 *
 * The chain-pinned fee amount stays the enforced target (anti-fork),
 * but the verifier accepts a payment within FEE_PRICE_TOLERANCE
 * *below* it so a user paying the live-displayed amount isn't
 * rejected when crypto appreciated since the operator last re-pinned.
 * Overpayment is always fine (floor); only the lower bound relaxes.
 *
 * Money guard — three layers:
 *   1. helper math (minAcceptableSatoshis / minAcceptablePiconero)
 *   2. BTC behavioral: a real BitcoinExplorerFeeVerifier against a
 *      mocked explorer accepts ≥ min, rejects < min
 *   3. structural tamper: both verifiers must route through the
 *      tolerance helpers, never the raw `< claim.expectedAmount`
 *
 * Run: npx tsx --tsconfig ../../tsconfig.smoke.json scripts/fee-tolerance-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	minAcceptableSatoshis,
	minAcceptablePiconero,
	FEE_PRICE_TOLERANCE,
	FEE_FALLBACK
} from '@morphit/asset-registry';
import { BitcoinExplorerFeeVerifier } from '../src/indexer/fee/bitcoinExplorerVerifier.ts';
import type { FeeClaim } from '../src/indexer/fee/verifier.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FEE_ADDRESS = 'bc1qfeeaddrexample000000000000000000000000';
const VALID_TXID = 'a'.repeat(64);

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

function btcFetch(observedSats: number): typeof fetch {
	const txBody = {
		txid: VALID_TXID,
		vout: [{ value: observedSats, scriptpubkey_address: FEE_ADDRESS }],
		status: { confirmed: true, block_height: 800_000 }
	};
	return (async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (url.includes('/blocks/tip/height')) {
			return { ok: true, status: 200, text: async () => '800000' } as unknown as Response;
		}
		if (url.includes('/tx/')) {
			return { ok: true, status: 200, json: async () => txBody } as unknown as Response;
		}
		throw new Error(`unmocked URL ${url}`);
	}) as unknown as typeof fetch;
}

function btcVerifier(observedSats: number): BitcoinExplorerFeeVerifier {
	return new BitcoinExplorerFeeVerifier(
		{
			feeAddress: FEE_ADDRESS,
			explorerUrls: ['https://blockstream.info/api'],
			minConfirmations: 1,
			requestTimeoutMs: 5_000
		},
		btcFetch(observedSats)
	);
}
const claim = (expectedAmount: number): FeeClaim => ({
	feeMethod: 'btc',
	expectedAmount,
	externalTxId: VALID_TXID,
	permlink: 'order-01',
	signer: 'alice'
});

async function main(): Promise<void> {
	console.log('\n\u2500\u2500\u2500 fee-tolerance smoke (cp372, Model A) \u2500\u2500\u2500');

	// ── 1. helper math ──────────────────────────────────────────
	check('minAcceptableSatoshis(2500) === 2125 (floor 85%)', minAcceptableSatoshis(2500) === 2125);
	check('minAcceptableSatoshis(417 fallback) === 354', minAcceptableSatoshis(FEE_FALLBACK.satoshis) === 354);
	check('minAcceptableSatoshis(1) === 0 (floors below 1)', minAcceptableSatoshis(1) === 0);
	check('minAcceptableSatoshis(0) === 0 (guard)', minAcceptableSatoshis(0) === 0);
	check('minAcceptableSatoshis(-5) === 0 (guard)', minAcceptableSatoshis(-5) === 0);
	check('minAcceptableSatoshis(NaN) === 0 (guard)', minAcceptableSatoshis(NaN) === 0);
	check('minAcceptablePiconero(781250000n) === 664062500n', minAcceptablePiconero(781_250_000n) === 664_062_500n);
	check('minAcceptablePiconero(FEE_FALLBACK.piconero) === 664062500n', minAcceptablePiconero(FEE_FALLBACK.piconero) === 664_062_500n);
	check('minAcceptablePiconero(0n) === 0n (guard)', minAcceptablePiconero(0n) === 0n);
	check('minAcceptablePiconero(-5n) === 0n (guard)', minAcceptablePiconero(-5n) === 0n);
	// Tolerance band identity: min == expected*(1-tol) at the reference.
	check('satoshi band == round-trip of FEE_PRICE_TOLERANCE', minAcceptableSatoshis(2000) === Math.floor(2000 * (1 - FEE_PRICE_TOLERANCE)));

	// ── 2. BTC behavioral (real verifier + mocked explorer) ─────
	// expected 2500 → min 2125.
	{
		const r = await btcVerifier(2500).verify(claim(2500));
		check('btc: exact pinned amount (2500) → verified', r.kind === 'verified');
	}
	{
		const r = await btcVerifier(2125).verify(claim(2500));
		check('btc: exactly at min (2125) → verified', r.kind === 'verified');
	}
	{
		const r = await btcVerifier(2200).verify(claim(2500));
		check('btc: within tolerance (2200, ~12% under) → verified', r.kind === 'verified');
	}
	{
		const r = await btcVerifier(2124).verify(claim(2500));
		check('btc: one sat below min (2124) → rejected (underpaid)', r.kind === 'rejected');
	}
	{
		const r = await btcVerifier(2000).verify(claim(2500));
		check('btc: well below min (2000, 20% under) → rejected', r.kind === 'rejected');
	}
	{
		const r = await btcVerifier(3000).verify(claim(2500));
		check('btc: overpayment (3000) → verified (floor, no upper bound)', r.kind === 'verified');
	}

	// ── 3. structural tamper guards ─────────────────────────────
	const btcSrc = readFileSync(resolve(__dirname, '..', 'src', 'indexer', 'fee', 'bitcoinExplorerVerifier.ts'), 'utf-8');
	const xmrSrc = readFileSync(resolve(__dirname, '..', 'src', 'indexer', 'fee', 'moneroProofVerifier.ts'), 'utf-8');
	check('tamper: btc verifier routes through minAcceptableSatoshis', btcSrc.includes('minAcceptableSatoshis('));
	check('tamper: btc verifier no longer compares raw `observedSats < claim.expectedAmount`', !btcSrc.includes('observedSats < claim.expectedAmount'));
	check('tamper: xmr verifier routes through minAcceptablePiconero', xmrSrc.includes('minAcceptablePiconero('));
	check('tamper: xmr verifier no longer compares raw `observed < claim.expectedAmount`', !xmrSrc.includes('observed < claim.expectedAmount'));

	console.log('\u2500'.repeat(56));
	if (failed === 0) {
		console.log(`\u2713 all ${passed} fee-tolerance scenarios passed`);
	} else {
		console.log(`${passed} passed, ${failed} failed (${passed + failed} total)`);
		console.log('fee-tolerance-smoke FAILED');
		process.exit(1);
	}
}

void main();
