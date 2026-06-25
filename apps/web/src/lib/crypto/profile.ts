/**
 * Morphit — user profile (display-name) handling.
 *
 * The display name is a human-readable label the user chooses. It has zero
 * authority: the truncated public key, always shown beside it, is the
 * cryptographic anchor that can't be forged.
 *
 * This module enforces the name-sanitization rules from docs/SECURITY.md
 * and docs/PLAN.md:
 *   - max 40 characters
 *   - no control characters (C0/C1)
 *   - no zero-width joiners / formatters (invisible characters)
 *   - no bidirectional overrides (right-to-left attack prevention)
 *   - trimmed of leading/trailing whitespace
 *   - internal whitespace collapsed to single ASCII spaces
 *   - not starting with `@` (ASCII or fullwidth ＠) — would look
 *     like an account handle
 *   - no homoglyph impersonation of reserved operator names
 *     (Cyrillic/Greek/fullwidth substitutions for Latin; see
 *     `confusables.ts` for the mapping table). Finding K option (c).
 *
 * The reserved-name impersonation check catches the highest-value
 * phishing target (display_names that look like "@morphit-fees" via
 * substituted characters). Non-reserved homoglyph confusion between
 * regular users remains possible — that's an arms race — but the
 * cryptographic fingerprint always shown beside the name defeats it.
 */

import { formatPublicKey } from './keygen';
import { impersonatesReservedName } from './confusables';

export const DISPLAY_NAME_MAX_LENGTH = 40;
export const DISPLAY_NAME_MIN_LENGTH = 1;

/** Codepoints that are always forbidden in display names. */
const FORBIDDEN_CODEPOINTS = new Set<number>([
	// Bidirectional override / formatting characters
	0x202a, // LEFT-TO-RIGHT EMBEDDING
	0x202b, // RIGHT-TO-LEFT EMBEDDING
	0x202c, // POP DIRECTIONAL FORMATTING
	0x202d, // LEFT-TO-RIGHT OVERRIDE
	0x202e, // RIGHT-TO-LEFT OVERRIDE
	0x2066, // LEFT-TO-RIGHT ISOLATE
	0x2067, // RIGHT-TO-LEFT ISOLATE
	0x2068, // FIRST STRONG ISOLATE
	0x2069, // POP DIRECTIONAL ISOLATE
	// Zero-width joiners / non-joiners / spaces
	0x200b, // ZERO WIDTH SPACE
	0x200c, // ZERO WIDTH NON-JOINER
	0x200d, // ZERO WIDTH JOINER
	0xfeff, // ZERO WIDTH NO-BREAK SPACE
	// Invisible language tags
	0x2060, // WORD JOINER
	0x2061, // FUNCTION APPLICATION
	0x2062, // INVISIBLE TIMES
	0x2063, // INVISIBLE SEPARATOR
	0x2064 // INVISIBLE PLUS
]);

export interface DisplayNameValidation {
	ok: boolean;
	/** i18n key for a friendly error message; empty when ok. */
	reasonKey: string;
	/** The cleaned-up name (safe to persist) if `ok`, else the user's raw input. */
	cleaned: string;
}

function isControlChar(code: number): boolean {
	// C0: 0x00–0x1F (tab, LF, CR etc.), C1: 0x7F–0x9F. All disallowed.
	return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

/**
 * Validate + normalize a display name. Returns the cleaned form plus an
 * error i18n key if anything is wrong.
 */
export function validateDisplayName(raw: string): DisplayNameValidation {
	if (typeof raw !== 'string') {
		return { ok: false, reasonKey: 'profile.display_name.errors.invalid', cleaned: '' };
	}

	// Normalize Unicode to NFC so that visually identical sequences compare equal
	// (important because max-length is measured in code points, not bytes).
	let s = raw.normalize('NFC');

	// Strip whitespace from ends; collapse internal runs to single ASCII spaces.
	s = s.trim().replace(/\s+/g, ' ');

	if (s.length < DISPLAY_NAME_MIN_LENGTH) {
		return { ok: false, reasonKey: 'profile.display_name.errors.too_short', cleaned: s };
	}

	// Count in code points, not UTF-16 units, so a user-perceived character
	// (including most emoji) counts as one.
	const codepoints = [...s];
	if (codepoints.length > DISPLAY_NAME_MAX_LENGTH) {
		return { ok: false, reasonKey: 'profile.display_name.errors.too_long', cleaned: s };
	}

	for (const ch of codepoints) {
		const code = ch.codePointAt(0) ?? 0;
		if (isControlChar(code)) {
			return { ok: false, reasonKey: 'profile.display_name.errors.control_char', cleaned: s };
		}
		if (FORBIDDEN_CODEPOINTS.has(code)) {
			return { ok: false, reasonKey: 'profile.display_name.errors.invisible_char', cleaned: s };
		}
	}

	// Reject names that start with @ (U+0040) or fullwidth ＠
	// (U+FF20). A display name prefixed with @ visually mimics
	// an account handle, which is the impersonation vector the
	// avatar-with-name rule was designed to defeat — and works in
	// contexts where the identicon isn't rendered (SERP snippets,
	// OS notifications, screen readers). Checked AFTER trim+collapse
	// so leading whitespace can't bypass.
	// Mirrors the indexer rule in apps/indexer/src/indexer/handlers/profile.ts
	// (display_name_leading_at) so UI and on-chain validation agree.
	const firstCodePoint = codepoints[0]?.codePointAt(0) ?? 0;
	if (firstCodePoint === 0x40 || firstCodePoint === 0xff20) {
		return { ok: false, reasonKey: 'profile.display_name.errors.leading_at', cleaned: s };
	}

	// Finding K option (c) — confusable-script / homograph check.
	// A determined impersonator can substitute Cyrillic/Greek/
	// fullwidth characters for Latin ones and bypass any blocklist
	// that compares strings naively. The skeleton function maps
	// all of these to a canonical Latin form, so an input like
	// "morphit-fеes" (with Cyrillic е) skeletonizes to the same
	// value as the reserved name and gets rejected.
	// Checked LAST so more specific errors (leading @, control
	// chars) take precedence — easier for the user to understand
	// "the @ sign isn't allowed" than "your name is a homograph
	// of a reserved operator".
	if (impersonatesReservedName(s)) {
		return {
			ok: false,
			reasonKey: 'profile.display_name.errors.impersonation',
			cleaned: s
		};
	}

	return { ok: true, reasonKey: '', cleaned: s };
}

export const SHORT_BIO_MAX_LENGTH = 128;

export interface ShortBioValidation {
	ok: boolean;
	/** i18n key for a friendly error message; empty when ok. */
	reasonKey: string;
	/** The cleaned bio (safe to persist) — may be empty (the field is optional). */
	cleaned: string;
}

/**
 * Validate + normalize an OPTIONAL short bio (≤128 codepoints). Empty is
 * valid. Applies the same control-char / invisible-char / bidi-override
 * hygiene as display names, but imposes no minimum length, no leading-@
 * rule, and no reserved-name check — a bio is free text, not an identity
 * claim. Any non-length hygiene failure maps to a single generic key.
 */
export function validateShortBio(raw: string): ShortBioValidation {
	if (typeof raw !== 'string') {
		return { ok: false, reasonKey: 'profile.short_bio.errors.invalid', cleaned: '' };
	}
	// NFC-normalize, trim ends, collapse internal whitespace runs to a
	// single ASCII space (bios render on one line).
	let s = raw.normalize('NFC').trim().replace(/\s+/g, ' ');

	const codepoints = [...s];
	if (codepoints.length > SHORT_BIO_MAX_LENGTH) {
		return { ok: false, reasonKey: 'profile.short_bio.errors.too_long', cleaned: s };
	}
	for (const ch of codepoints) {
		const code = ch.codePointAt(0) ?? 0;
		if (isControlChar(code) || FORBIDDEN_CODEPOINTS.has(code)) {
			return { ok: false, reasonKey: 'profile.short_bio.errors.invalid', cleaned: s };
		}
	}
	return { ok: true, reasonKey: '', cleaned: s };
}

/**
 * Short fingerprint for a Blurt public key, safe to render in any UI.
 *
 * Example: "BLT7gHu8mn…A9bb" — first 6 and last 4 characters of the key.
 *
 * **Format rationale:**
 *
 * - `BLT` prefix: canonical Blurt prefix for every public key. Seeing this
 *   trains users to trust the key, not the surrounding name. It's the same
 *   prefix they'll see on blurt.blog, in block explorers, and in their
 *   browser extensions (WhaleVault, Gravity).
 * - 6 + 4 characters: roughly 60 bits of visible identity — enough that
 *   impersonation would require brute-forcing a vanity prefix and suffix
 *   simultaneously, while still compact enough to read at a glance.
 *
 * Phase 1 works on hex representations of the raw public key; Phase 2
 * switches to Blurt's native base58 encoding. The `BLT` prefix is
 * hardcoded here so the visual anchor is stable across that migration —
 * users who learn to recognize "BLT7gHu8mn…A9bb" in Phase 1 will still
 * recognize the same identity in Phase 2 (different encoding, same
 * fingerprint shape).
 */
export function fingerprint(publicKey: Uint8Array): string {
	const body = formatPublicKey(publicKey);
	if (body.length < 10) return `BLT${body.toUpperCase()}`; // degenerate; don't over-mask
	const head = body.slice(0, 6);
	const tail = body.slice(-4);
	return `BLT${head}…${tail}`;
}

/**
 * Full public-key string in Blurt's canonical BLT-prefixed format.
 * This is what users see when they copy their key to the clipboard —
 * and now it's a real Blurt-format key they can paste into block
 * explorers, wallets, or other Blurt tooling.
 *
 * Implementation note: Phase 1/2 used `BLT` + hex-encoded raw bytes
 * as a placeholder. Post-ADR-0007, the real base58-checksummed form
 * is used. The `BLT` visual anchor is preserved across that
 * migration — `fingerprint()` still shows the hex-based abbreviation
 * for recognizability, while the canonical paste-correct form is now
 * produced by `formatPublicKeyBLT` in `$crypto/keygen`.
 *
 * cp165 byte-budget: the sync `fullPublicKey` helper was REMOVED.
 * Its previous body called dblurt's `PublicKey.toString()` which
 * statically imported the 2 MB dblurt+libsodium+secp256k1 chunk into
 * every authenticated page through the identity-store transitive
 * load graph.  Callers that need the canonical BLT-prefixed string
 * now call the async `formatPublicKeyBLT` directly when the user
 * action triggering the need fires (hover, click, submit) — it
 * dynamically imports dblurt on first call.  First-paint rendering
 * continues to use the sync `fingerprint(publicKey)` here.
 */

/**
 * Produce the canonical "Display Name (BLT7gHu8mn…A9bb)" rendering used
 * throughout the UI. If display name is empty/unset, returns just the
 * fingerprint — the key is always the authoritative anchor.
 *
 * cp165 byte-budget: this helper used to also return a `full` field
 * (the canonical BLT-base58check string).  That field required dblurt's
 * PublicKey class which is part of a 2 MB chunk.  Callers that need
 * the canonical full key string (tooltip on hover, clipboard copy)
 * now call `formatPublicKeyBLT` (async, dynamic dblurt import) on
 * demand — see IdentityLabel.svelte for the lazy-resolve-on-hover
 * pattern.
 */
export function formatIdentity(
	displayName: string | null | undefined,
	publicKey: Uint8Array
): {
	name: string;
	fingerprint: string;
} {
	const fp = fingerprint(publicKey);
	const name = (displayName ?? '').trim();
	return { name, fingerprint: fp };
}
