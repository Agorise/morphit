/**
 * Tests for BitcoinExplorerFeeVerifier.
 *
 * All HTTP is mocked — vi.fn() returning a Response-like object.
 * The verifier's only boundary to the outside world is `fetch`;
 * the rest is pure computation.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	BitcoinExplorerFeeVerifier,
	type BitcoinExplorerFeeVerifierConfig
} from '$indexer/fee/bitcoinExplorerVerifier';
import type { FeeClaim } from '$indexer/fee/verifier';

const FEE_ADDRESS = 'bc1qfeeaddrexample000000000000000000000000';
const VALID_TXID = 'a'.repeat(64);

function baseConfig(
	overrides: Partial<BitcoinExplorerFeeVerifierConfig> = {}
): BitcoinExplorerFeeVerifierConfig {
	return {
		feeAddress: FEE_ADDRESS,
		explorerUrls: ['https://blockstream.info/api', 'https://mempool.space/api'],
		minConfirmations: 1,
		requestTimeoutMs: 5_000,
		minSuccessfulResponses: 1,
		...overrides
	};
}

function claim(overrides: Partial<FeeClaim> = {}): FeeClaim {
	return {
		feeMethod: 'btc',
		expectedAmount: 2_500, // sats
		externalTxId: VALID_TXID,
		permlink: 'my-order-01',
		signer: 'alice',
		txProof: null,
		...overrides
	};
}

/** Shape a mock fetch that returns a canned JSON response. */
function mockFetchJson(body: unknown, status = 200): typeof fetch {
	return vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	})) as unknown as typeof fetch;
}

/** Mock fetch that returns different responses per URL substring. */
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

describe('BitcoinExplorerFeeVerifier — happy paths', () => {
	it('single explorer, payment matches expected → verified', async () => {
		const fetchImpl = mockFetchJson({
			txid: VALID_TXID,
			vout: [
				{ value: 2_500, scriptpubkey_address: FEE_ADDRESS },
				{ value: 100_000, scriptpubkey_address: 'bc1qsomeoneelse' }
			],
			status: { confirmed: true, block_height: 800_000 }
		});
		const verifier = new BitcoinExplorerFeeVerifier(
			baseConfig({ explorerUrls: ['https://blockstream.info/api'] }),
			fetchImpl
		);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('verified');
		if (result.kind === 'verified') {
			expect(result.observedAmount).toBe(2_500);
		}
	});

	it('two explorers agree → verified', async () => {
		const body = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true, block_height: 800_000 }
		};
		const fetchImpl = mockFetchJson(body);
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('verified');
	});

	it('overpayment accepted (observed > expected)', async () => {
		const fetchImpl = mockFetchJson({
			txid: VALID_TXID,
			vout: [{ value: 10_000, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true }
		});
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim({ expectedAmount: 2_500 }));
		expect(result.kind).toBe('verified');
		if (result.kind === 'verified') {
			expect(result.observedAmount).toBe(10_000);
		}
	});

	it('output split across multiple vout entries → sums correctly', async () => {
		const fetchImpl = mockFetchJson({
			txid: VALID_TXID,
			vout: [
				{ value: 1_000, scriptpubkey_address: FEE_ADDRESS },
				{ value: 50_000, scriptpubkey_address: 'bc1qchange' },
				{ value: 1_500, scriptpubkey_address: FEE_ADDRESS }
			],
			status: { confirmed: true }
		});
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim({ expectedAmount: 2_500 }));
		expect(result.kind).toBe('verified');
		if (result.kind === 'verified') {
			expect(result.observedAmount).toBe(2_500);
		}
	});
});

describe('BitcoinExplorerFeeVerifier — rejection paths', () => {
	it('underpaid → rejected with amount detail', async () => {
		const fetchImpl = mockFetchJson({
			txid: VALID_TXID,
			vout: [{ value: 1_000, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true }
		});
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim({ expectedAmount: 2_500 }));
		expect(result.kind).toBe('rejected');
		if (result.kind === 'rejected') {
			expect(result.reason).toContain('underpaid');
			expect(result.reason).toContain('1000');
			expect(result.reason).toContain('2500');
		}
	});

	it('wrong fee_method → rejected immediately', async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim({ feeMethod: 'xmr' }));
		expect(result.kind).toBe('rejected');
		if (result.kind === 'rejected') {
			expect(result.reason).toContain('xmr');
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('missing txid → rejected without fetch', async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim({ externalTxId: null }));
		expect(result.kind).toBe('rejected');
		if (result.kind === 'rejected') {
			expect(result.reason).toBe('missing_external_tx_id');
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('malformed txid (not hex) → rejected without fetch', async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim({ externalTxId: 'not-a-real-txid' }));
		expect(result.kind).toBe('rejected');
		if (result.kind === 'rejected') {
			expect(result.reason).toBe('malformed_tx_id');
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('bigint expectedAmount for btc → rejected (type mismatch)', async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim({ expectedAmount: 2_500n }));
		expect(result.kind).toBe('rejected');
		if (result.kind === 'rejected') {
			expect(result.reason).toContain('not_number');
		}
	});
});

describe('BitcoinExplorerFeeVerifier — explorer disagreement', () => {
	it('two explorers report different amounts → rejected (suspicious)', async () => {
		const fetchImpl = mockFetchByUrl({
			blockstream: {
				body: {
					txid: VALID_TXID,
					vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
					status: { confirmed: true }
				}
			},
			'mempool.space': {
				body: {
					txid: VALID_TXID,
					vout: [{ value: 1_000, scriptpubkey_address: FEE_ADDRESS }],
					status: { confirmed: true }
				}
			}
		});
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('rejected');
		if (result.kind === 'rejected') {
			expect(result.reason).toContain('disagreement');
		}
	});
});

describe('BitcoinExplorerFeeVerifier — pending_external paths', () => {
	it('all explorers fail → pending_external', async () => {
		const fetchImpl = mockFetchByUrl({
			blockstream: { throws: new Error('ECONNREFUSED') },
			'mempool.space': { throws: new Error('ETIMEDOUT') }
		});
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('pending_external');
		if (result.kind === 'pending_external') {
			// Reason wording was tightened — now reports total queried,
			// in-cooldown, and "none returned usable data" instead of
			// the older "N explorers failed".
			expect(result.reason).toContain('none returned usable data');
		}
	});

	it('one explorer fails, other succeeds → verified (graceful degradation)', async () => {
		// The verifier uses the structured `logger('btc-verify')`,
		// which writes to process.stderr/stdout via the textSink.
		// console.log is NOT touched.  Spy on process.stderr.write
		// instead — the partial-failure path logs at warn level.
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			const fetchImpl = mockFetchByUrl({
				blockstream: { throws: new Error('ECONNREFUSED') },
				'mempool.space': {
					body: {
						txid: VALID_TXID,
						vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
						status: { confirmed: true }
					}
				}
			});
			const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
			const result = await verifier.verify(claim());
			expect(result.kind).toBe('verified');
			// Verifier should log the partial failure for operator
			// observability.
			expect(stderrSpy).toHaveBeenCalled();
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it('tx unconfirmed → pending_external', async () => {
		const fetchImpl = mockFetchJson({
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: false }
		});
		const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('pending_external');
		if (result.kind === 'pending_external') {
			expect(result.reason).toContain('not yet confirmed');
		}
	});

	it('explorer returns 404 → counted as failure', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const fetchImpl = mockFetchByUrl({
				blockstream: { status: 404 },
				'mempool.space': { status: 404 }
			});
			const verifier = new BitcoinExplorerFeeVerifier(baseConfig(), fetchImpl);
			const result = await verifier.verify(claim());
			expect(result.kind).toBe('pending_external');
		} finally {
			warnSpy.mockRestore();
		}
	});

	it('explorer returns malformed JSON shape → counted as failure', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const fetchImpl = mockFetchJson({
				/* missing txid, vout, status */
				something: 'else'
			});
			const verifier = new BitcoinExplorerFeeVerifier(
				baseConfig({ explorerUrls: ['https://blockstream.info/api'] }),
				fetchImpl
			);
			const result = await verifier.verify(claim());
			expect(result.kind).toBe('pending_external');
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe('BitcoinExplorerFeeVerifier — construction', () => {
	it('refuses to construct with empty explorerUrls', () => {
		expect(() => new BitcoinExplorerFeeVerifier(baseConfig({ explorerUrls: [] }))).toThrow(
			/at least one/
		);
	});
});

describe('BitcoinExplorerFeeVerifier — quorum gate (Part 109)', () => {
	it('quorum=2 with 3 URLs, only 1 responds → pending_external (not verified)', async () => {
		const okBody = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true, block_height: 800_000 }
		};
		// blockstream responds OK; mempool throws; explorerC throws.
		const fetchImpl = mockFetchByUrl({
			'blockstream.info': { body: okBody },
			'mempool.space': { throws: new Error('network boom') },
			'explorerC.example': { throws: new Error('connection reset') }
		});
		const verifier = new BitcoinExplorerFeeVerifier(
			baseConfig({
				explorerUrls: [
					'https://blockstream.info/api',
					'https://mempool.space/api',
					'https://explorerC.example/api'
				],
				minSuccessfulResponses: 2
			}),
			fetchImpl
		);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('pending_external');
		if (result.kind === 'pending_external') {
			expect(result.reason).toMatch(/quorum not met/);
			expect(result.reason).toMatch(/1\/2/);
		}
	});

	it('quorum=2 with 3 URLs, 2 agree → verified', async () => {
		const okBody = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true, block_height: 800_000 }
		};
		const fetchImpl = mockFetchByUrl({
			'blockstream.info': { body: okBody },
			'mempool.space': { body: okBody },
			'explorerC.example': { throws: new Error('still down') }
		});
		const verifier = new BitcoinExplorerFeeVerifier(
			baseConfig({
				explorerUrls: [
					'https://blockstream.info/api',
					'https://mempool.space/api',
					'https://explorerC.example/api'
				],
				minSuccessfulResponses: 2
			}),
			fetchImpl
		);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('verified');
		if (result.kind === 'verified') {
			expect(result.observedAmount).toBe(2_500);
		}
	});

	it('quorum=1 (default back-compat) with 2 URLs, only 1 responds → verified', async () => {
		// Confirms the pre-Part-109 behavior is preserved when an
		// operator leaves the env at its default of 1.
		const okBody = {
			txid: VALID_TXID,
			vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
			status: { confirmed: true, block_height: 800_000 }
		};
		const fetchImpl = mockFetchByUrl({
			'blockstream.info': { body: okBody },
			'mempool.space': { throws: new Error('network boom') }
		});
		const verifier = new BitcoinExplorerFeeVerifier(
			baseConfig({ minSuccessfulResponses: 1 }),
			fetchImpl
		);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('verified');
	});
});

/**
 * cp78-D20: tip-height depth-check coverage.
 *
 * cp77 audit (Lesson #5) flagged that no test exercises the
 * `minConfirmations > 1` path in production code at
 * `apps/indexer/src/indexer/fee/bitcoinExplorerVerifier.ts:266+`,
 * which calls `fetchTipHeight()` which in turn calls
 * `res.text()` (line 446).  The existing `mockFetchJson()` /
 * `mockFetchByUrl()` helpers don't provide `.text()` because all
 * other tests use `minConfirmations: 1`, which short-circuits at
 * line 266 before the `.text()` call.
 *
 * This block exercises the path explicitly and proves the mock
 * contract production needs — closing the coverage gap surfaced
 * in cp77 audit.
 */
describe('BitcoinExplorerFeeVerifier — minConfirmations > 1 depth check', () => {
	/** Mock that responds to /tx with JSON and /blocks/tip/height with
	 *  text — matching the production `Response` field-consumption
	 *  contract.  fetchTipHeight calls `res.text()` at line 446;
	 *  fetchTx calls `res.json()`. */
	function mockFetchTxAndTip(
		txBody: unknown,
		tipHeightText: string,
		tipStatus = 200
	): typeof fetch {
		return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.includes('/blocks/tip/height')) {
				return {
					ok: tipStatus >= 200 && tipStatus < 300,
					status: tipStatus,
					text: async () => tipHeightText
				};
			}
			// Default to /tx response shape.
			return {
				ok: true,
				status: 200,
				json: async () => txBody
			};
		}) as unknown as typeof fetch;
	}

	it('depth ≥ minConfirmations → verified', async () => {
		// tx mined at block 800_000; tip at 800_005; depth = 5+1-0 = 6.
		// minConfirmations: 3, so 6 ≥ 3 → verified.
		const fetchImpl = mockFetchTxAndTip(
			{
				txid: VALID_TXID,
				vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
				status: { confirmed: true, block_height: 800_000 }
			},
			'800005'
		);
		const verifier = new BitcoinExplorerFeeVerifier(
			baseConfig({ explorerUrls: ['https://blockstream.info/api'], minConfirmations: 3 }),
			fetchImpl
		);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('verified');
	});

	it('depth < minConfirmations → pending_external (waits for more confirmations)', async () => {
		// tx mined at block 800_000; tip at 800_001; depth = 1+1-0 = 2.
		// minConfirmations: 3, so 2 < 3 → pending_external.
		const fetchImpl = mockFetchTxAndTip(
			{
				txid: VALID_TXID,
				vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
				status: { confirmed: true, block_height: 800_000 }
			},
			'800001'
		);
		const verifier = new BitcoinExplorerFeeVerifier(
			baseConfig({ explorerUrls: ['https://blockstream.info/api'], minConfirmations: 3 }),
			fetchImpl
		);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('pending_external');
		if (result.kind === 'pending_external') {
			expect(result.reason).toMatch(/depth/);
		}
	});

	it('tip-height endpoint 5xx → pending_external (retry later)', async () => {
		const fetchImpl = mockFetchTxAndTip(
			{
				txid: VALID_TXID,
				vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
				status: { confirmed: true, block_height: 800_000 }
			},
			'',
			503
		);
		const verifier = new BitcoinExplorerFeeVerifier(
			baseConfig({ explorerUrls: ['https://blockstream.info/api'], minConfirmations: 3 }),
			fetchImpl
		);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('pending_external');
		if (result.kind === 'pending_external') {
			expect(result.reason).toMatch(/tip-height/);
		}
	});

	it('tip-height endpoint returns malformed text → pending_external', async () => {
		const fetchImpl = mockFetchTxAndTip(
			{
				txid: VALID_TXID,
				vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
				status: { confirmed: true, block_height: 800_000 }
			},
			'not-a-number'
		);
		const verifier = new BitcoinExplorerFeeVerifier(
			baseConfig({ explorerUrls: ['https://blockstream.info/api'], minConfirmations: 3 }),
			fetchImpl
		);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('pending_external');
		if (result.kind === 'pending_external') {
			expect(result.reason).toMatch(/tip-height/);
		}
	});

	it('confirmed tx missing block_height → pending_external (degenerate explorer response)', async () => {
		// Same tip-height endpoint shape, but the tx has no block_height
		// even though confirmed:true.  Production line 272 catches this.
		const fetchImpl = mockFetchTxAndTip(
			{
				txid: VALID_TXID,
				vout: [{ value: 2_500, scriptpubkey_address: FEE_ADDRESS }],
				status: { confirmed: true } // no block_height
			},
			'800005'
		);
		const verifier = new BitcoinExplorerFeeVerifier(
			baseConfig({ explorerUrls: ['https://blockstream.info/api'], minConfirmations: 3 }),
			fetchImpl
		);
		const result = await verifier.verify(claim());
		expect(result.kind).toBe('pending_external');
		if (result.kind === 'pending_external') {
			expect(result.reason).toMatch(/block_height/);
		}
	});
});
