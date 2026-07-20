/**
 * Serialized-JSON size cap for indexer handlers.
 *
 * Finding L in docs/REVISIT-LIST.md §F: every handler that
 * accepts a freeform JSON object (price_model on orders,
 * header on chat, json_metadata on profile, hash_manifest
 * and endpoints on release) passes it through to a JSONB
 * column with no size bound. The Blurt chain's custom_json
 * op has a de-facto ~8KB limit that gates at intake, but:
 *   (a) that limit has changed before and could change again
 *   (b) indexer replay could ingest a batch of max-size
 *       payloads in one go, exploding DB growth
 *   (c) JSONB serialization cost scales O(size)
 *
 * The fix: validate serialized length at intake, reject
 * anything over MAX_JSONB_BYTES with a stable rejection
 * reason. Cap is chosen to be comfortably larger than any
 * legitimate payload (our own ops are well under 1KB each)
 * but small enough to make abusive payloads cheap to reject.
 *
 * 4KB is the chosen value — ~8x the largest legitimate
 * payload we emit, half the chain-level limit.
 */

/** Max serialized-JSON size in bytes (default for most handlers). */
export const MAX_JSONB_BYTES = 4096;

/** Larger cap for the profile handler, which needs room for an
 *  inline avatar (SVG text or base64-encoded WebP data URI)
 *  alongside display_name + nostr_url + streaming_url + website_url. Set to
 *  match the Blurt chain-level custom_json ceiling so we don't
 *  reject a payload the chain itself would have accepted. */
export const MAX_JSONB_BYTES_PROFILE = 8192;

/** Result of a size check. */
export type SizeCheckResult =
	| { ok: true; serialized: string }
	| { ok: false; reason: 'payload_too_large' };

/** Serialize an object and enforce the size cap.
 *
 *  Returns the serialized JSON on success so callers don't
 *  double-stringify — they can pass `result.serialized`
 *  directly to `client.query(... , [result.serialized, ...])`
 *  instead of `JSON.stringify(obj)`. Using the same string
 *  both for size-check and DB write guarantees the stored
 *  value matches exactly what passed the size check.
 *
 *  The optional `maxBytes` override lets handlers with larger
 *  legitimate payloads (profile, in particular) opt into a
 *  higher ceiling. Defaults to MAX_JSONB_BYTES. */
export function checkJsonbSize(
	value: unknown,
	maxBytes: number = MAX_JSONB_BYTES
): SizeCheckResult {
	const serialized = JSON.stringify(value);
	// Byte length, not code-point length. JSON with non-ASCII
	// content (emoji, CJK characters in user-supplied fields)
	// expands under UTF-8 — the DB stores bytes, so that's what
	// we measure against.
	const bytes = new TextEncoder().encode(serialized).byteLength;
	if (bytes > maxBytes) {
		return { ok: false, reason: 'payload_too_large' };
	}
	return { ok: true, serialized };
}
