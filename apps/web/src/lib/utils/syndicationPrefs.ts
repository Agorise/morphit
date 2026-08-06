/**
 * Morphit — syndication preferences.
 *
 * Two independent, opt-in (default-OFF) syndication choices, plus a
 * per-account "first trade already happened" marker the UI uses to
 * switch the Settings card + order form between two phases.
 *
 *   (1) firstTradeAnnounce — arm the one-time first-trade
 *       announcement ("Post A" in syndication/publish.ts) to the
 *       @morphit community.  Default OFF: we never post to a
 *       community on someone's behalf unless they ask.  Offered on
 *       the order form (before the first trade), in Settings, and at
 *       feedback time (the last moment before it could fire).
 *
 *   (2) orderBlogDefault — the DEFAULT state of the per-order "post
 *       this order to my blog" checkbox ("Post B").  Default OFF.
 *       After the first trade the Settings card repurposes to toggle
 *       this instead of the (now-spent) first-trade opt-in.
 *
 *   (3) firstTradeFired.<account> — written once the first feedback
 *       (= first completed trade) is broadcast for an account on
 *       this device.  Drives the phase switch.  This module only
 *       READS it (see hasFiredFirstTrade); LeaveFeedbackForm owns
 *       the write, with its own storage-error semantics tuned for
 *       not double-firing Post A.
 *
 * Persistence: localStorage. Cleared by Reset / Sign Out via the
 * normal localStorage cleanup paths.
 */

import { writable, type Readable, get } from 'svelte/store';
import { safeLocal } from './safeStorage';

// ─── (1) first-trade announcement opt-in ───────────────────────────
const FIRST_TRADE_KEY = 'morphit.syndication.firstTradeAnnounce';

/** Default OFF — opt-in only.  Only an explicit 'true' enables it;
 *  missing / garbled / legacy values stay off. */
function readFirstTrade(): boolean {
	return safeLocal.get(FIRST_TRADE_KEY) === 'true';
}

export function setFirstTradeAnnounce(enabled: boolean): void {
	safeLocal.set(FIRST_TRADE_KEY, enabled ? 'true' : 'false');
	firstTradeStore.set(enabled);
}

/** Read once, no subscription — used by the publish pipeline at
 *  fire time where there's no reactive context. */
export function isFirstTradeAnnounceEnabled(): boolean {
	return get(firstTradeStore);
}

const firstTradeStore = writable<boolean>(readFirstTrade());

/** Subscribable view — Settings + order form bind to this. */
export const firstTradeAnnounce: Readable<boolean> = {
	subscribe: firstTradeStore.subscribe
};

// ─── (2) per-order blog-post default ───────────────────────────────
const BLOG_DEFAULT_KEY = 'morphit.syndication.orderBlogDefault';

/** Default OFF — the per-order blog checkbox starts unchecked unless
 *  the user opts in to making it the default. */
function readBlogDefault(): boolean {
	return safeLocal.get(BLOG_DEFAULT_KEY) === 'true';
}

export function setOrderBlogDefault(enabled: boolean): void {
	safeLocal.set(BLOG_DEFAULT_KEY, enabled ? 'true' : 'false');
	blogDefaultStore.set(enabled);
}

/** Read once, no subscription — used to seed the order form's
 *  per-submission checkbox. */
export function isOrderBlogDefaultEnabled(): boolean {
	return get(blogDefaultStore);
}

const blogDefaultStore = writable<boolean>(readBlogDefault());

/** Subscribable view — the Settings blog-default toggle binds here. */
export const orderBlogDefault: Readable<boolean> = {
	subscribe: blogDefaultStore.subscribe
};

// ─── (3) first-trade-fired marker (phase switch, read-only here) ────
const FIRST_TRADE_FIRED_PREFIX = 'morphit.syndication.firstTradeFired.';

/** True once the account has completed (left feedback on) its first
 *  trade on this device — i.e. the first-trade milestone is past, so
 *  the first-trade opt-in is spent and the order form / Settings
 *  switch to their second-phase affordances.  Unknown account or
 *  unreadable storage reads as "not yet" so the opt-in stays
 *  offered (the chain-side permlink dedup, plus LeaveFeedbackForm's
 *  own marker, prevent any double-post regardless). */
export function hasFiredFirstTrade(account: string | null | undefined): boolean {
	if (!account) return false;
	return safeLocal.get(`${FIRST_TRADE_FIRED_PREFIX}${account}`) === '1';
}
