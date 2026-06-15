/**
 * rpc-endpoint-canon-smoke (beta5 item D).
 *
 * Pins the canonical Blurt RPC endpoint set (the single source of truth
 * in @morphit/operator-config) against the copies that CANNOT import it:
 *   - the frontend's DEFAULT_RPC_ENDPOINTS (browser bundle — can't pull
 *     in a node package). cp268: this is now the browser-CORS-clean
 *     SUBSET of canon (a browser can only use nodes that return a valid
 *     single Access-Control-Allow-Origin), so it is checked as a non-empty
 *     SUBSET with no stray node, NOT set-equal.
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
 * config bug: the wizard's list contained `rpc.blurt.world` and was
 * missing two endpoints the rest of the app used.
 */

import { readFileSync } from 'node:fs';
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
const setEq = (a: Set<string>, b: Set<string>) =>
	a.size === b.size && [...a].every((x) => b.has(x));
const show = (s: Iterable<string>) => [...s].sort().join(', ');

// ── canonical sanity ────────────────────────────────────────────────
if (DEFAULT_BLURT_RPC_ENDPOINTS.length >= 3) ok(`canonical set has ${DEFAULT_BLURT_RPC_ENDPOINTS.length} endpoints (>=3 for redundancy)`);
else bad('canonical set has fewer than 3 endpoints — too little RPC redundancy', show(canon));

if (DEFAULT_BLURT_RPC_ENDPOINTS.every((u) => u.startsWith('https://'))) ok('canonical endpoints are all https://');
else bad('a canonical endpoint is not https://', show(canon));

// Regression guard for the exact firefight artefact.
if (!canon.has('https://rpc.blurt.world')) ok('canonical set does not contain the un-attributed rpc.blurt.world (firefight regression)');
else bad('rpc.blurt.world is back in the canonical set — confirm it is a real, attributed node first');

// ── frontend literal (browser-CORS-clean SUBSET of canon) ───────────
// cp268: the browser list is the CORS-clean SUBSET of the canonical
// pool — a browser can only use a node that returns a single valid
// Access-Control-Allow-Origin, and three canonical nodes fail browser
// CORS (beblurt double-value; blurt.one + dagobert missing header). So
// the frontend list is NOT set-equal to canon; it must be a non-empty
// subset with NO stray node (drift guard) + enough nodes for failover.
{
	const src = readFileSync(join(REPO, 'apps', 'web', 'src', 'lib', 'net', 'config.ts'), 'utf8');
	const m = /DEFAULT_RPC_ENDPOINTS[^=]*=\s*\[([\s\S]*?)\]/.exec(src);
	if (!m) {
		bad('could not find DEFAULT_RPC_ENDPOINTS in apps/web/src/lib/net/config.ts');
	} else {
		const urls = new Set(Array.from(m[1]!.matchAll(/'(https:\/\/[^']+)'/g)).map((x) => x[1]!));
		const stray = [...urls].filter((u) => !canon.has(u));
		if (stray.length === 0)
			ok('frontend DEFAULT_RPC_ENDPOINTS is a subset of the canonical pool (no stray node)');
		else
			bad(
				'frontend DEFAULT_RPC_ENDPOINTS contains node(s) not in the canonical pool',
				`stray=[${show(stray)}] canon=[${show(canon)}]`
			);
		if (urls.size >= 2) ok(`frontend browser pool has ${urls.size} endpoints (>=2 for failover)`);
		else bad('frontend browser pool has fewer than 2 endpoints — too little browser failover', show(urls));
		if ([...urls].every((u) => u.startsWith('https://'))) ok('frontend endpoints are all https://');
		else bad('a frontend endpoint is not https://', show(urls));
	}
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

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 rpc-endpoint-canon smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} rpc-endpoint-canon scenarios passed`);
