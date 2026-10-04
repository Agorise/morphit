import { CONTACT_URL_SCHEMES } from '@morphit/operator-config';
/**
 * Handler: morphit_operator_register_v1
 *
 * Phase 5b — ADR-0013 Q1.1 (ratified: a — explicit registration).
 *
 * Payload shape:
 *   {
 *     "v": 1,
 *     "tag": string (1..64 chars, [a-z0-9._-]),
 *     "display_name": string (1..64 code points),
 *     "contact_url"?: string (optional; a CONTACT_URL_SCHEMES URL, no userinfo),
 *     "origin"?: string (optional; https://host[:port] for clearnet, or
 *                http://<v3>.onion | <x>.i2p | <x>.loki for a hidden service —
 *                https:// is refused for hidden hosts, v1.20.0 S9),
 *     "alt_addresses"?: { tor?, i2p_b32?, i2p_name?, lokinet?, ens? }
 *                (optional bare hosts, each validated to its network's shape),
 *     "fee_recipient"?: string (optional; the Blurt account this instance's
 *                BLURT fees pay their 90 % owner leg to — v1.20.0, G1),
 *     "ts"?: number (optional unix seconds)
 *   }
 * Unknown fields are ignored, so an older indexer accepts a newer op (it just
 * does not act on the new field) — proven for `fee_recipient` against the
 * v1.19.0 handler.
 *
 * THE OP IS AN UPSERT KEYED ON THE SIGNING ACCOUNT (the account is the permanent
 * identity — it signs every op):
 *   - first registration: inserts into `operators`; the TAG is first-come-
 *     first-served via its UNIQUE constraint and is immutable afterwards;
 *   - re-registration by the same account with the same tag: UPDATES the mutable
 *     fields (display_name, contact_url, origin, alt addresses). This is how an
 *     operator moves between clearnet and tor-only, renames an instance, or
 *     changes contact details. A registration OLDER than the newest one applied
 *     (only reachable through the boot reconcile's replay) changes nothing
 *     (v1.20.0, E5);
 *   - a field the payload does not carry (e.g. the web form sends no `origin`
 *     or `alt_addresses`) is left as it was; `known_instances` follows the
 *     CURRENT origin: a moved origin replaces the old row, and an origin sent
 *     EMPTY withdraws it (v1.20.0, E9);
 *   - `fee_recipient` (v1.20.0, G1): an accepted op carrying it appends a row
 *     to the append-only `operator_fee_recipients` history (block + trx), which
 *     other indexers read AS OF an op's block to accept the owner leg of fees
 *     paid through this operator's instance (see $indexer/feeRecipients). An
 *     op without it leaves the history as it was;
 *   - every accepted op appends an audit row to operator_registration_events.
 *
 * Rejection reasons:
 *   - payload_not_object
 *   - tag_* — tag validation failures (incl. tag_reserved)
 *   - tag_immutable — this account already registered a different tag
 *   - tag_already_claimed — another account registered this tag first
 *   - display_name_* — display name validation failures (incl.
 *     display_name_impersonates_reserved)
 *   - contact_url_* — optional URL validation failures
 *   - origin_* — origin validation failures (scheme, userinfo, path/query/
 *     fragment, non-public address or address-like name, pseudo-TLD)
 *   - alt_* — alt address validation failures
 *   - fee_recipient_invalid — `fee_recipient` present but not a Blurt account
 *     name (a malformed fee account would pay out to nobody; refused whole)
 *   - superseded_by_newer_registration — see above (E5)
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import {
	impersonatesReservedOperatorName,
	ownsReservedName,
	isReservedTag,
	tagImpersonatesReserved
} from '$indexer/confusables';
import { consensusV2Active } from '$indexer/consensusActivation';
import { isNonPublicAddressLiteral, nameMimicsNonPublicAddress } from '@morphit/hidden-transport';
import { FEE_RECIPIENT_ACCOUNT_RE, recordFeeRecipient } from '$indexer/feeRecipients';

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
 *  control chars, bidi overrides, the zero-width space.
 *  U+200C (ZWNJ) and U+200D (ZWJ) are intentionally NOT blocked — the
 *  zero-width non-joiner is essential to correct Farsi / Arabic-script and Indic
 *  orthography (Persian's "half-space" / nim-fasele). Only the zero-width SPACE
 *  (U+200B) and the explicit bidi override/isolate controls stay blocked; normal
 *  RTL text needs none of those (direction comes from the letters; the frontend
 *  renders names with dir="auto"). */
const FORBIDDEN_DISPLAY_NAME_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface ValidatedPayload {
	readonly tag: string;
	readonly display_name: string;
	readonly contact_url: string | null;
	readonly origin: string | null;
	/** v1.15.3 — optional hidden-service addresses the operator publishes ON-CHAIN
	 *  so the federation can reach a clearnet-censored node over Tor/I2P WITHOUT
	 *  first completing a (blocked) clearnet probe. All fields optional + host-only
	 *  (no scheme). null when the operator published none. */
	readonly alt_networks: RegAltNetworks | null;
	/** Did the payload carry an `origin` key at all? Absent = leave the stored
	 *  origin (and directory row) as they are on a re-registration; present but
	 *  empty/null = withdraw it (v1.20.0, E9). */
	readonly originProvided: boolean;
	/** Same for `alt_addresses`. */
	readonly altProvided: boolean;
	/** v1.20.0 (G1) — the registered BLURT fee account, or null when the
	 *  payload does not carry one (absent / null / "": the history is left as
	 *  it was). */
	readonly fee_recipient: string | null;
}

/** On-chain-published hidden-service addresses (host strings, no scheme). */
export interface RegAltNetworks {
	readonly tor: string | null;
	readonly i2p_b32: string | null;
	readonly i2p_name: string | null;
	readonly lokinet: string | null;
	readonly ens: string | null;
}

/** One DNS label: letters, digits and inner hyphens. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/**
 * The shape each published alt address must have, by key — ONE definition for
 * the register op, the federation probe's cache of a peer's own answer, and the
 * directory output (v1.20.0, E7). The name forms used to be checked with
 * `endsWith('.i2p')` / `endsWith('.loki')` alone, so `x.com/a.i2p` passed and
 * became `http://x.com/a.i2p` — a CLEARNET link — in the directory's "I2P" pill.
 */
export const ALT_HOST_SHAPES: Readonly<
	Record<'tor' | 'i2p_b32' | 'i2p_name' | 'lokinet' | 'ens', RegExp>
> = {
	tor: /^[a-z2-7]{56}\.onion$/,
	i2p_b32: /^[a-z2-7]{52}\.b32\.i2p$/,
	i2p_name: new RegExp(`^(?!.*\\.b32\\.i2p$)(?:${LABEL}\\.)+i2p$`),
	lokinet: new RegExp(`^(?:${LABEL}\\.)+loki$`),
	ens: /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/
};

/** A published alt host, normalised, if it has its network's shape; else null. */
export function altHostFor(key: keyof typeof ALT_HOST_SHAPES, v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const h = v.trim().toLowerCase();
	if (h.length === 0 || h.length > 80) return null;
	return ALT_HOST_SHAPES[key].test(h) ? h : null;
}

export function validate(payload: unknown): ValidatedPayload | { reason: string } {
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
	// Homograph impersonation of reserved operator handles is checked in the
	// handler, where the chain-authenticated signer is available for the
	// owner-exemption and the operator-specific policy (brand allowed inside a
	// longer distinct name — "Morphit Latino"; reserved infra handles + bare-brand
	// and homographs still blocked).

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
			if (!(CONTACT_URL_SCHEMES as readonly string[]).includes(parsed.protocol)) {
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
			// Clearnet origins must be https (TLS), and hidden-service origins http
			// (v1.20.0, S9): the federation's hidden transports dial a hidden origin
			// as plain HTTP through the tunnel — the network already authenticates
			// the host and encrypts end to end — so an https:// onion was silently
			// dialled on port 80 and, where it served only 443, failed every push
			// and probe as the PEER's fault until it was pruned. Legacy https hidden
			// rows are normalised to http at dial time (hiddenOriginForDial).
			// Hidden-service networks —
			// Tor (.onion), I2P (.b32.i2p), Lokinet (.loki) — carry their own
			// end-to-end encryption + cryptographic host authentication at the
			// network layer, so http:// is the correct (and only) scheme there:
			// a clearnet CA certificate is neither obtainable nor meaningful for
			// a .onion. This is what lets a node with NO clearnet domain still
			// advertise itself to the federated directory by its onion.
			//
			// Additive + backward-compatible: existing https origins are wholly
			// unchanged, and an indexer that predates this change simply declines
			// the new onion-only registrations rather than breaking on them (the
			// on-chain op stays valid; upgraded indexers record it). http:// on a
			// clearnet host stays rejected, as does https on a bogus host below.
			const oHost = parsed.hostname.toLowerCase();
			const isHiddenServiceHost =
				/^[a-z2-7]{56}\.onion$/.test(oHost) || // Tor v3 onion (56 base32 chars)
				oHost.endsWith('.i2p') || // I2P — both the named .i2p and the .b32.i2p hash end in .i2p
				oHost.endsWith('.loki'); // Lokinet / Session name
			if (parsed.protocol === 'https:' && !isHiddenServiceHost) {
				/* clearnet — allowed */
			} else if (parsed.protocol === 'http:' && isHiddenServiceHost) {
				/* hidden service — transport encryption is at the network layer */
			} else {
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
			// at `federationProbe.ts:fetchJson()` — sentinel-locked by `P122-CP3` in
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
			// The patterns above only match an IPv4
			// literal written out in full, so an IPv4-mapped IPv6 literal
			// (`[::ffff:127.0.0.1]`, which the URL parser rewrites to
			// `[::ffff:7f00:1]`), CGNAT, 0/8 and the like slipped through; and a
			// NAME such as `10.attacker.example` was accepted outright. The name
			// is the dangerous one: the transport router used to treat any host
			// spelled with a private prefix as local, so on a hidden-only node a
			// registered `https://10.<attacker>` was resolved and dialled from
			// the node's own address on every chat push. The router now parses
			// addresses (the real fix); here, any non-public address literal is
			// rejected by parsing it, and a name whose leading labels spell a
			// non-public prefix is refused as the disguise it is.
			if (isNonPublicAddressLiteral(hostname)) {
				return { reason: 'origin_private' };
			}
			if (nameMimicsNonPublicAddress(hostname)) {
				return { reason: 'origin_ip_like_name' };
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

	// alt_addresses — OPTIONAL (v1.15.3). Hidden-service addresses published
	// on-chain so peers can reach a clearnet-censored node over Tor/I2P. Each is
	// a bare host (no scheme, no path); validated to its network's shape so a
	// bogus value can't become a probe target. Absent/empty → null.
	let alt_networks: RegAltNetworks | null = null;
	if (payload.alt_addresses !== undefined && payload.alt_addresses !== null) {
		if (!isPlainObject(payload.alt_addresses)) return { reason: 'alt_addresses_not_object' };
		const a = payload.alt_addresses;
		const host = (v: unknown, key: string): string | null | { reason: string } => {
			if (v === undefined || v === null || v === '') return null;
			if (typeof v !== 'string') return { reason: `alt_${key}_not_string` };
			const h = v.trim().toLowerCase();
			if (h.length > 80) return { reason: `alt_${key}_too_long` };
			return h;
		};
		const tor = host(a.tor, 'tor');
		if (typeof tor === 'object' && tor !== null) return tor;
		if (tor !== null && altHostFor('tor', tor) === null) return { reason: 'alt_tor_not_onion' };
		const i2pB32 = host(a.i2p_b32, 'i2p_b32');
		if (typeof i2pB32 === 'object' && i2pB32 !== null) return i2pB32;
		if (i2pB32 !== null && altHostFor('i2p_b32', i2pB32) === null)
			return { reason: 'alt_i2p_b32_invalid' };
		const i2pName = host(a.i2p_name, 'i2p_name');
		if (typeof i2pName === 'object' && i2pName !== null) return i2pName;
		if (i2pName !== null && altHostFor('i2p_name', i2pName) === null)
			return { reason: 'alt_i2p_name_invalid' };
		const loki = host(a.lokinet, 'lokinet');
		if (typeof loki === 'object' && loki !== null) return loki;
		if (loki !== null && altHostFor('lokinet', loki) === null)
			return { reason: 'alt_lokinet_invalid' };
		const ens = host(a.ens, 'ens');
		if (typeof ens === 'object' && ens !== null) return ens;
		if (ens !== null && altHostFor('ens', ens) === null) return { reason: 'alt_ens_invalid' };
		// Keep null only if EVERY field was absent — else store the object.
		if (tor || i2pB32 || i2pName || loki || ens) {
			alt_networks = {
				tor: (tor as string | null) ?? null,
				i2p_b32: (i2pB32 as string | null) ?? null,
				i2p_name: (i2pName as string | null) ?? null,
				lokinet: (loki as string | null) ?? null,
				ens: (ens as string | null) ?? null
			};
		}
	}

	// fee_recipient — OPTIONAL (v1.20.0, G1). The account this operator's
	// instance pays the 90 % owner leg of BLURT fees to. Exact account-name
	// shape, no normalisation: the value is compared byte-for-byte against the
	// `to` of fee transfers, so a value that would need fixing up is refused.
	let feeRecipient: string | null = null;
	if (
		payload.fee_recipient !== undefined &&
		payload.fee_recipient !== null &&
		payload.fee_recipient !== ''
	) {
		if (
			typeof payload.fee_recipient !== 'string' ||
			!FEE_RECIPIENT_ACCOUNT_RE.test(payload.fee_recipient)
		) {
			return { reason: 'fee_recipient_invalid' };
		}
		feeRecipient = payload.fee_recipient;
	}

	return {
		tag,
		display_name: dnTrimmed,
		contact_url: contactUrl,
		origin,
		alt_networks,
		originProvided: 'origin' in payload,
		altProvided: 'alt_addresses' in payload,
		fee_recipient: feeRecipient
	};
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	const v = validate(ctx.payload);
	if ('reason' in v) return { ok: false, reason: v.reason };

	// display-name impersonation, signer-aware. The project brand
	// ("Morphit", "Agorise") is allowed inside a longer, distinct instance name
	// so first-party regional instances can brand themselves ("Morphit Latino");
	// bare-brand/homograph impersonation and any reserved infra handle stay
	// blocked. The rightful owner of a reserved name is exempt for THAT name
	// (matches profile.ts, which operatorRegister previously did not apply).
	// From CONSENSUS_V2_ACTIVATION_TIME names are compared on their confusable
	// skeleton too (invisible characters, math letters … — confusables.ts).
	const nameRule = { strict: consensusV2Active(ctx.blockTime) };
	if (
		!ownsReservedName(ctx.signer, v.display_name, nameRule) &&
		impersonatesReservedOperatorName(v.display_name, nameRule)
	) {
		return { ok: false, reason: 'display_name_impersonates_reserved' };
	}

	// The register op is an UPSERT keyed on the signing ACCOUNT (the true, permanent
	// identity — it signs every op). A re-registration UPDATES the mutable fields
	// (origin, display_name, contact_url): this is how an operator moves between
	// clearnet and tor-only, renames their instance, or changes contact details.
	// The TAG is immutable once claimed — first-come-first-served squatting
	// protection — so a re-registration that tries to change it is rejected.
	const existing = await client.query<{ tag: string }>(
		'SELECT tag FROM operators WHERE account = $1',
		[ctx.signer]
	);
	const existingRow = existing.rows[0];
	if (existingRow !== undefined) {
		if (existingRow.tag !== v.tag) {
			// Account is registered under a different tag; the tag can't change.
			return { ok: false, reason: 'tag_immutable' };
		}
		// Same account, same tag → update the mutable fields. registered_in_block
		// is deliberately left untouched (it records the FIRST registration).
		// A field the payload does not CARRY is left as it is (v1.20.0, E9): the
		// web /run-a-node form re-registers with tag + name + contact only, and
		// used to wipe the operator's origin and addresses from `operators` while
		// the directory row stayed — two stories about one operator. An origin
		// sent EMPTY is a withdrawal.
		// last_action_block_num only moves FORWARD: the dispatcher also advances
		// it on every other Morphit op the operator signs (E6).
		//
		// MONOTONIC (v1.20.0, E5): not over a NEWER registration. Live indexing
		// applies blocks in order, so this only refuses the boot reconcile
		// replaying an OLD op a validator used to reject — which, applied over
		// the newer registration, reverted the operator's origin, name and
		// addresses, deleted the current origin's directory row with its probe
		// history, and re-inserted the old origin as 'never'.
		const upd = await client.query(
			`UPDATE operators
			 SET display_name = $2, contact_url = $3,
			     origin = CASE WHEN $7::boolean THEN $4 ELSE origin END,
			     reg_alt_networks = CASE WHEN $8::boolean THEN $5::jsonb ELSE reg_alt_networks END,
			     last_action_block_num = GREATEST(COALESCE(last_action_block_num, 0), $6)
			 WHERE account = $1
			   AND NOT EXISTS (SELECT 1 FROM operator_registration_events e
			                    WHERE e.account = $1 AND e.kind = 'register'
			                      AND e.observed_in_block > $6)`,
			[
				ctx.signer,
				v.display_name,
				v.contact_url,
				v.origin,
				v.alt_networks ? JSON.stringify(v.alt_networks) : null,
				ctx.blockNum,
				v.originProvided,
				v.altProvided
			]
		);
		if ((upd.rowCount ?? 0) === 0) {
			return { ok: false, reason: 'superseded_by_newer_registration' };
		}
	} else {
		// Confusable-aware reserved-tag check for a NEW
		// claim. What was wrong: only exact equality (isReservedTag, in
		// validate()) was checked, so `m0rphit` / `rnorphit` / `morphit-io` were
		// claimable — and a tag is immutable, so a look-alike is squatted for
		// good. Checked here, on first registration only, so an operator who
		// already holds such a tag can still update their registration; the
		// rightful owner of a reserved name may build a tag on it.
		if (!ownsReservedName(ctx.signer, v.tag) && tagImpersonatesReserved(v.tag)) {
			return { ok: false, reason: 'tag_reserved' };
		}
		// First-time registration. UNIQUE(tag) enforces first-come-first-served;
		// ON CONFLICT DO NOTHING + the rowCount check distinguishes "tag already
		// claimed by another account" from a successful insert.
		const insertRes = await client.query<{ account: string }>(
			`INSERT INTO operators (
				account, tag, display_name, contact_url, origin, registered_in_block, reg_alt_networks, last_action_block_num
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (tag) DO NOTHING
			RETURNING account`,
			[
				ctx.signer,
				v.tag,
				v.display_name,
				v.contact_url,
				v.origin,
				ctx.blockNum,
				v.alt_networks ? JSON.stringify(v.alt_networks) : null,
				ctx.blockNum
			]
		);
		if (insertRes.rowCount === 0) {
			// Tag was already claimed by another account.
			return { ok: false, reason: 'tag_already_claimed' };
		}
	}

	// Sync known_instances to the operator's CURRENT origin — this works for both a
	// first-time insert and an origin change on update (and, with no origin, for a
	// withdrawal). Drop any prior origin row
	// this operator held that is no longer current (so a clearnet→tor move does not
	// leave the old clearnet origin lingering in the directory), then upsert the
	// current origin.  ON CONFLICT (origin) DO NOTHING preserves first-write-wins if
	// two operators ever claim the same origin string, and leaves an UNCHANGED
	// origin's existing probe status/history intact (the DELETE skips it and the
	// INSERT no-ops).  Other indexers running this same handler against the same op
	// converge identically; the chain is the federation source of truth.
	if (!v.originProvided) {
		// No origin key at all: the directory row is left exactly as it is.
	} else if (v.origin === null) {
		// An origin sent EMPTY on a RE-registration: the operator runs no public
		// instance any more. Withdraw every directory row it held (v1.20.0, E9) —
		// left in place, peers kept probing and pushing chat to an origin its
		// operator had taken back. (A first registration holds no row.)
		if (existingRow !== undefined) {
			await client.query(`DELETE FROM known_instances WHERE operator_account = $1`, [ctx.signer]);
		}
	} else {
		await client.query(`DELETE FROM known_instances WHERE operator_account = $1 AND origin <> $2`, [
			ctx.signer,
			v.origin
		]);
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

	// v1.20.0 (G1) — the fee account history, keyed by this op's position.
	// Written only on an ACCEPTED op (a superseded or rejected one returned
	// above), so a boot-reconcile heal records it at the op's ORIGINAL block.
	if (v.fee_recipient !== null) {
		await recordFeeRecipient(client, {
			account: ctx.signer,
			feeRecipient: v.fee_recipient,
			blockNum: ctx.blockNum,
			trxId: ctx.trxId,
			trxInBlock: ctx.trxInBlock,
			opInTrx: ctx.opInTrx
		});
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
				fee_recipient: v.fee_recipient,
				trx_id: ctx.trxId
			}),
			ctx.blockNum
		]
	);

	return { ok: true };
};

export default handle;
