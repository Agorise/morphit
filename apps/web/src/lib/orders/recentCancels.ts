/**
 * recentCancels — bridges the ~1-minute indexer lag on an order cancel.
 *
 * t.txt (v1.4.9 #6 + #7): when a user cancels an order, the broadcast lands on
 * chain immediately but the indexer takes up to a minute to reflect it. Until
 * then, any refetch (or a fresh /my/orders load after cancelling from the order
 * page) still reports the order as `live`, so the card and the Live/Cancelled
 * pill counts look wrong until a later refresh.
 *
 * This records a just-cancelled permlink in sessionStorage (short-lived), so any
 * view rendering that order can optimistically treat it as `cancelled` until the
 * indexer catches up. Session-scoped: it's a UI smoothing hint, not truth — the
 * chain is the source of truth and the next natural load reconciles.
 */
import { safeSession } from '$lib/utils/safeStorage';

const KEY = 'morphit.recent_cancels_v1';
/** How long a recorded cancel overrides the indexer's stale `live`. Comfortably
 *  longer than the observed ~1-minute indexing lag, short enough that a genuine
 *  re-list of the same permlink (new permlink anyway) is never shadowed. */
const TTL_MS = 3 * 60 * 1000;

interface CancelEntry {
	readonly permlink: string;
	readonly at: number;
}

function readEntries(): CancelEntry[] {
	try {
		const raw = safeSession.get(KEY);
		if (raw === null || raw === undefined || raw === '') return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const now = Date.now();
		return parsed.filter(
			(e): e is CancelEntry =>
				typeof e === 'object' &&
				e !== null &&
				typeof (e as CancelEntry).permlink === 'string' &&
				typeof (e as CancelEntry).at === 'number' &&
				now - (e as CancelEntry).at < TTL_MS
		);
	} catch {
		return [];
	}
}

/** Record that `permlink` was just cancelled (broadcast succeeded). */
export function recordCancel(permlink: string): void {
	const fresh = readEntries().filter((e) => e.permlink !== permlink);
	fresh.push({ permlink, at: Date.now() });
	try {
		safeSession.set(KEY, JSON.stringify(fresh));
	} catch {
		/* sessionStorage unavailable (private mode / disabled) — non-fatal;
		   the optimistic in-memory update in the caller still applies. */
	}
}

/** The set of permlinks cancelled within the TTL window. */
export function recentlyCancelledPermlinks(): Set<string> {
	return new Set(readEntries().map((e) => e.permlink));
}

/** Override the status of any recently-cancelled order to 'cancelled', so the
 *  indexer's lag doesn't briefly show a just-cancelled order as still live.
 *  Returns a new array only when something changed. */
export function applyRecentCancels<T extends { permlink: string; status?: string }>(
	orders: readonly T[]
): T[] {
	const cancelled = recentlyCancelledPermlinks();
	if (cancelled.size === 0) return orders as T[];
	return orders.map((o) =>
		cancelled.has(o.permlink) && o.status !== 'cancelled'
			? ({ ...o, status: 'cancelled' } as T)
			: o
	);
}
