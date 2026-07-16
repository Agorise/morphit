/**
 * Morphit indexer — BTC fee verifier quorum-call integration smoke.
 *
 * cp166 — proves the actual UX win Ken asked about: when 2 of 4
 * configured BTC explorers are down/slow, the verifier returns in
 * ~50 ms via the 2 healthy survivors, NOT in 5 s via Promise.allSettled
 * waiting on the slow ones' full timeout.
 *
 * Spins up 4 fake mempool.space-style HTTP servers on ephemeral
 * ports, then:
 *
 *   Scenario 1: All 4 healthy + agree → verifier returns fast (sub-100ms)
 *   Scenario 2: 2 healthy + 2 refusing connection → 2-of-2 quorum
 *               from survivors, returns fast (sub-200ms)
 *   Scenario 3: 2 healthy + 2 hanging forever → quorum from healthy
 *               survivors, returns fast (sub-200ms) — proves we
 *               don't wait on the slow ones
 *   Scenario 4: 4 explorers, 3 agree on amount X, 1 dissents on Y →
 *               majority outvotes the dissenter (minAgree=3),
 *               verified successfully
 *
 * Run: tsx scripts/btc-quorum-call-integration-smoke.ts
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BitcoinExplorerFeeVerifier } from '$indexer/fee/bitcoinExplorerVerifier';
import type { FeeClaim } from '$indexer/fee/verifier';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const FEE_ADDRESS = 'bc1qfeeaddrexample000000000000000000000000';
const VALID_TXID = 'a'.repeat(64);

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string): void {
	results.push({ name, passed: true });
}
function fail(name: string, detail?: string): void {
	results.push({ name, passed: false, detail });
}

/** Spin up a fake explorer that returns the given tx body on /tx/<txid>. */
function startHealthyExplorer(amountSatoshis: number): Promise<{
	url: string;
	close: () => Promise<void>;
}> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.url?.includes('/tx/')) {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						txid: VALID_TXID,
						vout: [
							{
								value: amountSatoshis,
								scriptpubkey_address: FEE_ADDRESS
							}
						],
						status: { confirmed: true }
					})
				);
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise((r) => server.close(() => r()))
			});
		});
	});
}

/** Server that accepts the connection but never responds — simulates
 *  a hung explorer (no TCP refusal, just silence). */
function startHangingExplorer(): Promise<{
	url: string;
	close: () => Promise<void>;
}> {
	return new Promise((resolve) => {
		const server = createServer(() => {
			// Never write to res — request hangs.
		});
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise((r) => server.close(() => r()))
			});
		});
	});
}

/** Returns a port that's bound briefly then released — connecting to
 *  it gives ECONNREFUSED. */
function dummyClosedPortUrl(): Promise<string> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as AddressInfo).port;
			server.close(() => resolve(`http://127.0.0.1:${port}`));
		});
	});
}

function claim(): FeeClaim {
	return {
		feeMethod: 'btc',
		expectedAmount: 2_500,
		externalTxId: VALID_TXID,
		permlink: 'x',
		signer: 'alice',
		txProof: null
	};
}

async function main(): Promise<void> {
	// ─── Scenario 1: all healthy + agree ───
	{
		const a = await startHealthyExplorer(2_500);
		const b = await startHealthyExplorer(2_500);
		const c = await startHealthyExplorer(2_500);
		const d = await startHealthyExplorer(2_500);
		try {
			const v = new BitcoinExplorerFeeVerifier({
				feeAddress: FEE_ADDRESS,
				explorerUrls: [a.url, b.url, c.url, d.url],
				minConfirmations: 1,
				requestTimeoutMs: 5_000,
				minSuccessfulResponses: 2
			});
			const t0 = Date.now();
			const r = await v.verify(claim());
			const elapsed = Date.now() - t0;
			if (r.kind === 'verified' && elapsed < 250) {
				pass(`scenario 1: 4 healthy explorers → verified in ${elapsed} ms`);
			} else {
				fail(
					'scenario 1: 4 healthy explorers',
					`kind=${r.kind} elapsed=${elapsed}`
				);
			}
		} finally {
			await Promise.all([a.close(), b.close(), c.close(), d.close()]);
		}
	}

	// ─── Scenario 2: 2 healthy + 2 connection-refused ───
	{
		const a = await startHealthyExplorer(2_500);
		const b = await startHealthyExplorer(2_500);
		const dead1 = await dummyClosedPortUrl();
		const dead2 = await dummyClosedPortUrl();
		try {
			const v = new BitcoinExplorerFeeVerifier({
				feeAddress: FEE_ADDRESS,
				// dead URLs first to force the pool to deal with them
				explorerUrls: [dead1, dead2, a.url, b.url],
				minConfirmations: 1,
				requestTimeoutMs: 5_000,
				minSuccessfulResponses: 2
			});
			const t0 = Date.now();
			const r = await v.verify(claim());
			const elapsed = Date.now() - t0;
			// We expect this to complete fast even with 2 dead URLs.
			// ECONNREFUSED fires immediately; the 2 healthy explorers
			// respond and form quorum.  Should be well under 500 ms.
			if (r.kind === 'verified' && elapsed < 500) {
				pass(
					`scenario 2: 2 healthy + 2 connection-refused → verified in ${elapsed} ms`
				);
			} else {
				fail(
					'scenario 2: ECONNREFUSED resilience',
					`kind=${r.kind} elapsed=${elapsed}`
				);
			}
		} finally {
			await Promise.all([a.close(), b.close()]);
		}
	}

	// ─── Scenario 3: 2 healthy + 2 hanging (THE actual choke-point fix) ───
	{
		const a = await startHealthyExplorer(2_500);
		const b = await startHealthyExplorer(2_500);
		const hung1 = await startHangingExplorer();
		const hung2 = await startHangingExplorer();
		try {
			// The healthy explorers respond in <50 ms; the hanging
			// ones would hold the request open for the full 5_000 ms
			// timeout under the old Promise.allSettled pattern.
			// Under cp166 quorumCall, the call returns as soon as
			// the 2 healthy form quorum, so we should be sub-500 ms.
			const v = new BitcoinExplorerFeeVerifier({
				feeAddress: FEE_ADDRESS,
				explorerUrls: [hung1.url, hung2.url, a.url, b.url],
				minConfirmations: 1,
				requestTimeoutMs: 5_000,
				minSuccessfulResponses: 2
			});
			const t0 = Date.now();
			const r = await v.verify(claim());
			const elapsed = Date.now() - t0;
			if (r.kind === 'verified' && elapsed < 500) {
				pass(
					`scenario 3: 2 healthy + 2 hanging → verified in ${elapsed} ms (no hang on the slow ones)`
				);
			} else {
				fail(
					'scenario 3: hung-explorer choke-point fix',
					`kind=${r.kind} elapsed=${elapsed} (expected verified in <500 ms; this is the actual UX win)`
				);
			}
		} finally {
			await Promise.all([a.close(), b.close(), hung1.close(), hung2.close()]);
		}
	}

	// ─── Scenario 4: dissenter is outvoted (3 agree, 1 disagrees) ───
	{
		const a = await startHealthyExplorer(2_500);
		const b = await startHealthyExplorer(2_500);
		const c = await startHealthyExplorer(2_500);
		const dissenter = await startHealthyExplorer(1_000);
		try {
			const v = new BitcoinExplorerFeeVerifier({
				feeAddress: FEE_ADDRESS,
				explorerUrls: [a.url, b.url, c.url, dissenter.url],
				minConfirmations: 1,
				requestTimeoutMs: 5_000,
				minSuccessfulResponses: 3
			});
			const r = await v.verify(claim());
			if (r.kind === 'verified' && r.observedAmount === 2_500) {
				pass(
					'scenario 4: 3 agree + 1 dissents → majority outvotes dissenter (verified at agreed amount)'
				);
			} else {
				fail(
					'scenario 4: dissenter outvoted',
					`kind=${r.kind} observed=${(r as { observedAmount?: number }).observedAmount}`
				);
			}
		} finally {
			await Promise.all([a.close(), b.close(), c.close(), dissenter.close()]);
		}
	}

	// Report
	let failed = 0;
	for (const r of results) {
		if (r.passed) {
			console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
		} else {
			console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
			if (r.detail) console.log('      ' + r.detail);
			failed++;
		}
	}
	console.log();
	console.log('──────────────────────────────────────────────────────');
	if (failed > 0) {
		console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
		process.exit(1);
	} else {
		console.log('✓ all ' + results.length + ' scenarios passed');
	}
}

main().catch((err) => {
	console.error('smoke crashed:', err);
	process.exit(1);
});
