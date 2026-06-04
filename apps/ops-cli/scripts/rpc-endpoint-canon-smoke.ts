/**
 * rpc-endpoint-canon-smoke (beta5 item D).
 *
 * Pins the canonical Blurt RPC endpoint set (the single source of truth
 * in @morphit/operator-config) against the copies that CANNOT import it:
 *   - the frontend's DEFAULT_RPC_ENDPOINTS (browser bundle — can't pull
 *     in a node package), and
 *   - the env examples (ops/env/indexer.env.example,
 *     ops/env/relay.env.example).
 *
 * The node-side consumers (indexer config, relay config, ops-cli
 * chainCheck/chainErrors/steps) all import the constant directly, so
 * TypeScript already guarantees they can't drift; this smoke covers the
 * non-importing copies. Compared as SETS (order-independent — the pool
 * learns fastest-first), so a cosmetic reorder is fine but a different
 * endpoint set fails.
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

// ── frontend literal ────────────────────────────────────────────────
{
	const src = readFileSync(join(REPO, 'apps', 'web', 'src', 'lib', 'net', 'config.ts'), 'utf8');
	const m = /DEFAULT_RPC_ENDPOINTS[^=]*=\s*\[([\s\S]*?)\]/.exec(src);
	if (!m) {
		bad('could not find DEFAULT_RPC_ENDPOINTS in apps/web/src/lib/net/config.ts');
	} else {
		const urls = new Set(Array.from(m[1]!.matchAll(/'(https:\/\/[^']+)'/g)).map((x) => x[1]!));
		if (setEq(urls, canon)) ok('frontend DEFAULT_RPC_ENDPOINTS matches the canonical set');
		else bad('frontend DEFAULT_RPC_ENDPOINTS differs from canonical', `frontend=[${show(urls)}] canon=[${show(canon)}]`);
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
