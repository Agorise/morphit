// @vitest-environment jsdom
/**
 * Settings → Offline Notifications card, rendered, against a stand-in relay
 * that keeps her channels the way the real one does. Checks what she sees and
 * what is sent when she uses it: the card is not there when the site offers
 * nothing; the senders' names show as text (a Session ID shortened); Cancel
 * while changing an address keeps the address she had; a code that is gone
 * takes her back to the address step; "Delete all" leaves nothing she typed;
 * Telegram is watched without using up the relay's per-account allowance,
 * and the watch ends when the code is on, runs out (she is told), she leaves
 * Settings or deletes everything; right-to-left text keeps addresses and names
 * in their own direction (the real locale text for the Telegram @name); a long
 * site name wraps; a strange reply from the relay does not break the card;
 * nothing she types is kept in the browser (nor offered by its autofill); and
 * on a shared computer, after a lock, a sign-out or another account, the next
 * person sees nothing she typed or was sent.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);

const h = vi.hoisted(() => ({
	locale: null as unknown as import('svelte/store').Writable<string>,
	unlocked: null as unknown as import('svelte/store').Writable<boolean>,
	identity: null as unknown as import('svelte/store').Writable<unknown>,
	account: null as unknown as import('svelte/store').Writable<string | null>,
	/** The words of the real locale files, as the i18n loader gives them. */
	messages: null as null | ((k: string, o?: { values?: Record<string, string> }) => string)
}));

const translate = (k: string, o?: { values?: Record<string, string> }) =>
	h.messages ? h.messages(k, o) : o?.values ? `${k}(${Object.values(o.values).join(',')})` : k;

vi.mock('svelte-i18n', async () => {
	const { writable: w, readable: r } = await import('svelte/store');
	h.locale = w('en');
	return { _: r(translate), locale: h.locale };
});
vi.mock('$lib/i18n', () => ({ t: readable(translate) }));
vi.mock('$lib/stores/identity', async () => {
	const { writable: w } = await import('svelte/store');
	h.unlocked = w(true);
	h.identity = w({ posting: { privateKey: new Uint8Array(32).fill(7) } });
	return { isUnlocked: h.unlocked, liveIdentity: h.identity };
});
// Signatures are checked against the relay's real verifier in
// offlineNotify.relay-parity.test.ts; here the relay is a stand-in.
vi.mock('@beblurt/dblurt', () => ({
	PrivateKey: class {
		sign() {
			return { toString: () => 'SIG' };
		}
	}
}));
vi.mock('$net/config', () => ({
	MORPHIT_RELAY_ORIGIN: 'https://relay.test',
	resolveOrigin: (o: string) => o
}));
vi.mock('$lib/blurt/ops/profile', async () => {
	const { writable: w, get } = await import('svelte/store');
	h.account = w<string | null>('grandma');
	return { getUserBlurtAccount: () => get(h.account), blurtAccountName: h.account };
});

type State = 'on' | 'pending';
interface Row {
	state: State;
	prev: boolean;
}
const relay = {
	offer: {} as Record<string, unknown>,
	rows: new Map<string, Row>(),
	log: [] as Array<{ action: string; body: Record<string, unknown> }>,
	override: {} as Record<string, (b: Record<string, unknown>) => [number, unknown] | undefined>,
	telegramCode: '87654321' as unknown,
	/** Holds the next request for `action` until `open()` (a slow network). */
	gate: null as null | { action: string; wait: Promise<void>; open: () => void },
	hold(action: string) {
		let open!: () => void;
		const wait = new Promise<void>((r) => (open = r));
		this.gate = { action, wait, open };
		return () => open();
	},
	reset() {
		this.offer = {
			site: 'Test Site',
			audience: 'test-relay',
			stored: true,
			channels: [
				{ id: 'email' },
				{ id: 'matrix', bot: '@bot:matrix.test' },
				{ id: 'xmpp', bot: 'bot@xmpp.test' },
				{ id: 'telegram', bot: 'TestNoticeBot' },
				{ id: 'session', bot: '05' + 'ab'.repeat(32) }
			],
			zero_clearnet: false
		};
		this.rows = new Map();
		this.log = [];
		this.override = {};
		this.telegramCode = '87654321';
		this.gate = null;
	},
	answer(action: string, b: Record<string, unknown>): [number, unknown] {
		const o = this.override[action]?.(b);
		if (o) return o;
		const c = String(b.channel);
		switch (action) {
			case 'status':
				return [
					200,
					{
						status: 'ok',
						channels: [...this.rows].map(([channel, r]) => ({ channel, state: r.state }))
					}
				];
			case 'set': {
				const had = this.rows.get(c);
				this.rows.set(c, { state: 'pending', prev: had?.state === 'on' || had?.prev === true });
				return c === 'telegram'
					? [200, { status: 'telegram_code', code: this.telegramCode, bot: 'TestNoticeBot' }]
					: [200, { status: 'code_sent' }];
			}
			case 'verify': {
				const r = this.rows.get(c);
				if (!r || r.state !== 'pending') return [400, { status: 'none' }];
				if (b.code !== '123456') return [400, { status: 'wrong' }];
				this.rows.set(c, { state: 'on', prev: false });
				return [200, { status: 'verified' }];
			}
			case 'remove':
				if (c === 'all') this.rows.clear();
				else this.rows.delete(c);
				return [200, { status: 'removed' }];
			case 'cancel': {
				const r = this.rows.get(c);
				if (r && r.state === 'pending') {
					if (r.prev) this.rows.set(c, { state: 'on', prev: false });
					else this.rows.delete(c);
				}
				return [200, { status: 'cancelled' }];
			}
			case 'here':
				return [200, { status: 'ok' }];
		}
		return [404, { status: 'nope' }];
	}
};

vi.mock('$net/fetchWithTimeout', () => ({
	fetchWithTimeout: async (url: string, init: { body?: string }) => {
		const action = url.split('/').pop()!;
		if (action === 'channels')
			return typeof relay.offer === 'string'
				? new Response(relay.offer as unknown as string, { status: 200 })
				: new Response(JSON.stringify(relay.offer), { status: 200 });
		const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
		relay.log.push({ action, body });
		// The relay answers now; the answer arrives when the gate opens.
		const [status, resp] = relay.answer(action, body);
		const gate = relay.gate;
		if (gate?.action === action) {
			relay.gate = null;
			await gate.wait;
		}
		return new Response(JSON.stringify(resp), { status });
	}
}));

const target = () => document.body.querySelector('#offline-notifications') as HTMLElement | null;
const card = () => {
	const c = target();
	if (!c) throw new Error('card not shown');
	return c;
};
/** What the card asked (the heartbeat's "here", every minute while a channel
 *  is on, is covered in offlineNotify.test.ts). */
const actions = () => relay.log.map((l) => l.action).filter((a) => a !== 'here');
/** Let the card's requests (real promises, WebCrypto hashing) finish. */
async function idle(rounds = 6): Promise<void> {
	const { flushSync } = await import('svelte');
	for (let i = 0; i < rounds; i++) {
		await new Promise<void>((r) => setImmediate(r));
		await new Promise<void>((r) => setImmediate(r));
		flushSync();
	}
}
async function until(cond: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (cond()) return;
		await idle(1);
	}
	throw new Error(`timed out waiting for: ${what}`);
}
function row(label: string): HTMLElement {
	const li = [...card().querySelectorAll<HTMLElement>('ul > li')].find(
		(l) => l.querySelector('span.font-semibold')?.textContent?.trim() === label
	);
	if (!li) throw new Error(`no row ${label}`);
	return li;
}
const rowOf = (c: string) => row(translate(`settings.offline_notify.channel.${c}`));
function button(el: HTMLElement, key: string): HTMLButtonElement {
	const b = [...el.querySelectorAll<HTMLButtonElement>('button')].find((x) =>
		x.textContent?.includes(translate(`settings.offline_notify.${key}`))
	);
	if (!b) throw new Error(`no button ${key} in ${el.textContent}`);
	return b;
}
const hasButton = (el: HTMLElement, key: string) =>
	[...el.querySelectorAll('button')].some((x) =>
		x.textContent?.includes(translate(`settings.offline_notify.${key}`))
	);
async function click(el: HTMLElement): Promise<void> {
	el.click();
	await idle();
}
async function type(input: HTMLInputElement, value: string): Promise<void> {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await idle(1);
}

let mounted: Record<string, unknown> | null = null;
async function render(): Promise<void> {
	const { mount } = await import('svelte');
	const { default: Card } = await import('./OfflineNotificationsCard.svelte');
	const el = document.createElement('div');
	document.body.appendChild(el);
	mounted = mount(Card, { target: el });
	await idle();
}
/** She leaves Settings. */
async function leave(): Promise<void> {
	const { unmount } = await import('svelte');
	if (mounted) await unmount(mounted);
	mounted = null;
	await idle();
}
/** setTimeout / setInterval under the test's control (Telegram's watch, the heartbeat). */
function fakeTimers(): void {
	vi.useRealTimers();
	vi.useFakeTimers({
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
		now: clock
	});
}
async function advance(ms: number): Promise<void> {
	for (let t = 0; t < ms; t += 1000) {
		vi.advanceTimersByTime(1000);
		await idle(4);
	}
}
const statusCount = () => actions().filter((a) => a === 'status').length;

/** Each test an hour after the last: a status answer kept for a few seconds
 *  (offlineNotify shares one as the page opens) never carries over. */
let clock = Date.now();

beforeAll(() => {
	// The same SHA-256, answered at once: WebCrypto answers on another thread,
	// at a moment the card's steps below cannot wait for exactly.
	vi.spyOn(crypto.subtle, 'digest').mockImplementation(
		async (_alg: AlgorithmIdentifier, data: BufferSource) =>
			Uint8Array.from(
				createHash('sha256')
					.update(new Uint8Array(ArrayBuffer.isView(data) ? data.buffer : data))
					.digest()
			).buffer
	);
});

beforeEach(async () => {
	relay.reset();
	clock += 3_600_000;
	vi.useFakeTimers({ toFake: ['Date'], now: clock });
	// The stores are made by the mock factories.
	await import('$lib/stores/identity');
	await import('$lib/blurt/ops/profile');
	await import('svelte-i18n');
	h.locale.set('en');
	h.unlocked.set(true);
	h.account.set('grandma');
	h.messages = null;
	localStorage.clear();
	sessionStorage.clear();
});

afterEach(async () => {
	(await import('$lib/notifications/offlineNotify')).stopOfflinePresence();
	relay.gate?.open();
	if (mounted) await leave();
	document.body.innerHTML = '';
	vi.useRealTimers();
});

describe('when the card is there', () => {
	it('not at all when the site offers nothing and keeps nothing (and nothing is asked about her)', async () => {
		relay.offer = { ...relay.offer, channels: [], stored: false };
		await render();
		expect(target()).toBeNull();
		expect(actions()).toEqual([]);
	});

	it('when the site offers nothing any more but still keeps hers: to turn it off', async () => {
		relay.offer = { ...relay.offer, channels: [] };
		relay.rows.set('email', { state: 'on', prev: false });
		await render();
		await until(() => target() !== null, 'card');
		expect(rowOf('email').textContent).toContain('settings.offline_notify.not_offered');
	});

	it('one status request as it opens, also with the heartbeat asking at the same time', async () => {
		relay.rows.set('email', { state: 'on', prev: false });
		const web = await import('$lib/notifications/offlineNotify');
		const stop = web.watchOfflinePresence();
		await render();
		await until(() => target() !== null && rowOf('email').textContent!.includes('✓'), 'on');
		await idle();
		stop();
		expect(actions().filter((a) => a === 'status')).toEqual(['status']);
	});
});

describe("the senders' names", () => {
	it('are shown as text; a Session ID by its start and end', async () => {
		relay.offer = {
			...relay.offer,
			channels: [
				{ id: 'matrix', bot: '<img src=x onerror="window.__pwned=1">' },
				{ id: 'session', bot: '05' + 'ab'.repeat(32) }
			]
		};
		await render();
		expect(card().querySelector('img')).toBeNull();
		expect(rowOf('matrix').textContent).toContain('<img src=x onerror="window.__pwned=1">');
		const session = rowOf('session').textContent!;
		expect(session).toContain('05abababab…ababab');
		expect(session).not.toContain('ab'.repeat(32));
	});

	it('a reply that is not what the relay sends does not break the card', async () => {
		relay.offer = {
			...relay.offer,
			channels: [
				{ id: 'email' },
				{ id: 'email' },
				{ id: 'fax' },
				null,
				{ id: 'matrix', bot: { evil: true } },
				{ id: 'xmpp', bot: ['x'] }
			],
			site: { not: 'text' }
		};
		const errors: unknown[] = [];
		const onErr = (e: ErrorEvent) => errors.push(e.error);
		window.addEventListener('error', onErr);
		await render();
		window.removeEventListener('error', onErr);
		expect(errors).toEqual([]);
		const labels = [...card().querySelectorAll('ul > li span.font-semibold')].map((s) =>
			s.textContent?.trim()
		);
		expect(labels).toEqual([
			'settings.offline_notify.channel.matrix',
			'settings.offline_notify.channel.xmpp',
			'settings.offline_notify.channel.email'
		]);
	});
});

describe('changing an address', () => {
	async function startChange(): Promise<void> {
		relay.rows.set('email', { state: 'on', prev: false });
		await render();
		await until(() => rowOf('email').textContent!.includes('✓'), 'email on');
		await click(button(rowOf('email'), 'change'));
		await type(rowOf('email').querySelector('input')!, 'new@example.net');
		await click(button(rowOf('email'), 'send_code'));
		await until(() => rowOf('email').textContent!.includes('code_label'), 'code step');
	}

	it('Cancel on the code step keeps the address she had (it is not turned off)', async () => {
		await startChange();
		relay.log = [];
		await click(button(rowOf('email'), 'cancel'));
		await until(() => rowOf('email').textContent!.includes('✓'), 'on again');
		expect(actions()).toEqual(['cancel', 'status']);
		expect(relay.log[0]!.body.channel).toBe('email');
		expect(hasButton(rowOf('email'), 'turn_off')).toBe(true);
		expect(relay.rows.get('email')).toEqual({ state: 'on', prev: false });
	});

	it('with a relay that has no cancel yet: nothing is removed, the card asks again', async () => {
		await startChange();
		relay.override.cancel = () => [404, { status: 'nope' }];
		relay.log = [];
		await click(button(rowOf('email'), 'cancel'));
		await until(() => actions().length === 2, 'cancel and status');
		expect(actions()).toEqual(['cancel', 'status']);
		expect(relay.rows.has('email')).toBe(true);
		expect(rowOf('email').textContent).not.toContain('errors.');
	});

	it('Cancel on a first address drops the waiting one', async () => {
		await render();
		await type(rowOf('xmpp').querySelector('input')!, 'me@xmpp.example');
		await click(button(rowOf('xmpp'), 'send_code'));
		await until(() => rowOf('xmpp').textContent!.includes('code_label'), 'code step');
		await click(button(rowOf('xmpp'), 'cancel'));
		await until(() => rowOf('xmpp').querySelector('input[type="text"]') !== null, 'address step');
		expect(actions()).not.toContain('remove');
		expect(relay.rows.has('xmpp')).toBe(false);
		expect(rowOf('xmpp').querySelector('input')!.value).toBe('');
	});
});

describe('a code that is gone', () => {
	for (const [status, code] of [
		['expired', 400],
		['none', 400],
		['too_many_codes', 429]
	] as const) {
		it(`after "${status}" she is back at the address step, told why`, async () => {
			await render();
			await type(rowOf('email').querySelector('input')!, 'me@example.net');
			await click(button(rowOf('email'), 'send_code'));
			await until(() => rowOf('email').textContent!.includes('code_label'), 'code step');
			relay.override.verify = (b) => {
				relay.rows.delete(String(b.channel));
				return [code, { status }];
			};
			const input = rowOf('email').querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
			await type(input, '654321');
			await click(button(rowOf('email'), 'confirm'));
			await until(() => hasButton(rowOf('email'), 'send_code'), 'address step');
			expect(rowOf('email').querySelector('input[type="email"]')).not.toBeNull();
			expect(rowOf('email').textContent).toContain(`settings.offline_notify.errors.${status}`);
			expect(actions().slice(-2)).toEqual(['verify', 'status']);
		});
	}

	it('a 429 that is not about codes says "too many tries", not "too many codes"', async () => {
		relay.override.set = () => [429, { status: 'rate_limited' }];
		await render();
		await type(rowOf('email').querySelector('input')!, 'me@example.net');
		await click(button(rowOf('email'), 'send_code'));
		expect(rowOf('email').textContent).toContain('settings.offline_notify.errors.rate_limited');
		expect(rowOf('email').textContent).not.toContain('too_many_codes');
	});
});

describe('Delete all my addresses', () => {
	it('also clears what she typed, codes, errors and a change in progress', async () => {
		relay.rows.set('email', { state: 'on', prev: false });
		relay.rows.set('xmpp', { state: 'pending', prev: false });
		await render();
		await until(() => rowOf('email').textContent!.includes('✓'), 'email on');
		await click(button(rowOf('email'), 'change'));
		await type(rowOf('email').querySelector('input')!, 'typed@example.net');
		await type(rowOf('matrix').querySelector('input')!, '@typed:matrix.example');
		await type(
			rowOf('xmpp').querySelector<HTMLInputElement>('input[inputmode="numeric"]')!,
			'111111'
		);
		await click(button(rowOf('xmpp'), 'confirm'));
		await until(() => rowOf('xmpp').textContent!.includes('errors.wrong'), 'wrong code');
		await click(button(card(), 'delete_all'));
		await until(() => card().textContent!.includes('settings.offline_notify.deleted'), 'deleted');
		expect([...card().querySelectorAll('input')].map((i) => i.value)).toEqual(
			Array(card().querySelectorAll('input').length).fill('')
		);
		expect(card().textContent).not.toContain('errors.');
		expect(rowOf('email').textContent).not.toContain('change_hint');
	});
});

describe('Telegram', () => {
	it('the link carries the bot and code encoded; a code that is not digits is refused', async () => {
		relay.override.set = () => {
			relay.rows.set('telegram', { state: 'pending', prev: false });
			return [200, { status: 'telegram_code', code: '87654321', bot: 'Test Bot/../x?y' }];
		};
		await render();
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
		const a = rowOf('telegram').querySelector('a')!;
		expect(a.getAttribute('href')).toBe('https://t.me/Test%20Bot%2F..%2Fx%3Fy?start=87654321');
		await click(button(rowOf('telegram'), 'cancel'));
		relay.override.set = () => [200, { status: 'telegram_code', code: '1&x=y', bot: 'B' }];
		await click(button(rowOf('telegram'), 'telegram_connect'));
		expect(rowOf('telegram').querySelector('a')).toBeNull();
		expect(rowOf('telegram').textContent).toContain('errors.failed');
	});

	it('waits with backoff, stays inside the relay allowance, then offers "Check again"', async () => {
		vi.useRealTimers();
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
			now: clock
		});
		await render();
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
		const t0 = Date.now();
		const statusTimes = () =>
			relay.log.filter((l) => l.action === 'status').map((l) => l.body.timestamp as number);
		const before = statusTimes().length;
		const polls: number[] = [];
		let last = before;
		for (let s = 0; s < 11 * 60; s++) {
			vi.advanceTimersByTime(1000);
			await idle(8);
			const n = statusTimes().length;
			for (; last < n; last++) polls.push(Math.round((Date.now() - t0) / 1000));
		}
		// 5 s, then 15 s later, then every 30 s, for ten minutes.
		expect(polls.slice(0, 4)).toEqual([5, 20, 50, 80]);
		expect(Math.max(...polls)).toBeLessThanOrEqual(600);
		expect(polls.length).toBe(21);
		// Everything this account sent in the busiest ten minutes stays under 30.
		const all = relay.log.filter((l) => l.action !== 'here').length;
		expect(all).toBeLessThan(30);
		expect(hasButton(rowOf('telegram'), 'telegram_check_again')).toBe(true);
		expect(rowOf('telegram').textContent).not.toContain('telegram_waiting');
		// Her code reached the bot meanwhile: "Check again" finds it on.
		relay.rows.set('telegram', { state: 'on', prev: false });
		await click(button(rowOf('telegram'), 'telegram_check_again'));
		await until(() => rowOf('telegram').textContent!.includes('✓'), 'telegram on');
		const sent = relay.log.length;
		vi.advanceTimersByTime(10 * 60_000);
		await idle();
		expect(relay.log.slice(sent).filter((l) => l.action === 'status')).toEqual([]);
	});

	it('Cancel while waiting stops watching', async () => {
		vi.useRealTimers();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: clock });
		await render();
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
		await click(button(rowOf('telegram'), 'cancel'));
		await idle();
		expect(actions().slice(-2)).toEqual(['cancel', 'status']);
		const n = actions().length;
		vi.advanceTimersByTime(5 * 60_000);
		await idle();
		expect(actions().length).toBe(n);
	});
});

describe('right-to-left', () => {
	it('addresses and codes are typed left to right; names and the site keep their own direction', async () => {
		h.locale.set('fa');
		relay.rows.set('xmpp', { state: 'pending', prev: false });
		await render();
		for (const input of card().querySelectorAll('input'))
			expect(input.getAttribute('dir'), input.outerHTML).toBe('ltr');
		expect(rowOf('matrix').textContent).toContain('⁨@bot:matrix.test⁩');
		expect(rowOf('telegram').textContent).toContain('⁨@TestNoticeBot⁩');
		expect(rowOf('xmpp').textContent).toContain('⁨bot@xmpp.test⁩');
		expect(card().textContent).toContain('intro(⁨Test Site⁩)');
		expect(card().textContent).toContain('privacy(⁨Test Site⁩)');
	});

	it('left-to-right: the card itself adds nothing (a copied address stays clean)', async () => {
		await render();
		expect(card().textContent).not.toMatch(/[⁦-⁩]/);
		expect(rowOf('matrix').textContent).toContain('from_bot(@bot:matrix.test)');
	});

	/** The words she reads: the real locale file, through the i18n loader's
	 *  own @handle step (rtlHandle.ts), values filled in. */
	async function realWords(lang: string): Promise<void> {
		const { isolateAtHandles } = await import('$lib/i18n/rtlHandle');
		const { isRtlLocale } = await import('$lib/i18n/locales');
		const json = ((await import(`../i18n/locales/${lang}.json`)) as { default: unknown }).default;
		const dict = isolateAtHandles(json, { literals: isRtlLocale(lang) });
		h.messages = (k, o) => {
			const v = k
				.split('.')
				.reduce<unknown>((n, part) => (n as Record<string, unknown> | undefined)?.[part], dict);
			if (typeof v !== 'string') return k;
			return v.replace(/\{(\w+)\}/g, (m, name: string) => o?.values?.[name] ?? m);
		};
		h.locale.set(lang);
	}
	const telegramSteps = () => rowOf('telegram').querySelector('p')!.textContent!;

	for (const lang of ['en', 'fa']) {
		it(`${lang}: the Telegram bot's @name is isolated once, left to right, as every @{…} is`, async () => {
			await realWords(lang);
			await render();
			await click(button(rowOf('telegram'), 'telegram_connect'));
			await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
			const text = telegramSteps();
			expect(text).toContain('\u2066@TestNoticeBot\u2069');
			expect(text.match(/[\u2066-\u2069]/g)).toEqual(['\u2066', '\u2069']);
		});
	}

	it('en: apart from that @handle, nothing is added anywhere on the card', async () => {
		await realWords('en');
		relay.rows.set('xmpp', { state: 'pending', prev: false });
		await render();
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
		const all = card().textContent!.replace('\u2066@TestNoticeBot\u2069', '');
		expect(all).not.toMatch(/[\u2066-\u2069]/);
		expect(all).toContain('Notes come from @bot:matrix.test.');
		expect(all).toContain('We sent a code from bot@xmpp.test.');
	});
});

describe('a long site name', () => {
	it('wraps (an .onion name has no place to break)', async () => {
		const onion = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion';
		relay.offer = { ...relay.offer, site: onion };
		await render();
		// The page's real utility classes, built by the site's Tailwind setup.
		const postcss = (await import('postcss')).default;
		const tailwind = (await import('tailwindcss')).default;
		const config = (
			(await import(/* @vite-ignore */ '../../../tailwind.config.js' as string)) as {
				default: Record<string, unknown>;
			}
		).default;
		const css = await postcss([
			tailwind({ ...config, content: [{ raw: card().outerHTML, extension: 'html' }] })
		]).process('@tailwind utilities;', { from: undefined });
		const style = document.createElement('style');
		style.textContent = css.css;
		document.head.appendChild(style);
		const paragraphs = [...card().querySelectorAll('p')].filter((p) =>
			p.textContent?.includes(onion)
		);
		expect(paragraphs.map((p) => p.textContent?.slice(0, 30))).toEqual([
			'settings.offline_notify.intro(',
			'settings.offline_notify.privac'
		]);
		for (const p of paragraphs) expect(getComputedStyle(p).overflowWrap).toBe('anywhere');
		style.remove();
	});
});

describe('what she types stays out of the browser', () => {
	it('set, confirm, change, cancel and delete keep nothing in storage, the URL or history', async () => {
		const opened: string[] = [];
		vi.stubGlobal('indexedDB', { open: (n: string) => (opened.push(n), {}) });
		const href = location.href;
		const hist = history.length;
		try {
			await render();
			await type(rowOf('email').querySelector('input')!, 'grandma.private@example.net');
			await click(button(rowOf('email'), 'send_code'));
			await until(() => rowOf('email').textContent!.includes('code_label'), 'code step');
			await type(
				rowOf('email').querySelector<HTMLInputElement>('input[inputmode="numeric"]')!,
				'123456'
			);
			await click(button(rowOf('email'), 'confirm'));
			await until(() => rowOf('email').textContent!.includes('✓'), 'on');
			await click(button(rowOf('email'), 'change'));
			// Once confirmed, the address she typed is not kept on the page.
			expect(rowOf('email').querySelector('input')!.value).toBe('');
			await type(rowOf('email').querySelector('input')!, 'second.private@example.net');
			await click(button(rowOf('email'), 'send_code'));
			await until(() => rowOf('email').textContent!.includes('code_label'), 'code step');
			await click(button(rowOf('email'), 'cancel'));
			await until(() => rowOf('email').textContent!.includes('✓'), 'on');
			await type(rowOf('matrix').querySelector('input')!, '@grandma:matrix.example');
			await click(button(card(), 'delete_all'));
			await idle();
			const kept = JSON.stringify({
				ls: Object.entries(localStorage),
				ss: Object.entries(sessionStorage),
				cookie: document.cookie
			});
			expect(kept).toBe('{"ls":[],"ss":[],"cookie":""}');
			expect(opened).toEqual([]);
			expect(location.href).toBe(href);
			expect(history.length).toBe(hist);
			// Typed addresses are not left in the page either.
			expect(document.body.innerHTML).not.toContain('private@example.net');
			expect([...card().querySelectorAll('input')].map((i) => i.value).join('')).toBe('');
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('a shared computer: the next person sees nothing of hers', () => {
	/** Grandma leaves something in every step: a typed address, a code waiting
	 *  for its number, a change of address, a wrong-code error, a Telegram code. */
	async function grandmaTypes(): Promise<void> {
		relay.rows.set('email', { state: 'on', prev: false });
		relay.rows.set('xmpp', { state: 'pending', prev: false });
		await render();
		await until(() => rowOf('email').textContent!.includes('✓'), 'email on');
		await click(button(rowOf('email'), 'change'));
		await type(rowOf('email').querySelector('input')!, 'grandma.new@example.net');
		await type(rowOf('matrix').querySelector('input')!, '@grandma:matrix.example');
		await type(
			rowOf('xmpp').querySelector<HTMLInputElement>('input[inputmode="numeric"]')!,
			'111111'
		);
		await click(button(rowOf('xmpp'), 'confirm'));
		await until(() => rowOf('xmpp').textContent!.includes('errors.wrong'), 'wrong code');
		await type(
			rowOf('xmpp').querySelector<HTMLInputElement>('input[inputmode="numeric"]')!,
			'222222'
		);
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'telegram code');
	}

	/** Mallory has nothing saved on this site. */
	async function malloryCard(): Promise<void> {
		relay.rows = new Map();
		await until(() => card().querySelector('ul input[type="email"]') !== null, "mallory's card");
		await idle();
	}

	const lastStatusFor = () => relay.log.filter((l) => l.action === 'status').at(-1)!.body.account;

	function expectNothingOfHers(): void {
		for (const input of card().querySelectorAll('input'))
			expect(input.value, input.outerHTML).toBe('');
		expect(card().textContent).not.toContain('87654321');
		expect(card().querySelector('a')).toBeNull();
		expect(card().textContent).not.toContain('errors.');
		expect(card().textContent).not.toContain('✓');
		expect(card().textContent).not.toContain('change_hint');
		expect(card().textContent).not.toContain('code_label');
		expect(document.body.innerHTML).not.toContain('grandma');
	}

	for (const how of ['lock', 'sign-out'] as const) {
		it(`after a ${how}, another account signing in on this tab finds every field empty and no Telegram watch`, async () => {
			fakeTimers();
			await grandmaTypes();
			h.unlocked.set(false);
			if (how === 'sign-out') h.account.set(null);
			await idle();
			expect(card().querySelectorAll('input')).toHaveLength(0);
			h.account.set('mallory');
			h.unlocked.set(true);
			await malloryCard();
			expectNothingOfHers();
			expect(lastStatusFor()).toBe('mallory');
			// Grandma's Telegram code is not watched for (as mallory) either.
			const n = statusCount();
			await advance(11 * 60_000);
			expect(statusCount()).toBe(n);
		});
	}

	it('another account on the same tab without a lock: the same', async () => {
		fakeTimers();
		await grandmaTypes();
		h.account.set('mallory');
		await malloryCard();
		expectNothingOfHers();
		// The card asked about mallory (and shows what mallory has).
		expect(lastStatusFor()).toBe('mallory');
		const n = statusCount();
		await advance(11 * 60_000);
		expect(statusCount()).toBe(n);
	});

	it('her status still on its way when the next person signs in is not shown to them', async () => {
		relay.rows.set('email', { state: 'on', prev: false });
		const open = relay.hold('status');
		await render();
		expect(statusCount()).toBe(1);
		h.unlocked.set(false);
		h.account.set('mallory');
		relay.rows = new Map();
		h.unlocked.set(true);
		await until(() => statusCount() === 2, "mallory's status");
		await idle();
		open();
		await idle();
		expect(card().textContent).not.toContain('✓');
		expect(hasButton(rowOf('email'), 'turn_off')).toBe(false);
	});

	it('an error for her request arriving after the next person signed in is not shown to them', async () => {
		await render();
		relay.override.set = () => [400, { status: 'invalid_address' }];
		await type(rowOf('email').querySelector('input')!, 'grandma@example');
		const open = relay.hold('set');
		button(rowOf('email'), 'send_code').click();
		await idle();
		h.unlocked.set(false);
		h.account.set('mallory');
		h.unlocked.set(true);
		await idle();
		open();
		await idle();
		expect(card().textContent).not.toContain('errors.');
		expect(rowOf('email').querySelector('input')!.value).toBe('');
	});

	it('her Telegram code arriving after the next person signed in is not shown to them', async () => {
		fakeTimers();
		await render();
		const open = relay.hold('set');
		button(rowOf('telegram'), 'telegram_connect').click();
		await idle();
		h.unlocked.set(false);
		h.account.set('mallory');
		h.unlocked.set(true);
		await idle();
		open();
		await idle();
		expect(rowOf('telegram').querySelector('a')).toBeNull();
		expect(card().textContent).not.toContain('87654321');
		const n = statusCount();
		await advance(11 * 60_000);
		expect(statusCount()).toBe(n);
	});
});

describe('a Telegram code that runs out while the card waits', () => {
	it('the watch finds it gone: she is told it expired and can ask again', async () => {
		fakeTimers();
		await render();
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
		relay.rows.delete('telegram');
		await advance(5_000);
		await until(() => hasButton(rowOf('telegram'), 'telegram_connect'), 'connect again');
		expect(rowOf('telegram').textContent).toContain('settings.offline_notify.errors.expired');
		expect(rowOf('telegram').querySelector('a')).toBeNull();
		const n = statusCount();
		await advance(11 * 60_000);
		expect(statusCount()).toBe(n);
	});

	it('"Check again" finds it gone: the same', async () => {
		fakeTimers();
		await render();
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
		await advance(11 * 60_000);
		expect(hasButton(rowOf('telegram'), 'telegram_check_again')).toBe(true);
		relay.rows.delete('telegram');
		await click(button(rowOf('telegram'), 'telegram_check_again'));
		await until(() => hasButton(rowOf('telegram'), 'telegram_connect'), 'connect again');
		expect(rowOf('telegram').textContent).toContain('settings.offline_notify.errors.expired');
	});

	it('when the bot saw her code, it is on and nothing is said to have expired', async () => {
		fakeTimers();
		await render();
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
		relay.rows.set('telegram', { state: 'on', prev: false });
		await advance(5_000);
		await until(() => rowOf('telegram').textContent!.includes('✓'), 'telegram on');
		expect(rowOf('telegram').textContent).not.toContain('errors.');
		// …and the watch stops there.
		const n = statusCount();
		await advance(11 * 60_000);
		expect(statusCount()).toBe(n);
	});
});

describe('the Telegram watch stops', () => {
	it('when she leaves Settings while a look is on its way', async () => {
		fakeTimers();
		await render();
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
		const open = relay.hold('status');
		const before = statusCount();
		vi.advanceTimersByTime(5_000);
		await idle();
		expect(statusCount()).toBe(before + 1);
		await leave();
		open();
		await idle();
		await advance(11 * 60_000);
		expect(statusCount()).toBe(before + 1);
	});

	it('when she deletes all her addresses', async () => {
		fakeTimers();
		relay.rows.set('email', { state: 'on', prev: false });
		await render();
		await until(() => rowOf('email').textContent!.includes('✓'), 'email on');
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
		await click(button(card(), 'delete_all'));
		await until(() => card().textContent!.includes('settings.offline_notify.deleted'), 'deleted');
		const n = statusCount();
		await advance(11 * 60_000);
		expect(statusCount()).toBe(n);
		expect(card().textContent).not.toContain('errors.');
	});
});

describe('the heartbeat', () => {
	it('stops when she turns off her last channel', async () => {
		fakeTimers();
		relay.rows.set('email', { state: 'on', prev: false });
		await render();
		await until(() => rowOf('email').textContent!.includes('✓'), 'email on');
		const beats = () => relay.log.filter((l) => l.action === 'here').length;
		const first = beats();
		await advance(60_000);
		expect(beats()).toBe(first + 1);
		await click(button(rowOf('email'), 'turn_off'));
		await until(() => !rowOf('email').textContent!.includes('✓'), 'off');
		const after = beats();
		await advance(3 * 60_000);
		expect(beats()).toBe(after);
	});
});

describe('"Use a different address"', () => {
	it('Cancel goes back to "On" with nothing sent, and forgets what she typed', async () => {
		relay.rows.set('email', { state: 'on', prev: false });
		await render();
		await until(() => rowOf('email').textContent!.includes('✓'), 'email on');
		await click(button(rowOf('email'), 'change'));
		await type(rowOf('email').querySelector('input')!, 'other@example.net');
		const sent = relay.log.length;
		await click(button(rowOf('email'), 'cancel'));
		expect(rowOf('email').querySelector('input')).toBeNull();
		expect(hasButton(rowOf('email'), 'turn_off')).toBe(true);
		expect(relay.log.slice(sent).map((l) => l.action)).toEqual([]);
		await click(button(rowOf('email'), 'change'));
		expect(rowOf('email').querySelector('input')!.value).toBe('');
	});

	it('no Cancel on a first address (there is nothing to go back to)', async () => {
		await render();
		expect(hasButton(rowOf('email'), 'cancel')).toBe(false);
	});
});

describe('Cancel waits for a request already on its way', () => {
	it('on the code step, while Confirm is sent', async () => {
		await render();
		await type(rowOf('email').querySelector('input')!, 'me@example.net');
		await click(button(rowOf('email'), 'send_code'));
		await until(() => rowOf('email').textContent!.includes('code_label'), 'code step');
		await type(
			rowOf('email').querySelector<HTMLInputElement>('input[inputmode="numeric"]')!,
			'123456'
		);
		const open = relay.hold('verify');
		button(rowOf('email'), 'confirm').click();
		await idle();
		expect(button(rowOf('email'), 'cancel').disabled).toBe(true);
		open();
		await until(() => rowOf('email').textContent!.includes('✓'), 'on');
		expect(actions()).not.toContain('cancel');
	});

	it('after "Use a different address", while her code is being sent', async () => {
		relay.rows.set('email', { state: 'on', prev: false });
		await render();
		await until(() => rowOf('email').textContent!.includes('✓'), 'email on');
		await click(button(rowOf('email'), 'change'));
		await type(rowOf('email').querySelector('input')!, 'other@example.net');
		const open = relay.hold('set');
		button(rowOf('email'), 'send_code').click();
		await idle();
		expect(button(rowOf('email'), 'cancel').disabled).toBe(true);
		open();
		await until(() => rowOf('email').textContent!.includes('code_label'), 'code step');
	});

	it('Telegram, while "Check again" looks', async () => {
		fakeTimers();
		await render();
		await click(button(rowOf('telegram'), 'telegram_connect'));
		await until(() => rowOf('telegram').querySelector('a') !== null, 'link');
		await advance(11 * 60_000);
		const open = relay.hold('status');
		button(rowOf('telegram'), 'telegram_check_again').click();
		await idle();
		expect(button(rowOf('telegram'), 'cancel').disabled).toBe(true);
		open();
		await idle();
		expect(button(rowOf('telegram'), 'cancel').disabled).toBe(false);
	});
});

describe('her addresses stay out of the browser autofill', () => {
	it('every address field, email too, asks the browser not to save it', async () => {
		await render();
		const fields = [...card().querySelectorAll<HTMLInputElement>('input')].filter(
			(i) => i.getAttribute('inputmode') !== 'numeric'
		);
		expect(fields.map((i) => i.getAttribute('aria-label'))).toEqual(
			['matrix', 'session', 'xmpp', 'email'].map((c) => `settings.offline_notify.channel.${c}`)
		);
		for (const f of fields) expect(f.getAttribute('autocomplete'), f.outerHTML).toBe('off');
	});
});
