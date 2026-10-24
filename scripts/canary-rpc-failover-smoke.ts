#!/usr/bin/env tsx
/**
 * scripts/canary-rpc-failover-smoke.ts
 *
 * the warrant canary used to POST its chain-head request to a
 * single pinned Blurt node. When that node returned 526 (dead TLS cert)
 * the ENTIRE canary refresh stopped, even though Morphit has an RPC
 * rotator that would have hopped to the next node. This smoke locks in the
 * fix: the canary walks the canonical DEFAULT_BLURT_RPC_ENDPOINTS list with
 * real failover, sourced from ONE place.
 *
 * Two kinds of scenario:
 *   A. LOGIC — the pure failover core (blurtHeadFailover.ts) is exercised
 *      with an injected fetchOne, so the walk/stop/null behaviour is proven
 *      with no network at all.
 *   B. WIRING — the CLI (fetch-blurt-head.ts) imports the canonical list
 *      (not a hand-copied one) and runs it through the failover walk, and
 *      generate.sh calls that CLI instead of a single pinned curl. These
 *      are the checks that bite if someone reintroduces the single-node bug.
 *
 *   v1.21.15: a Tor-only node asks its onion nodes all at once (the fastest
 *   valid head wins); a clearnet node whose every clearnet node failed asks
 *   the hidden nodes all at once, through Tor / i2pd only.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	type BlurtHead,
	fetchBlurtHeadFastest,
	fetchBlurtHeadPhased,
	fetchBlurtHeadWithFailover,
	parseHead,
	planCanaryBlurtPhases,
	resolveCanaryNodes,
	canaryDefaultNodes
} from './canary/blurtHeadFailover.js';
import { readTextCapped } from './canary/readCapped.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

console.log('\n── canary RPC failover smoke ──────────────────────────\n');

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}`);
	}
}

const GOOD: BlurtHead = {
	head_block_number: 12_345_678,
	head_block_id: '00bc614e0000000000000000000000000000dead',
	time: '2026-07-11T01:00:00'
};

// ─── A. LOGIC — failover walk (no network) ───────────────────────

async function run(): Promise<void> {
	// Hops past failing nodes to the first that answers, and reports which.
	{
		const tried: string[] = [];
		const fetchOne = async (url: string): Promise<BlurtHead | null> => {
			tried.push(url);
			return url === 'https://c.example' ? GOOD : null;
		};
		const got = await fetchBlurtHeadWithFailover(
			['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'],
			fetchOne
		);
		check(
			'failover hops past dead nodes to the first that answers',
			got !== null && got.url === 'https://c.example' && got.head.head_block_number === 12_345_678
		);
		check(
			'failover tries nodes in order and STOPS at the first success (no d.example)',
			tried.join(',') === 'https://a.example,https://b.example,https://c.example'
		);
	}

	// Every node failing yields null (the caller then exits non-zero).
	{
		const fetchOne = async (): Promise<BlurtHead | null> => null;
		const got = await fetchBlurtHeadWithFailover(
			['https://a.example', 'https://b.example'],
			fetchOne
		);
		check('failover returns null when every node fails', got === null);
	}

	// First node healthy → later nodes are never contacted.
	{
		let calls = 0;
		const fetchOne = async (): Promise<BlurtHead | null> => {
			calls++;
			return GOOD;
		};
		const got = await fetchBlurtHeadWithFailover(
			['https://a.example', 'https://b.example', 'https://c.example'],
			fetchOne
		);
		check('a healthy first node short-circuits the rest (1 call)', got !== null && calls === 1);
	}

	// ─── resolveCanaryNodes semantics ────────────────────────────
	const canonical = ['https://one.example', 'https://two.example', 'https://three.example'];
	check(
		'no override → the FULL canonical list, order preserved',
		resolveCanaryNodes(undefined, canonical).join(',') === canonical.join(',') &&
			resolveCanaryNodes('   ', canonical).join(',') === canonical.join(',')
	);
	// review D12: an override is PREFERRED-FIRST, not exclusive — the walk falls
	// through to the rest so one down node never stalls the canary.
	check(
		'a single override is tried FIRST, then the full list (deduped)',
		resolveCanaryNodes('https://two.example', canonical).join(',') ===
			['https://two.example', 'https://one.example', 'https://three.example'].join(',')
	);
	check(
		'a comma-separated override (all hidden onions) is preferred-first, then the list',
		resolveCanaryNodes('http://a.onion, http://b.onion', canonical).join(',') ===
			['http://a.onion', 'http://b.onion', ...canonical].join(',')
	);
	check(
		'a brand-new override node prepends without dropping the fallback list',
		resolveCanaryNodes('https://pinned.example', canonical).join(',') ===
			['https://pinned.example', ...canonical].join(',')
	);

	// D12 contract: on a tor-only node the default list is EVERY hidden .onion
	// (never clearnet, never just the first); clearnet nodes keep the clearnet list.
	{
		const clear = ['https://c1.example', 'https://c2.example'];
		const hid = [
			'http://aaa.onion',
			'http://aaa.b32.i2p',
			'http://bbb.onion',
			'http://bbb.b32.i2p'
		];
		const tor = canaryDefaultNodes(true, clear, hid);
		check(
			'tor-only default = all .onion entries (not just the first)',
			tor.join(',') === 'http://aaa.onion,http://bbb.onion'
		);
		check('tor-only default never contains clearnet', !tor.some((u) => u.startsWith('https://c')));
		check(
			'clearnet default = the clearnet list',
			canaryDefaultNodes(false, clear, hid).join(',') === clear.join(',')
		);
		// ops/fix-canary-tor2.sh writes a comma list: every entry becomes a node, first.
		check(
			'a comma-list override on tor-only = each onion first, then the rest of the onions',
			resolveCanaryNodes('http://bbb.onion,http://ccc.onion', tor).join(',') ===
				'http://bbb.onion,http://ccc.onion,http://aaa.onion'
		);
	}

	// ─── v1.21.15: phases — race the hidden nodes ─────────────────
	{
		const clear = ['https://c1.example', 'https://c2.example'];
		const hid = ['http://aaa.onion', 'http://aaa.b32.i2p', 'http://bbb.onion'];
		const tor = planCanaryBlurtPhases({
			override: 'http://own.onion',
			torOnly: true,
			clearnet: clear,
			hidden: hid
		});
		check(
			'tor-only: the override first (all at once), then the other default onions all at once — never clearnet',
			tor.length === 2 &&
				tor[0]?.mode === 'race' &&
				tor[0].nodes.join(',') === 'http://own.onion' &&
				tor[1]?.mode === 'race' &&
				tor[1].nodes.join(',') === 'http://aaa.onion,http://bbb.onion'
		);
		const cl = planCanaryBlurtPhases({
			override: 'http://aaa.onion',
			torOnly: false,
			clearnet: clear,
			hidden: hid
		});
		check(
			'clearnet: override + clearnet in order, then the remaining hidden nodes (onion and I2P) all at once',
			cl.length === 2 &&
				cl[0]?.mode === 'walk' &&
				cl[0].nodes.join(',') === 'http://aaa.onion,https://c1.example,https://c2.example' &&
				cl[1]?.mode === 'race' &&
				cl[1].nodes.join(',') === 'http://aaa.b32.i2p,http://bbb.onion'
		);
		const asked: string[] = [];
		const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
		const got = await fetchBlurtHeadPhased(
			planCanaryBlurtPhases({ override: undefined, torOnly: false, clearnet: clear, hidden: hid }),
			async (url) => {
				asked.push(url);
				if (url.startsWith('https://')) return null;
				await delay(url === 'http://bbb.onion' ? 20 : 300);
				return GOOD;
			}
		);
		check(
			'clearnet all failed: the hidden nodes are asked together and the fastest answers',
			got?.url === 'http://bbb.onion' &&
				asked.slice(0, 2).join(',') === clear.join(',') &&
				asked.length === 5
		);
		asked.length = 0;
		await fetchBlurtHeadPhased(
			planCanaryBlurtPhases({ override: undefined, torOnly: false, clearnet: clear, hidden: hid }),
			async (url) => {
				asked.push(url);
				return GOOD;
			}
		);
		check('clearnet answers: no hidden node is asked', asked.join(',') === 'https://c1.example');
		check(
			'race: null when every node fails; a throwing node is just a miss',
			(await fetchBlurtHeadFastest(['a', 'b'], async (u) => {
				if (u === 'a') throw new Error('boom');
				return null;
			})) === null && (await fetchBlurtHeadFastest([], async () => GOOD)) === null
		);
	}

	// ─── parseHead shape guard ───────────────────────────────────
	check('parseHead accepts a well-formed result', parseHead(GOOD) !== null);
	check(
		'parseHead rejects junk (missing / zero / wrong-typed fields)',
		parseHead(null) === null &&
			parseHead({}) === null &&
			parseHead({ head_block_number: 0, head_block_id: 'x', time: 't' }) === null &&
			parseHead({ head_block_number: 5, head_block_id: '', time: 't' }) === null &&
			parseHead({ head_block_number: '5', head_block_id: 'x', time: 't' }) === null
	);
	// v1.21.15: the head goes into a signed canary — its id must be a Blurt
	// block id that carries this height, its time the chain's format.
	check(
		'parseHead rejects a block id that is not 40 hex digits',
		parseHead({ ...GOOD, head_block_id: `${GOOD.head_block_id}00` }) === null &&
			parseHead({ ...GOOD, head_block_id: GOOD.head_block_id.toUpperCase() }) === null &&
			parseHead({ ...GOOD, head_block_id: '00bc614e\n000000000000000000000000000dead' }) === null
	);
	check(
		'parseHead rejects a block id whose first 8 hex digits are not the height',
		parseHead({ ...GOOD, head_block_number: GOOD.head_block_number + 1 }) === null
	);
	check(
		'parseHead rejects a height that is not a safe whole number',
		parseHead({ ...GOOD, head_block_number: 12_345_678.5 }) === null &&
			parseHead({ ...GOOD, head_block_number: 2 ** 60 }) === null
	);
	check(
		'parseHead rejects a time not in the chain format (no zone, whole seconds)',
		parseHead({ ...GOOD, time: '2026-07-11T01:00:00Z' }) === null &&
			parseHead({ ...GOOD, time: 'yesterday' }) === null &&
			parseHead({ ...GOOD, time: '2026-07-11T01:00:00\t1' }) === null
	);

	// ─── answers are read up to 64 KB (v1.21.15) ─────────────────
	{
		const stream = (bytes: number, chunk = 4096): ReadableStream<Uint8Array> => {
			let left = bytes;
			return new ReadableStream({
				pull(ctrl) {
					if (left <= 0) return ctrl.close();
					const n = Math.min(chunk, left);
					left -= n;
					ctrl.enqueue(new Uint8Array(n).fill(0x61));
				}
			});
		};
		check(
			'an answer up to 64 KB is read whole',
			(await readTextCapped(new Response(stream(64 * 1024))))?.length === 64 * 1024 &&
				(await readTextCapped(new Response('{"result":1}'))) === '{"result":1}'
		);
		check(
			'an answer that keeps streaming past 64 KB is cut off and not used',
			(await readTextCapped(new Response(stream(64 * 1024 + 1)))) === null &&
				(await readTextCapped(new Response(stream(10 * 1024 * 1024)))) === null
		);
		check(
			'an answer that says it is larger than 64 KB is not read at all',
			(await readTextCapped(
				new Response(stream(10), { headers: { 'content-length': String(64 * 1024 + 1) } })
			)) === null
		);
		const blurtCli = readFileSync(join(REPO, 'scripts/canary/fetch-blurt-head.ts'), 'utf8');
		const btcCli = readFileSync(join(REPO, 'scripts/canary/fetch-btc-head.ts'), 'utf8');
		check(
			'both head fetchers read every answer through the 64 KB cap (never resp.json() / resp.text())',
			/readTextCapped\(resp\)/.test(blurtCli) &&
				!/\.(json|text)\(\)/.test(blurtCli) &&
				/readTextCapped\(heightResp\)/.test(btcCli) &&
				/readTextCapped\(hashResp\)/.test(btcCli) &&
				/readTextCapped\(resp\)/.test(btcCli) &&
				!/\.(json|text)\(\)/.test(btcCli)
		);
	}

	// ─── B. WIRING — CLI + generate.sh ───────────────────────────
	const cli = readFileSync(join(REPO, 'scripts/canary/fetch-blurt-head.ts'), 'utf8');
	const gen = readFileSync(join(REPO, 'scripts/canary/generate.sh'), 'utf8');

	check(
		'CLI imports DEFAULT_BLURT_RPC_ENDPOINTS from @morphit/operator-config (one source of truth)',
		/import\s*\{[^}]*\bDEFAULT_BLURT_RPC_ENDPOINTS\b[^}]*\}\s*from\s*'@morphit\/operator-config'/.test(
			cli
		)
	);
	check(
		'CLI does NOT hand-copy a Blurt RPC URL list of its own',
		!/https?:\/\/[a-z0-9.-]*blurt[a-z0-9.-]*/i.test(cli)
	);
	check(
		'CLI runs the fetch through the phase plan (walk / race)',
		cli.includes('fetchBlurtHeadPhased(') &&
			/planCanaryBlurtPhases\(\{[^}]*torOnly: canaryIsTorOnly\(\)[^}]*hidden: DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS/.test(
				cli
			)
	);
	check(
		'CLI: a hidden node goes through Tor / i2pd only — skipped with no proxy, the dispatcher on the fetch',
		/if \(isHidden && dispatcher === null\) \{/.test(cli) &&
			(cli.match(/\bfetch\(/g)?.length ?? 0) === 1 &&
			/\bfetch\(url, \{\s*\.\.\.via,/.test(cli)
	);
	check(
		'generate.sh invokes the failover helper via tsx (real call, not a comment)',
		/"\$RUN_TSX"\s+"\$REPO_ROOT\/scripts\/canary\/fetch-blurt-head\.ts"/.test(gen)
	);
	check(
		'generate.sh no longer POSTs get_dynamic_global_properties to a single pinned node',
		!/curl[^\n]*get_dynamic_global_properties/.test(gen) &&
			!/get_dynamic_global_properties[^\n]*curl/.test(gen)
	);

	// ─── verdict ─────────────────────────────────────────────────
	const total = pass + fails.length;
	console.log('\n──────────────────────────────────────────────────────');
	if (fails.length > 0) {
		console.log(`✗ ${fails.length} of ${total} canary-rpc-failover checks FAILED`);
		process.exit(1);
	}
	console.log(`✓ all ${total} canary-rpc-failover scenarios passed`);
}

void run();
