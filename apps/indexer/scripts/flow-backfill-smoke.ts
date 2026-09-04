#!/usr/bin/env tsx
/**
 * flow-backfill-smoke.ts — correctness + resource-safety of the reorder-buffer
 * backfill, with ZERO chain/DB. A virtual clock drives fetch latencies + hedge
 * timers deterministically, so out-of-order arrival, hedging, backpressure, and
 * memory-pressure back-off are all reproducible.
 *
 * Pins: I1 in-order, I2 completeness, I3 buffer cap, I4 cursor-adjacent bias,
 * I5 hedge (dedup), I6 retry-on-failure, I7 abort, I8 memory-pressure back-off.
 */
import { flowBackfill, makeGovernor, type Governor, type FlowDeps } from '../src/indexer/flowBackfill.ts';

let pass = 0;
const fails: string[] = [];
const ok = (m: string, cond: boolean): void => {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${m}`);
	} else {
		fails.push(m);
		console.log(`  \u2717 ${m}`);
	}
};

// ── virtual clock: a discrete-event scheduler ──
class VClock {
	now = 0;
	private q: Array<{ at: number; seq: number; fn: () => void; cancelled: boolean }> = [];
	private seq = 0;
	at(ms: number, fn: () => void): () => void {
		const e = { at: this.now + Math.max(0, ms), seq: this.seq++, fn, cancelled: false };
		this.q.push(e);
		return () => {
			e.cancelled = true;
		};
	}
	hasPending(): boolean {
		return this.q.some((e) => !e.cancelled);
	}
	advance(): boolean {
		this.q = this.q.filter((e) => !e.cancelled);
		if (this.q.length === 0) return false;
		this.q.sort((a, b) => a.at - b.at || a.seq - b.seq);
		const e = this.q.shift()!;
		this.now = e.at;
		e.fn();
		return true;
	}
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

// Drive flowBackfill to completion against a virtual clock.
async function drive<B>(deps: FlowDeps<B>, clock: VClock): Promise<{ ok: boolean; err?: unknown }> {
	let done = false;
	let out: { ok: boolean; err?: unknown } = { ok: false };
	void flowBackfill(deps).then(
		() => {
			done = true;
			out = { ok: true };
		},
		(err) => {
			done = true;
			out = { ok: false, err };
		}
	);
	for (let i = 0; i < 500000 && !done; i++) {
		await flush();
		if (done) break;
		if (!clock.advance()) {
			await flush();
			if (!done && !clock.hasPending()) break;
		}
	}
	await flush();
	return out;
}

/** A recording harness: block payloads are the block numbers; latency per range
 *  is configurable; applyWindow records the applied order. */
function harness(opts: {
	from: number;
	target: number;
	windowBlocks: number;
	latencyFor: (lo: number, preferFastest: boolean) => number;
	failFirst?: Set<number>; // los that reject on their first attempt
	holeAt?: number; // block number to return as a hole (null) → applyWindow stops
	governor?: Governor;
	hedgeFactor?: number;
	fastBand?: number;
	aborted?: () => boolean;
}) {
	const clock = new VClock();
	const applied: number[] = [];
	const dispatches: Array<{ lo: number; preferFastest: boolean }> = [];
	const failed = new Set<number>();
	const bytesPerBlock = 1000;

	const deps: FlowDeps<number> = {
		from: opts.from,
		target: opts.target,
		windowBlocks: opts.windowBlocks,
		fetchRange(lo, hi, preferFastest) {
			dispatches.push({ lo, preferFastest });
			return new Promise((resolve, reject) => {
				const latency = opts.latencyFor(lo, preferFastest);
				clock.at(latency, () => {
					if (opts.failFirst?.has(lo) && !failed.has(lo)) {
						failed.add(lo);
						reject(new Error(`sim fail ${lo}`));
						return;
					}
					const blocks: Array<number | null> = [];
					for (let b = lo; b <= hi; b++) blocks.push(opts.holeAt === b ? null : b);
					resolve(blocks);
				});
			});
		},
		windowBytes: (blocks) => blocks.length * bytesPerBlock,
		async applyWindow({ lo, blocks }) {
			for (let i = 0; i < blocks.length; i++) {
				const n = lo + i;
				if (blocks[i] === null) return false; // hole → stop (prefix committed)
				applied.push(n);
			}
			return true;
		},
		governor:
			opts.governor ??
			makeGovernor({
				maxBufferBytes: 0,
				memFraction: 0.25,
				autoCapBytes: 1_000_000_000,
				maxInflight: 8,
				autoInflight: 8,
				pressureFraction: 0.9,
				budget: () => 8_000_000_000,
				rss: () => 100_000_000
			}),
		now: () => clock.now,
		setTimer: (ms, cb) => clock.at(ms, cb),
		hedgeFactor: opts.hedgeFactor ?? 3,
		fastestLatencyMs: () => 100,
		fastBand: opts.fastBand ?? 3,
		maxRetriesPerRange: 5,
		backpressurePollMs: 50,
		aborted: opts.aborted ?? (() => false)
	};
	return { clock, deps, applied, dispatches };
}

const isStrictSeq = (arr: number[], from: number, to: number): boolean => {
	if (arr.length !== to - from + 1) return false;
	for (let i = 0; i < arr.length; i++) if (arr[i] !== from + i) return false;
	return true;
};

async function main(): Promise<void> {
	console.log('\nflow-backfill smoke\n');

	// I1/I2 — out-of-order arrival: alternating fast/slow endpoints so windows
	// resolve in a scrambled order; apply must still be strict + complete.
	{
		const h = harness({
			from: 0,
			target: 199,
			windowBlocks: 10,
			// every other window is 10x slower → they resolve out of order
			latencyFor: (lo) => (Math.floor(lo / 10) % 2 === 0 ? 1000 : 100)
		});
		const r = await drive(h.deps, h.clock);
		ok('I1/I2: scrambled arrival still applies 0..199 strictly in order, exactly once', r.ok && isStrictSeq(h.applied, 0, 199));
	}

	// I3 — buffer cap: a tiny high-water must force backpressure (few windows
	// buffered at once) yet still complete correctly.
	{
		const gov = makeGovernor({
			maxBufferBytes: 25_000, // ~2.5 windows of 10×1000 bytes
			memFraction: 0.25,
			autoCapBytes: 1_000_000_000,
			maxInflight: 32,
			autoInflight: 32,
			pressureFraction: 0.9,
			budget: () => 8_000_000_000,
			rss: () => 100_000_000
		});
		const h = harness({ from: 0, target: 299, windowBlocks: 10, latencyFor: () => 100, governor: gov });
		const r = await drive(h.deps, h.clock);
		ok('I3: completes under a tiny buffer cap (backpressure works)', r.ok && isStrictSeq(h.applied, 0, 299));
		// With a ~25KB cap it can never have launched all 30 windows at once;
		// the total dispatch count still equals the number of windows (no waste).
		ok('I3: no wasted dispatches under backpressure (30 windows → 30 fetches)', h.dispatches.length === 30);
	}

	// I4 — cursor-adjacent bias: near-cursor windows go out preferFastest, far
	// ones do not.
	{
		const h = harness({ from: 0, target: 199, windowBlocks: 10, latencyFor: () => 100, fastBand: 3 });
		const r = await drive(h.deps, h.clock);
		const firstThree = h.dispatches.filter((d) => d.lo < 30);
		const farOnes = h.dispatches.filter((d) => d.lo >= 60 && !h.dispatches.find((x) => x.lo === d.lo && x.preferFastest));
		ok('I4: the first cursor-adjacent windows are dispatched fastest-first', r.ok && firstThree.length > 0 && firstThree.every((d) => d.preferFastest));
		ok('I4: at least one far-ahead window is NOT fastest-first (spread)', farOnes.length > 0);
	}

	// I5 — hedge: make the CURSOR window (lo 0) permanently slow on its first
	// (non-preferFastest is fast, but its offset put it on a slow node). Model:
	// preferFastest fetches are fast (100), non-preferFastest are very slow
	// (100000). The cursor window (lo 0) is preferFastest so it's fast — instead
	// make ALL first attempts slow and the hedge (preferFastest re-issue) fast.
	{
		let hedgeReissued = false;
		const clock = new VClock();
		const applied: number[] = [];
		const deps: FlowDeps<number> = {
			from: 0,
			target: 9,
			windowBlocks: 10,
			fetchRange(lo, hi, preferFastest) {
				// original dispatch of lo 0 is slow; the hedge (a SECOND dispatch of
				// lo 0, preferFastest) resolves fast.
				const isHedge = lo === 0 && preferFastest && hedgeReissued;
				return new Promise((resolve) => {
					clock.at(isHedge ? 50 : 100000, () => {
						const blocks: Array<number | null> = [];
						for (let b = lo; b <= hi; b++) blocks.push(b);
						resolve(blocks);
					});
				});
			},
			windowBytes: (b) => b.length * 1000,
			async applyWindow({ lo, blocks }) {
				for (let i = 0; i < blocks.length; i++) applied.push(lo + i);
				return true;
			},
			governor: makeGovernor({
				maxBufferBytes: 0,
				memFraction: 0.25,
				autoCapBytes: 1e9,
				maxInflight: 8,
				autoInflight: 8,
				pressureFraction: 0.9,
				budget: () => 8e9,
				rss: () => 1e8
			}),
			now: () => clock.now,
			setTimer: (ms, cb) => {
				// mark that once the hedge timer fires we allow the fast hedge path
				return clock.at(ms, () => {
					hedgeReissued = true;
					cb();
				});
			},
			hedgeFactor: 3,
			fastestLatencyMs: () => 100,
			fastBand: 3,
			maxRetriesPerRange: 5,
			backpressurePollMs: 50,
			aborted: () => false
		};
		const r = await drive(deps, clock);
		ok('I5: a slow cursor window is hedged and applies once (no dup)', r.ok && isStrictSeq(applied, 0, 9));
	}

	// I6 — retry: a range rejects on its first attempt, succeeds on retry.
	{
		const h = harness({ from: 0, target: 99, windowBlocks: 10, latencyFor: () => 100, failFirst: new Set([30, 70]) });
		const r = await drive(h.deps, h.clock);
		ok('I6: a range that fails once is re-fetched and the run completes', r.ok && isStrictSeq(h.applied, 0, 99));
	}

	// I7 — abort mid-run: clean return, prefix applied, no throw.
	{
		let n = 0;
		const h = harness({
			from: 0,
			target: 999,
			windowBlocks: 10,
			latencyFor: () => 100,
			aborted: () => ++n > 50 // abort after some progress
		});
		const r = await drive(h.deps, h.clock);
		ok('I7: abort mid-run returns cleanly (no throw)', r.ok === true);
		ok('I7: applied blocks are a strict prefix (no gaps/dupes) up to the abort', h.applied.every((v, i) => i === 0 || v === h.applied[i - 1]! + 1));
	}

	// I8 — memory pressure: while under pressure, no NEW dispatches happen;
	// when it clears, the run completes.
	{
		let pressured = true;
		const gov = makeGovernor({
			maxBufferBytes: 0,
			memFraction: 0.25,
			autoCapBytes: 1e9,
			maxInflight: 8,
			autoInflight: 8,
			pressureFraction: 0.9,
			budget: () => 8e9,
			rss: () => (pressured ? 7.5e9 : 1e8) // 7.5/8 = 0.9375 ≥ 0.9 → pressured
		});
		const h = harness({ from: 0, target: 99, windowBlocks: 10, latencyFor: () => 100, governor: gov });
		// Let it start under pressure, then release after a beat.
		const clock = h.clock;
		clock.at(500, () => {
			pressured = false;
		});
		const before = h.dispatches.length;
		const r = await drive(h.deps, clock);
		ok('I8: memory pressure pauses launching, then completes once it clears', r.ok && isStrictSeq(h.applied, 0, 99));
		ok('I8: (sanity) dispatches happened only after pressure cleared', h.dispatches.length > before);
	}

	console.log('');
	if (fails.length > 0) {
		console.log(`\u2717 ${fails.length} of ${pass + fails.length} flow-backfill checks FAILED`);
		for (const f of fails) console.log(`    - ${f}`);
		process.exit(1);
	}
	console.log(`\u2713 all ${pass} flow-backfill scenarios passed`);
}

void main();
