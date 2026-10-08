#!/usr/bin/env tsx
/**
 * Smoke: the ELI5 release blocks must be REAL and COPY-PASTEABLE.
 *
 * the six blocks were reconstructed from memory instead of reproduced
 * from the record, inventing a `<your-vps>` placeholder, a `morphit-ops
 * canary-repair` command that does not exist, and wrong script paths. The maintainer had to
 * catch it. Guidance ("copy it exactly") is not a control; a check is.
 *
 * `scripts/eli5-release.sh <version>` is now the single source of the blocks.
 * This smoke runs it and asserts:
 *   • every script path it names actually exists on disk;
 *   • the env-var names match what `release-build-payload.ts` really reads;
 *   • the gates survive (signed tag, CI-green gate, `< /dev/null`, canary);
 *   • the manifest comes from the published tarball, not a laptop build, and
 *     the upgraded site is checked against it after the broadcast;
 *   • no placeholder token ever creeps back in.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrityGate } from '../../ops-cli/src/commands/upgrade.ts';

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
check(
	'the version is interpolated into the tag',
	/git tag -s v9\.9\.9 -m "Morphit v9\.9\.9"/.test(out)
);
check(
	'the version is interpolated into the payload build',
	/MORPHIT_BUILD_VERSION=9\.9\.9/.test(out)
);
check('the commit message is interpolated', /^git commit -m 'test message'$/m.test(out));

// ─── the commit line runs the message as DATA, whatever it contains ───
// It was pasted into `git commit -m "…"`: a quote broke the line and a `$(…)`
// or backtick ran a command on the laptop. Run the printed line with `git`
// replaced by a function that records its arguments.
{
	const dir = mkdtempSync(join(tmpdir(), 'eli5-msg-'));
	const pwned = join(dir, 'PWNED');
	const hostile = `v9.9.9 — it's "quoted" \`touch ${pwned}\` $(touch ${pwned}) $HOME \\ ; touch ${pwned} '' "`;
	const o = execFileSync('bash', [GEN, '9.9.9', hostile], { encoding: 'utf8' });
	const line = (/^git commit -m .*$/m.exec(o) ?? [''])[0];
	const r = spawnSync(
		'bash',
		['-c', `git() { printf '%s\\0' "$@" > "${join(dir, 'args')}"; }\n${line}`],
		{ encoding: 'utf8' }
	);
	let args: string[] = [];
	try {
		args = readFileSync(join(dir, 'args'), 'utf8').split('\0').slice(0, -1);
	} catch {
		args = [];
	}
	check(
		'a commit message with quotes, backticks, $( ) and $ is committed verbatim and runs nothing',
		r.status === 0 &&
			!existsSync(pwned) &&
			args.length === 3 &&
			args[0] === 'commit' &&
			args[1] === '-m' &&
			args[2] === hostile
	);
	rmSync(dir, { recursive: true, force: true });
}

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
const paths = [...out.matchAll(/\b(?:apps|packages|scripts)\/[\w./-]+\.(?:ts|mjs|js|sh)\b/g)].map(
	(m) => m[0]
);
const missing = paths.filter((rel) => !existsSync(join(REPO, rel)));
check('every path named in the blocks exists on disk', missing.length === 0);
if (missing.length > 0) for (const m of missing) console.error(`      missing: ${m}`);

check(
	'the dry-run line is exactly canonical',
	out.includes(
		'./node_modules/.bin/tsx apps/indexer/scripts/release-broadcast.ts release.json --dry-run'
	)
);
check(
	'the real-broadcast line is exactly canonical',
	/\n\.\/node_modules\/\.bin\/tsx apps\/indexer\/scripts\/release-broadcast\.ts release\.json\n/.test(
		out
	)
);
check(
	'the blocks never run npx (it can fetch a package that is not installed)',
	!/\bnpx\b/.test(out)
);
check(
	'the blocks never invoke ops-cli (release tooling lives in apps/indexer)',
	!/apps\/ops-cli/.test(out)
);

// ─── env vars must match what the payload builder actually reads ───
const builder = readFileSync(
	join(REPO, 'apps', 'indexer', 'scripts', 'release-build-payload.ts'),
	'utf8'
);
for (const v of [
	'MORPHIT_BUILD_VERSION',
	'MORPHIT_BUILD_HASH_MANIFEST_FILE',
	'MORPHIT_BUILD_BLURT_BASE'
]) {
	check(
		`${v} is read by release-build-payload.ts and named in the blocks`,
		builder.includes(`process.env.${v}`) && out.includes(v)
	);
}
// The BLURT floor must be CHAIN-PINNED, not left to the builder's empty default:
// BLOCK 3 runs with `< /dev/null`, so an unset value would OMIT the floor and let
// each instance silently fall back to its own env. Pin the canonical 125.
check('BLOCK 3 pins the BLURT floor to 125', /MORPHIT_BUILD_BLURT_BASE=125\b/.test(out));

// ─── every block says WHICH MACHINE it runs on (v1.18.0 review, O12) ───
// the maintainer works across several boxes at once; a block that does not say where it
// runs is a block run in the wrong terminal. Blocks 3, 5 and 6 did not.
const MACHINE = /\((?:laptop|morphit\.io|morphitir|morphitlat)\b/;
const headers = [...out.matchAll(/^\*\*BLOCK (\d)\*\* — (.*)$/gm)];
check('there are exactly six blocks', headers.length === 6);
for (const h of headers) {
	check(`BLOCK ${h[1]} names the machine it runs on`, MACHINE.test(h[2] ?? ''));
}
check(
	'BLOCK 5 (the upgrade) runs on morphit.io',
	/^\*\*BLOCK 5\*\* — [^\n]*\(morphit\.io\b/m.test(out)
);
check(
	'BLOCKS 3, 4 and 6 (payload, key and canary) run on the laptop, never the server',
	/^\*\*BLOCK 3\*\* — [^\n]*\(laptop\b/m.test(out) &&
		/^\*\*BLOCK 4\*\* — [^\n]*\(laptop\b/m.test(out) &&
		/^\*\*BLOCK 6\*\* — [^\n]*\(laptop\b/m.test(out)
);

// ─── the gates ───
check('BLOCK 2 waits for CI to go green', /GATE: wait for CI to go green/.test(out));
check(
	'the tag is SIGNED with a message (the maintainer\u2019s git config rejects bare tags)',
	/git tag -s /.test(out) && !/git tag v/.test(out)
);
check(
	'`< /dev/null` is present (the payload builder prompts, and would hang)',
	/release-build-payload\.ts < \/dev\/null/.test(out)
);
check(
	'a dry-run precedes the real broadcast',
	out.indexOf('--dry-run') < out.lastIndexOf('release-broadcast.ts release.json')
);
check(
	'BLOCK 6 repairs the canary via the migrated refresh ~/.morphit/update-canary.sh (upgrade wipes build/canary.txt)',
	/\.morphit\/update-canary\.sh/.test(out) && !/morphit-canary-setup\.sh/.test(out)
);

// ─── BLOCK 3 installs the lockfile before running any repo tooling ───
// (v1.20.0) The laptop repo is refreshed by unpacking the release tarball, which
// leaves node_modules as it was. The payload builder then imported a library
// whose installed copy predated the lockfile and died before writing
// release.json. BLOCK 3's FIRST command must be `npm ci`, ahead of every tsx
// run in the ceremony — and with no install scripts, on the machine that holds
// the @morphit WIF.
{
	const b3 = out.slice(out.indexOf('**BLOCK 3**'), out.indexOf('**BLOCK 4**'));
	const firstCmd = (/```\n([^\n]*)/.exec(b3) ?? [])[1] ?? '';
	check(
		'BLOCK 3 starts with `npm ci --ignore-scripts` (unpacking a tarball does not update node_modules)',
		/^npm ci --ignore-scripts\b/.test(firstCmd) &&
			out.indexOf('npm ci') < out.indexOf('node_modules/.bin/tsx')
	);
}

// ─── (v1.20.3) BLOCK 3 clears the previous ceremony's values first ───
// v1.20.2's payload carried the CID and IPNS record v1.20.1's ceremony had left
// in the same terminal. The unset comes BEFORE the payload build, which also
// refuses such a value itself (MORPHIT_BUILD_ANCHOR_FILE).
{
	const b3 = out.slice(out.indexOf('**BLOCK 3**'), out.indexOf('**BLOCK 4**'));
	const unsetAt = b3.indexOf("unset $(env | grep -o '^MORPHIT_BUILD_[A-Z0-9_]*')");
	check(
		'BLOCK 3 unsets every MORPHIT_BUILD_* value before building the payload',
		unsetAt !== -1 && unsetAt < b3.indexOf('release-build-payload.ts')
	);
}

// ─── (v1.21.1) a release whose anchor has no CID: Block 3 says how to supply it ───
// Behaviour: apps/indexer/test/scripts/releaseCeremony.test.ts runs the printed
// seed command with stub ipfs/curl (the "hosted" line, the copy that ran, a
// tarball failing its hash) and the --ipfs-cid recovery line.
// 2026-10-07: the CID can no longer come from the upgrade, which now runs after
// the broadcast; morphit.io seeds on its own (it installs nothing), with the
// NEW release's seed scripts from the checked tarball, never the installed ones
// (an older stager stages different bytes, so a different CID).
{
	const b3 = out.slice(out.indexOf('**BLOCK 3**'), out.indexOf('**BLOCK 4**'));
	const note = b3.slice(b3.indexOf('this release has no IPFS CID'));
	const cmd = /```\n([^\n]+)\n```/.exec(note)?.[1] ?? '';
	check(
		'BLOCK 3 has morphit.io seed the release with its own scripts, and passes the CID with --ipfs-cid',
		/sha256sum -c/.test(cmd) &&
			/MORPHIT_STAGE_TARBALL="\$D\/morphit-v9\.9\.9\.tar\.gz"/.test(cmd) &&
			/sh "\$D\/ops\/ipfs\/morphit-ipfs-seed\.sh" v9\.9\.9$/.test(cmd) &&
			!/\/opt\/morphit\/ops/.test(cmd) &&
			/morphit\.io, logged in as root/.test(note) &&
			/hosted v9\.9\.9 → bafy/.test(note) &&
			/release-build-payload\.ts --ipfs-cid <cid> < \/dev\/null > release\.json/.test(note)
	);
}

// ─── the manifest: from the anchored tarball, checked against its own list ───
// (behaviour: apps/indexer/test/scripts/releaseCeremony.test.ts runs Block 3 and
// Block 6's served check)
{
	const b3 = out.slice(out.indexOf('**BLOCK 3**'), out.indexOf('**BLOCK 4**'));
	check(
		'BLOCK 3 computes the manifest from the published tarball it downloaded',
		/verify-json-to-release-manifest\.mjs --anchor \/tmp\/morphit-anchor\.env --tarball \/tmp\/morphit-v9\.9\.9\.tar\.gz > apps\/web\/build-manifest\.release\.json/.test(
			b3
		) && /-o \/tmp\/morphit-v9\.9\.9\.tar\.gz$/m.test(b3)
	);
}
check(
	'no laptop build feeds the manifest (cross-machine hashes differ)',
	!/npm run build/.test(out) && !/build-manifest\.mjs/.test(out)
);
check(
	'the on-chain payload pins no blurt_rpc endpoints',
	!/ENDPOINTS_FILE/.test(out) && !/blurt_rpc/.test(out)
);

// ─── decentralized-distribution: the anchor comes from CI, not a laptop sign ───
// release.yml builds + hashes + signs the canonical tarball and attaches a
// distribution-anchor.env; the ceremony FETCHES that and the payload builder
// PARSES it (never `source`). It must
// NOT run release-sign.sh (its git-archive bytes differ from the published
// tarball → a mismatched on-chain hash — the footgun removed at the cut).
check(
	'the ceremony does NOT run release-sign.sh (CI builds the canonical tarball)',
	!/release-sign\.sh/.test(out)
);
check(
	'the ceremony fetches the anchor from the published release',
	/releases\/download\/[^\s]*distribution-anchor\.env/.test(out)
);
check(
	'the payload build reads the fetched anchor itself and nothing sources it',
	/MORPHIT_BUILD_ANCHOR_FILE=\/tmp\/morphit-anchor\.env /.test(out) &&
		!/^\s*(source|\.)\s/m.test(out) &&
		builder.includes('MORPHIT_BUILD_ANCHOR_FILE')
);
// The release (its page and assets) is copied only to the hosts release.yml
// publishes to; the other mirrors get the commits and the tag by git push.
// The blocks must name exactly those hosts, and never claim more.
{
	const ymlHosts = [
		...readFileSync(join(REPO, '.forgejo', 'workflows', 'release.yml'), 'utf8').matchAll(
			/^\s*publish_to "([a-z0-9.-]+)"/gm
		)
	].map((m) => m[1]!);
	const gate = out.slice(out.indexOf('release.yml` to go green'), out.indexOf('**BLOCK 3**'));
	check('release.yml copies the release to at least one host', ymlHosts.length > 0);
	check(
		`the gate after BLOCK 2 names every host release.yml copies the release to (${ymlHosts.join(', ')})`,
		ymlHosts.every((h) => gate.includes(h))
	);
	check(
		'the blocks never claim the release is mirrored to GitHub (it gets only the git push)',
		!/mirrored to GitHub|GitHub \+ Codeberg/.test(out)
	);
}
// IPFS is OPTIONAL + off by default: the ceremony must NOT force an ipfs add
// or a manual mirror push (the maintainer's Forgejo auto-mirrors those refs already).
check('the ceremony does not force an ipfs add step', !/ipfs add/.test(out));
check(
	'the ceremony does not do a manual codeberg push (auto-mirrored)',
	!/git push codeberg/.test(out)
);
// The mirror list is now a FIXED default baked into the payload builder, so the
// operator never supplies it (Forgejo auto-pushes to these hosts anyway).
check(
	'the payload builder bakes the Codeberg + GitHub mirror default',
	/codeberg\.org\/agorise\/morphit/.test(builder) && /github\.com\/agorise\/morphit/.test(builder)
);
for (const v of [
	'MORPHIT_BUILD_SOURCE_SHA256',
	'MORPHIT_BUILD_GPG_FINGERPRINT',
	'MORPHIT_BUILD_IPFS_CID',
	'MORPHIT_BUILD_MIRRORS'
]) {
	check(`${v} is read by release-build-payload.ts`, builder.includes(`process.env.${v}`));
}

// ─── release.yml must publish + attach the anchor, and NEVER broadcast ───
// The ceremony now depends on CI doing the build/publish/attach; guard it so a
// future edit that drops the anchor write, the auto-publish, or (critically)
// leaks the chain broadcast into CI is caught here.
const releaseYml = readFileSync(join(REPO, '.forgejo', 'workflows', 'release.yml'), 'utf8');
check(
	'release.yml writes the anchor from the PUBLISHED tarball sha256',
	/distribution-anchor\.env/.test(releaseYml) && /\$TARBALL\.sha256/.test(releaseYml)
);
check(
	'release.yml auto-creates the release + attaches assets',
	/\/releases\b/.test(releaseYml) && /attachment=@/.test(releaseYml)
);
check(
	'release.yml sets the release body from RELEASE-NOTES-${TAG}.md (node-encoded JSON)',
	/RELEASE-NOTES-\$\{TAG\}\.md/.test(releaseYml) && /rel-create\.json/.test(releaseYml)
);
check(
	'the re-run body refresh uses a tag_name-free PATCH (never touches the signed tag)',
	/-X PATCH/.test(releaseYml) && /rel-patch\.json/.test(releaseYml)
);
check(
	'release.yml declares NO `permissions:` key (Forgejo ignores it, warns)',
	!/^\s*permissions:/m.test(releaseYml)
);
check(
	'release.yml publishes with an operator token, falling back to the auto-token',
	/RELEASE_TOKEN:-\$AUTO_TOKEN/.test(releaseYml)
);
check(
	'release.yml NEVER broadcasts to the chain (no spending key in CI)',
	!/release-broadcast/.test(releaseYml)
);

// ─── canonical IPFS CID (self-hosted seed; NO pinning service) — additive, never fails a release ───
// v1.9.3: release.yml computes a DETERMINISTIC directory CID with the pinned
// Kubo (`ipfs add --only-hash`) over the shared staging script — no upload, no
// secret, no account — and carries it on-chain via the anchor's optional ipfs_cid.
// Our own nodes host it (the seed box + every instance's Kubo). Pin the wiring so a
// future edit can't silently drop the automation or re-introduce a paid pinner.
check(
	'release.yml computes the CID with the pinned Kubo, no pinning service',
	/add -rQ --cid-version 1 .*--only-hash/.test(releaseYml) &&
		/ops\/ipfs\/stage-release-dir\.sh/.test(releaseYml) &&
		!/pinata|pinFileToIPFS|PINATA_JWT/i.test(releaseYml)
);
check(
	'the CID compute is non-fatal (release proceeds without ipfs_cid on failure)',
	/no ipfs_cid this run/.test(releaseYml)
);
check(
	'the anchor carries the CID only when one was pinned (ipfs-cid.txt)',
	/if \[ -s ipfs-cid\.txt \]/.test(releaseYml) && /MORPHIT_BUILD_IPFS_CID=/.test(releaseYml)
);
const payloadBuilder = readFileSync(
	join(REPO, 'apps', 'indexer', 'scripts', 'release-build-payload.ts'),
	'utf8'
);
check(
	'the payload builder reads MORPHIT_BUILD_IPFS_CID → on-chain ipfs_cid',
	/MORPHIT_BUILD_IPFS_CID/.test(payloadBuilder) && /value\.ipfs_cid = cid/.test(payloadBuilder)
);

// ─── (2026-10-07) the release is anchored on chain BEFORE morphit.io upgrades ───
// Since v1.21.0, `morphit-ops upgrade` installs a release only with a pinned
// signature or @morphit's on-chain record of its SHA-256 (integrityGate). CI
// holds no signing key, so the record is the only way in, and the v1.21.1
// ceremony, which upgraded morphit.io in Block 3 and broadcast in Block 5, was
// refused on morphit.io and morphitir: "The release is not signed, and no
// signed on-chain release record names its hash." Assert the reason (the gate,
// run) and the consequence (the order of the printed blocks).
{
	const gateRefusesUnanchored = !integrityGate({
		signature: 'absent',
		chainHash: null,
		primaryHash: 'a'.repeat(64),
		actualHash: 'a'.repeat(64),
		hidden: null
	}).allowed;
	check(
		'the upgrader refuses an unsigned release that has no on-chain record (so the ceremony must broadcast first)',
		gateRefusesUnanchored
	);
	const broadcastAt = out.search(
		/\n\.\/node_modules\/\.bin\/tsx apps\/indexer\/scripts\/release-broadcast\.ts release\.json\n/
	);
	const upgradeAt = out.search(/^sudo morphit-ops\b/m);
	check(
		'the real broadcast is printed before the first `sudo morphit-ops` (the upgrade needs the on-chain record)',
		broadcastAt !== -1 && upgradeAt !== -1 && broadcastAt < upgradeAt
	);
	const b5 = out.slice(out.indexOf('**BLOCK 5**'), out.indexOf('**BLOCK 6**'));
	check(
		'BLOCK 5 is the morphit.io upgrade, after the broadcast',
		/^\*\*BLOCK 5\*\* — [^\n]*\(morphit\.io\b/m.test(out) && /^sudo morphit-ops$/m.test(b5)
	);
	// The served-site check still runs: after the upgrade, against the record.
	const b6 = out.slice(out.indexOf('**BLOCK 6**'));
	check(
		'BLOCK 6 checks the upgraded morphit.io serves the anchored build (verify.json against the tarball)',
		/curl -fsSL https:\/\/morphit\.io\/verify\.json -o (\S+)/.test(b6) &&
			/verify-json-to-release-manifest\.mjs --anchor \S+ --tarball \S+ --served \S+/.test(b6)
	);
	// No line before the broadcast fetches what morphit.io serves: it still
	// serves the previous release then.
	check(
		'nothing before the broadcast reads morphit.io/verify.json (it still serves the old release)',
		!out.slice(0, broadcastAt).includes('morphit.io/verify.json')
	);
}

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
