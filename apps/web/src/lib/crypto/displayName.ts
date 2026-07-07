/**
 * Display-name length helpers — pure string logic, zero crypto deps.
 *
 * Extracted from crypto/profile.ts (cp404): profile.ts imports keygen
 * (→ @scure/bip39, heavy), and profileProps.ts — which sits in the root
 * layout's STATIC import closure via selfProfile → AvatarMenu — only needs
 * the trivial cap helper. Importing it from profile.ts dragged bip39 into
 * the baseline modulepreload of every page (caught by
 * crypto-blurt-not-in-baseline-closure-smoke). Keeping these here lets the
 * light consumers import the cap without the key-derivation closure.
 *
 * profile.ts re-exports these for back-compat, so existing
 * `import { capDisplayName } from '$lib/crypto/profile'` call sites are
 * unchanged.
 */

/** Maximum display-name length, in Unicode code points. */
export const DISPLAY_NAME_MAX_LENGTH = 24;
/** Minimum display-name length, in Unicode code points. */
export const DISPLAY_NAME_MIN_LENGTH = 1;

/**
 * Truncate a display name to {@link DISPLAY_NAME_MAX_LENGTH} code points
 * for DISPLAY. New names can't exceed the cap (validateDisplayName rejects
 * them), but a name set under an older, larger cap must still render inside
 * the limit — so every surface that shows a stored display name runs it
 * through this. Slices by code point (not UTF-16 unit) so an emoji counts
 * as one. Returns '' for null/empty.
 */
export function capDisplayName(name: string | null | undefined): string {
	if (!name) return '';
	const cps = [...name];
	return cps.length <= DISPLAY_NAME_MAX_LENGTH ? name : cps.slice(0, DISPLAY_NAME_MAX_LENGTH).join('');
}
