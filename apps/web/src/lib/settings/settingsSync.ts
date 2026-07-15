/**
 * settingsSync — mirror the user's device-local settings to chain (v1.5.0),
 * modeled on chatFolders.ts.
 *
 * On sign-in we FETCH + DECRYPT the on-chain settings blob and APPLY it to the
 * local stores; on any subsequent settings change we AGGREGATE the local stores
 * and schedule a debounced ENCRYPTED broadcast. Encrypted with a posting-key-
 * derived key, so the operator only ever stores an opaque blob.
 *
 * Best-effort: a failed broadcast never breaks the app; the local stores keep
 * the change this session. A `ready` gate ensures the initial restore (and the
 * initial subscribe fire) never echo straight back out as a broadcast.
 */
import { get } from 'svelte/store';
import { identity } from '$stores/identity';
import { getUserBlurtAccount } from '$blurt/ops/profile';
import { getUserSettings } from '$lib/indexer/client';
import { decryptSettingsState } from '$lib/settings/settingsCrypto';
import { broadcastSettings, type UserSettingsState } from '$blurt/ops/settings';
import {
	userPreferences,
	setPreference,
	getPreferencesSnapshot,
	type UserPreferences
} from '$stores/userPreferences';
import { hiddenAccounts, hideAccount, clearAllHidden } from '$lib/utils/hiddenAccounts';
import {
	notificationPrefs,
	setCategory,
	setChannel,
	setPushPrivacy,
	setQuietHours,
	type NotificationPrefs
} from '$lib/notifications/preferences';
import {
	crossPageTradeEventsEnabled,
	enableCrossPageTradeEvents,
	disableCrossPageTradeEvents
} from '$lib/notifications/crossPageTradeEvents';

/** Coalesce rapid consecutive settings edits into a single broadcast. */
const BROADCAST_DEBOUNCE_MS = 4000;

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// No broadcasts until the initial on-chain restore has completed, so the
// restore's own store writes (and each store's initial subscribe fire) don't
// echo back out as a broadcast.
let ready = false;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

/** Read the current local settings into the on-chain blob shape. Sections are
 *  added here as each settings surface is wired into the mirror. */
function aggregate(): UserSettingsState {
	const n = get(notificationPrefs);
	return {
		preferences: getPreferencesSnapshot(),
		hidden: [...get(hiddenAccounts)],
		notifications: {
			categories: n.categories,
			channels: n.channels,
			pushPrivacy: n.pushPrivacy,
			quietHours: n.quietHours
			// mutedUntil excluded — a transient kill-switch, not a synced preference.
		},
		privacy: {
			crossPageTradeEvents: get(crossPageTradeEventsEnabled)
			// "Shared-address history" is device-only by design (the addresses
			// never leave the browser) — deliberately NOT mirrored.
		}
		// syndication (Blurt.media / Nostr URLs) lives in the on-chain profile
		// json_metadata — already synced there, so not mirrored here.
	};
}

async function broadcastNow(): Promise<void> {
	const id = get(identity);
	if (id.state !== 'unlocked') return;
	try {
		await broadcastSettings(id.live, aggregate());
	} catch {
		/* best-effort — the local stores keep the change this session */
	}
}

function scheduleBroadcast(): void {
	if (!ready) return;
	if (broadcastTimer !== null) clearTimeout(broadcastTimer);
	broadcastTimer = setTimeout(() => {
		broadcastTimer = null;
		void broadcastNow();
	}, BROADCAST_DEBOUNCE_MS);
}

/** Apply a decrypted on-chain settings blob to the local stores. Runs with
 *  `ready === false` so these writes never trigger a re-broadcast. Every field
 *  is validated + optional — an absent/garbage section leaves the device value
 *  untouched. */
function applyRestored(state: UserSettingsState): void {
	if (state.preferences && typeof state.preferences === 'object') {
		const p = state.preferences as Partial<UserPreferences>;
		if (typeof p.fiat === 'string') setPreference('fiat', p.fiat);
		if (typeof p.region === 'string') setPreference('region', p.region);
	}
	if (Array.isArray(state.hidden)) {
		clearAllHidden();
		for (const a of state.hidden) {
			if (typeof a === 'string' && a.length > 0) hideAccount(a);
		}
	}
	if (isObj(state.notifications)) {
		const n = state.notifications;
		const cats = isObj(n.categories) ? n.categories : {};
		for (const k of ['order', 'chat', 'feedback'] as const) {
			if (typeof cats[k] === 'boolean') setCategory(k, cats[k] as boolean);
		}
		const chans = isObj(n.channels) ? n.channels : {};
		for (const k of ['native', 'push', 'audio', 'vibrate'] as const) {
			if (typeof chans[k] === 'boolean') setChannel(k, chans[k] as boolean);
		}
		if (n.pushPrivacy === 'self_hosted' || n.pushPrivacy === 'standard' || n.pushPrivacy === 'off') {
			setPushPrivacy(n.pushPrivacy);
		}
		if (isObj(n.quietHours)) {
			const q = n.quietHours;
			const patch: Partial<NotificationPrefs['quietHours']> = {};
			if (typeof q.enabled === 'boolean') patch.enabled = q.enabled;
			if (typeof q.from === 'string') patch.from = q.from;
			if (typeof q.to === 'string') patch.to = q.to;
			setQuietHours(patch);
		}
	}
	if (isObj(state.privacy)) {
		const pv = state.privacy;
		if (typeof pv.crossPageTradeEvents === 'boolean') {
			if (pv.crossPageTradeEvents) enableCrossPageTradeEvents();
			else disableCrossPageTradeEvents();
		}
	}
}

/**
 * Start the settings mirror for the signed-in user: fetch + apply the on-chain
 * blob, then watch the local stores and broadcast (debounced) on change.
 * Returns a teardown. Intended to be started once per session (e.g. from the
 * root layout when unlocked).
 */
export function initSettingsSync(): () => void {
	// Watch every mirrored store. Changes AFTER the restore schedule a
	// broadcast; the initial subscribe fire + the restore's writes are gated
	// out by `ready`.
	const unsubs = [
		userPreferences.subscribe(() => scheduleBroadcast()),
		hiddenAccounts.subscribe(() => scheduleBroadcast()),
		notificationPrefs.subscribe(() => scheduleBroadcast()),
		crossPageTradeEventsEnabled.subscribe(() => scheduleBroadcast())
	];

	void (async () => {
		const id = get(identity);
		const account = getUserBlurtAccount();
		if (id.state === 'unlocked' && account) {
			try {
				const r = await getUserSettings(account);
				if (r.ok && r.data.enc !== null) {
					const state = await decryptSettingsState(
						id.live.posting.privateKey,
						account,
						r.data.enc
					);
					if (state !== null && typeof state === 'object') {
						applyRestored(state as UserSettingsState);
					}
				}
			} catch {
				/* keep device-local defaults */
			}
		}
		ready = true;
	})();

	return () => {
		for (const u of unsubs) u();
		if (broadcastTimer !== null) {
			clearTimeout(broadcastTimer);
			broadcastTimer = null;
		}
		ready = false;
	};
}
