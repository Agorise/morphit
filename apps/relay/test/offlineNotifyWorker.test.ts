/**
 * Offline notices: the worker's decisions around a send that fails —
 * how often it is tried, that a retry is the same notice (no second daily
 * slot, not a second stranger notice), and that an app the site no longer
 * offers is never sent to.
 */
import { describe, expect, it } from 'vitest';
import type { NotifyConfig } from '../src/notify/config.ts';
import type { DueNotice, OfflineNotifyStore } from '../src/notify/store.ts';
import { MAX_ATTEMPTS, OfflineNotifyWorker, Presence } from '../src/notify/worker.ts';

const onion = 'm'.repeat(56) + '.onion';
// An email server at an .onion address and no Tor: every send fails at once,
// before any connection.
const cfg = {
	siteName: 'Test',
	audience: 'relay-test',
	linkOrigin: 'http://' + 'a'.repeat(56) + '.onion',
	linkOrigins: { clearnet: null, tor: null, i2p: null },
	policy: { torSocks: '', hiddenOnly: true },
	email: {
		host: onion,
		port: 25,
		security: 'starttls',
		user: 'u',
		password: 'p',
		from: 'x@' + onion
	},
	matrix: null,
	xmpp: null,
	telegram: null,
	session: null,
	off: {}
} as unknown as NotifyConfig;

function fakeStore(
	channels: Array<{ channel: string; address: string }>,
	strangerToldToday = false
) {
	const calls = { slot: 0, link: 0, dropped: 0, strangerAsked: 0 };
	const store = {
		repliedSince: async () => false,
		unreadStoredFrom: async () => true,
		blocked: async () => false,
		readSince: async () => false,
		alreadyNoticed: async () => false,
		everWrote: async () => false,
		noticedSince: async () => {
			calls.strangerAsked++;
			return strangerToldToday;
		},
		verifiedChannels: async () => ({
			channels: channels.map((c) => ({ ...c, route: null, linkNet: 'tor' })),
			locale: 'en'
		}),
		takeDailySlot: async () => {
			calls.slot++;
			return true;
		},
		createLink: async () => {
			calls.link++;
			return 'tok'.repeat(8);
		},
		dropLink: async () => {
			calls.dropped++;
		}
	};
	return { store: store as unknown as OfflineNotifyStore, calls };
}

const notice = (attempts: number): DueNotice => ({
	account: 'grandma',
	sender: 'stranger',
	orderPermlink: '',
	eventAt: new Date('2026-10-15T12:00:00Z'),
	attempts
});
const now = new Date('2026-10-15T12:15:00Z');

describe('offline notices: a send that fails', () => {
	it(`is tried ${MAX_ATTEMPTS} times in all, then given up`, async () => {
		const verdicts: string[] = [];
		for (let a = 0; a < MAX_ATTEMPTS; a++) {
			const { store } = fakeStore([{ channel: 'email', address: 'g@example.onion' }]);
			const w = new OfflineNotifyWorker(cfg, store, new Presence(), () => now);
			verdicts.push(await w.handle(notice(a), now));
		}
		expect(verdicts).toEqual([...Array(MAX_ATTEMPTS - 1).fill('retry'), 'failed']);
	});

	it('a retry is the same notice: no second daily slot, not counted as a second stranger notice', async () => {
		// She was sent a notice about this stranger today.
		const { store, calls } = fakeStore([{ channel: 'email', address: 'g@example.onion' }], true);
		const w = new OfflineNotifyWorker(cfg, store, new Presence(), () => now);
		// First try: a stranger she was already told about today → held back.
		expect(await w.handle(notice(0), now)).toBe('stranger_quota');
		expect(calls.slot).toBe(0);
		// A retry of a notice that got through the checks once goes ahead…
		expect(await w.handle(notice(1), now)).toBe('retry');
		// …without asking again, and without a second slot.
		expect(calls.strangerAsked).toBe(1);
		expect(calls.slot).toBe(0);
		// The failed try's link went (it reached no app).
		expect(calls.link).toBe(1);
		expect(calls.dropped).toBe(1);
	});

	it('an app the site no longer offers is never sent to (and makes no link)', async () => {
		const { store, calls } = fakeStore([{ channel: 'matrix', address: '@g:hs.org' }]);
		const w = new OfflineNotifyWorker(cfg, store, new Presence(), () => now);
		expect(await w.handle(notice(1), now)).toBe('no_channels');
		expect(calls.link).toBe(0);
	});
});
