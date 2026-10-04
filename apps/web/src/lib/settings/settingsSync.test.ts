// @vitest-environment jsdom
/**
 * The settings mirror never publishes settings it has not read: a
 * failed read of the on-chain blob leaves this device's settings as they are
 * and blocks broadcasts until a read succeeds (retried), instead of resetting
 * them to defaults and publishing those for every device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

const sent: { hidden: string[] }[] = [];
let settingsReply: () => unknown = () => ({ ok: false, code: 'timeout', message: 'timeout' });
vi.mock('$stores/identity', async () => {
	const { writable } = await import('svelte/store');
	return {
		identity: writable({ state: 'unlocked', live: { posting: { privateKey: new Uint8Array(32) } } })
	};
});
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'alice' }));
vi.mock('$lib/indexer/client', () => ({ getUserSettings: async () => settingsReply() }));
vi.mock('$lib/settings/settingsCrypto', () => ({
	decryptSettingsState: async (_k: unknown, _a: unknown, enc: string) => JSON.parse(enc)
}));
vi.mock('$blurt/ops/settings', () => ({
	broadcastSettings: async (_live: unknown, state: { hidden: string[] }) => {
		sent.push(state);
		return { block_num: 1, trx_id: 'x' };
	}
}));

import { get } from 'svelte/store';
import { initSettingsSync } from './settingsSync';
import { clearAllHidden, hideAccount, hiddenAccounts } from '$lib/utils/hiddenAccounts';
import { setPreference } from '$stores/userPreferences';

beforeEach(() => {
	sent.length = 0;
	vi.useFakeTimers();
	clearAllHidden();
	hideAccount('scammer1');
	hideAccount('scammer2');
});
afterEach(() => vi.useRealTimers());

describe('settingsSync', () => {
	it('a failed read keeps local settings and publishes nothing', async () => {
		settingsReply = () => ({ ok: false, code: 'timeout', message: 'timeout' });
		const stop = initSettingsSync();
		await vi.advanceTimersByTimeAsync(100);
		expect([...get(hiddenAccounts)].sort()).toEqual(['scammer1', 'scammer2']);
		setPreference('fiat', 'EUR');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sent).toEqual([]);
		stop();
	});

	it('the read is retried; once it succeeds the restored settings are what gets published', async () => {
		let calls = 0;
		settingsReply = () => {
			calls++;
			return calls < 2
				? { ok: false, code: 'timeout', message: 'timeout' }
				: {
						ok: true,
						data: { enc: JSON.stringify({ hidden: ['scammer1', 'scammer2', 'spammer3'] }) }
					};
		};
		const stop = initSettingsSync();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(calls).toBeGreaterThanOrEqual(2);
		expect([...get(hiddenAccounts)].sort()).toEqual(['scammer1', 'scammer2', 'spammer3']);
		setPreference('fiat', 'EUR');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sent.at(-1)?.hidden.sort()).toEqual(['scammer1', 'scammer2', 'spammer3']);
		stop();
	});

	it('an account with no blob yet starts from defaults (nothing inherited)', async () => {
		settingsReply = () => ({ ok: true, data: { enc: null } });
		const stop = initSettingsSync();
		await vi.advanceTimersByTimeAsync(100);
		expect([...get(hiddenAccounts)]).toEqual([]);
		stop();
	});
});
