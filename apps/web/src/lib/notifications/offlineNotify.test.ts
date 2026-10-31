/**
 * Settings → Offline Notifications: what the browser does with each answer
 * from this site's relay. Drives the REAL request functions in offlineNotify.ts
 * (real signatures; the relay is a stand-in that answers whatever each test
 * needs) and checks what she would see: which error, whether a notice's link
 * is gone or only "not right now", that cancelling a change is its own signed
 * request, that a strange answer cannot get into a link or crash the card,
 * that the status is asked once as the page opens, and that the heartbeat
 * stops when she locks or signs out — even mid-request.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PrivateKey } from '@beblurt/dblurt';
import { writable } from 'svelte/store';

const h = vi.hoisted(() => {
	type Answer = { status: number; body?: unknown; raw?: string } | 'network';
	return {
		account: 'grandma' as string | null,
		sent: [] as Array<{ action: string; url: string; body: Record<string, unknown> }>,
		/** Per action: the answer (or a promise of it). */
		answers: {} as Record<string, Answer | (() => Answer | Promise<Answer>)>,
		channelsCalls: 0,
		/** Signed requests that reached the relay (never reset by a test). */
		signedArrived: 0
	};
});

const key = PrivateKey.fromSeed('offline-notify-behaviour');
const identity = writable<{ posting: { privateKey: Uint8Array } } | null>({
	posting: { privateKey: Uint8Array.from((key as unknown as { key: Buffer }).key) }
});

vi.mock('$net/config', () => ({
	MORPHIT_RELAY_ORIGIN: 'https://relay.test',
	resolveOrigin: (o: string) => o
}));
vi.mock('$lib/blurt/ops/profile', () => ({ getUserBlurtAccount: () => h.account }));
vi.mock('$lib/stores/identity', () => ({ liveIdentity: identity }));
vi.mock('$net/fetchWithTimeout', () => ({
	fetchWithTimeout: async (url: string, init: { body?: string }) => {
		const action = url.split('/').pop()!;
		if (action === 'channels') h.channelsCalls++;
		else {
			h.signedArrived++;
			h.sent.push({ action, url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
		}
		const a0 = h.answers[action] ?? { status: 200, body: { status: 'ok', channels: [] } };
		const a = typeof a0 === 'function' ? await a0() : a0;
		if (a === 'network') throw new TypeError('Failed to fetch');
		return new Response(a.raw ?? JSON.stringify(a.body ?? {}), { status: a.status });
	}
}));

const CHANNELS = {
	status: 200,
	body: {
		site: 'Vigilante Trading',
		audience: 'vigilante-relay',
		stored: true,
		channels: [{ id: 'email' }, { id: 'telegram', bot: 'VigilanteBot' }],
		zero_clearnet: false
	}
};

type Web = typeof import('./offlineNotify');
let web: Web;
/** Every signed request draws its nonce first, synchronously: this counts the
 *  requests begun, at the very moment each begins. */
let nonces: MockInstance;

beforeEach(async () => {
	h.account = 'grandma';
	h.sent.length = 0;
	h.channelsCalls = 0;
	h.signedArrived = 0;
	h.answers = { channels: CHANNELS };
	nonces = vi.spyOn(globalThis.crypto, 'getRandomValues');
	identity.set({
		posting: { privateKey: Uint8Array.from((key as unknown as { key: Buffer }).key) }
	});
	vi.resetModules();
	web = await import('./offlineNotify');
});

afterEach(() => {
	web.stopOfflinePresence();
	vi.useRealTimers();
	nonces.mockRestore();
});

const actions = () => h.sent.map((s) => s.action);
const flush = async (n = 20) => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => queueMicrotask(r));
};
/**
 * Signing uses WebCrypto, so a request reaches the relay some real time after
 * it begins. Tests wait for what they expect to see (`expect.poll`), never a
 * guessed number of milliseconds. expect.poll, unlike vi.waitFor, does not move
 * a fake clock while it waits, so the heartbeat tests step it by exact minutes.
 */
const POLL = { timeout: 4_000, interval: 5 } as const;
/**
 * Resolves once every signed request begun so far has reached the relay.
 * Called just after the moment an unwanted request would have begun, it turns
 * "and nothing more is sent" into a check instead of a wait-and-see: anything
 * that began is waited for, and nothing that has not begun can arrive later.
 */
const allArrived = () => expect.poll(() => h.signedArrived, POLL).toBe(nonces.mock.calls.length);

describe('errors she is shown', () => {
	it('a 429 is "too many codes" only when the relay says so; otherwise "too many tries"', async () => {
		h.answers.set = { status: 429, body: { status: 'too_many_codes' } };
		await expect(web.setAddress('email', 'a@b.example', 'en')).rejects.toBe('too_many_codes');
		h.answers.set = { status: 429, body: { status: 'rate_limited' } };
		await expect(web.setAddress('email', 'a@b.example', 'en')).rejects.toBe('rate_limited');
		h.answers.set = { status: 429, raw: 'Too Many Requests' };
		await expect(web.setAddress('email', 'a@b.example', 'en')).rejects.toBe('rate_limited');
		h.answers.verify = { status: 429, body: { status: 'rate_limited' } };
		await expect(web.verifyCode('email', '123456')).rejects.toBe('rate_limited');
		h.answers.status = { status: 429, body: { status: 'rate_limited' } };
		await expect(web.offlineStatus()).rejects.toBe('rate_limited');
	});

	it('code answers come through as themselves', async () => {
		for (const s of ['wrong', 'expired', 'none'] as const) {
			h.answers.verify = { status: 400, body: { status: s } };
			await expect(web.verifyCode('email', '123456')).rejects.toBe(s);
		}
		h.answers.set = { status: 503, body: { status: 'offline_notify_unavailable' } };
		await expect(web.setAddress('email', 'a@b.example', 'en')).rejects.toBe('unavailable');
	});

	it('a relay too busy to answer in time: "busy" (try again), not "unavailable"', async () => {
		h.answers.set = { status: 503, body: { status: 'busy' } };
		await expect(web.setAddress('email', 'a@b.example', 'en')).rejects.toBe('busy');
		h.answers.verify = { status: 503, body: { status: 'busy' } };
		await expect(web.verifyCode('email', '123456')).rejects.toBe('busy');
		h.answers.remove = { status: 503, body: { status: 'busy' } };
		await expect(web.removeChannel('all')).rejects.toBe('busy');
	});
});

describe('a site whose relay does not name itself', () => {
	it('is "unavailable", and nothing is signed or sent', async () => {
		h.answers.channels = { status: 200, body: { ...CHANNELS.body, audience: '' } };
		await expect(web.offlineStatus()).rejects.toBe('unavailable');
		await expect(web.setAddress('email', 'a@b.example', 'en')).rejects.toBe('unavailable');
		await expect(web.removeChannel('all')).rejects.toBe('unavailable');
		expect(h.sent).toEqual([]);
	});
});

describe('a notice link', () => {
	it('opens the conversation the relay names', async () => {
		h.answers.open = { status: 200, body: { status: 'ok', peer: 'trader-joe', order: 'p-1' } };
		expect(await web.openNoticeLink('AbCdEfGhIjKlMnOpQrStUvWx')).toEqual({
			kind: 'ok',
			peer: 'trader-joe',
			order: 'p-1'
		});
		h.answers.open = { status: 200, body: { status: 'ok', peer: 'trader-joe', order: null } };
		expect(await web.openNoticeLink('AbCdEfGhIjKlMnOpQrStUvWx')).toEqual({
			kind: 'ok',
			peer: 'trader-joe',
			order: null
		});
		expect(h.sent.at(-1)?.body.token).toBe('AbCdEfGhIjKlMnOpQrStUvWx');
	});

	it('is gone only when the relay says it does not exist (404) or cannot be read (400)', async () => {
		for (const status of [404, 400]) {
			h.answers.open = { status, body: { status: 'not_found' } };
			expect(await web.openNoticeLink('AbCdEfGhIjKlMnOpQrStUvWx')).toEqual({ kind: 'gone' });
		}
	});

	it('is kept for another try when the relay is busy, down, or not reached', async () => {
		for (const a of [
			{ status: 429, body: { status: 'rate_limited' } },
			{ status: 503, body: { status: 'signature_invalid', reason: 'chain_unreachable' } },
			{ status: 401, body: { status: 'signature_invalid' } },
			{ status: 500, body: { status: 'internal' } },
			'network' as const
		]) {
			h.answers.open = a;
			expect(await web.openNoticeLink('AbCdEfGhIjKlMnOpQrStUvWx'), JSON.stringify(a)).toEqual({
				kind: 'retry'
			});
		}
		identity.set(null); // locked
		expect(await web.openNoticeLink('AbCdEfGhIjKlMnOpQrStUvWx')).toEqual({ kind: 'retry' });
	});

	it('a reply that names no account opens nothing', async () => {
		for (const peer of ['../settings', 'Trader', '', 'a', '//evil.example', 42, null]) {
			h.answers.open = { status: 200, body: { status: 'ok', peer, order: null } };
			expect(await web.openNoticeLink('AbCdEfGhIjKlMnOpQrStUvWx'), String(peer)).toEqual({
				kind: 'gone'
			});
		}
		h.answers.open = { status: 200, body: { status: 'ok', peer: 'trader-joe', order: { x: 1 } } };
		expect(await web.openNoticeLink('AbCdEfGhIjKlMnOpQrStUvWx')).toEqual({
			kind: 'ok',
			peer: 'trader-joe',
			order: null
		});
	});
});

describe('cancelling a change of address', () => {
	it('is its own signed request for that channel, never a removal', async () => {
		h.answers.cancel = { status: 200, body: { status: 'cancelled' } };
		await web.cancelChange('email');
		expect(actions()).toEqual(['cancel']);
		expect(h.sent[0]!.url).toBe('https://relay.test/v1/notify/cancel');
		expect(h.sent[0]!.body).toMatchObject({ channel: 'email', account: 'grandma' });
		expect(typeof h.sent[0]!.body.signature).toBe('string');
	});

	it('an older relay that has no cancel (404/400) changes nothing and is not an error', async () => {
		for (const status of [404, 400]) {
			h.sent.length = 0;
			h.answers.cancel = { status, body: { status: 'nope' } };
			await expect(web.cancelChange('matrix')).resolves.toBeUndefined();
			expect(actions()).toEqual(['cancel']);
		}
	});

	it('other failures are shown', async () => {
		h.answers.cancel = { status: 503, body: {} };
		await expect(web.cancelChange('email')).rejects.toBe('unavailable');
		h.answers.cancel = 'network';
		await expect(web.cancelChange('email')).rejects.toBe('failed');
	});
});

describe('Telegram', () => {
	it('accepts only a code of 6 to 10 digits (it goes into a t.me link)', async () => {
		h.answers.set = { status: 200, body: { status: 'telegram_code', code: '87654321', bot: 'B' } };
		expect(await web.startTelegram('en')).toEqual({ code: '87654321', bot: 'B' });
		for (const code of ['12345', '12345678901', '1234&x=1', '12 345678', 12345678, null]) {
			h.answers.set = { status: 200, body: { status: 'telegram_code', code, bot: 'B' } };
			await expect(web.startTelegram('en'), String(code)).rejects.toBe('failed');
		}
		h.answers.set = { status: 200, body: { status: 'telegram_code', code: '1234567', bot: {} } };
		expect(await web.startTelegram('en')).toEqual({ code: '1234567', bot: '' });
	});
});

describe('what the site offers', () => {
	const offeredWith = async (body: unknown, raw?: string) => {
		h.answers.channels = raw !== undefined ? { status: 200, raw } : { status: 200, body };
		return web.offeredChannels();
	};

	it('keeps only known channels, once each, with a text bot name (or none)', async () => {
		const o = await offeredWith({
			site: 'S',
			audience: 'r',
			stored: true,
			channels: [
				{ id: 'email' },
				{ id: 'email', bot: 'dupe' },
				{ id: 'fax' },
				null,
				'matrix',
				{ id: 'matrix', bot: { evil: true } },
				{ id: 'xmpp', bot: ['a'] },
				{ id: 'session', bot: 'x'.repeat(500) }
			],
			zero_clearnet: true
		});
		expect(o.channels).toEqual([
			{ id: 'email', bot: undefined },
			{ id: 'matrix', bot: undefined },
			{ id: 'xmpp', bot: undefined },
			{ id: 'session', bot: 'x'.repeat(200) }
		]);
		expect(o).toMatchObject({ site: 'S', audience: 'r', stored: true, zeroClearnet: true });
	});

	it('a strange reply is read as "nothing offered", never thrown', async () => {
		for (const body of [null, [], 'x', { channels: 'all' }, { channels: { id: 'email' } }]) {
			const o = await offeredWith(body);
			expect(o.channels, JSON.stringify(body)).toEqual([]);
		}
		expect((await offeredWith(undefined, 'not json')).channels).toEqual([]);
		const o = await offeredWith({
			site: { html: '<b>' },
			audience: 7,
			stored: 'yes',
			zero_clearnet: 1,
			channels: []
		});
		expect(o).toEqual({
			site: '',
			audience: '',
			stored: false,
			channels: [],
			zeroClearnet: false
		});
		expect((await offeredWith({ site: 'y'.repeat(100_000), channels: [] })).site).toHaveLength(200);
	});

	it('a status reply naming unknown channels or states is ignored', async () => {
		await web.offeredChannels();
		h.answers.status = {
			status: 200,
			body: {
				status: 'ok',
				channels: [
					{ channel: 'email', state: 'on' },
					{ channel: 'fax', state: 'on' },
					{ channel: 'matrix', state: 'weird' },
					null,
					{ channel: 'xmpp', state: 'pending' }
				]
			}
		};
		expect(await web.offlineStatus()).toEqual({ email: 'on', xmpp: 'pending' });
		h.answers.status = { status: 200, body: { status: 'ok', channels: 'nope' } };
		expect(await web.offlineStatus({ fresh: true })).toEqual({});
	});
});

describe('the status is asked once as the page opens', () => {
	beforeEach(() => {
		h.answers.status = {
			status: 200,
			body: { status: 'ok', channels: [{ channel: 'email', state: 'on' }] }
		};
	});

	it('asked together (the card and the heartbeat), it is one request', async () => {
		const [a, b] = await Promise.all([web.offlineStatus(), web.offlineStatus()]);
		expect(a).toEqual({ email: 'on' });
		expect(b).toEqual({ email: 'on' });
		expect(actions()).toEqual(['status']);
		// …and again a moment later (the card mounts after the heartbeat asked).
		expect(await web.offlineStatus()).toEqual({ email: 'on' });
		expect(actions()).toEqual(['status']);
	});

	it('a fresh look, a change she made, or another account asks again', async () => {
		await web.offlineStatus();
		await web.offlineStatus({ fresh: true });
		expect(actions()).toEqual(['status', 'status']);
		h.answers.remove = { status: 200, body: { status: 'removed' } };
		await web.removeChannel('email');
		await web.offlineStatus();
		expect(actions()).toEqual(['status', 'status', 'remove', 'status']);
		h.account = 'grandpa';
		await web.offlineStatus();
		expect(actions()).toEqual(['status', 'status', 'remove', 'status', 'status']);
		expect(h.sent.at(-1)!.body.account).toBe('grandpa');
	});

	it("one account's status still on its way is not handed to the next account", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		h.answers.status = async () => {
			const who = h.sent.at(-1)!.body.account;
			if (who !== 'grandma') return { status: 200, body: { status: 'ok', channels: [] } };
			await gate;
			return {
				status: 200,
				body: { status: 'ok', channels: [{ channel: 'email', state: 'on' }] }
			};
		};
		const hers = web.offlineStatus();
		await expect.poll(actions, POLL).toEqual(['status']);
		h.account = 'grandpa';
		const his = web.offlineStatus();
		// He asks for himself (not waiting on hers), and has his answer before hers comes.
		await expect
			.poll(() => h.sent.map((s) => s.body.account), POLL)
			.toEqual(['grandma', 'grandpa']);
		expect(await his).toEqual({});
		release();
		expect(await hers).toEqual({ email: 'on' });
		expect(h.sent.map((s) => s.body.account)).toEqual(['grandma', 'grandpa']);
		// Her late answer is not kept for him either.
		expect(await web.offlineStatus()).toEqual({});
		expect(actions()).toEqual(['status', 'status']);
	});

	it('the answer is not kept for long', async () => {
		await web.offlineStatus();
		const now = Date.now();
		const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 11_000);
		await web.offlineStatus();
		spy.mockRestore();
		expect(actions()).toEqual(['status', 'status']);
	});

	it('the heartbeat and the card opening together send one status', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		h.answers.status = async () => {
			await gate;
			return { status: 200, body: { status: 'ok', channels: [{ channel: 'email', state: 'on' }] } };
		};
		const stop = web.watchOfflinePresence();
		// The heartbeat's status is on its way when the card opens.
		await expect.poll(actions, POLL).toEqual(['status']);
		const card = web.offlineStatus();
		release();
		expect(await card).toEqual({ email: 'on' });
		// The heartbeat got the same answer and started: nothing else asks after this.
		await expect.poll(actions, POLL).toEqual(['status', 'here']);
		stop();
		await allArrived();
		expect(actions()).toEqual(['status', 'here']);
	});
});

describe('the heartbeat', () => {
	const on = { status: 200, body: { status: 'ok', channels: [{ channel: 'email', state: 'on' }] } };

	it('signs "here" once a minute while she has a channel on, and stops when the effect ends', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		h.answers.status = on;
		const stop = web.watchOfflinePresence();
		await expect.poll(actions, POLL).toEqual(['status', 'here']);
		vi.advanceTimersByTime(60_000);
		await expect.poll(actions, POLL).toEqual(['status', 'here', 'here']);
		stop();
		// A beat still scheduled would begin during this, synchronously.
		vi.advanceTimersByTime(5 * 60_000);
		await allArrived();
		expect(actions()).toEqual(['status', 'here', 'here']);
	});

	it('nothing when no channel is on, or nothing is offered', async () => {
		h.answers.status = {
			status: 200,
			body: { status: 'ok', channels: [{ channel: 'email', state: 'pending' }] }
		};
		// What the layout's watch runs, awaited: once it is done, a heartbeat
		// would have begun.
		await web.resumeOfflinePresence();
		await allArrived();
		expect(actions()).toEqual(['status']);
		h.sent.length = 0;
		h.answers.channels = { status: 200, body: { ...CHANNELS.body, channels: [] } };
		vi.resetModules();
		web = await import('./offlineNotify');
		await web.resumeOfflinePresence();
		await allArrived();
		expect(actions()).toEqual([]);
	});

	it('locked or signed out while the status is on its way: never starts', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		let answer!: (a: typeof on) => void;
		h.answers.status = () => new Promise((r) => (answer = r));
		const stop = web.watchOfflinePresence();
		await expect.poll(actions, POLL).toEqual(['status']);
		// She locks: the layout's effect ends while the answer is still coming.
		stop();
		answer(on);
		// Another look at the status shares that same answer, and is handed it
		// after the heartbeat's code was: once it has it, the heartbeat has
		// decided (and a heartbeat started would have begun its first beat).
		expect(await web.offlineStatus()).toEqual({ email: 'on' });
		vi.advanceTimersByTime(5 * 60_000);
		await allArrived();
		expect(actions()).toEqual(['status']);
	});

	it('locked or signed out while the offer is on its way: does not even ask', async () => {
		let answer!: (a: typeof CHANNELS) => void;
		h.answers.channels = () => new Promise((r) => (answer = r));
		const stop = web.watchOfflinePresence();
		await expect.poll(() => h.channelsCalls, POLL).toBe(1);
		stop();
		answer(CHANNELS);
		// Shares that same offer, handed it after the heartbeat's code was (see above).
		await web.offeredChannels();
		await allArrived();
		expect(actions()).toEqual([]);
	});

	it('the layout effect: ending it before the code is loaded starts nothing; after, stops it', async () => {
		const { offlinePresenceWhileUnlocked } = await import('./offlinePresence');
		const calls: string[] = [];
		let loaded!: () => void;
		const slow = () =>
			new Promise<{ watchOfflinePresence(): () => void }>((r) => {
				loaded = () =>
					r({
						watchOfflinePresence: () => {
							calls.push('watch');
							return () => calls.push('stop');
						}
					});
			});
		const end = offlinePresenceWhileUnlocked(slow);
		end();
		loaded();
		await flush();
		expect(calls).toEqual([]);

		const end2 = offlinePresenceWhileUnlocked(slow);
		loaded();
		await flush();
		expect(calls).toEqual(['watch']);
		end2();
		expect(calls).toEqual(['watch', 'stop']);
	});

	it('the layout effect, with the real requests: lock ends the heartbeat', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		h.answers.status = on;
		const { offlinePresenceWhileUnlocked } = await import('./offlinePresence');
		const end = offlinePresenceWhileUnlocked(() => Promise.resolve(web));
		await expect.poll(actions, POLL).toEqual(['status', 'here']);
		end();
		vi.advanceTimersByTime(3 * 60_000);
		await allArrived();
		expect(actions()).toEqual(['status', 'here']);
	});
});

describe('her address stays in the request and nowhere else', () => {
	it('set / verify / cancel / remove leave nothing in storage, the URL or any request URL', async () => {
		const store = () => {
			const m = new Map<string, string>();
			return {
				get length() {
					return m.size;
				},
				key: (i: number) => [...m.keys()][i] ?? null,
				getItem: (k: string) => m.get(k) ?? null,
				setItem: (k: string, v: string) => void m.set(k, String(v)),
				removeItem: (k: string) => void m.delete(k),
				clear: () => m.clear(),
				dump: () => [...m.entries()]
			};
		};
		const ls = store();
		const ss = store();
		const idbOpened: string[] = [];
		const pushed: unknown[] = [];
		vi.stubGlobal('localStorage', ls);
		vi.stubGlobal('sessionStorage', ss);
		vi.stubGlobal('indexedDB', { open: (n: string) => (idbOpened.push(n), {}) });
		vi.stubGlobal('history', {
			pushState: (...a: unknown[]) => pushed.push(a),
			replaceState: (...a: unknown[]) => pushed.push(a)
		});
		try {
			const ADDRESS = 'grandma.private@example.net';
			h.answers.set = { status: 200, body: { status: 'code_sent' } };
			h.answers.verify = { status: 200, body: { status: 'verified' } };
			h.answers.cancel = { status: 200, body: { status: 'cancelled' } };
			await web.setAddress('email', ` ${ADDRESS} `, 'en');
			await web.verifyCode('email', '123 456');
			await web.setAddress('matrix', '@grandma:matrix.example', 'en');
			await web.cancelChange('matrix');
			await web.removeChannel('all');
			expect(ls.dump()).toEqual([]);
			expect(ss.dump()).toEqual([]);
			expect(idbOpened).toEqual([]);
			expect(pushed).toEqual([]);
			expect(h.sent.every((s) => !s.url.includes('grandma.private'))).toBe(true);
			expect(h.sent.find((s) => s.action === 'set')!.body.address).toBe(ADDRESS);
			// Only the request that sets it carries it.
			const carrying = h.sent.filter((s) => JSON.stringify(s.body).includes('grandma.private'));
			expect(carrying.map((s) => s.action)).toEqual(['set']);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
