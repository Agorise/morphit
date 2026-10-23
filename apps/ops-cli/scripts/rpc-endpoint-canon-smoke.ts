/**
 * rpc-endpoint-canon-smoke (beta5 item D).
 *
 * Pins the canonical Blurt RPC endpoint set (the single source of truth
 * in @morphit/operator-config) against the copies that CANNOT import it:
 *   - (the web app carries NO copy since v1.21.14: the browser contacts no
 *     RPC node; checked below)
 *   - the env examples (ops/env/indexer.env.example,
 *     ops/env/relay.env.example). These are SERVER-side (no CORS), so they
 *     stay set-EQUAL to canon.
 *
 * The node-side consumers (indexer config, relay config, ops-cli
 * chainCheck/chainErrors/steps) all import the constant directly, so
 * TypeScript already guarantees they can't drift; this smoke covers the
 * non-importing copies. Order-independent (the pool learns fastest-first),
 * so a cosmetic reorder is fine but a stray/missing endpoint fails.
 *
 * This is the guard that would have caught the beta5 firefight's root
 * config bug: the wizard's list contained a dead node and was missing
 * two endpoints the rest of the app used.
 *
 * That node is permanently offline and must never be referenced anywhere,
 * so this file spells it in parts (DEAD_HOST) and checks that no file in
 * the repository names it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, detail = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (detail) console.log(`      ${detail}`);
};

const canon = new Set(DEFAULT_BLURT_RPC_ENDPOINTS);
/** The decommissioned node, spelled in parts so this guard does not name it. */
const DEAD_HOST = ['rpc', 'blurt', 'world'].join('.');
const DEAD_RE = new RegExp(DEAD_HOST.replace(/\./g, '\\.'), 'i');
const setEq = (a: Set<string>, b: Set<string>) =>
	a.size === b.size && [...a].every((x) => b.has(x));
const show = (s: Iterable<string>) => [...s].sort().join(', ');

// ── canonical sanity ────────────────────────────────────────────────
if (DEFAULT_BLURT_RPC_ENDPOINTS.length >= 3) ok(`canonical set has ${DEFAULT_BLURT_RPC_ENDPOINTS.length} endpoints (>=3 for redundancy)`);
else bad('canonical set has fewer than 3 endpoints — too little RPC redundancy', show(canon));

if (DEFAULT_BLURT_RPC_ENDPOINTS.every((u) => u.startsWith('https://'))) ok('canonical endpoints are all https://');
else bad('a canonical endpoint is not https://', show(canon));

// Regression guard for the exact firefight artefact.
if (!DEFAULT_BLURT_RPC_ENDPOINTS.some((u) => DEAD_RE.test(u)))
	ok('canonical set does not contain the dead node (firefight regression)');
else bad('the dead node is back in the canonical set — it is permanently offline');

// ── the web app carries no node list ────────────────────────────────
// Since v1.21.14 the browser contacts no Blurt RPC node (every page's CSP is
// connect-src 'self'; the release check reads through the instance), so the
// web app must not carry a copy of the pool that could drift or be used.
{
	const src = readFileSync(join(REPO, 'apps', 'web', 'src', 'lib', 'net', 'config.ts'), 'utf8');
	const nodes = [...canon].filter((u) => src.includes(u.replace(/\/+$/, '')));
	if (nodes.length === 0) ok('the web app config names no Blurt RPC node');
	else bad('the web app config names Blurt RPC node(s) again', show(nodes));
}

// ── env examples ────────────────────────────────────────────────────
function envListVar(path: string, varName: string): Set<string> | null {
	const src = readFileSync(join(REPO, path), 'utf8');
	const line = src.split('\n').find((l) => l.startsWith(`${varName}=`));
	if (line === undefined) return null;
	const val = line.slice(varName.length + 1).trim();
	return new Set(
		val
			.split(',')
			.map((u) => u.trim())
			.filter((u) => u !== '')
	);
}

for (const [path, varName] of [
	['ops/env/indexer.env.example', 'MORPHIT_INDEXER_RPC_ENDPOINTS'],
	['ops/env/relay.env.example', 'MORPHIT_RELAY_BLURT_RPC']
] as const) {
	const urls = envListVar(path, varName);
	if (urls === null) {
		bad(`could not find ${varName} in ${path}`);
	} else if (setEq(urls, canon)) {
		ok(`${path} ${varName} matches the canonical set`);
	} else {
		bad(`${path} ${varName} differs from canonical`, `example=[${show(urls)}] canon=[${show(canon)}]`);
	}
}

// ── Ansible deploy defaults ─────────────────────────────────
// The env examples above were guarded, but the Ansible group_vars copy
// was NOT — and that is exactly where the dead node
// survived (group_vars/all.yml pinned the indexer to it as "primary",
// and the egress allowlist opened it while BLOCKING the real six). Pin
// the Ansible indexer-endpoint default to canon too, and keep the
// decommissioned node out of the whole file (endpoints AND allowlist).
function yamlScalarList(path: string, key: string): Set<string> | null {
	const src = readFileSync(join(REPO, path), 'utf8');
	const line = src.split('\n').find((l) => l.trimStart().startsWith(`${key}:`));
	if (line === undefined) return null;
	let val = line.slice(line.indexOf(':') + 1).trim();
	if (
		(val.startsWith('"') && val.endsWith('"')) ||
		(val.startsWith("'") && val.endsWith("'"))
	) {
		val = val.slice(1, -1);
	}
	return new Set(
		val
			.split(',')
			.map((u) => u.trim())
			.filter((u) => u !== '')
	);
}

{
	const ansiblePath = 'ops/ansible/group_vars/all.yml';
	const urls = yamlScalarList(ansiblePath, 'morphit_indexer_blurt_rpc_endpoints');
	if (urls === null) {
		bad(`could not find morphit_indexer_blurt_rpc_endpoints in ${ansiblePath}`);
	} else if (setEq(urls, canon)) {
		ok(`${ansiblePath} morphit_indexer_blurt_rpc_endpoints matches the canonical set`);
	} else {
		bad(
			`${ansiblePath} indexer RPC endpoints differ from canonical`,
			`ansible=[${show(urls)}] canon=[${show(canon)}]`
		);
	}

	const ay = readFileSync(join(REPO, ansiblePath), 'utf8');
	if (!DEAD_RE.test(ay)) {
		ok(`${ansiblePath} is free of the dead node (endpoints + egress allowlist)`);
	} else {
		bad(`the dead node reappeared in ${ansiblePath} — decommissioned; use the canonical set`);
	}
}

// ── verify-download.mjs (this copy rotted — it still pinned the
//    dead node and a downloader hit "could not reach the
//    chain" during the v1.8.15 ceremony). It's a standalone Node script
//    (no browser CORS), so its DEFAULT_RPCS must equal the WHOLE 6-node
//    canonical pool, and must never contain the decommissioned node. ──
{
	const src = readFileSync(join(REPO, 'scripts', 'verify-download.mjs'), 'utf8');
	const m = /DEFAULT_RPCS\s*=\s*\[([\s\S]*?)\]/.exec(src);
	if (!m) {
		bad('could not find DEFAULT_RPCS in scripts/verify-download.mjs');
	} else {
		const urls = new Set(Array.from(m[1]!.matchAll(/'(https:\/\/[^']+)'/g)).map((x) => x[1]!));
		if (setEq(urls, canon))
			ok('verify-download.mjs DEFAULT_RPCS === the full canonical pool');
		else
			bad(
				'verify-download.mjs DEFAULT_RPCS differs from the canonical pool',
				`script=[${show(urls)}] canon=[${show(canon)}]`
			);
	}
	if (!DEAD_RE.test(src))
		ok('verify-download.mjs is free of the dead node (list + usage + error suggestion)');
	else bad('the dead node reappeared in scripts/verify-download.mjs — decommissioned');
}

// ── no file anywhere names the dead node ─────────────────────────────
// Code, tests, fixtures, comments and docs alike: a fixture naming it is how
// it keeps coming back. (node_modules, build output and the private journal
// are not the repository's text.)
{
	const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.svelte-kit', 'private']);
	const hits: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			const st = statSync(p);
			if (st.isDirectory()) {
				if (!SKIP_DIRS.has(name)) walk(p);
			} else if (st.isFile() && st.size < 4 * 1024 * 1024 && !name.endsWith('.map')) {
				const text = readFileSync(p, 'latin1');
				if (DEAD_RE.test(text)) hits.push(p.slice(REPO.length + 1));
			}
		}
	};
	walk(REPO);
	if (hits.length === 0) ok('no file in the repository names the dead node');
	else bad('files still name the dead node (use a neutral host such as rpc.example.org)', hits.join(', '));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 rpc-endpoint-canon smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} rpc-endpoint-canon scenarios passed`);
