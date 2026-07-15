/**
 * recentCompletes — bridges the ~1-minute indexer lag on an order complete.
 *
 * v1.5.0: when a trade settles, the seller's order is marked done via
 * morphit_order_complete_v1 (auto the moment the client verifies the payment,
 * or via the manual "Mark as complete" button). The broadcast lands on chain
 * immediately but the indexer takes up to a minute to reflect the new
 * status='completed'. Until then any refetch still reports the order as `live`,
 * so the card and the Live/Paid pill counts look wrong until a later refresh.
 *
 * This records a just-completed permlink in sessionStorage (short-lived), so any
 * view rendering that order can optimistically treat it as `completed` until the
 * indexer catches up. Session-scoped: it's a UI smoothing hint, not truth — the
 * chain is the source of truth and the next natural load reconciles. Mirror of
 * recentCancels.ts.
 */
import { safeSession } from '$lib/utils/safeStorage';

const KEY = 'morphit.recent_completes_v1';
/** How long a recorded complete overrides the indexer's stale `live`. Comfortably
 *  longer than the observed ~1-minute indexing lag, short enough that a genuine
 *  re-list of the same permlink (new permlink anyway) is never shadowed. */
const TTL_MS = 3 * 60 * 1000;

interface CompleteEntry {
	readonly permlink: string;
	readonly at: number;
}

function readEntries(): CompleteEntry[] {
	try {
		const raw = safeSession.get(KEY);
		if (raw === null || raw === undefined || raw === '') return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const now = Date.now();
		return parsed.filter(
			(e): e is CompleteEntry =>
				typeof e === 'object' &&
				e !== null &&
				typeof (e as CompleteEntry).permlink === 'string' &&
				typeof (e as CompleteEntry).at === 'number' &&
				now - (e as CompleteEntry).at < TTL_MS
		);
	} catch {
		return [];
	}
}

/** Record that `permlink` was just completed (broadcast succeeded). */
export function recordComplete(permlink: string): void {
	const fresh = readEntries().filter((e) => e.permlink !== permlink);
	fresh.push({ permlink, at: Date.now() });
	try {
		safeSession.set(KEY, JSON.stringify(fresh));
	} catch {
		/* sessionStorage unavailable (private mode / disabled) — non-fatal;
		   the optimistic in-memory update in the caller still applies. */
	}
}

/** The set of permlinks completed within the TTL window. */
export function recentlyCompletedPermlinks(): Set<string> {
	return new Set(readEntries().map((e) => e.permlink));
}

/** Override the status of any recently-completed order to 'completed', so the
 *  indexer's lag doesn't briefly show a just-completed order as still live.
 *  Returns a new array only when something changed. */
export function applyRecentCompletes<T extends { permlink: string; status?: string }>(
	orders: readonly T[]
): T[] {
	const completed = recentlyCompletedPermlinks();
	if (completed.size === 0) return orders as T[];
	return orders.map((o) =>
		completed.has(o.permlink) && o.status !== 'completed'
			? ({ ...o, status: 'completed' } as T)
			: o
	);
}
