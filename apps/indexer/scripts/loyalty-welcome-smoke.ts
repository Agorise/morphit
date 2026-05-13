/**
 * Loyalty welcome + milestone smoke.
 *
 * Exercises trackVerifiedBlurtFee:
 *   - First-fee welcome (1 BP, once-per-account).
 *   - Milestone crossings (10/50/200/1000 BP).
 *   - Cumulative BP target stays correct when both fire.
 *   - Idempotent on replay.
 */

import {
	trackVerifiedBlurtFee,
	FIRST_FEE_WELCOME_BP,
	FIRST_FEE_WELCOME_SENTINEL_BLURT,
	LOYALTY_MILESTONES
} from '../src/indexer/loyalty.ts';
import { makeMockClient } from '../test/testutils/mockClient.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => console.log(`  ✓ ${name}`),
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

console.log('\n── Loyalty welcome + milestones ──────────────────────────');

// ─── Welcome fires once on first fee ────────────────────────────

await scenario('first verified BLURT fee queues a 1 BP delegation', async () => {
	const mock = makeMockClient([
		// upsert returns previous=0 (fresh row), new=10
		{
			match: /INSERT INTO account_loyalty/,
			rows: [{ previous_total: '0', new_total: '10' }]
		},
		// G6: welcome INSERT now wrapped in SAVEPOINT.
		{ match: /^SAVEPOINT first_fee_welcome_sp$/ },
		// welcome milestone insert succeeds (no unique violation)
		{ match: /INSERT INTO account_loyalty_milestones/, rowCount: 1 },
		{ match: /^RELEASE SAVEPOINT first_fee_welcome_sp$/ },
		// cumulative BP query → 1 BP (just the welcome row)
		{
			match: /SELECT COALESCE\(SUM\(bp_rewarded\)/,
			rows: [{ cumulative_bp: '1' }]
		},
		// queue the delegation
		{ match: /INSERT INTO relay_pending_transfers/, rowCount: 1 }
	]);

	await trackVerifiedBlurtFee(mock.client, 'alice', 10, 1000, new Date(), 'morphit', 'morphit');

	// Verify the queue row carries the correct cumulative target.
	const queueRow = mock.queries.find((q) => /relay_pending_transfers/.test(q.text));
	if (!queueRow) throw new Error('no queue row');
	const recipient = queueRow.params[0];
	const cumBp = queueRow.params[1];
	const reason = queueRow.params[2];
	if (recipient !== 'alice') throw new Error(`recipient=${recipient}`);
	if (Number(cumBp) !== 1) throw new Error(`cumBp=${cumBp} expected 1`);
	if (reason !== 'first_listing_fee_welcome') throw new Error(`reason=${reason}`);
});

// ─── Welcome is idempotent ──────────────────────────────────────

await scenario('replay of fee does NOT double-queue welcome', async () => {
	const mock = makeMockClient([
		{
			match: /INSERT INTO account_loyalty/,
			rows: [{ previous_total: '10', new_total: '20' }]
		},
		// G6: welcome SAVEPOINT around the collision.
		{ match: /^SAVEPOINT first_fee_welcome_sp$/ },
		// unique violation = welcome already received
		{
			match: /INSERT INTO account_loyalty_milestones/,
			throwError: { code: '23505' }
		},
		{ match: /^ROLLBACK TO SAVEPOINT first_fee_welcome_sp$/ },
		{ match: /^RELEASE SAVEPOINT first_fee_welcome_sp$/ }
		// NO cumulative query, NO queue row — welcome already happened
	]);

	await trackVerifiedBlurtFee(mock.client, 'alice', 10, 1001, new Date(), 'morphit', 'morphit');

	const queueRow = mock.queries.find((q) => /relay_pending_transfers/.test(q.text));
	if (queueRow) throw new Error('welcome should not re-queue');
});

// ─── Welcome + milestone fire together ──────────────────────────

await scenario('large first fee crosses welcome + 100 BLURT milestone', async () => {
	const mock = makeMockClient([
		// Fresh row, 100 BLURT paid in one go
		{
			match: /INSERT INTO account_loyalty/,
			rows: [{ previous_total: '0', new_total: '100' }]
		},
		// G6: welcome SAVEPOINT + INSERT + RELEASE.
		{ match: /^SAVEPOINT first_fee_welcome_sp$/ },
		{ match: /INSERT INTO account_loyalty_milestones/, rowCount: 1 },
		{ match: /^RELEASE SAVEPOINT first_fee_welcome_sp$/ },
		// Cumulative after welcome → 1 BP
		{
			match: /SELECT COALESCE\(SUM\(bp_rewarded\)/,
			rows: [{ cumulative_bp: '1' }]
		},
		// Welcome queue row
		{ match: /INSERT INTO relay_pending_transfers/, rowCount: 1 },
		// G6: milestone-100 SAVEPOINT + INSERT + RELEASE.
		{ match: /^SAVEPOINT loyalty_ms_100_sp$/ },
		{ match: /INSERT INTO account_loyalty_milestones/, rowCount: 1 },
		{ match: /^RELEASE SAVEPOINT loyalty_ms_100_sp$/ },
		// Cumulative after milestone → 1 + 10 = 11 BP
		{
			match: /SELECT COALESCE\(SUM\(bp_rewarded\)/,
			rows: [{ cumulative_bp: '11' }]
		},
		// Milestone queue row (cumulative = 11)
		{ match: /INSERT INTO relay_pending_transfers/, rowCount: 1 }
	]);

	await trackVerifiedBlurtFee(mock.client, 'bob', 100, 1002, new Date(), 'morphit', 'morphit');

	const queueRows = mock.queries.filter((q) => /INSERT INTO relay_pending_transfers/.test(q.text));
	if (queueRows.length !== 2) {
		throw new Error(`expected 2 queue rows, got ${queueRows.length}`);
	}
	const welcome = queueRows[0];
	const milestone = queueRows[1];
	if (Number(welcome!.params[1]) !== 1) throw new Error('welcome should be 1 BP');
	if (Number(milestone!.params[1]) !== 11) {
		throw new Error(`milestone cumulative should be 11, got ${milestone!.params[1]}`);
	}
});

// ─── Welcome BP value is the documented constant ────────────────

await scenario('welcome BP = 1', () => {
	if (FIRST_FEE_WELCOME_BP !== 1) throw new Error(String(FIRST_FEE_WELCOME_BP));
});

await scenario('welcome sentinel = 0', () => {
	if (FIRST_FEE_WELCOME_SENTINEL_BLURT !== 0)
		throw new Error(String(FIRST_FEE_WELCOME_SENTINEL_BLURT));
});

// ─── Milestone schedule unchanged ───────────────────────────────

await scenario('loyalty milestones still 100/500/2000/10000 → 10/50/200/1000', () => {
	const expected = [
		[100, 10],
		[500, 50],
		[2000, 200],
		[10000, 1000]
	];
	for (let i = 0; i < expected.length; i++) {
		const ms = LOYALTY_MILESTONES[i];
		if (!ms) throw new Error(`missing milestone ${i}`);
		if (ms.thresholdBlurt !== expected[i]![0])
			throw new Error(`threshold[${i}]=${ms.thresholdBlurt}`);
		if (ms.bpReward !== expected[i]![1]) throw new Error(`reward[${i}]=${ms.bpReward}`);
	}
});

// ─── Zero-amount fee no-op ──────────────────────────────────────

await scenario('zero-amount fee returns immediately', async () => {
	const mock = makeMockClient();
	await trackVerifiedBlurtFee(mock.client, 'alice', 0, 1003, new Date(), 'morphit', 'morphit');
	if (mock.queries.length !== 0) throw new Error(`leaked queries: ${mock.queries.length}`);
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
