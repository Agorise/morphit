/**
 * C-L5 — one chat-activity stream per browser, not one per tab.
 *
 * Over Tor and I2P a browser allows about six HTTP/1.1 connections per site.
 * Each tab held its own activity stream open, so a few tabs used them all up:
 * live chat stopped and ordinary page requests stalled. Now the tabs of one
 * account elect a holder over a BroadcastChannel; it keeps the stream and
 * passes every event to the others. When it goes, another tab opens the
 * stream and gets the same catch-up a reconnect gets (the indexer's replay,
 * then `ready`).
 *
 * Each "tab" below is a fresh instance of the real module; BroadcastChannel,
 * EventSource and the timers are fakes shared by all of them, as they are
 * shared by the tabs of one browser. A tab can be frozen (a suspended
 * background tab): its timers and channel messages wait until it resumes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TabEnv {
	id: number;
	account: string | null;
	live: boolean;
	ticket: boolean;
	setLive: (v: boolean) => void;
	/** Sets the account name and tells its subscribers. */
	setAccount: (a: string | null) => void;
}

/** This tab's account, session and ticket: registered before each tab's
 *  fresh import of the module, so every instance has its own. */
function mockTab(t: TabEnv): void {
	vi.doMock('$lib/chat/streamTicket', () => ({
		withStreamTicket: (p: string, a: string) =>
			t.ticket ? `${p}${p.includes('?') ? '&' : '?'}ticket=T-${a}-${t.id}` : null
	}));
	vi.doMock('$blurt/ops/profile', async () => {
		const { writable } = await import('svelte/store');
		const name = writable(t.account);
		t.setAccount = (a) =>
			runAs(t.id, () => {
				t.account = a;
				name.set(a);
			});
		return { getUserBlurtAccount: () => t.account, blurtAccountName: name };
	});
	vi.doMock('$stores/identity', async () => {
		const { writable } = await import('svelte/store');
		const s = writable(t.live);
		t.setLive = (v: boolean) =>
			runAs(t.id, () => {
				t.live = v;
				s.set(v);
			});
		return { hasAnySession: { subscribe: s.subscribe } };
	});
}
vi.mock('$lib/chat/chatFolders', () => ({
	folderOf: () => 'inbox',
	restoreThread: () => undefined
}));
vi.mock('$lib/notifications/chatThread', () => ({
	chatThreadFromClickPath: () => null,
	dismissChatNotificationsFor: async () => undefined
}));

// ── which tab is running, and frozen tabs ───────────────────────────────────

let currentTab = 0;
const frozen = new Set<number>();
/** Tabs whose timers run only when the test releases them (a hidden tab's
 *  chained timers under Chrome's intensive throttling: once a minute); their
 *  channel messages still arrive. */
const throttled = new Set<number>();
/** A frozen tab's due timer callbacks (one per timer) and channel messages. */
const heldTimers = new Map<number, Map<object, () => void>>();
const heldMessages = new Map<number, { run: () => void; type: unknown }[]>();
const timerKeys = new Map<unknown, { owner: number; key: object }>();

function runAs<T>(tab: number, fn: () => T): T {
	const prev = currentTab;
	currentTab = tab;
	try {
		return fn();
	} finally {
		currentTab = prev;
	}
}

function fireAs(owner: number, key: object, call: () => void): void {
	if (frozen.has(owner) || throttled.has(owner)) {
		const m = heldTimers.get(owner) ?? new Map<object, () => void>();
		heldTimers.set(owner, m);
		m.set(key, call);
		return;
	}
	runAs(owner, call);
}

// ── fakes shared by every tab ────────────────────────────────────────────────

class FakeES {
	static all: FakeES[] = [];
	/** The next constructions that throw. */
	static throwNext = 0;
	readyState = 1;
	readonly owner = currentTab;
	private l = new Map<string, ((ev: { data: string }) => void)[]>();
	constructor(readonly url: string) {
		if (FakeES.throwNext > 0) {
			FakeES.throwNext--;
			throw new Error('SyntaxError');
		}
		FakeES.all.push(this);
	}
	addEventListener(type: string, fn: (ev: { data: string }) => void): void {
		this.l.set(type, [...(this.l.get(type) ?? []), fn]);
	}
	emit(type: string, data: unknown = {}): void {
		if (this.readyState === 2) throw new Error('emit on a closed stream');
		runAs(this.owner, () => {
			for (const fn of this.l.get(type) ?? []) fn({ data: JSON.stringify(data) });
		});
	}
	close(): void {
		this.readyState = 2;
	}
	/** The server refused it (403/429): CLOSED, then `error`. */
	httpError(): void {
		this.readyState = 2;
		runAs(this.owner, () => {
			for (const fn of this.l.get('error') ?? []) fn({ data: '' });
		});
	}
	/** The tab that opened it. */
	get tab(): number {
		return this.owner;
	}
}

/** BroadcastChannel: same name, other instances, delivered asynchronously,
 *  never to the sender, never to a closed channel. `cut` drops delivery
 *  between two tabs (a test-made partition, to force two holders). */
class FakeBC {
	static open = new Set<FakeBC>();
	static cut = new Set<string>();
	readonly tab = currentTab;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	private closed = false;
	constructor(readonly name: string) {
		FakeBC.open.add(this);
	}
	postMessage(data: unknown): void {
		if (this.closed) throw new Error('InvalidStateError');
		const copy = structuredClone(data);
		for (const o of FakeBC.open) {
			if (o === this || o.name !== this.name) continue;
			if (FakeBC.cut.has(`${this.tab}|${o.tab}`) || FakeBC.cut.has(`${o.tab}|${this.tab}`))
				continue;
			void Promise.resolve().then(() => o.deliver(copy));
		}
	}
	private deliver(data: unknown): void {
		const run = (): void => {
			if (this.closed) return;
			runAs(this.tab, () => this.onmessage?.({ data }));
		};
		if (frozen.has(this.tab)) {
			const q = heldMessages.get(this.tab) ?? [];
			heldMessages.set(this.tab, q);
			q.push({ run, type: (data as { type?: unknown } | null)?.type });
			return;
		}
		run();
	}
	close(): void {
		this.closed = true;
		FakeBC.open.delete(this);
	}
}

// ── tabs ─────────────────────────────────────────────────────────────────────

interface Got {
	fast: { peer: string; order: string; atMs: number | undefined }[];
	pings: { peer: string }[];
	fires: number;
}
interface Tab {
	env: TabEnv;
	got: Got;
	stop: () => void;
}

let nextId = 1;
let idCounter = 0;
let tabs: Tab[] = [];
/** Set by a test to cut the next tab off from another as it opens. */
let nextCut: ((id: number) => void) | null = null;

async function settle(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function openTab(
	account: string | null,
	opts: { live?: boolean; ticket?: boolean } = {}
): Promise<Tab> {
	vi.resetModules();
	const env: TabEnv = {
		id: nextId++,
		account,
		live: opts.live ?? true,
		ticket: opts.ticket ?? true,
		setLive: () => undefined,
		setAccount: () => undefined
	};
	mockTab(env);
	const mod = await import('./globalChatActivityStream');
	const got: Got = { fast: [], pings: [], fires: 0 };
	mod.subscribeFastPush((peer, order, atMs) => got.fast.push({ peer, order, atMs }));
	mod.subscribeChatActivityPings((p) => got.pings.push(p));
	mod.subscribeChatActivity(() => {
		got.fires++;
	});
	nextCut?.(env.id);
	let stopped = false;
	const stopMod = runAs(env.id, () => mod.startGlobalChatActivity());
	const tab: Tab = {
		env,
		got,
		stop: () => {
			if (stopped) return;
			stopped = true;
			runAs(env.id, stopMod);
		}
	};
	tabs.push(tab);
	await settle();
	return tab;
}

/** Run a throttled tab's due timers, once each. */
async function releaseTimers(t: Tab): Promise<void> {
	const timers = [...(heldTimers.get(t.env.id)?.values() ?? [])];
	heldTimers.delete(t.env.id);
	for (const f of timers) runAs(t.env.id, f);
	await settle();
}

/** Freeze a tab: its timers and channel messages wait. */
function freeze(t: Tab): void {
	frozen.add(t.env.id);
}

/** Resume a frozen tab: its due timers run once each, its held messages are
 *  delivered; `first` says which comes first (a browser does not promise an
 *  order): its timers, its messages, the new holder's heartbeats alone, or
 *  an event from its own stream. */
async function resume(
	t: Tab,
	first: 'timers' | 'messages' | 'heartbeats' | 'stream',
	es?: FakeES
): Promise<void> {
	const id = t.env.id;
	frozen.delete(id);
	const messages = heldMessages.get(id) ?? [];
	heldMessages.delete(id);
	// Read when they run: a timer cleared meanwhile does not fire.
	const runTimers = (): void => {
		const timers = [...(heldTimers.get(id)?.values() ?? [])];
		heldTimers.delete(id);
		for (const f of timers) runAs(id, f);
	};
	const runMessages = (): void => {
		for (const m of messages) m.run();
	};
	if (first === 'heartbeats') {
		for (const m of messages.filter((x) => x.type === 'hb')) m.run();
		await settle();
		const rest = messages.filter((x) => x.type !== 'hb');
		messages.length = 0;
		messages.push(...rest);
	}
	if (first === 'stream') {
		es!.emit('chat_activity', { ...FRAME, order: 'while-frozen' });
		await settle();
	}
	if (first === 'messages' || first === 'heartbeats') {
		runMessages();
		await settle();
		runTimers();
	} else {
		runTimers();
		await settle();
		runMessages();
	}
	await settle();
}

const openStreams = (): FakeES[] => FakeES.all.filter((e) => e.readyState !== 2);
const theStream = (): FakeES => {
	const open = openStreams();
	expect(open, 'exactly one activity stream open').toHaveLength(1);
	return open[0]!;
};
const theCarol = (): FakeES => {
	const open = openStreams().filter((e) => e.url.startsWith('/v1/chat-activity/carol/'));
	expect(open).toHaveLength(1);
	return open[0]!;
};
const tabOf = (es: FakeES): Tab => tabs.find((t) => t.env.id === es.tab)!;

const FRAME = { peer: 'alice', order: 'sell-1', inbound: true, at: null };

/** Bounds from the design: a heartbeat about every second, a takeover after
 *  about 2.5–3 s of silence. */
const QUIET_OK_MS = 2_000;
const TAKEOVER_BY_MS = 4_500;
/** A goodbye hands over well inside the silence window. */
const GOODBYE_BY_MS = 1_000;

beforeEach(() => {
	vi.useFakeTimers();
	FakeES.all = [];
	FakeES.throwNext = 0;
	FakeBC.open.clear();
	FakeBC.cut.clear();
	frozen.clear();
	throttled.clear();
	heldTimers.clear();
	heldMessages.clear();
	timerKeys.clear();
	tabs = [];
	currentTab = 0;
	idCounter = 0;
	vi.stubGlobal('window', globalThis);
	vi.stubGlobal('EventSource', FakeES);
	vi.stubGlobal('BroadcastChannel', FakeBC);
	vi.stubGlobal('navigator', {});
	// Tab ids rise in the order tabs join: the first tab has the lowest.
	vi.stubGlobal('crypto', {
		getRandomValues: (b: Uint8Array) => {
			b.fill(0);
			b[b.length - 1] = ++idCounter;
			return b;
		}
	});
	// Timers run as the tab that set them, and wait while it is frozen.
	const st = globalThis.setTimeout;
	const si = globalThis.setInterval;
	const ct = globalThis.clearTimeout;
	const ci = globalThis.clearInterval;
	const wrap =
		(make: typeof setTimeout | typeof setInterval) =>
		(fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]): unknown => {
			const owner = currentTab;
			const key = {};
			const handle = (make as (f: () => void, ms?: number) => unknown)(
				() => fireAs(owner, key, () => fn(...a)),
				ms
			);
			timerKeys.set(handle, { owner, key });
			return handle;
		};
	const unwrap =
		(clear: typeof clearTimeout) =>
		(handle: unknown): void => {
			const k = timerKeys.get(handle);
			if (k !== undefined) heldTimers.get(k.owner)?.delete(k.key);
			clear(handle as Parameters<typeof clearTimeout>[0]);
		};
	vi.stubGlobal('setTimeout', wrap(st));
	vi.stubGlobal('setInterval', wrap(si));
	vi.stubGlobal('clearTimeout', unwrap(ct));
	vi.stubGlobal('clearInterval', unwrap(ci));
});
afterEach(() => {
	frozen.clear();
	throttled.clear();
	for (const t of tabs) t.stop();
	tabs = [];
	nextCut = null;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('C-L5: the tabs of one account share one activity stream', () => {
	it('three tabs, opened apart or together, open exactly one stream and keep it at one', async () => {
		// Apart: each opens between two heartbeats, so only an answer to its
		// `hello` tells it the stream is held.
		await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_400);
		await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_400);
		await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_400);
		expect(theStream().url).toMatch(/^\/v1\/chat-activity\/bob\/stream\?ticket=T-bob-\d+$/);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(openStreams()).toHaveLength(1);
		expect(FakeES.all, 'no stream opened and dropped along the way').toHaveLength(1);
		// Three more, all at the same moment, for another account.
		await openTab('carol');
		await openTab('carol');
		await openTab('carol');
		await vi.advanceTimersByTimeAsync(10_000);
		const carol = FakeES.all.filter((e) => e.url.startsWith('/v1/chat-activity/carol/'));
		expect(carol).toHaveLength(1);
		expect(openStreams()).toHaveLength(2);
	});

	it('an event at the stream reaches every tab once, and only tabs of that account', async () => {
		const t1 = await openTab('bob');
		const t2 = await openTab('bob');
		const t3 = await openTab('bob');
		const other = await openTab('carol');
		await vi.advanceTimersByTimeAsync(2_000);
		const es = openStreams().find((e) => e.url.startsWith('/v1/chat-activity/bob/'))!;
		es.emit('chat_activity', FRAME);
		es.emit('ready');
		await settle();
		await vi.advanceTimersByTimeAsync(300);
		for (const t of [t1, t2, t3]) {
			expect(t.got.fast).toEqual([{ peer: 'alice', order: 'sell-1', atMs: undefined }]);
			expect(t.got.pings).toHaveLength(1);
			expect(t.got.fires).toBe(1);
		}
		expect(other.got.fast).toEqual([]);
		expect(other.got.pings).toEqual([]);
	});

	it('Web Locks present: the tabs still elect over the channel and take no lock', async () => {
		let requests = 0;
		vi.stubGlobal('navigator', {
			locks: {
				request: () => {
					requests++;
					return new Promise(() => undefined);
				}
			}
		});
		await openTab('bob');
		await openTab('bob');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(openStreams()).toHaveLength(1);
		expect(requests).toBe(0);
	});

	it('the holder closes (goodbye): another tab opens the stream at once and every tab gets the catch-up', async () => {
		await openTab('bob');
		await openTab('bob');
		await openTab('bob');
		await vi.advanceTimersByTimeAsync(2_000);
		const first = theStream();
		const leader = tabOf(first);
		leader.stop();
		await settle();
		expect(first.readyState).toBe(2);
		await vi.advanceTimersByTimeAsync(GOODBYE_BY_MS);
		const next = theStream();
		expect(next.tab).not.toBe(leader.env.id);
		const at = Date.now() - 4_000;
		next.emit('chat_activity', { ...FRAME, order: 'sell-2', at });
		next.emit('ready');
		await settle();
		await vi.advanceTimersByTimeAsync(300);
		const rest = tabs.filter((t) => t !== leader);
		for (const t of rest) {
			expect(t.got.fast).toEqual([{ peer: 'alice', order: 'sell-2', atMs: at }]);
			expect(t.got.fires).toBe(1);
		}
		await vi.advanceTimersByTimeAsync(30_000);
		expect(FakeES.all, 'one takeover, no extra streams').toHaveLength(2);
	});

	it('the holder crashes (no goodbye): another tab takes over once the heartbeats stop', async () => {
		await openTab('bob');
		await openTab('bob');
		await openTab('bob');
		await vi.advanceTimersByTimeAsync(2_000);
		const first = theStream();
		const leader = tabOf(first);
		// A crash: it runs nothing again and says nothing.
		freeze(leader);
		first.close();
		await vi.advanceTimersByTimeAsync(QUIET_OK_MS);
		expect(openStreams(), 'not before the silence window').toHaveLength(0);
		await vi.advanceTimersByTimeAsync(TAKEOVER_BY_MS - QUIET_OK_MS);
		const next = theStream();
		expect(next.tab).not.toBe(leader.env.id);
		next.emit('chat_activity', { ...FRAME, at: Date.now() - 3_000 });
		next.emit('ready');
		await settle();
		await vi.advanceTimersByTimeAsync(300);
		for (const t of tabs.filter((x) => x !== leader)) {
			expect(t.got.fast).toHaveLength(1);
			expect(t.got.fires).toBe(1);
		}
		await vi.advanceTimersByTimeAsync(30_000);
		expect(FakeES.all).toHaveLength(2);
	});

	it('two tabs that both hold the stream settle on one, and a tab hearing both handles each event once', async () => {
		const t1 = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		const t3 = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		// t2 cannot hear t1 (nor t1 t2): it takes the stream too.
		nextCut = (id) => FakeBC.cut.add(`${t1.env.id}|${id}`);
		const t2 = await openTab('bob');
		nextCut = null;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(openStreams()).toHaveLength(2);
		const [a, b] = openStreams() as [FakeES, FakeES];
		// The same message reaches both streams; t3 hears both relays.
		a.emit('chat_activity', FRAME);
		b.emit('chat_activity', FRAME);
		await settle();
		expect(t3.got.fast, 'the duplicate is not handled twice').toHaveLength(1);
		expect(t3.got.pings).toHaveLength(1);
		// They can hear each other again: one stays, the other closes at once.
		FakeBC.cut.clear();
		await vi.advanceTimersByTimeAsync(1_500);
		expect(openStreams()).toHaveLength(1);
		expect(FakeES.all).toHaveLength(2);
		const kept = theStream();
		kept.emit('chat_activity', { ...FRAME, order: 'sell-9' });
		await settle();
		for (const t of [t1, t2, t3]) {
			expect(t.got.fast.filter((f) => f.order === 'sell-9')).toHaveLength(1);
		}
		await vi.advanceTimersByTimeAsync(30_000);
		expect(openStreams()).toHaveLength(1);
		expect(FakeES.all).toHaveLength(2);
	});

	it('after two holders, identical genuine pings seconds apart are each handled', async () => {
		const t1 = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		const t3 = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		nextCut = (id) => FakeBC.cut.add(`${t1.env.id}|${id}`);
		const t2 = await openTab('bob');
		nextCut = null;
		await vi.advanceTimersByTimeAsync(5_000);
		const s1 = openStreams().find((e) => e.tab === t1.env.id)!;
		const s2 = openStreams().find((e) => e.tab === t2.env.id)!;
		// A ping only t2's stream had.
		s2.emit('chat_activity', FRAME);
		await settle();
		expect(t3.got.fast).toHaveLength(1);
		// Healed: t1 (lower id) keeps the stream.
		FakeBC.cut.clear();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(theStream()).toBe(s1);
		// The same sender writes again, twice, two seconds apart: new messages.
		s1.emit('chat_activity', FRAME);
		await settle();
		await vi.advanceTimersByTimeAsync(2_000);
		s1.emit('chat_activity', FRAME);
		await settle();
		expect(t3.got.fast, 'each genuine ping is handled').toHaveLength(3);
		expect(t2.got.fast.length).toBeGreaterThanOrEqual(2);
	});

	it('the holder locks or signs out: it says so, and another tab takes over at once', async () => {
		await openTab('bob');
		await openTab('bob');
		await vi.advanceTimersByTimeAsync(2_000);
		const first = theStream();
		const leader = tabOf(first);
		const other = tabs.find((t) => t !== leader)!;
		leader.env.setLive(false);
		await settle();
		expect(first.readyState).toBe(2);
		await vi.advanceTimersByTimeAsync(GOODBYE_BY_MS);
		expect(theStream().tab).toBe(other.env.id);
		theStream().emit('chat_activity', FRAME);
		await settle();
		expect(other.got.fast).toHaveLength(1);
		expect(leader.got.fast).toEqual([]);
		// Unlocked again: it follows the open stream instead of opening another.
		leader.env.setLive(true);
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(theStream().tab).toBe(other.env.id);
		theStream().emit('chat_activity', FRAME);
		await settle();
		expect(leader.got.fast).toHaveLength(1);
		// Signed out everywhere: nothing open, nothing listening.
		leader.env.setLive(false);
		other.env.setLive(false);
		await settle();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(openStreams()).toHaveLength(0);
		expect(FakeBC.open.size).toBe(0);
	});

	it('a tab with no ticket does not hold the stream; once it has one it waits its turn', async () => {
		const t1 = await openTab('bob', { ticket: false });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(openStreams()).toHaveLength(0);
		const t2 = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		expect(theStream().tab).toBe(t2.env.id);
		t1.env.ticket = true;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(theStream().tab).toBe(t2.env.id);
		t2.stop();
		await settle();
		await vi.advanceTimersByTimeAsync(GOODBYE_BY_MS);
		expect(theStream().tab).toBe(t1.env.id);
	});
});

describe('C-L5 review: account, freeze and failing streams', () => {
	it('a session that flips on before its account name is set never joins the old name', async () => {
		const bob = await openTab('bob');
		await vi.advanceTimersByTimeAsync(2_000);
		const bobEs = theStream();
		// A tab signing in as carol where bob's name is still remembered.
		const x = await openTab('bob', { live: false });
		await vi.advanceTimersByTimeAsync(1_000);
		x.env.setLive(true);
		x.env.setAccount('carol');
		await settle();
		bobEs.emit('chat_activity', FRAME);
		await settle();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(bob.got.fast).toHaveLength(1);
		expect(x.got.fast, "never handles the other account's events").toEqual([]);
		expect(x.got.pings).toEqual([]);
		const xs = FakeES.all.filter((e) => e.tab === x.env.id);
		expect(xs.map((e) => e.url.split('/')[3])).toEqual(['carol']);
	});

	it('a session with no account name yet joins nothing, then its own account once named', async () => {
		await openTab('bob');
		await vi.advanceTimersByTimeAsync(2_000);
		const bobEs = theStream();
		const x = await openTab(null, { live: false });
		x.env.setLive(true);
		await settle();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(FakeBC.open.size, 'no channel joined without a name').toBe(1);
		x.env.setAccount('carol');
		await settle();
		await vi.advanceTimersByTimeAsync(1_000);
		const carol = openStreams().find((e) => e.url.startsWith('/v1/chat-activity/carol/'));
		expect(carol?.tab).toBe(x.env.id);
		bobEs.emit('chat_activity', FRAME);
		await settle();
		expect(x.got.fast).toEqual([]);
	});

	it("a tab whose account changed unannounced drops the old account's relayed events", async () => {
		await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		const x = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		const bobEs = theStream();
		// The name changed in storage only: no store update reached this tab.
		x.env.account = 'carol';
		bobEs.emit('chat_activity', FRAME);
		await settle();
		expect(x.got.fast).toEqual([]);
		expect(x.got.pings).toEqual([]);
	});

	it("a holder whose account changed unannounced drops its own stream's events", async () => {
		const x = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		const es = theStream();
		x.env.account = 'carol';
		es.emit('chat_activity', FRAME);
		await settle();
		expect(x.got.fast).toEqual([]);
	});

	it("a follower whose account changed unannounced never takes the old account's stream", async () => {
		const bob = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		const x = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		x.env.account = 'carol';
		bob.stop();
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		const xs = FakeES.all.filter((e) => e.tab === x.env.id);
		expect(xs.every((e) => e.url.startsWith('/v1/chat-activity/carol/'))).toBe(true);
	});

	it('a tab that switches account forgets the copies it saw for the old one', async () => {
		const t1 = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		const x = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		nextCut = (id) => FakeBC.cut.add(`${t1.env.id}|${id}`);
		await openTab('bob');
		nextCut = null;
		await vi.advanceTimersByTimeAsync(5_000);
		// x hears two bob holders, and handles a ping from one.
		openStreams()
			.find((e) => e.tab === t1.env.id)!
			.emit('chat_activity', FRAME);
		await settle();
		expect(x.got.fast).toHaveLength(1);
		// Now carol: its own stream's first ping, with the same text, is new.
		x.env.setAccount('carol');
		await settle();
		await vi.advanceTimersByTimeAsync(300);
		const carolEs = theCarol();
		expect(carolEs.tab).toBe(x.env.id);
		carolEs.emit('chat_activity', FRAME);
		await settle();
		expect(x.got.fast).toHaveLength(2);
	});

	for (const first of ['timers', 'messages', 'heartbeats', 'stream'] as const) {
		it(`a frozen holder that resumes (${first} first) stands down, though its id is lower`, async () => {
			const t1 = await openTab('bob');
			await vi.advanceTimersByTimeAsync(1_000);
			const t2 = await openTab('bob');
			const t3 = await openTab('bob');
			await vi.advanceTimersByTimeAsync(1_000);
			const old = theStream();
			expect(old.tab).toBe(t1.env.id);
			freeze(t1);
			await vi.advanceTimersByTimeAsync(TAKEOVER_BY_MS);
			const current = openStreams().find((e) => e.tab !== t1.env.id)!;
			expect(current.tab).toBe(t2.env.id);
			await resume(t1, first, old);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(old.readyState).toBe(2);
			expect(theStream()).toBe(current);
			expect(FakeES.all, 'no second takeover').toHaveLength(2);
			// Its stream's event, relayed in its old term, is not handled by
			// the others (the current holder's own stream carries it).
			expect(t3.got.fast.filter((f) => f.order === 'while-frozen')).toEqual([]);
			current.emit('chat_activity', { ...FRAME, order: 'after' });
			await settle();
			for (const t of [t1, t2, t3]) {
				expect(t.got.fast.filter((f) => f.order === 'after')).toHaveLength(1);
			}
		});
	}

	it('a hidden holder whose heartbeat runs once a minute keeps the stream while it answers', async () => {
		const t1 = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		await openTab('bob');
		await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		const es = theStream();
		expect(es.tab).toBe(t1.env.id);
		throttled.add(t1.env.id);
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(60_000);
			await releaseTimers(t1);
		}
		expect(theStream()).toBe(es);
		expect(FakeES.all, 'no takeover while it lives').toHaveLength(1);
		es.emit('chat_activity', FRAME);
		await settle();
		for (const t of tabs) expect(t.got.fast).toHaveLength(1);
	});

	it('a holder whose EventSource cannot be made tries again after the pause', async () => {
		FakeES.throwNext = 1;
		const t1 = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		expect(openStreams()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(theStream().tab).toBe(t1.env.id);
	});

	it('a holder whose stream keeps closing without `ready` lets another tab hold it', async () => {
		const t1 = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		const t2 = await openTab('bob');
		await vi.advanceTimersByTimeAsync(1_000);
		theStream().httpError();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(theStream().tab).toBe(t1.env.id);
		theStream().httpError();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(theStream().tab).toBe(t1.env.id);
		theStream().httpError();
		await vi.advanceTimersByTimeAsync(GOODBYE_BY_MS);
		expect(theStream().tab).toBe(t2.env.id);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(theStream().tab).toBe(t2.env.id);
	});
});

describe('C-L5 fallback: without BroadcastChannel, one stream per tab as before', () => {
	it('no BroadcastChannel: each tab opens its own stream at once', async () => {
		vi.stubGlobal('BroadcastChannel', undefined);
		const ts = [await openTab('bob'), await openTab('bob'), await openTab('bob')];
		const open = openStreams();
		expect(open).toHaveLength(3);
		expect(new Set(open.map((e) => e.tab))).toEqual(new Set(ts.map((t) => t.env.id)));
		open[0]!.emit('chat_activity', FRAME);
		await settle();
		expect(ts.filter((t) => t.got.fast.length > 0)).toHaveLength(1);
	});

	it('Web Locks but no BroadcastChannel: each tab opens its own stream', async () => {
		vi.stubGlobal('navigator', { locks: { request: () => new Promise(() => undefined) } });
		vi.stubGlobal('BroadcastChannel', undefined);
		await openTab('bob');
		await openTab('bob');
		expect(openStreams()).toHaveLength(2);
	});
});
