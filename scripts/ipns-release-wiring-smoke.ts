#!/usr/bin/env tsx
/**
 * scripts/ipns-release-wiring-smoke.ts  (v1.9.6, Ken)
 *
 * Morphit points a STABLE IPNS name (Ed25519 `k51…`) at every release so
 * `ipns://<name>` always resolves to the latest tarball — over the PUBLIC DHT,
 * with no DNS and no third party. The model is SIGN-ONCE / REBROADCAST-ONLY:
 *   - scripts/ipns-keygen.mjs (Ken's one-time key gen) + scripts/ipns-sign.mjs
 *     (CI, per release) — the key never leaves as anything but MORPHIT_IPNS_KEY;
 *     ipns-sign.mjs signs a record LOCALLY and prints {name,record} as JSON
 *   - release.yml signs after computing the canonical CID (gated on
 *     MORPHIT_IPNS_KEY, non-fatal) and carries BOTH the name AND the signed
 *     record (base64) into the distribution anchor env
 *   - the release schema + the indexer handler BOTH validate optional `ipns_name`
 *     AND `ipns_record` with the SAME regex/bounds + reason (parity); the payload
 *     builder reads MORPHIT_BUILD_IPNS_NAME + MORPHIT_BUILD_IPNS_RECORD and emits both
 *   - the download page shows TWO decentralized "latest" cards: native ipns://
 *     (DHT, no DNS) + an ipfs.io gateway CID (any browser), plus the copyable address
 *
 * (w3name is GONE — it stored records off the DHT, so public gateways never resolved
 * them; ipns-sign.mjs uses w3name ONLY to parse the existing key, then the low-level
 * `ipns` lib to sign a DHT-valid record. The rebroadcast side is covered by
 * ipns-dht-rebroadcast-smoke.ts.)
 *
 * Source greps strip comments first.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
let pass = 0,
	fail = 0;
const ok = (m: string) => (pass++, console.log(`  \u2713 ${m}`));
const bad = (m: string, d = '') => (fail++, console.log(`  \u2717 ${m}${d ? `\n      ${d}` : ''}`));
const strip = (s: string) =>
	s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const readS = (p: string) => strip(read(p));
// Shell-comment stripper: drop full-line `#` comments so anti-pattern greps on
// shell scripts don't match a comment that (necessarily) names the thing it replaced.
const stripHash = (s: string) =>
	s
		.split('\n')
		.filter((l) => !/^\s*#/.test(l))
		.join('\n');

// ── 1. the two scripts (keygen + sign) ───────────────────────────────
{
	const keygen = read('scripts/ipns-keygen.mjs');
	/Name\.create\(\)/.test(keygen) && /key\.raw/.test(keygen) && /MORPHIT_IPNS_KEY/.test(keygen)
		? ok('ipns-keygen.mjs: creates a key, prints base64, names the secret')
		: bad('ipns-keygen.mjs shape');

	const sign = read('scripts/ipns-sign.mjs');
	const checks: Array<[string, boolean]> = [
		['imports w3name (to PARSE the existing key only)', /from 'w3name'/.test(sign)],
		['imports the low-level ipns lib (DHT-valid record)', /from 'ipns'/.test(sign)],
		['imports the ipns validator', /from 'ipns\/validator'/.test(sign)],
		['creates an IPNS record (createIPNSRecord)', /createIPNSRecord\(/.test(sign)],
		['marshals the record to bytes (marshalIPNSRecord)', /marshalIPNSRecord\(/.test(sign)],
		['self-validates before emitting (validate + round-trip)', /validate\(/.test(sign) && /unmarshalIPNSRecord\(/.test(sign)],
		['reads RELEASE_CID', /RELEASE_CID/.test(sign)],
		['reads the key + skips (exit 2) without it', /MORPHIT_IPNS_KEY/.test(sign) && /process\.exit\(2\)/.test(sign)],
		['reads MORPHIT_IPNS_SEQUENCE (monotonic, no chain read)', /MORPHIT_IPNS_SEQUENCE/.test(sign)],
		['emits {name,record} as JSON on stdout', /process\.stdout\.write\(/.test(sign) && /JSON\.stringify\(\{ name/.test(sign) && /record: recordB64/.test(sign)],
		['logs go to stderr, not stdout', /console\.error/.test(sign)],
		// the whole point: NOT w3name Name.publish (which is off-DHT)
		['does NOT call w3name Name.publish (off-DHT — the bug we fixed)', !/Name\.publish\(/.test(sign)]
	];
	for (const [n, okp] of checks) okp ? ok(`ipns-sign.mjs: ${n}`) : bad(`ipns-sign.mjs: ${n}`);
}

// ── 2. release.yml wiring (sign step + anchor carries name AND record) ─
{
	const yml = read('.forgejo/workflows/release.yml'); // YAML: keep comments (grep real keys)
	/Sign stable IPNS record/.test(yml)
		? ok('release.yml has the IPNS SIGN step (DHT-native)')
		: bad('release.yml IPNS sign step');
	/secrets\.MORPHIT_IPNS_KEY/.test(yml)
		? ok('IPNS step gated on the MORPHIT_IPNS_KEY secret')
		: bad('IPNS step secret gate');
	/ipns-sign\.mjs/.test(yml) && /ipns-name\.txt/.test(yml) && /ipns-record\.txt/.test(yml)
		? ok('runs ipns-sign.mjs → ipns-name.txt + ipns-record.txt')
		: bad('IPNS step runs the signer → both outputs');
	/MORPHIT_IPNS_SEQUENCE=/.test(yml)
		? ok('passes a monotonic MORPHIT_IPNS_SEQUENCE (build timestamp)')
		: bad('IPNS step passes a sequence');
	/MORPHIT_BUILD_IPNS_NAME=\$\(cat ipns-name\.txt\)/.test(yml)
		? ok('anchor carries MORPHIT_BUILD_IPNS_NAME')
		: bad('anchor carries the IPNS name');
	/MORPHIT_BUILD_IPNS_RECORD=\$\(cat ipns-record\.txt\)/.test(yml)
		? ok('anchor carries MORPHIT_BUILD_IPNS_RECORD (the signed record)')
		: bad('anchor carries the IPNS record');
}

// ── 2b. Canonical IPFS CID compute (self-hosted seed; NO pinning service) ──
{
	const yml = read('.forgejo/workflows/release.yml');
	const stage = stripHash(read('ops/ipfs/stage-release-dir.sh'));
	const checks: Array<[string, boolean]> = [
		['NO commercial pinner referenced', !/pinata|pinFileToIPFS|PINATA_JWT|lighthouse|storacha/i.test(yml)],
		['installs pinned Kubo (version + SHA-512 + verify)', /KUBO_VERSION/.test(yml) && /KUBO_SHA512/.test(yml) && /sha512sum/.test(yml)],
		['stages via the shared stage-release-dir.sh', /ops\/ipfs\/stage-release-dir\.sh/.test(yml)],
		['computes the dir CID with ipfs add --only-hash (cidv1)', /add -rQ --cid-version 1 --only-hash/.test(yml)],
		['records the CID to ipfs-cid.txt', /ipfs-cid\.txt/.test(yml)],
		['stager: stable morphit-latest.tar.gz', /morphit-latest\.tar\.gz/.test(stage)],
		['stager: notes come from the tarball via tar -O, not an external fetch', !/curl[^\n]*RELEASE-NOTES/i.test(stage) && !/curl[^\n]*\.asc/i.test(stage) && /tar -xzf[^\n]*-O/.test(stage)],
		['stager: discoverable dir — README.md + keyword-tagged metadata.json', /README\.md/.test(stage) && /"keywords":/.test(stage)],
		['stager: metadata.json has version + sha256', /"version":/.test(stage) && /"sha256":/.test(stage)],
		['stager: metadata.json DETERMINISTIC (no released_utc timestamp)', !/released_utc/.test(stage)]
	];
	for (const [n, okp] of checks) okp ? ok(`ipfs-cid: ${n}`) : bad(`ipfs-cid: ${n}`);
}

// ── 3. schema + indexer parity: ipns_name AND ipns_record ─────────────
{
	const rel = readS('packages/release-schema/src/release.ts');
	const val = readS('packages/release-schema/src/releaseValidate.ts');
	const idx = readS('apps/indexer/src/indexer/handlers/release.ts');

	// ipns_name
	/ipns_name\?: string/.test(rel) ? ok('schema: ReleaseDistributionBlock.ipns_name') : bad('schema ipns_name field');
	const RE = String.raw`k51\[a-z0-9\]\{50,70\}`;
	const nameValHas = new RegExp(RE).test(val) && /distribution_ipns_name_invalid/.test(val);
	const nameIdxHas = new RegExp(RE).test(idx) && /distribution_ipns_name_invalid/.test(idx);
	nameValHas && nameIdxHas
		? ok('ipns_name: validator ↔ indexer use the SAME regex + reason')
		: bad('ipns_name validator/indexer parity');
	/ipns_name !== undefined \? \{ ipns_name \}/.test(val) && /ipns_name !== undefined \? \{ ipns_name \}/.test(idx)
		? ok('ipns_name: both attach only when present')
		: bad('ipns_name conditional attach');

	// ipns_record (v1.9.6)
	/ipns_record\?: string/.test(rel) ? ok('schema: ReleaseDistributionBlock.ipns_record') : bad('schema ipns_record field');
	const recValHas = /distribution_ipns_record_invalid/.test(val);
	const recIdxHas = /distribution_ipns_record_invalid/.test(idx);
	recValHas ? ok('releaseValidate: ipns_record reason present') : bad('validator ipns_record reason');
	recIdxHas ? ok('indexer handler: ipns_record reason present (parity)') : bad('indexer ipns_record reason');
	recValHas && recIdxHas
		? ok('ipns_record: validator ↔ indexer BOTH validate it (parity)')
		: bad('ipns_record validator/indexer parity');
	/ipns_record !== undefined \? \{ ipns_record \}/.test(val) && /ipns_record !== undefined \? \{ ipns_record \}/.test(idx)
		? ok('ipns_record: both attach only when present')
		: bad('ipns_record conditional attach');
}

// ── 4. payload builder: emits ipns_name AND ipns_record ───────────────
{
	const b = readS('apps/indexer/scripts/release-build-payload.ts');
	/MORPHIT_BUILD_IPNS_NAME/.test(b) ? ok('payload builder reads MORPHIT_BUILD_IPNS_NAME') : bad('builder reads name env');
	/value\.ipns_name = ipns/.test(b) ? ok('payload builder emits ipns_name') : bad('builder emits ipns_name');
	/MORPHIT_BUILD_IPNS_RECORD/.test(b) ? ok('payload builder reads MORPHIT_BUILD_IPNS_RECORD') : bad('builder reads record env');
	/value\.ipns_record = ipnsRec/.test(b) ? ok('payload builder emits ipns_record') : bad('builder emits ipns_record');
}

// ── 5. download page: TWO decentralized cards (native ipns:// + gateway CID) ──
{
	const ipns = readS('apps/web/src/lib/ipns.ts');
	const dl = readS('apps/web/src/routes/[lang]/download/+page.svelte');
	const checks: Array<[string, boolean]> = [
		['ipns.ts: NATIVE ipns://<name>/ tarball URL (DHT, no DNS)', /ipns:\/\/\$\{MORPHIT_IPNS_NAME\}/.test(ipns) && /ipnsNativeTarballUrl/.test(ipns)],
		['ipns.ts: gateway CID helper links ipfs.io/ipfs/${cid}', /ipfs\.io\/ipfs\/\$\{cid\}/.test(ipns)],
		['ipns.ts: ships the canonical on-chain IPNS name', /MORPHIT_IPNS_NAME =/.test(ipns)],
		['ipns.ts: w3name gateway path retired (no /ipns/<k51> gateway URL)', !/dweb\.link\/ipns/.test(ipns) && !/ipfs\.io\/ipns/.test(ipns)],
		['download page: NATIVE IPNS card (ipnsNativeTarballUrl)', /ipnsNativeTarballUrl\(\)/.test(dl) && /id: 'ipns'/.test(dl)],
		['download page: IPFS gateway card via the CID helper', /ipfsCidTarballUrl\(/.test(dl)],
		['download page: reads the release CID (distribution.ipfs_cid)', /distribution\?\.ipfs_cid/.test(dl)],
		['download page: IPNS note + copyable ipns:// address', /download\.ipns_note/.test(dl) && /ipnsNativeDirUrl\(\)/.test(dl)]
	];
	for (const [n, okp] of checks) okp ? ok(`download: ${n}`) : bad(`download: ${n}`);
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 ipns-release-wiring smoke FAILED (${fail})`);
	process.exit(1);
}
console.log('\u2713 IPNS "always latest" is wired DHT-native: keygen + sign scripts, release.yml, schema↔indexer parity (name + record), payload builder, two download cards');
console.log(`\u2713 all ${pass} ipns-release-wiring scenarios passed`);
