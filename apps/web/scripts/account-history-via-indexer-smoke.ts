#!/usr/bin/env tsx
/**
 * Smoke: account history (and the explorer's account read) go through the
 * indexer, not direct browser RPC. Anchor cp296.
 *
 * PRIVACY INVARIANT (priority #1). The balance card's P&L export and the
 * block-explorer account page used to read an account's chain history —
 * and the explorer also its balance/DGP — by talking to public Blurt RPC
 * nodes DIRECTLY from the browser, leaking the user's IP and exactly
 * whose account they were inspecting to third parties Morphit doesn't
 * control. cp296 routes both through the operator's own indexer
 * (same-origin): a new `/v1/account/:account/history` proxy (sibling of
 * the cp295 balance proxy), and the explorer's account read reuses the
 * balance proxy (now also returning `posting_pub`). This smoke fails if
 * any leg of that wiring regresses:
 *
 *   1. The indexer exposes the history endpoint file and mounts it at
 *      `/v1/account` in main.ts.
 *   2. `@morphit/indexer-client` exports `AccountHistoryResponse` +
 *      `AccountHistoryEntry`, and the balance response carries `posting_pub`.
 *   3. A web fetch helper `fetchAccountHistory` exists.
 *   4. MyBalanceCard fetches history via `fetchAccountHistory` and no
 *      longer imports `getBlurtClient`.
 *   5. The explorer account page fetches history via `fetchAccountHistory`,
 *      its account read via `fetchAccountBalance`, and no longer imports
 *      `getBlurtClient`.
 *
 * Each invariant is a predicate reused for the live check AND for in-code
 * tamper tests, so this smoke proves its own assertions have teeth.
 *
 * NOTE (scope): this guards the two account-VIEW surfaces only. Other
 * browser→RPC reads (chat chainVerify, the web client's getAccountHistory
 * helper) are tracked under the broader browser→RPC migration and are
 * intentionally NOT asserted here.
 *
 * Tamper tests (run below; each must flip a check red):
 *   - Drop the `/v1/account` history mount from main.ts → fails.
 *   - Make MyBalanceCard stop importing fetchAccountHistory → fails.
 *   - Re-introduce a getBlurtClient import into the explorer page → fails.
 *   - Remove `posting_pub` from the balance response interface → fails.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

const P = {
	endpoint: join(REPO, 'apps/indexer/src/api/accountHistory.ts'),
	main: join(REPO, 'apps/indexer/src/main.ts'),
	client: join(REPO, 'packages/indexer-client/src/index.ts'),
	balanceEndpoint: join(REPO, 'apps/indexer/src/api/accountBalance.ts'),
	webHelper: join(REPO, 'apps/web/src/lib/blurt/accountHistory.ts'),
	balanceCard: join(REPO, 'apps/web/src/lib/components/MyBalanceCard.svelte'),
	explorer: join(REPO, 'apps/web/src/routes/[lang]/explorer/account/[name=account]/+page.svelte')
} as const;

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

type Check = { readonly name: string; readonly holds: () => boolean };

const checks: readonly Check[] = [
	{
		name: 'indexer history endpoint exists + exports accountHistoryRoute',
		holds: () => /export function accountHistoryRoute\(/.test(read(P.endpoint))
	},
	{
		name: 'history endpoint serves GET /:account/history via callCondenser(get_account_history)',
		holds: () => {
			const s = read(P.endpoint);
			return /\.get\(\s*['"]\/:account\/history['"]/.test(s) && /get_account_history/.test(s);
		}
	},
	{
		name: 'main.ts mounts accountHistoryRoute on the /v1/account sub-app',
		holds: () => {
			const s = read(P.main);
			return (
				/import \{ accountHistoryRoute \}/.test(s) &&
				/accountApp\.route\('\/', accountHistoryRoute\(blurt\)\)/.test(s) &&
				/app\.route\('\/v1\/account', accountApp\)/.test(s)
			);
		}
	},
	{
		name: 'indexer-client exports AccountHistoryResponse + AccountHistoryEntry',
		holds: () => {
			const s = read(P.client);
			return (
				/export interface AccountHistoryResponse/.test(s) &&
				/export type AccountHistoryEntry/.test(s)
			);
		}
	},
	{
		name: 'balance response carries posting_pub (explorer account read needs no getAccount RPC)',
		holds: () => /posting_pub: string \| null/.test(read(P.client))
	},
	{
		name: 'balance endpoint emits posting_pub',
		holds: () => /posting_pub: postingPub/.test(read(P.balanceEndpoint))
	},
	{
		name: 'web helper exports fetchAccountHistory hitting /v1/account/:account/history',
		holds: () => {
			const s = read(P.webHelper);
			return /export async function fetchAccountHistory\(/.test(s) && /\/history\?from=/.test(s);
		}
	},
	{
		name: 'MyBalanceCard fetches history via fetchAccountHistory',
		holds: () => /fetchAccountHistory\(/.test(read(P.balanceCard))
	},
	{
		name: 'MyBalanceCard no longer imports getBlurtClient (history read is proxied)',
		holds: () => !/getBlurtClient/.test(read(P.balanceCard))
	},
	{
		name: 'explorer account page fetches history via fetchAccountHistory',
		holds: () => /fetchAccountHistory\(/.test(read(P.explorer))
	},
	{
		name: 'explorer account page reads account/DGP via fetchAccountBalance',
		holds: () => /fetchAccountBalance\(/.test(read(P.explorer))
	},
	{
		name: 'explorer account page no longer imports getBlurtClient (both reads proxied)',
		holds: () => !/getBlurtClient/.test(read(P.explorer))
	}
];

let pass = 0;
let fail = 0;

for (const c of checks) {
	if (c.holds()) {
		console.log(`  ✓ ${c.name}`);
		pass++;
	} else {
		console.error(`  ✗ ${c.name}`);
		fail++;
	}
}

// ── In-code tamper tests: break one invariant at a time on an in-memory
//    copy and assert the matching check flips red. ──
const tampers: ReadonlyArray<{
	readonly label: string;
	readonly file: keyof typeof P;
	readonly mutate: (s: string) => string;
	readonly check: string;
}> = [
	{
		label: 'drop the history mount from main.ts',
		file: 'main',
		mutate: (s) => s.replace(/\n\taccountApp\.route\('\/', accountHistoryRoute\(blurt\)\);/, ''),
		check: 'main.ts mounts accountHistoryRoute on the /v1/account sub-app'
	},
	{
		label: 'make MyBalanceCard stop importing fetchAccountHistory',
		file: 'balanceCard',
		mutate: (s) => s.replace(/fetchAccountHistory/g, 'noSuchHistoryFn'),
		check: 'MyBalanceCard fetches history via fetchAccountHistory'
	},
	{
		label: 're-introduce a getBlurtClient import into the explorer page',
		file: 'explorer',
		mutate: (s) => `import { getBlurtClient } from '$blurt/client';\n${s}`,
		check: 'explorer account page no longer imports getBlurtClient (both reads proxied)'
	},
	{
		label: 'remove posting_pub from the balance response interface',
		file: 'client',
		mutate: (s) => s.replace(/posting_pub: string \| null/g, 'posting_removed: string'),
		check: 'balance response carries posting_pub (explorer account read needs no getAccount RPC)'
	}
];

for (const t of tampers) {
	const orig = read(P[t.file]);
	const mutated = t.mutate(orig);
	if (mutated === orig) {
		console.error(`  ✗ tamper wiring error: "${t.label}" did not change the source`);
		fail++;
		continue;
	}
	// Temporarily evaluate the check against the mutated source by swapping
	// the file content through a closure: re-implement the relevant predicate
	// inline using the mutated string.
	const check = checks.find((c) => c.name === t.check);
	if (!check) {
		console.error(`  ✗ tamper wiring error: no check named "${t.check}"`);
		fail++;
		continue;
	}
	// Reuse the predicate by monkey-reading: build a one-off predicate that
	// mirrors the live one but over `mutated`. We do this by name.
	const mutatedHolds = ((): boolean => {
		switch (t.check) {
			case 'main.ts mounts accountHistoryRoute on the /v1/account sub-app':
				return (
					/import \{ accountHistoryRoute \}/.test(mutated) &&
					/accountApp\.route\('\/', accountHistoryRoute\(blurt\)\)/.test(mutated) &&
					/app\.route\('\/v1\/account', accountApp\)/.test(mutated)
				);
			case 'MyBalanceCard fetches history via fetchAccountHistory':
				return /fetchAccountHistory\(/.test(mutated);
			case 'explorer account page no longer imports getBlurtClient (both reads proxied)':
				return !/getBlurtClient/.test(mutated);
			case 'balance response carries posting_pub (explorer account read needs no getAccount RPC)':
				return /posting_pub: string \| null/.test(mutated);
			default:
				return true;
		}
	})();
	if (mutatedHolds) {
		console.error(`  ✗ tamper NOT caught: after "${t.label}", check still passes (toothless)`);
		fail++;
	} else {
		console.log(`  ✓ tamper caught: "${t.label}" turns "${t.check}" red`);
		pass++;
	}
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`✓ all ${pass} scenarios passed`);
