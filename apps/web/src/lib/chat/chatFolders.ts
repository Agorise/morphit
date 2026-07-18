/**
 * Per-DISCUSSION folder state for the /chat inbox — synced ON CHAIN.
 *
 * Ken's model (t.txt): the chat inbox is an email inbox. Every discussion —
 * keyed by (peer, order) exactly like read-state — lives in exactly ONE of
 * three folders. The DEFAULT is **Inbox**: a thread nobody has filed hasn't been
 * archived or starred, so it behaves as un-filed (it shows in the Inbox and
 * counts toward unread). This is the safe default — a brand-new incoming message,
 * even for a user who has never logged in before, appears in the Inbox and
 * badges, so it can never silently hide.
 *
 *   - 'inbox'    — THE DEFAULT. Absence from the map == inbox. Nothing is stored
 *                  for it, so a fresh account and a brand-new thread are Inbox
 *                  with zero state.
 *   - 'starred'  — the user flagged it with the gold star.
 *   - 'archived' — the user explicitly archived it (per-discussion). Shown only
 *                  under the Archived tab.
 *
 * Transitions (a discussion is only ever in ONE folder):
 *   - star (empty→gold):  inbox|archived → starred
 *   - star (gold→empty):  starred        → inbox
 *   - archive:            inbox|starred  → archived
 *   - restore:            archived       → inbox
 *
 * SYNC + PRIVACY (priority #1): only the explicitly-filed folders (starred +
 * archived) are stored; inbox is absence. That state is mirrored to a
 * `safeLocal` key (instant, offline, and the source of truth for rendering) AND
 * broadcast on chain as a `morphit_chat_folders_v1` op — ENCRYPTED with a
 * posting-key-derived key (see folderCrypto), so it syncs across devices while
 * any observer of the PUBLIC chain sees only opaque ciphertext (the peers and
 * orders a user has filed never appear in the clear). Only the posting key is
 * used, so posting-only users are supported and the memo key is never touched.
 * The on-chain fetch goes through the indexer client's normal same-instance
 * channel (no third party, no CDN) and decryption is client-side only; nothing
 * about the organization is logged. On load we fetch + decrypt the on-chain
 * state (authoritative for cross-device) and adopt it; every folder action
 * updates the mirror instantly and schedules a debounced encrypted broadcast.
 */

import { writable, get, type Readable } from 'svelte/store';
import { safeLocal } from '$utils/safeStorage';
import { sanitizeBlockTime } from './readState';
import { identity } from '$stores/identity';
import { getChatFolders } from '$indexer/client';
import type { ChatFolderState } from '$blurt/ops/chatFolders';

const KEY = 'morphit.chat.folders';
/** cp474 (t.txt #5, "fastmessagestatusupdate") — wall-clock ms of the newest
 *  LOCAL folder change, persisted beside the mirror so it survives a reload.
 *
 *  THE BUG THIS FIXES. `syncChatFoldersFromChain` used to adopt the on-chain
 *  state UNCONDITIONALLY. A folder move updates the mirror instantly and
 *  schedules a 1.5s-debounced broadcast, which then has to reach a block and be
 *  indexed — so for roughly a minute the chain still serves the PRE-move state.
 *  Refresh inside that window and the mount-time sync overwrote the mirror with
 *  the stale chain copy: the move visibly UNDID itself and only "took effect"
 *  once the indexer caught up. That is exactly Ken's report — a move that
 *  doesn't stick for about a minute.
 *
 *  The endpoint has always returned `updated_at` (the indexer's row time) and
 *  the client type has always carried it; nobody read it. Comparing it against
 *  this stamp turns a blind overwrite into last-write-wins, with no change to
 *  the on-chain payload — so an older peer reading or writing
 *  `morphit_chat_folders_v1` is unaffected. */
/** Matches the on-chain per-list cap in the handler. Overflow drops
 *  oldest-touched. Only filed (starred/archived) discussions are stored. */
const MAX_ENTRIES = 300;
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
/** Coalesce rapid consecutive folder actions into a single broadcast. */
const BROADCAST_DEBOUNCE_MS = 1_500;
/** Ceiling on a single folder broadcast. Generous — a slow node on a bad
 *  connection is normal and a spurious timeout just costs a retry — but finite,
 *  because `broadcastInFlight` must always be released. See broadcastNow(). */
const BROADCAST_TIMEOUT_MS = 30_000;

export type ChatFolder = 'inbox' | 'starred' | 'archived';
/** The stored (non-default) folders. 'inbox' is ABSENCE from the map. */
type StoredFolder = 'starred' | 'archived';

interface FolderEntry {
	folder: StoredFolder;
	at: string;
}
type FolderMap = Record<string, FolderEntry>;

/** Same discussion key the inbox and read-state use. NUL cannot appear in an
 *  account name or a permlink, so no two distinct threads collide. */
function threadKey(peer: string, orderPermlink: string): string {
	return `${peer}\u0000${orderPermlink}`;
}

function validKey(k: string): boolean {
	const nul = k.indexOf('\u0000');
	if (nul === -1) return false;
	const peer = k.slice(0, nul);
	const order = k.slice(nul + 1);
	return ACCOUNT_NAME_RE.test(peer) && order.length <= 256;
}

/** Parse a stored FolderMap from a raw JSON string. */
function parseMap(raw: string | null): FolderMap {
	if (raw === null) return {};
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		const out: FolderMap = {};
		for (const [k, v] of Object.entries(parsed)) {
			if (typeof k !== 'string' || !validKey(k)) continue;
			if (typeof v !== 'object' || v === null) continue;
			const folder = (v as { folder?: unknown }).folder;
			const at = (v as { at?: unknown }).at;
			if (folder !== 'starred' && folder !== 'archived') continue;
			if (typeof at !== 'string' || Number.isNaN(new Date(at).getTime())) continue;
			out[k] = { folder, at };
		}
		return out;
	} catch {
		return {};
	}
}

function readMirror(): FolderMap {
	return parseMap(safeLocal.get(KEY));
}

function writeMirror(state: FolderMap): void {
	try {
		safeLocal.set(KEY, JSON.stringify(state));
	} catch {
		/* best-effort (quota / private mode) — a failed write just means the
		   organisation isn't persisted this session, never a broken inbox. */
	}
}


/** cp474 — stamp a LOCAL change. Called from the mutators, never from the
 *  chain-adopt path: adopting a remote change must not make the local copy look
 *  newer than the chain it just came from, or the device would refuse every
 *  subsequent sync. */
/** v1.7.7 — when this device last changed folders, measured so it is COMPARABLE
 *  to the chain's `updated_at` (a block time).
 *
 *  THE BUG: this held a bare `Date.now()`, and `syncChatFoldersFromChain`
 *  compared it against `res.data.updated_at`. Mixed bases — and the worst
 *  instance of that family here, because the guard it corrupts is the one
 *  PROTECTING un-broadcast clicks:
 *
 *      if (localAtMs > 0 && chainAtMs < localAtMs) return;   // "I'm ahead"
 *
 *  On a clock slower than the age of the chain's last write, `localAtMs` sits
 *  behind `chainAtMs`, the guard reads "the chain is ahead of me", and the sync
 *  adopts the chain's OLDER state — silently reverting every click still sitting
 *  in the 1.5s broadcast debounce. Found by Ken asking what happens when a user
 *  archives 20 threads at two clicks a second. Modelled: correct and 30s-slow
 *  survive; 90s-slow and 10min-slow lose the lot. kentest3's clock is this. The
 *  v1.7.7 15s re-sync turned a once-per-page-load window into a gun that fires
 *  every 15 seconds.
 *
 *  WHAT NOT TO DO: a plain dirty BOOLEAN removes the clock and breaks something
 *  worse — a device holding an un-broadcast change would never adopt from
 *  another device, so a star made on the phone would be lost the moment the
 *  laptop next broadcast. `chatFoldersSync.test.ts` states that property in as
 *  many words ("cross-device sync must still win — this is the property the fix
 *  must not trade away") and caught the attempt. The last-write-wins MODEL was
 *  never the problem; only its units were.
 *
 *  So: clamp, exactly as the archive watermark does. `lastAdoptedAt` is the
 *  newest block time this device has actually seen, so max(now, that) can never
 *  read as older than the chain state we already hold, whatever the local clock
 *  says — while a genuinely newer remote write still sorts above us and wins. */
const LOCAL_CHANGED_KEY = 'morphit.chat.folders.localChangedAt';

function readLocalChangedAt(): number {
	const raw = safeLocal.get(LOCAL_CHANGED_KEY);
	if (raw === null) return 0;
	const n = Number(raw);
	return Number.isFinite(n) ? n : 0;
}

function markLocalChange(): void {
	try {
		const seen = lastAdoptedAt === null ? NaN : new Date(lastAdoptedAt).getTime();
		const at = Number.isFinite(seen) ? Math.max(Date.now(), seen) : Date.now();
		safeLocal.set(LOCAL_CHANGED_KEY, String(at));
	} catch {
		/* best-effort — see writeMirror. */
	}
}

function clearLocalChange(): void {
	try {
		safeLocal.remove(LOCAL_CHANGED_KEY);
	} catch {
		/* best-effort */
	}
}

/** Keep the MAX_ENTRIES most-recently-touched entries. */
function cap(state: FolderMap): FolderMap {
	const entries = Object.entries(state);
	if (entries.length <= MAX_ENTRIES) return state;
	entries.sort((a, b) => b[1].at.localeCompare(a[1].at)); // newest first
	entries.length = MAX_ENTRIES;
	return Object.fromEntries(entries);
}

function isEmpty(map: FolderMap): boolean {
	for (const _ in map) return false;
	return true;
}

function mapToState(map: FolderMap): ChatFolderState {
	const starred: string[] = [];
	const archived: string[] = [];
	for (const [k, v] of Object.entries(map)) {
		if (v.folder === 'starred') starred.push(k);
		else if (v.folder === 'archived') archived.push(k);
	}
	return { starred, archived };
}

/**
 * On-chain shape → local map.
 *
 * cp474 — `previous` matters more than it looks. The on-chain payload is
 * `{ starred: string[], archived: string[] }` and carries NO timestamps, so this
 * has to invent an `at` for every entry it adopts. Stamping `now` unconditionally
 * (which is what it used to do) quietly breaks
 * `resurrectArchivedOnNewActivity`: that compares a thread's newest message time
 * against `entry.at`, so re-stamping every archived thread to "now" on each sync
 * makes ALL real message times look older than the archive, and a message that
 * landed while the user was away can never resurface. The Gmail behaviour the
 * function documents — "Only genuinely-newer activity resurfaces" — was being
 * switched off by its own neighbour.
 *
 * So: carry the local `at` forward for any thread we already had filed the same
 * way. The chain and the mirror agree about that thread, and the mirror is the
 * only place the real archive time still exists. `now` is kept only for entries
 * genuinely new to this device, where we honestly don't know when they were
 * filed — and where "don't resurface old history" is the right default anyway.
 */
function stateToMap(state: ChatFolderState, previous: FolderMap = {}): FolderMap {
	const now = new Date().toISOString();
	const out: FolderMap = {};
	const at = (k: string, folder: StoredFolder): string => {
		const prev = previous[k];
		return prev !== undefined && prev.folder === folder ? prev.at : now;
	};
	for (const k of state.starred) if (validKey(k)) out[k] = { folder: 'starred', at: at(k, 'starred') };
	for (const k of state.archived)
		if (validKey(k)) out[k] = { folder: 'archived', at: at(k, 'archived') };
	return out;
}

function isFolderState(v: unknown): v is ChatFolderState {
	return (
		typeof v === 'object' &&
		v !== null &&
		Array.isArray((v as ChatFolderState).starred) &&
		Array.isArray((v as ChatFolderState).archived) &&
		(v as ChatFolderState).starred.every((x) => typeof x === 'string') &&
		(v as ChatFolderState).archived.every((x) => typeof x === 'string')
	);
}

const foldersStore = writable<FolderMap>(readMirror());

/** Public reactive view. UI subscribes here to reflect star/archive changes. */
export const chatFolders: Readable<FolderMap> = {
	subscribe: foldersStore.subscribe
};

/** The folder a discussion is in right now. Absence → 'inbox' (the default). */
export function folderOf(peer: string, orderPermlink: string): ChatFolder {
	if (!ACCOUNT_NAME_RE.test(peer)) return 'inbox';
	const entry = get(foldersStore)[threadKey(peer, orderPermlink)];
	return entry ? entry.folder : 'inbox';
}

export function isStarred(peer: string, orderPermlink: string): boolean {
	return folderOf(peer, orderPermlink) === 'starred';
}

export function isArchived(peer: string, orderPermlink: string): boolean {
	return folderOf(peer, orderPermlink) === 'archived';
}

// ─── On-chain broadcast (debounced, best-effort, encrypted) ────
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

/** Broadcast the CURRENT store state to chain, ENCRYPTED. No-op when locked
 *  (the mirror still holds the change this session). Best-effort: a failed
 *  broadcast never breaks the inbox. Heavy deps are dynamically imported so the
 *  inbox bundle stays light. */
/** True while a broadcast is in flight. v1.7.7 — broadcasts must SERIALIZE.
 *
 *  Ken: "if i have 20 messages sitting in my inbox, and i want every single one
 *  of them to move to Archived and i click on one archive link for each message
 *  every half second, then nothing will malfunction or break, right?"
 *
 *  The debounce already handles the fast case correctly — `broadcastNow` reads
 *  `get(foldersStore)` at FIRE time, not at schedule time, so twenty clicks
 *  inside 1.5s collapse into one op carrying the final state. That is the batch
 *  he asked for and it was already there.
 *
 *  The hole was slower clicking. Click, pause 2s (broadcast A departs with state
 *  S0), click again 1.5s later (broadcast B departs with S1). Two ops in flight
 *  at once, and the handler is LATEST-BY-BLOCK — so if A happens to land in a
 *  later block than B, the chain's final answer is S0 and the newer change is
 *  silently undone. Nothing errors. The user just watches a thread crawl back
 *  out of Archived a minute later and reasonably concludes the app is broken.
 *
 *  One in flight at a time, and anything that arrives meanwhile re-schedules. */
let broadcastInFlight = false;
let broadcastQueued = false;

async function broadcastNow(): Promise<void> {
	const id = get(identity);
	if (id.state !== 'unlocked') return;
	if (broadcastInFlight) {
		// Don't race the op already on its way — its successor will pick up
		// whatever changed, because it re-reads the store when it fires.
		broadcastQueued = true;
		return;
	}
	broadcastInFlight = true;
	try {
		const { broadcastChatFolders } = await import('$blurt/ops/chatFolders');
		// v1.7.7 — the in-flight guard NEEDS a way out.
		//
		// `broadcastChatFolders` has no timeout of its own, so a request that never
		// settles would pin `broadcastInFlight` forever and every later folder
		// change would queue behind it for the rest of the session — silently, with
		// the UI still showing the move. That is a worse failure than the race the
		// guard exists to prevent, and it would be MY doing: before the guard, a
		// hung request blocked nothing.
		//
		// A timeout turns "hung" into "failed", which is a state we already handle
		// correctly: the dirty stamp survives, so the next sync re-arms the
		// broadcast and the change still gets out.
		await Promise.race([
			broadcastChatFolders(id.live, mapToState(get(foldersStore))),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('broadcast_timeout')), BROADCAST_TIMEOUT_MS)
			)
		]);
		// Only NOW is the chain known to carry our state. Clearing the dirty flag
		// before this point would let the next sync adopt over a change that never
		// left the device.
		clearLocalChange();
	} catch {
		/* best-effort — the local mirror keeps the change, and the dirty flag
		   stays set so the next sync won't overwrite it. */
	} finally {
		broadcastInFlight = false;
		if (broadcastQueued) {
			broadcastQueued = false;
			// Changes landed while we were in flight — send the current state.
			scheduleBroadcast();
		}
	}
}

function scheduleBroadcast(): void {
	if (broadcastTimer !== null) clearTimeout(broadcastTimer);
	broadcastTimer = setTimeout(() => {
		broadcastTimer = null;
		void broadcastNow();
	}, BROADCAST_DEBOUNCE_MS);
}

/** Move a discussion into a folder. 'inbox' removes the entry (the default),
 *  the other two store it. Updates the mirror + store instantly, then schedules
 *  a debounced encrypted on-chain broadcast. */
/** v1.7.7 — the timestamp we stamp on a folder entry.
 *
 *  THE BUG THIS FIXES (Ken's kentest3): `resurrectArchivedOnNewActivity`
 *  compares this value against a thread's `last_message_at`, which is a BLOCK
 *  time from the indexer. Stamping `new Date()` compared the user's LOCAL WALL
 *  CLOCK to blockchain time — so on a machine whose clock runs even slightly
 *  slow, archiving a thread wrote `at` EARLIER than the message that was already
 *  sitting in it, the resurrect rule read that as "new activity since you
 *  archived", and the thread bounced straight back to the Inbox on the next poll.
 *
 *  That is exactly what Ken saw: archive → refresh a minute later → it's back;
 *  archive again → now `at` has crept past the block time → it sticks. And it is
 *  why kentest2 never reproduced it on identical code. **The older Brave build
 *  was a red herring — it was never the browser, and never a cache. It was the
 *  clock.**
 *
 *  The fix is to stop mixing time bases. `at` is a WATERMARK meaning "the newest
 *  message I had seen when I filed this thread", so it is measured in the same
 *  units as the thing it is compared to. Clamping to `max(now, lastMessageAt)`
 *  keeps `now` for threads with no message time yet, while guaranteeing the
 *  watermark can never sit behind a message already in the thread — the
 *  precondition for a spurious resurrect. No schema change: still one ISO string,
 *  so entries written by older builds keep working (they just keep the old
 *  wall-clock semantics until re-filed).
 *
 *  Skew in the OTHER direction (a fast clock) was never a problem here — it only
 *  makes the watermark later, and a later watermark cannot cause a false
 *  resurrect. Only false NON-resurrect, which the real message time now fixes. */
function watermark(lastMessageAt?: string): string {
	const now = Date.now();
	// v1.7.7 — SANITISE first. This value comes from the operator's indexer, and
	// `max(now, seen)` would otherwise hand a hostile far-future timestamp
	// straight into the folder map: the entry could never resurrect (nothing is
	// newer than 2099) and would sort newest forever, making it immune to cap()'s
	// eviction. Found in the adversarial pass, not by a user report.
	const seenDate = sanitizeBlockTime(lastMessageAt, now);
	if (seenDate === null) return new Date(now).toISOString();
	return new Date(Math.max(now, seenDate.getTime())).toISOString();
}

export function setFolder(
	peer: string,
	orderPermlink: string,
	folder: ChatFolder,
	lastMessageAt?: string
): void {
	if (!ACCOUNT_NAME_RE.test(peer)) return;
	if (orderPermlink.length > 256) return;
	const key = threadKey(peer, orderPermlink);
	const current = get(foldersStore);
	const next: FolderMap = { ...current };
	if (folder === 'inbox') {
		if (!(key in next)) return; // already default, nothing to change
		delete next[key];
	} else {
		next[key] = { folder, at: watermark(lastMessageAt) };
	}
	const capped = cap(next);
	writeMirror(capped);
	markLocalChange();
	foldersStore.set(capped);
	scheduleBroadcast();
}

/** Star toggle: starred → inbox, anything else → starred. (Un-starring always
 *  returns to the Inbox, never to Archived.) */
export function toggleStar(peer: string, orderPermlink: string, lastMessageAt?: string): void {
	// v1.7.7 — starred entries take the SAME watermark basis as archived ones.
	//
	// [KEN] asked whether the Starred folder was covered by the clock rule. Today
	// a starred entry's `at` never meets a block time — `resurrectArchivedOn-
	// NewActivity` bails on `folder !== 'archived'` — so it was not a live bug.
	// Two things made it worth fixing anyway:
	//
	//   1. `cap()` sorts EVERY entry by `at` to evict at MAX_ENTRIES. Once
	//      archived entries clamp to max(now, blockTime) and starred ones stamp
	//      bare `now`, that sort mixes two time bases. On a slow clock archived
	//      entries stamp AHEAD of local now, sort newer, and starred entries are
	//      evicted first. The v1.7.7 watermark fix INTRODUCED that skew — before
	//      it, both were `new Date()`: consistently wrong, but comparable.
	//   2. Ken has already floated resurrecting starred threads on new activity
	//      ("or too and from the starred folder as well?"). The day that ships,
	//      a bare `now` here becomes the archive bug all over again.
	//
	// One basis for every entry costs nothing and removes both.
	setFolder(peer, orderPermlink, isStarred(peer, orderPermlink) ? 'inbox' : 'starred', lastMessageAt);
}

/** Archive a discussion (inbox|starred → archived). */
export function archiveThread(peer: string, orderPermlink: string, lastMessageAt?: string): void {
	// v1.7.7 — pass the thread's newest BLOCK time so the watermark is measured in
	// the same units as the resurrect check compares it against. See watermark().
	setFolder(peer, orderPermlink, 'archived', lastMessageAt);
}

/** Restore an archived discussion to the Inbox. */
export function restoreThread(peer: string, orderPermlink: string): void {
	setFolder(peer, orderPermlink, 'inbox');
}

/**
 * Gmail-style: pull an archived thread back into the Inbox when a message
 * arrives AFTER it was archived, so a new reply is never silently buried in
 * Archived (where it wouldn't show in the Inbox tab or feed the unread badge).
 *
 * "After it was archived" is the whole point: we compare each archived thread's
 * newest-message time to the wall-clock time we recorded when the user archived
 * it (`entry.at`). A thread the user archived AFTER reading — where the newest
 * message predates the archive — stays put, so opening the app doesn't dump the
 * whole Archived tab back into the Inbox. Only genuinely-newer activity resurfaces.
 *
 * Called by the inbox whenever the conversation list changes (poll / live ping).
 * Restoring removes the entry (Inbox = absence) and syncs on chain, so both
 * devices agree. Idempotent: a resurrected thread is no longer archived, so a
 * re-run does nothing.
 */
export function resurrectArchivedOnNewActivity(
	threads: ReadonlyArray<{ peer: string; orderPermlink: string; lastMessageAt: string }>
): void {
	const current = get(foldersStore);
	let changed = false;
	const next: FolderMap = { ...current };
	for (const t of threads) {
		if (!ACCOUNT_NAME_RE.test(t.peer)) continue;
		const entry = next[threadKey(t.peer, t.orderPermlink)];
		if (entry === undefined || entry.folder !== 'archived') continue;
		const archivedAtMs = new Date(entry.at).getTime();
		const lastMsgMs = new Date(t.lastMessageAt).getTime();
		if (Number.isFinite(archivedAtMs) && Number.isFinite(lastMsgMs) && lastMsgMs > archivedAtMs) {
			delete next[threadKey(t.peer, t.orderPermlink)]; // → Inbox (absence)
			changed = true;
		}
	}
	if (changed) {
		const capped = cap(next);
		writeMirror(capped);
		markLocalChange();
		foldersStore.set(capped);
		scheduleBroadcast();
	}
}

// ─── On-chain load / migration ─────────────────────────────────
let syncedThisSession = false;

/** v1.7.7 — the `updated_at` we last adopted, so a repeat sync that finds
 *  nothing new costs one small GET and a comparison instead of a posting-key
 *  decrypt. This is what makes `syncChatFoldersFromChain` cheap enough to call
 *  on a timer rather than once per page load.
 *
 *  Keyed on `updated_at`, NOT the `enc` ciphertext. `updated_at` is the
 *  indexer's canonical "this changed" signal; the ciphertext is an
 *  implementation detail that happens to correlate with it. Keying on the
 *  ciphertext also silently assumed encryption is deterministic per state — if
 *  a nonce ever churns, every poll would decrypt for nothing, and the
 *  optimisation would quietly evaporate with no test noticing. */
/** PERSISTED. The newest chain version this device has actually seen.
 *
 *  v1.7.7 — this began as module state, and that left a hole exactly where Ken
 *  pointed: refresh the tab, then click Archive before the first sync completes,
 *  and `lastAdoptedAt` is null, so `markLocalChange`'s watermark has nothing to
 *  clamp against and degrades to a bare `Date.now()` — the very bug it exists to
 *  prevent. On kentest3's slow clock the next sync then clobbers the click.
 *
 *  It is durable knowledge (a block time we have observed), so it belongs in
 *  storage, not in a variable that dies with the page. */
const LAST_ADOPTED_KEY = 'morphit.chat.folders.lastAdoptedAt';

let lastAdoptedAt: string | null = safeLocal.get(LAST_ADOPTED_KEY);

function setLastAdoptedAt(v: string | null): void {
	lastAdoptedAt = v;
	try {
		if (v === null) safeLocal.remove(LAST_ADOPTED_KEY);
		else safeLocal.set(LAST_ADOPTED_KEY, v);
	} catch {
		/* best-effort — see writeMirror. */
	}
}

/**
 * Fetch + decrypt the on-chain folder state and adopt it (authoritative for
 * cross-device). If the account has NO on-chain state yet but there IS local
 * filing, this performs the one-time migration: broadcast the current local
 * state so it lands on chain. A brand-new account with no local filing
 * broadcasts nothing (no pointless empty op). Best-effort — any failure leaves
 * the local mirror in place.
 *
 * v1.7.7 — SAFE TO CALL REPEATEDLY, and it must be.
 *
 * This used to be called exactly once, from a `$effect` that fired when
 * `$isUnlocked` flipped true. So a device read the chain on page load and never
 * again: Ken archived a thread on his PC and his PHONE kept showing it in the
 * Inbox until he manually refreshed. He also spotted the asymmetry that explains
 * it — un-archiving DID propagate without a refresh. That was never syncing:
 * `resurrectArchivedOnNewActivity` RE-DERIVES it locally on every conversation
 * poll from data each device already has. Archiving has nothing to re-derive
 * from — it is a decision, and it can only arrive from the chain. Nothing was
 * re-reading the chain.
 */
export async function syncChatFoldersFromChain(): Promise<void> {
	const id = get(identity);
	if (id.state !== 'unlocked') return;
	let account: string | null;
	try {
		const { getUserBlurtAccount } = await import('$blurt/ops/profile');
		account = getUserBlurtAccount();
	} catch {
		return;
	}
	if (!account) return;

	const res = await getChatFolders(account);
	if (!res.ok) return;

	if (res.data.enc === null) {
		// No on-chain state. Migrate up ONLY if there's local filing worth
		// recording — a fresh account broadcasts nothing.
		if (!syncedThisSession && !isEmpty(get(foldersStore))) {
			syncedThisSession = true;
			await broadcastNow();
		} else {
			syncedThisSession = true;
		}
		return;
	}

	// cp474 (t.txt #5) — LAST-WRITE-WINS, not blind adopt.
	//
	// This used to overwrite the mirror with whatever the chain served. But a
	// folder move updates the mirror instantly and only reaches the chain after a
	// 1.5s debounce + a block + indexing — so for ~a minute the chain still
	// serves the PRE-move state. Refreshing inside that window handed the stale
	// copy straight back over the user's own change: the move undid itself and
	// only "took effect" once the indexer caught up. That is Ken's ~1-minute
	// symptom, and it was a correctness bug, not a latency one.
	//
	// `updated_at` is the indexer's row time for this account's newest folder op.
	// It has always been on the response and on the client type — nobody read it.
	// If our newest LOCAL change is newer, the chain is behind us: keep local and
	// make sure the broadcast is still on its way. Otherwise the chain is
	// genuinely newer (another device filed something) and we adopt, which is
	// what cross-device sync is for. No on-chain payload change, so an older peer
	// reading or writing `morphit_chat_folders_v1` is unaffected.
	// v1.7.7 — LAST-WRITE-WINS without comparing a wall clock to a block time.
	//
	// This used to be `chainAtMs < localAtMs`, i.e. the indexer's block time
	// against `Date.now()` on this device. On a slow clock that reads backwards
	// and the sync adopts the chain's OLDER state, wiping out clicks still
	// sitting in the broadcast debounce. See LOCAL_DIRTY_KEY.
	//
	// The rule is unchanged in intent — a device holding un-broadcast changes is
	// AHEAD and must not be overwritten — but both sides are now measured against
	// block time, so there is no second basis to disagree with.
	const chainAtMs = res.data.updated_at !== null ? new Date(res.data.updated_at).getTime() : 0;
	const localAtMs = readLocalChangedAt();
	// `<=`, not `<`: our watermark clamps UP to the newest block time we have
	// seen, so the common case — the chain still serving the state we already
	// hold — lands on EQUAL. With `<` that read as "the chain is ahead" and
	// adopted over our own un-broadcast clicks.
	if (localAtMs > 0 && Number.isFinite(chainAtMs) && chainAtMs <= localAtMs) {
		syncedThisSession = true;
		// A reload inside the 1.5s debounce drops the timer with the page, which
		// would strand the move on this device. Re-arm it.
		scheduleBroadcast();
		return;
	}

	try {
		// v1.7.7 — chain hasn't moved since we last adopted? Nothing to do, and we
		// skip the posting-key decrypt entirely. This is what makes a repeat sync
		// cheap enough to run on a timer: one small GET and a comparison in the
		// common case, which is every case except an actual cross-device change.
		if (lastAdoptedAt !== null && res.data.updated_at === lastAdoptedAt) return;
		const { decryptFolderState } = await import('./folderCrypto');
		const decrypted = await decryptFolderState(id.live.posting.privateKey, account, res.data.enc);
		if (decrypted !== null && isFolderState(decrypted)) {
			// v1.7.7 — remember WHEN we adopted, so the next poll can skip the
			// decrypt while the chain hasn't moved. Set only on a SUCCESSFUL adopt:
			// recording a state we failed to decrypt would make us skip it forever.
			setLastAdoptedAt(res.data.updated_at);
			// Pass the current mirror so real archive times survive the adopt — see
			// stateToMap's note on why `now` for everything breaks resurrect.
			const map = cap(stateToMap(decrypted, get(foldersStore)));
			writeMirror(map);
			// v1.7.7 — we only get here when NOT dirty (the guard above returns
			// otherwise), so there is nothing to clear. Clearing anyway would be
			// actively harmful now that the flag is the only thing protecting an
			// un-broadcast change: a clear here could drop a click that arrived
			// between the fetch and this line, and the next sync would overwrite it.
			// The flag is cleared in exactly one place — a broadcast that SUCCEEDED.
			foldersStore.set(map);
			syncedThisSession = true;
		}
	} catch {
		/* decryption / parse failure — keep the local mirror */
	}
}

/** Clear all folder state. Called by the lock-session flow alongside the other
 *  local chat state (read-state, blocks, etc.). Does NOT broadcast — locking is
 *  a local action; the on-chain state stays as last synced. */
export function clearChatFolders(): void {
	if (broadcastTimer !== null) {
		clearTimeout(broadcastTimer);
		broadcastTimer = null;
	}
	syncedThisSession = false;
	// v1.7.7 — the adopted-blob memo is per-ACCOUNT state, so it dies with the
	// folder store. Leaving it set across a sign-out would let a stale memo skip
	// the decrypt for the NEXT account if their blobs happened to match, and it
	// made every test after the first one skip adoption (which is how this was
	// caught).
	setLastAdoptedAt(null);
	safeLocal.remove(KEY);
	// cp474 — drop the local-change stamp with the state it described. Leaving it
	// behind would make the next session look "ahead of the chain" while holding
	// an empty map, and the last-write-wins check would then refuse to adopt the
	// user's real folders back from chain.
	clearLocalChange();
	foldersStore.set({});
}

/** Test-only exports of the on-chain ↔ local shape bridge. Kept exported so a
 *  regression in the conversion (e.g. swapping starred/archived, or dropping
 *  entries) is caught by a round-trip test — this bridge is what syncs a user's
 *  folders to/from chain, so a silent bug here corrupts their organization. */
export const __chatFolderShape = { mapToState, stateToMap };

/** Test-only: reload from the local mirror. */
export function __reloadChatFolders(): void {
	// This hook exists to model a PAGE RELOAD, so it must drop the module state a
	// reload would drop — otherwise a test's in-flight broadcast leaks into the
	// next test and blocks it, which is exactly how the deadlock above was found.
	broadcastInFlight = false;
	broadcastQueued = false;
	if (broadcastTimer !== null) {
		clearTimeout(broadcastTimer);
		broadcastTimer = null;
	}
	// v1.7.7 — reset the adopted-blob memo with the store; a test that reloads the
	// mirror expects the next sync to actually adopt, not skip on a stale memo.
	setLastAdoptedAt(null);
	foldersStore.set(readMirror());
}
