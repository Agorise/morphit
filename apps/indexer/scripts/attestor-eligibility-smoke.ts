/**
 * Attestor eligibility helper — tsx smoke runner.
 *
 * Finding I logic runtime-verification. Exercises
 * checkAttestorEligibility across phase × gate-status cases
 * with mocked DB rows.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/attestor-eligibility-smoke.ts
 */

import {
	checkAttestorEligibility,
	ATTESTOR_LOYALTY_THRESHOLD_BLURT,
	ATTESTOR_AGE_THRESHOLD_DAYS
} from '../src/indexer/attestorEligibility.ts';
import { makeMockClient } from '../test/testutils/mockClient.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => {
				console.log(`  ✓ ${name}`);
			},
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

/** Build a mock client seeded to return one row with the given
 *  (created_block_time, cumulative_blurt_paid), matching the
 *  helper's LEFT JOIN query shape. */
function seedRow(createdAt: Date | null, loyaltyBlurt: number | null) {
	return makeMockClient([
		{
			match: 'FROM accounts',
			rows: [
				{
					created_block_time: createdAt,
					cumulative_blurt_paid: loyaltyBlurt === null ? null : String(loyaltyBlurt)
				}
			]
		}
	]);
}

/** Build a mock that returns zero rows — account-not-found. */
function seedEmpty() {
	return makeMockClient([{ match: 'FROM accounts', rows: [], rowCount: 0 }]);
}

// A fixed reference time so age arithmetic is deterministic.
const NOW = new Date('2026-04-24T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

console.log('\n── Attestor eligibility (Finding I) ─────────────────');

// ─── account_not_found ────────────────────────────────────────

await scenario('account_not_found → ineligible regardless of phase', async () => {
	const mock = seedEmpty();
	const r = await checkAttestorEligibility('ghost', 'launch', mock.client, NOW);
	if (r.eligible) throw new Error('expected ineligible');
	if (r.reason !== 'account_not_found') {
		throw new Error(`expected account_not_found, got ${r.reason}`);
	}
	assertEqual(r.daysUntilEligible, null, 'daysUntilEligible');
	assertEqual(r.missingLoyaltyBlurt, ATTESTOR_LOYALTY_THRESHOLD_BLURT, 'missing');
});

await scenario('account_not_found same reason under steady phase', async () => {
	const mock = seedEmpty();
	const r = await checkAttestorEligibility('ghost', 'steady', mock.client, NOW);
	if (r.eligible) throw new Error('expected ineligible');
	if (r.reason !== 'account_not_found') {
		throw new Error(`expected account_not_found, got ${r.reason}`);
	}
});

// ─── Young account + no loyalty ──────────────────────────────

await scenario('young account + no loyalty → ineligible, both gates fail', async () => {
	const created = new Date(NOW.getTime() - 10 * DAY_MS); // 10 days ago
	const mock = seedRow(created, 0);
	const r = await checkAttestorEligibility('fresh', 'launch', mock.client, NOW);
	if (r.eligible) throw new Error('expected ineligible');
	if (r.reason !== 'insufficient_loyalty_and_young_account') {
		throw new Error(`unexpected reason: ${r.reason}`);
	}
	// 30 - 10 = 20 days remain.
	assertEqual(r.daysUntilEligible, 20, 'daysUntilEligible');
	assertEqual(r.missingLoyaltyBlurt, ATTESTOR_LOYALTY_THRESHOLD_BLURT, 'missing');
});

await scenario('loyalty row missing → treated as 0', async () => {
	// Account exists (has a created_block_time) but
	// account_loyalty row doesn't exist yet — LEFT JOIN returns
	// NULL for cumulative_blurt_paid.
	const created = new Date(NOW.getTime() - 10 * DAY_MS);
	const mock = seedRow(created, null);
	const r = await checkAttestorEligibility('newish', 'launch', mock.client, NOW);
	if (r.eligible) throw new Error('expected ineligible');
	assertEqual(r.loyaltyBlurt, 0, 'loyaltyBlurt');
});

// ─── Launch phase OR gate ────────────────────────────────────

await scenario('launch: young + enough loyalty → eligible (loyalty branch)', async () => {
	const created = new Date(NOW.getTime() - 5 * DAY_MS);
	const mock = seedRow(created, 150);
	const r = await checkAttestorEligibility('paid-up', 'launch', mock.client, NOW);
	if (!r.eligible) throw new Error(`expected eligible: ${JSON.stringify(r)}`);
	assertEqual(r.reason, 'loyalty', 'reason');
});

await scenario('launch: old + no loyalty → eligible (age branch)', async () => {
	const created = new Date(NOW.getTime() - 60 * DAY_MS);
	const mock = seedRow(created, 0);
	const r = await checkAttestorEligibility('vintage', 'launch', mock.client, NOW);
	if (!r.eligible) throw new Error('expected eligible');
	assertEqual(r.reason, 'age', 'reason');
});

await scenario('launch: old AND loyal → eligible with reason=both', async () => {
	const created = new Date(NOW.getTime() - 60 * DAY_MS);
	const mock = seedRow(created, 500);
	const r = await checkAttestorEligibility('veteran', 'launch', mock.client, NOW);
	if (!r.eligible) throw new Error('expected eligible');
	assertEqual(r.reason, 'both', 'reason');
});

// ─── Steady phase AND gate ───────────────────────────────────

await scenario('steady: young + enough loyalty → ineligible (young_account)', async () => {
	const created = new Date(NOW.getTime() - 10 * DAY_MS);
	const mock = seedRow(created, 200);
	const r = await checkAttestorEligibility('loyal-fresh', 'steady', mock.client, NOW);
	if (r.eligible) throw new Error('steady should fail when age is short');
	assertEqual(r.reason, 'young_account', 'reason');
	assertEqual(r.missingLoyaltyBlurt, 0, 'missingLoyaltyBlurt');
	assertEqual(r.daysUntilEligible, 20, 'daysUntilEligible');
});

await scenario('steady: old + no loyalty → ineligible (insufficient_loyalty)', async () => {
	const created = new Date(NOW.getTime() - 100 * DAY_MS);
	const mock = seedRow(created, 10);
	const r = await checkAttestorEligibility('broke-old', 'steady', mock.client, NOW);
	if (r.eligible) throw new Error('steady should fail without loyalty');
	assertEqual(r.reason, 'insufficient_loyalty', 'reason');
	assertEqual(r.missingLoyaltyBlurt, 90, 'missingLoyaltyBlurt');
	assertEqual(r.daysUntilEligible, 0, 'daysUntilEligible');
});

await scenario('steady: old AND loyal → eligible with reason=both', async () => {
	const created = new Date(NOW.getTime() - 60 * DAY_MS);
	const mock = seedRow(created, 500);
	const r = await checkAttestorEligibility('qualified', 'steady', mock.client, NOW);
	if (!r.eligible) throw new Error('expected eligible');
	assertEqual(r.reason, 'both', 'reason');
});

// ─── Boundary conditions ─────────────────────────────────────

await scenario('exactly at loyalty threshold (100) → meets loyalty', async () => {
	const created = new Date(NOW.getTime() - 5 * DAY_MS);
	const mock = seedRow(created, ATTESTOR_LOYALTY_THRESHOLD_BLURT);
	const r = await checkAttestorEligibility('edge-loyal', 'launch', mock.client, NOW);
	if (!r.eligible) throw new Error('100 BLURT exactly should qualify');
});

await scenario('exactly at age threshold (30 days) → meets age', async () => {
	const created = new Date(NOW.getTime() - ATTESTOR_AGE_THRESHOLD_DAYS * DAY_MS);
	const mock = seedRow(created, 0);
	const r = await checkAttestorEligibility('edge-age', 'launch', mock.client, NOW);
	if (!r.eligible) throw new Error('30 days exactly should qualify');
});

await scenario('99.999 BLURT and 29 days → ineligible', async () => {
	const created = new Date(NOW.getTime() - 29 * DAY_MS);
	const mock = seedRow(created, 99.999);
	const r = await checkAttestorEligibility('just-short', 'launch', mock.client, NOW);
	if (r.eligible) throw new Error('both thresholds missed by a hair → ineligible');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
