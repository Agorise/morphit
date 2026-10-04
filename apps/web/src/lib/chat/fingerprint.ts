/**
 * Morphit chat — the "Verify peer" safety number.
 *
 * Opt-in, hidden-by-default protection against a hostile indexer that
 * substitutes chat keys.
 *
 * ─── Threat model ──────────────────────────────────────────
 *
 * Chat is trust-on-first-use: the indexer hands each side the counterparty's
 * published X25519 chat key. A hostile indexer could hand Alice its own key
 * M_B "for Bob" and Bob its own key M_A "for Alice", sit in the middle and
 * read everything. Two people who compare the safety number over a channel
 * they already trust (a voice call, in person, another messenger they have
 * verified) detect that: each sees a different number.
 *
 * Comparing numbers does NOT prove who is on the other end of that channel —
 * the user has to recognise their counterparty's voice, face, handle.
 *
 * ─── Construction (the shape of Signal's safety numbers) ───
 *
 * Each party gets 30 digits computed from THAT party's account name and chat
 * key alone:
 *
 *     h = SHA-512("morphit-safety-number-v2" ‖ 0x00 ‖ key ‖ account)
 *     repeat 5200 times: h = SHA-512(h ‖ key)
 *     digits = the first 30 bytes of h, as six 5-byte big-endian
 *              integers, each mod 100000, zero-padded to 5 digits
 *
 * The number shown is both parties' 30 digits, the numerically smaller half
 * first, so both sides show the same 60 digits (12 groups of 5).
 *
 * Why per party, not a hash of the pair: the previous 8-word fingerprint was
 * 64 bits over the PAIR, so the attacker above only needed ANY collision
 * F(A, M_B) = F(M_A, B) between two values it controls — a ~2^32 birthday
 * search. With independent halves, Alice's number matches Bob's only if
 * digits(M_B) = digits(B) AND digits(M_A) = digits(A): a second preimage of
 * each half, ~2^99.7 candidates each, every candidate costing 5,201 SHA-512
 * runs. The whole number carries ~199 bits.
 *
 * The account name is bound in, so the same key presented under another
 * account gives another number. The keys are raw 32-byte X25519 public keys
 * (never their on-chain encoding); anything else is refused, so a missing or
 * truncated key is never turned into a number.
 *
 * SHA-512 comes from libsodium (already loaded by chat), not WebCrypto, so the
 * check also works on plain-HTTP I2P addresses, where browsers withhold
 * WebCrypto.
 */

import { ensureSodium, sodiumSumo } from '$crypto/sodium';

/** Version of the construction above. A change bumps the domain tag. */
export const SAFETY_NUMBER_VERSION = 2;
const DOMAIN_TAG = 'morphit-safety-number-v2';
const ITERATIONS = 5200;
const PUB_BYTES = 32;
/** Digits per party, shown in groups of 5. */
const PARTY_DIGITS = 30;
const GROUP = 5;

export interface SafetyNumberParty {
	/** The Blurt account name the key belongs to. */
	readonly account: string;
	/** The party's raw 32-byte X25519 chat public key. */
	readonly pub: Uint8Array;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** The 30 digits of one party. */
async function partyDigits(party: SafetyNumberParty): Promise<string> {
	if (!(party.pub instanceof Uint8Array) || party.pub.length !== PUB_BYTES) {
		throw new Error(
			`safety number: a chat key must be a ${PUB_BYTES}-byte Uint8Array, got ${party.pub?.length}`
		);
	}
	if (typeof party.account !== 'string' || party.account.length === 0) {
		throw new Error('safety number: account name must not be empty');
	}
	await ensureSodium();
	const enc = new TextEncoder();
	const { crypto_hash_sha512 } = sodiumSumo();
	let h = crypto_hash_sha512(
		concat(enc.encode(DOMAIN_TAG), new Uint8Array([0]), party.pub, enc.encode(party.account))
	);
	for (let i = 0; i < ITERATIONS; i++) h = crypto_hash_sha512(concat(h, party.pub));
	let digits = '';
	for (let c = 0; c < PARTY_DIGITS / GROUP; c++) {
		let v = 0;
		for (let b = 0; b < 5; b++) v = v * 256 + h[c * 5 + b]!;
		digits += String(v % 100_000).padStart(GROUP, '0');
	}
	return digits;
}

/**
 * The safety number for a conversation: 12 groups of 5 digits, identical on
 * both sides whichever party computes it. Throws on a key that is not 32
 * bytes or an empty account name (the caller shows "not ready").
 */
export async function computeSafetyNumber(
	a: SafetyNumberParty,
	b: SafetyNumberParty
): Promise<readonly string[]> {
	const [da, db] = await Promise.all([partyDigits(a), partyDigits(b)]);
	const all = da <= db ? da + db : db + da;
	const groups: string[] = [];
	for (let i = 0; i < all.length; i += GROUP) groups.push(all.slice(i, i + GROUP));
	return groups;
}
