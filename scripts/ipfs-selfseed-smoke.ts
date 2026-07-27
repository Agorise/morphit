#!/usr/bin/env tsx
/**
 * scripts/ipfs-selfseed-smoke.ts  (v1.9.3, Ken)
 *
 * v1.9.3 hosts releases on our OWN nodes — no commercial pinning service. This
 * pins the whole self-seed chain so no layer silently regresses:
 *   - release.yml computes the canonical CID with the PINNED Kubo (no upload), over
 *     the shared staging script, and the Kubo version + SHA-512 there MUST match
 *     ops/ipfs/morphit-ipfs-setup.sh (the drift risk of hardcoding it twice)
 *   - ops/ipfs/stage-release-dir.sh is the SINGLE deterministic staging path
 *     (no timestamp → CI's --only-hash CID == the seed box's add CID)
 *   - ops/ipfs/morphit-ipfs-seed.sh hosts it: stage → add → ASSERT CID==expected
 *     (fail loud) → announce
 *   - scripts/verify-cid-public.sh is the GUARD: resolves on >=1 public gateway or
 *     refuses the broadcast
 *   - NO commercial pinner (pinata / storacha / lighthouse) anywhere in the path
 *
 * Shell greps strip `#` comment lines first (a script's own comment necessarily
 * names the anti-pattern it replaced — e.g. stage-release-dir.sh mentions the old
 * `released_utc` in prose).
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
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
// Drop full-line `#` comments so anti-pattern greps ignore a script's own prose.
const stripHash = (s: string) =>
	s
		.split('\n')
		.filter((l) => !/^\s*#/.test(l))
		.join('\n');

const yml = read('.forgejo/workflows/release.yml');
const setup = read('ops/ipfs/morphit-ipfs-setup.sh');
const stager = stripHash(read('ops/ipfs/stage-release-dir.sh'));
const seed = stripHash(read('ops/ipfs/morphit-ipfs-seed.sh'));
const guard = stripHash(read('scripts/verify-cid-public.sh'));

// ── 1. NO commercial pinner anywhere in the release/host path ────────
{
	const PINNERS = /pinata|pinFileToIPFS|PINATA_JWT|pinByHash|lighthouse|storacha|fil\.one|up\.storacha/i;
	const files: Array<[string, string]> = [
		['release.yml', yml],
		['stage-release-dir.sh', stager],
		['morphit-ipfs-seed.sh', seed],
		['verify-cid-public.sh', guard]
	];
	let clean = true;
	for (const [name, body] of files) {
		if (PINNERS.test(body)) {
			clean = false;
			bad(`no commercial pinner: ${name} still references one`);
		}
	}
	clean && ok('no commercial pinner referenced anywhere (pinata / storacha / lighthouse)');
}

// ── 2. release.yml computes the CID with the pinned Kubo (no upload) ──
{
	const checks: Array<[string, boolean]> = [
		['installs a pinned Kubo (version + SHA-512)', /KUBO_VERSION/.test(yml) && /KUBO_SHA512/.test(yml)],
		['verifies the Kubo checksum (sha512sum)', /sha512sum/.test(yml)],
		['stages via the shared stage-release-dir.sh', /ops\/ipfs\/stage-release-dir\.sh/.test(yml)],
		['uses the LOCAL just-built tarball (MORPHIT_STAGE_TARBALL)', /MORPHIT_STAGE_TARBALL/.test(yml)],
		['computes the CID with ipfs add --only-hash (cidv1)', /add -rQ --cid-version 1 --only-hash/.test(yml)],
		['records the CID to ipfs-cid.txt', /ipfs-cid\.txt/.test(yml)]
	];
	for (const [n, okp] of checks) okp ? ok(`release.yml: ${n}`) : bad(`release.yml: ${n}`);
}

// ── 3. Kubo version + SHA-512 MATCH between release.yml and the setup script ──
{
	const ymlVer = (yml.match(/KUBO_VERSION:\s*(v[0-9][0-9.]*)/) || [])[1];
	const ymlSha = (yml.match(/KUBO_SHA512:\s*([0-9a-fA-F]{128})/) || [])[1];
	const setVer = (setup.match(/MORPHIT_KUBO_VERSION:-(v[0-9][0-9.]*)/) || [])[1];
	const setSha = (setup.match(/MORPHIT_KUBO_SHA512:-([0-9a-fA-F]{128})/) || [])[1];

	ymlVer ? ok(`release.yml Kubo version parsed (${ymlVer})`) : bad('release.yml Kubo version not found');
	ymlSha ? ok('release.yml Kubo SHA-512 parsed') : bad('release.yml Kubo SHA-512 not found');
	setVer ? ok(`setup script Kubo version parsed (${setVer})`) : bad('setup script Kubo version not found');
	setSha ? ok('setup script Kubo SHA-512 parsed') : bad('setup script Kubo SHA-512 not found');

	ymlVer && setVer && ymlVer === setVer
		? ok(`Kubo VERSION in sync (release.yml == setup script == ${ymlVer})`)
		: bad('Kubo version DRIFT between release.yml and morphit-ipfs-setup.sh', `${ymlVer} vs ${setVer}`);
	ymlSha && setSha && ymlSha.toLowerCase() === setSha.toLowerCase()
		? ok('Kubo SHA-512 in sync (release.yml == setup script)')
		: bad('Kubo SHA-512 DRIFT between release.yml and morphit-ipfs-setup.sh');
}

// ── 4. stage-release-dir.sh — single deterministic staging path ──────
{
	const checks: Array<[string, boolean]> = [
		['supports LOCAL acquisition (MORPHIT_STAGE_TARBALL)', /MORPHIT_STAGE_TARBALL/.test(stager)],
		['supports DOWNLOAD acquisition (release download base)', /MORPHIT_RELEASE_DOWNLOAD_BASE/.test(stager)],
		['verifies the tarball sha256 (integrity)', /sha256sum/.test(stager) && /mismatch/i.test(stager)],
		['stages a stable morphit-latest.tar.gz', /morphit-latest\.tar\.gz/.test(stager)],
		['writes metadata.json with version + sha256', /"version":/.test(stager) && /"sha256":/.test(stager)],
		['metadata is DETERMINISTIC (no released_utc timestamp)', !/released_utc/.test(stager)],
		['self-contained dir — no notes/asc fetch-dependency (v1.9.3 CID-divergence guard)', !/RELEASE-NOTES/.test(stager) && !/\.asc/.test(stager)]
	];
	for (const [n, okp] of checks) okp ? ok(`stager: ${n}`) : bad(`stager: ${n}`);
}

// ── 5. morphit-ipfs-seed.sh — origin host with the equality assertion ─
{
	const checks: Array<[string, boolean]> = [
		['stages via the shared stage-release-dir.sh', /stage-release-dir\.sh/.test(seed)],
		['adds the directory (ipfs add --cid-version 1)', /add -rQ --cid-version 1/.test(seed)],
		['ASSERTS the CID equals the expected/anchored one', /"\$CID" != "\$EXPECTED"/.test(seed) && /MISMATCH/i.test(seed)],
		['fails loud (exit 1) on CID mismatch', /MISMATCH[\s\S]*exit 1/i.test(seed)],
		['announces it (ipfs routing provide)', /routing provide/.test(seed)],
		['rejects a non-vX.Y.Z tag', /v\[0-9\]/.test(seed)]
	];
	for (const [n, okp] of checks) okp ? ok(`seed: ${n}`) : bad(`seed: ${n}`);
}

// ── 6. verify-cid-public.sh — the broadcast guard ───────────────────
{
	const checks: Array<[string, boolean]> = [
		['polls independent public gateways', /MORPHIT_GUARD_GATEWAYS/.test(guard) && /ipfs\.io/.test(guard) && /dweb\.link/.test(guard)],
		['fetches the CID metadata.json', /metadata\.json/.test(guard)],
		['confirms the expected version (not just any 200)', /WANT_VER/.test(guard) && /grep -q/.test(guard)],
		['passes on the FIRST gateway that serves (exit 0 in the loop)', /exit 0/.test(guard)],
		['fails loud → no broadcast (exit 1)', /DO NOT BROADCAST[\s\S]*exit 1/i.test(guard)],
		['backs off across rounds (retry cold content)', /ATTEMPTS/.test(guard) && /sleep/.test(guard)]
	];
	for (const [n, okp] of checks) okp ? ok(`guard: ${n}`) : bad(`guard: ${n}`);
}

// ── 7. morphit-ops wiring: the "Seed this release" action is offered ─
{
	const harden = read('apps/ops-cli/src/commands/harden.ts');
	/Seed this release to IPFS/.test(harden) && /morphit-ipfs-seed\.sh/.test(harden)
		? ok('morphit-ops harden offers "Seed this release to IPFS" → morphit-ipfs-seed.sh')
		: bad('morphit-ops seed action not wired');
}

// ── 8. morphit-ops UPGRADE auto-seeds the installed release (Block 3 fold) ──
{
	const upgrade = read('apps/ops-cli/src/commands/upgrade.ts');
	const checks: Array<[string, boolean]> = [
		['upgrade seeds via morphit-ipfs-seed.sh', /morphit-ipfs-seed\.sh/.test(upgrade)],
		['gated on IPFS hosting up (ipfs present + service active)', /is-active --quiet ipfs/.test(upgrade) && /command -v ipfs/.test(upgrade)],
		['seeds the just-installed tag (latestTag)', /seedScript, latestTag/.test(upgrade)],
		['non-fatal — never fails the upgrade over seeding', /never fail an upgrade over IPFS/.test(upgrade)]
	];
	for (const [n, okp] of checks) okp ? ok(`upgrade: ${n}`) : bad(`upgrade: ${n}`);
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 ipfs-selfseed smoke FAILED (${fail})`);
	process.exit(1);
}
console.log('\u2713 self-seed IPFS is wired: no commercial pinner, pinned-Kubo CID compute, version/SHA in sync, deterministic staging, seed asserts CID equality, guard gates the broadcast');
console.log(`\u2713 all ${pass} ipfs-selfseed scenarios passed`);
