#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/snapshot-oplog-verify-smoke.ts (cp767)
 *
 * Locks the PURE Tier-2 op-log verification core: the position-based match
 * against a chain block, and the spread sampler. Fails CLOSED — an ambiguous
 * match is a MISMATCH. No DB/network.
 */
import {
	verifyStoredOpAgainstBlock,
	pickVerificationSample,
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

// ── sampler: spread, bounds, determinism, permlink preference ─────
{
	const rows: StoredOpRef[] = Array.from({ length: 1000 }, (_, i) => ({
		blockNum: 60_000_000 + i,
		trxInBlock: 0,
		opInTrx: 0,
		signer: 'a',
		opId: 'morphit_order',
		permlink: i % 2 === 0 ? `p${i}` : null
	}));
	const s = pickVerificationSample(rows, 40);
	check('sample size is capped at k', s.length <= 40 && s.length > 0);
	check('sample is sorted ascending by block', s.every((r, i) => i === 0 || r.blockNum >= s[i - 1]!.blockNum));
	check('sample includes the newest block (live-order tail)', s.some((r) => r.blockNum === 60_000_999));
	check('sample spans a wide range (not clustered)', s[s.length - 1]!.blockNum - s[0]!.blockNum > 900);
	const s2 = pickVerificationSample(rows, 40);
	check('sampler is deterministic', JSON.stringify(s) === JSON.stringify(s2));
}
check('sample of 0 rows is empty', pickVerificationSample([], 40).length === 0);
check('k >= pool returns all rows', pickVerificationSample([ref], 40).length === 1);
check('k <= 0 returns empty', pickVerificationSample([ref], 0).length === 0);

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} snapshot-oplog-verify checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} snapshot-oplog-verify scenarios passed`);
