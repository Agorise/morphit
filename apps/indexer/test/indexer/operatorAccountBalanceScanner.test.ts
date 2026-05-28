/**
 * Tests for OperatorAccountBalanceScanner.
 *
 * Pure unit scope — mocks BlurtClient.getAccounts and captures
 * alerts via a sink array. No Database, no real RPC, no timers.
 *
 * Coverage:
 *   - opt-out (both thresholds 0 → no RPC call, no alerts)
 *   - downward-cross alert fires exactly once, hysteresis
 *     prevents duplicate alerts on subsequent scans
 *   - upward-cross RECOVERED alert fires once, re-arms the
 *     LOW_BALANCE alert for the next drain
 *   - SUSTAINED_RPC_FAILURE fires only after threshold of
 *     consecutive failures; success resets the counter
 *   - SHAPE_ERROR fires when balance string is unparseable
 *   - missing account → silent (no alert), error counted
 *   - partial configuration (only relay, not fees) works
 *   - maybeScan respects the intervalMs throttle
 */

import { describe, expect, it, vi } from 'vitest';
import type { BlurtClient, ChainAccount } from '$blurt/client';

import {
	OperatorAccountBalanceScanner,
	type OperatorAccountBalanceScanConfig,
	type OperatorBalanceAlert
} from '$indexer/operatorAccountBalanceScanner';

/** Minimal ChainAccount stub — only the fields the scanner reads. */
function acc(name: string, balance: string): ChainAccount {
	return {
		name,
		balance,
		posting: { weight_threshold: 1, account_auths: [], key_auths: [] },
		active: { weight_threshold: 1, account_auths: [], key_auths: [] },
		owner: { weight_threshold: 1, account_auths: [], key_auths: [] },
		memo_key: 'BLT1'
	};
}

function defaultConfig(
	overrides: Partial<OperatorAccountBalanceScanConfig> = {}
): OperatorAccountBalanceScanConfig {
	return {
		intervalMs: 60_000,
		accounts: [
			{ name: 'morphit-relay', thresholdBlurt: 100, role: 'relay' },
			{ name: 'morphit-fees', thresholdBlurt: 10, role: 'fees' }
		],
		failureAlertThreshold: 3,
		...overrides
	};
}

function makeFixture(
	initialResponse: ReadonlyMap<string, ChainAccount> | (() => never),
	config: OperatorAccountBalanceScanConfig = defaultConfig()
) {
	const alerts: OperatorBalanceAlert[] = [];
	const getAccountsSpy = vi.fn(
		async (names: readonly string[]): Promise<ReadonlyMap<string, ChainAccount>> => {
			if (typeof initialResponse === 'function') return initialResponse();
			const filtered = new Map<string, ChainAccount>();
			for (const n of names) {
				const a = initialResponse.get(n);
				if (a) filtered.set(n, a);
			}
			return filtered;
		}
	);
	const blurt = { getAccounts: getAccountsSpy } as unknown as BlurtClient;
	const scanner = new OperatorAccountBalanceScanner(blurt, config, (a) => alerts.push(a));
	return { scanner, alerts, getAccountsSpy };
}

describe('OperatorAccountBalanceScanner', () => {
	it('opt-out: no accounts with threshold>0 → no RPC call, no alerts', async () => {
		const fx = makeFixture(new Map(), {
			intervalMs: 60_000,
			accounts: [
				{ name: 'morphit-relay', thresholdBlurt: 0, role: 'relay' },
				{ name: 'morphit-fees', thresholdBlurt: 0, role: 'fees' }
			],
			failureAlertThreshold: 3
		});
		const result = await fx.scanner.scanOnce();
		expect(result).toEqual({
			accountsChecked: 0,
			alertsFired: 0,
			recoveriesFired: 0,
			errors: 0
		});
		expect(fx.getAccountsSpy).not.toHaveBeenCalled();
		expect(fx.alerts).toEqual([]);
	});

	it('above threshold on first scan: no alert, state records above', async () => {
		const fx = makeFixture(
			new Map([
				['morphit-relay', acc('morphit-relay', '500.000 BLURT')],
				['morphit-fees', acc('morphit-fees', '50.000 BLURT')]
			])
		);
		const result = await fx.scanner.scanOnce();
		expect(result.alertsFired).toBe(0);
		expect(result.recoveriesFired).toBe(0);
		expect(fx.alerts).toEqual([]);
		const state = fx.scanner.getCurrentState();
		expect(state.get('morphit-relay')).toEqual({
			below: false,
			lastObservedBlurt: 500
		});
		expect(state.get('morphit-fees')).toEqual({
			below: false,
			lastObservedBlurt: 50
		});
	});

	it('below threshold on first scan: LOW_BALANCE alert fires', async () => {
		const fx = makeFixture(
			new Map([
				['morphit-relay', acc('morphit-relay', '50.000 BLURT')],
				['morphit-fees', acc('morphit-fees', '50.000 BLURT')]
			])
		);
		const result = await fx.scanner.scanOnce();
		expect(result.alertsFired).toBe(1);
		expect(fx.alerts).toHaveLength(1);
		const a = fx.alerts[0]!;
		expect(a.kind).toBe('LOW_BALANCE');
		if (a.kind !== 'LOW_BALANCE') throw new Error('narrowing');
		expect(a.account).toBe('morphit-relay');
		expect(a.role).toBe('relay');
		expect(a.balanceBlurt).toBe(50);
		expect(a.thresholdBlurt).toBe(100);
	});

	it('hysteresis: second scan still below → NO duplicate alert', async () => {
		const fx = makeFixture(
			new Map([
				['morphit-relay', acc('morphit-relay', '50.000 BLURT')],
				['morphit-fees', acc('morphit-fees', '50.000 BLURT')]
			])
		);
		await fx.scanner.scanOnce();
		await fx.scanner.scanOnce();
		expect(fx.alerts).toHaveLength(1);
		expect(fx.alerts[0]!.kind).toBe('LOW_BALANCE');
	});

	it('recovery: balance goes back above → RECOVERED alert, re-arms LOW_BALANCE', async () => {
		let currentBalance = '50.000 BLURT';
		const getAccountsSpy = vi.fn(async (names: readonly string[]) => {
			const m = new Map<string, ChainAccount>();
			for (const n of names) {
				if (n === 'morphit-relay') {
					m.set(n, acc(n, currentBalance));
				} else if (n === 'morphit-fees') {
					m.set(n, acc(n, '50.000 BLURT'));
				}
			}
			return m;
		});
		const blurt = { getAccounts: getAccountsSpy } as unknown as BlurtClient;
		const alerts: OperatorBalanceAlert[] = [];
		const scanner = new OperatorAccountBalanceScanner(blurt, defaultConfig(), (a) =>
			alerts.push(a)
		);

		// Below
		await scanner.scanOnce();
		expect(alerts.map((a) => a.kind)).toEqual(['LOW_BALANCE']);

		// Recover
		currentBalance = '500.000 BLURT';
		await scanner.scanOnce();
		expect(alerts.map((a) => a.kind)).toEqual(['LOW_BALANCE', 'RECOVERED']);

		// Still above — no new alert
		await scanner.scanOnce();
		expect(alerts.map((a) => a.kind)).toEqual(['LOW_BALANCE', 'RECOVERED']);

		// Drain again — LOW_BALANCE fires a second time (re-armed)
		currentBalance = '25.000 BLURT';
		await scanner.scanOnce();
		expect(alerts.map((a) => a.kind)).toEqual(['LOW_BALANCE', 'RECOVERED', 'LOW_BALANCE']);
	});

	it('RPC failures: SUSTAINED_RPC_FAILURE fires after threshold, success resets', async () => {
		let mode: 'fail' | 'ok' = 'fail';
		const error = new Error('chain RPC unreachable');
		const getAccountsSpy = vi.fn(async (names: readonly string[]) => {
			if (mode === 'fail') throw error;
			const m = new Map<string, ChainAccount>();
			for (const n of names) m.set(n, acc(n, '500.000 BLURT'));
			return m;
		});
		const blurt = { getAccounts: getAccountsSpy } as unknown as BlurtClient;
		const alerts: OperatorBalanceAlert[] = [];
		const scanner = new OperatorAccountBalanceScanner(
			blurt,
			defaultConfig({ failureAlertThreshold: 3 }),
			(a) => alerts.push(a)
		);

		// Two failures — below threshold, no alert yet
		await scanner.scanOnce();
		await scanner.scanOnce();
		expect(alerts).toHaveLength(0);

		// Third failure — alert fires
		await scanner.scanOnce();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.kind).toBe('SUSTAINED_RPC_FAILURE');
		const a = alerts[0]!;
		if (a.kind !== 'SUSTAINED_RPC_FAILURE') throw new Error('narrowing');
		expect(a.consecutiveFailures).toBe(3);
		expect(a.lastError).toBe('chain RPC unreachable');

		// Fourth failure — alert fires again (threshold already met;
		// current implementation fires each scan-cycle while sustained)
		await scanner.scanOnce();
		expect(alerts).toHaveLength(2);

		// Success — failure counter resets
		mode = 'ok';
		await scanner.scanOnce();
		// No new alert on first success
		expect(alerts).toHaveLength(2);

		// Fail again — must accumulate from 1, not from 5
		mode = 'fail';
		await scanner.scanOnce();
		expect(alerts).toHaveLength(2); // 1 consecutive again — below threshold
	});

	it('SHAPE_ERROR: unparseable balance string triggers alert', async () => {
		const fx = makeFixture(
			new Map([
				['morphit-relay', acc('morphit-relay', 'not a balance')],
				['morphit-fees', acc('morphit-fees', '50.000 BLURT')]
			])
		);
		const result = await fx.scanner.scanOnce();
		expect(result.errors).toBe(1);
		expect(fx.alerts.some((a) => a.kind === 'SHAPE_ERROR')).toBe(true);
		const err = fx.alerts.find((a) => a.kind === 'SHAPE_ERROR')!;
		if (err.kind !== 'SHAPE_ERROR') throw new Error('narrowing');
		expect(err.account).toBe('morphit-relay');
		expect(err.rawBalance).toBe('not a balance');
	});

	it('missing account in response: silent, errors counted', async () => {
		const fx = makeFixture(
			new Map([
				// morphit-relay deliberately omitted to simulate a typo
				// or nonexistent account
				['morphit-fees', acc('morphit-fees', '50.000 BLURT')]
			])
		);
		const result = await fx.scanner.scanOnce();
		expect(result.errors).toBe(1);
		// No alert for the missing account — just a log-level warning
		// which this test doesn't observe.
		expect(fx.alerts).toEqual([]);
	});

	it('partial configuration: only relay configured, fees threshold=0 → only relay checked', async () => {
		const fx = makeFixture(new Map([['morphit-relay', acc('morphit-relay', '50.000 BLURT')]]), {
			intervalMs: 60_000,
			accounts: [
				{ name: 'morphit-relay', thresholdBlurt: 100, role: 'relay' },
				{ name: 'morphit-fees', thresholdBlurt: 0, role: 'fees' }
			],
			failureAlertThreshold: 3
		});
		const result = await fx.scanner.scanOnce();
		expect(result.accountsChecked).toBe(1);
		expect(fx.getAccountsSpy).toHaveBeenCalledWith(['morphit-relay'], { userFacing: false });
		expect(fx.alerts).toHaveLength(1);
		expect(fx.alerts[0]!.kind).toBe('LOW_BALANCE');
	});

	it('maybeScan respects intervalMs throttle', async () => {
		const fx = makeFixture(
			new Map([
				['morphit-relay', acc('morphit-relay', '500.000 BLURT')],
				['morphit-fees', acc('morphit-fees', '50.000 BLURT')]
			]),
			defaultConfig({ intervalMs: 60_000 })
		);
		await fx.scanner.maybeScan();
		await fx.scanner.maybeScan();
		await fx.scanner.maybeScan();
		// Only one actual scan should have fired in quick succession.
		expect(fx.getAccountsSpy).toHaveBeenCalledTimes(1);
	});
});
