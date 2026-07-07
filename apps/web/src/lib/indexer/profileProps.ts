/**
 * Extract IdentityLabel-relevant fields from a ProfileResponse.
 *
 * A ProfileResponse has an opaque `json_metadata` object whose
 * shape is convention-not-protocol. IdentityLabel expects specific
 * props (displayName, avatarSvg, avatarDataUri, nostrUrl,
 * blurtMediaUrl) and this helper bridges the two.
 *
 * Every field defaults to null if the profile is null, the
 * metadata isn't an object, or the individual value is absent /
 * wrong type / empty string. Empty-string is treated as "not set"
 * per the profile op contract — the only case where `""` means
 * something specific is "user explicitly cleared the avatar", and
 * at the label-rendering level that's indistinguishable from "not
 * set."
 *
 * Defense in depth (Finding G2.2): avatar_svg from the indexer is
 * RE-SANITIZED here before being returned. The broadcast path
 * doesn't re-sanitize ("the caller already did") and the chain
 * doesn't validate, so a malicious indexer or a profile op sent
 * via a non-Morphit client could deliver unsafe SVG. Re-sanitizing
 * on receive closes both paths. The original sanitizer is in
 * $lib/avatar; calling it here is a few-ms operation per profile,
 * negligible against the network fetch.
 *
 * Duplication note: this replaces the 4 $derived.by blocks at the
 * top of the profile-page +page.svelte. That page should switch
 * to calling this helper to eliminate the copy-paste.
 */

import type { ProfileResponse } from '@morphit/indexer-client';
import { sanitizeSvg } from '$lib/avatar';
import { capDisplayName } from '$lib/crypto/displayName';

export interface IdentityLabelProfileProps {
	readonly displayName: string | null;
	readonly avatarSvg: string | null;
	readonly avatarDataUri: string | null;
	readonly nostrUrl: string | null;
	readonly blurtMediaUrl: string | null;
	/** json_metadata.short_bio — used by the settings form to hydrate the
	 *  bio field from the current account's on-chain profile (cp346). Not
	 *  rendered by IdentityLabel itself; other callers simply ignore it. */
	readonly shortBio: string | null;
}

/** Re-sanitize an indexer-supplied SVG string.  Returns the
 *  sanitized form on success, or null on parse-failure or
 *  unsupported environment (SSR — DOMParser missing).  Empty
 *  string in returns null too. */
function safeSanitizeFromIndexer(s: string): string | null {
	if (s.length === 0) return null;
	if (typeof DOMParser === 'undefined') {
		// SSR or test environment without DOM — fall back to
		// "no avatar" rather than ship unsanitized content.
		// Production browser path always has DOMParser.
		return null;
	}
	const result = sanitizeSvg(s);
	if (!result.ok) return null;
	return result.value;
}

/** Validate that a string looks like a base64 image data URI.
 *  Returns the value unchanged when safe, or null when not.
 *
 *  O3.2 — pre-fix this was missing; profileProps accepted any
 *  non-empty string for avatar_data_uri and passed it to
 *  IdentityLabel which renders `<img src={value}>`.  A chain-
 *  direct attacker (or malicious indexer) could set this to an
 *  arbitrary URL like `https://tracker.example/pixel.gif`,
 *  causing the browser to issue an outbound GET request
 *  whenever a Morphit user's avatar surfaces — leaking user IP
 *  + referer to the attacker.
 *
 *  Permitted subtypes: webp (the canonical format produced by
 *  reencodeRaster), png, jpeg, gif.  SVG is excluded — SVG
 *  must come through avatar_svg → sanitizeSvg.  Allowing
 *  data:image/svg+xml here would bypass that sanitizer.
 *
 *  Defense-in-depth alongside G2.2's SVG re-sanitization. */
function safeValidateDataUri(s: string): string | null {
	if (s.length === 0) return null;
	// Hard length cap matching a comfortable upper bound on a
	// 96×96 base64-encoded image.  ~12KB is well above what
	// reencodeRaster produces (~2KB for a typical webp).  An
	// over-cap value is a red flag regardless of MIME — refuse.
	if (s.length > 16384) return null;
	const m = /^data:image\/(webp|png|jpeg|gif);base64,([A-Za-z0-9+/]+=*)$/.exec(s);
	if (!m) return null;
	return s;
}

/** Return a set of IdentityLabel props derived from a profile row.
 *  Passing `null` (no profile fetched yet, or no row exists) returns
 *  an all-null set — IdentityLabel falls back to the identicon. */
export function extractLabelPropsFromProfile(
	profile: ProfileResponse | null | undefined
): IdentityLabelProfileProps {
	if (!profile) {
		return {
			displayName: null,
			avatarSvg: null,
			avatarDataUri: null,
			nostrUrl: null,
			blurtMediaUrl: null,
			shortBio: null
		};
	}
	const displayName =
		typeof profile.display_name === 'string' && profile.display_name.length > 0
			? capDisplayName(profile.display_name)
			: null;

	const meta = profile.json_metadata;
	if (typeof meta !== 'object' || meta === null) {
		return {
			displayName,
			avatarSvg: null,
			avatarDataUri: null,
			nostrUrl: null,
			blurtMediaUrl: null,
			shortBio: null
		};
	}

	const m = meta as Record<string, unknown>;

	function str(key: string): string | null {
		const v = m[key];
		return typeof v === 'string' && v.length > 0 ? v : null;
	}

	// Re-sanitize the SVG. Other string fields are rendered as
	// Svelte text (auto-escaped) so they don't need this treatment.
	const rawSvg = str('avatar_svg');
	const safeSvg = rawSvg !== null ? safeSanitizeFromIndexer(rawSvg) : null;

	// O3.2 — validate avatar_data_uri shape so a hostile URL
	// can't be smuggled into <img src>.
	const rawDataUri = str('avatar_data_uri');
	const safeDataUri = rawDataUri !== null ? safeValidateDataUri(rawDataUri) : null;

	return {
		displayName,
		avatarSvg: safeSvg,
		avatarDataUri: safeDataUri,
		nostrUrl: str('nostr_url'),
		blurtMediaUrl: str('blurt_media_url'),
		shortBio: str('short_bio')
	};
}
