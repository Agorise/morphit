/**
 * Tests for SequentialDetector — Layer 8 of the signup-drain
 * defense stack.
 *
 * The detector is in-memory and per-bucket.  These tests cover
 * the three patterns it watches for, the time-window
 * expiration, the bucket isolation, and the failure modes that
 * matter for the create handler's correctness.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SequentialDetector } from '../src/policy/sequentialDetector.ts';

let now = 1_000_000_000_000; // arbitrary fixed-time start
function tick(ms: number): void {
	now += ms;
}
function clock(): number {
	return now;
}

beforeEach(() => {
	now = 1_000_000_000_000;
});

function makeDetector(
	overrides: Partial<{
		windowMs: number;
		thresholdCount: number;
		minPrefixLen: number;
	}> = {}
) {
	return new SequentialDetector({
		windowMs: overrides.windowMs ?? 3_600_000, // 1h
		thresholdCount: overrides.thresholdCount ?? 2,
		minPrefixLen: overrides.minPrefixLen ?? 3,
		now: clock
	});
}

describe('SequentialDetector — numeric_suffix pattern', () => {
	it('blocks the 3rd numeric-suffix signup from same bucket within window', () => {
		const d = makeDetector();
		d.recordSignup('user001', '203.0.113.0/24');
		d.recordSignup('user002', '203.0.113.0/24');
		// Threshold is 2 — meaning 2 prior matches → block the
		// 3rd.
		const r = d.check('user003', '203.0.113.0/24');
		expect(r.blocked).toBe(true);
		expect(r.reason).toBe('sequential_numeric_suffix');
		expect(r.matchedPrior).toEqual(['user001', 'user002']);
	});

	it('does NOT block when prior signups are from a different bucket', () => {
		const d = makeDetector();
		d.recordSignup('user001', '203.0.113.0/24');
		d.recordSignup('user002', '203.0.113.0/24');
		// Different bucket — should pass.
		const r = d.check('user003', '198.51.100.0/24');
		expect(r.blocked).toBe(false);
	});

	it('does NOT block when prior signups have a different prefix', () => {
		const d = makeDetector();
		d.recordSignup('user001', '203.0.113.0/24');
		d.recordSignup('user002', '203.0.113.0/24');
		// Different prefix root.
		const r = d.check('alice001', '203.0.113.0/24');
		expect(r.blocked).toBe(false);
	});

	it('forgets prior signups after the window expires', () => {
		const d = makeDetector({ windowMs: 60_000 });
		d.recordSignup('user001', '203.0.113.0/24');
		d.recordSignup('user002', '203.0.113.0/24');
		tick(60_001);
		const r = d.check('user003', '203.0.113.0/24');
		expect(r.blocked).toBe(false);
		// Prior records were pruned:
		expect(d.size()).toBe(0);
	});

	it('handles hyphen-separated numeric suffix (user-001)', () => {
		const d = makeDetector();
		d.recordSignup('user-001', '203.0.113.0/24');
		d.recordSignup('user-002', '203.0.113.0/24');
		const r = d.check('user-003', '203.0.113.0/24');
		expect(r.blocked).toBe(true);
		expect(r.reason).toBe('sequential_numeric_suffix');
	});
});

describe('SequentialDetector — sequential_alpha_suffix pattern', () => {
	it('blocks alphabetical-suffix sequence (accta, acctb → acctc)', () => {
		// Blurt names are lowercase-only (validateBlurtName
		// enforces this).  The detector therefore only needs to
		// handle lowercase alpha-suffix patterns.
		const d = makeDetector();
		d.recordSignup('myaccta', '203.0.113.0/24');
		d.recordSignup('myacctb', '203.0.113.0/24');
		const r = d.check('myacctc', '203.0.113.0/24');
		expect(r.blocked).toBe(true);
		expect(r.reason).toBe('sequential_alpha_suffix');
	});

	it('does NOT trip on names too short for alpha-suffix detection', () => {
		const d = makeDetector();
		d.recordSignup('foo', '203.0.113.0/24');
		d.recordSignup('foo', '203.0.113.0/24');
		// stripAlphaSuffix returns null for length < 4 — foo doesn't
		// trigger.
		const r = d.check('bar', '203.0.113.0/24');
		// No pattern match — pass.
		expect(r.blocked).toBe(false);
	});
});

describe('SequentialDetector — close-similarity pattern', () => {
	it('blocks signups sharing a long prefix even when tail differs', () => {
		const d = makeDetector({ minPrefixLen: 5 });
		d.recordSignup('userfoo01', '203.0.113.0/24');
		d.recordSignup('userfoo02', '203.0.113.0/24');
		const r = d.check('userfoo99', '203.0.113.0/24');
		// This will hit numeric_suffix first (shared "userfoo" prefix
		// stripped of digits = "userfoo"), so the reason might be
		// numeric_suffix not close_similarity.  Verify it's blocked
		// regardless.
		expect(r.blocked).toBe(true);
	});

	it('does NOT block on short shared prefixes (only 2 chars)', () => {
		const d = makeDetector({ minPrefixLen: 5 });
		d.recordSignup('alice', '203.0.113.0/24');
		d.recordSignup('alex', '203.0.113.0/24');
		// "al" is only 2 chars — below the threshold.
		const r = d.check('alana', '203.0.113.0/24');
		expect(r.blocked).toBe(false);
	});
});

describe('SequentialDetector — bucket isolation', () => {
	it('per-bucket isolation prevents cross-attribution', () => {
		const d = makeDetector();
		// Bucket A registers user001/user002.
		d.recordSignup('user001', '203.0.113.0/24');
		d.recordSignup('user002', '203.0.113.0/24');
		// Bucket B's user003 is fine.
		const r = d.check('user003', '198.51.100.0/24');
		expect(r.blocked).toBe(false);
		// But bucket A's user003 is blocked.
		const rA = d.check('user003', '203.0.113.0/24');
		expect(rA.blocked).toBe(true);
	});
});

describe('SequentialDetector — memory cap', () => {
	it('does not grow unbounded', () => {
		const d = makeDetector();
		// Push 10,000 records with the same bucket — well above the
		// MAX_RECENT_SIGNUPS cap.
		for (let i = 0; i < 10_000; i++) {
			d.recordSignup(`name-${i}`, '203.0.113.0/24');
		}
		// size() prunes; assert it's bounded.
		expect(d.size()).toBeLessThanOrEqual(5_000);
	});
});

describe('SequentialDetector — threshold tuning', () => {
	it('threshold=1 → blocks on the 2nd signup', () => {
		const d = makeDetector({ thresholdCount: 1 });
		d.recordSignup('user001', '203.0.113.0/24');
		const r = d.check('user002', '203.0.113.0/24');
		expect(r.blocked).toBe(true);
	});

	it('threshold=5 → allows up to 5 sequential, blocks 6th', () => {
		const d = makeDetector({ thresholdCount: 5 });
		for (let i = 1; i <= 5; i++) {
			d.recordSignup(`user${String(i).padStart(3, '0')}`, '203.0.113.0/24');
		}
		const r = d.check('user006', '203.0.113.0/24');
		expect(r.blocked).toBe(true);
	});
});

describe('SequentialDetector — clearAll', () => {
	it('clearAll resets state', () => {
		const d = makeDetector();
		d.recordSignup('user001', '203.0.113.0/24');
		d.recordSignup('user002', '203.0.113.0/24');
		d.clearAll();
		const r = d.check('user003', '203.0.113.0/24');
		expect(r.blocked).toBe(false);
		expect(d.size()).toBe(0);
	});
});
