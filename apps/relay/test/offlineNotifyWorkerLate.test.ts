/**
 * Offline notices: a notice send that outlives its budget, or opens a Matrix
 * room and then fails.
 *
 *   - it arrives after all: no second notice (its link stays, nothing put
 *     back), and the room it opened is offered to her row (kept only if the
 *     row still holds that address);
 *   - it fails after all: the link goes and the notice is tried again;
 *   - a room opened for a send that then failed is left.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotifyConfig } from '../src/notify/config.ts';
import type { DueNotice, OfflineNotifyStore } from '../src/notify/store.ts';
import { MatrixRoomLeftOpen } from '../src/notify/channels/matrix.ts';

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
			return Promise.reject(new MatrixRoomLeftOpen('!orphan:hs', new Error('M_FORBIDDEN')));
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
const SEALED = Buffer.from('sealed-address');

function harness(address: string) {
	const calls = {
		setRoute: [] as unknown[][],
		leave: [] as unknown[][],
		dropLink: 0,
		requeue: 0
	};
	const store = {
		repliedSince: async () => false,
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
					route: null,
					linkNet: 'clearnet',
					addressSealed: SEALED,
					prev: false
				}
			],
			locale: 'en'
		}),
		setRoute: async (...a: unknown[]) => {
			calls.setRoute.push(a);
			return true;
		},
		queueLeave: async (...a: unknown[]) => {
			calls.leave.push(a);
		},
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

	it('that arrives after all: no second notice, and its room goes to her row', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const { w, calls } = harness('@late-ok:hs');
		const verdict = w.handle(notice, now);
		await vi.advanceTimersByTimeAsync(SEND_BUDGET_MS + 10);
		expect(await verdict).toBe('late');
		await vi.advanceTimersByTimeAsync(2000);
		expect(calls.dropLink).toBe(0);
		expect(calls.requeue).toBe(0);
		expect(calls.setRoute).toEqual([
			['alice', 'matrix', '!late:hs', { addressSealed: SEALED, prev: false }]
		]);
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

describe('offline notices: a room opened for a send that failed', () => {
	it('is left', async () => {
		const { w, calls } = harness('@fails:hs');
		expect(await w.handle(notice, now)).toBe('retry');
		expect(calls.leave).toEqual([['alice', '!orphan:hs']]);
		expect(calls.dropLink).toBe(1);
	});
});
