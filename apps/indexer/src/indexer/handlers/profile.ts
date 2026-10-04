/**
 * Handler: morphit_profile_v1
 *
 * Payload shape:
 *   {
 *     "display_name": string (1..64 chars),
 *     "json_metadata"?: object  // optional freeform JSON
 *   }
 *
 * Effect: upsert into `profiles` for this account. The event log
 * keeps the full history; `profiles` keeps the latest.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { checkJsonbSize, MAX_JSONB_BYTES_PROFILE } from '$indexer/payloadSize';
import { impersonatesReservedName, ownsReservedName } from '$indexer/confusables';
import { consensusV2Active } from '$indexer/consensusActivation';
import { isOrderLang, ORDER_LANG_CODES } from '@morphit/operator-config';

const DISPLAY_NAME_MAX = 64;

/** Forbidden character classes in display names. We block:
 *  - C0/C1 control chars (\u0000–\u001F, \u007F–\u009F) — no
 *    legitimate use in a display name, often used to break
 *    rendering or log parsing
 *  - Bidi-override marks (U+202A–202E, U+2066–2069) — used to
 *    disguise text visually ("@morphit" that renders as
 *    something else entirely)
 *  - The zero-width space U+200B, U+2060–2064 and U+FEFF —
 *    homograph attacks against operator names (ZWNJ/ZWJ are
 *    allowed, below)
 *  This is permissive by default: emoji, scripts of any
 *  language, and punctuation are all allowed. Only the handful
 *  of character classes with no legitimate display use are
 *  rejected.
 *  U+200C (ZWNJ) and U+200D (ZWJ) are intentionally NOT blocked — the
 *  zero-width non-joiner is essential to correct Farsi / Arabic-script and Indic
 *  orthography (Persian's "half-space" / nim-fasele). Only the zero-width SPACE
 *  (U+200B) and the explicit bidi override/isolate controls stay blocked. */
const FORBIDDEN_DISPLAY_NAME_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface ValidatedPayload {
	readonly display_name: string;
	/** `display_name: null` — an explicit clear (from the activation time). */
	readonly clear_display_name: boolean;
	readonly json_metadata: Record<string, unknown>;
}

function validate(
	payload: unknown,
	signer: string,
	blockTime: Date
): ValidatedPayload | { reason: string } {
	if (!isPlainObject(payload)) return { reason: 'payload_not_object' };

	// display_name is OPTIONAL — a profile may set only an avatar
	// or links without a name. `undefined` or empty/whitespace-only
	// is treated as "no display name" (stored as '', which the
	// upsert below refuses to overwrite an existing name with).
	// From CONSENSUS_V2_ACTIVATION_TIME, `display_name: null` CLEARS the
	// stored name. An empty string cannot: it means "no name in this op" and
	// leaves the stored one alone, so there was no way to remove a name (the
	// settings page claimed it could). Before that time null is refused, as
	// it always was.
	const clearName = payload.display_name === null && consensusV2Active(blockTime);
	const dn = payload.display_name === undefined || clearName ? '' : payload.display_name;
	if (typeof dn !== 'string') return { reason: 'display_name_not_string' };
	// O3.1 — NFC-normalize first.  Without this, an attacker
	// submitting NFD-decomposed unicode (e.g., "fe\u0301es" instead
	// of "fées") bypasses the impersonatesReservedName check below:
	// the regex's character classes contain precomposed forms like
	// \u00e9 but not the bare combining-acute sequence.  Frontend
	// already NFC-normalizes before validation; mirroring on the
	// indexer closes the chain-direct attack vector.  Also makes
	// the codepoint-count check meaningful (NFC-canonical length is
	// what users perceive).
	const normalized = dn.normalize('NFC');
	// Trim for length-check purposes, but store as supplied (post-
	// NFC) so we preserve the signer's exact intent up to canonical
	// equivalence.
	const trimmed = normalized.trim();
	// Empty after trim ⇒ no display name (allowed). A non-empty name
	// must still pass the length / impersonation checks below; the
	// former one-codepoint floor is implied (any non-empty trimmed
	// value is at least one character), so no explicit min check.
	// Count user-perceived characters (code points), not UTF-16 units,
	// so "👋 Sally" isn't mis-rejected.
	if ([...trimmed].length > DISPLAY_NAME_MAX) {
		return { reason: 'display_name_too_long' };
	}
	// Reject control / bidi / zero-width characters — no
	// legitimate display use, but used by impersonation attacks.
	if (FORBIDDEN_DISPLAY_NAME_CHARS.test(trimmed)) {
		return { reason: 'display_name_forbidden_char' };
	}
	// Finding K option (b) — reject names starting with @ (or its
	// fullwidth U+FF20 confusable ＠). A display_name prefixed with
	// @ visually mimics an account handle, which enables
	// impersonation of operator accounts (e.g. "@morphit-fees")
	// in contexts where the identicon-always-rendered invariant
	// doesn't surface — SERP snippets, OS notifications, screen
	// readers with terse settings, screenshots.
	// We check the FIRST code point after trim, not raw[0], so
	// leading whitespace doesn't bypass. Fullwidth ＠ is the only
	// sufficiently common confusable to handle explicitly here; the
	// reserved-name check below compares on a confusable skeleton.
	const firstCodePoint = trimmed.codePointAt(0);
	if (firstCodePoint === 0x40 /* @ */ || firstCodePoint === 0xff20 /* ＠ */) {
		return { reason: 'display_name_leading_at' };
	}
	// Finding K option (c) — homograph impersonation of reserved
	// operator handles. Cyrillic/Greek/fullwidth/accented
	// substitutions for Latin characters can produce display_names
	// that look identical to "@morphit-fees" etc. but are different
	// byte-sequences; the homoglyph table in confusables.ts catches
	// them. From CONSENSUS_V2_ACTIVATION_TIME the name is also
	// compared on its skeleton (NFKD, default-ignorable characters and
	// combining marks removed, NFKC) — invisible characters, math
	// letters and the like no longer get a name past the table — and
	// the exact reserved string is no longer exempt for everyone.
	// Mirror of apps/web/src/lib/crypto/confusables.ts — keep the
	// two tables synchronized.
	//
	// The SIGNER is exempt on their OWN reserved name: @agorise writing
	// "Agorise" or "Trading @ Agorise" is not impersonating anybody — it is the only
	// account on the chain for whom that name is simply true. The exemption
	// is keyed on `signer`, which is chain-authenticated by `extractSigner`,
	// so no third party can assert it. Everyone else is still blocked from
	// every confusable form.
	const rule = { strict: consensusV2Active(blockTime) };
	if (!ownsReservedName(signer, trimmed, rule) && impersonatesReservedName(trimmed, rule)) {
		return { reason: 'display_name_impersonates_reserved' };
	}

	let metadata: Record<string, unknown> = {};
	if (payload.json_metadata !== undefined) {
		if (!isPlainObject(payload.json_metadata)) {
			return { reason: 'json_metadata_not_object' };
		}
		// Profile uses the larger PROFILE budget (8 KB) to make
		// room for an inline avatar alongside the other metadata
		// fields. See payloadSize.ts for the rationale. This bounds the
		// incoming OP; the handler re-checks the MERGED result too.
		const sizeCheck = checkJsonbSize(payload.json_metadata, MAX_JSONB_BYTES_PROFILE);
		if (!sizeCheck.ok) {
			return { reason: 'json_metadata_too_large' };
		}
		metadata = payload.json_metadata;
		if (consensusV2Active(blockTime)) {
			const bad = metadataProblem(metadata);
			if (bad !== null) return { reason: bad };
		}
	}

	return {
		display_name: trimmed,
		clear_display_name: clearName,
		json_metadata: metadata
	};
}

/** Longest short bio, in code points (the client's SHORT_BIO_MAX_LENGTH). */
const SHORT_BIO_MAX = 128;
/** Longest profile link. */
const PROFILE_URL_MAX = 512;
const NOSTR_URI = /^nostr:(?:npub|nprofile)1[0-9a-z]{6,400}$/;

/**
 * From CONSENSUS_V2_ACTIVATION_TIME the values of the known json_metadata
 * keys are checked before they are stored (they used to be stored as sent:
 * a bio with bidi overrides or zero-width characters, a link that is not a
 * string, or a `javascript:` link). An empty string still clears a field.
 * Returns the rejection reason, or null.
 */
function metadataProblem(m: Record<string, unknown>): string | null {
	const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(m, k);
	if (has('short_bio')) {
		const v = m.short_bio;
		if (typeof v !== 'string') return 'short_bio_not_string';
		const bio = v.normalize('NFC').trim().replace(/\s+/g, ' ');
		if ([...bio].length > SHORT_BIO_MAX) return 'short_bio_too_long';
		if (FORBIDDEN_DISPLAY_NAME_CHARS.test(bio)) return 'short_bio_forbidden_char';
	}
	for (const k of ['website_url', 'streaming_url', 'nostr_url'] as const) {
		if (!has(k)) continue;
		const v = m[k];
		if (typeof v !== 'string') return `${k}_not_string`;
		if (v.length === 0) continue; // explicit clear
		if (v.length > PROFILE_URL_MAX) return `${k}_too_long`;
		if (k === 'nostr_url' && NOSTR_URI.test(v)) continue;
		let u: URL;
		try {
			u = new URL(v);
		} catch {
			return `${k}_invalid`;
		}
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${k}_invalid`;
		if (FORBIDDEN_DISPLAY_NAME_CHARS.test(v)) return `${k}_invalid`;
	}
	for (const k of ['avatar_svg', 'avatar_data_uri'] as const) {
		if (has(k) && typeof m[k] !== 'string') return `${k}_not_string`;
	}
	if (has('avatar_data_uri')) {
		const v = m.avatar_data_uri as string;
		if (v.length > 0 && !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(v)) {
			return 'avatar_data_uri_invalid';
		}
	}
	return null;
}

/** The keys metadataProblem judges. */
const CHECKED_METADATA_KEYS = [
	'short_bio',
	'website_url',
	'streaming_url',
	'nostr_url',
	'avatar_svg',
	'avatar_data_uri'
] as const;

/**
 * For read paths that serve stored json_metadata: a copy with every checked
 * field that fails the intake rules removed (rows stored before
 * CONSENSUS_V2_ACTIVATION_TIME, or by an older indexer, may hold values the
 * handler now refuses). Other keys are kept as they are. PURE.
 */
export function sanitizeStoredProfileMetadata(meta: unknown): Record<string, unknown> {
	if (!isPlainObject(meta)) return {};
	const out: Record<string, unknown> = { ...meta };
	for (const k of CHECKED_METADATA_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(meta, k)) continue;
		if (metadataProblem({ [k]: meta[k] }) !== null) delete out[k];
	}
	return out;
}

/** json_metadata keys the profile op recognizes. CLOSED set: a merge
 *  only ever touches these, so partial updates can't accumulate unbounded
 *  keys across ops. Keep in sync with the frontend profileProps extractor
 *  (short_bio, nostr_url, streaming_url, website_url, avatar_svg,
 *  avatar_data_uri). */
const PROFILE_METADATA_KEYS = [
	'short_bio',
	'nostr_url',
	'streaming_url',
	'website_url',
	'avatar_svg',
	'avatar_data_uri',
	// v1.15.0 — ordered list of the user's preferred languages (first = primary,
	// the default for new posts; the whole set defaults the orderbook language
	// filter). An ARRAY of SUPPORTED_LOCALES codes, not a string; empty ⇒ clear.
	'preferred_langs'
] as const;

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	const v = validate(ctx.payload, ctx.signer, ctx.blockTime);
	if ('reason' in v) return { ok: false, reason: v.reason };

	// MERGE json_metadata rather than wholesale-replace, so a partial
	// profile update (e.g. broadcasting just a new short_bio) does NOT
	// orphan fields the op omits (e.g. a previously-set avatar). This
	// matches the documented op intent (an omitted field is left intact;
	// an explicit empty string clears it). Per known key: empty string ⇒
	// clear, non-empty ⇒ set, ABSENT ⇒ keep prior. Only the closed key
	// set is merged, bounding the accumulated size. Profile ops for one
	// account are applied serially in block order, so the read-then-write
	// is race-free (FOR UPDATE guards against any future concurrency).
	const existing = await client.query<{ json_metadata: Record<string, unknown> | null }>(
		'SELECT json_metadata FROM profiles WHERE account = $1 FOR UPDATE',
		[ctx.signer]
	);
	const prior = existing.rows[0]?.json_metadata ?? {};
	const incoming = v.json_metadata;
	const merged: Record<string, unknown> = {};
	for (const k of PROFILE_METADATA_KEYS) {
		if (Object.prototype.hasOwnProperty.call(incoming, k)) {
			const val = incoming[k];
			if (k === 'preferred_langs') {
				// Array of supported lang codes (first = primary). Validate + dedupe;
				// empty/all-invalid ⇒ clear (skip so it isn't carried forward).
				const arr = Array.isArray(val) ? val.filter((x): x is string => isOrderLang(x)) : [];
				const deduped = [...new Set(arr)].slice(0, ORDER_LANG_CODES.length);
				if (deduped.length === 0) continue; // explicit clear
				merged[k] = deduped; // set
				continue;
			}
			if (typeof val === 'string' && val.length === 0) continue; // explicit clear
			merged[k] = val; // set
		} else if (Object.prototype.hasOwnProperty.call(prior, k)) {
			merged[k] = prior[k]; // keep prior (omitted ⇒ unchanged)
		}
	}

	// ─── Avatar uniqueness across users ────────────────────────────
	// An avatar image may belong to only ONE account. This runs inside
	// the same FOR UPDATE transaction and the indexer applies ops
	// serially in block order, so the read-then-write is race-free.
	//
	// The `account <> signer` clause is what lets a single user remove
	// and re-upload the SAME image: their own row is excluded from the
	// conflict search, so re-claiming their own avatar never trips the
	// guard. If the merged avatar duplicates ANOTHER account's, we
	// revert just that field to this account's prior value (or drop it
	// when there was none) so the rest of the profile update — display
	// name, bio, links — still applies. The key names come from a fixed
	// allowlist (never user input), so interpolating them into the JSON
	// path operator is safe.
	for (const key of ['avatar_svg', 'avatar_data_uri'] as const) {
		const val = merged[key];
		if (typeof val !== 'string' || val.length === 0) continue;
		const dup = await client.query(
			`SELECT 1 FROM profiles WHERE account <> $1 AND json_metadata->>'${key}' = $2 LIMIT 1`,
			[ctx.signer, val]
		);
		if (dup.rowCount !== null && dup.rowCount > 0) {
			// Duplicate — do not let this account claim another's avatar.
			if (typeof prior[key] === 'string' && (prior[key] as string).length > 0) {
				merged[key] = prior[key];
			} else {
				delete merged[key];
			}
		}
	}
	// Re-check the MERGED size (not just this op) so repeated partial
	// merges can never push a profile past the budget.
	const mergedSerialized = JSON.stringify(merged);
	if (Buffer.byteLength(mergedSerialized, 'utf8') > MAX_JSONB_BYTES_PROFILE) {
		return { ok: false, reason: 'json_metadata_too_large' };
	}
	await client.query(
		`INSERT INTO profiles (
			account, display_name, json_metadata,
			source_block_num, source_trx_id, updated_at
		) VALUES ($1, $2, $3::jsonb, $4, $5, $6)
		ON CONFLICT (account) DO UPDATE SET
			display_name = CASE
				WHEN $7::boolean THEN ''
				WHEN EXCLUDED.display_name = '' THEN profiles.display_name
				ELSE EXCLUDED.display_name
			END,
			json_metadata = EXCLUDED.json_metadata,
			source_block_num = EXCLUDED.source_block_num,
			source_trx_id = EXCLUDED.source_trx_id,
			updated_at = EXCLUDED.updated_at`,
		[
			ctx.signer,
			v.display_name,
			mergedSerialized,
			ctx.blockNum,
			ctx.trxId,
			ctx.blockTime,
			v.clear_display_name
		]
	);

	return { ok: true };
};

export default handle;
