/**
 * One stalled push service no longer holds everyone's notifications
 * (v1.21.14 full chat audit, S-L7).
 *
 * The sender worked the queue one row at a time and, within a row, one device
 * at a time, each allowed up to 15 s — so a single stalled push service
 * delayed every notification behind it, and the pass that met it did not end
 * until it timed out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';

import { PUSH_PASSES_IN_FLIGHT, PushSender } from '../src/policy/pushSender.ts';
import type { Config } from '../src/config/index.ts';

type Row = {
	id: string;
	account: string;
	category: string;
	title: string;
	body: string;
	click_path: string | null;
	event_at: Date;
	enqueued_at: Date;
	notification_id: string | null;
	sent: boolean;
};

/** How long a push service takes to answer, on the fake clock. */
const ANSWER_MS = 50;
/** …and a stalled one (the send timeout). */
const STALLED_MS = 15_000;

function harness(devicesOf: Record<string, string[]>, slow: Set<string>, selectMs = 0) {
	const rows: Row[] = [];
	const sent: { endpoint: string; at: number }[] = [];
	const t0 = Date.now();
	let selects = 0;
	const db = {
		query: async (text: string, params: unknown[]) => {
			if (/^\s*SELECT/.test(text)) {
				selects++;
				const [limit, skip] = params as [number, string[]];
				if (selectMs > 0) await new Promise((r) => setTimeout(r, selectMs));
				return {
					rows: rows
						.filter((r) => !r.sent && !skip.includes(r.id))
						.slice(0, limit)
						.map((r) => ({ ...r })),
					rowCount: 0
				};
			}
			if (/UPDATE push_pending SET sent_at/.test(text)) {
				const r = rows.find((x) => x.id === String(params[0]));
				if (r) r.sent = true;
			}
			return { rows: [], rowCount: 1 };
		}
	};
	const subs = {
		listByAccount: async (account: string) =>
			(devicesOf[account] ?? []).map((endpoint) => ({ account, endpoint, p256dh: 'p', auth: 'a' })),
		markDelivery: async () => undefined,
		delete: async () => undefined,
		recordFailure: async () => 1
	};
	const keys = webpush.generateVAPIDKeys();
	const sender = new PushSender(
		{
			pushEnabled: true,
			vapidSubject: 'mailto:ops@example.com',
			vapidPublicKey: keys.publicKey,
			vapidPrivateKey: keys.privateKey,
			pushBatchSize: 50,
			pushMaxAgeSeconds: 3600,
			pushPollIntervalMs: 1000,
			pushMaxConsecutiveFailures: 5
		} as unknown as Config,
		db as never,
		subs as never
	);
	(sender as unknown as { sendOne: (d: { endpoint: string }) => Promise<string> }).sendOne = (d) =>
		new Promise((resolve) => {
			const done = () => {
				sent.push({ endpoint: d.endpoint, at: Date.now() - t0 });
				resolve('delivered');
			};
			// On the fake clock every test installs (beforeEach): no real wait.
			setTimeout(done, slow.has(d.endpoint) ? STALLED_MS : ANSWER_MS);
		});
	let n = 0;
	const enqueue = (account: string) =>
		rows.push({
			id: String(++n),
			account,
			category: 'chat',
			title: 't',
			body: 'b',
			click_path: null,
			event_at: new Date(),
			enqueued_at: new Date(Date.now() + n),
			notification_id: null,
			sent: false
		});
	return { sender, sent, enqueue, rows, selects: () => selects };
}

describe('push sender (S-L7, fake timers)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("one stalled device does not delay the same account's other devices, or anyone else", async () => {
		const h = harness(
			{
				alice: ['https://push.example/stalled', 'https://push.example/alice2'],
				bob: ['https://push.example/bob']
			},
			new Set(['https://push.example/stalled'])
		);
		h.enqueue('alice');
		h.enqueue('bob');
		void h.sender.tick();
		await vi.advanceTimersByTimeAsync(100);
		expect(h.sent.map((s) => s.endpoint).sort()).toEqual([
			'https://push.example/alice2',
			'https://push.example/bob'
		]);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(h.sent.map((s) => s.endpoint)).toContain('https://push.example/stalled');
	});

	it('review B, F6: a row whose pass failed before sending is retried on the next pass, not 5 minutes later', async () => {
		const h = harness({ alice: ['https://push.example/alice'] }, new Set());
		h.enqueue('alice');
		// The first look-up of the account's devices fails (a database blip).
		const subs = (
			h.sender as unknown as { subs: { listByAccount: (a: string) => Promise<unknown> } }
		).subs;
		const real = subs.listByAccount.bind(subs);
		let failOnce = true;
		subs.listByAccount = async (a: string) => {
			if (failOnce) {
				failOnce = false;
				throw new Error('connection reset');
			}
			return real(a);
		};
		h.sender.start();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(h.sent.map((x) => x.endpoint)).toEqual(['https://push.example/alice']);
		const stopping = h.sender.stop();
		await vi.advanceTimersByTimeAsync(2_000);
		await stopping;
	});

	it('a notification queued while a pass waits on a stalled device goes out on the next pass', async () => {
		const h = harness(
			{ alice: ['https://push.example/stalled'], bob: ['https://push.example/bob'] },
			new Set(['https://push.example/stalled'])
		);
		h.enqueue('alice');
		h.sender.start();
		await vi.advanceTimersByTimeAsync(500);
		h.enqueue('bob');
		await vi.advanceTimersByTimeAsync(1_500);
		expect(h.sent.map((s) => s.endpoint)).toEqual(['https://push.example/bob']);
		// The stalled row was not picked up again by the later passes.
		await vi.advanceTimersByTimeAsync(15_000);
		expect(h.sent.filter((s) => s.endpoint.endsWith('stalled')).length).toBe(1);
		const stopping = h.sender.stop();
		await vi.advanceTimersByTimeAsync(2_000);
		await stopping;
	});

	it('a stalled database does not start a new pass every interval without end (finding 10)', async () => {
		const h = harness({ alice: ['https://push.example/a'] }, new Set(), 60_000);
		h.enqueue('alice');
		h.sender.start();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(h.selects()).toBe(PUSH_PASSES_IN_FLIGHT);
		const stopping = h.sender.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		await stopping;
	});

	it('a slow read that started before another pass sent a row does not send it again (review 2, finding 8)', async () => {
		const rows = [
			{
				id: '1',
				account: 'alice',
				category: 'chat',
				title: 't',
				body: 'b',
				click_path: null,
				event_at: new Date(),
				enqueued_at: new Date(),
				notification_id: null,
				sent: false
			}
		];
		// Postgres: a statement's snapshot is taken when it starts, the answer
		// arrives later. The second read starts before the first pass sends the
		// row and answers after it has finished with it.
		const selectDelays = [1500, 3000];
		let sel = 0;
		const sent: number[] = [];
		const db = {
			query: async (text: string, params: unknown[]) => {
				if (/^\s*SELECT/.test(text)) {
					const [limit, skip] = params as [number, string[]];
					const snap = rows
						.filter((r) => !r.sent && !skip.includes(r.id))
						.slice(0, limit)
						.map((r) => ({ ...r }));
					const d = selectDelays[sel++] ?? 0;
					await new Promise((r) => setTimeout(r, d));
					return { rows: snap, rowCount: snap.length };
				}
				if (/UPDATE push_pending SET sent_at/.test(text)) {
					const r = rows.find((x) => x.id === String(params[0]));
					if (r) r.sent = true;
				}
				return { rows: [], rowCount: 1 };
			}
		};
		const subs = {
			listByAccount: async (a: string) => [
				{ account: a, endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }
			],
			markDelivery: async () => undefined,
			delete: async () => undefined,
			recordFailure: async () => 1
		};
		const keys = webpush.generateVAPIDKeys();
		const sender = new PushSender(
			{
				pushEnabled: true,
				vapidSubject: 'mailto:o@example.com',
				vapidPublicKey: keys.publicKey,
				vapidPrivateKey: keys.privateKey,
				pushBatchSize: 50,
				pushMaxAgeSeconds: 3600,
				pushPollIntervalMs: 1000,
				pushMaxConsecutiveFailures: 5
			} as unknown as Config,
			db as never,
			subs as never
		);
		(sender as unknown as { sendOne: () => Promise<string> }).sendOne = () =>
			new Promise((res) =>
				setTimeout(() => {
					sent.push(Date.now());
					res('delivered');
				}, ANSWER_MS)
			);
		sender.start();
		await vi.advanceTimersByTimeAsync(10_000);
		const stopping = sender.stop();
		await vi.advanceTimersByTimeAsync(10_000);
		await stopping;
		expect(sent.length).toBe(1);
	});

	it('two passes that read the queue at the same moment never send one row twice', async () => {
		// The database answers slower than the poll interval, so the second
		// pass reads the queue before the first has marked anything as its own.
		const h = harness(
			{ alice: ['https://push.example/stalled'] },
			new Set(['https://push.example/stalled']),
			1_500
		);
		h.enqueue('alice');
		h.sender.start();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(h.sent.length).toBe(1);
		const stopping = h.sender.stop();
		await vi.advanceTimersByTimeAsync(20_000);
		await stopping;
	});
});
