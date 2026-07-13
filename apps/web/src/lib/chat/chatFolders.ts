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

function stateToMap(state: ChatFolderState): FolderMap {
	const now = new Date().toISOString();
	const out: FolderMap = {};
	for (const k of state.starred) if (validKey(k)) out[k] = { folder: 'starred', at: now };
	for (const k of state.archived) if (validKey(k)) out[k] = { folder: 'archived', at: now };
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

	try {
		const { decryptFolderState } = await import('./folderCrypto');
		const decrypted = await decryptFolderState(id.live.posting.privateKey, account, res.data.enc);
		if (decrypted !== null && isFolderState(decrypted)) {
			const map = cap(stateToMap(decrypted));
			writeMirror(map);
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
