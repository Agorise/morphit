/**
 * Per-DISCUSSION folder state for the /chat inbox.
 *
 * Ken's model (t.txt): the chat inbox is an email inbox. Every discussion —
 * keyed by (peer, order) exactly like read-state — lives in exactly ONE of
 * three folders:
 *
 *   - 'inbox'    — the default. Every discussion starts here; nothing has to
 *                  be stored for it (absence from the map == inbox), which
 *                  keeps the store tiny and makes "migrate existing messages"
 *                  a no-op: they are all already in the Inbox.
 *   - 'starred'  — the user flagged it with the gold star. Shown under the
 *                  ★ Starred tab regardless of where it was before.
 *   - 'archived' — the user archived it (the old "Dismiss", now per-discussion
 *                  rather than per-person). Shown only under the Archived tab.
 *
 * Transitions (a discussion is only ever in ONE folder):
 *   - star (empty→gold):  inbox|archived → starred
 *   - star (gold→empty):  starred        → inbox
 *   - archive:            inbox|starred  → archived
 *   - restore:            archived       → inbox
 *
 * This mirrors the on-screen behaviour: starring MOVES a card to Starred and
 * un-starring MOVES it to the Inbox (never back to Archived); archiving MOVES
 * it to Archived and Restore brings it back to the Inbox.
 *
 * Storage / reactivity / privacy: identical shape to `readState` — a single
 * `safeLocal` key holding a JSON map, wrapped in a Svelte store so the inbox
 * cards, the tab counts, the global unread badge, and the in-chatroom star all
 * re-render the instant the folder changes. Same browser only (like read-state
 * and the old dismiss); the chatroom and the inbox share this store, so
 * toggling the star in a conversation is reflected on the inbox immediately.
 * A cleared localStorage loses the organisation (everything falls back to the
 * Inbox), which is the same trade-off the rest of the local chat state makes.
 */

import { writable, get, type Readable } from 'svelte/store';
import { safeLocal } from '$utils/safeStorage';

const KEY = 'morphit.chat.folders';
/** Bounded so a very heavy inbox can't grow the map without limit. Only
 *  non-default (starred/archived) discussions are stored, so this is a lot of
 *  headroom in practice. Overflow drops the oldest-touched entries. */
const MAX_ENTRIES = 1000;
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** The two NON-DEFAULT folders. 'inbox' is represented by ABSENCE from the
 *  map, so it is never a stored value. */
export type ChatFolder = 'inbox' | 'starred' | 'archived';
type StoredFolder = 'starred' | 'archived';

/** Shape in storage: threadKey → { folder, at }. `at` (ISO) is only used to
 *  decide which entries to drop when capping — newest-touched wins. */
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

function readRaw(): FolderMap {
	const raw = safeLocal.get(KEY);
	if (raw === null) return {};
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		const out: FolderMap = {};
		for (const [k, v] of Object.entries(parsed)) {
			if (typeof k !== 'string') continue;
			const nul = k.indexOf('\u0000');
			if (nul === -1) continue;
			const peer = k.slice(0, nul);
			const order = k.slice(nul + 1);
			if (!ACCOUNT_NAME_RE.test(peer) || order.length > 256) continue;
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

function writeRaw(state: FolderMap): void {
	try {
		safeLocal.set(KEY, JSON.stringify(state));
	} catch {
		// best-effort (quota / private mode) — a failed write just means the
		// organisation isn't persisted this session, never a broken inbox.
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

const foldersStore = writable<FolderMap>(readRaw());

/** Public reactive view. UI subscribes here to reflect star/archive changes. */
export const chatFolders: Readable<FolderMap> = {
	subscribe: foldersStore.subscribe
};

/** The folder a discussion is in right now. Absence → 'inbox'. */
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

/** Move a discussion into a folder. 'inbox' removes the entry (the default),
 *  the other two store it. Persists + notifies subscribers. */
export function setFolder(peer: string, orderPermlink: string, folder: ChatFolder): void {
	if (!ACCOUNT_NAME_RE.test(peer)) return;
	if (orderPermlink.length > 256) return;
	const key = threadKey(peer, orderPermlink);
	const current = get(foldersStore);
	const next: FolderMap = { ...current };
	if (folder === 'inbox') {
		if (!(key in next)) return; // already default, nothing to write
		delete next[key];
	} else {
		next[key] = { folder, at: new Date().toISOString() };
	}
	const capped = cap(next);
	writeRaw(capped);
	foldersStore.set(capped);
}

/** Star toggle: starred → inbox, anything else → starred. (Un-starring always
 *  returns to the Inbox, never to Archived — matches t.txt item 11.) */
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

/** Clear all folder state. Called by the lock-session flow alongside the other
 *  local chat state (read-state, blocks, etc.). */
export function clearChatFolders(): void {
	safeLocal.remove(KEY);
	foldersStore.set({});
}

/** Test-only: reload from storage. */
export function __reloadChatFolders(): void {
	foldersStore.set(readRaw());
}
