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
const LOCAL_CHANGED_KEY = 'morphit.chat.folders.localChangedAt';
/** Matches the on-chain per-list cap in the handler. Overflow drops
 *  oldest-touched. Only filed (starred/archived) discussions are stored. */
const MAX_ENTRIES = 300;
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
/** Coalesce rapid consecutive folder actions into a single broadcast. */
const BROADCAST_DEBOUNCE_MS = 1_500;

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

/** cp474 — read the newest local-change stamp. 0 when never set (fresh
 *  profile, cleared storage), which makes the chain authoritative — the right
 *  default, and the pre-cp474 behaviour. */
function readLocalChangedAt(): number {
	const raw = safeLocal.get(LOCAL_CHANGED_KEY);
	if (raw === null) return 0;
	const n = Number(raw);
	return Number.isFinite(n) ? n : 0;
}

/** cp474 — stamp a LOCAL change. Called from the mutators, never from the
 *  chain-adopt path: adopting a remote change must not make the local copy look
 *  newer than the chain it just came from, or the device would refuse every
 *  subsequent sync. */
function markLocalChange(): void {
	try {
		safeLocal.set(LOCAL_CHANGED_KEY, String(Date.now()));
	} catch {
		/* best-effort — see writeMirror. */
	}
}

/** cp474 — clear the stamp once the chain is known to carry our change, so the
 *  device stops treating itself as ahead. */
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
async function broadcastNow(): Promise<void> {
	const id = get(identity);
	if (id.state !== 'unlocked') return;
	try {
		const { broadcastChatFolders } = await import('$blurt/ops/chatFolders');
		await broadcastChatFolders(id.live, mapToState(get(foldersStore)));
	} catch {
		/* best-effort — the local mirror keeps the change this session */
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
export function setFolder(peer: string, orderPermlink: string, folder: ChatFolder): void {
	if (!ACCOUNT_NAME_RE.test(peer)) return;
	if (orderPermlink.length > 256) return;
	const key = threadKey(peer, orderPermlink);
	const current = get(foldersStore);
	const next: FolderMap = { ...current };
	if (folder === 'inbox') {
		if (!(key in next)) return; // already default, nothing to change
		delete next[key];
	} else {
		next[key] = { folder, at: new Date().toISOString() };
	}
	const capped = cap(next);
	writeMirror(capped);
	markLocalChange();
	foldersStore.set(capped);
	scheduleBroadcast();
}

/** Star toggle: starred → inbox, anything else → starred. (Un-starring always
 *  returns to the Inbox, never to Archived.) */
export function toggleStar(peer: string, orderPermlink: string): void {
	setFolder(peer, orderPermlink, isStarred(peer, orderPermlink) ? 'inbox' : 'starred');
}

/** Archive a discussion (inbox|starred → archived). */
export function archiveThread(peer: string, orderPermlink: string): void {
	setFolder(peer, orderPermlink, 'archived');
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

/**
 * Fetch + decrypt the on-chain folder state and adopt it (authoritative for
 * cross-device). Call on chat-page mount once the identity is unlocked. If the
 * account has NO on-chain state yet but there IS local filing, this performs the
 * one-time migration: broadcast the current local state so it lands on chain.
 * A brand-new account with no local filing broadcasts nothing (no pointless
 * empty op). Best-effort — any failure leaves the local mirror in place.
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
	const chainAtMs = res.data.updated_at !== null ? new Date(res.data.updated_at).getTime() : 0;
	const localAtMs = readLocalChangedAt();
	if (localAtMs > 0 && Number.isFinite(chainAtMs) && chainAtMs < localAtMs) {
		syncedThisSession = true;
		// A reload inside the 1.5s debounce drops the timer with the page, which
		// would strand the move on this device. Re-arm it.
		scheduleBroadcast();
		return;
	}

	try {
		const { decryptFolderState } = await import('./folderCrypto');
		const decrypted = await decryptFolderState(id.live.posting.privateKey, account, res.data.enc);
		if (decrypted !== null && isFolderState(decrypted)) {
			// Pass the current mirror so real archive times survive the adopt — see
			// stateToMap's note on why `now` for everything breaks resurrect.
			const map = cap(stateToMap(decrypted, get(foldersStore)));
			writeMirror(map);
			// The chain has caught up to (or overtaken) us, so this device is no
			// longer ahead. Belt-and-braces: chain timestamps advance monotonically,
			// so a stale stamp would self-heal on the next remote write anyway — but
			// carrying an "I'm ahead" claim we know to be false is how a later
			// refactor grows a real bug.
			clearLocalChange();
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
	foldersStore.set(readMirror());
}
