import { describe, it, expect } from 'vitest';
import { computePowerDownProgress } from './powerDownProgress';

// 1:1 vesting pool → 1 VESTS == 1 BP, keeps the BP assertions simple.
const FUND = '1000000.000 BLURT';
const SHARES = '1000000.000000 VESTS';
const scale = (vests: number) => String(vests * 1_000_000); // VESTS → raw int

describe('computePowerDownProgress (cp439)', () => {
	it('returns null for an idle account (zero rate, epoch sentinel)', () => {
		expect(
			computePowerDownProgress(
				{
					vesting_withdraw_rate: '0.000000 VESTS',
					next_vesting_withdrawal: '1970-01-01T00:00:00',
					to_withdraw: '0',
					withdrawn: '0'
				},
				FUND,
				SHARES
			)
		).toBeNull();
	});

	it('computes remaining BP, finish date, and installments for an active power-down', () => {
		// 4M VESTS total, 1M/week, one payout already taken → 3M left, 3 to go.
		const p = computePowerDownProgress(
			{
				vesting_withdraw_rate: '1000000.000000 VESTS',
				next_vesting_withdrawal: '2026-07-15T12:00:00',
				to_withdraw: scale(4_000_000),
				withdrawn: scale(1_000_000)
			},
			FUND,
			SHARES
		);
		expect(p).not.toBeNull();
		expect(p!.remainingBp).toBeCloseTo(3_000_000, 0);
		expect(p!.installmentsLeft).toBe(3);
		// finish = next + (3-1)*7d = 2026-07-15T12:00:00Z + 14 days
		expect(p!.finishIso).toBe('2026-07-29T12:00:00.000Z');
	});

	it('parses the Z-less chain timestamp as UTC (not local)', () => {
		const p = computePowerDownProgress(
			{
				vesting_withdraw_rate: '1000000.000000 VESTS',
				next_vesting_withdrawal: '2026-07-15T12:00:00', // no Z
				to_withdraw: scale(1_000_000),
				withdrawn: '0'
			},
			FUND,
			SHARES
		);
		expect(p!.finishIso).toBe('2026-07-15T12:00:00.000Z');
	});

	it('does not add a phantom week when the amount divides evenly', () => {
		// exactly 3 payouts remaining
		const p = computePowerDownProgress(
			{
				vesting_withdraw_rate: '1000000.000000 VESTS',
				next_vesting_withdrawal: '2026-07-15T00:00:00',
				to_withdraw: scale(3_000_000),
				withdrawn: '0'
			},
			FUND,
			SHARES
		);
		expect(p!.installmentsLeft).toBe(3);
	});

	it('final installment: remaining < rate → 1 payout, finish == next', () => {
		const p = computePowerDownProgress(
			{
				vesting_withdraw_rate: '1000000.000000 VESTS',
				next_vesting_withdrawal: '2026-07-15T00:00:00',
				to_withdraw: scale(1_000_000),
				withdrawn: scale(700_000)
			},
			FUND,
			SHARES
		);
		expect(p!.installmentsLeft).toBe(1);
		expect(p!.finishIso).toBe('2026-07-15T00:00:00.000Z');
		expect(p!.remainingBp).toBeCloseTo(300_000, 0);
	});

	it('returns null when nothing remains (fully withdrawn)', () => {
		expect(
			computePowerDownProgress(
				{
					vesting_withdraw_rate: '1000000.000000 VESTS',
					next_vesting_withdrawal: '2026-07-15T00:00:00',
					to_withdraw: scale(4_000_000),
					withdrawn: scale(4_000_000)
				},
				FUND,
				SHARES
			)
		).toBeNull();
	});

	it('accepts numeric (non-string) raw totals off the node', () => {
		const p = computePowerDownProgress(
			{
				vesting_withdraw_rate: '1000000.000000 VESTS',
				next_vesting_withdrawal: '2026-07-15T00:00:00',
				to_withdraw: 2_000_000_000_000, // number, not string
				withdrawn: 0
			},
			FUND,
			SHARES
		);
		expect(p!.installmentsLeft).toBe(2);
	});
});
