/**
 * Offline notices — the Matrix rooms the bot still has to leave and forget.
 *
 * The store puts a room in `offline_notify_leave`, in the same transaction,
 * whenever the row holding it is deleted or its room replaced (a removed,
 * changed or never-confirmed address, a channel the operator turned off —
 * see guardRooms in store.ts; no database trigger: the indexer's snapshot and
 * rollback checks refuse database code). This works through that queue: leave and
 * forget, then drop the entry; a homeserver that does not answer is tried
 * again later, up to {@link LEAVE_TRIES} times over about two days.
 */

import { logger } from '$log';
import type { MatrixConfig } from './channels/matrix.ts';
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

/** One pass over the rooms that are due. Never throws. Returns how many were
 *  taken from the queue this pass, and how many of those were left. */
export async function drainLeaves(
	store: OfflineNotifyStore,
	matrix: MatrixConfig | null,
	policy: NetPolicy,
	now: Date,
	/** Rooms taken from the queue in this pass. */
	limit = 20
): Promise<{ claimed: number; left: number }> {
	// Matrix turned off: the rooms wait (the operator's purge left them first).
	if (matrix === null) return { claimed: 0, left: 0 };
	let left = 0;
	let claimed = 0;
	try {
		const items = await store.claimLeaves(limit, now);
		claimed = items.length;
		for (const item of items) {
			// Not openable (cannot ever be left), or hers again by now (she
			// cancelled a change, a send saved it back): off the queue, the
			// bot stays.
			if (item.room === null || (await store.roomHeld(item.account, item.room))) {
				await store.leaveDone(item.key);
				continue;
			}
			try {
				await leaveRoom(matrix, policy, item.room);
				await store.leaveDone(item.key);
				left++;
			} catch (err) {
				const tries = item.tries + 1;
				if (tries >= LEAVE_TRIES) {
					log.warn('offline_notify_leave_gave_up', { err: errorClass(err) });
					await store.leaveDone(item.key);
				} else {
					await store.leaveLater(item.key, tries, new Date(now.getTime() + leaveBackoffMs(tries)));
				}
			}
		}
	} catch (err) {
		log.warn('offline_notify_leave_failed', { err: errorClass(err) });
	}
	return { claimed, left };
}

/**
 * Leave rooms one at a time until the queue is empty or `budgetMs` has
 * passed — no room is STARTED after that (one leave may take about 30 s).
 * For the operator turning Matrix off, whose tool must answer in time.
 */
export async function drainLeavesWithin(
	store: OfflineNotifyStore,
	matrix: MatrixConfig | null,
	policy: NetPolicy,
	budgetMs: number,
	clock: () => number = Date.now
): Promise<{ left: number }> {
	let left = 0;
	const until = clock() + budgetMs;
	while (clock() < until) {
		const pass = await drainLeaves(store, matrix, policy, new Date(clock()), 1);
		left += pass.left;
		if (pass.claimed === 0) break;
	}
	return { left };
}
