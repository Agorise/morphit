/**
 * Per-peer read-state tracker for the /chat inbox.
 *
 * Phase A (client-side only): records the timestamp at which the
 * local user last visited each conversation. The inbox uses this
 * to compare against `ConversationSummary.last_message_at` and
 * decide whether a conversation is unread.
 *
 * Phase B (planned — chain-backed read receipts): when
 * `morphit_chat_read_v1` lands, broadcasting a read-ack op will
 * also shadow-write here so the offline-first UI stays snappy.
 * The on-chain state is the source of truth for cross-device sync;
 * this module is the single-device fast path.
 *
 * Storage:
 *   safeLocal key `morphit.chat.read_state`. Value is a JSON object
 *   mapping `peer → iso-timestamp`. Bounded at MAX_PEERS entries;
 *   overflow drops the oldest visit.
 *
 * Reactivity:
 *   Callers that render inbox state can subscribe to
 *   `readStateStore` to re-render when any peer is marked read.
 *   Direct calls to `markConversationRead()` notify all
 *   subscribers.
 *
 * Privacy:
 *   This data lives on the local device only in Phase A. A lost
 *   device or cleared localStorage means losing the unread-state
 *   signal (all recent conversations will show as unread until
 *   the user re-opens them). Phase B's on-chain ack makes read
 *   state durable and cross-device; Phase A is "good enough for
 *   one device."
 */

import { writable, get, type Readable } from 'svelte/store';
import { safeLocal } from '$utils/safeStorage';

const KEY = 'morphit.chat.read_state';
const MAX_PEERS = 500;
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

/** Shape in storage: peer → ISO timestamp of last visit. */
type ReadStateMap = Record<string, string>;

function readRaw(): ReadStateMap {
	const raw = safeLocal.get(KEY);
	if (raw === null) return {};
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return {};
		}
		// Filter to well-formed entries. Invalid account names and
		// non-string values are dropped silently — a corrupt store
		// shouldn't break the inbox.
		const out: ReadStateMap = {};
		for (const [k, v] of Object.entries(parsed)) {
			if (
				typeof k === 'string' &&
				ACCOUNT_NAME_RE.test(k) &&
				typeof v === 'string' &&
				!Number.isNaN(new Date(v).getTime())
			) {
				out[k] = v;
			}
		}
		return out;
	} catch {
		return {};
	}
}

function writeRaw(state: ReadStateMap): void {
	try {
		safeLocal.set(KEY, JSON.stringify(state));
	} catch {
		// safeLocal is best-effort; writes can fail in quota-exceeded
		// or private-mode contexts. Silently ignore — the inbox will
		// just show a stale unread signal rather than breaking.
	}
}

/** Cap the state to the MAX_PEERS most-recently-visited peers.
 *  Called after every write. O(n log n) on n=500 peers = trivial. */
function cap(state: ReadStateMap): ReadStateMap {
	const entries = Object.entries(state);
	if (entries.length <= MAX_PEERS) return state;
	entries.sort((a, b) => b[1].localeCompare(a[1])); // newest first
	entries.length = MAX_PEERS;
	return Object.fromEntries(entries);
}

/** Initial load from storage. The store is the reactive entry
 *  point; imperative helpers below sync the underlying storage
 *  and push updates through. */
const readStateStore = writable<ReadStateMap>(readRaw());

/** Public reactive view. UI subscribes here to reflect
 *  mark-read actions across components. */
export const readState: Readable<ReadStateMap> = {
	subscribe: readStateStore.subscribe
};

/**
 * Record that the user has "read" / visited a conversation at
 * this moment. Idempotent — the latest call wins. Persists to
 * storage and notifies subscribers.
 */
export function markConversationRead(peer: string, at: Date = new Date()): void {
	if (!ACCOUNT_NAME_RE.test(peer)) return;
	const current = get(readStateStore);
	const next = cap({ ...current, [peer]: at.toISOString() });
	writeRaw(next);
	readStateStore.set(next);
}

/**
 * Monotonic-advance merge of remote read-state entries into the
 * local store. Each (peer, timestamp) entry only updates the
 * local state if the incoming timestamp is strictly newer than
 * the current local value. Invalid entries are silently skipped.
 *
 * Used by the inbox on load: after fetching
 * GET /v1/chat-read-state/:me, we merge the server's view into
 * the local readState so cross-device reads are reflected
 * without blowing away local reads that happened while offline.
 *
 * Contract: unlike markConversationRead (which is "latest call
 * wins"), this is "max of local and remote wins" — matching the
 * on-chain handler's monotonic-advance guard. Together the two
 * ensure that read state only ever moves forward in time.
 */
export function mergeRemoteReadState(
	remote: readonly { peer: string; last_read_at: string }[]
): void {
	const current = get(readStateStore);
	const next: ReadStateMap = { ...current };
	let mutated = false;
	for (const entry of remote) {
		if (!ACCOUNT_NAME_RE.test(entry.peer)) continue;
		const incoming = new Date(entry.last_read_at).getTime();
		if (!Number.isFinite(incoming)) continue;
		const local = current[entry.peer];
		if (local === undefined || incoming > new Date(local).getTime()) {
			next[entry.peer] = entry.last_read_at;
			mutated = true;
		}
	}
	if (mutated) {
		const capped = cap(next);
		writeRaw(capped);
		readStateStore.set(capped);
	}
}

/**
 * Return the ISO timestamp at which the user last visited the
 * conversation with `peer`, or null if they've never visited.
 */
export function getLastVisited(peer: string): string | null {
	if (!ACCOUNT_NAME_RE.test(peer)) return null;
	const state = get(readStateStore);
	return state[peer] ?? null;
}

/**
 * Convenience predicate: is this conversation unread? A
 * conversation is unread if its `last_message_at` is newer than
 * the user's last visit, OR the user has never visited.
 *
 * A conversation started by the user themselves (where the last
 * message is outbound) is technically "unread" by this definition
 * until they re-open it. Callers that want to distinguish
 * "unread because peer replied" from "unread because I just sent
 * something" should pass the last sender and filter.
 */
export function isUnread(peer: string, lastMessageAt: string): boolean {
	if (!ACCOUNT_NAME_RE.test(peer)) return false;
	const visited = getLastVisited(peer);
	if (!visited) return true;
	return new Date(lastMessageAt).getTime() > new Date(visited).getTime();
}

/**
 * Clear the entire read-state map. Called by the lock-session
 * flow alongside other conversation-related local state.
 */
export function clearReadState(): void {
	safeLocal.remove(KEY);
	readStateStore.set({});
}

/**
 * For test determinism only — reload from storage. Prefer the
 * exported helpers in production code.
 */
export function __reloadFromStorage(): void {
	readStateStore.set(readRaw());
}
