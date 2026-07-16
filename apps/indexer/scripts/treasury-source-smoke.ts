/**
 * Morphit smoke — TreasurySource resolution policy.
 *
 * Scope: the chain-pin > env > absent precedence, the cache TTL,
 * the request-coalescing, and the "rebuild on address change"
 * detection logic the poller uses.
 *
 * Part 109: viewkey concepts removed entirely.  The
 * TreasurySourceEnvFallback no longer has `xmrViewkey`, the
 * XmrTreasury return shape no longer has `viewkey`, and
 * legacy chain rows that contain a stray `viewkey` field are
 * silently stripped (defense-in-depth — verified below).
 */

import { TreasurySource, type TreasurySourceEnvFallback } from '../src/indexer/treasurySource';

let scenarios = 0;
let failures = 0;

console.log('\n── TreasurySource resolution smoke ───────────────────────\n');

interface FakeRow {
	treasury: unknown;
}

class FakeDatabase {
	public queries: number = 0;
	constructor(private rows: FakeRow[]) {}
	async query<T>(_sql: string): Promise<{ rowCount: number | null; rows: T[] }> {
		this.queries++;
		return { rowCount: this.rows.length, rows: this.rows as unknown as T[] };
	}
	setRows(rows: FakeRow[]): void {
		this.rows = rows;
	}
	withTx<T>(_fn: () => Promise<T>): Promise<T> {
		throw new Error('not implemented in fake');
	}
}

const VALID_BTC_ADDR_1 = 'bc1q' + 'a'.repeat(38);
const VALID_BTC_ADDR_2 = 'bc1q' + 'b'.repeat(38);
const VALID_XMR_ADDR = '4' + 'A'.repeat(94);

const ENV_FALLBACK: TreasurySourceEnvFallback = {
	btcAddress: 'bc1q' + 'e'.repeat(38),
	btcSatoshis: 416,
	xmrAddress: '4' + 'E'.repeat(94),
	xmrPiconero: '781250000',
	// cp474 — REQUIRED since cp372 and absent here until now.  `resolveBlurt`
	// gates on `this.env.blurtBase > 0`; with the field missing that read
	// `undefined > 0` === false, so the env-fallback branch was unreachable in
	// every scenario in this file.
	blurtBase: 3
};

const EMPTY_ENV: TreasurySourceEnvFallback = {
	btcAddress: '',
	btcSatoshis: 0,
	xmrAddress: '',
	xmrPiconero: '',
	// cp474 — 0 is the "operator set nothing" sentinel resolveBlurt tests for.
	blurtBase: 0
};

async function run(): Promise<void> {
	// Case 1: empty DB + env values → env wins.
	{
		const db = new FakeDatabase([]);
		const src = new TreasurySource(db as unknown as never, ENV_FALLBACK);
		const snap = await src.current();
		if (snap.btc?.source !== 'env') throw new Error(`btc source: ${snap.btc?.source}`);
		if (snap.btc?.address !== ENV_FALLBACK.btcAddress) throw new Error('btc env addr');
		if (snap.xmr?.addressSource !== 'env') {
			throw new Error(`xmr addressSource: ${snap.xmr?.addressSource}`);
		}
		if (snap.xmr?.address !== ENV_FALLBACK.xmrAddress) throw new Error('xmr env addr');
		if (snap.hasChainPin !== false) throw new Error('hasChainPin should be false');
		// Part 109: snapshot.xmr MUST NOT have a viewkey field.
		if ('viewkey' in (snap.xmr as object)) {
			throw new Error('Part 109 invariant: xmr snapshot must not expose a viewkey field');
		}
		console.log('  ✓ Part 109: empty DB + env values → env wins, no viewkey field');
		scenarios++;
	}

	// Case 2: empty DB + empty env → both null.
	{
		const db = new FakeDatabase([]);
		const src = new TreasurySource(db as unknown as never, EMPTY_ENV);
		const snap = await src.current();
		if (snap.btc !== null) throw new Error(`btc should be null, got ${JSON.stringify(snap.btc)}`);
		if (snap.xmr !== null) throw new Error(`xmr should be null, got ${JSON.stringify(snap.xmr)}`);
		if (snap.hasChainPin !== false) throw new Error('hasChainPin should be false');
		console.log('  ✓ Part 109: empty DB + empty env → both null');
		scenarios++;
	}

	// Case 3: chain BTC + no chain XMR → BTC chain, XMR env.
	{
		const db = new FakeDatabase([
			{
				treasury: {
					btc: { address: VALID_BTC_ADDR_1, satoshis: 500 },
					xmr: null
				}
			}
		]);
		const src = new TreasurySource(db as unknown as never, ENV_FALLBACK);
		const snap = await src.current();
		if (snap.btc?.source !== 'chain') throw new Error('btc should be chain');
		if (snap.btc?.address !== VALID_BTC_ADDR_1) throw new Error('btc address mismatch');
		if (snap.btc?.satoshis !== 500) throw new Error('btc satoshis');
		if (snap.xmr?.addressSource !== 'env') throw new Error('xmr addressSource should be env');
		if (snap.xmr?.address !== ENV_FALLBACK.xmrAddress) throw new Error('xmr env addr');
		if (snap.hasChainPin !== true) throw new Error('hasChainPin should be true');
		console.log('  ✓ Part 109: chain BTC + env XMR → mixed sources, hasChainPin=true');
		scenarios++;
	}

	// Case 4: chain has XMR address+piconero → XMR also chain-sourced.
	{
		const db = new FakeDatabase([
			{
				treasury: {
					btc: { address: VALID_BTC_ADDR_1, satoshis: 500 },
					xmr: { address: VALID_XMR_ADDR, piconero: '500000' }
				}
			}
		]);
		const src = new TreasurySource(db as unknown as never, ENV_FALLBACK);
		const snap = await src.current();
		if (snap.btc?.source !== 'chain') throw new Error('btc should be chain');
		if (snap.xmr?.addressSource !== 'chain') {
			throw new Error('xmr addressSource should be chain');
		}
		if (snap.xmr?.address !== VALID_XMR_ADDR) throw new Error('xmr address mismatch');
		if (snap.xmr?.piconero !== '500000') throw new Error('xmr piconero');
		if ('viewkey' in (snap.xmr as object)) {
			throw new Error('Part 109 invariant: chain-sourced xmr must not have viewkey field');
		}
		console.log('  ✓ Part 109: chain BTC + chain XMR → both chain-sourced');
		scenarios++;
	}

	// Case 4b: legacy/hostile chain row contains a viewkey field.
	// TreasurySource MUST strip it.
	{
		const db = new FakeDatabase([
			{
				treasury: {
					btc: null,
					xmr: {
						address: VALID_XMR_ADDR,
						viewkey: 'f'.repeat(64), // hostile/stale field
						piconero: '500000'
					}
				}
			}
		]);
		const src = new TreasurySource(db as unknown as never, ENV_FALLBACK);
		const snap = await src.current();
		if (snap.xmr === null) throw new Error('xmr should be populated');
		if ('viewkey' in (snap.xmr as object)) {
			throw new Error(
				`Part 109 invariant violated: legacy chain-side viewkey leaked into ` +
					`snapshot.  Got ${JSON.stringify(snap.xmr)}`
			);
		}
		console.log(
			'  ✓ Part 109: legacy/hostile chain-row viewkey is stripped, never propagates'
		);
		scenarios++;
	}

	// Case 4c: community-operator state — chain XMR address, env
	// address empty.  Pre-Part-108++ this would mean "verifier
	// disabled"; in Part 109 the verifier works fine (per-payment
	// proofs from users; no operator-side viewkey required).
	{
		const partialEnv: TreasurySourceEnvFallback = {
			btcAddress: '',
			btcSatoshis: 0,
			xmrAddress: '',
			xmrPiconero: '',
			blurtBase: 0 // cp474 — required since cp372
		};
		const db = new FakeDatabase([
			{
				treasury: {
					btc: null,
					xmr: { address: VALID_XMR_ADDR, piconero: '500000' }
				}
			}
		]);
		const src = new TreasurySource(db as unknown as never, partialEnv);
		const snap = await src.current();
		if (snap.xmr === null) throw new Error('xmr should be populated (chain has address)');
		if (snap.xmr.address !== VALID_XMR_ADDR) throw new Error('address mismatch');
		if (snap.xmr.addressSource !== 'chain') throw new Error('addressSource should be chain');
		if ('viewkey' in (snap.xmr as object)) {
			throw new Error('Part 109: viewkey field must not appear');
		}
		console.log(
			'  ✓ Part 109: community-operator inherits chain address, no viewkey concept'
		);
		scenarios++;
	}

	// Case 5: cache TTL — second call within TTL hits cache.
	{
		let now = 1_000_000_000_000;
		const clock = () => now;
		const db = new FakeDatabase([
			{ treasury: { btc: { address: VALID_BTC_ADDR_1, satoshis: 500 }, xmr: null } }
		]);
		const src = new TreasurySource(db as unknown as never, ENV_FALLBACK, 30_000, clock);
		// cp474 — read the counter into a fresh local at each checkpoint. Comparing
		// `db.queries` directly let TS narrow it to the literal `1` at the first
		// guard and keep that narrowing across the awaits (it can't see
		// `src.current()` mutate the fake), which made the final `!== 2` look
		// like an impossible comparison.
		await src.current();
		const afterFirst = db.queries;
		if (afterFirst !== 1) throw new Error(`first call queries=${afterFirst}`);
		now += 10_000; // within TTL
		await src.current();
		const afterCached = db.queries;
		if (afterCached !== 1) throw new Error(`cached call queried again, queries=${afterCached}`);
		now += 30_000; // past TTL
		await src.current();
		const afterTtl = db.queries;
		if (afterTtl !== 2) {
			throw new Error(`past-TTL call did not requery, queries=${afterTtl}`);
		}
		console.log('  ✓ Part 109: cache TTL respected, requery after expiry');
		scenarios++;
	}

	// Case 6: refresh() forces past cache.
	{
		const db = new FakeDatabase([
			{ treasury: { btc: { address: VALID_BTC_ADDR_1, satoshis: 500 }, xmr: null } }
		]);
		const src = new TreasurySource(db as unknown as never, ENV_FALLBACK);
		await src.current();
		await src.refresh();
		if (db.queries !== 2) throw new Error(`refresh did not bypass cache, queries=${db.queries}`);
		console.log('  ✓ Part 109: refresh() bypasses cache');
		scenarios++;
	}

	// Case 7: chain → env transition.
	{
		const db = new FakeDatabase([
			{ treasury: { btc: { address: VALID_BTC_ADDR_1, satoshis: 500 }, xmr: null } }
		]);
		const src = new TreasurySource(db as unknown as never, ENV_FALLBACK);
		const snap1 = await src.current();
		if (snap1.btc?.source !== 'chain') throw new Error('first snapshot should be chain');
		db.setRows([]);
		await src.refresh();
		const snap2 = await src.current();
		if (snap2.btc?.source !== 'env') throw new Error('after un-pin, should be env');
		console.log('  ✓ Part 109: chain → env when chain pin disappears');
		scenarios++;
	}

	// Case 8: address rotation triggers rebuild detection.
	{
		const db = new FakeDatabase([
			{ treasury: { btc: { address: VALID_BTC_ADDR_1, satoshis: 500 }, xmr: null } }
		]);
		const src = new TreasurySource(db as unknown as never, ENV_FALLBACK);
		const snap1 = await src.current();
		const addr1 = snap1.btc?.address;
		db.setRows([
			{ treasury: { btc: { address: VALID_BTC_ADDR_2, satoshis: 500 }, xmr: null } }
		]);
		await src.refresh();
		const snap2 = await src.current();
		const addr2 = snap2.btc?.address;
		if (addr1 === addr2) throw new Error('address should have changed');
		if (addr2 !== VALID_BTC_ADDR_2) throw new Error('new address');
		console.log('  ✓ Part 109: pinned address rotation visible after refresh');
		scenarios++;
	}

	// Case 9: DB query throws → falls back to env.
	{
		const db = {
			async query() {
				throw new Error('connection refused');
			}
		};
		const src = new TreasurySource(db as unknown as never, ENV_FALLBACK);
		const snap = await src.current(); // should not throw
		if (snap.btc?.source !== 'env') throw new Error('DB error should fall back to env');
		console.log('  ✓ Part 109: DB error → env fallback (no throw)');
		scenarios++;
	}

	// Case 10: env-only XMR with empty piconero → null.
	{
		const partialEnv: TreasurySourceEnvFallback = {
			btcAddress: '',
			btcSatoshis: 0,
			xmrAddress: VALID_XMR_ADDR,
			xmrPiconero: '',
			blurtBase: 0 // cp474 — required since cp372
		};
		const db = new FakeDatabase([]);
		const src = new TreasurySource(db as unknown as never, partialEnv);
		const snap = await src.current();
		if (snap.xmr !== null) {
			throw new Error('partial env XMR (empty piconero) should resolve to null');
		}
		console.log('  ✓ Part 109: partial env XMR (empty piconero) → resolves to null');
		scenarios++;
	}

	console.log(`\n${'─'.repeat(54)}`);
	if (failures === 0) {
		console.log(`✓ all ${scenarios} scenarios passed`);
		process.exit(0);
	} else {
		console.log(`✗ ${failures}/${scenarios} scenarios failed`);
		process.exit(1);
	}
}

void run();
