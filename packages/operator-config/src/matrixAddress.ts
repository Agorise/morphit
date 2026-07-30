/**
 * Matrix address validators — single source of truth.
 *
 * Two distinct Matrix address shapes that this codebase
 * intentionally keeps separate:
 *
 *   @user:server  — MXID (user ID).  Used for PRIVATE E2E DMs.
 *                   Operator alert routing destination.  NEVER
 *                   exposed via the public /v1/instance API.
 *
 *   #room:server  — Room alias.  Used for PUBLIC group chat.
 *                   User→operator contact destination.  Exposed
 *                   via /v1/instance.operator_matrix_room and
 *                   rendered on /support, /about-this-instance,
 *                   footer.
 *
 * Why this matters: Memory's @user:server vs #room:server rule
 * says blanket @→# replacement is actively harmful — a security
 * disclosure routed to a public room is a privacy violation.
 *
 * The branded types below make it impossible to pass an MXID
 * where a room alias is expected (or vice versa) without an
 * explicit type assertion that a reviewer must approve.
 *
 * Spec references:
 *   MXID:        https://spec.matrix.org/v1.11/appendices/#user-identifiers
 *   Room alias:  https://spec.matrix.org/v1.11/appendices/#room-aliases
 *
 * Both formats:  `<sigil><localpart>:<server>`
 *
 * Localpart for MXID:        [a-z0-9._=/+-]+   (1..255 chars,
 *                            historical mixed case tolerated
 *                            for read but rejected for write)
 * Localpart for room alias:  any printable ASCII except : (no
 *                            length limit per spec, but we cap
 *                            at 255 for sanity)
 * Server:                    DNS hostname OR ipv4 OR [ipv6]
 *                            optionally with :port
 */

/** An MXID like `@alice:matrix.org`.  Branded to prevent
 *  confusion with RoomAlias. */
export type MatrixMxid = string & { readonly __brand: 'MatrixMxid' };

/** A room alias like `#agorise:matrix.org`.  Branded to prevent
 *  confusion with Mxid. */
export type MatrixRoomAlias = string & { readonly __brand: 'MatrixRoomAlias' };

/** MXID localpart per Matrix spec — lowercase + a few allowed
 *  specials.  We're strict on write (only lowercase) per the
 *  current Matrix recommendation. */
const MXID_LOCALPART_RE = /^[a-z0-9._=/+-]{1,255}$/;

/** Room-alias localpart — printable ASCII except `:`.  We
 *  additionally exclude `#` and `@` so a typo like `#@foo:bar`
 *  doesn't slip through.  Capped at 255 chars. */
const ROOM_ALIAS_LOCALPART_RE = /^[!-9;-?A-~]{1,255}$/;

/** Server part — DNS hostname (RFC 1035) OR IPv4 OR [IPv6],
 *  optionally with `:<port>`.  We're permissive on the
 *  hostname side (don't enforce TLD length) since Matrix
 *  servers can run on .local / .onion / .i2p etc. */
const SERVER_RE =
	/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/;

/** Validates that `s` is a well-formed MXID (@user:server).
 *  Returns the branded MatrixMxid type on success.
 *
 *  This is the ONLY way to construct a MatrixMxid value —
 *  there's no escape hatch.  Persona sentinels rely on this:
 *  any code path that produces an MXID must go through this
 *  function. */
export function parseMxid(s: string): MatrixMxid | null {
	if (typeof s !== 'string') return null;
	if (s.length === 0 || s.length > 512) return null;
	if (s[0] !== '@') return null;
	const colonIdx = s.indexOf(':');
	if (colonIdx < 2) return null; // need at least @x:
	const localpart = s.slice(1, colonIdx);
	const server = s.slice(colonIdx + 1);
	if (!MXID_LOCALPART_RE.test(localpart)) return null;
	if (!SERVER_RE.test(server)) return null;
	return s as MatrixMxid;
}

/** Validates that `s` is a well-formed room alias (#room:server).
 *  Returns the branded MatrixRoomAlias type on success. */
export function parseRoomAlias(s: string): MatrixRoomAlias | null {
	if (typeof s !== 'string') return null;
	if (s.length === 0 || s.length > 512) return null;
	if (s[0] !== '#') return null;
	const colonIdx = s.indexOf(':');
	if (colonIdx < 2) return null; // need at least #x:
	const localpart = s.slice(1, colonIdx);
	const server = s.slice(colonIdx + 1);
	if (!ROOM_ALIAS_LOCALPART_RE.test(localpart)) return null;
	// Disallow @ inside localpart explicitly — defense in depth
	// against a confused-deputy attack where a `#@foo:bar` is
	// crafted to look like an MXID after a buggy prefix swap.
	if (localpart.includes('@')) return null;
	if (!SERVER_RE.test(server)) return null;
	return s as MatrixRoomAlias;
}

/** Type guard: is `s` an MXID? */
export function isMxid(s: string): s is MatrixMxid {
	return parseMxid(s) !== null;
}

/** Type guard: is `s` a room alias? */
export function isRoomAlias(s: string): s is MatrixRoomAlias {
	return parseRoomAlias(s) !== null;
}

/** Example strings for wizard prompts + i18n placeholder copy.
 *  Centralized so docs, wizard, and frontend all show the same
 *  example. */
export const MATRIX_EXAMPLE_MXID = '@alice:matrix.org';
export const MATRIX_EXAMPLE_ROOM_ALIAS = '#morphit-operator:matrix.org';
