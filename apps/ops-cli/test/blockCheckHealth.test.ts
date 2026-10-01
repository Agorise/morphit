/**
 * v1.20.2 (E1) — `morphit-ops health` shows the indexer's report-only block
 * verification (the operator-only `block_check` block of /v1/health).
 */
import { describe, expect, it } from 'vitest';

import { describeBlockCheck, parseBlockCheck, summarizeHealth } from '../src/commands/health.ts';

const body = (o: Record<string, unknown>) => ({
	mode: 'report-only',
	since: '2026-10-01T20:00:00.000Z',
	checked: 120000,
	matched: 120000,
	merkleMismatch: 0,
	idMismatch: 0,
	linkMismatch: 0,
	linksChecked: 119999,
	txidMismatch: {},
	unsupported: {},
	lastBlock: 64135602,
	firstProblems: [],
	...o
});

describe('block check in morphit-ops health', () => {
	it('all matched → green, with the count', () => {
		const s = summarizeHealth({ status: 'ok', block_check: body({}) });
		expect(describeBlockCheck(s.blockCheck!)).toEqual({
			tone: 'ok',
			text: 'report-only — all 120,000 blocks matched'
		});
	});
	it('a real mismatch is the loud case, with where to look', () => {
		const d = describeBlockCheck(
			parseBlockCheck(body({ matched: 119998, merkleMismatch: 1, linkMismatch: 1 }))!
		);
		expect(d.tone).toBe('warn');
		expect(d.text).toContain('2 block(s) did NOT match (merkle 1, link 1)');
		expect(d.text).toContain('journalctl -u morphit-indexer | grep block_verify_problem');
	});
	it('operations this version cannot check yet are named, calmly', () => {
		const d = describeBlockCheck(
			parseBlockCheck(
				body({
					matched: 119990,
					unsupported: { witness_set_properties: 7 },
					txidMismatch: { comment: 3 }
				})
			)!
		);
		expect(d).toEqual({
			tone: 'dim',
			text: 'report-only — 119,990 of 120,000 matched; 10 not checkable by this version yet (witness_set_properties)'
		});
	});
	it('an older indexer has no block_check: nothing to show', () => {
		expect(summarizeHealth({ status: 'ok' }).blockCheck).toBeNull();
	});
});
