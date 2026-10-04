#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/snapshot-oplog-verify-smoke.ts
 *
 * Locks the PURE Tier-2 snapshot verification core: the position-based match
 * against a chain block, the account-creation match, the CSPRNG-driven
 * sampling helpers and the verdict. Fails CLOSED — an ambiguous match is a
 * MISMATCH. No DB/network.
 */
import { randomInt } from 'node:crypto';
import {
	verifyStoredOpAgainstBlock,
	verifyAccountCreatedInBlock,
	randomDistinctIndices,
	pickBlockTargets,
	newestShare,
	oplogVerdict,
	type StoredOpRef,
	type BlockLike
} from '../src/db/snapshotOplogVerify.ts';

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}`);
	}
}

console.log('\n── snapshot op-log verify smoke (cp767) ───────────────\n');

const ref: StoredOpRef = {
	blockNum: 62_000_000,
	trxInBlock: 1,
	opInTrx: 0,
	signer: 'alice',
	opId: 'morphit_order',
	permlink: 'sell-btc-abc123'
};
// A chain block whose (trx 1, op 0) is exactly the recorded custom_json.
const goodBlock: BlockLike = {
	transactions: [
		{ operations: [['vote', {}]] },
		{
			operations: [
				[
					'custom_json',
					{
						required_auths: [],
						required_posting_auths: ['alice'],
						id: 'morphit_order',
						json: JSON.stringify({ permlink: 'sell-btc-abc123', side: 'sell' })
					}
				]
			]
		}
	]
};

// ── happy path ────────────────────────────────────────────────────
check('a recorded op present at its position with matching permlink verifies', verifyStoredOpAgainstBlock(ref, goodBlock).ok);

// ── fail closed on every tamper ───────────────────────────────────
check('null block → mismatch', !verifyStoredOpAgainstBlock(ref, null).ok);
check('no transaction at position → mismatch', !verifyStoredOpAgainstBlock({ ...ref, trxInBlock: 9 }, goodBlock).ok);
check('no op at position → mismatch', !verifyStoredOpAgainstBlock({ ...ref, opInTrx: 9 }, goodBlock).ok);
check('wrong op id → mismatch', !verifyStoredOpAgainstBlock({ ...ref, opId: 'morphit_cancel' }, goodBlock).ok);
check('wrong signer → mismatch', !verifyStoredOpAgainstBlock({ ...ref, signer: 'mallory' }, goodBlock).ok);
check('permlink mismatch (points at a REAL op of a different order) → mismatch', !verifyStoredOpAgainstBlock({ ...ref, permlink: 'sell-btc-DIFFERENT' }, goodBlock).ok);
{
	// position holds a non-custom_json op
	const b: BlockLike = { transactions: [{ operations: [['vote', {}]] }, { operations: [['transfer', {}]] }] };
	check('position is a non-custom_json op → mismatch', !verifyStoredOpAgainstBlock(ref, b).ok);
}
{
	// permlink-less op (e.g. a profile ptr) matches on id+signer+position only
	const noPerm: StoredOpRef = { ...ref, opId: 'morphit_profile', permlink: null };
	const b: BlockLike = { transactions: [{ operations: [] }, { operations: [['custom_json', { required_posting_auths: ['alice'], id: 'morphit_profile', json: '{}' }]] }] };
	check('permlink-less op verifies on id+signer+position', verifyStoredOpAgainstBlock(noPerm, b).ok);
}
{
	// on-chain op json won't parse but a permlink was expected → mismatch
	const b: BlockLike = { transactions: [{ operations: [] }, { operations: [['custom_json', { required_posting_auths: ['alice'], id: 'morphit_order', json: '{bad' }]] }] };
	check('unparseable on-chain json when permlink expected → mismatch', !verifyStoredOpAgainstBlock(ref, b).ok);
}

// ── sampling: unpredictable, whole-range, bounded ─────
{
	const idx = randomDistinctIndices(1000, 40, randomInt);
	check('random indices: k distinct, in range, ascending', idx.length === 40 && new Set(idx).size === 40 && idx.every((v, i) => v >= 0 && v < 1000 && (i === 0 || v > idx[i - 1]!)));
	check('random indices: k > n gives all n', randomDistinctIndices(5, 40, randomInt).join() === '0,1,2,3,4');
	check('random indices: n = 0 or k = 0 gives none', randomDistinctIndices(0, 5, randomInt).length === 0 && randomDistinctIndices(5, 0, randomInt).length === 0);
	const a = randomDistinctIndices(100_000, 40, randomInt);
	const b2 = randomDistinctIndices(100_000, 40, randomInt);
	check('two runs draw different samples (a forger cannot know where it looks)', a.join() !== b2.join());
	// With a scripted source, any index can be drawn — including the last one.
	check('the newest index is reachable', randomDistinctIndices(10, 1, (m) => m - 1).join() === '9');
	const t = pickBlockTargets(1_000_001, 1_010_000, 200, randomInt);
	check('block targets stay in range', t.length === 200 && t.every((x) => x >= 1_000_001 && x <= 1_010_000));
	check('block targets cover the top of the range', t.some((x) => x > 1_008_000));
	check('block targets: empty range gives none', pickBlockTargets(10, 9, 5, randomInt).length === 0);
	check('newest share is a quarter, at least one', newestShare(40) === 10 && newestShare(1) === 1);
}
// ── account creation match ─────
{
	const blk = {
		transaction_ids: ['t0', 't1'],
		transactions: [
			{ operations: [['transfer', { from: 'x', to: 'y' }]] },
			{ operations: [['account_create', { new_account_name: 'carol', creator: 'morphit-relay' }]] }
		]
	} as never;
	check('account created in its recorded trx → ok', verifyAccountCreatedInBlock('carol', 't1', blk).ok);
	check('account recorded in another trx → mismatch', !verifyAccountCreatedInBlock('carol', 't0', blk).ok);
	check('account not created in the block → mismatch', !verifyAccountCreatedInBlock('mallory', 't1', blk).ok);
	check('no block → mismatch', !verifyAccountCreatedInBlock('carol', 't1', null).ok);
}
// ── verdict ─────
check('any failure quarantines', oplogVerdict({ sampled: 40, verified: 39, failures: 1 }) === 'quarantine');
check('too little checked is inconclusive', oplogVerdict({ sampled: 40, verified: 31, failures: 0 }) === 'inconclusive');
check('enough checked, no failure → verified', oplogVerdict({ sampled: 40, verified: 32, failures: 0 }) === 'verified');
check('nothing sampled is inconclusive', oplogVerdict({ sampled: 0, verified: 0, failures: 0 }) === 'inconclusive');
// ── v1.20.0 (V3-7): the authority the DISPATCHER accepted, per op ──
// BLURT-paid orders, feature bids and stranger fees are signed with ACTIVE
// authority (their fee transfer sits in the same tx, and Blurt forbids mixing
// posting and active in one tx), so their signer is in required_auths. The
// verifier checked only required_posting_auths and quarantined every honest
// snapshot holding one of them.
{
	const at = (id: string, auths: { active?: string[]; posting?: string[] }) => ({
		transactions: [
			{
				operations: [
					[
						'custom_json',
						{
							required_auths: auths.active ?? [],
							required_posting_auths: auths.posting ?? [],
							id,
							json: JSON.stringify({ permlink: 'p1', fee_method: 'blurt' })
						}
					],
					['transfer', { from: 'alice', to: 'morphit-fees', amount: '62.500 BLURT', memo: 'morphit-fee:p1' }]
				]
			}
		]
	});
	const stored = (opId: string, signer = 'alice', permlink: string | null = 'p1') => ({
		blockNum: 1,
		trxInBlock: 0,
		opInTrx: 0,
		signer,
		opId,
		permlink
	});
	for (const id of ['morphit_order_v1', 'morphit_feature_bid_v1', 'morphit_stranger_fee_v1']) {
		const r = verifyStoredOpAgainstBlock(stored(id), at(id, { active: ['alice'] }) as never);
		check(`V3-7: an ACTIVE-signed ${id} (signer in required_auths) verifies`, r.ok);
		check(
			`V3-7: an ACTIVE-signed ${id} recorded under another signer → mismatch`,
			!verifyStoredOpAgainstBlock(stored(id, 'mallory'), at(id, { active: ['alice'] }) as never).ok
		);
	}
	check(
		'V3-7: an ACTIVE-signed chat op (the dispatcher never applies one) → mismatch',
		!verifyStoredOpAgainstBlock(stored('morphit_chat_v1', 'alice', null), at('morphit_chat_v1', { active: ['alice'] }) as never).ok
	);
	check(
		'V3-7: a posting-signed order still verifies (posting auth is the other valid form)',
		verifyStoredOpAgainstBlock(stored('morphit_order_v1'), at('morphit_order_v1', { posting: ['alice'] }) as never).ok
	);
	check(
		'V3-7: two posting auths (the dispatcher rejects: multiple_posting_auths) → mismatch',
		!verifyStoredOpAgainstBlock(stored('morphit_order_v1'), at('morphit_order_v1', { posting: ['alice', 'bob'] }) as never).ok
	);
}


const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} snapshot-oplog-verify checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} snapshot-oplog-verify scenarios passed`);
