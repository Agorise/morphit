/**
 * Quiet hours and "Silence everything", as the service worker sees them.
 *
 * The settings live in localStorage ($lib/notifications/preferences), which a
 * service worker cannot read — so Web Push (the tab-closed channel) used to
 * ignore them. The page now copies the two fields that matter into a small
 * IndexedDB record whenever they change, and the service worker reads it
 * before showing a push notification: while silenced, the notification is
 * shown SILENT (no sound, no vibration). It cannot be skipped altogether: a
 * browser requires every push to show a notification and shows a generic one
 * of its own otherwise. Turning push off ("Off") cancels the subscription
 * itself ($lib/notifications/push setPushPrivacyLevel).
 *
 * Shared by the page and the service worker; standard APIs only. Every call
 * is best-effort and never throws.
 */

export interface SilenceState {
	/** Unix ms until which every alert is muted; 0 = not muted. */
	readonly mutedUntil: number;
	readonly quietHours: { readonly enabled: boolean; readonly from: string; readonly to: string };
}

function parseHM(s: string): number | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(s);
	if (!m) return null;
	const h = parseInt(m[1] ?? '', 10);
	const mm = parseInt(m[2] ?? '', 10);
	if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
	return h * 60 + mm;
}

/** True while `state` silences alerts at `now` (local time): muted, or inside
 *  the quiet-hours window (which may wrap past midnight, e.g. 22:00 → 07:00). */
export function isSilencedAt(state: SilenceState, now: Date): boolean {
	if (state.mutedUntil > now.getTime()) return true;
	if (!state.quietHours.enabled) return false;
	const nowMinutes = now.getHours() * 60 + now.getMinutes();
	const from = parseHM(state.quietHours.from);
	const to = parseHM(state.quietHours.to);
	if (from === null || to === null) return false;
	if (from <= to) return nowMinutes >= from && nowMinutes < to;
	return nowMinutes >= from || nowMinutes < to;
}

export const SILENCE_DB_NAME = 'morphit-notify';
const STORE = 'kv';
const RECORD = 'silence';

function openDb(): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		try {
			if (typeof indexedDB === 'undefined') return resolve(null);
			const req = indexedDB.open(SILENCE_DB_NAME, 1);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
			req.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

/** Page side: record the current quiet-hours / mute settings. */
export async function writeSilenceState(state: SilenceState): Promise<void> {
	const db = await openDb();
	if (!db) return;
	try {
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).put(
			{ mutedUntil: state.mutedUntil, quietHours: { ...state.quietHours } },
			RECORD
		);
		await new Promise<void>((resolve) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		});
	} catch {
		/* best-effort */
	} finally {
		db.close();
	}
}

/** Service-worker side: the last recorded settings, or null. */
export async function readSilenceState(): Promise<SilenceState | null> {
	const db = await openDb();
	if (!db) return null;
	try {
		const tx = db.transaction(STORE, 'readonly');
		const req = tx.objectStore(STORE).get(RECORD);
		const value = await new Promise<unknown>((resolve) => {
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
		});
		const v = value as Partial<SilenceState> | null;
		if (
			v &&
			typeof v.mutedUntil === 'number' &&
			v.quietHours &&
			typeof v.quietHours.enabled === 'boolean' &&
			typeof v.quietHours.from === 'string' &&
			typeof v.quietHours.to === 'string'
		) {
			return { mutedUntil: v.mutedUntil, quietHours: v.quietHours };
		}
		return null;
	} catch {
		return null;
	} finally {
		db.close();
	}
}
