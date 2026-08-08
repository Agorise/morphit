#!/usr/bin/env tsx
/**
 * indexer-relay-account — cp673.
 *
 * `/v1/instance.relay_account` is served from `MORPHIT_INDEXER_RELAY_ACCOUNT`,
 * which DEFAULTS to the canonical `'morphit-relay'`. If an install writer leaves
 * it unset, a non-canonical instance advertises the wrong relay account and every
 * peer rejects its probe with `relay_account mismatch` (anti-impersonation).
 *
 * This is exactly what happened to the first federated instance (ansible install):
 * the ansible `indexer.env.j2` template set the operator tag + account name but
 * NOT the indexer relay account, so it fell back to `morphit-relay`.
 *
 * Invariant guarded here: every config writer that establishes the relay account
 * MUST also set `MORPHIT_INDEXER_RELAY_ACCOUNT` to that same account.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── indexer-relay-account (cp673) ──────────────────────\n');

// ── ansible: indexer.env.j2 must set it to the operator account ──
const ansibleIndexerEnv = read('ops/ansible/roles/morphit/templates/indexer.env.j2');
check(
	'ansible indexer.env.j2 sets MORPHIT_INDEXER_RELAY_ACCOUNT',
	/^MORPHIT_INDEXER_RELAY_ACCOUNT=/m.test(ansibleIndexerEnv),
	'unset → falls back to the canonical default morphit-relay → peer probes reject with relay_account mismatch'
);
check(
	'ansible indexer.env.j2 binds it to {{ morphit_operator_account }} (not a hardcoded/default value)',
	/^MORPHIT_INDEXER_RELAY_ACCOUNT=\{\{\s*morphit_operator_account\s*\}\}/m.test(ansibleIndexerEnv)
);
// it must match the account the relay/register side uses
const ansibleRelayEnv = read('ops/ansible/roles/morphit/templates/relay.env.j2');
const relayUsesOperatorAccount = /^MORPHIT_RELAY_ACCOUNT=\{\{\s*morphit_operator_account\s*\}\}/m.test(ansibleRelayEnv);
const indexerUsesOperatorAccount = /^MORPHIT_INDEXER_RELAY_ACCOUNT=\{\{\s*morphit_operator_account\s*\}\}/m.test(ansibleIndexerEnv);
check(
	'ansible indexer + relay relay-account bindings agree',
	!relayUsesOperatorAccount || indexerUsesOperatorAccount,
	'the indexer must advertise the same relay account the relay signs with'
);

// ── ops-cli wizard: render.ts must set it too ──
const render = read('apps/ops-cli/src/init/render.ts');
check(
	'ops-cli render.ts writes MORPHIT_INDEXER_RELAY_ACCOUNT',
	/MORPHIT_INDEXER_RELAY_ACCOUNT=/.test(render)
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} indexer-relay-account checks passed` : '✗ indexer-relay-account FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
