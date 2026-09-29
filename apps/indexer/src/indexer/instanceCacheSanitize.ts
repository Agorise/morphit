/**
 * Morphit indexer — what a PEER may put in this node's federation directory
 * (v1.20.0 fix wave, E7).
 *
 * The probe caches the name, tagline, contact link and alt addresses a peer's
 * own /v1/instance serves, and /v1/instances hands them to every browser that
 * opens the directory. They were stored exactly as sent — any JSON type, any
 * size (up to the probe's 256 KB body cap per field), any URL scheme — while
 * the SAME fields arriving by the signed register op are length-, type- and
 * shape-checked. One registered peer could add a quarter of a megabyte to every
 * directory response and every directory stream poll, put `javascript:` in its
 * contact link, and point its "Tor" pill at any clearnet URL, overriding the
 * onion it had signed on chain.
 *
 * Every field here is judged by the same rule the register op and the node's
 * own config use; anything else becomes null (the field is dropped, never the
 * whole peer). Applied when the probe WRITES the cache and again when the
 * directory READS it, so rows cached before this release are cleaned on the way
 * out without waiting for a re-probe.
 */
import { CONTACT_URL_SCHEMES } from '@morphit/operator-config';
import { altHostFor } from '$indexer/handlers/operatorRegister';
import { isPgSafeText } from '$db/pgText';

/** The node's own config limits for the same fields (MORPHIT_INSTANCE_*). */
export const CACHED_NAME_MAX = 64;
export const CACHED_TAGLINE_MAX = 200;
export const CACHED_CONTACT_URL_MAX = 2048;
export const CACHED_NOSTR_MAX = 80;

/** A string of at most `max` code points after trimming, else null. A NUL or
 *  an unpaired surrogate (v1.20.0, V3-11) is not text a peer's name can hold:
 *  null, like every other field that fails its rule. */
export function textOrNull(v: unknown, max: number): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	if (t.length === 0 || [...t].length > max || !isPgSafeText(t)) return null;
	return t;
}

/** A contact link with a scheme the register op accepts and no userinfo. */
export function contactUrlOrNull(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	if (t.length === 0 || t.length > CACHED_CONTACT_URL_MAX || !isPgSafeText(t)) return null;
	let u: URL;
	try {
		u = new URL(t);
	} catch {
		return null;
	}
	if (!(CONTACT_URL_SCHEMES as readonly string[]).includes(u.protocol)) return null;
	if (u.username !== '' || u.password !== '') return null;
	return t;
}

export interface CleanAltNetworks {
	tor: string | null;
	lokinet: string | null;
	i2p_b32: string | null;
	i2p_name: string | null;
	ens: string | null;
	nostr: string | null;
}

/**
 * Alt addresses from an UNTRUSTED blob (a peer's answer, or a cache row), each
 * kept only if it has its network's shape. A legacy single `i2p` field is
 * routed to i2p_b32 / i2p_name by that same shape check.
 */
export function altNetworksFromUntrusted(raw: unknown): CleanAltNetworks | null {
	if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	const r = raw as Record<string, unknown>;
	let i2pB32 = altHostFor('i2p_b32', r.i2p_b32);
	let i2pName = altHostFor('i2p_name', r.i2p_name);
	if (i2pB32 === null && i2pName === null) {
		i2pB32 = altHostFor('i2p_b32', r.i2p);
		i2pName = i2pB32 === null ? altHostFor('i2p_name', r.i2p) : null;
	}
	return {
		tor: altHostFor('tor', r.tor),
		lokinet: altHostFor('lokinet', r.lokinet),
		i2p_b32: i2pB32,
		i2p_name: i2pName,
		ens: altHostFor('ens', r.ens),
		nostr: textOrNull(r.nostr, CACHED_NOSTR_MAX)
	};
}
