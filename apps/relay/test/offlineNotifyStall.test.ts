/**
 * Offline notices: one stuck server does not hold up everyone's notes.
 *
 * The worker sends one notice after another. A server that never answers (a
 * Session node or a Tor exit dripping a byte now and then) used to keep the
 * worker's round open — and a round still running blocks every later one —
 * so no notice went out on any channel until the relay restarted. Each send
 * now has SEND_BUDGET_MS; past it, that send counts as failed and the next
 * notice goes on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotifyConfig } from '../src/notify/config.ts';
import type { DueNotice, OfflineNotifyStore } from '../src/notify/store.ts';

const sent: string[] = [];
vi.mock('../src/notify/dispatch.ts', async (orig) => {
	const real = await orig<typeof import('../src/notify/dispatch.ts')>();
	return {
		...real,
		dispatch: (_cfg: unknown, channel: string, address: string) => {
			// alice's server never answers; bob's does.
			if (address === 'alice@example.org') return new Promise<never>(() => undefined);
			sent.push(`${channel}:${address}`);
			return Promise.resolve(null);
		}
	};
});

const { OfflineNotifyWorker, Presence, SEND_BUDGET_MS } = await import('../src/notify/worker.ts');

afterEach(() => {
	vi.useRealTimers();
	sent.length = 0;
});

describe('offline notices: a stuck send', () => {
	it('counts as failed after its budget, and the next notice goes out', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const now = new Date('2026-10-15T12:15:00Z');
		const notice = (account: string): DueNotice => ({
			account,
			sender: 'trader-joe',
			orderPermlink: '',
			eventAt: new Date('2026-10-15T12:00:00Z'),
			attempts: 0
		});
		const store = {
			purge: async () => undefined,
			takeDue: async () => [notice('alice'), notice('bob')],
			requeue: async () => undefined,
			telegramCodeWaiting: async () => false,
			repliedSince: async () => false,
			unreadStoredFrom: async () => true,
			blocked: async () => false,
			dropLink: async () => undefined,
			readSince: async () => false,
			alreadyNoticed: async () => false,
			everWrote: async () => true,
			noticedSince: async () => false,
			takeDailySlot: async () => true,
			createLink: async () => 'token',
			setRoute: async () => undefined,
			queueLeave: async () => undefined,
			verifiedChannels: async (account: string) => ({
				channels: [
					{ channel: 'email', address: `${account}@example.org`, route: null, linkNet: 'clearnet' }
				],
				locale: 'en'
			})
		} as unknown as OfflineNotifyStore;
		const cfg = {
			linkOrigin: 'https://site.example',
			linkOrigins: { clearnet: null, tor: null, i2p: null, loki: null },
			siteName: 'Site',
			matrix: null,
			session: null,
			xmpp: null,
			telegram: null,
			email: { host: 'mail.example' },
			policy: { torSocks: '', hiddenOnly: false }
		} as unknown as NotifyConfig;
		const w = new OfflineNotifyWorker(cfg, store, new Presence(() => now.getTime()), () => now);
		let done = false;
		const round = w.tick().then(() => (done = true));
		await vi.advanceTimersByTimeAsync(SEND_BUDGET_MS - 1000);
		expect(done).toBe(false);
		expect(sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(2000);
		await round;
		expect(done).toBe(true);
		expect(sent).toEqual(['email:bob@example.org']);
	});
});
