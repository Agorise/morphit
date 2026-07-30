#!/usr/bin/env node
/**
 * scripts/ipns-keygen.mjs  (v1.9.x, Ken)
 *
 * ONE-TIME generation of Morphit's stable IPNS publishing key. Run this ONCE,
 * locally, on the release laptop. It prints:
 *
 *   - the IPNS NAME (a `k51…` string): PUBLIC. This is the permanent, stable
 *     name that always resolves to the LATEST release once the CI publish step
 *     runs each release. Safe to share, bake on-chain, and put on the site.
 *   - the IPNS PRIVATE KEY (base64): SECRET. Whoever holds this can repoint the
 *     name. Store it as the `MORPHIT_IPNS_KEY` secret in Forgejo → Actions →
 *     Secrets. NEVER commit it, paste it in chat, or put it in the repo.
 *
 * The private key never leaves your laptop except as that one CI secret — same
 * trust model as the @morphit WIF and the GPG signer. w3name signs records
 * locally, so the w3name service (and Anthropic, and this repo) never see it.
 *
 * Usage (from repo root):
 *   npm i --no-save w3name && node scripts/ipns-keygen.mjs
 *
 * Then: paste the printed MORPHIT_IPNS_KEY into the Forgejo secret, and give the
 * `k51…` NAME to whoever is wiring the download page + on-chain field.
 */
import * as Name from 'w3name';

const name = await Name.create();
const nameStr = name.toString();
const keyB64 = Buffer.from(name.key.raw).toString('base64');

// Sanity: the base64 round-trips back to the same name (what CI will do).
const reimported = await Name.from(Buffer.from(keyB64, 'base64'));
if (reimported.toString() !== nameStr) {
	console.error('FATAL: key round-trip mismatch — do not use this key.');
	process.exit(1);
}

const line = '─'.repeat(72);
console.log(line);
console.log('Morphit IPNS key — GENERATED ONCE. Keep this key forever.');
console.log(line);
console.log('');
console.log('IPNS NAME (PUBLIC — share / bake on-chain / put on the site):');
console.log('');
console.log('  ' + nameStr);
console.log('');
console.log('Resolves at, once CI has published a release:');
console.log('  https://dweb.link/ipns/' + nameStr);
console.log('  ipns://' + nameStr);
console.log('');
console.log(line);
console.log('IPNS PRIVATE KEY (SECRET — store as the MORPHIT_IPNS_KEY Forgejo');
console.log('Actions secret; never commit, never paste in chat):');
console.log('');
console.log('  ' + keyB64);
console.log('');
console.log(line);
console.log('Next steps:');
console.log('  1. Forgejo → repo → Settings → Actions → Secrets → add');
console.log('     MORPHIT_IPNS_KEY = the base64 key above.');
console.log('  2. Hand the k51… NAME (not the key) to the download-page/on-chain');
console.log('     wiring. The very next tagged release auto-publishes the name to');
console.log('     the latest tarball CID — no per-release action after that.');
console.log(line);
