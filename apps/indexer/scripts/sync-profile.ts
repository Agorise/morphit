#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/sync-profile.ts  (cp762 — diagnostic, not a smoke)
 *
 * WHY: "the initial chain sync takes days" — before optimising, MEASURE where
 * the wall-clock actually goes, because the fix differs completely by regime:
 *   - FETCH-bound  → the RPC pool / Tor latency / node historical-serving is
 *                    the wall. More clearnet nodes barely help; a co-located
 *                    blurtd fed by a block_log / a Postgres snapshot does.
 *   - APPLY-bound  → CPU in the op dispatch or the per-window DB commit is the
 *                    wall. Batch/DB tuning is the lever.
 *
 * This runs the REAL fetch primitive (`BlurtClient.getBlocks`) against the
 * indexer's REAL configured pool, over whatever transport that pool uses
 * (clearnet or, after a tor-only re-provision, hidden-only over Tor). It then
 * projects the full-sync fetch time and — only with --with-db — probes the
 * per-window commit cost. It is SAFE to run alongside a live sync:
 *   - fetch profiling is READ-ONLY (no DB connection at all);
 *   - the commit probe (--with-db) writes ONLY to an isolated, dropped-at-exit
 *     table `_morphit_syncprofile_probe`, never to any indexer table.
 *
 * Run on a node (env sourced from its indexer.env), repo root = /opt/morphit:
 *   set -a; . /etc/morphit/indexer.env; set +a
 *   node_modules/.bin/tsx --tsconfig tsconfig.smoke.json \
 *     apps/indexer/scripts/sync-profile.ts --windows 12
 *
 * Flags:
 *   --windows N   sample windows to fetch           (default 12)
 *   --batch N     blocks per window                 (default 20 = BLOCK_FETCH_BATCH)
 *   --from N      first block to sample             (default: config.startBlock —
 *                 the oldest blocks, the realistic worst case for node serving)
 *   --with-db     also probe per-window commit cost (opt-in; touches an isolated table)
 *   --json        machine-readable output
 */
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/config/index.ts';
import { BlurtClient } from '../src/blurt/client.ts';
import { createDatabase } from '../src/db/pool.ts';

const BLOCK_FETCH_BATCH = 20; // mirrors poller.ts

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const asJson = has('json');

function num(v: string | undefined, dflt: number): number {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function pct(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN;
	const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[i]!;
}
const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
function fmtDur(ms: number): string {
	const s = ms / 1000;
	if (s < 90) return `${s.toFixed(1)}s`;
	const m = s / 60;
	if (m < 90) return `${m.toFixed(1)} min`;
	const h = m / 60;
	if (h < 48) return `${h.toFixed(1)} hours`;
	return `${(h / 24).toFixed(1)} days`;
}

async function main(): Promise<void> {
	const config = loadConfig();
	const client = new BlurtClient(config);

	const windows = num(flag('windows'), 12);
	const batch = num(flag('batch'), BLOCK_FETCH_BATCH);
	const endpointCount = Math.max(1, client.endpointCount());
	const concurrency = config.backfillConcurrency > 0 ? config.backfillConcurrency : endpointCount;

	// Chain distance the real initial sync must cover.
	const dgp = await client.getDynamicGlobalProperties();
	const head = dgp.head_block_number;
	const startBlock = config.startBlock;
	const from = num(flag('from'), startBlock);
	const backlog = Math.max(0, head - startBlock);

	const out = (s: string): void => {
		if (!asJson) console.log(s);
	};

	out('\n── indexer sync profiler (cp762) ──────────────────────');
	out(`  endpoints in pool ....... ${endpointCount}`);
	out(`  backfill concurrency .... ${concurrency}${config.backfillConcurrency > 0 ? '' : ' (auto = one window per endpoint)'}`);
	out(`  chain head .............. ${head.toLocaleString()}`);
	out(`  sync start block ........ ${startBlock.toLocaleString()}`);
	out(`  full backlog ............ ${backlog.toLocaleString()} blocks`);
	out(`  sampling ................ ${windows} window(s) × ${batch} block(s), from ${from.toLocaleString()}`);
	out('');

	// ── FETCH PROFILE ─────────────────────────────────────────────
	// Fetch `windows` contiguous windows, rotating the starting endpoint each
	// window (offset = w % endpointCount) exactly like the poller, so slow/dead
	// endpoints show up as slow windows or nulls.
	const windowMs: number[] = [];
	const perOffsetMs = new Map<number, number[]>();
	let blocksServed = 0;
	let blocksMissing = 0;
	let firstErr = '';
	const fetched: unknown[][] = [];

	for (let w = 0; w < windows; w++) {
		const lo = from + w * batch;
		const nums: number[] = [];
		for (let b = lo; b < lo + batch; b++) nums.push(b);
		const offset = w % endpointCount;
		const t0 = performance.now();
		try {
			const blocks = await client.getBlocks(nums, offset);
			const dt = performance.now() - t0;
			windowMs.push(dt);
			(perOffsetMs.get(offset) ?? perOffsetMs.set(offset, []).get(offset)!).push(dt);
			const served = blocks.filter((b) => b != null).length;
			blocksServed += served;
			blocksMissing += blocks.length - served;
			fetched.push(blocks.filter((b) => b != null) as unknown[]);
		} catch (err) {
			const dt = performance.now() - t0;
			windowMs.push(dt);
			blocksMissing += batch;
			if (!firstErr) firstErr = err instanceof Error ? err.message : String(err);
		}
	}

	const sorted = [...windowMs].sort((a, b) => a - b);
	const medWin = pct(sorted, 50);
	const p90Win = pct(sorted, 90);
	const minWin = sorted[0] ?? NaN;
	const maxWin = sorted[sorted.length - 1] ?? NaN;
	// Per-window blocks/sec, then project across the whole backlog assuming the
	// poller keeps `concurrency` windows in flight (best case: perfect overlap).
	const totalWindows = Math.ceil(backlog / batch);
	const projFetchMs = (totalWindows * medWin) / Math.max(1, concurrency);

	out('  FETCH (real getBlocks against the live pool):');
	out(`    window latency ........ median ${fmtMs(medWin)} · p90 ${fmtMs(p90Win)} · min ${fmtMs(minWin)} · max ${fmtMs(maxWin)}`);
	out(`    blocks served/missing . ${blocksServed}/${blocksMissing}${blocksMissing > 0 ? '  ⚠ some endpoints did not serve the sampled (old) blocks' : ''}`);
	if (firstErr) out(`    first fetch error ..... ${firstErr}`);
	for (const [offset, arr] of [...perOffsetMs.entries()].sort((a, b) => a[0] - b[0])) {
		const s = [...arr].sort((x, y) => x - y);
		out(`    endpoint offset ${offset} ..... median ${fmtMs(pct(s, 50))} over ${arr.length} window(s)`);
	}
	out(`    ➜ projected FETCH-only time for the ${backlog.toLocaleString()}-block backlog`);
	out(`      (${totalWindows.toLocaleString()} windows ÷ concurrency ${concurrency} × median ${fmtMs(medWin)}): ~${fmtDur(projFetchMs)}`);
	out('');

	// ── APPLY-CPU PROXY (no DB) ───────────────────────────────────
	// Real applyBlock also does per-op DB work; here we measure only the CPU to
	// walk each fetched block's transactions/ops (a proxy + a lower bound). If
	// this is tiny next to FETCH, the regime is fetch-bound and this proxy is
	// enough; if FETCH is small, build a full applyBlock profiler next.
	let ops = 0;
	let txs = 0;
	const tParse0 = performance.now();
	for (const win of fetched) {
		for (const blk of win as Array<{ transactions?: Array<{ operations?: unknown[] }> }>) {
			const t = blk?.transactions ?? [];
			txs += t.length;
			for (const tx of t) ops += tx.operations?.length ?? 0;
		}
	}
	const parseMs = performance.now() - tParse0;
	const parsedBlocks = fetched.reduce((n, w) => n + w.length, 0);
	const perBlockParseMs = parsedBlocks > 0 ? parseMs / parsedBlocks : 0;
	out('  APPLY-CPU proxy (op-walk over fetched blocks, no DB):');
	out(`    ${parsedBlocks} block(s): ${txs} tx / ${ops} op · ${fmtMs(perBlockParseMs)}/block`);
	out(`    ➜ projected op-walk for backlog: ~${fmtDur(perBlockParseMs * backlog)} (proxy/lower-bound)`);
	out('');

	// ── COMMIT PROBE (opt-in, isolated table) ─────────────────────
	let projCommitMs = NaN;
	if (has('with-db')) {
		const db = createDatabase(config);
		try {
			const commitMs: number[] = [];
			// Isolated, WAL-logged table so the commit fsync cost is REAL (a TEMP
			// table would be unlogged and under-measure). Dropped at the end.
			await db.withTx(async (c) => {
				await c.query('CREATE TABLE IF NOT EXISTS _morphit_syncprofile_probe (n bigint, at timestamptz default now())');
			});
			const probes = Math.max(8, windows);
			for (let i = 0; i < probes; i++) {
				const t0 = performance.now();
				await db.withTx(async (c) => {
					// ~batch rows/commit ≈ one window's worth of writes.
					for (let r = 0; r < batch; r++) {
						await c.query('INSERT INTO _morphit_syncprofile_probe (n) VALUES ($1)', [i * batch + r]);
					}
				});
				commitMs.push(performance.now() - t0);
			}
			await db.withTx(async (c) => {
				await c.query('DROP TABLE IF EXISTS _morphit_syncprofile_probe');
			});
			const cs = [...commitMs].sort((a, b) => a - b);
			const medCommit = pct(cs, 50);
			projCommitMs = totalWindows * medCommit; // one commit per window, serial
			out('  COMMIT probe (isolated table, ~1 window of rows per tx):');
			out(`    per-window commit ..... median ${fmtMs(medCommit)} · min ${fmtMs(cs[0]!)} · max ${fmtMs(cs[cs.length - 1]!)}`);
			out(`    ➜ projected COMMIT time for backlog (${totalWindows.toLocaleString()} serial commits): ~${fmtDur(projCommitMs)}`);
			out('');
		} finally {
			await db.close();
		}
	} else {
		out('  COMMIT probe: skipped (pass --with-db to measure per-window commit cost).');
		out('');
	}

	// ── VERDICT ───────────────────────────────────────────────────
	const applyProxyMs = perBlockParseMs * backlog;
	const dbMs = Number.isFinite(projCommitMs) ? projCommitMs : 0;
	const verdict =
		projFetchMs >= Math.max(applyProxyMs, dbMs) * 2
			? 'FETCH-BOUND — the RPC pool / transport is the wall. A co-located blurtd fed by a block_log or a Postgres snapshot fixes this; adding clearnet nodes or dropping tor-only barely moves it.'
			: dbMs > projFetchMs && dbMs >= applyProxyMs
				? 'COMMIT-BOUND — per-window DB commit dominates. Bigger windows, synchronous_commit off during backfill, and deferred index builds are the levers.'
				: applyProxyMs > projFetchMs
					? 'APPLY-CPU-BOUND (by the proxy) — worth a full applyBlock profiler before optimising.'
					: 'MIXED — no single term dominates by 2×; capture a longer sample (more --windows) and re-run.';

	if (asJson) {
		console.log(
			JSON.stringify({
				endpointCount,
				concurrency,
				head,
				startBlock,
				backlog,
				fetch: { medianWindowMs: medWin, p90WindowMs: p90Win, blocksServed, blocksMissing, projectedMs: projFetchMs },
				applyProxy: { perBlockMs: perBlockParseMs, projectedMs: applyProxyMs, txs, ops },
				commit: { projectedMs: projCommitMs },
				verdict
			})
		);
	} else {
		out('  ── VERDICT ──────────────────────────────────────────');
		out(`  ${verdict}`);
		out('');
	}
}

main().catch((err) => {
	console.error('sync-profile failed:', err instanceof Error ? err.message : err);
	process.exit(1);
});
