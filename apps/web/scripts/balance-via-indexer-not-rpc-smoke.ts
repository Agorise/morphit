#!/usr/bin/env tsx
/**
 * Smoke: the balance card reads via the indexer, not direct RPC. Anchor cp295.
 *
 * PRIVACY INVARIANT (priority #1). A browser fetching an account's
 * balance straight from public Blurt RPC nodes leaks the user's IP and
 * which account they're viewing to third-party operators. cp295 routes
 * that read through the operator's own indexer (same-origin), so the
 * third parties only ever see the indexer's server-side request. This
 * smoke fails if any leg of that wiring regresses:
 *
 *   1. The indexer exposes the balance endpoint file and mounts it at
 *      `/v1/account` in main.ts.
 *   2. `@morphit/indexer-client` exports the shared `AccountBalanceResponse`.
 *   3. A web fetch helper `fetchAccountBalance` exists.
 *   4. MyBalanceCard's balance refresh uses `fetchAccountBalance` — i.e.
 *      it does NOT load the balance straight off the blurt client.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Drop the `/v1/account` mount from main.ts → fails.
 *   - Make MyBalanceCard stop importing fetchAccountBalance → fails.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

let pass = 0;
let fail = 0;
const ok = (m: string): void => {
	console.log(`  ✓ ${m}`);
	pass++;
};
const bad = (m: string): void => {
	console.error(`  ✗ ${m}`);
	fail++;
};
const read = (rel: string): string => {
	const p = join(REPO, rel);
	return existsSync(p) ? readFileSync(p, 'utf-8') : '';
};

// 1. Endpoint exists + mounted.
const endpoint = read('apps/indexer/src/api/accountBalance.ts');
if (endpoint.includes('accountBalanceRoute') && /\/:account\/balance/.test(endpoint)) {
	ok('indexer endpoint accountBalance.ts defines GET /:account/balance');
} else {
	bad('indexer endpoint accountBalance.ts missing or lacks /:account/balance route');
}
const main = read('apps/indexer/src/main.ts');
if (main.includes('accountBalanceRoute') && main.includes("app.route('/v1/account'")) {
	ok('main.ts mounts the balance route at /v1/account');
} else {
	bad('main.ts does not mount accountBalanceRoute at /v1/account');
}

// 2. Shared response type.
const client = read('packages/indexer-client/src/index.ts');
if (/interface AccountBalanceResponse/.test(client)) {
	ok('indexer-client exports AccountBalanceResponse');
} else {
	bad('indexer-client missing AccountBalanceResponse');
}

// 3. Web fetch helper.
const helper = read('apps/web/src/lib/blurt/accountBalance.ts');
if (/export async function fetchAccountBalance/.test(helper) && helper.includes('/v1/account/')) {
	ok('web helper fetchAccountBalance fetches /v1/account/.../balance');
} else {
	bad('web helper fetchAccountBalance missing or wrong path');
}

// 4. MyBalanceCard uses the indexer helper for the balance read.
const card = read('apps/web/src/lib/components/MyBalanceCard.svelte');
const importsHelper = /import\s*\{\s*fetchAccountBalance\s*\}\s*from\s*'\$blurt\/accountBalance'/.test(card);
const callsHelper = /fetchAccountBalance\s*\(/.test(card);
if (importsHelper && callsHelper) {
	ok('MyBalanceCard reads balance via fetchAccountBalance (indexer), not direct RPC');
} else {
	bad('MyBalanceCard does not use fetchAccountBalance for the balance read');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log(`✓ all ${pass} scenarios passed`);
