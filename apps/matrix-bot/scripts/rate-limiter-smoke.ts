#!/usr/bin/env tsx
/**
 * Rate-limiter smoke — sliding-window WARN suppression.
 *
 * Uses an in-memory state mock so the smoke runs without SQLite
 * setup.  Same semantics as the SQLite-backed impl.
 */

import { createRateLimiter, type RateLimiter } from '../src/rateLimit.ts';
import type { State } from '../src/state.ts';
import type { StructuredAlert } from '../src/classifier.ts';

function memoryState(): State {
	const deliveries = new Map<string, number>();
	const suppressions: Array<{ category: string; ms: number }> = [];
	const infoEvents: StructuredAlert[] = [];
	return {
		getLastDelivery(cat) {
			return deliveries.get(cat) ?? null;
		},
		setLastDelivery(cat, ms) {
			deliveries.set(cat, ms);
		},
		countSuppressions(cat, sinceMs) {
			return suppressions.filter((s) => s.category === cat && s.ms >= sinceMs).length;
		},
		insertSuppression(cat, ms) {
			suppressions.push({ category: cat, ms });
		},
		pushInfoEvent(alert) {
			infoEvents.push(alert);
		},
		drainInfoEvents() {
			const out = [...infoEvents];
			infoEvents.length = 0;
			return out;
		},
		pruneOlderThan() {
			/* noop */
		},
		close() {
			/* noop */
		}
	};
}

interface Check {
	readonly name: string;
	readonly fn: (rl: RateLimiter, state: State) => string | null;
}

const WINDOW_MS = 60 * 60 * 1000; // 1 hour

const checks: Check[] = [
	{
		name: 'first WARN in a fresh window passes (not limited)',
		fn: (rl) => {
			const now = 1_000_000_000_000;
			return rl.isLimited('test:cat', now) ? 'should NOT be limited on first call' : null;
		}
	},
	{
		name: 'after recordDelivery, second WARN within window is limited',
		fn: (rl) => {
			const now = 1_000_000_000_000;
			rl.recordDelivery('test:cat-2', now);
			const within = now + 30 * 60 * 1000; // 30 min later
			return rl.isLimited('test:cat-2', within)
				? null
				: 'should be limited 30 min after delivery';
		}
	},
	{
		name: 'WARN passes again 1 hour + 1 ms after the recorded delivery',
		fn: (rl) => {
			const now = 1_000_000_000_000;
			rl.recordDelivery('test:cat-3', now);
			const after = now + WINDOW_MS + 1;
			return rl.isLimited('test:cat-3', after)
				? 'should NOT be limited >1h after delivery'
				: null;
		}
	},
	{
		name: 'different categories share no rate budget',
		fn: (rl) => {
			const now = 1_000_000_000_000;
			rl.recordDelivery('test:cat-A', now);
			const within = now + 30 * 60 * 1000;
			return rl.isLimited('test:cat-B', within)
				? 'cat-A delivery must not affect cat-B'
				: null;
		}
	},
	{
		name: 'suppressions counted per-category for digest',
		fn: (rl) => {
			const now = 1_000_000_000_000;
			const sinceMs = now - 24 * 60 * 60 * 1000;
			rl.recordSuppression('test:cat-D', now);
			rl.recordSuppression('test:cat-D', now + 1);
			rl.recordSuppression('test:cat-D', now + 2);
			rl.recordSuppression('test:cat-E', now + 3);
			const dCount = rl.getSuppressedCount('test:cat-D', sinceMs);
			const eCount = rl.getSuppressedCount('test:cat-E', sinceMs);
			if (dCount !== 3) return `expected 3 cat-D suppressions, got ${dCount}`;
			if (eCount !== 1) return `expected 1 cat-E suppression, got ${eCount}`;
			return null;
		}
	},
	{
		name: 'suppressions older than the count window are not counted',
		fn: (rl) => {
			const now = 1_000_000_000_000;
			const window = 60 * 60 * 1000;
			rl.recordSuppression('test:cat-F', now - 2 * window); // outside
			rl.recordSuppression('test:cat-F', now - window / 2); // inside
			const count = rl.getSuppressedCount('test:cat-F', now - window);
			return count === 1 ? null : `expected 1 inside-window, got ${count}`;
		}
	}
];

let pass = 0;
let fail = 0;
console.log('rate-limiter smoke:\n');
for (const c of checks) {
	const state = memoryState();
	const rl = createRateLimiter(state);
	const reason = c.fn(rl, state);
	if (reason === null) {
		console.log(`  ✓ ${c.name}`);
		pass++;
	} else {
		console.error(`  ✗ ${c.name}`);
		console.error(`      ${reason}`);
		fail++;
	}
}
console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} rate-limiter scenarios hold`);
	process.exit(0);
} else {
	console.error(`✗ ${fail} failed, ${pass} passed`);
	process.exit(1);
}
