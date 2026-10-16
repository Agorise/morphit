/**
 * Offline notices: when the operator turns Matrix off, the tool leaves the
 * bot's rooms one at a time and starts none after its time budget, so its
 * answer reaches `morphit-ops` before that gives up on it (the addresses are
 * already deleted; a late answer would read as "nothing was changed").
 */
import { describe, expect, it, vi } from 'vitest';

let clock = 0;
let homeserverDown = false;
const leftRooms: string[] = [];
vi.mock('../src/notify/channels/matrix.ts', () => ({
	leaveRoom: vi.fn(async (_m: unknown, _p: unknown, room: string) => {
		clock += 40_000; // a homeserver that takes 40 s per room
		if (homeserverDown) throw new Error('ECONNREFUSED');
		leftRooms.push(room);
	})
}));

const { drainLeaves, drainLeavesWithin, LEAVE_TRIES, leaveBackoffMs } = await import(
	'../src/notify/leaves.ts'
);

describe('offline notices: leaving rooms within a time budget', () => {
	it('starts no room after the budget, and leaves the rest queued', async () => {
		const queue = Array.from({ length: 10 }, (_, i) => Buffer.from([i]));
		const done: Buffer[] = [];
		const store = {
			claimLeaves: async (limit: number) =>
				queue.splice(0, limit).map((key) => ({ key, tries: 0, room: `!r${key[0]}:hs` })),
			leaveDone: async (key: Buffer) => {
				done.push(key);
			},
			leaveLater: async () => undefined,
			roomHeld: async () => false
		};
		clock = 0;
		const r = await drainLeavesWithin(
			store as never,
			{} as never,
			{ torSocks: '', hiddenOnly: false },
			100_000,
			() => clock
		);
		// Started at 0, 40 and 80 s; at 120 s no fourth one is started.
		expect(r.left).toBe(3);
		expect(done).toHaveLength(3);
		expect(queue).toHaveLength(7);
	});

	it('stops at once when nothing is queued', async () => {
		const store = {
			claimLeaves: async () => [],
			leaveDone: async () => undefined,
			roomHeld: async () => false
		};
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

describe('offline notices: a homeserver that does not answer', () => {
	const policy = { torSocks: '', hiddenOnly: false };
	it('is tried again later, with growing waits, for about two days — then given up', async () => {
		homeserverDown = true;
		let item = { key: Buffer.from([1]), tries: 0, account: 'alice', room: '!r:hs' };
		const later: Array<{ tries: number; at: number }> = [];
		let done = 0;
		const store = {
			claimLeaves: async () => [item],
			leaveDone: async () => {
				done++;
			},
			leaveLater: async (_k: Buffer, tries: number, at: Date) => {
				later.push({ tries, at: at.getTime() });
				item = { ...item, tries };
			},
			roomHeld: async () => false
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

	it('a room she holds again by now is not left (only taken off the queue)', async () => {
		leftRooms.length = 0;
		let done = 0;
		const store = {
			claimLeaves: async () => [
				{ key: Buffer.from([2]), tries: 0, account: 'alice', room: '!mine:hs' }
			],
			leaveDone: async () => {
				done++;
			},
			roomHeld: async (_a: string, room: string) => room === '!mine:hs'
		};
		await drainLeaves(store as never, {} as never, policy, new Date(0));
		expect(leftRooms).toEqual([]);
		expect(done).toBe(1);
	});
});
