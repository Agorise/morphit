/**
 * The push privacy controls reach Web Push (the tab-closed channel):
 *
 *   - "Off" cancels this browser's push subscription, in the browser and at
 *     the relay;
 *   - quiet hours and "Silence everything" are recorded where the service
 *     worker reads them, so its notifications arrive silent meanwhile.
 *
 * Real preferences / push / silenceState modules; the browser's push API, the
 * relay and IndexedDB are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn(async (..._a: unknown[]) => new Response('{}'));
vi.mock('$net/fetchWithTimeout', () => ({
	fetchWithTimeout: (...a: unknown[]) => fetchWithTimeout(...a)
}));

/** A minimal IndexedDB: one database, key-value stores, put(value, key)/get(key). */
function fakeIndexedDb() {
	const stores = new Map<string, Map<unknown, unknown>>();
	const later = (fn: () => void) => void setTimeout(fn, 0);
	return {
		open() {
			const req: Record<string, unknown> & { result?: unknown } = {};
			later(() => {
				const db = {
					objectStoreNames: { contains: (n: string) => stores.has(n) },
					createObjectStore: (n: string) => void stores.set(n, new Map()),
					close() {},
					transaction(n: string) {
						const store = stores.get(n)!;
						const tx: Record<string, unknown> = {
							objectStore: () => ({
								put: (v: unknown, k: unknown) => void store.set(k, structuredClone(v)),
								get(k: unknown) {
									const r: Record<string, unknown> = {};
									later(() => {
										r.result = store.get(k);
										(r.onsuccess as () => void)?.();
									});
									return r;
								}
							})
						};
						setTimeout(() => (tx.oncomplete as () => void)?.(), 1);
						return tx;
					}
				};
				req.result = db;
				if (!stores.size) (req.onupgradeneeded as () => void)?.();
				(req.onsuccess as () => void)?.();
			});
			return req;
		}
	};
}

/** The silence record the service worker reads, once `landed` says the
 *  write being waited for is in (the write is fire-and-forget). */
async function silenceRecord(
	read: () => Promise<import('./silenceState').SilenceState | null>,
	landed: (s: import('./silenceState').SilenceState) => boolean
): Promise<import('./silenceState').SilenceState> {
	return vi.waitFor(async () => {
		const s = await read();
		if (s === null || !landed(s)) throw new Error('not written yet');
		return s;
	});
}

let browserUnsubscribe: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.resetModules();
	fetchWithTimeout.mockClear();
	browserUnsubscribe = vi.fn(async () => true);
	const subscription = {
		endpoint: 'https://push.example/send/xyz',
		unsubscribe: browserUnsubscribe
	};
	vi.stubGlobal('indexedDB', fakeIndexedDb());
	vi.stubGlobal('window', {
		Notification: { permission: 'granted' },
		PushManager: function PushManager() {},
		location: new URL('https://morphit.example/')
	});
	vi.stubGlobal('navigator', {
		serviceWorker: {
			ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription } })
		}
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('"Off"', () => {
	it('cancels the push subscription in the browser and at the relay', async () => {
		const { setPushPrivacyLevel } = await import('./push');
		await setPushPrivacyLevel('off', 'alice');
		expect(browserUnsubscribe).toHaveBeenCalled();
		const relay = fetchWithTimeout.mock.calls.find(([u]) =>
			String(u).endsWith('/v1/push/unsubscribe')
		);
		expect(relay).toBeDefined();
		expect(JSON.parse((relay![1] as { body: string }).body)).toMatchObject({ account: 'alice' });
	});

	it('"Standard" leaves it alone', async () => {
		const { setPushPrivacyLevel } = await import('./push');
		await setPushPrivacyLevel('standard', 'alice');
		expect(browserUnsubscribe).not.toHaveBeenCalled();
	});
});

describe('quiet hours and "Silence everything" reach the service worker', () => {
	it('"Silence everything" for an hour: the service worker reads it as silenced', async () => {
		const prefs = await import('./preferences');
		const { readSilenceState, isSilencedAt } = await import('./silenceState');
		prefs.muteFor(60 * 60_000);
		const seen = await silenceRecord(readSilenceState, (s) => s.mutedUntil > 0);
		expect(isSilencedAt(seen, new Date())).toBe(true);
	});

	it('quiet hours across midnight', async () => {
		const prefs = await import('./preferences');
		const { readSilenceState, isSilencedAt } = await import('./silenceState');
		prefs.setQuietHours({ enabled: true, from: '22:00', to: '07:00' });
		const seen = await silenceRecord(readSilenceState, (s) => s.quietHours.enabled);
		expect(isSilencedAt(seen, new Date(2026, 9, 2, 23, 30))).toBe(true);
		expect(isSilencedAt(seen, new Date(2026, 9, 3, 6, 59))).toBe(true);
		expect(isSilencedAt(seen, new Date(2026, 9, 3, 7, 0))).toBe(false);
		expect(isSilencedAt(seen, new Date(2026, 9, 2, 12, 0))).toBe(false);
	});
});
