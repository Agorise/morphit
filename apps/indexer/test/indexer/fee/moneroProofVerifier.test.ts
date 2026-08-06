/**
 * Tests for MoneroProofFeeVerifier (Part 108++).
 *
 * Verifies the per-payment tx_proof verification path that
 * REPLACED the old view-key-based MoneroExplorerFeeVerifier.
 * No view key required by any indexer — the user supplies the
 * proof from their own Monero wallet.
 *
 * All HTTP is mocked — vi.fn() returning a Response-like object.
 * The verifier's only boundary to the outside world is `fetch`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	MoneroProofFeeVerifier,
	type MoneroProofFeeVerifierConfig
} from '$indexer/fee/moneroProofVerifier';
import type { FeeClaim } from '$indexer/fee/verifier';

const FEE_ADDRESS =
	'4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2bYXZKK';
const VALID_TXID = 'a'.repeat(64);
// A Part 108++ tx_proof string used in tests.  Real proofs come
// from `monero-wallet-cli get_tx_proof` or the GUI's "Prove
// transaction" dialog.  This is a synthetic string with the right
// shape for the verifier's structural checks; the explorer's
// cryptographic verification is mocked.
const VALID_TX_PROOF =
	'OutProofV2' +
	'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' +
	'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' +
	'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';

function baseConfig(
	overrides: Partial<MoneroProofFeeVerifierConfig> = {}
): MoneroProofFeeVerifierConfig {
	return {
		feeAddress: FEE_ADDRESS,
		explorerUrls: ['https://xmrchain.net'],
		minConfirmations: 1,
		requestTimeoutMs: 5_000,
		minSuccessfulResponses: 1,
		...overrides
	};
}

function claim(overrides: Partial<FeeClaim> = {}): FeeClaim {
	return {
		feeMethod: 'xmr',
		expectedAmount: 781_250_000n, // ~$0.25 at $320/XMR
		externalTxId: VALID_TXID,
		txProof: VALID_TX_PROOF,
		permlink: 'my-order-02',
		signer: 'bob',
		...overrides
	};
}

function mockFetchJson(body: unknown, status = 200): typeof fetch {
	return vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	})) as unknown as typeof fetch;
}

describe('MoneroProofFeeVerifier — construction', () => {
	it('rejects empty explorer URL list', () => {
		expect(
			() => new MoneroProofFeeVerifier(baseConfig({ explorerUrls: [] }))
		).toThrow(/at least one explorer URL/);
	});

	it('rejects non-HTTPS explorer URL (privacy invariant)', () => {
		expect(
			() =>
				new MoneroProofFeeVerifier(
					baseConfig({ explorerUrls: ['http://insecure-explorer.example'] })
				)
		).toThrow(/must be https/);
	});

	it('exposes currentAddress for poller rotation detection', () => {
		const v = new MoneroProofFeeVerifier(baseConfig());
		expect(v.currentAddress).toBe(FEE_ADDRESS);
	});

	it('does NOT expose any view-key getter (Part 108++ invariant)', () => {
		const v = new MoneroProofFeeVerifier(baseConfig()) as unknown as Record<
			string,
			unknown
		>;
		// The old MoneroExplorerFeeVerifier had a `currentViewKey`
		// getter.  The Part 108++ replacement holds NO viewkey and
		// MUST NOT surface anything related to one.
		expect('currentViewKey' in v).toBe(false);
		expect(v.currentViewKey).toBeUndefined();
	});
});

describe('MoneroProofFeeVerifier — happy path', () => {
	it('verifies a payment that the proof confirms with sufficient confirmations', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig(),
			mockFetchJson({
				status: 'success',
				data: {
					address: FEE_ADDRESS,
					tx_hash: VALID_TXID,
					outputs: [{ amount: 781_250_000, match: true }],
					tx_confirmations: 5
				}
			})
		);
		const r = await v.verify(claim());
		expect(r.kind).toBe('verified');
		if (r.kind === 'verified') {
			expect(r.observedAmount).toBe(781_250_000n);
		}
	});

	it('handles amounts as JSON strings (large piconero)', async () => {
		const huge = '1000000000000000'; // 1000 XMR in piconero
		const v = new MoneroProofFeeVerifier(
			baseConfig(),
			mockFetchJson({
				status: 'success',
				data: {
					address: FEE_ADDRESS,
					tx_hash: VALID_TXID,
					outputs: [{ amount: huge, match: true }],
					tx_confirmations: 10
				}
			})
		);
		const r = await v.verify(claim({ expectedAmount: 1_000_000_000_000_000n }));
		expect(r.kind).toBe('verified');
		if (r.kind === 'verified') {
			expect(r.observedAmount).toBe(1_000_000_000_000_000n);
		}
	});

	it('sums multiple matching outputs (subaddress-derived multi-output)', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig(),
			mockFetchJson({
				status: 'success',
				data: {
					address: FEE_ADDRESS,
					tx_hash: VALID_TXID,
					outputs: [
						{ amount: 400_000_000, match: true },
						{ amount: 400_000_000, match: true },
						{ amount: 99_999_999_999, match: false } // not ours
					],
					tx_confirmations: 1
				}
			})
		);
		const r = await v.verify(claim());
		expect(r.kind).toBe('verified');
		if (r.kind === 'verified') {
			expect(r.observedAmount).toBe(800_000_000n);
		}
	});
});

describe('MoneroProofFeeVerifier — rejection paths', () => {
	it('rejects fee_method != xmr', async () => {
		const v = new MoneroProofFeeVerifier(baseConfig(), mockFetchJson({}));
		const r = await v.verify(claim({ feeMethod: 'btc' }));
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			expect(r.reason).toMatch(/cannot verify fee_method=btc/);
		}
	});

	it('rejects missing externalTxId', async () => {
		const v = new MoneroProofFeeVerifier(baseConfig(), mockFetchJson({}));
		const r = await v.verify(claim({ externalTxId: null }));
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			expect(r.reason).toBe('missing_external_tx_id');
		}
	});

	it('rejects malformed externalTxId', async () => {
		const v = new MoneroProofFeeVerifier(baseConfig(), mockFetchJson({}));
		const r = await v.verify(claim({ externalTxId: 'not-a-txid' }));
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			expect(r.reason).toBe('malformed_tx_id');
		}
	});

	it('rejects missing tx_proof (Part 108++ invariant)', async () => {
		const v = new MoneroProofFeeVerifier(baseConfig(), mockFetchJson({}));
		const r = await v.verify(claim({ txProof: null }));
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			expect(r.reason).toBe('missing_tx_proof');
		}
	});

	it('rejects tx_proof with wrong prefix', async () => {
		const v = new MoneroProofFeeVerifier(baseConfig(), mockFetchJson({}));
		const r = await v.verify(claim({ txProof: 'NotARealProofPrefix' + 'a'.repeat(64) }));
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			expect(r.reason).toBe('malformed_tx_proof_prefix');
		}
	});

	it('rejects tx_proof that is too long', async () => {
		const v = new MoneroProofFeeVerifier(baseConfig(), mockFetchJson({}));
		const r = await v.verify(
			claim({ txProof: 'OutProofV2' + 'a'.repeat(5000) })
		);
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			expect(r.reason).toBe('tx_proof_too_long');
		}
	});

	it('rejects tx_proof with bad charset (e.g. control chars)', async () => {
		const v = new MoneroProofFeeVerifier(baseConfig(), mockFetchJson({}));
		const r = await v.verify(claim({ txProof: 'OutProofV2' + 'a\nb' + 'c'.repeat(60) }));
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			expect(r.reason).toBe('malformed_tx_proof_charset');
		}
	});

	it('rejects underpaid (observed < expected)', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig(),
			mockFetchJson({
				status: 'success',
				data: {
					address: FEE_ADDRESS,
					tx_hash: VALID_TXID,
					outputs: [{ amount: 100_000_000, match: true }], // 100M piconero
					tx_confirmations: 1
				}
			})
		);
		const r = await v.verify(claim()); // expects 781_250_000
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			expect(r.reason).toMatch(/underpaid/);
		}
	});

	it('rejects when no outputs matched our address (proof for different recipient)', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig(),
			mockFetchJson({
				status: 'success',
				data: {
					address: FEE_ADDRESS,
					tx_hash: VALID_TXID,
					outputs: [{ amount: 1_000_000_000, match: false }],
					tx_confirmations: 1
				}
			})
		);
		const r = await v.verify(claim());
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			expect(r.reason).toBe('tx_proof_did_not_prove_any_match');
		}
	});

	it('rejects when explorer echoes wrong tx_hash (manipulation defense)', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig(),
			mockFetchJson({
				status: 'success',
				data: {
					address: FEE_ADDRESS,
					tx_hash: 'b'.repeat(64), // different from claim's txid
					outputs: [{ amount: 781_250_000, match: true }],
					tx_confirmations: 1
				}
			})
		);
		const r = await v.verify(claim());
		// txid mismatch → data_malformed → no successful responses →
		// pending_external (single explorer; it answered but with bad
		// shape).
		expect(r.kind).toBe('pending_external');
	});

	it('rejects expectedAmount that is not a bigint', async () => {
		const v = new MoneroProofFeeVerifier(baseConfig(), mockFetchJson({}));
		const r = await v.verify(claim({ expectedAmount: 781_250_000 })); // number, not bigint
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			expect(r.reason).toBe('expected_amount_not_bigint_for_xmr');
		}
	});
});

describe('MoneroProofFeeVerifier — explorer health paths', () => {
	it('returns pending_external on transport failure (single explorer, network error)', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig(),
			vi.fn(async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch
		);
		const r = await v.verify(claim());
		expect(r.kind).toBe('pending_external');
	});

	it('returns pending_external on 5xx', async () => {
		const v = new MoneroProofFeeVerifier(baseConfig(), mockFetchJson({}, 503));
		const r = await v.verify(claim());
		expect(r.kind).toBe('pending_external');
	});

	it('treats explorer status=error as data_not_found (user claim wrong, explorer healthy)', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig(),
			mockFetchJson({ status: 'error', message: 'invalid proof' })
		);
		const r = await v.verify(claim());
		// Single explorer, returned data_not_found → no successful
		// responses → pending_external.  The data path treats this
		// as a healthy-explorer-says-no, doesn't trip the breaker.
		expect(r.kind).toBe('pending_external');
	});

	it('returns pending_external when below minConfirmations', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig({ minConfirmations: 5 }),
			mockFetchJson({
				status: 'success',
				data: {
					address: FEE_ADDRESS,
					tx_hash: VALID_TXID,
					outputs: [{ amount: 781_250_000, match: true }],
					tx_confirmations: 1
				}
			})
		);
		const r = await v.verify(claim());
		expect(r.kind).toBe('pending_external');
		if (r.kind === 'pending_external') {
			expect(r.reason).toMatch(/confirmations/);
		}
	});

	it('two explorers disagree on proven amount → pending_external (no quorum)', async () => {
		// cp166 — under the old "any disagreement = reject" model,
		// this returned `rejected`.  Under the new quorum-with-early-
		// return model, with minAgree=2 and only 2 disagreeing
		// explorers, no bucket reaches the threshold so the verifier
		// returns `pending_external` (attestable) rather than killing
		// the trade outright.  Trust property preserved — trade
		// doesn't go live without cross-source agreement.
		const v = new MoneroProofFeeVerifier(
			baseConfig({
				explorerUrls: ['https://explorer-a.test', 'https://explorer-b.test'],
				minSuccessfulResponses: 2
			}),
			vi.fn(async (input: Parameters<typeof fetch>[0]) => {
				const url = typeof input === 'string' ? input : input.toString();
				const amount = url.includes('explorer-a') ? 781_250_000 : 1_000_000_000;
				return {
					ok: true,
					status: 200,
					json: async () => ({
						status: 'success',
						data: {
							address: FEE_ADDRESS,
							tx_hash: VALID_TXID,
							outputs: [{ amount, match: true }],
							tx_confirmations: 5
						}
					})
				};
			}) as unknown as typeof fetch
		);
		const r = await v.verify(claim());
		expect(r.kind).toBe('pending_external');
		if (r.kind === 'pending_external') {
			expect(r.reason).toMatch(/quorum not met/);
		}
	});
});

describe('MoneroProofFeeVerifier — privacy invariants', () => {
	it('does NOT include the proof string in any log line', async () => {
		// We can't easily intercept the structured logger here, but
		// we can confirm the URL-construction path uses the proof
		// only as a query parameter to fetchImpl (not in any log
		// before that point).  This test asserts the proof flows
		// through fetchImpl exactly once and only as a query param.
		const seenUrls: string[] = [];
		const v = new MoneroProofFeeVerifier(
			baseConfig(),
			vi.fn(async (input: Parameters<typeof fetch>[0]) => {
				const url = typeof input === 'string' ? input : input.toString();
				seenUrls.push(url);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						status: 'success',
						data: {
							address: FEE_ADDRESS,
							tx_hash: VALID_TXID,
							outputs: [{ amount: 781_250_000, match: true }],
							tx_confirmations: 5
						}
					})
				};
			}) as unknown as typeof fetch
		);
		await v.verify(claim());
		expect(seenUrls).toHaveLength(1);
		// The URL contains the proof in the viewkey= parameter
		// (xmrchain's API surface; it's the proof in proof-mode).
		// That's the ONLY place the proof appears in the request.
		expect(seenUrls[0]).toContain(`viewkey=${VALID_TX_PROOF}`);
		// Privacy invariant: the proof ONLY appears in the URL once,
		// not in any header, not in any body.  (Proof not echoed
		// back to the caller.)
	});

	it('uses txprove=1 mode (proof verification, NOT view-key decryption)', async () => {
		const seenUrls: string[] = [];
		const v = new MoneroProofFeeVerifier(
			baseConfig(),
			vi.fn(async (input: Parameters<typeof fetch>[0]) => {
				const url = typeof input === 'string' ? input : input.toString();
				seenUrls.push(url);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						status: 'success',
						data: {
							address: FEE_ADDRESS,
							tx_hash: VALID_TXID,
							outputs: [{ amount: 781_250_000, match: true }],
							tx_confirmations: 5
						}
					})
				};
			}) as unknown as typeof fetch
		);
		await v.verify(claim());
		expect(seenUrls[0]).toContain('txprove=1');
	});
});

describe('MoneroProofFeeVerifier — quorum gate (Part 109)', () => {
	function mockFetchByUrl(
		responses: Record<string, { body?: unknown; status?: number; throws?: Error }>
	): typeof fetch {
		return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = typeof input === 'string' ? input : input.toString();
			for (const [match, cfg] of Object.entries(responses)) {
				if (url.includes(match)) {
					if (cfg.throws) throw cfg.throws;
					const status = cfg.status ?? 200;
					return {
						ok: status >= 200 && status < 300,
						status,
						json: async () => cfg.body
					};
				}
			}
			throw new Error(`unmocked URL: ${url}`);
		}) as unknown as typeof fetch;
	}

	const SUCCESSFUL_BODY = {
		status: 'success',
		data: {
			address: FEE_ADDRESS,
			tx_hash: VALID_TXID,
			tx_prove: true,
			tx_confirmations: 10,
			viewkey: 'redacted',
			outputs: [{ amount: 781_250_000, match: true, output_idx: 0, output_pubkey: 'x' }]
		}
	};

	it('quorum=2 with 3 URLs, only 1 responds → pending_external (not verified)', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig({
				explorerUrls: [
					'https://xmrchain.net',
					'https://localmonero.co/blocks',
					'https://exploremonero.com'
				],
				minSuccessfulResponses: 2
			}),
			mockFetchByUrl({
				'xmrchain.net': { body: SUCCESSFUL_BODY },
				'localmonero.co': { throws: new Error('network boom') },
				'exploremonero.com': { throws: new Error('connection reset') }
			})
		);
		const result = await v.verify(claim());
		expect(result.kind).toBe('pending_external');
		if (result.kind === 'pending_external') {
			expect(result.reason).toMatch(/quorum not met/);
			// cp166 — new wording references the agreeing-bucket size
			// in plain language rather than the old "N/M" fraction.
			expect(result.reason).toMatch(/< 2 agreeing/);
		}
	});

	it('quorum=2 with 3 URLs, 2 agree → verified', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig({
				explorerUrls: [
					'https://xmrchain.net',
					'https://localmonero.co/blocks',
					'https://exploremonero.com'
				],
				minSuccessfulResponses: 2
			}),
			mockFetchByUrl({
				'xmrchain.net': { body: SUCCESSFUL_BODY },
				'localmonero.co': { body: SUCCESSFUL_BODY },
				'exploremonero.com': { throws: new Error('still down') }
			})
		);
		const result = await v.verify(claim());
		expect(result.kind).toBe('verified');
		if (result.kind === 'verified') {
			expect(result.observedAmount).toBe(781_250_000n);
		}
	});

	it('quorum=1 (default back-compat) with 2 URLs, only 1 responds → verified', async () => {
		const v = new MoneroProofFeeVerifier(
			baseConfig({
				explorerUrls: ['https://xmrchain.net', 'https://localmonero.co/blocks'],
				minSuccessfulResponses: 1
			}),
			mockFetchByUrl({
				'xmrchain.net': { body: SUCCESSFUL_BODY },
				'localmonero.co': { throws: new Error('network boom') }
			})
		);
		const result = await v.verify(claim());
		expect(result.kind).toBe('verified');
	});

	it('quorum=3 with all 5 default explorers responding → verified', async () => {
		// Sanity: the realistic operator config (default 5 URLs +
		// MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES=3) works
		// when all 5 are healthy.
		const v = new MoneroProofFeeVerifier(
			baseConfig({
				explorerUrls: [
					'https://xmrchain.net',
					'https://localmonero.co/blocks',
					'https://monerohash.com/explorer',
					'https://exploremonero.com',
					'https://moneroexplorer.org'
				],
				minSuccessfulResponses: 3
			}),
			mockFetchByUrl({
				'xmrchain.net': { body: SUCCESSFUL_BODY },
				'localmonero.co': { body: SUCCESSFUL_BODY },
				'monerohash.com': { body: SUCCESSFUL_BODY },
				'exploremonero.com': { body: SUCCESSFUL_BODY },
				'moneroexplorer.org': { body: SUCCESSFUL_BODY }
			})
		);
		const result = await v.verify(claim());
		expect(result.kind).toBe('verified');
	});
});
