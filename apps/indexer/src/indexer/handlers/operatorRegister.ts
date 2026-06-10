/**
 * Handler: morphit_operator_register_v1
 *
 * Phase 5b — ADR-0013 Q1.1 (ratified: a — explicit registration).
 *
 * Payload shape:
 *   {
 *     "v": 1,
 *     "tag": string (1..64 chars, [a-z0-9._-]),
 *     "display_name": string (1..64 chars),
 *     "contact_url"?: string (optional https URL),
 *     "ts"?: number (optional unix seconds)
 *   }
 *
 * Effect:
 *   - Validates tag + display_name + optional contact_url
 *   - Inserts into `operators` — first-come-first-served on tag
 *     via UNIQUE constraint
 *   - Appends an audit row to operator_registration_events with
 *     kind='register'
 *
 * Rejection reasons:
 *   - payload_not_object
 *   - tag_* — tag validation failures
 *   - display_name_* — display name validation failures
 *   - contact_url_* — optional URL validation failures
 *   - tag_already_claimed — another account registered this tag first
 *   - account_already_registered — this account already has an
 *     operator identity (idempotent-replay isn't automatic; the
 *     account uses a separate op to change its tag or display_name
 *     once policy for that lands in ADR-0013 extensions)
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { impersonatesReservedName, isReservedTag } from '$indexer/confusables';

const TAG_MIN = 1;
const TAG_MAX = 64;
const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 64;
const CONTACT_URL_MAX = 2048;
/** Origin URL max length.  Same as contact_url; matches what most
 *  HTTP servers and reverse proxies tolerate before they choke. */
const ORIGIN_MAX = 2048;

/** Tag format: lowercase alphanumeric + dash/underscore/dot. No
 *  uppercase, no spaces, no emoji. Keeps tags URL-safe, log-safe,
 *  and impossible-to-homograph. Spec from FAQ entry
 *  `operator_registration` already shipped. */
const TAG_PATTERN = /^[a-z0-9._-]+$/;

/** Same forbidden-char class as profile display names — block
 *  control chars, bidi overrides, zero-width joiners. */
const FORBIDDEN_DISPLAY_NAME_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface ValidatedPayload {
	readonly tag: string;
	readonly display_name: string;
	readonly contact_url: string | null;
	readonly origin: string | null;
}

function validate(payload: unknown): ValidatedPayload | { reason: string } {
	if (!isPlainObject(payload)) return { reason: 'payload_not_object' };

	// tag
	const tag = payload.tag;
	if (typeof tag !== 'string') return { reason: 'tag_not_string' };
	if (tag.length < TAG_MIN) return { reason: 'tag_too_short' };
	if (tag.length > TAG_MAX) return { reason: 'tag_too_long' };
	if (!TAG_PATTERN.test(tag)) return { reason: 'tag_invalid_chars' };
	// P6-3 audit fix: reject project-reserved tags (morphit,
	// agorise, etc).  Tag is immutable post-registration so a
	// squatter could permanently own canonical names.
	if (isReservedTag(tag)) {
		return { reason: 'tag_reserved' };
	}

	// display_name
	const dn = payload.display_name;
	if (typeof dn !== 'string') return { reason: 'display_name_not_string' };
	// P6-2 audit hardening: pre-NFC length cap.  NFC normalization,
	// trim, and codepoint spread all operate on full input before
	// the post-trim length check.  DISPLAY_NAME_MAX × 4 absorbs
	// NFC expansion ratios for any realistic Unicode input.
	if (dn.length > DISPLAY_NAME_MAX * 4) {
		return { reason: 'display_name_too_long' };
	}
	// NFC-normalize so visually-equivalent sequences compare equal
	// and the codepoint length is meaningful.  Mirrors the user-
	// profile validator (Finding O1.1: bring operator name
	// validation up to user-profile parity).
	const dnNormalized = dn.normalize('NFC');
	const dnTrimmed = dnNormalized.trim();
	if (dnTrimmed.length < DISPLAY_NAME_MIN) {
		return { reason: 'display_name_too_short' };
	}
	// Count code points, not UTF-16 units, so "👋 Alice" isn't
	// mis-rejected.
	const dnCodepoints = [...dnTrimmed];
	if (dnCodepoints.length > DISPLAY_NAME_MAX) {
		return { reason: 'display_name_too_long' };
	}
	if (FORBIDDEN_DISPLAY_NAME_CHARS.test(dnTrimmed)) {
		return { reason: 'display_name_forbidden_char' };
	}
	// Reject names starting with @ (or its fullwidth U+FF20
	// confusable ＠).  A display_name prefixed with @ visually
	// mimics an account handle, which enables impersonation of
	// operator accounts (e.g. "@morphit-fees") in contexts where
	// the identicon-always-rendered invariant doesn't surface.
	// Mirrors the user-profile rule.  (O1.1)
	const firstCodePoint = dnTrimmed.codePointAt(0);
	if (firstCodePoint === 0x40 /* @ */ || firstCodePoint === 0xff20 /* ＠ */) {
		return { reason: 'display_name_leading_at' };
	}
	// Homograph impersonation of reserved operator handles —
	// Cyrillic/Greek/fullwidth substitutions for Latin produce
	// display_names that look identical to "@morphit-fees" etc.
	// but are different byte-sequences.  The skeleton function
	// maps them to a canonical form; we reject when the skeleton
	// matches a reserved name.  Mirrors the user-profile rule.
	// (O1.1)
	if (impersonatesReservedName(dnTrimmed)) {
		return { reason: 'display_name_impersonates_reserved' };
	}

	// contact_url — optional. If provided, must be a well-formed
	// http(s) URL under the length cap. We don't verify it resolves;
	// operators are responsible for keeping their own contact URL
	// live.
	let contactUrl: string | null = null;
	if (payload.contact_url !== undefined && payload.contact_url !== null) {
		if (typeof payload.contact_url !== 'string') {
			return { reason: 'contact_url_not_string' };
		}
		const cu = payload.contact_url.trim();
		if (cu.length > CONTACT_URL_MAX) {
			return { reason: 'contact_url_too_long' };
		}
		if (cu.length > 0) {
			let parsed: URL;
			try {
				parsed = new URL(cu);
			} catch {
				return { reason: 'contact_url_not_url' };
			}
			// O1.2 — https only.  Pre-fix this allowed http:// too,
			// which lets operators publish a downgrade link.  Mixed-
			// content browsers usually block clicks on these from
			// an HTTPS page, but the request still fires for
			// fingerprinting.  Match the user-profile Nostr / Blurt-
			// media validator policy: https-only.
			if (parsed.protocol !== 'https:') {
				return { reason: 'contact_url_bad_scheme' };
			}
			// O1.2 — reject userinfo (https://user:pw@host/).
			// Phishing pattern; same rule as the user-profile
			// instance-URL validator.
			if (parsed.username !== '' || parsed.password !== '') {
				return { reason: 'contact_url_has_userinfo' };
			}
			contactUrl = cu;
		}
	}

	// origin — optional (Phase D.5).  Operator's claim of where
	// their Morphit instance is reachable on the public web.
	// Same policy as contact_url plus stricter shape: must be
	// scheme + host (+ optional port) only.  Path / query /
	// fragment all forbidden because the indexer probe layer
	// appends `/v1/health` etc. to this value.  Also normalized
	// for storage so equality comparisons work: lowercase scheme +
	// host, trailing slash dropped.
	let origin: string | null = null;
	if (payload.origin !== undefined && payload.origin !== null) {
		if (typeof payload.origin !== 'string') {
			return { reason: 'origin_not_string' };
		}
		const oRaw = payload.origin.trim();
		if (oRaw.length > ORIGIN_MAX) {
			return { reason: 'origin_too_long' };
		}
		if (oRaw.length > 0) {
			let parsed: URL;
			try {
				parsed = new URL(oRaw);
			} catch {
				return { reason: 'origin_not_url' };
			}
			if (parsed.protocol !== 'https:') {
				return { reason: 'origin_bad_scheme' };
			}
			if (parsed.username !== '' || parsed.password !== '') {
				return { reason: 'origin_has_userinfo' };
			}
			// Reject anything beyond scheme + host + port.
			if (parsed.pathname !== '/' && parsed.pathname !== '') {
				return { reason: 'origin_has_path' };
			}
			if (parsed.search !== '') {
				return { reason: 'origin_has_query' };
			}
			if (parsed.hash !== '') {
				return { reason: 'origin_has_fragment' };
			}
			// Audit 2026-05 finding 5-5: reject non-public
			// hostnames at registration to prevent SSRF via
			// federation probe.  Without this, an attacker could
			// register `https://localhost:6379/` (Redis port),
			// `https://169.254.169.254/` (AWS IMDS), `https://10.x.y.z/`
			// (RFC1918 private), or `https://[::1]/` and the
			// federation probe would fire GET requests against the
			// indexer's own internal network.
			//
			// Strategy: reject the obvious bad classes by hostname
			// pattern.  This list catches literal-private-hostname
			// attacks.  The full DNS-rebinding closure (resolve +
			// validate every returned IP + pin via custom undici
			// dispatcher to prevent TOCTOU) lives in the probe layer
			// at `federationProbe.ts:fetchJson()` — shipped Part 122
			// cp3, sentinel-locked by `P122-CP3` in
			// apps/web/scripts/persona-walkthrough-smoke.ts.  The
			// registration-time check here is defense-in-depth; the
			// probe-time check is the authoritative one.
			const hostname = parsed.hostname.toLowerCase();
			// Reject 127.0.0.0/8 explicitly.
			if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) {
				return { reason: 'origin_loopback' };
			}
			// Reject any non-routable / link-local / metadata hosts.
			if (
				hostname === 'localhost' ||
				hostname === '0.0.0.0' ||
				hostname === '[::]' ||
				hostname === '[::1]' ||
				hostname === '::1' ||
				hostname === '169.254.169.254' || // AWS / GCP IMDS
				hostname === 'metadata.google.internal'
			) {
				return { reason: 'origin_loopback' };
			}
			// Reject RFC 1918 private ranges (10.0.0.0/8,
			// 172.16.0.0/12, 192.168.0.0/16) and link-local
			// (169.254.0.0/16) by IP literal pattern.
			if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) {
				return { reason: 'origin_private' };
			}
			if (/^192\.168\.\d+\.\d+$/.test(hostname)) {
				return { reason: 'origin_private' };
			}
			if (/^172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+$/.test(hostname)) {
				return { reason: 'origin_private' };
			}
			if (/^169\.254\.\d+\.\d+$/.test(hostname)) {
				return { reason: 'origin_link_local' };
			}
			// Reject IPv6 unique-local and link-local ranges by
			// prefix (fc00::/7, fe80::/10).
			if (/^\[?(fc|fd)[0-9a-f]{2}:/i.test(hostname)) {
				return { reason: 'origin_private' };
			}
			if (/^\[?fe80:/i.test(hostname)) {
				return { reason: 'origin_link_local' };
			}
			// Reject `.local` (mDNS), `.localhost`, `.internal`
			// pseudo-TLDs.
			if (
				hostname.endsWith('.local') ||
				hostname.endsWith('.localhost') ||
				hostname.endsWith('.internal') ||
				hostname === 'broadcasthost'
			) {
				return { reason: 'origin_pseudo_tld' };
			}
			// Normalize: URL constructor lowercases scheme + host
			// already; drop trailing slash that pathname insertion
			// adds.  Result: `https://alice-morphit.example` or
			// `https://alice-morphit.example:8443`.
			origin = `${parsed.protocol}//${parsed.host}`;
		}
	}

	return {
		tag,
		display_name: dnTrimmed,
		contact_url: contactUrl,
		origin
	};
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	const v = validate(ctx.payload);
	if ('reason' in v) return { ok: false, reason: v.reason };

	// First, check that this account hasn't already registered. Per
	// Q1.1 ratification, the register op is one-time per account.
	// A future `morphit_operator_update_v1` op can change display_name
	// or contact_url, but the tag is immutable once registered (this
	// is a strict reading of first-come-first-served; the alternative
	// — letting operators change tags — creates squatting races).
	const existing = await client.query<{ account: string }>(
		'SELECT account FROM operators WHERE account = $1',
		[ctx.signer]
	);
	if (existing.rows.length > 0) {
		return { ok: false, reason: 'account_already_registered' };
	}

	// Attempt the insert. UNIQUE(tag) enforces first-come-first-served.
	// We use `ON CONFLICT DO NOTHING` combined with a follow-up check
	// so we can distinguish "tag already claimed" from "insert failed
	// for unexpected reason."
	const insertRes = await client.query<{ account: string }>(
		`INSERT INTO operators (
			account, tag, display_name, contact_url, origin, registered_in_block
		) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (tag) DO NOTHING
		RETURNING account`,
		[ctx.signer, v.tag, v.display_name, v.contact_url, v.origin, ctx.blockNum]
	);
	if (insertRes.rowCount === 0) {
		// Tag was already claimed by another account. The UNIQUE
		// constraint fired without inserting. This is expected
		// behaviour under tag races; not an error.
		return { ok: false, reason: 'tag_already_claimed' };
	}

	// Phase D.5 — populate known_instances when the operator
	// registered with an origin.  Other indexers running this
	// same handler against the same op will populate their own
	// known_instances tables identically; the chain is the
	// federation source of truth.
	//
	// ON CONFLICT DO NOTHING handles the unlikely case where two
	// operators registered with the same origin (e.g. one of them
	// typo'd the URL during registration).  First-write wins; the
	// later registration's origin lives on the operators row but
	// won't get probed until/unless the first operator deregisters.
	if (v.origin !== null) {
		await client.query(
			`INSERT INTO known_instances (
				origin, operator_account,
				registered_at_block, registered_at_time,
				last_probe_status
			) VALUES ($1, $2, $3, $4, 'never')
			ON CONFLICT (origin) DO NOTHING`,
			[v.origin, ctx.signer, ctx.blockNum, ctx.blockTime]
		);
	}

	// Audit row in the registration events log — matches the
	// class-2 materialization pattern documented in schema-v7.sql:
	// operators + operator_earnings are derivable from this table,
	// so this insert is the source of truth.
	await client.query(
		`INSERT INTO operator_registration_events (
			account, kind, payload, observed_in_block
		) VALUES ($1, 'register', $2::jsonb, $3)`,
		[
			ctx.signer,
			JSON.stringify({
				tag: v.tag,
				display_name: v.display_name,
				contact_url: v.contact_url,
				origin: v.origin,
				trx_id: ctx.trxId
			}),
			ctx.blockNum
		]
	);

	return { ok: true };
};

export default handle;
