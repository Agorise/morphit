#!/usr/bin/env tsx
/**
 * scripts/ipns-release-wiring-smoke.ts  (v1.9.x, Ken)
 *
 * Morphit publishes every release to a STABLE IPNS name (w3name) so
 * `ipns://<name>` always resolves to the latest tarball. This pins the whole
 * chain so no layer can silently drop it:
 *   - scripts/ipns-keygen.mjs (Ken's one-time key gen) + scripts/ipns-publish.mjs
 *     (CI republish) exist and sign LOCALLY (key never leaves as anything but the
 *     MORPHIT_IPNS_KEY secret); the publish script prints ONLY the name on stdout
 *   - release.yml republishes after computing the canonical CID (gated on
 *     MORPHIT_IPNS_KEY, non-fatal) and carries the name into the distribution anchor env
 *   - the release schema + the indexer handler BOTH validate an optional
 *     `ipns_name` with the SAME regex + reason (parity), and the payload builder
 *     reads MORPHIT_BUILD_IPNS_NAME and emits `ipns_name`
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
// shell scripts don't match a comment that (necessarily) names the thing it
// replaced — e.g. stage-release-dir.sh's own note about the old `released_utc`.
const stripHash = (s: string) =>
	s
		.split('\n')
		.filter((l) => !/^\s*#/.test(l))
		.join('\n');

// ── 1. the two scripts ───────────────────────────────────────────────
{
	const keygen = read('scripts/ipns-keygen.mjs');
	/Name\.create\(\)/.test(keygen) && /key\.raw/.test(keygen) && /MORPHIT_IPNS_KEY/.test(keygen)
		? ok('ipns-keygen.mjs: creates a key, prints base64, names the secret')
		: bad('ipns-keygen.mjs shape');

	const pub = read('scripts/ipns-publish.mjs');
	const checks: Array<[string, boolean]> = [
		['imports w3name', /from 'w3name'/.test(pub)],
		['imports the key (Name.from)', /Name\.from\(/.test(pub)],
		['first publish uses v0', /Name\.v0\(/.test(pub)],
		['updates increment the sequence', /Name\.increment\(/.test(pub)],
		['publishes the signed record', /Name\.publish\(/.test(pub)],
		['skips (exit 2) without the key', /MORPHIT_IPNS_KEY/.test(pub) && /exit\(2\)/.test(pub)],
		['reads RELEASE_CID', /RELEASE_CID/.test(pub)],
		// prints ONLY the name on stdout; all logs to stderr
		['name goes to stdout', /process\.stdout\.write\(name\.toString\(\)\)/.test(pub)],
		['logs go to stderr', /console\.error/.test(pub)]
	];
	for (const [n, okp] of checks) okp ? ok(`ipns-publish.mjs: ${n}`) : bad(`ipns-publish.mjs: ${n}`);
}

// ── 2. release.yml wiring ────────────────────────────────────────────
{
	const yml = read('.forgejo/workflows/release.yml'); // YAML: keep comments (grep real keys)
	/Publish stable IPNS name/.test(yml)
		? ok('release.yml has the IPNS publish step')
		: bad('release.yml IPNS step');
	/secrets\.MORPHIT_IPNS_KEY/.test(yml)
		? ok('IPNS step gated on the MORPHIT_IPNS_KEY secret')
		: bad('IPNS step secret gate');
	/node .*ipns-publish\.mjs/.test(yml) && /ipns-name\.txt/.test(yml)
		? ok('runs ipns-publish.mjs → ipns-name.txt')
		: bad('IPNS step runs the publisher');
	/MORPHIT_BUILD_IPNS_NAME=\$\(cat ipns-name\.txt\)/.test(yml)
		? ok('anchor carries MORPHIT_BUILD_IPNS_NAME')
		: bad('anchor carries the IPNS name');
}

// ── 2b. Canonical IPFS CID compute (self-hosted seed; NO pinning service) ──
// v1.9.3: CI computes a DETERMINISTIC directory CID with the pinned Kubo over the
// SHARED staging script — it does not upload to any pinner. The seed box hosts the
// same CID; instances pin it. (stager greps strip shell comments first.)
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
		['stager: RELEASE-NOTES.md + versioned copy', /RELEASE-NOTES\.md/.test(stage) && /RELEASE-NOTES-\$TAG\.md/.test(stage)],
		['stager: metadata.json has version + sha256', /"version":/.test(stage) && /"sha256":/.test(stage)],
		['stager: metadata.json DETERMINISTIC (no released_utc timestamp)', !/released_utc/.test(stage)]
	];
	for (const [n, okp] of checks) okp ? ok(`ipfs-cid: ${n}`) : bad(`ipfs-cid: ${n}`);
}

// ── 3. schema + indexer parity ───────────────────────────────────────
{
	const rel = readS('packages/release-schema/src/release.ts');
	/ipns_name\?: string/.test(rel) ? ok('schema: ReleaseDistributionBlock.ipns_name') : bad('schema ipns_name field');

	const val = readS('packages/release-schema/src/releaseValidate.ts');
	const idx = readS('apps/indexer/src/indexer/handlers/release.ts');
	const RE = String.raw`k51\[a-z0-9\]\{50,70\}`;
	const valHas = new RegExp(RE).test(val) && /distribution_ipns_name_invalid/.test(val);
	const idxHas = new RegExp(RE).test(idx) && /distribution_ipns_name_invalid/.test(idx);
	valHas ? ok('schema validator: ipns_name regex + reason') : bad('schema validator ipns_name');
	idxHas ? ok('indexer handler: ipns_name regex + reason (parity)') : bad('indexer ipns_name');
	valHas && idxHas
		? ok('validator ↔ indexer use the SAME ipns_name regex + reason')
		: bad('ipns_name validator/indexer parity');
	// both attach it to the built block
	/ipns_name !== undefined \? \{ ipns_name \}/.test(val) && /ipns_name !== undefined \? \{ ipns_name \}/.test(idx)
		? ok('both attach ipns_name only when present')
		: bad('ipns_name conditional attach');
}

// ── 4. payload builder ───────────────────────────────────────────────
{
	const b = readS('apps/indexer/scripts/release-build-payload.ts');
	/MORPHIT_BUILD_IPNS_NAME/.test(b)
		? ok('payload builder reads MORPHIT_BUILD_IPNS_NAME')
		: bad('payload builder reads the env');
	/value\.ipns_name = ipns/.test(b)
		? ok('payload builder emits ipns_name in the distribution block')
		: bad('payload builder emits ipns_name');
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 ipns-release-wiring smoke FAILED (${fail})`);
	process.exit(1);
}
console.log('\u2713 IPNS "always latest" is wired: keygen + publish scripts, release.yml, schema↔indexer parity, payload builder');
console.log(`\u2713 all ${pass} ipns-release-wiring scenarios passed`);
