/**
 * Offline notices: a notice send that outlives its budget, or fails.
 *
 *   - it arrives after all: no second notice (its link stays, nothing put
 *     back);
 *   - it fails after all: the link goes and the notice is tried again;
 *   - a send that fails at once: tried again. (Which Matrix room is hers, and
 *     which rooms are left, is the store's: channels/matrix.ts, store.ts.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotifyConfig } from '../src/notify/config.ts';
import type { DueNotice, OfflineNotifyStore } from '../src/notify/store.ts';

vi.mock('../src/notify/dispatch.ts', async (orig) => {
	const real = await orig<typeof import('../src/notify/dispatch.ts')>();
	// worker.ts SEND_BUDGET_MS (checked below); importing it here would loop.
	const SEND_BUDGET_MS = 120_000;
	return {
		...real,
		dispatch: (_cfg: unknown, _channel: string, address: string) => {
			if (address === '@late-ok:hs')
				return new Promise((r) => setTimeout(() => r('!late:hs'), SEND_BUDGET_MS + 1000));
			if (address === '@late-fail:hs')
				return new Promise((_r, j) =>
					setTimeout(() => j(new Error('gone')), SEND_BUDGET_MS + 1000)
				);
			return Promise.reject(new Error('M_FORBIDDEN'));
		}
	};
});

const { OfflineNotifyWorker, Presence, SEND_BUDGET_MS } = await import('../src/notify/worker.ts');

const now = new Date('2026-10-15T12:15:00Z');
const notice: DueNotice = {
	account: 'alice',
	sender: 'trader-joe',
	orderPermlink: '',
	eventAt: new Date('2026-10-15T12:00:00Z'),
	attempts: 0
};

function harness(address: string) {
	const calls = {
		dropLink: 0,
		requeue: 0
	};
	const store = {
		repliedSince: async () => false,
		unreadStoredFrom: async () => true,
		blocked: async () => false,
		readSince: async () => false,
		alreadyNoticed: async () => false,
		everWrote: async () => true,
		noticedSince: async () => false,
		takeDailySlot: async () => true,
		createLink: async () => 'token',
		verifiedChannels: async () => ({
			channels: [
				{
					channel: 'matrix',
					address,
					linkNet: 'clearnet',
					prev: false
				}
			],
			locale: 'en'
		}),
		matrixRoomBook: () => ({}),
		dropLink: async () => {
			calls.dropLink++;
		},
		requeue: async () => {
			calls.requeue++;
		}
	} as unknown as OfflineNotifyStore;
	const cfg = {
		linkOrigin: 'https://site.example',
		linkOrigins: { clearnet: null, tor: null, i2p: null, loki: null },
		siteName: 'Site',
		matrix: { homeserver: 'https://hs', token: 't', userId: '@bot:hs' },
		session: null,
		xmpp: null,
		telegram: null,
		email: null,
		policy: { torSocks: '', hiddenOnly: false }
	} as unknown as NotifyConfig;
	const w = new OfflineNotifyWorker(cfg, store, new Presence(() => now.getTime()), () => now);
	return { w, calls };
}

afterEach(() => vi.useRealTimers());

describe('offline notices: a send past its budget', () => {
	it('(the budget these sends outlive)', () => expect(SEND_BUDGET_MS).toBe(120_000));

	it('that arrives after all: no second notice', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const { w, calls } = harness('@late-ok:hs');
		const verdict = w.handle(notice, now);
		await vi.advanceTimersByTimeAsync(SEND_BUDGET_MS + 10);
		expect(await verdict).toBe('late');
		await vi.advanceTimersByTimeAsync(2000);
		expect(calls.dropLink).toBe(0);
		expect(calls.requeue).toBe(0);
	});

	it('that fails after all: the link goes and it is tried again', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const { w, calls } = harness('@late-fail:hs');
		const verdict = w.handle(notice, now);
		await vi.advanceTimersByTimeAsync(SEND_BUDGET_MS + 10);
		expect(await verdict).toBe('late');
		expect(calls.requeue).toBe(0);
		await vi.advanceTimersByTimeAsync(2000);
		expect(calls.dropLink).toBe(1);
		expect(calls.requeue).toBe(1);
	});
});

describe('offline notices: a send that fails at once', () => {
	it('is tried again, its link gone', async () => {
		const { w, calls } = harness('@fails:hs');
		expect(await w.handle(notice, now)).toBe('retry');
		expect(calls.dropLink).toBe(1);
	});
});
