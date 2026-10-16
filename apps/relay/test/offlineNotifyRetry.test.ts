/**
 * Offline notices: a send that failed is tried again on a UTC quarter hour,
 * like every first try (the indexer's due times), so a retry does not stand
 * out from the shared marks — and never sooner than RETRY_MS.
 */
import { describe, expect, it } from 'vitest';
import type { NotifyConfig } from '../src/notify/config.ts';
import type { DueNotice, OfflineNotifyStore } from '../src/notify/store.ts';
import {
	OfflineNotifyWorker,
	Presence,
	RETRY_MS,
	retryAt,
	SLOT_MS,
	type Verdict
} from '../src/notify/worker.ts';

describe('offline notices: retries', () => {
	it('retryAt: the first quarter hour at least RETRY_MS away', () => {
		const t = (iso: string): number => new Date(iso).getTime();
		expect(retryAt(t('2026-10-15T12:00:00Z')).toISOString()).toBe('2026-10-15T12:15:00.000Z');
		expect(retryAt(t('2026-10-15T12:09:59Z')).toISOString()).toBe('2026-10-15T12:15:00.000Z');
		expect(retryAt(t('2026-10-15T12:10:01Z')).toISOString()).toBe('2026-10-15T12:30:00.000Z');
		for (let s = 0; s < 3600; s += 13) {
			const now = t('2026-10-15T12:00:00Z') + s * 1000;
			const r = retryAt(now).getTime();
			expect(r % SLOT_MS).toBe(0);
			expect(r - now).toBeGreaterThanOrEqual(RETRY_MS);
			expect(r - now).toBeLessThan(RETRY_MS + SLOT_MS);
		}
	});

	it('a failed send is put back for the next quarter hour', async () => {
		const now = new Date('2026-10-15T12:15:20Z');
		const notice: DueNotice = {
			account: 'grandma',
			sender: 'trader-joe',
			orderPermlink: '',
			eventAt: new Date('2026-10-15T11:58:00Z'),
			attempts: 0
		};
		const requeued: Date[] = [];
		const store = {
			purge: async () => undefined,
			takeDue: async () => [notice],
			requeue: async (_n: DueNotice, due: Date) => {
				requeued.push(due);
			},
			telegramCodeWaiting: async () => false
		} as unknown as OfflineNotifyStore;
		class FailingWorker extends OfflineNotifyWorker {
			override async handle(): Promise<Verdict> {
				return 'retry';
			}
		}
		const w = new FailingWorker(
			{ telegram: null } as unknown as NotifyConfig,
			store,
			new Presence(() => now.getTime()),
			() => now
		);
		await w.tick();
		expect(requeued.map((d) => d.toISOString())).toEqual(['2026-10-15T12:30:00.000Z']);
	});
});
