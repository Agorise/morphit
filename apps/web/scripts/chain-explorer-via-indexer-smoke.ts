#!/usr/bin/env tsx
/**
 * Smoke: the block-explorer's block + transaction reads go through the
 * indexer, not direct browser RPC. Anchor cp296.
 *
 * PRIVACY INVARIANT (priority #1). The explorer's block and tx pages used
 * to call Blurt `get_block` / `get_transaction` straight from the browser,
 * leaking the user's IP and which block/tx they inspected. cp296 routes
 * both through `/v1/chain/block/:num` and `/v1/chain/tx/:id` on the
 * operator's own indexer (same-origin), siblings of the balance/account/
 * history proxies. With the account-page migration (separate smoke), the
 * ENTIRE block explorer is now RPC-free from the browser. This smoke
 * fails if any leg regresses.
 *
 * Tamper tests (each must flip a check red):
 *   - Drop the /v1/chain mount from main.ts → fails.
 *   - Re-introduce a getBlurtClient import into the block page → fails.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

const P = {
	endpoint: join(REPO, 'apps/indexer/src/api/chainExplorer.ts'),
	main: join(REPO, 'apps/indexer/src/main.ts'),
	client: join(REPO, 'packages/indexer-client/src/index.ts'),
	webHelper: join(REPO, 'apps/web/src/lib/blurt/chainExplorer.ts'),
	blockPage: join(REPO, 'apps/web/src/routes/[lang]/explorer/block/[num=blocknum]/+page.svelte'),
	txPage: join(REPO, 'apps/web/src/routes/[lang]/explorer/tx/[id=trxid]/+page.svelte')
} as const;

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

type Check = { readonly name: string; readonly holds: (s?: string) => boolean };

const checks: readonly Check[] = [
	{
		name: 'indexer chain endpoint exports chainExplorerRoute serving /block/:num + /tx/:id',
		holds: () => {
			const s = read(P.endpoint);
			return (
				/export function chainExplorerRoute\(/.test(s) &&
				/\.get\(\s*['"]\/block\/:num['"]/.test(s) &&
				/\.get\(\s*['"]\/tx\/:id['"]/.test(s) &&
				/get_block/.test(s) &&
				/get_transaction/.test(s)
			);
		}
	},
	{
		name: 'main.ts mounts the chain explorer routes at /v1/chain (cp347: via a rate-limited sub-app)',
		holds: () => {
			const s = read(P.main);
			return (
				/import \{ chainExplorerRoute \}/.test(s) &&
				/chainApp\.route\('\/', chainExplorerRoute\(blurt\)\)/.test(s) &&
				/app\.route\('\/v1\/chain', chainApp\)/.test(s)
			);
		}
	},
	{
		name: 'indexer-client exports ChainBlockResponse + ChainTxResponse',
		holds: () => {
			const s = read(P.client);
			return /export interface ChainBlockResponse/.test(s) && /export interface ChainTxResponse/.test(s);
		}
	},
	{
		name: 'web helper exports fetchChainBlock + fetchChainTx',
		holds: () => {
			const s = read(P.webHelper);
			return /export async function fetchChainBlock\(/.test(s) && /export async function fetchChainTx\(/.test(s);
		}
	},
	{
		name: 'explorer block page uses fetchChainBlock and no getBlurtClient',
		holds: () => {
			const s = read(P.blockPage);
			return /fetchChainBlock\(/.test(s) && !/getBlurtClient/.test(s);
		}
	},
	{
		name: 'explorer tx page uses fetchChainTx and no getBlurtClient',
		holds: () => {
			const s = read(P.txPage);
			return /fetchChainTx\(/.test(s) && !/getBlurtClient/.test(s);
		}
	}
];

let pass = 0;
let fail = 0;
for (const c of checks) {
	if (c.holds()) {
		console.log(`  \u2713 ${c.name}`);
		pass++;
	} else {
		console.error(`  \u2717 ${c.name}`);
		fail++;
	}
}

// ── Tamper tests ──
{
	const mutated = read(P.main).replace(/\n\tchainApp\.route\('\/', chainExplorerRoute\(blurt\)\);/, '');
	const stillOk = /chainApp\.route\('\/', chainExplorerRoute\(blurt\)\)/.test(mutated);
	if (mutated === read(P.main)) {
		console.error('  \u2717 tamper wiring error: could not drop the /v1/chain mount');
		fail++;
	} else if (stillOk) {
		console.error('  \u2717 tamper NOT caught: dropping /v1/chain mount still passes (toothless)');
		fail++;
	} else {
		console.log('  \u2713 tamper caught: dropping the /v1/chain mount turns the mount check red');
		pass++;
	}
}
{
	const mutated = `import { getBlurtClient } from '$blurt/client';\n${read(P.blockPage)}`;
	const stillOk = /fetchChainBlock\(/.test(mutated) && !/getBlurtClient/.test(mutated);
	if (stillOk) {
		console.error('  \u2717 tamper NOT caught: re-adding getBlurtClient to the block page still passes (toothless)');
		fail++;
	} else {
		console.log('  \u2713 tamper caught: re-adding getBlurtClient to the block page turns its check red');
		pass++;
	}
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`\u2713 all ${pass} scenarios passed`);
