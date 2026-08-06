/**
 * Morphit smoke — GlobalDailyCeiling persistence (NEW-9 hardening
 * for Finding 5-4).
 *
 * Verifies that when the optional persistPath is set:
 *   - A fresh instance with no file starts at count=0.
 *   - After recordSuccess() calls, the file exists with the
 *     correct count.
 *   - A new instance reading that file restores the count.
 *   - A stale-date file (yesterday's bucket) is ignored on load.
 *   - When persistPath is null, no file is created.
 *
 * Uses the OS tmp dir; cleans up after itself.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GlobalDailyCeiling } from '../../relay/src/policy/globalDailyCeiling.ts';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── daily-ceiling persistence smoke ───────────────────────\n');

const tmpRoot = mkdtempSync(join(tmpdir(), 'morphit-ceiling-smoke-'));

try {
	scenario('no persistPath → in-memory only, no file created', () => {
		const c = new GlobalDailyCeiling(10);
		c.recordSuccess();
		c.recordSuccess();
		if (c.currentCount() !== 2) throw new Error(`expected 2, got ${c.currentCount()}`);
		// Ensure no rogue file appeared in tmp
		const accidental = join(tmpRoot, 'should-not-exist.json');
		if (existsSync(accidental)) throw new Error('unexpected file');
	});

	scenario('persistPath: count saved after recordSuccess', () => {
		const path = join(tmpRoot, 'ceiling-1.json');
		const c = new GlobalDailyCeiling(10, undefined, path);
		c.recordSuccess();
		c.recordSuccess();
		c.recordSuccess();
		if (!existsSync(path)) throw new Error('file not created');
		const raw = readFileSync(path, 'utf-8');
		const parsed = JSON.parse(raw) as { count: number };
		if (parsed.count !== 3) throw new Error(`file count ${parsed.count} != 3`);
	});

	scenario('persistPath: new instance loads existing count', () => {
		const path = join(tmpRoot, 'ceiling-2.json');
		const c1 = new GlobalDailyCeiling(10, undefined, path);
		c1.recordSuccess();
		c1.recordSuccess();
		c1.recordSuccess();
		c1.recordSuccess();

		const c2 = new GlobalDailyCeiling(10, undefined, path);
		if (c2.currentCount() !== 4) {
			throw new Error(`restored count ${c2.currentCount()} != 4`);
		}
		// Recording on the second instance keeps incrementing
		c2.recordSuccess();
		if (c2.currentCount() !== 5) throw new Error('increment broke');
	});

	scenario('persistPath: stale-date file is ignored on load', () => {
		const path = join(tmpRoot, 'ceiling-3.json');
		// Write a yesterday-dated bucket
		writeFileSync(
			path,
			JSON.stringify({
				date: '2000-01-01',
				count: 999,
				hourlyCounts: new Array(24).fill(0)
			})
		);
		const c = new GlobalDailyCeiling(10, undefined, path);
		if (c.currentCount() !== 0) {
			throw new Error(`stale not ignored, got ${c.currentCount()}`);
		}
	});

	scenario('persistPath: malformed JSON is ignored', () => {
		const path = join(tmpRoot, 'ceiling-4.json');
		writeFileSync(path, '{not json');
		const c = new GlobalDailyCeiling(10, undefined, path);
		if (c.currentCount() !== 0) throw new Error('malformed not ignored');
		c.recordSuccess();
		if (c.currentCount() !== 1) throw new Error('post-malformed broken');
	});

	scenario('persistPath: shape-mismatch JSON is ignored', () => {
		const path = join(tmpRoot, 'ceiling-5.json');
		writeFileSync(path, JSON.stringify({ wrong: 'shape' }));
		const c = new GlobalDailyCeiling(10, undefined, path);
		if (c.currentCount() !== 0) throw new Error('mismatch not ignored');
	});

	scenario('persistPath: hourlyCounts also persisted', () => {
		const path = join(tmpRoot, 'ceiling-6.json');
		const c1 = new GlobalDailyCeiling(10, undefined, path);
		c1.recordSuccess();
		c1.recordSuccess();
		const peakBefore = c1.peakHourCount();

		const c2 = new GlobalDailyCeiling(10, undefined, path);
		const peakAfter = c2.peakHourCount();
		if (peakAfter !== peakBefore) {
			throw new Error(`peak ${peakAfter} != ${peakBefore} after restore`);
		}
	});

	scenario('persistPath: ceiling-reached survives restart', () => {
		const path = join(tmpRoot, 'ceiling-7.json');
		const c1 = new GlobalDailyCeiling(2, undefined, path);
		c1.recordSuccess();
		c1.recordSuccess();
		if (c1.canAccept()) throw new Error('should be at ceiling');

		const c2 = new GlobalDailyCeiling(2, undefined, path);
		if (c2.canAccept()) throw new Error('ceiling not honored after restart');
	});
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
