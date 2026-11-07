/**
 * "Show Blurt profile pictures" (v1.23.3) — this browser's choice, off until
 * the visitor turns it on.
 *
 * Owner, 2026-11-06: an account's Blurt profile picture should show across
 * the site, not only on the witnesses page; a Morphit avatar wins over it
 * everywhere; and the pictures stay off until the visitor turns them on
 * ("Off until turned on"). One switch for the whole site: the witnesses
 * page's "display" link and the switch in Settings both set it, and every
 * tab follows at once.
 *
 * The pictures come from this instance (/v1/avatars, which fetches them), never
 * from the hosts the accounts chose. The choice is this device's (not the
 * account's): a shared computer's next visitor finds it as the last one left
 * it, like the language.
 */
import { readable, type Readable } from 'svelte/store';

export const BLURT_PICTURES_KEY = 'morphit.showBlurtPictures';

function read(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem(BLURT_PICTURES_KEY) === '1';
	} catch {
		return false;
	}
}

let setLocal: ((v: boolean) => void) | null = null;

/** Whether this browser shows Blurt profile pictures (false until turned on). */
export const showBlurtPictures: Readable<boolean> = readable(read(), (set) => {
	setLocal = set;
	set(read());
	const onStorage = (e: StorageEvent): void => {
		if (e.key === BLURT_PICTURES_KEY || e.key === null) set(read());
	};
	if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
	return () => {
		setLocal = null;
		if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
	};
});

/** Turn the pictures on or off, for this tab now and every other tab. */
export function setShowBlurtPictures(on: boolean): void {
	try {
		if (on) localStorage.setItem(BLURT_PICTURES_KEY, '1');
		else localStorage.removeItem(BLURT_PICTURES_KEY);
	} catch {
		// Storage blocked (private mode): the choice holds for this page only.
	}
	setLocal?.(on);
}
