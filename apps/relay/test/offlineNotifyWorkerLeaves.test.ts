/**
 * Offline notices: a homeserver that is slow to let the Matrix bot leave its
 * rooms never holds up the notices (review 19d, MEDIUM-1).
 *
 * The worker's round used to leave rooms first, and to wait for every pass
 * of the leave round — which went on as long as users kept removing,
 * cancelling or confirming addresses (each asks for one more pass). With a
 * hung homeserver no notice went out, on any app, for as long as that went
 * on. Now the round delivers the notices first, and waits for one pass of
 * leaves at most (leaves.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import type { NotifyConfig } from '../src/notify/config.ts';
import type { DueNotice, OfflineNotifyStore } from '../src/notify/store.ts';

const events: string[] = [];
vi.mock('../src/notify/dispatch.ts', async (orig) => {
	const real = await orig<typeof import('../src/notify/dispatch.ts')>();
	return {
		...real,
		dispatch: (_cfg: unknown, channel: string, address: string) => {
			events.push(`sent ${channel}:${address}`);
			return Promise.resolve(null);
		}
	};
});

const { OfflineNotifyWorker, Presence } = await import('../src/notify/worker.ts');
const { drainLeaves } = await import('../src/notify/leaves.ts');

describe('offline notices: slow leaves never hold up the notices', () => {
	it('the round delivers first and waits for one pass of leaves at most, while users keep asking for more', async () => {
		// A fake clock: the homeserver's answers, the users' requests and the
		// pass's time budget all follow it.
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
		});
		const now = new Date();
		const notice: DueNotice = {
			account: 'bob',
			sender: 'trader-joe',
			orderPermlink: '',
			eventAt: new Date(now.getTime() - 15 * 60_000),
			attempts: 0
		};
		let due = [notice];
		let n = 0;
		const store = {
			purge: async () => undefined,
			takeDue: async () => {
				const d = due;
				due = [];
				return d;
			},
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
			verifiedChannels: async (account: string) => ({
				channels: [{ channel: 'email', address: `${account}@example.org`, linkNet: 'clearnet' }],
				locale: 'en'
			}),
			// Rooms keep coming (users keep removing addresses), and the
			// homeserver takes 100 ms to answer each leave.
			claimLeaves: async () => {
				n++;
				const room = `!r${n}:hs`;
				return [
					{ key: Buffer.from(room), tries: 0, account: '~matrix-room', room, addressMac: null }
				];
			},
			leaveIfUnused: async () => {
				await new Promise((r) => setTimeout(r, 100));
				events.push('left');
				return 'left' as const;
			},
			leaveLater: async () => undefined,
			leaveDone: async () => undefined
		} as unknown as OfflineNotifyStore;
		const cfg = {
			linkOrigin: 'https://site.example',
			linkOrigins: { clearnet: null, tor: null, i2p: null, loki: null },
			siteName: 'Site',
			matrix: { homeserver: 'http://hs.invalid', accessToken: 't', userId: '@bot:hs' },
			session: null,
			xmpp: null,
			telegram: null,
			email: { host: 'mail.example' },
			policy: { torSocks: '', hiddenOnly: false }
		} as unknown as NotifyConfig;
		const w = new OfflineNotifyWorker(cfg, store, new Presence(() => now.getTime()), () => now);
		// The API: an address removed, cancelled or confirmed every 50 ms.
		const api = setInterval(() => void drainLeaves(store, cfg.matrix, cfg.policy, now), 50);
		try {
			let done = false;
			const round = w.tick().then(() => (done = true));
			// One pass of leaves: 20 rooms, 100 ms each.
			await vi.advanceTimersByTimeAsync(2100);
			// The notice went out first…
			expect(events[0]).toBe('sent email:bob@example.org');
			// …and the round is over after that one pass, although users
			// keep asking for more (each asks for another pass).
			expect(done).toBe(true);
			expect(events.filter((e) => e === 'left').length).toBeGreaterThanOrEqual(20);
			await round;
		} finally {
			clearInterval(api);
			vi.useRealTimers();
		}
	}, 20_000);
});
