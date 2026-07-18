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
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** Shape in storage: peer → ISO timestamp of last visit. */
type ReadStateMap = Record<string, string>;

export const PEER_WIDE = '*';

function threadKey(peer: string, orderPermlink: string): string {
	return `${peer}\u0000${orderPermlink}`;
}

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
			if (typeof k !== 'string' || typeof v !== 'string') continue;
			if (Number.isNaN(new Date(v).getTime())) continue;

			// cp446 — MIGRATE, don't discard. Before threading, a key was the bare
			// peer name and the value meant "everything with this peer, up to here".
			// That is precisely a peer-wide ack, so it becomes `peer\u0000*`. Drop
			// it instead and every existing user's whole inbox lights up unread on
			// the morning they upgrade.
			const nul = k.indexOf('\u0000');
			if (nul === -1) {
				if (!ACCOUNT_NAME_RE.test(k)) continue;
				out[`${k}\u0000${PEER_WIDE}`] = v;
				continue;
			}

			const peer = k.slice(0, nul);
			const order = k.slice(nul + 1);
			if (!ACCOUNT_NAME_RE.test(peer) || order.length > 256) continue;
			out[k] = v;
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
/**
 * cp446 — read state is per DISCUSSION, not per person (Ken: "if I read one
 * thread from a user, it should not mark other threads with that user as read.
 * Think of it like email.").
 *
 * A map key is `peer` + NUL + one of:
 *   - the order's permlink,
 *   - `''` for the thread that cites no order,
 *   - `PEER_WIDE` (`'*'`) for a legacy ack, which covers every thread with that
 *     peer up to its timestamp. Pre-cp446 clients only ever sent these, and an
 *     old client still sends them today.
 *
 * NUL cannot occur in an account name or a permlink, so no two distinct threads
 * can produce the same key. `'*'` is not a legal permlink, so a real thread can
 * never collide with the peer-wide sentinel.
 */
export function markConversationRead(
	peer: string,
	orderPermlink: string,
	at: Date = new Date()
): void {
	if (!ACCOUNT_NAME_RE.test(peer)) return;
	if (orderPermlink === PEER_WIDE || orderPermlink.length > 256) return;
	const current = get(readStateStore);
	const next = cap({ ...current, [threadKey(peer, orderPermlink)]: at.toISOString() });
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
	remote: readonly { peer: string; last_read_at: string; order_permlink?: string }[]
): void {
	const current = get(readStateStore);
	const next: ReadStateMap = { ...current };
	let mutated = false;
	for (const entry of remote) {
		if (!ACCOUNT_NAME_RE.test(entry.peer)) continue;
		const incoming = new Date(entry.last_read_at).getTime();
		if (!Number.isFinite(incoming)) continue;
		// cp446 — an ack names the discussion it acknowledges. A pre-cp446 instance
		// omits the field, and every ack it ever stored was peer-wide; treat it as
		// such rather than silently attributing it to the order-less thread, which
		// would leave the user's other threads looking unread on that device.
		const order = entry.order_permlink ?? PEER_WIDE;
		if (order.length > 256) continue;
		const key = threadKey(entry.peer, order);
		const local = current[key];
		if (local === undefined || incoming > new Date(local).getTime()) {
			next[key] = entry.last_read_at;
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
export function getLastVisited(peer: string, orderPermlink: string): string | null {
	if (!ACCOUNT_NAME_RE.test(peer)) return null;
	const state = get(readStateStore);
	// The later of: this thread's own ack, and any peer-wide ack that predates
	// threading (or arrived from a device still running an old build). Both are
	// monotonic, so MAX is the only answer that can never un-read a thread.
	const own = state[threadKey(peer, orderPermlink)] ?? null;
	const wide = state[threadKey(peer, PEER_WIDE)] ?? null;
	if (own === null) return wide;
	if (wide === null) return own;
	return new Date(own).getTime() >= new Date(wide).getTime() ? own : wide;
}

/**
 * Is this conversation unread? Unread means its `last_message_at` is newer than
 * your last visit (or you've never visited) AND the last word isn't your own.
 *
 * v1.7.5 (t.txt #2) — `lastMessageIsMine` is new, and the old doc comment here
 * had already spotted the bug it fixes:
 *
 *   "A conversation started by the user themselves (where the last message is
 *    outbound) is technically 'unread' by this definition until they re-open it.
 *    Callers that want to distinguish ... should pass the last sender and filter."
 *
 * No caller ever did, because they COULDN'T: `ConversationSummary` carried no
 * such field. `has_user_sent` answers a different question ("have I ever sent in
 * this thread"). So the note asked callers to do something the API made
 * impossible, and the bug sat there being described rather than fixed: Ken sends
 * a message from his PC and his PHONE lights up unread — his own words, nagging
 * him from another device.
 *
 * The flag is REQUIRED rather than defaulted. A default of `false` reproduces the
 * old behaviour silently, so every future caller would inherit the bug by saying
 * nothing; making it required means the compiler asks the question. Pass `false`
 * when you genuinely don't know (an inbound Web Push, say — nobody pushes you
 * your own message).
 */
export function isUnread(
	peer: string,
	orderPermlink: string,
	lastMessageAt: string,
	lastMessageIsMine: boolean
): boolean {
	if (!ACCOUNT_NAME_RE.test(peer)) return false;
	// Your own last word: nothing is waiting to be read, on ANY device. This
	// precedes the cursor check on purpose — the cursor is per-device, and the
	// whole point is that the answer must not depend on which device you're
	// holding.
	if (lastMessageIsMine) return false;
	const visited = getLastVisited(peer, orderPermlink);
	if (!visited) return true;
	// v1.7.7 — SANITISE here too, or the fix to readAckTimestamp is only half a
	// fix and it shows.
	//
	// `lastMessageAt` comes from the operator's indexer, and Morphit is
	// federated. Before the cursor was sanitised, a hostile `2099` set the READ
	// CURSOR to 2099 and every real message afterwards read as already-seen — the
	// user went silently deaf. That is fixed. But this comparison still took the
	// raw value, so the same lie now pins `2099 > cursor` true forever: a badge
	// the user can never clear, on a thread that will not stop shouting. Severity
	// fell from dangerous to maddening; it did not reach zero.
	//
	// Treating an untrustworthy stamp as `now` is the honest reading of "we do not
	// know when the last message was": it counts as unread until the user opens
	// the thread, and then it clears, exactly like any other message.
	const at = sanitizeBlockTime(lastMessageAt);
	const atMs = at === null ? Date.now() : at.getTime();
	return atMs > new Date(visited).getTime();
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

/**
 * The timestamp to record when acknowledging a conversation as read.
 *
 * `isUnread()` compares the indexer's `last_message_at` — a CHAIN timestamp —
 * against whatever we stored here. Storing the client's `Date.now()` therefore
 * makes the comparison clock-dependent: if the browser's clock runs even
 * slightly behind the chain, the last message you just watched arrive is
 * "newer" than your acknowledgement, and the conversation stays lit green in
 * the inbox forever.
 *
 * So: acknowledge with the newest message we have actually SEEN, and fall back
 * to the local clock only when there is nothing to point at (an empty
 * conversation, or a list of still-pending sends that the chain has not stamped
 * yet). When the chain is running ahead of us, take the chain's word for it.
 *
 * @param latestSeenAt the newest CONFIRMED message time in view, or null.
 */
/** v1.7.7 — the furthest ahead of our own clock we will believe a "block time".
 *
 *  Generous, because the local clock is the thing we already know we cannot
 *  trust: a user whose PC runs an hour slow must still be able to read their
 *  chat. Finite, because a value from the network must never be able to push a
 *  read cursor to the year 2099.
 *
 *  This is not paranoia about a hypothetical. Morphit is FEDERATED: the value
 *  arrives from whichever operator's indexer the user chose, and "my operator is
 *  honest" is exactly the assumption the whole design refuses to make everywhere
 *  else. */
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

/** Reject a block time that cannot be real.
 *
 *  A block time is a chain fact and cannot meaningfully lead our clock — Blurt
 *  won't accept a block from the future, so anything materially ahead of `now`
 *  is a lie or a bug, and either way it must not be trusted.
 *
 *  WHAT THIS DEFENDS (found in the v1.7.7 adversarial pass, prompted by Ken:
 *  "this is exactly the type of thing that a black hat would try to do"):
 *  a hostile or compromised operator serves `last_message_at: '2099-01-01'`.
 *  Unsanitised, that value:
 *    1. becomes the user's READ CURSOR the moment they open the thread — so
 *       every genuine message afterwards is marked already-read. The user goes
 *       SILENTLY DEAF: no badge, no green border, no notification. In a
 *       marketplace that is a counterparty's payment message you never see, an
 *       order that expires, and a dispute you lose. This is the one that costs
 *       money.
 *    2. becomes an archived thread's watermark, so it can never resurrect.
 *    3. sorts newest forever, making the entry immune to cap()'s eviction.
 *
 *  Clamping to null means "we have no trustworthy message time here", and every
 *  caller already has a correct answer for that case: fall back to `now`. The
 *  worst a hostile timestamp can then do is nothing at all. */
export function sanitizeBlockTime(at: string | Date | null | undefined, now: number = Date.now()): Date | null {
	if (at === null || at === undefined) return null;
	const d = at instanceof Date ? at : new Date(at);
	const t = d.getTime();
	if (!Number.isFinite(t)) return null;
	if (t > now + MAX_FUTURE_SKEW_MS) return null;
	// Hand back the CALLER'S Date when it was already one. Allocating a copy is
	// wasteful and, more to the point, silently breaks reference equality for
	// every caller that compares identity — `readAck.test.ts` does exactly that.
	return d;
}

export function readAckTimestamp(latestSeenAt: Date | null, now: Date = new Date()): Date {
	// v1.7.7 — sanitise BEFORE clamping. `max(seen, now)` is exactly the shape
	// that hands a poisoned future timestamp straight through to the cursor.
	const seen = sanitizeBlockTime(latestSeenAt, now.getTime());
	if (seen === null || Number.isNaN(seen.getTime())) return now;
	return seen.getTime() > now.getTime() ? seen : now;
}
