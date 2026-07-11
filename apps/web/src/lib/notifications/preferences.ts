/**
 * Notification preferences — persisted user settings.
 *
 * One module owns all the toggle state for the notifications system.
 * Settings widgets bind to it; the notify() entry point reads it at
 * fire time so toggle changes take effect immediately without a
 * re-subscribe dance.
 *
 * Persistence: safeStorage (graceful no-op in Private Mode / Tor).
 * Schema version: bumped when we add/rename keys; older persisted
 * state is migrated or cleared depending on the change.
 *
 * All toggles default to sensible values:
 *   - order category: on (highest signal)
 *   - chat category: off (high noise; per-thread mute is a deferred
 *     feature — currently the only way to disable chat notifications
 *     is the global category toggle)
 *   - feedback category: on
 *   - ambient channels: always on (no toggle — they're free)
 *   - native API: off until user opts in
 *   - push: off until user opts in; privacy = 'standard'
 *   - audio: off
 *   - vibrate: off
 *   - quiet hours: disabled
 *   - muted-until: 0 (never muted)
 */

import { writable, type Readable } from 'svelte/store';
import { safeLocal } from '../utils/safeStorage';

const STORAGE_KEY = 'morphit.notifications.prefs.v1';

export type PushPrivacy = 'self_hosted' | 'standard' | 'off';

export interface NotificationPrefs {
	/** Which event categories produce notifications. */
	categories: {
		order: boolean;
		chat: boolean;
		feedback: boolean;
	};
	/** Which delivery channels are enabled. Ambient channels are
	 *  always on and not user-configurable — they're free. */
	channels: {
		native: boolean; // Notification API (tab-open) — phase 2
		push: boolean; // Web Push (tab-closed) — phase 3
		audio: boolean; // audio cue — phase 4
		vibrate: boolean; // mobile vibration — phase 4
	};
	/** Push service architecture choice. Only consulted when
	 *  `channels.push` is true. */
	pushPrivacy: PushPrivacy;
	/** Quiet hours — when enabled, push + audio suppress between
	 *  `from` and `to` (HH:MM in the user's local time; visual
	 *  channels keep updating). */
	quietHours: {
		enabled: boolean;
		from: string; // "22:00"
		to: string; // "07:00"
	};
	/** Unix ms timestamp until which all alerts are muted. 0 means
	 *  not muted. Set by the kill-switch in Settings. */
	mutedUntil: number;
}

const DEFAULTS: NotificationPrefs = {
	categories: { order: true, chat: true, feedback: true },
	channels: { native: false, push: false, audio: false, vibrate: false },
	pushPrivacy: 'standard',
	quietHours: { enabled: false, from: '22:00', to: '07:00' },
	mutedUntil: 0
};

/** Deep-merge defaults with persisted state so newly-added keys in
 *  later versions don't crash older persisted payloads. */
function hydrate(): NotificationPrefs {
	const raw = safeLocal.get(STORAGE_KEY);
	if (!raw) return { ...DEFAULTS };
	try {
		const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
		return {
			categories: { ...DEFAULTS.categories, ...(parsed.categories ?? {}) },
			channels: { ...DEFAULTS.channels, ...(parsed.channels ?? {}) },
			pushPrivacy: parsed.pushPrivacy ?? DEFAULTS.pushPrivacy,
			quietHours: { ...DEFAULTS.quietHours, ...(parsed.quietHours ?? {}) },
			mutedUntil: typeof parsed.mutedUntil === 'number' ? parsed.mutedUntil : 0
		};
	} catch {
		// Corrupted payload — fall back to defaults rather than crash.
		return { ...DEFAULTS };
	}
}

/** Legacy key retired 2026-07-08: the old trade-notification toggle lived
 *  in its own localStorage flag and gated order native alerts separately
 *  from the unified prefs. Order notifications now flow through notify()
 *  (gated on `channels.native`), so a user who had the legacy toggle ON
 *  wanted native order alerts — carry that intent forward by enabling
 *  channels.native. Runs exactly once: the legacy key is removed after, so
 *  it can never re-enable native against a later explicit opt-out. */
const LEGACY_TRADE_KEY = 'morphit.tradeNotifications.enabled';
function migrateLegacyTradeNotifications(prefs: NotificationPrefs): NotificationPrefs {
	const legacy = safeLocal.get(LEGACY_TRADE_KEY);
	if (legacy === null) return prefs; // nothing to migrate (new user / already done)
	safeLocal.remove(LEGACY_TRADE_KEY); // retire the key — one-time
	if (legacy === 'true' && !prefs.channels.native) {
		const migrated = { ...prefs, channels: { ...prefs.channels, native: true } };
		persist(migrated);
		return migrated;
	}
	return prefs;
}

/** cp453 (t.txt) — chat notifications are ON for everyone by default now. The
 *  DEFAULTS above already ship `chat:true` for new users, but anyone who
 *  persisted prefs BEFORE the chat default flipped false→true (cp450) carries a
 *  stale `chat:false` that overrides it. Flip that to on ONCE. A done-flag guards
 *  it so it runs a single time per browser and never re-enables against a LATER
 *  explicit opt-out (same discipline as the legacy trade-notification migration
 *  above). */
const CHAT_DEFAULT_ON_KEY = 'morphit.notif.chatDefaultOn.v1';
function migrateEnableChatByDefault(prefs: NotificationPrefs): NotificationPrefs {
	if (safeLocal.get(CHAT_DEFAULT_ON_KEY) !== null) return prefs; // already ran once
	safeLocal.set(CHAT_DEFAULT_ON_KEY, '1'); // one-time — set even when already on
	if (!prefs.categories.chat) {
		const migrated = { ...prefs, categories: { ...prefs.categories, chat: true } };
		persist(migrated);
		return migrated;
	}
	return prefs;
}

const internal = writable<NotificationPrefs>(
	migrateEnableChatByDefault(migrateLegacyTradeNotifications(hydrate()))
);

/** Subscribe-only view for consumers (Settings binds via set(), via
 *  the mutator functions below). */
export const notificationPrefs: Readable<NotificationPrefs> = {
	subscribe: internal.subscribe
};

/** The categories the user has turned OFF, in the shape the relay
 *  stores on a push subscription as its `muted_categories` blocklist
 *  (cp450 GAP A). Empty = nothing muted = every category on. Order is
 *  stable so an unchanged pref set produces an unchanged payload. */
export function mutedCategoriesFromPrefs(p: NotificationPrefs): string[] {
	return (['order', 'chat', 'feedback'] as const).filter((c) => !p.categories[c]);
}

/** Persist current state to storage. Called after every mutator. */
function persist(p: NotificationPrefs): void {
	safeLocal.set(STORAGE_KEY, JSON.stringify(p));
}

// ────────────────────────────────────────────────────────────────
// Mutators
// ────────────────────────────────────────────────────────────────

export function setCategory(category: keyof NotificationPrefs['categories'], value: boolean): void {
	internal.update((p: NotificationPrefs) => {
		const next = { ...p, categories: { ...p.categories, [category]: value } };
		persist(next);
		return next;
	});
}

export function setChannel(channel: keyof NotificationPrefs['channels'], value: boolean): void {
	internal.update((p: NotificationPrefs) => {
		const next = { ...p, channels: { ...p.channels, [channel]: value } };
		persist(next);
		return next;
	});
}

export function setPushPrivacy(level: PushPrivacy): void {
	internal.update((p: NotificationPrefs) => {
		const next = { ...p, pushPrivacy: level };
		persist(next);
		return next;
	});
}

export function setQuietHours(patch: Partial<NotificationPrefs['quietHours']>): void {
	internal.update((p: NotificationPrefs) => {
		const next = { ...p, quietHours: { ...p.quietHours, ...patch } };
		persist(next);
		return next;
	});
}

/** Mute all alert-class channels for `durationMs`. Pass Infinity or
 *  a very large number for "until I turn it back on." */
export function muteFor(durationMs: number): void {
	const until = Date.now() + durationMs;
	internal.update((p: NotificationPrefs) => {
		const next = { ...p, mutedUntil: until };
		persist(next);
		return next;
	});
}

export function unmute(): void {
	internal.update((p: NotificationPrefs) => {
		const next = { ...p, mutedUntil: 0 };
		persist(next);
		return next;
	});
}

/** True when alerts are currently suppressed by mute-until OR by
 *  quiet hours window. The notify() entry point consults this
 *  before firing alert-class channels. */
export function isCurrentlySilenced(p: NotificationPrefs): boolean {
	// Mute-until wins — user explicitly asked for silence.
	if (p.mutedUntil > Date.now()) return true;
	if (!p.quietHours.enabled) return false;

	// Quiet-hours window comparison. Both values are "HH:MM" strings
	// in the user's local time. Handles the overnight case (22:00 →
	// 07:00) by recognising `from > to` as a wraparound.
	const now = new Date();
	const nowMinutes = now.getHours() * 60 + now.getMinutes();
	const fromMinutes = parseHM(p.quietHours.from);
	const toMinutes = parseHM(p.quietHours.to);
	if (fromMinutes === null || toMinutes === null) return false;

	if (fromMinutes <= toMinutes) {
		// Non-wrapping range: 09:00 → 17:00
		return nowMinutes >= fromMinutes && nowMinutes < toMinutes;
	}
	// Wrapping range: 22:00 → 07:00
	return nowMinutes >= fromMinutes || nowMinutes < toMinutes;
}

function parseHM(s: string): number | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(s);
	if (!m) return null;
	// m[1] and m[2] are guaranteed defined when m matches
	// (mandatory captures), but TS's noUncheckedIndexedAccess
	// can't infer that.
	const h = parseInt(m[1] ?? '', 10);
	const mm = parseInt(m[2] ?? '', 10);
	if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
	return h * 60 + mm;
}
