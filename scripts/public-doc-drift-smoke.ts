#!/usr/bin/env tsx
/**
 * Morphit — public-doc drift smoke (v1.7.7, t.txt #1).
 *
 * Ken: "i do not want ANY drift, so make sure with each new release, we verify
 * each of the public facing md files that users will want to refer to for help."
 *
 * A promise to "check every release" is a promise that holds until somebody is
 * in a hurry. This is the thing that makes it hold anyway.
 *
 * SCOPE — the docs a stranger actually opens when they need help. Deliberately
 * NOT all 222 .md files: most are point-in-time audit records, and a guard that
 * demanded those stay current would force us to falsify history.
 *
 * WHAT DRIFT MEANS HERE (each check pins a REQUIREMENT, never a literal):
 *   D-1  every env var a public doc tells you to set is read by the code.
 *        This is the one that actually bites: v1.7.5 shipped with
 *        `MORPHIT_INDEXER_BLURT_RPC_ENDPOINTS` in apps/indexer/README.md while
 *        the code reads `MORPHIT_INDEXER_RPC_ENDPOINTS`. An operator following
 *        the README set a variable that was SILENTLY IGNORED and got the default
 *        endpoints. No error, no warning — the doc just lied.
 *   D-2  every repo path a public doc cites in backticks exists.
 *   D-3  every npm script a public doc tells you to run exists in a package.json.
 *   D-4  the start-here hub's links all resolve (it is the front door).
 *   D-5  no public doc claims a version that contradicts package.json.
 *
 * ON FALSE POSITIVES — a guard that cries wolf gets muted, and a muted guard
 * protects nothing. Each allow-list entry below is a REAL class found by hand
 * during the v1.7.5/v1.7.7 sweeps, with the reason it is not drift. Adding an
 * entry is a decision; it should be uncomfortable.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The docs a user or operator opens for help. */
const PUBLIC_DOCS = [
	'README.md',
	'docs/start-here/README.md',
	'docs/RUN-A-MORPHIT-NODE.md',
	'docs/OPERATIONS.md',
	'docs/UPGRADING.md',
	'docs/MIGRATE-TO-RELEASE-TRACK.md',
	'docs/SECURITY.md',
	'docs/API.md',
	'docs/LAUNCH-DAY.md',
	'docs/POST-LAUNCH-WEEK-ONE.md',
	'docs/BETA-INCIDENT-RUNBOOK.md',
	'docs/RECOVERING-FROM-WRONG-RELAY-KEY.md',
	'docs/FEES-AND-REWARDS.md',
	'docs/SWITCHING-NETWORKS.md',
	'apps/indexer/README.md',
	'apps/relay/README.md',
	'apps/mcp-server/README.md',
	'ops/ansible/README.md'
];

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
	}
};

// ── the docs must exist at all ──────────────────────────────────────
for (const d of PUBLIC_DOCS) {
	check(`D-0 ${d} exists`, existsSync(join(ROOT, d)), 'a public doc vanished, or was moved without updating this list');
}
const docs = PUBLIC_DOCS.filter((d) => existsSync(join(ROOT, d)));
const text = new Map(docs.map((d) => [d, readFileSync(join(ROOT, d), 'utf8')]));

// ── D-1: documented env vars must be read by the code ───────────────
/** Env names in public docs that are NOT drift, each with the reason. */
const ENV_ALLOW: ReadonlyArray<{ name: string; why: string }> = [
	{
		name: 'MORPHIT_BUILD_',
		why: 'a prefix fragment, not a variable — matched because docs write MORPHIT_BUILD_* wildcards'
	},
	{
		name: 'MORPHIT_RELAY_AUTOMINT_',
		why: 'documented BECAUSE it no longer exists — OPERATIONS.md tells upgraders to REMOVE it (ADR-0010 as amended 2026-06). Documenting a removal is the opposite of drift.'
	},
	{
		name: 'MORPHIT_RELAY_WEEKLY_ACT_COUNT',
		why: 'same removal note as MORPHIT_RELAY_AUTOMINT_*'
	},
	{
		name: 'MORPHIT_RELAY_DAILY_RECIPIENT_CAP_USD',
		why: 'appears in an OPERATIONS.md FUTURE-WORK section that literally says "4-6 new env vars" — a proposal, not a claim about today'
	},
	{
		name: 'MORPHIT_RELAY_GLOBAL_TPM_CEILING',
		why: 'same future-work proposal as MORPHIT_RELAY_DAILY_RECIPIENT_CAP_USD'
	},
	{
		name: 'MORPHIT_CANARY_BLURT_RPC',
		why: "read by Ken's LOCAL canary script (~/Documents/Agorise/Morphit/morphit-canary-setup.sh), which is intentionally outside this repo"
	},
	{ name: 'MORPHIT_CANARY_INSTANCE_ORIGIN', why: 'local canary script, outside this repo' },
	{ name: 'MORPHIT_CANARY_NEWS_RSS', why: 'local canary script, outside this repo' },
	{ name: 'MORPHIT_CANARY_OPERATOR_ACCOUNT', why: 'local canary script, outside this repo' },
	{ name: 'MORPHIT_CANARY_OPERATOR_NAME', why: 'local canary script, outside this repo' },
	{ name: 'MORPHIT_CANARY_PGP_KEY_ID', why: 'local canary script, outside this repo' },
	{
		name: 'MORPHIT_RELAY_KEYSTORE_PATH',
		why: 'named in OPERATIONS.md BECAUSE it is a warning: "Earlier revisions of this example named these … which the relay never reads". This is the F-007 bug (cp308) and the doc now steers operators away from it. Warning about a past mistake is the opposite of drift — and a guard that punished it would delete the warning and let the mistake back in.'
	},
	{
		name: 'MORPHIT_RELAY_PASSPHRASE_FILE',
		why: 'same F-007 warning as MORPHIT_RELAY_KEYSTORE_PATH'
	},
	{
		name: 'MORPHIT_FAIL2BAN_SSHD_CRITICAL',
		why: 'RUNTIME-ASSEMBLED, not literal: the monitor builds MORPHIT_FAIL2BAN_<JAIL>_CRITICAL per live jail (see operator-doc-env-var-parity-smoke, which documents the same pattern). `sshd` is a real jail, so this is a real var — it just never appears as a literal in source.'
	}
];
const allowed = new Set(ENV_ALLOW.map((e) => e.name));

// Everything the code could possibly read.
//
// NOT `git grep`: this repo is handed between sessions as a TARBALL with no
// .git, where git grep exits non-zero and silently contributes nothing — which
// made the first version of this guard report every documented env var as a
// ghost. A guard whose answer depends on whether .git happens to exist is worse
// than no guard: it is a guard that cries wolf in exactly the environment the
// work actually happens in. One code path, same answer everywhere.
const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.svelte-kit',
	'dist',
	'build',
	'coverage',
	'.vite',
	'__pycache__',
	'translator-output'
]);
const walkFiles = (dir: string): string[] => {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(e.name)) continue;
		const f = join(dir, e.name);
		if (e.isDirectory()) out.push(...walkFiles(f));
		else out.push(f);
	}
	return out;
};
const allFiles = walkFiles(ROOT);
const repoFiles = allFiles.map((f) => f.slice(ROOT.length + 1));

/** Strip comments before treating a file as evidence.
 *
 *  Found by tamper-proofing THIS guard: reintroducing the exact v1.7.5 ghost var
 *  did not fire it. Reason — this file's own header explains the bug BY NAME, and
 *  the header is not markdown, so the guard read its own prose as proof that the
 *  ghost var was real code. `operator-doc-env-var-parity-smoke` has the identical
 *  shape (its header names MORPHIT_RELAY_KEYSTORE_PATH, a ghost).
 *
 *  A guard that documents a bug must not thereby whitelist it. Mentioning a name
 *  is not reading it: `process.env.MORPHIT_X` is evidence, `// MORPHIT_X is a
 *  ghost` is prose. This is a blunt strip, not a parser — it can only ever REMOVE
 *  evidence, so its failure mode is a false ALARM (noisy, noticed, fixed), never
 *  a false pass (silent, and the whole reason this guard exists). */
const stripComments = (src: string): string =>
	src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let codeBlob = '';
for (const f of allFiles) {
	if (f.endsWith('.md')) continue; // docs are the CLAIM, not the evidence
	try {
		const raw = readFileSync(f, 'utf8');
		codeBlob += /\.(ts|tsx|js|mjs|cjs|svelte)$/.test(f) ? stripComments(raw) : raw;
	} catch {
		/* binary */
	}
}

const codeEnv = new Set(codeBlob.match(/MORPHIT_[A-Z0-9_]+/g) ?? []);

const ghosts: string[] = [];
for (const [doc, body] of text) {
	for (const v of new Set(body.match(/\bMORPHIT_[A-Z0-9_]+\b/g) ?? [])) {
		if (allowed.has(v) || codeEnv.has(v)) continue;
		ghosts.push(`${doc}: ${v}`);
	}
}
check(
	'D-1 every env var in a public doc is actually read by the code',
	ghosts.length === 0,
	`documented but NOWHERE in code — an operator setting these gets silence:\n      ${ghosts.join('\n      ')}`
);

// The allow-list must not rot either: an entry that stops matching is a lie.
const staleAllow = ENV_ALLOW.filter(
	(e) => !docs.some((d) => (text.get(d) ?? '').includes(e.name))
);
check(
	'D-1b no stale env allow-list entries',
	staleAllow.length === 0,
	`these are allow-listed but no longer appear in any public doc — delete them:\n      ${staleAllow
		.map((e) => e.name)
		.join(', ')}`
);

// ── D-2: cited repo paths must exist ────────────────────────────────
/** Backticked paths that are NOT repo files, with the reason. */
const PATH_ALLOW: ReadonlyArray<{ frag: string; why: string }> = [
	{ frag: 'verify.json', why: 'a SERVED artifact built at deploy time, not a repo file' },
	{ frag: 'build-manifest.release.json', why: 'generated during the release ceremony' },
	{ frag: 'service-worker.js', why: 'a served URL path, not a repo file' },
	{ frag: 'sitemap.xml', why: 'generated at build time' },
	{ frag: 'llms.txt', why: 'generated at build time' },
	{ frag: 'llms-full.txt', why: 'generated at build time' },
	{ frag: 'mint-acts.ts', why: 'cited BECAUSE it does not exist — the doc says "There is no mint-acts.ts script"' },
	{ frag: 'verify-xmr-viewkey.ts', why: 'cited in a section explicitly marked "(retired)"' },
	{ frag: '/usr/', why: 'a VPS filesystem path, not a repo path' },
	{ frag: '/etc/', why: 'a VPS filesystem path' },
	{ frag: '/var/', why: 'a VPS filesystem path' },
	{ frag: '/opt/', why: 'a VPS filesystem path' },
	{ frag: 'group_vars/', why: 'cited relative to ops/ansible/, resolved there' },
	{ frag: 'inventory/', why: 'cited relative to ops/ansible/' },
	{ frag: 'vault.yml', why: 'the operator creates this from vault.yml.example; it must NOT be in the repo' },
	{ frag: 'hosts.yml', why: 'the operator creates this from hosts.yml.example' },
	{ frag: '.env', why: 'operator-created from an example' },
	{ frag: 'morphit-canary-setup.sh', why: "Ken's local script, intentionally outside this repo" },
	{ frag: 'release.json', why: 'generated during the release ceremony' },
	{
		frag: 'keystore.json',
		why: "the relay keystore is created by the operator at setup and holds their signing key — it must NEVER be in the repo, so 'missing' is the correct state"
	}
];
const deadPaths: string[] = [];
for (const [doc, body] of text) {
	for (const m of body.matchAll(/`([a-zA-Z0-9_./@-]+\.(?:ts|mjs|js|sh|sql|json|svelte|yml|yaml))`/g)) {
		const p = m[1]!;
		if (PATH_ALLOW.some((a) => p.includes(a.frag))) continue;
		if (p.startsWith('@') || p.startsWith('http')) continue;
		// A bare filename is a reference BY NAME ("see config.ts"), not a claim
		// about location. Only something with a separator asserts a path, and only
		// a path can be wrong about where a file lives.
		if (!p.includes('/')) continue;
		// Resolve from the repo root, relative to the doc, OR as a SUFFIX of a real
		// file. The suffix case matters: docs legitimately shorten
		// `apps/web/src/lib/crypto/masterPassword.ts` to `crypto/masterPassword.ts`,
		// and that is a real reference to a real file. What suffix matching still
		// catches is a WRONG path — `apps/indexer/src/api/feeAttest.ts` matches no
		// file's tail, because the handler lives under src/indexer/handlers/.
		const cands = [join(ROOT, p), join(ROOT, dirname(doc), p)];
		if (cands.some((c) => existsSync(c))) continue;
		if (repoFiles.some((f) => f.endsWith('/' + p))) continue;
		deadPaths.push(`${doc}: \`${p}\``);
	}
}
check(
	'D-2 every repo path cited in a public doc resolves',
	deadPaths.length === 0,
	`cited but missing:\n      ${deadPaths.join('\n      ')}`
);

// ── D-3: npm scripts a doc tells you to run must exist ──────────────
const pkgScripts = new Set<string>();
const pkgs = ['package.json', 'apps/web/package.json', 'apps/indexer/package.json', 'apps/relay/package.json', 'apps/ops-cli/package.json', 'apps/mcp-server/package.json'];
for (const p of pkgs) {
	if (!existsSync(join(ROOT, p))) continue;
	const j = JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as { scripts?: Record<string, string> };
	for (const k of Object.keys(j.scripts ?? {})) pkgScripts.add(k);
}
const ghostScripts: string[] = [];
for (const [doc, body] of text) {
	for (const m of body.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
		const s = m[1]!;
		if (!pkgScripts.has(s)) ghostScripts.push(`${doc}: npm run ${s}`);
	}
}
check(
	'D-3 every `npm run` a public doc tells you to run exists',
	ghostScripts.length === 0,
	`no such script:\n      ${ghostScripts.join('\n      ')}`
);

// ── D-4: the front door's links resolve ─────────────────────────────
const hub = text.get('docs/start-here/README.md') ?? '';
const hubDead: string[] = [];
for (const m of hub.matchAll(/\]\((\.\.?\/[^)]+\.md)\)/g)) {
	const target = resolve(ROOT, 'docs/start-here', m[1]!);
	if (!existsSync(target)) hubDead.push(m[1]!);
}
check('D-4 every start-here hub link resolves', hubDead.length === 0, hubDead.join(', '));

// ── D-5: no contradicted version claim ──────────────────────────────
const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string })
	.version;
// Only CURRENT-version claims are pinned. "Upgrading past v1.3.5" is a historical
// fact about migration v39 and must NOT be rewritten every release — pinning bare
// version-shaped strings would force exactly that vandalism.
const versionClaims: string[] = [];
for (const [doc, body] of text) {
	// Must say Morphit AND use a v-prefix. Without both, this matched `127.0.0`
	// out of 127.0.0.1 and every library version in the file — noise that would
	// get the check muted, or worse, "fixed" by rewriting an IP address.
	for (const m of body.matchAll(
		/morphit[^\n]{0,50}?(?:current(?:ly)?|running|this release|latest)[^\n]{0,30}?\bv(\d+\.\d+\.\d+)/gi
	)) {
		if (m[1] !== version) versionClaims.push(`${doc}: claims v${m[1]}, package.json says ${version}`);
	}
}
check(
	'D-5 no public doc claims a current version other than package.json',
	versionClaims.length === 0,
	versionClaims.join('\n      ')
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} public-doc-drift checks passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} public-doc-drift checks FAILED`);
	process.exit(1);
}
