/**
 * local-block-smoke (beta5).
 *
 * Unit-tests the PURE core of instance-local blocking: planLocalBlock
 * (the insert/reblock/amend/unblock/noop state machine) and
 * normalizeAccount. The DB write path (applyLocalBlock) + the listing-
 * query enforcement are exercised against a real Postgres separately.
 */

import { planLocalBlock, normalizeAccount } from '../src/lib/localBlock.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const opsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel: string): string => readFileSync(join(opsRoot, 'src', rel), 'utf8');

let pass = 0;
let fail = 0;
const expect = (n: string, c: boolean, d = '') => {
	if (c) {
		pass++;
		console.log(`  \u2713 ${n}`);
	} else {
		fail++;
		console.log(`  \u2717 ${n}`);
		if (d) console.log(`      ${d}`);
	}
};

// normalizeAccount
expect('normalize: strips @ + lowercases', normalizeAccount('@Alice') === 'alice');
expect('normalize: accepts dotted/hyphen names', normalizeAccount('foo.bar-baz') === 'foo.bar-baz');
expect('normalize: rejects spaces/symbols', normalizeAccount('BAD NAME!') === null);
expect('normalize: rejects too short', normalizeAccount('ab') === null);
expect('normalize: rejects leading digit', normalizeAccount('1abc') === null);

const plan = (
	action: 'block' | 'unblock',
	currentState: 'blocked' | 'unblocked' | null,
	currentReason: string | null = null,
	reason = ''
) => planLocalBlock({ action, account: 'alice', reason, currentState, currentReason }).op;

// block transitions
expect('block + no row → insert', plan('block', null) === 'insert');
expect('block + unblocked → reblock', plan('block', 'unblocked') === 'reblock');
expect('block + blocked, same reason → noop', plan('block', 'blocked', 'spam', 'spam') === 'noop');
expect('block + blocked, new reason → amend', plan('block', 'blocked', 'spam', 'fraud') === 'amend');

// unblock transitions
expect('unblock + blocked → unblock', plan('unblock', 'blocked') === 'unblock');
expect('unblock + unblocked → noop', plan('unblock', 'unblocked') === 'noop');
expect('unblock + no row → noop', plan('unblock', null) === 'noop');

// ── cp258 — operator_blocks key guard ───────────────────────────────
// All ops-cli block writes/reads MUST be keyed by the per-instance
// operatorAccount (== the indexer's operatorAccountName, == the on-chain
// block handler's gate), NOT officialAccount (the federation-wide
// release-signer). Using officialAccount silently made every ops-cli
// block inert for any instance with a separate
// MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME. This static guard pins the fix.
{
	const blockSrc = readSrc('commands/block.ts');
	const modSrc = readSrc('commands/moderation.ts');
	const menuSrc = readSrc('lib/menuAnnotations.ts');
	const cfgSrc = readSrc('config.ts');

	expect(
		'block.ts keys the block on ctx.config.operatorAccount',
		/const\s+operator\s*=\s*ctx\.config\.operatorAccount\b/.test(blockSrc),
		'morphit-ops block must write operator_blocks under operatorAccount'
	);
	expect(
		'block.ts does NOT key the block on officialAccount',
		!/ctx\.config\.officialAccount\b/.test(blockSrc),
		'officialAccount is the release-signer, not the operator_blocks key'
	);
	expect(
		'moderation.ts reads block statuses by ctx.config.operatorAccount',
		/const\s+operator\s*=\s*ctx\.config\.operatorAccount\b/.test(modSrc) &&
			!/ctx\.config\.officialAccount\b/.test(modSrc),
		'the moderation dashboard must look up blocks under the operator account'
	);
	expect(
		'menuAnnotations.ts binds config.operatorAccount in its operator_blocks SQL',
		/config\.operatorAccount\b/.test(menuSrc) && !/config\.officialAccount\b/.test(menuSrc),
		'the menu suspicious-flag count excludes operator-blocked accounts by operatorAccount'
	);
	expect(
		'config.ts declares a required operatorAccount field',
		/readonly\s+operatorAccount\s*:\s*string\s*;/.test(cfgSrc),
		'ops-cli Config must expose operatorAccount so block/moderation can key on it'
	);
	expect(
		'config.ts derives operatorAccount from OPERATOR env with official fallback',
		/operatorAccount\s*:\s*[\s\S]{0,160}MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME[\s\S]{0,80}MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME/.test(
			cfgSrc
		),
		'operatorAccount must mirror the indexer rule: OPERATOR if set, else OFFICIAL'
	);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 local-block smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} local-block scenarios passed`);
