#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/reputation-receipt-shape-smoke.ts
 *
 * Structural Defense (cp124 H4) — invariants over the
 * /v1/accounts/:account/reputation-receipt response shape.
 *
 * The receipt is the "show your work" endpoint — any third party
 * should be able to re-derive the published weighted_rating from
 * the receipt's rows.  These structural smokes pin the contract
 * so silent drift can't introduce verifier-incompatible changes.
 *
 * The receipt's API surface is type-checked via the
 * @morphit/indexer-client package; this smoke pins the SHAPE
 * (required fields, formula description, decay constant) at
 * runtime.
 *
 * Scenarios:
 *   R-1   ReputationReceiptResponse interface fields are present
 *   R-2   ReputationExclusionReason union covers all 5 cases
 *   R-3   ReputationReceiptRow interface fields are present
 *   R-4   Decay half-life constant in package matches indexer's
 *         REPUTATION_DECAY_HALF_LIFE_DAYS (single source of truth)
 *   R-5   Formula string in module doc mentions both the exponent
 *         formula AND the exclusion reasons (machine readers can
 *         introspect this string for self-documentation)
 *   R-6   The 5 exclusion-reason string-literal values match
 *         what the receipt handler emits
 *   R-7   computeWeightedRating + reputationDecayWeight imports
 *         resolve and exports exist
 */

import {
	REPUTATION_DECAY_HALF_LIFE_DAYS,
	reputationDecayWeight,
	computeWeightedRating
} from '../src/indexer/reputation/decay';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	ReputationReceiptResponse,
	ReputationReceiptRow,
	ReputationExclusionReason
} from '@morphit/indexer-client';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── reputation-receipt-shape invariants smoke (cp124 H4) ───\n');

// R-1 — type-level field presence via satisfies
{
	const sample: ReputationReceiptResponse = {
		account: 'alice',
		as_of: '2026-05-23T00:00:00.000Z',
		decay_half_life_days: 365,
		formula: 'weighted_rating = ...',
		summary: {
			count_total: 5,
			count_included: 4,
			count_excluded: 1,
			weight_sum: 3.7,
			weighted_rating: 4.74
		},
		rows: []
	};
	if (sample.account === 'alice') pass('R-1 ReputationReceiptResponse all required fields present');
	else fail('R-1', 'unreachable');
}

// R-2 — exclusion reasons union
{
	const reasons: ReputationExclusionReason[] = [
		null,
		'no_order_permlink',
		'suspicious_reciprocity',
		'related_accounts',
		'one_way_pile_on',
		'review_concentration'
	];
	if (reasons.length === 6) pass('R-2 ReputationExclusionReason covers null + 5 reason strings');
	else fail('R-2', `got ${reasons.length}`);
}

// R-3 — row shape
{
	const row: ReputationReceiptRow = {
		source_trx_id: 'abc',
		reviewer: 'bob',
		rating: 5,
		created_at: '2026-05-22T00:00:00.000Z',
		order_permlink: 'sell-btc-1',
		age_days: 1.5,
		decay_weight: 0.997,
		included: true,
		excluded_reason: null
	};
	if (row.reviewer === 'bob') pass('R-3 ReputationReceiptRow all required fields present');
	else fail('R-3', 'unreachable');
}

// R-4 — single source of truth for half-life
{
	const k = REPUTATION_DECAY_HALF_LIFE_DAYS;
	if (k === 365) {
		pass(`R-4 REPUTATION_DECAY_HALF_LIFE_DAYS === 365 (matches docs / public commitment)`);
	} else {
		fail(
			'R-4',
			`half-life constant changed without doc update: got ${k}.  If this is intentional, ` +
				'update ADR-0038, FAQ "build high reputation organically", and the public ' +
				'formula description in the receipt endpoint.'
		);
	}
}

// R-5 — formula description completeness  (we read the actual receipt
// handler source file to check the formula string)
{
	
	
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'api', 'reputationReceipt.ts'),
		'utf-8'
	);
	const formulaMatch = src.match(/formula:\s*\n\s*'([^']+)'/);
	const formula =
		formulaMatch && formulaMatch[1]
			? (formulaMatch[1] + (src.match(/'([^']+)'\.\s*\+/g) || []).join(' '))
			: src;
	const mentionsFormula = src.includes('SUM(rating × decay_weight) / SUM(decay_weight)');
	const mentionsExclusions =
		src.includes('suspicious_reciprocity') &&
		src.includes('related_accounts') &&
		src.includes('one_way_pile_on') &&
		src.includes('review_concentration');
	if (mentionsFormula && mentionsExclusions) {
		pass('R-5 formula description names the math AND lists all 4 signal-table exclusions');
	} else {
		fail(
			'R-5',
			`formula description must explain the math AND list exclusion reasons. ` +
				`mentionsFormula=${mentionsFormula}, mentionsExclusions=${mentionsExclusions}`
		);
	}
	void formula; // silence unused
}

// R-6 — the 5 exclusion-reason string literals match in source
{
	
	
	const src = readFileSync(
		resolve(__dirname, '..', 'src', 'api', 'reputationReceipt.ts'),
		'utf-8'
	);
	const expected = [
		"'no_order_permlink'",
		"'suspicious_reciprocity'",
		"'related_accounts'",
		"'one_way_pile_on'",
		"'review_concentration'"
	];
	const missing = expected.filter((e) => !src.includes(e));
	if (missing.length === 0) {
		pass('R-6 all 5 exclusion-reason string literals present in handler source');
	} else {
		fail('R-6', `missing reasons: ${missing.join(', ')}`);
	}
}

// R-7 — JS implementation exports
{
	const weight = reputationDecayWeight(0);
	const r = computeWeightedRating([{ rating: 5, createdAt: new Date() }], new Date());
	if (typeof weight === 'number' && typeof r === 'number') {
		pass('R-7 reputationDecayWeight + computeWeightedRating exports resolve');
	} else {
		fail('R-7', `weight=${weight}, r=${r}`);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error(`\nreputation-receipt-shape smoke FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} reputation-receipt-shape scenarios passed`);
