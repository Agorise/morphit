#!/usr/bin/env node
/**
 * scripts/ipns-sign.mjs  (v1.9.6, Ken)
 *
 * Signs Morphit's stable IPNS name → THIS release's CID, LOCALLY, and prints the
 * resulting SIGNED RECORD (base64) so CI can anchor it on-chain as
 * `distribution.ipns_record`. Every instance then rebroadcasts that record to the
 * public DHT — WITHOUT the key — keeping `ipns://<name>` resolvable on any gateway
 * for as long as a single instance is alive (see ops/ipfs/morphit-ipns-rebroadcast.sh).
 *
 * WHY THIS REPLACES ipns-publish.mjs (w3name): w3name stores IPNS records in its own
 * HTTP service, OFF the public IPFS DHT — so public gateways (which resolve IPNS via
 * the DHT) can never find them ("could not resolve name"). We put the record on the
 * DHT via the federation instead. w3name is used here ONLY to parse the EXISTING key
 * (unchanged); the record itself is created + signed with the low-level `ipns`
 * library (full control of lifetime + the marshaled bytes) and the private key never
 * leaves this process. The signed record is PUBLIC and safe to anchor + broadcast.
 *
 * Security: only the holder of the private key can MINT or bump a record (the
 * sequence number is signed), so an instance rebroadcasting this record physically
 * cannot repoint the name. This script self-validates the record it produces (same
 * check the DHT + gateways run) and refuses to emit anything that doesn't verify.
 *
 * Inputs (env):
 *   RELEASE_CID              — the release directory's IPFS CID (from the pin step).
 *   MORPHIT_IPNS_KEY         — base64 of the IPNS private key (Forgejo secret).
 *   MORPHIT_IPNS_SEQUENCE    — sequence number for THIS record. CI passes
 *                              (previous on-chain record's sequence + 1); the very
 *                              first release passes 0. Newest sequence wins on resolve.
 *   MORPHIT_IPNS_LIFETIME_MS — optional record validity in ms (default 365 days).
 *
 * Output (stdout, one JSON line): { "name", "sequence", "value", "record" }
 *   where `record` is the base64 marshaled IPNS record → distribution.ipns_record.
 * All logging goes to stderr.
 *
 * Failure is NON-FATAL to a release (caller ignores a non-zero exit): IPNS is
 * additive to the immutable ipfs_cid + the on-chain SHA-256 + the git mirrors.
 *
 * Deps (installed --no-save in CI): ipns w3name @libp2p/peer-id
 */
import * as Name from 'w3name';
import {
	createIPNSRecord,
	marshalIPNSRecord,
	unmarshalIPNSRecord,
	multihashToIPNSRoutingKey
} from 'ipns';
import { validate } from 'ipns/validator';
import { peerIdFromString } from '@libp2p/peer-id';

const log = (...a) => console.error(...a);
const skip = (msg) => { log(msg); process.exit(2); }; // 2 = intentionally skipped
const die = (msg) => { log(msg); process.exit(1); }; // 1 = tried and failed

const cid = (process.env.RELEASE_CID || '').trim();
const keyB64 = (process.env.MORPHIT_IPNS_KEY || '').trim();
const seqRaw = (process.env.MORPHIT_IPNS_SEQUENCE || '').trim();
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const lifetimeMs = Number(process.env.MORPHIT_IPNS_LIFETIME_MS || '') || ONE_YEAR_MS;

if (!keyB64) skip('No MORPHIT_IPNS_KEY — skipping IPNS sign (release proceeds without ipns_record).');
if (!cid) skip('No RELEASE_CID — nothing to point the name at; skipping IPNS sign.');
// Loose CID sanity — the release-schema validates it strictly on-chain; here we only
// refuse to sign a record for something that clearly isn't a CID.
if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|b[a-z2-7]{50,})$/.test(cid)) {
	skip(`RELEASE_CID '${cid}' does not look like a CIDv0/CIDv1 — skipping IPNS sign.`);
}
if (seqRaw !== '' && !/^\d+$/.test(seqRaw)) skip(`MORPHIT_IPNS_SEQUENCE '${seqRaw}' must be a non-negative integer.`);
const sequence = seqRaw === '' ? 0n : BigInt(seqRaw);

let name;
try {
	name = await Name.from(Buffer.from(keyB64, 'base64'));
} catch (e) {
	skip('MORPHIT_IPNS_KEY is not a valid base64 IPNS key — skipping. ' + (e?.message ?? e));
}
const nameStr = name.toString();

const value = `/ipfs/${cid}`;
let bytes;
try {
	const record = await createIPNSRecord(name.key, value, sequence, lifetimeMs);
	bytes = marshalIPNSRecord(record);
} catch (e) {
	die('IPNS record signing failed (non-fatal): ' + (e?.message ?? e));
}

// Self-validate EXACTLY as a rebroadcasting instance + a resolving gateway will:
// signature valid, not expired, within the size cap, value + sequence intact.
// Refuse to emit anything that would be rejected downstream.
try {
	const pid = peerIdFromString(nameStr);
	await validate(pid.publicKey, bytes);
	// sanity: routing key derivable (this is the /ipns/<key> the DHT stores it under)
	multihashToIPNSRoutingKey(pid.toMultihash());
	const rt = unmarshalIPNSRecord(bytes);
	const rtValue = typeof rt.value === 'string' ? rt.value : new TextDecoder().decode(rt.value);
	if (rtValue !== value) throw new Error(`value mismatch after round-trip: ${rtValue} !== ${value}`);
	if (rt.sequence !== sequence) throw new Error(`sequence mismatch after round-trip: ${rt.sequence} !== ${sequence}`);
} catch (e) {
	die('Signed IPNS record failed self-validation (NOT emitting): ' + (e?.message ?? e));
}

const recordB64 = Buffer.from(bytes).toString('base64');
log(
	`Signed IPNS ${nameStr} -> ${value} ` +
		`(seq ${sequence}, lifetime ${Math.round(lifetimeMs / 86400000)}d, ${bytes.length}B / ${recordB64.length} b64 chars).`
);
log('Record signed LOCALLY; it is PUBLIC — anchored on-chain + rebroadcast to the DHT by every instance. Key never left this process.');
// stdout: single JSON line for CI to fold into the on-chain anchor.
process.stdout.write(
	JSON.stringify({ name: nameStr, sequence: Number(sequence), value, record: recordB64 }) + '\n'
);
