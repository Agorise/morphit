#!/usr/bin/env tsx
/*
 * asset-network-set-registry-parity — cp175 F-013 guard.
 *
 * The valid per-asset network allowlists for the multi-network assets
 * (USDT erc20/trc20/spl/bep20, USDC erc20/spl/base/polygon, DAI
 * erc20/polygon/base/arbitrum) are the canonical `supportedNetworks` in
 * @morphit/asset-registry. But the indexer HARDCODES them as
 * `USDT/USDC/DAI_NETWORKS_VALID` Sets in BOTH order.ts AND orderReplace.ts
 * (three copies total counting the registry).
 *
 * F-013: there was no guard tying the handler Sets to the registry. If someone
 * adds a network to the registry's supportedNetworks (e.g. a new USDC chain),
 * the indexer would keep its stale Set and SILENTLY REJECT orders on the new
 * network with `asset_network_unknown` — a confusing partial rollout where the
 * frontend offers a network the indexer refuses.
 *
 * This sentinel asserts every handler Set equals the registry's
 * supportedNetworks (as a SET — order-independent) for USDT/USDC/DAI.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSETS } from '@morphit/asset-registry';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

let pass = 0;
let fail = 0;
function ok(name: string): void {
	console.log(`  ✓ ${name}`);
	pass++;
}
function bad(name: string, detail: string): void {
	console.log(`  ✗ ${name}: ${detail}`);
	fail++;
}

console.log('\n── asset-network-set-registry-parity (cp175 F-013 guard) ──\n');

// Registry truth: supportedNetworks for each multi-network asset, as sorted arrays.
function registryNetworks(ticker: string): string[] {
	const a = ASSETS.find((x) => x.ticker === ticker || x.displayTicker === ticker);
	if (!a) throw new Error(`registry has no asset '${ticker}'`);
	return [...a.supportedNetworks].sort();
}

// Extract a `const NAME_NETWORKS_VALID = new Set([...])` literal from a handler file.
function handlerSet(file: string, varName: string): string[] | null {
	const src = readFileSync(resolve(SRC, file), 'utf8');
	const re = new RegExp(`${varName}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`);
	const m = re.exec(src);
	if (!m) return null;
	return (m[1] ?? '')
		.split(',')
		.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
		.filter((s) => s.length > 0)
		.sort();
}

const ASSET_VARS: Array<{ ticker: string; varName: string }> = [
	{ ticker: 'USDT', varName: 'USDT_NETWORKS_VALID' },
	{ ticker: 'USDC', varName: 'USDC_NETWORKS_VALID' },
	{ ticker: 'DAI', varName: 'DAI_NETWORKS_VALID' }
];
const HANDLER_FILES = ['indexer/handlers/order.ts', 'indexer/handlers/orderReplace.ts'];

const eq = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

for (const file of HANDLER_FILES) {
	for (const { ticker, varName } of ASSET_VARS) {
		const hset = handlerSet(file, varName);
		const reg = registryNetworks(ticker);
		if (hset === null) {
			bad(`${file} :: ${varName}`, 'set literal not found — handler refactored? update this sentinel.');
			continue;
		}
		if (eq(hset, reg)) {
			ok(`${file} :: ${varName} = registry ${ticker} supportedNetworks [${reg.join(',')}]`);
		} else {
			bad(
				`${file} :: ${varName}`,
				`handler has [${hset.join(',')}] but registry ${ticker}.supportedNetworks is [${reg.join(',')}] — drift (see cp175 F-013)`
			);
		}
	}
}

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
