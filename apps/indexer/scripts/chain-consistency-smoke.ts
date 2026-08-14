/**
 * Smoke: the RPC trust layer's pure decision logic — blockConsistencyKey +
 * interpretChainConsistency. This is the security-critical comparison that
 * decides whether a quorum of endpoints agreed on the chain, so it's exercised
 * exhaustively here without a pool or a network.
 */
import {
	blockConsistencyKey,
	interpretChainConsistency
} from '../src/blurt/chainConsistency.ts';
import type { BlockHeader } from '../src/blurt/client.ts';
import type { QuorumCallResult } from '@morphit/rpc-pool';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}`);
	}
}

function blk(over: Partial<BlockHeader>): BlockHeader {
	return { timestamp: '2026-08-13T00:00:00', transactions: [], transaction_ids: [], ...over };
}

// ── blockConsistencyKey ─────────────────────────────────────────────
check('key prefers block_id', blockConsistencyKey(blk({ block_id: 'ABC123' })) === 'id:abc123');
check(
	'key is case-insensitive on block_id',
	blockConsistencyKey(blk({ block_id: 'ABC' })) === blockConsistencyKey(blk({ block_id: 'abc' }))
);
check(
	'key falls back to composite when no block_id',
	blockConsistencyKey(blk({ previous: 'PREV', transaction_merkle_root: 'M', witness: 'w' })).startsWith(
		'c:prev|'
	)
);
check(
	'no block_id AND no previous → empty key (unusable, never matches)',
	blockConsistencyKey(blk({ witness: 'w' })) === ''
);
check(
	'two nodes, same block_id → same key (they agree)',
	blockConsistencyKey(blk({ block_id: 'X', witness: 'a' })) ===
		blockConsistencyKey(blk({ block_id: 'X', witness: 'b' }))
);
check(
	'two nodes, different block_id → different key (disagree)',
	blockConsistencyKey(blk({ block_id: 'X' })) !== blockConsistencyKey(blk({ block_id: 'Y' }))
);

// ── interpretChainConsistency ───────────────────────────────────────
function qr(over: Partial<QuorumCallResult<BlockHeader>>): QuorumCallResult<BlockHeader> {
	return {
		kind: 'all_responses_in',
		responses: [],
		agreedKey: undefined,
		contacted: 0,
		cooledDown: 0,
		...over
	};
}

// quorum_met → consistent
{
	const r = interpretChainConsistency(
		qr({
			kind: 'quorum_met',
			agreedKey: 'id:x',
			responses: [blk({ block_id: 'X' }), blk({ block_id: 'X' })],
			contacted: 3
		}),
		2
	);
	check('quorum_met → consistent', r.consistent && r.reason === 'quorum_agreed');
	check('quorum_met counts agreeing endpoints', r.agreeing === 2);
}

// all_responses_in with 2 DISTINCT keys → disagreement (the loud case)
{
	const r = interpretChainConsistency(
		qr({
			kind: 'all_responses_in',
			responses: [blk({ block_id: 'X' }), blk({ block_id: 'Y' })],
			contacted: 2
		}),
		2
	);
	check('disagreement (2 distinct ids) → not consistent', !r.consistent);
	check('disagreement reason', r.reason === 'disagreement');
}

// all_responses_in with only 1 answer → insufficient, NOT a fork accusation
{
	const r = interpretChainConsistency(
		qr({ kind: 'all_responses_in', responses: [blk({ block_id: 'X' })], contacted: 1 }),
		2
	);
	check('single response → insufficient_responses (not disagreement)', r.reason === 'insufficient_responses');
	check('insufficient → not consistent', !r.consistent);
}

// no_endpoints → nothing to check
{
	const r = interpretChainConsistency(qr({ kind: 'no_endpoints', cooledDown: 6 }), 2);
	check('no_endpoints → not consistent + reason', !r.consistent && r.reason === 'no_endpoints');
	check('no_endpoints surfaces cooledDown', r.cooledDown === 6);
}

// required threshold is echoed back
{
	const r = interpretChainConsistency(qr({ kind: 'quorum_met', agreedKey: 'id:x', responses: [blk({ block_id: 'X' })] }), 3);
	check('required threshold echoed', r.required === 3);
}

console.log(
	fail === 0
		? `\n\u2713 all ${pass} chain-consistency checks passed`
		: `\n\u2717 chain-consistency: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
