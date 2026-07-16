#!/usr/bin/env tsx
/*
 * blurt-noble-signer-recovery-proof — cp173 elliptic-migration feasibility proof.
 *
 * Proves the ONLY property the elliptic→@noble/secp256k1 signing migration
 * actually requires: that a @noble/secp256k1-based Blurt signer produces
 * signatures the chain will ACCEPT.
 *
 * WHY RECOVERY, NOT BYTE-EQUALITY.  An earlier framing of this proof asserted
 * byte-exact equivalence with @beblurt/dblurt's elliptic-based signer.  That
 * is the WRONG invariant.  Graphene-lineage chains (Blurt / Steem / Hive)
 * verify a signature by RECOVERING the public key from it and checking that
 * key against the operation's required authority.  They do NOT require the
 * specific RFC-6979 deterministic signature any particular library happens to
 * emit — any valid CANONICAL ECDSA signature (low-S, low-R) that recovers to
 * an authorized key is accepted.  So the migration's correctness question is
 * "does a noble-produced signature recover to the signer's key?", which this
 * proves by feeding noble signatures to dblurt's OWN parser + recovery and
 * confirming the recovered key matches.
 *
 * Cross-check: each noble signature is ALSO re-verified under noble itself
 * (round-trip), and we assert the canonical constraints hold (low-S, low-R,
 * 65-byte wire [recovery+31]++r(32)++s(32)).
 *
 * SCOPE.  This is a FEASIBILITY PROOF, not a shipped migration.  It does NOT
 * change any Morphit signing path (apps/web/src/lib/blurt/sign.ts still calls
 * dblurt's broadcast.sign).  It does NOT broadcast to the live chain — the
 * sandbox has no chain access, so the FINAL cutover still requires one real
 * Blurt broadcast to confirm end-to-end acceptance.  See
 * docs/adr/0046-elliptic-signing-migration.md for the full plan and the
 * standing REVISIT item.
 *
 * Runtime note: dblurt loads in CI via its pure-JS elliptic fallback (the
 * native secp256k1 addon is not required for signing/recovery), so this smoke
 * runs anywhere tsx + node run.
 */

import * as secp from '@noble/secp256k1';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as dblurt from '@beblurt/dblurt';

// dblurt ships as CJS; under tsx the exports may sit on the namespace or on
// `.default` depending on interop.  Resolve defensively so this runs both ways.
const dblurtNs = (dblurt as Record<string, unknown>).default
	? ((dblurt as Record<string, unknown>).default as Record<string, unknown>)
	: (dblurt as unknown as Record<string, unknown>);
const PrivateKey = dblurtNs.PrivateKey as new (b: Buffer) => {
	createPublic: () => { toString: () => string };
};
const Signature = dblurtNs.Signature as {
	fromBuffer: (b: Buffer) => { recover: (m: Buffer) => { toString: () => string } };
};

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// RFC-6979 HMAC hook required by noble v2's synchronous sign().
secp.etc.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]) =>
	createHmac('sha256', key).update(secp.etc.concatBytes(...msgs)).digest();

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];
const pass = (name: string) => results.push({ name, ok: true });
const fail = (name: string, detail?: string) => results.push({ name, ok: false, detail });

/*
 * The candidate noble Blurt signer.  This is the primitive the migration would
 * wire into sign.ts in place of dblurt's broadcast.sign.  Canonical-signature
 * discipline: re-derive with a bumped RFC-6979 extra-entropy counter until both
 * r and s have a clear high bit (graphene's "low-R + low-S" canonical form),
 * then emit the 65-byte wire format the chain parses.
 */
function blurtSignNoble(digest32: Uint8Array, priv: Uint8Array): Buffer {
	for (let n = 0; n < 1000; n++) {
		const opts: { lowS: boolean; extraEntropy?: Uint8Array } = { lowS: true };
		if (n > 0) {
			const e = Buffer.alloc(32, 0);
			e.writeUInt32LE(n, 0);
			opts.extraEntropy = e;
		}
		const sig = secp.sign(digest32, priv, opts);
		// cp474 — @noble/secp256k1 v2's `Signature.toBytes()` takes NO arguments;
	// the 'compact' we used to pass was silently ignored. It already returns the
	// 64-byte compact (r || s) form (it's the inverse of `fromBytes`, and
	// `toCompactRawBytes()` is its explicit alias), so behaviour is unchanged —
	// but the call now says what it actually does.
	const compact = sig.toBytes();
		const r = compact.slice(0, 32);
		const s = compact.slice(32, 64);
		if ((r[0] & 0x80) !== 0 || (s[0] & 0x80) !== 0) continue; // not canonical (high-R/high-S) — retry
		const wire = Buffer.alloc(65);
		wire[0] = sig.recovery + 31; // graphene recovery byte: 27 + recid + 4 (compressed)
		Buffer.from(r).copy(wire, 1);
		Buffer.from(s).copy(wire, 33);
		return wire;
	}
	throw new Error('no canonical signature in 1000 iterations (astronomically unlikely)');
}

function randPriv(): Uint8Array {
	for (;;) {
		const p = randomBytes(32);
		try {
			secp.getPublicKey(p, true);
			return p;
		} catch {
			/* out of range — retry */
		}
	}
}

/* ---- Proof 1: noble signatures recover to the correct key under DBLURT ---- */
{
	const N = 300;
	let okCount = 0;
	let bad = 0;
	for (let i = 0; i < N; i++) {
		const priv = randPriv();
		const digest = createHash('sha256')
			.update('recover-' + i + '-' + randomBytes(6).toString('hex'))
			.digest();
		const wire = blurtSignNoble(digest, priv);
		// Parse with dblurt's own wire parser, recover with dblurt's own recovery.
		const recovered = Signature.fromBuffer(wire).recover(Buffer.from(digest)).toString();
		const expected = new PrivateKey(Buffer.from(priv)).createPublic().toString();
		if (recovered === expected) okCount++;
		else {
			bad++;
			if (bad <= 3) fail(`recover vector ${i}`, `recovered=${recovered} expected=${expected}`);
		}
	}
	if (bad === 0) pass(`noble→dblurt recovery: ${okCount}/${N} recover to the correct key`);
	else fail('noble→dblurt recovery', `${bad}/${N} did not recover to the signer key`);
}

/* ---- Proof 2: canonical-form constraints hold on noble output ---- */
{
	const N = 100;
	let okCount = 0;
	for (let i = 0; i < N; i++) {
		const priv = randPriv();
		const digest = createHash('sha256').update('canon-' + i).digest();
		const wire = blurtSignNoble(digest, priv);
		const recByte = wire[0];
		const r0 = wire[1];
		const s0 = wire[33];
		const lenOk = wire.length === 65;
		const recOk = recByte >= 31 && recByte <= 34; // 27 + recid(0..3) + 4
		const lowR = (r0 & 0x80) === 0;
		const lowS = (s0 & 0x80) === 0;
		if (lenOk && recOk && lowR && lowS) okCount++;
	}
	if (okCount === N) pass(`canonical form: all ${N} sigs are 65-byte, low-R, low-S, valid recovery byte`);
	else fail('canonical form', `${N - okCount}/${N} violated canonical constraints`);
}

/* ---- Proof 3: noble signatures round-trip-verify under noble ---- */
{
	const N = 50;
	let okCount = 0;
	for (let i = 0; i < N; i++) {
		const priv = randPriv();
		const pub = secp.getPublicKey(priv, true);
		const digest = createHash('sha256').update('verify-' + i).digest();
		const wire = blurtSignNoble(digest, priv);
		const compact = new Uint8Array(64);
		wire.copy(Buffer.from(compact.buffer), 0, 1, 65);
		if (secp.verify(compact, digest, pub, { lowS: true })) okCount++;
	}
	if (okCount === N) pass(`round-trip: all ${N} noble sigs verify under noble`);
	else fail('round-trip verify', `${N - okCount}/${N} failed to verify`);
}

/* ---- report ---- */
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ${GREEN}✓${RESET} ${r.name}`);
	} else {
		console.log(`  ${RED}✗${RESET} ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log(`✗ ${failed} of ${results.length} blurt-noble-signer-recovery-proof scenarios failed`);
	process.exit(1);
} else {
	console.log(`✓ all ${results.length} blurt-noble-signer-recovery-proof scenarios pass`);
}
