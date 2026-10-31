/**
 * Offline notices: the leave queue's timing — when the operator turns Matrix
 * off, the tool leaves the rooms one at a time, starts none after its budget
 * and has every request done by its deadline, so its answer reaches
 * `morphit-ops` before that gives up on it; a homeserver that does not answer
 * is tried again with growing waits, then given up. Whether a room may be left
 * is the store's (store.leaveIfUnused, on a real database:
 * offlineNotifyMatrixOneRoom.test.ts, scripts/offline-notify-matrix-rooms-smoke.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let clock = 0;
let homeserverDown = false;
const leftRooms: string[] = [];
const ctxs: unknown[] = [];
vi.mock('../src/notify/channels/matrix.ts', () => ({
	leaveRoom: vi.fn(async (_m: unknown, _p: unknown, room: string, ctx: unknown) => {
		ctxs.push(ctx);
		clock += 40_000; // a homeserver that takes 40 s per room
		if (homeserverDown) throw new Error('ECONNREFUSED');
		leftRooms.push(room);
	})
}));

const {
	drainLeaves,
	drainLeavesWithin,
	LEAVE_CALL_MS,
	LEAVE_PASS_MS,
	LEAVE_TRIES,
	leaveBackoffMs
} = await import('../src/notify/leaves.ts');

/** A store whose leaveIfUnused leaves every room (or keeps the ones in `keep`). */
const leaving = (keep: ReadonlySet<string> = new Set()) => ({
	leaveIfUnused: async (
		item: { room: string | null },
		leave: (room: string) => Promise<void>
	): Promise<'left' | 'kept'> => {
		if (item.room === null || keep.has(item.room)) return 'kept';
		await leave(item.room);
		return 'left';
	}
});

describe('offline notices: leaving rooms within a time budget', () => {
	it('starts no room after the budget, every request bounded by the deadline, the rest stay queued', async () => {
		const queue = Array.from({ length: 10 }, (_, i) => ({
			key: Buffer.from([i]),
			tries: 0,
			account: 'a',
			room: `!r${i}:hs`,
			addressMac: null
		}));
		const store = {
			claimLeaves: async (limit: number) => queue.splice(0, limit),
			leaveLater: async () => undefined,
			leaveDone: async () => undefined,
			...leaving()
		};
		clock = 0;
		ctxs.length = 0;
		const r = await drainLeavesWithin(
			store as never,
			{} as never,
			{ torSocks: '', hiddenOnly: false },
			100_000,
			() => clock,
			123_456
		);
		// Started at 0, 40 and 80 s; at 120 s no fourth one is started.
		expect(r.left).toBe(3);
		expect(queue).toHaveLength(7);
		expect(ctxs).toEqual([
			{ callMs: LEAVE_CALL_MS, deadline: 123_456 },
			{ callMs: LEAVE_CALL_MS, deadline: 123_456 },
			{ callMs: LEAVE_CALL_MS, deadline: 123_456 }
		]);
	});

	it('stops at once when nothing is queued', async () => {
		const store = { claimLeaves: async () => [], ...leaving() };
		clock = 0;
		const r = await drainLeavesWithin(
			store as never,
			{} as never,
			{ torSocks: '', hiddenOnly: false },
			100_000,
			() => clock
		);
		expect(r.left).toBe(0);
	});
});

describe('offline notices: leave passes, one at a time', () => {
	const policy = { torSocks: '', hiddenOnly: false };
	// On a fake clock (setTimeout, setInterval and Date): the homeserver's
	// answers and the pass's time budget follow it, not real time.
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	/** A queue (rooms claimed one at a time, as the real one leases them) and a
	 *  store whose leave takes `ms` per room. */
	const queueOf = (rooms: string[], ms: number) => {
		const left: string[] = [];
		let leaving = 0;
		const store = {
			claimLeaves: async () => {
				const room = rooms.shift();
				return room === undefined
					? []
					: [{ key: Buffer.from(room), tries: 0, account: 'a', room, addressMac: null }];
			},
			leaveIfUnused: async (item: { room: string }) => {
				leaving++;
				await new Promise((r) => setTimeout(r, ms));
				leaving--;
				left.push(item.room);
				return 'left' as const;
			},
			leaveLater: async () => undefined,
			leaveDone: async () => undefined
		};
		return { store, left, leaving: () => leaving };
	};
	const settled = <T>(p: Promise<T>) => {
		const s: { done: boolean; value?: T } = { done: false };
		void p.then((v) => {
			s.done = true;
			s.value = v;
		});
		return s;
	};

	it('a call during a pass waits for that pass only; the pass it asked for then runs on its own', async () => {
		const rooms = ['!a:hs'];
		const q = queueOf(rooms, 300);
		// One room a pass, so the pass is over once '!a' is left.
		const first = settled(drainLeaves(q.store as never, {} as never, policy, new Date(0), 1));
		await vi.advanceTimersByTimeAsync(0);
		expect(q.leaving()).toBe(1);
		// Queued while the first pass runs (a user removed her address)…
		rooms.push('!b:hs');
		const joined = settled(drainLeaves(q.store as never, {} as never, policy, new Date(0), 1));
		await vi.advanceTimersByTimeAsync(300);
		// …the call that came during the first pass is done with it,
		expect(joined.done).toBe(true);
		expect(joined.value).toEqual(first.value);
		expect(q.left).toEqual(['!a:hs']);
		// …and '!b' is left by the pass it asked for, which nobody waits for.
		expect(q.leaving()).toBe(1);
		await vi.advanceTimersByTimeAsync(300);
		expect(q.left).toEqual(['!a:hs', '!b:hs']);
	});

	it('API calls asking again and again never keep a caller waiting more than one pass', async () => {
		const rooms = Array.from({ length: 100 }, (_, i) => `!r${i}:hs`);
		const q = queueOf(rooms, 100);
		const api = setInterval(
			() => void drainLeaves(q.store as never, {} as never, policy, new Date(0)),
			50
		);
		try {
			const mine = settled(drainLeaves(q.store as never, {} as never, policy, new Date(0), 5));
			await vi.advanceTimersByTimeAsync(500);
			expect(mine.done).toBe(true);
			expect(mine.value?.claimed).toBe(5);
		} finally {
			clearInterval(api);
		}
	});

	it(`one pass starts no room after its time (${LEAVE_PASS_MS / 1000} s), however many are due`, async () => {
		const q = queueOf(
			Array.from({ length: 50 }, (_, i) => `!r${i}:hs`),
			100
		);
		const r = settled(
			drainLeaves(q.store as never, {} as never, policy, new Date(0), 50, { passMs: 350 })
		);
		await vi.advanceTimersByTimeAsync(1000);
		// Started at 0, 100, 200 and 300 ms; none at 400.
		expect(r.done).toBe(true);
		expect(r.value?.claimed).toBe(4);
	});
});

describe('offline notices: a homeserver that does not answer', () => {
	const policy = { torSocks: '', hiddenOnly: false };
	it('is tried again later, with growing waits, for about two days — then given up', async () => {
		homeserverDown = true;
		let item = { key: Buffer.from([1]), tries: 0, account: 'a', room: '!r:hs', addressMac: null };
		const later: Array<{ tries: number; at: number }> = [];
		let done = 0;
		// As the real queue: a claimed room is not due again until it is
		// put back (leaveLater) or its lease runs out.
		let dueAt = 0;
		const store = {
			claimLeaves: async (_limit: number, now: Date) => {
				if (done > 0 || now.getTime() < dueAt) return [];
				dueAt = now.getTime() + 10 * 60_000;
				return [item];
			},
			leaveDone: async () => {
				done++;
			},
			leaveLater: async (_k: Buffer, tries: number, at: Date) => {
				later.push({ tries, at: at.getTime() });
				item = { ...item, tries };
				dueAt = at.getTime();
			},
			...leaving()
		};
		let t = 0;
		for (let i = 0; i < LEAVE_TRIES; i++) {
			await drainLeaves(store as never, {} as never, policy, new Date(t));
			if (later.length > 0) t = later.at(-1)!.at;
		}
		homeserverDown = false;
		// Tried LEAVE_TRIES times in all: the last failure gives it up.
		expect(later).toHaveLength(LEAVE_TRIES - 1);
		expect(done).toBe(1);
		// Each wait at least as long as the one before; together about two days.
		const waits = later.map((l, i) => l.at - (i === 0 ? 0 : later[i - 1]!.at));
		for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]!);
		expect(waits[0]).toBe(leaveBackoffMs(1));
		const total = later.at(-1)!.at;
		expect(total).toBeGreaterThan(36 * 60 * 60_000);
		expect(total).toBeLessThan(60 * 60 * 60_000);
	});

	it('a room the store keeps is not left', async () => {
		leftRooms.length = 0;
		let claimed = false;
		const store = {
			claimLeaves: async () =>
				claimed
					? []
					: ((claimed = true),
						[
							{ key: Buffer.from([2]), tries: 0, account: 'a', room: '!mine:hs', addressMac: null }
						]),
			...leaving(new Set(['!mine:hs']))
		};
		const r = await drainLeaves(store as never, {} as never, policy, new Date(0));
		expect(leftRooms).toEqual([]);
		expect(r).toEqual({ claimed: 1, left: 0 });
	});

	it('Matrix not set up: nothing is claimed or left (the rooms wait)', async () => {
		let claimed = 0;
		const store = {
			claimLeaves: async () => {
				claimed++;
				return [];
			}
		};
		expect(await drainLeaves(store as never, null, policy, new Date(0))).toEqual({
			claimed: 0,
			left: 0
		});
		expect(claimed).toBe(0);
	});
});
