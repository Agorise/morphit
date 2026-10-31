/**
 * Offline notices — the Matrix rooms the bot still has to leave and forget.
 *
 * The store queues a room in `offline_notify_leave` in the same transaction
 * that lets it go (store.ts): an address's room once no row of any account
 * holds that address any more; a room nothing uses (one a new room replaced,
 * one opened by a sender that lost the claim to another, one a code that came
 * too late opened, a room an older version kept on a row). No database
 * trigger: the indexer's snapshot and rollback checks refuse database code.
 *
 * This works through that queue. Whether a room may still be used is decided
 * in the database just BEFORE the leave (store.leaveIfUnused; no transaction
 * is open while the homeserver answers): an address's room that a row took
 * back by then stays. A homeserver that does not answer is tried again later,
 * up to {@link LEAVE_TRIES} times over about two days.
 */

import { logger } from '$log';
import type { MatrixConfig, MatrixCtx } from './channels/matrix.ts';
import { leaveRoom } from './channels/matrix.ts';
import { errorClass } from './dispatch.ts';
import type { NetPolicy } from './net.ts';
import type { OfflineNotifyStore } from './store.ts';

const log = logger('offline-notify');

/** Tries before a room is given up: the waits between them add up to about
 *  two days (1, 2, 4 … minutes, then every 6 hours). */
export const LEAVE_TRIES = 16;

/** Wait before try `n` (1-based): 1, 2, 4 … minutes, at most 6 hours. */
export function leaveBackoffMs(n: number): number {
	return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, n - 1));
}

type Claimed = Awaited<ReturnType<OfflineNotifyStore['claimLeaves']>>[number];

async function later(
	store: OfflineNotifyStore,
	item: Claimed,
	now: Date,
	err: unknown
): Promise<void> {
	const tries = item.tries + 1;
	if (tries >= LEAVE_TRIES) {
		log.warn('offline_notify_leave_gave_up', { err: errorClass(err) });
		await store.leaveDone(item);
	} else {
		await store.leaveLater(item.key, tries, new Date(now.getTime() + leaveBackoffMs(tries)));
	}
}

/** Leave one claimed room if nothing uses it. True when it was left. */
async function leaveOne(
	store: OfflineNotifyStore,
	matrix: MatrixConfig,
	policy: NetPolicy,
	item: Claimed,
	now: Date,
	ctx: MatrixCtx
): Promise<boolean> {
	try {
		return (
			(await store.leaveIfUnused(item, (room) => leaveRoom(matrix, policy, room, ctx))) === 'left'
		);
	} catch (err) {
		await later(store, item, now, err);
		return false;
	}
}

/** Each request when leaving may take this long. */
export const LEAVE_CALL_MS = 15_000;

/** One pass starts no room after this, and every request of it ends by
 *  this plus two requests' time: a homeserver that hangs holds the worker
 *  (which delivers the notices first) for about a minute at most. */
export const LEAVE_PASS_MS = 30_000;

/** The pass running now, per store (one at a time in a process), and
 *  whether someone asked for another one meanwhile. */
const rounds = new WeakMap<
	OfflineNotifyStore,
	{ pass: Promise<{ claimed: number; left: number }>; again: boolean }
>();

/**
 * Leave the rooms that are due: one pass of at most `limit` rooms, none
 * started after {@link LEAVE_PASS_MS}. Never throws. Returns how many were
 * taken from the queue in that pass, and how many of those were left.
 *
 * One pass at a time in a process (the worker asks every round, the API
 * after every change that may let a room go). A call while one runs waits for
 * THAT pass only and asks for one more, which then runs on its own, for what
 * was queued meanwhile — so nobody, the worker least of all, waits for passes
 * others asked for.
 */
export function drainLeaves(
	store: OfflineNotifyStore,
	matrix: MatrixConfig | null,
	policy: NetPolicy,
	now: Date,
	/** Rooms taken from the queue in a pass. */
	limit = 20,
	opts: {
		/** Each request may take this long at most ({@link LEAVE_CALL_MS}). */
		readonly callMs?: number;
		/** {@link LEAVE_PASS_MS}. */
		readonly passMs?: number;
	} = {}
): Promise<{ claimed: number; left: number }> {
	// Matrix not set up: the bot cannot sign in to leave anything — the rooms
	// wait in the queue until it is (docs/OPERATIONS.md §54.3).
	if (matrix === null) return Promise.resolve({ claimed: 0, left: 0 });
	const running = rounds.get(store);
	if (running !== undefined) {
		running.again = true;
		return running.pass;
	}
	const round = { pass: Promise.resolve({ claimed: 0, left: 0 }), again: false };
	const start = (at: Date): void => {
		round.again = false;
		round.pass = (async () => {
			const r = await onePass(store, matrix, policy, at, limit, opts);
			// Decided before this pass's callers go on: another pass (on its
			// own, nobody waits for it), or the round is over.
			if (round.again) start(new Date(Math.max(at.getTime(), Date.now())));
			else rounds.delete(store);
			return r;
		})();
	};
	rounds.set(store, round);
	start(now);
	return round.pass;
}

async function onePass(
	store: OfflineNotifyStore,
	matrix: MatrixConfig,
	policy: NetPolicy,
	now: Date,
	limit: number,
	opts: { readonly callMs?: number; readonly passMs?: number }
): Promise<{ claimed: number; left: number }> {
	const callMs = opts.callMs ?? LEAVE_CALL_MS;
	const until = Date.now() + (opts.passMs ?? LEAVE_PASS_MS);
	const ctx: MatrixCtx = { callMs, deadline: until + 2 * callMs };
	let claimed = 0;
	let left = 0;
	try {
		// One at a time: a room claimed but not tried would wait out its lease.
		while (claimed < limit && Date.now() < until) {
			const [item] = await store.claimLeaves(1, now);
			if (item === undefined) break;
			claimed++;
			if (await leaveOne(store, matrix, policy, item, now, ctx)) left++;
		}
	} catch (err) {
		log.warn('offline_notify_leave_failed', { err: errorClass(err) });
	}
	return { claimed, left };
}

/**
 * Leave rooms one at a time until the queue is empty or `budgetMs` has
 * passed — no room is STARTED after that — and every request ends by
 * `doneBy` (ms since the epoch) at the latest. For the operator turning
 * Matrix off, whose tool must answer in time. Rooms not left wait in the
 * queue (the relay goes on with them while Matrix is set up).
 */
export async function drainLeavesWithin(
	store: OfflineNotifyStore,
	matrix: MatrixConfig | null,
	policy: NetPolicy,
	budgetMs: number,
	clock: () => number = Date.now,
	doneBy: number = clock() + budgetMs + 2 * LEAVE_CALL_MS
): Promise<{ left: number }> {
	if (matrix === null) return { left: 0 };
	const until = clock() + budgetMs;
	const ctx: MatrixCtx = { callMs: LEAVE_CALL_MS, deadline: doneBy };
	let left = 0;
	try {
		while (clock() < until) {
			const [item] = await store.claimLeaves(1, new Date(clock()));
			if (item === undefined) break;
			if (await leaveOne(store, matrix, policy, item, new Date(clock()), ctx)) left++;
		}
	} catch (err) {
		log.warn('offline_notify_leave_failed', { err: errorClass(err) });
	}
	return { left };
}
