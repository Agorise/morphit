/**
 * Tests for the ACT auto-minter (ADR-0010 §5).
 *
 * The decision logic (planActMint) is a pure function — exhaustively
 * tested here across every branch and boundary. The ActAutoMinter class
 * is tested with a hand-rolled BlurtClient stub so we verify the
 * read → plan → mint → log wiring (including the insufficient-BLURT skip
 * and the disabled no-op) without touching a real chain.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	planActMint,
	parseBlurtBalance,
	ActAutoMinter,
	type ActAutoMintConfig
} from '../src/blurt/actAutoMinter.ts';
import type { BlurtClient } from '../src/blurt/client.ts';

describe('parseBlurtBalance', () => {
	it('parses a well-formed liquid balance', () => {
		expect(parseBlurtBalance('423.000 BLURT')).toBe(423);
		expect(parseBlurtBalance('0.000 BLURT')).toBe(0);
		expect(parseBlurtBalance('1234.567 BLURT')).toBe(1234.567);
	});

	it('trims surrounding whitespace', () => {
		expect(parseBlurtBalance('  50.000 BLURT  ')).toBe(50);
	});

	it('returns null for the relay "unknown" sentinel and malformed input', () => {
		expect(parseBlurtBalance('unknown')).toBeNull();
		expect(parseBlurtBalance('')).toBeNull();
		expect(parseBlurtBalance('100 BLT')).toBeNull();
		expect(parseBlurtBalance('100.000 STEEM')).toBeNull();
		expect(parseBlurtBalance('not a number BLURT')).toBeNull();
	});
});

describe('planActMint', () => {
	// Common healthy-funds knobs; individual tests override what matters.
	const base = {
		target: 25,
		lowWater: 10,
		maxPerCycle: 25,
		liquidBlurt: 100_000,
		feeBlurt: 100,
		reserve: 50
	};

	it('does nothing when pending is at or above the low-water mark', () => {
		expect(planActMint({ ...base, pending: 10 }).reason).toBe('above_low_water');
		expect(planActMint({ ...base, pending: 10 }).mintCount).toBe(0);
		expect(planActMint({ ...base, pending: 25 }).reason).toBe('above_low_water');
		expect(planActMint({ ...base, pending: 11 }).mintCount).toBe(0);
	});

	it('mints the full gap back to target when funds allow', () => {
		const p = planActMint({ ...base, pending: 5 });
		// desired = min(25 - 5, 25) = 20; affordable is huge.
		expect(p.reason).toBe('minted');
		expect(p.desired).toBe(20);
		expect(p.mintCount).toBe(20);
	});

	it('caps a single cycle at maxPerCycle even when far below target', () => {
		const p = planActMint({
			...base,
			pending: 0,
			target: 100,
			lowWater: 50,
			maxPerCycle: 25
		});
		expect(p.desired).toBe(25); // min(100 - 0, 25)
		expect(p.mintCount).toBe(25);
		expect(p.reason).toBe('minted');
	});

	it('mints only what is affordable above the reserve (partial)', () => {
		const p = planActMint({
			...base,
			pending: 5,
			liquidBlurt: 1_050, // spendable above reserve = 1000
			feeBlurt: 100 // affordable = floor(1000 / 100) = 10
		});
		expect(p.desired).toBe(20);
		expect(p.affordable).toBe(10);
		expect(p.mintCount).toBe(10);
		expect(p.reason).toBe('partial_insufficient_blurt');
	});

	it('mints nothing when it cannot afford even one ACT above the reserve', () => {
		const p = planActMint({
			...base,
			pending: 5,
			liquidBlurt: 100, // spendable = 100 - 50 = 50 < feeBlurt
			feeBlurt: 100
		});
		expect(p.mintCount).toBe(0);
		expect(p.affordable).toBe(0);
		expect(p.reason).toBe('insufficient_blurt');
		expect(p.desired).toBe(20); // still reports what it wanted
	});

	it('never dips into the reserve (balance exactly at reserve)', () => {
		const p = planActMint({
			...base,
			pending: 5,
			liquidBlurt: 50, // spendable = 0
			feeBlurt: 100
		});
		expect(p.mintCount).toBe(0);
		expect(p.reason).toBe('insufficient_blurt');
	});

	it('spends exactly down to the reserve, never below', () => {
		const p = planActMint({
			...base,
			pending: 8, // desired = min(25 - 8, 25) = 17
			liquidBlurt: 350, // spendable = 300 → affordable = 3
			feeBlurt: 100,
			reserve: 50
		});
		expect(p.affordable).toBe(3);
		expect(p.mintCount).toBe(3);
		expect(p.reason).toBe('partial_insufficient_blurt');
		// Post-mint liquid would be 350 - 3*100 = 50 == reserve (never below).
	});

	it('treats a zero fee as unaffordable rather than dividing by zero', () => {
		const p = planActMint({ ...base, pending: 5, feeBlurt: 0 });
		expect(p.affordable).toBe(0);
		expect(p.mintCount).toBe(0);
		expect(p.reason).toBe('insufficient_blurt');
	});

	it('handles pending just one below the low-water mark', () => {
		const p = planActMint({ ...base, pending: 9 }); // desired = 25 - 9 = 16
		expect(p.desired).toBe(16);
		expect(p.mintCount).toBe(16);
		expect(p.reason).toBe('minted');
	});
});

/** Minimal BlurtClient stub exposing only what ActAutoMinter.runCycle
 *  calls. Cast through unknown — we deliberately implement a subset. */
function stubClient(opts: {
	balance: string;
	pending: number;
	fee?: string;
	mintImpl?: () => Promise<{ id: string }>;
}): { client: BlurtClient; mint: ReturnType<typeof vi.fn> } {
	const mint = vi.fn(
		opts.mintImpl ?? (async () => ({ id: 'trx-test', block_num: 1, trx_num: 0, expired: false }))
	);
	const client = {
		getAccount: async () => ({
			name: 'morphit-relay',
			balance: opts.balance,
			pending_claimed_accounts: opts.pending
		}),
		getChainProperties: async () => ({ account_creation_fee: opts.fee ?? '100.000 BLURT' }),
		broadcastClaimAccount: mint
	} as unknown as BlurtClient;
	return { client, mint };
}

const cfg = (over: Partial<ActAutoMintConfig> = {}): ActAutoMintConfig => ({
	enabled: true,
	targetActs: 25,
	lowWaterActs: 10,
	intervalMs: 3_600_000,
	maxPerCycle: 25,
	minBlurtReserve: 50,
	...over
});

describe('ActAutoMinter.runCycle', () => {
	it('mints the gap when below low-water with ample BLURT', async () => {
		const { client, mint } = stubClient({ balance: '100000.000 BLURT', pending: 5 });
		const m = new ActAutoMinter(client, 'morphit-relay', 'WIF', 100, cfg());
		await m.runCycle();
		// desired = 25 - 5 = 20
		expect(mint).toHaveBeenCalledTimes(20);
		expect(mint).toHaveBeenCalledWith({
			creator: 'morphit-relay',
			creatorActiveWif: 'WIF',
			feeBlurt: 100
		});
	});

	it('does not mint when the buffer is healthy', async () => {
		const { client, mint } = stubClient({ balance: '100000.000 BLURT', pending: 20 });
		const m = new ActAutoMinter(client, 'morphit-relay', 'WIF', 100, cfg());
		await m.runCycle();
		expect(mint).not.toHaveBeenCalled();
	});

	it('does not mint when BLURT is below the reserve, even if ACTs are low', async () => {
		const { client, mint } = stubClient({ balance: '100.000 BLURT', pending: 2 });
		const m = new ActAutoMinter(client, 'morphit-relay', 'WIF', 100, cfg());
		await m.runCycle();
		expect(mint).not.toHaveBeenCalled();
	});

	it('uses the live chain fee over the fallback', async () => {
		const { client, mint } = stubClient({
			balance: '100000.000 BLURT',
			pending: 5,
			fee: '120.000 BLURT'
		});
		const m = new ActAutoMinter(client, 'morphit-relay', 'WIF', 100, cfg());
		await m.runCycle();
		// desired = 25 - 5 = 20, all affordable; every call uses the live fee.
		expect(mint).toHaveBeenCalledTimes(20);
		expect(mint).toHaveBeenCalledWith(expect.objectContaining({ feeBlurt: 120 }));
	});

	it('stops the batch on the first mint failure (recoverable next cycle)', async () => {
		let calls = 0;
		const { client, mint } = stubClient({
			balance: '100000.000 BLURT',
			pending: 5,
			mintImpl: async () => {
				calls++;
				if (calls === 3) throw new Error('chain rejected');
				return { id: `trx-${calls}` };
			}
		});
		const m = new ActAutoMinter(client, 'morphit-relay', 'WIF', 100, cfg());
		await m.runCycle();
		// Tries 1, 2, 3 → 3 throws → loop breaks. No further attempts.
		expect(mint).toHaveBeenCalledTimes(3);
	});

	it('is a no-op when disabled (start does not mint)', async () => {
		const { client, mint } = stubClient({ balance: '100000.000 BLURT', pending: 0 });
		const m = new ActAutoMinter(client, 'morphit-relay', 'WIF', 100, cfg({ enabled: false }));
		m.start();
		// give any stray async a tick
		await Promise.resolve();
		expect(mint).not.toHaveBeenCalled();
		m.close();
	});
});
