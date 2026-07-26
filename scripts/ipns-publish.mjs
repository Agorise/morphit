#!/usr/bin/env node
/**
 * scripts/ipns-publish.mjs  (v1.9.x, Ken)
 *
 * Runs in the release workflow AFTER the tarball is pinned to IPFS. It repoints
 * Morphit's stable IPNS name (from the MORPHIT_IPNS_KEY secret) at THIS release's
 * CID, so `ipns://<name>` / `https://dweb.link/ipns/<name>` always resolves to
 * the newest release — the "always find our latest" pointer, permanently.
 *
 * Inputs (env):
 *   RELEASE_CID       — the release tarball's IPFS CID (from the pin step).
 *   MORPHIT_IPNS_KEY  — base64 of the IPNS private signing key (Forgejo secret).
 *
 * Output: prints ONLY the `k51…` name on stdout (CI captures it → ipns-name.txt
 * → the on-chain anchor's optional `ipns_name`). All logging goes to stderr.
 *
 * Failure is NON-FATAL to a release (caller ignores a non-zero exit): IPNS is
 * additive to the git mirrors + the immutable ipfs_cid + the on-chain SHA-256.
 * Records are signed LOCALLY (w3name never sees the key) and live ~1 year, so
 * republishing every release keeps the name alive far ahead of the cadence.
 */
import * as Name from 'w3name';

const log = (...a) => console.error(...a);

const cid = (process.env.RELEASE_CID || '').trim();
const keyB64 = (process.env.MORPHIT_IPNS_KEY || '').trim();

if (!keyB64) {
	log('No MORPHIT_IPNS_KEY — skipping IPNS publish (release proceeds without ipns_name).');
	process.exit(2);
}
if (!cid) {
	log('No RELEASE_CID — nothing to point the name at; skipping IPNS publish.');
	process.exit(2);
}

let name;
try {
	name = await Name.from(Buffer.from(keyB64, 'base64'));
} catch (e) {
	log('MORPHIT_IPNS_KEY is not a valid base64 IPNS key — skipping. ' + (e?.message ?? e));
	process.exit(2);
}

const value = `/ipfs/${cid}`;

let revision;
try {
	// Existing name: fetch the current record so we can bump the sequence number.
	const current = await Name.resolve(name);
	if (current.value === value) {
		log(`IPNS name already points at ${value} — republishing to refresh validity.`);
	}
	revision = await Name.increment(current, value);
} catch (e) {
	// First-ever publish for this key (nothing to resolve yet).
	log('No existing IPNS record (first publish) — creating v0. ' + (e?.message ?? e));
	revision = await Name.v0(name, value);
}

try {
	await Name.publish(revision, name.key);
} catch (e) {
	log('IPNS publish failed (non-fatal): ' + (e?.message ?? e));
	process.exit(1);
}

log(`Published IPNS ${name.toString()} → ${value} (seq ${revision.sequence ?? '?'}).`);
log(`Resolve: https://dweb.link/ipns/${name.toString()}`);
// stdout: the name ONLY (captured by CI)
process.stdout.write(name.toString());
