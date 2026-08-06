/**
 * Alt-network address validation + the per-network config wiring, kept pure
 * (no prompts/IO) so the alt-address wizard's correctness is unit-tested
 * directly by alt-address-wizard-smoke.
 *
 * Address shapes (all lowercase, canonical):
 *   - Tor v3 onion:  56 base32 chars + ".onion"
 *   - Lokinet:       the full 52-char base32z address, OR a short ONS name
 *                    (e.g. "morphit.loki") — both end in ".loki"
 *   - I2P b32:       52+ base32 chars + ".b32.i2p" (52 traditional, 56+ for
 *                    encrypted leasesets)
 */

export type AltNet = 'tor' | 'lokinet' | 'i2p';

const ONION_RE = /^[a-z2-7]{56}\.onion$/;
// Full .loki is 52 base32z chars; ONS names are short and may contain hyphens.
// Accept either so an operator can advertise their ONS name in the footer.
const LOKI_RE = /^[a-z0-9][a-z0-9-]{1,62}\.loki$/;
const I2P_B32_RE = /^[a-z2-7]{52,}\.b32\.i2p$/;
// I2P vanity host-name: ordinary hostname labels ending in ".i2p" (NOT the
// ".b32.i2p" hash form — that's the b32 slot).  e.g. "morphit.i2p".
const I2P_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.i2p$/;
// ENS name: one or more ASCII hostname labels ending in ".eth".  e.g.
// "morphit.eth" or a subdomain "node.morphit.eth".  This is a FORMAT check on
// the common ASCII case (no on-chain resolution, no UTS-46/emoji normalization
// — consistent with how the onion/i2p addresses are validated by shape, not
// resolved, and with the "tiny footprint, no extra deps" posture). ENS is a
// registered NAME (like the I2P vanity name), not a self-generated address, so
// it lives here beside validateI2pName rather than in the AltNet generator set.
const ENS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.eth$/;

/** Trim, lowercase, strip a pasted scheme + trailing slashes. */
export function normalizeAltAddress(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '');
}

export function isValidOnion(s: string): boolean {
	return ONION_RE.test(s);
}
export function isValidLoki(s: string): boolean {
	return LOKI_RE.test(s);
}
export function isValidI2pB32(s: string): boolean {
	return I2P_B32_RE.test(s);
}
export function isValidI2pName(s: string): boolean {
	return I2P_NAME_RE.test(s) && !s.endsWith('.b32.i2p');
}
export function isValidEnsName(s: string): boolean {
	return ENS_RE.test(s);
}

export type ValidateResult =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly reason: string };

/** Validate (and normalize) a pasted address for the chosen network. */
export function validateAltAddress(net: AltNet, raw: string): ValidateResult {
	const v = normalizeAltAddress(raw);
	if (v.length === 0) return { ok: false, reason: 'empty' };
	if (net === 'tor') {
		return isValidOnion(v)
			? { ok: true, value: v }
			: { ok: false, reason: 'that is not a v3 .onion address (expected 56 letters/digits then ".onion")' };
	}
	if (net === 'lokinet') {
		return isValidLoki(v)
			? { ok: true, value: v }
			: { ok: false, reason: 'that is not a .loki address (it should end in ".loki")' };
	}
	return isValidI2pB32(v)
		? { ok: true, value: v }
		: { ok: false, reason: 'that is not a .b32.i2p address (expected 52+ letters/digits then ".b32.i2p")' };
}

/** Validate (and normalize) a pasted I2P vanity NAME (DOMAIN.i2p), the
 *  human-readable address that resolves via an i2p address book.  Rejects
 *  the .b32.i2p hash form (that belongs in the b32 slot). */
export function validateI2pName(raw: string): ValidateResult {
	const v = normalizeAltAddress(raw);
	if (v.length === 0) return { ok: false, reason: 'empty' };
	if (v.endsWith('.b32.i2p'))
		return { ok: false, reason: 'that is a .b32.i2p hash address — set it under the I2P b32 option, not the vanity name' };
	return isValidI2pName(v)
		? { ok: true, value: v }
		: { ok: false, reason: 'that is not an I2P vanity name (expected something like "morphit.i2p")' };
}

/** Validate (and normalize) a pasted ENS .eth name.  Nothing to "generate":
 *  the operator registers an ENS name on Ethereum and pastes it here.  Like
 *  the I2P vanity name, it's a human-readable pointer (typically an ENS
 *  contenthash → IPFS site), advertised as a footer pill — Morphit does not
 *  resolve it. */
export function validateEnsName(raw: string): ValidateResult {
	const v = normalizeAltAddress(raw);
	if (v.length === 0) return { ok: false, reason: 'empty' };
	return isValidEnsName(v)
		? { ok: true, value: v }
		: { ok: false, reason: 'that is not an ENS .eth name (expected something like "morphit.eth")' };
}

/** morphit.config.env key for the optional ENS .eth name. Standalone (not in
 *  the AltNet ENV_KEY map) because ENS is a registered name, not a generated
 *  hidden-service address. */
export const ENS_ENV_KEY = 'MORPHIT_INSTANCE_ENS_NAME';

/** Which morphit.config.env key each network's address is written to. I2P
 *  uses the modern split var (_I2P_B32_ADDRESS), which the indexer maps to
 *  the footer's `i2p_b32`. */
export const ENV_KEY: Record<AltNet, string> = {
	tor: 'MORPHIT_INSTANCE_TOR_ADDRESS',
	lokinet: 'MORPHIT_INSTANCE_LOKINET_ADDRESS',
	i2p: 'MORPHIT_INSTANCE_I2P_B32_ADDRESS'
};

/** The generator/helper script for each network (relative to repo root).
 *  Lokinet has no vanity grinder, so its script only prints setup steps. */
export const GEN_SCRIPT: Record<AltNet, string> = {
	tor: 'scripts/generate-onion.sh',
	i2p: 'scripts/generate-i2p.sh',
	lokinet: 'scripts/generate-lokinet.sh'
};

/** Whether the operator can choose the address's leading letters. Lokinet
 *  cannot (Lokinet generates the key itself). */
export const SUPPORTS_VANITY_PREFIX: Record<AltNet, boolean> = {
	tor: true,
	i2p: true,
	lokinet: false
};
