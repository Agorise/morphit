/**
 * Accounts' Blurt profile pictures on every page (v1.23.3).
 *
 * A page shows an account's Blurt picture only when the visitor turned
 * pictures on (stores/blurtPictures.ts) AND this instance can fetch them
 * (`blurt_pictures` in /v1/instance: never on a hidden-only instance), and
 * only where the account has no Morphit avatar in hand — that one wins.
 *
 * The picture is this instance's /v1/avatars/<name>. An account it has no
 * picture for answers 404: the page draws the identicon, and remembers the
 * miss for a while so the next label of that account draws the identicon at
 * once (no blank circle, no request) instead of asking again.
 */
import { derived, type Readable } from 'svelte/store';

import { instance } from '$lib/stores/instance';
import { showBlurtPictures } from '$lib/stores/blurtPictures';

/** Pictures are wanted and this instance can serve them. */
export const blurtPicturesActive: Readable<boolean> = derived(
	[showBlurtPictures, instance],
	([on, inst]) => on && inst.blurt_pictures
);

/** Pictures are switched on but this instance has not said yet whether it
 *  serves them: a picture surface waits (a quiet placeholder), so it never
 *  draws the identicon and then swaps it for the picture (review, v1.23.3). */
export const blurtPicturesUnknown: Readable<boolean> = derived(
	[showBlurtPictures, instance],
	([on, inst]) => on && !inst.loaded
);

/** A miss is trusted this long, so the next labels of that account on this
 *  page draw the identicon at once. Short (review, v1.23.3): an image error
 *  may be a passing one (a rate limit, the network), not "no picture". The
 *  instance's 404 is itself cached by the browser for a quarter hour. */
export const PICTURE_MISS_TTL_MS = 2 * 60_000;
const MISSES_MAX = 2000;
const misses = new Map<string, number>();

/** This page saw no picture for the account a moment ago. */
export function pictureKnownMissing(account: string, now: number = Date.now()): boolean {
	const at = misses.get(account);
	if (at === undefined) return false;
	if (now - at >= PICTURE_MISS_TTL_MS) {
		misses.delete(account);
		return false;
	}
	return true;
}

/** The picture did not load (none set, unreachable, rate-limited). */
export function notePictureMissing(account: string, now: number = Date.now()): void {
	misses.delete(account);
	misses.set(account, now);
	while (misses.size > MISSES_MAX) misses.delete(misses.keys().next().value!);
}

/** Tests only. */
export function _clearPictureMisses(): void {
	misses.clear();
}
