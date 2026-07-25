#!/usr/bin/env tsx
/**
 * Smoke: the ELI5 release blocks must be REAL and COPY-PASTEABLE.
 *
 * cp445 — the six blocks were reconstructed from memory instead of reproduced
 * from the record, inventing a `<your-vps>` placeholder, a `morphit-ops
 * canary-repair` command that does not exist, and wrong script paths. Ken had to
 * catch it. Guidance ("copy it exactly") is not a control; a check is.
 *
 * `scripts/eli5-release.sh <version>` is now the single source of the blocks.
 * This smoke runs it and asserts:
 *   • every script path it names actually exists on disk;
 *   • the env-var names match what `release-build-payload.ts` really reads;
 *   • the gates survive (signed tag, CI-green gate, `< /dev/null`, canary);
 *   • the manifest comes from the VPS's served verify.json, not a laptop build;
 *   • no placeholder token ever creeps back in.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const GEN = join(REPO, 'scripts', 'eli5-release.sh');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
};

check('the block generator exists', existsSync(GEN));
if (!existsSync(GEN)) process.exit(1);

const out = execFileSync('bash', [GEN, '9.9.9', 'test message'], { encoding: 'utf8' });

// ─── the version is substituted everywhere, nothing left to hand-edit ───
check('the version is interpolated into the tag', /git tag -s v9\.9\.9 -m "Morphit v9\.9\.9"/.test(out));
check('the version is interpolated into the payload build', /MORPHIT_BUILD_VERSION=9\.9\.9/.test(out));
check('the commit message is interpolated', /git commit -m "test message"/.test(out));

// ─── NO PLACEHOLDERS. This is the exact class of bug that shipped. ───
const PLACEHOLDERS = ['<your-vps>', '<vps>', '<version>', 'X.Y.Z', 'YOUR_', 'TODO', 'FIXME', '...'];
for (const p of PLACEHOLDERS) {
	check(`no placeholder "${p}" survives into the output`, !out.includes(p));
}

// ─── every command must be a REAL file in this repo ───
const REFERENCED = [
	'apps/web/scripts/verify-json-to-release-manifest.mjs',
	'apps/indexer/scripts/release-build-payload.ts',
	'apps/indexer/scripts/release-broadcast.ts'
];
for (const rel of REFERENCED) {
	check(`the blocks name a real script: ${rel}`, out.includes(rel) && existsSync(join(REPO, rel)));
}
check('no invented command (morphit-ops canary-repair does not exist)', !/canary-repair/.test(out));

// Presence of the RIGHT path does not prove absence of a WRONG one — a tamper
// that swapped the dry-run line for `apps/ops-cli/src/main.ts release-broadcast`
// passed the check above, because the real path still appeared on the next line.
// So: EVERY path-shaped token in the output must exist on disk, and the two
// broadcast invocations must be exactly the canonical ones.
const paths = [...out.matchAll(/\b(?:apps|packages|scripts)\/[\w./-]+\.(?:ts|mjs|js|sh)\b/g)].map((m) => m[0]);
const missing = paths.filter((rel) => !existsSync(join(REPO, rel)));
check('every path named in the blocks exists on disk', missing.length === 0);
if (missing.length > 0) for (const m of missing) console.error(`      missing: ${m}`);

check('the dry-run line is exactly canonical', out.includes('npx tsx apps/indexer/scripts/release-broadcast.ts release.json --dry-run'));
check('the real-broadcast line is exactly canonical', /npx tsx apps\/indexer\/scripts\/release-broadcast\.ts release\.json\n/.test(out));
check('the blocks never invoke ops-cli (release tooling lives in apps/indexer)', !/apps\/ops-cli/.test(out));

// ─── env vars must match what the payload builder actually reads ───
const builder = readFileSync(join(REPO, 'apps', 'indexer', 'scripts', 'release-build-payload.ts'), 'utf8');
for (const v of ['MORPHIT_BUILD_VERSION', 'MORPHIT_BUILD_HASH_MANIFEST_FILE', 'MORPHIT_BUILD_BLURT_BASE']) {
	check(`${v} is read by release-build-payload.ts and named in the blocks`, builder.includes(`process.env.${v}`) && out.includes(v));
}
// The BLURT floor must be CHAIN-PINNED, not left to the builder's empty default:
// BLOCK 4 runs with `< /dev/null`, so an unset value would OMIT the floor and let
// each instance silently fall back to its own env. Pin the canonical 125.
check('BLOCK 4 pins the BLURT floor to 125', /MORPHIT_BUILD_BLURT_BASE=125\b/.test(out));

// ─── the gates ───
check('BLOCK 2 waits for CI to go green', /GATE: wait for CI to go green/.test(out));
check('the tag is SIGNED with a message (Ken\u2019s git config rejects bare tags)', /git tag -s /.test(out) && !/git tag v/.test(out));
check('`< /dev/null` is present (the payload builder prompts, and would hang)', /release-build-payload\.ts < \/dev\/null/.test(out));
check('a dry-run precedes the real broadcast', out.indexOf('--dry-run') < out.lastIndexOf('release-broadcast.ts release.json'));
check('BLOCK 6 repairs the canary (upgrade wipes build/canary.txt)', /morphit-canary-setup\.sh/.test(out));

// ─── the manifest must come from the VPS, not a laptop build ───
check('the manifest is derived from the VPS\u2019s SERVED verify.json', /curl -fsSL https:\/\/morphit\.io\/verify\.json/.test(out));
check('no laptop build feeds the manifest (cross-machine hashes differ)', !/npm run build/.test(out) && !/build-manifest\.mjs/.test(out));
check('the on-chain payload pins no blurt_rpc endpoints', !/ENDPOINTS_FILE/.test(out) && !/blurt_rpc/.test(out));

// ─── decentralized-distribution: the anchor comes from CI, not a laptop sign ───
// release.yml builds + hashes + signs the canonical tarball and attaches a
// distribution-anchor.env; the ceremony FETCHES that and sources it. It must
// NOT run release-sign.sh (its git-archive bytes differ from the published
// tarball → a mismatched on-chain hash — the footgun removed at the cp560 cut).
check('the ceremony does NOT run release-sign.sh (CI builds the canonical tarball)', !/release-sign\.sh/.test(out));
check('the ceremony fetches the anchor from the published release', /releases\/download\/[^\s]*distribution-anchor\.env/.test(out));
check('the payload build sources the fetched distribution anchor', /source \/tmp\/morphit-anchor\.env/.test(out));
check('the blocks note that mirroring to GitHub + Codeberg is automatic', /GitHub \+ Codeberg/.test(out));
// IPFS is OPTIONAL + off by default: the ceremony must NOT force an ipfs add
// or a manual mirror push (Ken's Forgejo auto-mirrors those refs already).
check('the ceremony does not force an ipfs add step', !/ipfs add/.test(out));
check('the ceremony does not do a manual codeberg push (auto-mirrored)', !/git push codeberg/.test(out));
// The mirror list is now a FIXED default baked into the payload builder, so the
// operator never supplies it (Forgejo auto-pushes to these hosts anyway).
check('the payload builder bakes the Codeberg + GitHub mirror default', /codeberg\.org\/agorise\/morphit/.test(builder) && /github\.com\/agorise\/morphit/.test(builder));
for (const v of ['MORPHIT_BUILD_SOURCE_SHA256', 'MORPHIT_BUILD_GPG_FINGERPRINT', 'MORPHIT_BUILD_IPFS_CID', 'MORPHIT_BUILD_MIRRORS']) {
	check(`${v} is read by release-build-payload.ts`, builder.includes(`process.env.${v}`));
}

// ─── release.yml must publish + attach the anchor, and NEVER broadcast ───
// The ceremony now depends on CI doing the build/publish/attach; guard it so a
// future edit that drops the anchor write, the auto-publish, or (critically)
// leaks the chain broadcast into CI is caught here.
const releaseYml = readFileSync(join(REPO, '.forgejo', 'workflows', 'release.yml'), 'utf8');
check('release.yml writes the anchor from the PUBLISHED tarball sha256', /distribution-anchor\.env/.test(releaseYml) && /\$TARBALL\.sha256/.test(releaseYml));
check('release.yml auto-creates the release + attaches assets', /\/releases\b/.test(releaseYml) && /attachment=@/.test(releaseYml));
check('release.yml grants the auto-token release-write (contents: write)', /permissions:\s*\n\s*contents:\s*write/.test(releaseYml));
check('release.yml NEVER broadcasts to the chain (no spending key in CI)', !/release-broadcast/.test(releaseYml));

// ─── all six blocks, in order ───
const order = ['BLOCK 1', 'BLOCK 2', 'BLOCK 3', 'BLOCK 4', 'BLOCK 5', 'BLOCK 6'];
let last = -1;
let ordered = true;
for (const b of order) {
	const i = out.indexOf(b);
	if (i === -1 || i < last) ordered = false;
	last = i;
}
check('all six blocks are present, in order', ordered);
check('there is no stray BLOCK 7 (ceremony is 6 blocks)', !/BLOCK 7/.test(out));

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} eli5-release-blocks scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} eli5-release-blocks checks FAILED`);
	process.exit(1);
}
