#!/usr/bin/env tsx
/**
 * scripts/public-claims-truth-smoke.ts
 *
 * Public claims must match the code. Two kinds of check:
 *
 * 1. Retired overclaims. The 2026-10 audit found public text that the code
 *    did not back up: "rogue nodes can't forge it", "fully anonymous",
 *    "onion-only" for a node that is Tor AND I2P, "no logging", a removed
 *    `/v1/operators/:tag` route, a `PREFER_NATIVE` lever that never had an
 *    effect, a `/security-credits` page that no longer exists, and so on.
 *    None of those phrases may come back in the public docs, the READMEs,
 *    the claims list or the English UI strings.
 *
 * 2. Numbers tied to code. Where the claims list or the FAQ states a count
 *    (RPC nodes per network, Monero sources, the fee quorum, featured slots,
 *    the soft-close window), the number must equal the constant it
 *    describes. Change one without the other and this fails.
 *
 * The scanned set excludes release notes and the ADRs, which record history.
 * (The internal journals are not in the public tree: private/ is gitignored.)
 *
 * Usage: tsx scripts/public-claims-truth-smoke.ts [--root <repo>]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.indexOf('--root');
const ROOT =
	rootArg > 0 && process.argv[rootArg + 1]
		? resolve(process.argv[rootArg + 1]!)
		: resolve(HERE, '..');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

function read(rel: string): string {
	const p = join(ROOT, rel);
	return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function walk(dir: string, out: string[]): void {
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name.startsWith('.')) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (name.endsWith('.md')) out.push(relative(ROOT, p));
	}
}

const JOURNAL = /^RELEASE-NOTES/;

function publicFiles(): string[] {
	const out: string[] = [];
	for (const f of ['README.md', 'SECURITY.md', 'MORPHIT-BRAG-LIST.md', 'THIRD-PARTY-LICENSES.md']) {
		if (existsSync(join(ROOT, f))) out.push(f);
	}
	const docs: string[] = [];
	walk(join(ROOT, 'docs'), docs);
	for (const f of docs) {
		const base = f.split('/').pop() ?? '';
		if (f.startsWith('docs/adr/') || JOURNAL.test(base)) continue;
		out.push(f);
	}
	for (const top of ['apps', 'packages']) {
		const dir = join(ROOT, top);
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			const readme = join(top, name, 'README.md');
			if (existsSync(join(ROOT, readme))) out.push(readme);
		}
	}
	walk(join(ROOT, 'ops'), out);
	out.push('apps/web/src/lib/i18n/locales/en.json');
	return out;
}

// ── 1. retired overclaims ──────────────────────────────────────────
interface Banned {
	id: string;
	re: RegExp;
	why: string;
	/** Files where the phrase is allowed (e.g. the threat model recording history). */
	allow?: RegExp;
	/** When set, only these files are checked. */
	only?: RegExp;
}
const BANNED: Banned[] = [
	{
		id: 'rogue-nodes-cant-forge',
		re: /rogue nodes? can'?t forge/i,
		why: 'a node can make the release check fail; say what the check proves, not that forging is impossible'
	},
	{
		id: 'fully-anonymous',
		re: /fully anonymous/i,
		why: 'no instance is fully anonymous; say what is hidden from whom'
	},
	{
		id: 'onion-only',
		re: /onion-only/i,
		why: 'zero-clearnet instances serve Tor AND I2P; say "zero-clearnet" or "hidden-only"'
	},
	{
		id: 'no-logging',
		re: /\bno logging\b/i,
		why: 'services log events; the true claim is "no access logs"'
	},
	{ id: 'counterparty-free', re: /counterparty-free/i, why: 'every trade has a counterparty' },
	{
		id: 'untraceable',
		re: /\buntraceable\b/i,
		why: 'public-chain metadata is traceable; see METADATA-LEAK-CATALOG.md'
	},
	{
		id: 'never-exposes-ip',
		re: /never (?:exposes|reveals|leaks|shares) (?:your |the |a )?(?:visitor'?s? )?IP/i,
		why: 'the instance and the release-check nodes see the visitor IP on clearnet'
	},
	{
		id: 'operators-tag-route',
		re: /\/v1\/operators\/:tag/,
		why: 'there is no per-tag operators route; /v1/operators lists them all'
	},
	{
		id: 'prefer-native-lever',
		re: /PREFER_NATIVE/,
		why: 'the price lever never had an effect and was removed',
		allow: /^docs\/audit\//
	},
	{ id: 'security-credits-page', re: /security-credits/i, why: 'the credits page was removed' },
	{
		id: 'security-email',
		re: /security@[a-z0-9.-]+\.[a-z]/i,
		why: 'the only private disclosure channel is a Matrix DM to @agorise:matrix.org'
	},
	// Spelled with a character class so the forge-name smoke does not flag this rule.
	{ id: 'old-forge-name', re: /\bGit[e]a\b/, why: 'the forge is Forgejo' },
	{ id: 'rpc-blurt-world', re: /rpc\.blurt\.world/i, why: 'that node is gone' },
	{
		id: 'keystore-xchacha',
		re: /XChaCha20/i,
		why: 'the browser keystore is Argon2id + XSalsa20-Poly1305; chat uses ChaCha20-Poly1305-IETF'
	},
	{
		id: 'forward-secrecy-claim',
		re: /(?:provides?|with|offers?|gives?) (?:perfect )?forward secrecy/i,
		why: 'chat has no forward secrecy in either mode'
	},
	{
		id: 'rpc-operators-independent',
		re: /independent (?:RPC |blockchain |node )(?:operators|servers)|independent (?:Blurt |RPC )?nodes|(?:nodes?|RPC)[^.\n]{0,30}different operators|different operators[^.\n]{0,30}(?:nodes?|RPC)|another operator'?s node|node of another operator|second operator'?s node/i,
		why: 'RPC operators are counted by node name and the default hidden nodes are run by the project; do not promise independence (the signature is the check)'
	},
	{
		id: 'in-page-check-vs-operator',
		re: /independent of the operator'?s word|if both match, trust/i,
		why: 'the in-page integrity check cannot catch an operator who serves altered code'
	},
	{
		id: 'consistency-sample-as-filter',
		re: /agree before trusting it|confirms they agree before/i,
		why: 'the chain-consistency sample is an alarm, not a filter'
	},
	{
		id: 'unsigned-never-published',
		re: /never published unsigned|nothing is published unsigned|every release (?:tarball )?carries (?:a |its )?(?:detached )?(?:GPG )?signature/i,
		why: 'a release is published without .asc files when CI holds no signing key; nodes then install it by the on-chain SHA-256'
	},
	{
		id: 'custom-rpc-setting',
		re: /node a user adds in Settings/i,
		why: 'the custom RPC endpoint setting was removed'
	},
	{
		id: 'use-owner-key',
		re: /useOwnerKey/,
		why: 'no such function exists; the app never signs with the owner key'
	},
	{
		id: 'threat-model-process-notes',
		re: /\bstream [A-H]\b|\(blocker\b|\bfiled to\b|git history keeps|project journals|rewrite at install and upgrade is still open|refuses? (?:the )?`?0640/i,
		why: 'the threat model states the code, not the fix process or where old data lives',
		only: /^docs\/audit\//
	}
];

const files = publicFiles();
console.log(`public-claims-truth smoke (root: ${ROOT}, ${files.length} files)\n`);
console.log('1. retired overclaims');
for (const b of BANNED) {
	const hits: string[] = [];
	for (const f of files) {
		if (b.allow?.test(f)) continue;
		if (b.only && !b.only.test(f)) continue;
		const text = read(f);
		for (const m of text.matchAll(
			new RegExp(b.re.source, b.re.flags.includes('g') ? b.re.flags : b.re.flags + 'g')
		)) {
			const line = text.slice(0, m.index ?? 0).split('\n').length;
			hits.push(`${f}:${line}`);
		}
	}
	check(`1.${b.id} absent`, hits.length === 0, `${hits.slice(0, 6).join(', ')} — ${b.why}`);
}

// ── 2. numbers tied to code ────────────────────────────────────────
const WORDS: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10
};
function num(s: string | undefined): number | null {
	if (s === undefined) return null;
	const k = s.toLowerCase();
	if (k in WORDS) return WORDS[k]!;
	return /^\d+$/.test(k) ? Number(k) : null;
}

/** Number of string literals in `export const NAME: readonly string[] = [ … ];`. */
function arrayCount(rel: string, name: string): string[] | null {
	const src = read(rel);
	const m = src.match(
		new RegExp(
			`export const ${name}\\s*:\\s*readonly string\\[\\]\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as const)?\\s*;`
		)
	);
	if (!m) return null;
	// Drop whole-line and block comments; a `//` inside a URL literal stays.
	const body = m[1]!.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
	return [...body.matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2] ?? '');
}
function constNum(rel: string, name: string): number | null {
	const m = read(rel).match(new RegExp(`const ${name}\\s*=\\s*(\\d+)\\s*;`));
	return m ? Number(m[1]) : null;
}

/** Every number a pattern captures in `text`; fails when the phrase is gone. */
function claimEquals(
	id: string,
	text: string,
	re: RegExp,
	expected: number | null,
	where: string
): void {
	const found = [
		...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))
	].map((m) => num(m[1]));
	if (expected === null) {
		check(
			id,
			false,
			`the code constant for this claim was not found (${where}) — update this smoke with the code`
		);
		return;
	}
	if (found.length === 0) {
		check(
			id,
			false,
			`claim phrase ${re} not found in ${where} — if the claim was reworded, update this smoke`
		);
		return;
	}
	const wrong = found.filter((n) => n !== expected);
	check(id, wrong.length === 0, `${where} says ${found.join(', ')}; the code says ${expected}`);
}

console.log('\n2. numbers tied to code');

const brag = read('MORPHIT-BRAG-LIST.md');
let faq = '';
try {
	const en = JSON.parse(read('apps/web/src/lib/i18n/locales/en.json')) as {
		faq?: { entries?: Record<string, { a?: string }> };
	};
	faq = en.faq?.entries?.ip_address_and_rpc_nodes?.a ?? '';
} catch {
	faq = '';
}

const NET = 'apps/web/src/lib/net/config.ts';
claimEquals(
	'2.faq clearnet release-check nodes',
	faq,
	/the (one|two|three|four|five|six|seven|eight|nine|ten|\d+) public clearnet nodes/i,
	arrayCount(NET, 'DEFAULT_RPC_ENDPOINTS')?.length ?? null,
	'FAQ ip_address_and_rpc_nodes'
);
claimEquals(
	'2.faq onion release-check nodes',
	faq,
	/only the (one|two|three|four|five|six|seven|eight|nine|ten|\d+) \.onion nodes/i,
	arrayCount(NET, 'DEFAULT_HIDDEN_RPC_ENDPOINTS')?.length ?? null,
	'FAQ ip_address_and_rpc_nodes'
);
claimEquals(
	'2.faq I2P release-check nodes',
	faq,
	/only the (one|two|three|four|five|six|seven|eight|nine|ten|\d+) \.b32\.i2p nodes/i,
	arrayCount(NET, 'DEFAULT_I2P_RPC_ENDPOINTS')?.length ?? null,
	'FAQ ip_address_and_rpc_nodes'
);

// The default fee-source lists live in ONE place (operator-config feeSources.ts):
// the XMR default is the onion explorers, then the clearnet sources.
const FEE_SOURCES = 'packages/operator-config/src/feeSources.ts';
const listOf = (...names: string[]): string[] | null => {
	const parts = names.map((n) => arrayCount(FEE_SOURCES, n));
	return parts.every((p) => p !== null) ? parts.flatMap((p) => p!) : null;
};
const XMR = listOf('DEFAULT_XMR_ONION_EXPLORERS', 'DEFAULT_XMR_CLEARNET_EXPLORERS');
const BTC_FEE = listOf('DEFAULT_BTC_ONION_EXPLORERS', 'DEFAULT_BTC_CLEARNET_EXPLORERS');
const PRICENODES = listOf('DEFAULT_PRICENODES');
const ops = read('docs/OPERATIONS.md');
claimEquals(
	'2.ops BTC fee explorer count',
	ops,
	/\*\*BTC\*\* \(`MORPHIT_INDEXER_BTC_EXPLORER_URLS`, (\d+) by default\)/,
	BTC_FEE?.length ?? null,
	'docs/OPERATIONS.md §40.4a'
);
claimEquals(
	'2.ops XMR fee source count',
	ops,
	/\*\*XMR\*\* \(`MORPHIT_INDEXER_XMR_EXPLORER_URLS`, (\d+) by default\)/,
	XMR?.length ?? null,
	'docs/OPERATIONS.md §40.4a'
);
claimEquals(
	'2.ops pricenode count',
	ops,
	/\*\*Prices\*\* \(`MORPHIT_INDEXER_PRICENODE_URLS`, (\d+) by default\)/,
	PRICENODES?.length ?? null,
	'docs/OPERATIONS.md §40.4a'
);
const xmrNodes = XMR ? XMR.filter((u) => u.startsWith('node+')).length : null;
const xmrExplorers = XMR ? XMR.length - (xmrNodes ?? 0) : null;
claimEquals(
	'2.brag Monero source count',
	brag,
	/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+) independent (?:Monero )?sources/i,
	XMR?.length ?? null,
	'MORPHIT-BRAG-LIST.md'
);
claimEquals(
	'2.brag Monero source count (default-list form)',
	brag,
	/default list of (one|two|three|four|five|six|seven|eight|nine|ten|\d+) XMR sources/i,
	XMR?.length ?? null,
	'MORPHIT-BRAG-LIST.md'
);
claimEquals(
	'2.brag Monero explorer count',
	brag,
	/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+) (?:Monero )?explorers\b/i,
	xmrExplorers,
	'MORPHIT-BRAG-LIST.md'
);
claimEquals(
	'2.brag Monero node count',
	brag,
	/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+) public Monero nodes/i,
	xmrNodes,
	'MORPHIT-BRAG-LIST.md'
);
const QUORUM = constNum('apps/indexer/src/config/index.ts', 'DEFAULT_XMR_MIN_SUCCESSFUL_RESPONSES');
claimEquals(
	'2.brag fee quorum ("must agree")',
	brag,
	/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+) must agree by default/i,
	QUORUM,
	'MORPHIT-BRAG-LIST.md'
);
claimEquals(
	'2.brag fee quorum ("default is")',
	brag,
	/The default is (\d+), over a default list/i,
	QUORUM,
	'MORPHIT-BRAG-LIST.md'
);

const BID = 'apps/indexer/src/indexer/handlers/featureBid.ts';
claimEquals(
	'2.brag featured slots',
	brag,
	/expiring top-(\d+) bid/i,
	constNum(BID, 'MAX_SLOTS_VISIBLE'),
	'MORPHIT-BRAG-LIST.md'
);
claimEquals(
	'2.brag soft-close window',
	brag,
	/arrives in the last (\d+) minutes/i,
	constNum(BID, 'SNIPE_EXTENSION_MINUTES'),
	'MORPHIT-BRAG-LIST.md'
);
claimEquals(
	'2.brag soft-close cap',
	brag,
	/capped at (\d+) extensions/i,
	constNum(BID, 'MAX_EXTENSIONS'),
	'MORPHIT-BRAG-LIST.md'
);

/** "More than N" claims: N must be a true floor of the code's count and close
 *  enough to it (within `slack`) to stay meaningful. */
function claimFloor(
	id: string,
	text: string,
	re: RegExp,
	actual: number | null,
	slack: number,
	where: string
): void {
	const found = [
		...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))
	].map((m) => num(m[1]));
	if (actual === null) {
		check(id, false, `the count in the code was not found (${where}) — update this smoke`);
		return;
	}
	if (found.length === 0) {
		check(
			id,
			false,
			`claim phrase ${re} not found in ${where} — if the claim was reworded, update this smoke`
		);
		return;
	}
	const wrong = found.filter((n) => n === null || n >= actual || n < actual - slack);
	check(
		id,
		wrong.length === 0,
		`${where} says more than ${found.join(', ')}; the code has ${actual} (the floor must be below it and within ${slack})`
	);
}

/** Entries of the SMOKES=( … ) array in scripts/run-smokes.sh. */
function smokeCount(): number | null {
	const src = read('scripts/run-smokes.sh');
	const m = src.match(/^SMOKES=\(\n([\s\S]*?)^\)/m);
	if (!m) return null;
	return m[1]!.split('\n').filter((l) => /^\s*"[^"]+"\s*$/.test(l)).length;
}
const SMOKES = smokeCount();
claimFloor(
	'2.brag smoke runners',
	brag,
	/More than (\d+) smoke runners/i,
	SMOKES,
	100,
	'MORPHIT-BRAG-LIST.md'
);
claimFloor(
	'2.README smoke runners',
	read('README.md'),
	/more than (\d+) runners/i,
	SMOKES,
	100,
	'README.md'
);

const docsDir: string[] = [];
walk(join(ROOT, 'docs'), docsDir);
const DOC_COUNT = docsDir.filter((f) => !f.startsWith('docs/adr/')).length;
claimFloor(
	'2.brag design documents',
	brag,
	/More than (\d+) design and operations documents/i,
	DOC_COUNT,
	10,
	'MORPHIT-BRAG-LIST.md'
);

/** Entries with a `key:` field inside `export const NAME … = [ … ];`. */
function keyedEntries(rel: string, name: string): string[] | null {
	const m = read(rel).match(
		new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\](?: as const)?;`)
	);
	if (!m) return null;
	return [...m[1]!.matchAll(/^\s+key: '([^']+)'/gm)].map((x) => x[1]!);
}
const PAY = keyedEntries('apps/web/src/lib/payments/registry.ts', 'PAYMENT_METHODS');
claimFloor(
	'2.brag payment methods',
	brag,
	/more than (\d+) payment methods/i,
	PAY?.length ?? null,
	20,
	'MORPHIT-BRAG-LIST.md'
);
const CARRIERS = keyedEntries('apps/web/src/lib/shipping/carriers.ts', 'CARRIERS');
claimEquals(
	'2.brag bundled carriers',
	brag,
	/Top (\d+) worldwide carriers/i,
	CARRIERS ? CARRIERS.filter((k) => k !== 'other').length : null,
	'MORPHIT-BRAG-LIST.md'
);
const relayCfg = read('apps/relay/src/config/index.ts').match(
	/maxRequestBodyBytes:\s*(\d+)\s*\*\s*1024/
);
claimEquals(
	'2.brag relay body cap',
	brag,
	/(\d+) KiB on the relay/i,
	relayCfg ? Number(relayCfg[1]) : null,
	'MORPHIT-BRAG-LIST.md'
);
const idxCap = read('apps/indexer/src/config/index.ts').match(
	/MORPHIT_INDEXER_MAX_BODY_BYTES:[^\n]*\.default\((\d+)\)/
);
claimEquals(
	'2.brag indexer body cap',
	brag,
	/(\d+) KiB by default on the indexer/i,
	idxCap ? Number(idxCap[1]) / 1024 : null,
	'MORPHIT-BRAG-LIST.md'
);

console.log('');
if (fail === 0) console.log(`✓ all ${pass} public-claims-truth checks passed`);
else {
	console.error(`✗ ${fail} of ${pass + fail} public-claims-truth checks FAILED`);
	process.exit(1);
}
