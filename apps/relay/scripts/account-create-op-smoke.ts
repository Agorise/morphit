#!/usr/bin/env tsx
/**
 * Regression smoke for the beta.28 account-creation op swap.
 *
 * Blurt disabled BOTH `claim_account` (op 15) and `create_claimed_account`
 * (op 16) at hard fork 2 — the chain evaluators assert "This operation is
 * disable since hard fork 2." The relay therefore creates accounts with a
 * direct `account_create` (op 5), paying the `account_creation_fee` INLINE
 * (read live from the chain per broadcast, since the evaluator asserts the
 * fee equals the witnesses' median EXACTLY). See ADR-0010 (amended 2026-06).
 *
 * This smoke LOCKS that migration. It fails if anyone:
 *   - reverts the builder to the disabled ACT ops,
 *   - drops the inline `fee`, or re-adds an `extensions` field,
 *   - drifts the op-5 field ORDER away from dblurt's serializer,
 *   - re-introduces the claim_account / auto-minter broadcast machinery, or
 *   - stops reading the fee live from the chain.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAccountCreateOp, type NewAccountAuthorities } from '../src/blurt/client.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

// The canonical op-5 field order (Steem/Blurt account_create). This is the
// contract the relay's builder must follow AND that dblurt serializes.
const EXPECTED_ORDER = [
	'fee',
	'creator',
	'new_account_name',
	'owner',
	'active',
	'posting',
	'memo_key',
	'json_metadata'
] as const;

const SAMPLE_AUTH: NewAccountAuthorities = {
	newAccountName: 'alice-test',
	ownerPubkey: 'BLT5OwnerKeyOwnerKeyOwnerKeyOwnerKeyOwnerKeyOwnerKeyOwn',
	activePubkey: 'BLT5ActiveKeyActiveKeyActiveKeyActiveKeyActiveKeyActiveK',
	postingPubkey: 'BLT5PostingKeyPostingKeyPostingKeyPostingKeyPostingKeyPo',
	memoPubkey: 'BLT5MemoKeyMemoKeyMemoKeyMemoKeyMemoKeyMemoKeyMemoKeyMe',
	jsonMetadata: ''
};
const SAMPLE_FEE = '100.000 BLURT';

console.log('\n── account_create op-swap regression smoke ──────────────\n');

const [opName, body] = buildAccountCreateOp('morphit-relay', SAMPLE_FEE, SAMPLE_AUTH);

scenario('builds the `account_create` op (op 5), NOT a disabled ACT op', () => {
	assert(opName === 'account_create', `op name is ${JSON.stringify(opName)}, expected 'account_create'`);
	// @ts-expect-error — defensive: these ops are disabled on Blurt and must never be built.
	assert(opName !== 'claim_account' && opName !== 'create_claimed_account', 'built a disabled ACT op');
});

scenario('fee is paid INLINE (present in the op body, equals the passed fee)', () => {
	assert('fee' in body, 'op body has no `fee` field — account_create pays the fee inline');
	assert(body.fee === SAMPLE_FEE, `body.fee is ${JSON.stringify(body.fee)}, expected ${JSON.stringify(SAMPLE_FEE)}`);
});

scenario('op body field ORDER is exactly the op-5 layout (no extras)', () => {
	const keys = Object.keys(body);
	assert(
		keys.length === EXPECTED_ORDER.length && keys.every((k, i) => k === EXPECTED_ORDER[i]),
		`field order is [${keys.join(', ')}], expected [${EXPECTED_ORDER.join(', ')}]`
	);
});

scenario('NO `extensions` field (unlike the retired create_claimed_account)', () => {
	assert(!('extensions' in body), 'account_create must NOT carry an extensions field');
});

scenario('builder field order matches dblurt`s native account_create serializer (op 5)', () => {
	const require = createRequire(import.meta.url);
	const serializerPath = require.resolve('@beblurt/dblurt/lib/chain/serializer.js');
	const src = readFileSync(serializerPath, 'utf-8');
	const m = src.match(/OperationSerializers\.account_create\s*=\s*OperationDataSerializer\(\s*5\s*,\s*\[([\s\S]*?)\]\s*\)/);
	assert(m !== null, 'dblurt has no account_create OperationDataSerializer(5, …) — op-5 not native?');
	const fields = [...m![1].matchAll(/\[\s*'([a-z_]+)'/g)].map((x) => x[1]);
	assert(
		fields.length === EXPECTED_ORDER.length && fields.every((f, i) => f === EXPECTED_ORDER[i]),
		`dblurt op-5 fields [${fields.join(', ')}] differ from builder order [${EXPECTED_ORDER.join(', ')}]`
	);
});

// Source guards on the relay client: the disabled-op + auto-minter
// machinery must stay gone, and the fee must be read live from the chain.
const CLIENT_SRC = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'blurt', 'client.ts'),
	'utf-8'
);
// Strip line/block comments so prose mentions of the dead ops (e.g. the
// "Blurt disabled …" explanation) don't trip the guards — we only care
// about live code.
const CLIENT_CODE = CLIENT_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

scenario('relay client does NOT broadcast the disabled ACT ops (code, not comments)', () => {
	assert(!CLIENT_CODE.includes("'create_claimed_account'"), "client.ts still builds 'create_claimed_account'");
	assert(!CLIENT_CODE.includes("'claim_account'"), "client.ts still builds 'claim_account'");
	assert(!/broadcastClaimAccount/.test(CLIENT_CODE), 'client.ts still defines broadcastClaimAccount');
	assert(
		!/registerClaimedAccountOperationSerializers/.test(CLIENT_CODE),
		'client.ts still registers the claimed-account serializers (account_create is dblurt-native)'
	);
});

scenario('broadcastAccountCreate reads the account_creation_fee LIVE from the chain', () => {
	assert(/broadcastAccountCreate/.test(CLIENT_CODE), 'broadcastAccountCreate not found');
	assert(
		/getChainProperties\(\)/.test(CLIENT_CODE) && /account_creation_fee/.test(CLIENT_CODE),
		'broadcastAccountCreate must read getChainProperties().account_creation_fee per call'
	);
});

console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
