/**
 * An offline notice only for a message the chain has (v1.21.14 full chat
 * audit, S-L8).
 *
 * Notices are queued from the FAST path, before the chain has the message, and
 * a message can be announced that then never lands. A notice 10-60 minutes
 * later then opened an empty thread. Now the message must be stored by then;
 * one not stored yet waits (an indexer catching up) without counting as a try,
 * and one never stored is never announced.
 */
import { describe, expect, it } from 'vitest';
import type { NotifyConfig } from '../src/notify/config.ts';
import type { DueNotice, OfflineNotifyStore } from '../src/notify/store.ts';
import { NOT_STORED_GIVE_UP_MS, OfflineNotifyWorker, Presence } from '../src/notify/worker.ts';

const cfg = {
	siteName: 'Test',
	audience: 'relay-test',
	linkOrigin: 'http://' + 'a'.repeat(56) + '.onion',
	linkOrigins: { clearnet: null, tor: null, i2p: null },
	policy: { torSocks: '', hiddenOnly: true },
	email: null,
	matrix: null,
	xmpp: null,
	telegram: null,
	session: null,
	off: {}
} as unknown as NotifyConfig;

const eventAt = new Date('2026-10-15T12:00:00Z');
const notice: DueNotice = {
	account: 'grandma',
	sender: 'friend',
	orderPermlink: '',
	eventAt,
	attempts: 0
};

function store(stored: boolean) {
	const calls = { link: 0, slot: 0, since: [] as string[], requeued: [] as boolean[] };
	const s = {
		repliedSince: async () => false,
		blocked: async () => false,
		unreadStoredFrom: async (a: string, p: string, thread: string) => {
			calls.since.push(`${a}|${p}|${thread}`);
			return stored;
		},
		readSince: async () => false,
		alreadyNoticed: async () => false,
		everWrote: async () => true,
		noticedSince: async () => false,
		verifiedChannels: async () => ({ channels: [], locale: 'en' }),
		takeDailySlot: async () => {
			calls.slot++;
			return true;
		},
		createLink: async () => {
			calls.link++;
			return 'tok';
		},
		purge: async () => undefined,
		takeDue: async () => [notice],
		requeue: async (_n: DueNotice, _due: Date, countAsAttempt = true) => {
			calls.requeued.push(countAsAttempt);
		},
		telegramCodeWaiting: async () => false
	};
	return { s: s as unknown as OfflineNotifyStore, calls };
}

describe('offline notices for messages the chain does not have (S-L8)', () => {
	it('not stored yet: it waits, and the wait is not a try', async () => {
		const { s, calls } = store(false);
		const now = new Date(eventAt.getTime() + 15 * 60_000);
		const w = new OfflineNotifyWorker(cfg, s, new Presence(), () => now);
		expect(await w.handle(notice, now)).toBe('wait');
		expect(calls.link).toBe(0);
		expect(calls.slot).toBe(0);
		expect(calls.since).toEqual(['grandma|friend|']);
		await w.tick();
		expect(calls.requeued).toEqual([false]);
	});

	it('never stored: never announced', async () => {
		const { s, calls } = store(false);
		const now = new Date(eventAt.getTime() + NOT_STORED_GIVE_UP_MS + 60_000);
		const w = new OfflineNotifyWorker(cfg, s, new Presence(), () => now);
		expect(await w.handle(notice, now)).toBe('not_on_chain');
		expect(calls.link).toBe(0);
	});

	it('stored: the notice goes on to the usual checks', async () => {
		const { s } = store(true);
		const now = new Date(eventAt.getTime() + 15 * 60_000);
		const w = new OfflineNotifyWorker(cfg, s, new Presence(), () => now);
		// No channel set up in this fixture: the next check answers.
		expect(await w.handle(notice, now)).toBe('no_channels');
	});
});
