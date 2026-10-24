#!/usr/bin/env tsx
/**
 * scripts/canary-btc-failover-smoke.ts
 *
 * the canary hit blockstream.info alone for its Bitcoin freshness
 * proof, no fallback + fatal abort; a single timeout killed the whole refresh.
 * widened to FIVE independent providers (Blockstream, mempool.space,
 * Blockchain.com, Blockchair, BlockCypher), each with its own HTTP shape, plus
 * six independent news feeds. This smoke locks that in:
 *
 *   v1.21.15: the hidden (onion) explorers join in — first and all at once
 *   (fastest valid answer wins) on a Tor-only node; on a clearnet node only
 *   after every clearnet source failed — and only ever through Tor / i2pd.
 *
 *   A. LOGIC — the pure core (btcHeadFailover.ts): the failover walk hops/stops
 *      with an injected fetchOne, and `parseBtcSourceBody` extracts a tip from
 *      EACH provider shape (and rejects junk) — all with no network.
 *   B. WIRING — the source list is the canonical one from operator-config (≥5
 *      providers across heterogeneous shapes), the CLI dispatches through the
 *      pure parser + failover walk, generate.sh calls the CLI and degrades
 *      instead of aborting, and the news line has ≥5 independent feeds.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DEFAULT_BTC_I2P_EXPLORERS,
	DEFAULT_BTC_ONION_EXPLORERS,
	DEFAULT_CANARY_BTC_HIDDEN_SOURCES,
	DEFAULT_CANARY_BTC_SOURCES,
	type CanaryBtcSource
} from '@morphit/operator-config';
import {
	type BtcHead,
	fetchBtcHeadFastest,
	fetchBtcHeadPhased,
	fetchBtcHeadWithFailover,
	planCanaryBtcPhases,
	parseBtcSourceBody,
	parseBtcTip,
	resolveCanaryBtcSources
} from './canary/btcHeadFailover.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

console.log('\n── canary BTC failover smoke ──────────────────────────\n');

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

// A stand-in tip hash: 64 lowercase hex chars (leading zeros like a real tip).
const H = '0'.repeat(19) + 'a'.repeat(45); // 19 + 45 = 64
const GOOD: BtcHead = { height: 840_123, hash: H };
const esplora = (url: string): CanaryBtcSource => ({ kind: 'esplora', url, label: url });

async function run(): Promise<void> {
	// ─── A. LOGIC — failover walk (no network) ───────────────────────
	{
		const tried: string[] = [];
		const fetchOne = async (s: CanaryBtcSource): Promise<BtcHead | null> => {
			tried.push(s.url);
			return s.url === 'c' ? GOOD : null;
		};
		const got = await fetchBtcHeadWithFailover(
			[esplora('a'), esplora('b'), esplora('c'), esplora('d')],
			fetchOne
		);
		check(
			'failover hops past dead providers to the first that answers',
			got !== null && got.source.url === 'c' && got.head.height === 840_123
		);
		check('failover STOPS at the first success (no d)', tried.join(',') === 'a,b,c');
	}
	{
		const got = await fetchBtcHeadWithFailover([esplora('a'), esplora('b')], async () => null);
		check('failover returns null when every provider fails', got === null);
	}
	{
		let calls = 0;
		const got = await fetchBtcHeadWithFailover([esplora('a'), esplora('b')], async () => {
			calls++;
			return GOOD;
		});
		check('a healthy first provider short-circuits the rest (1 call)', got !== null && calls === 1);
	}

	// ─── resolveCanaryBtcSources semantics ───────────────────────────
	const canonical: CanaryBtcSource[] = [
		{ kind: 'esplora', url: 'https://one.example/api', label: 'one.example' },
		{ kind: 'blockchair', url: 'https://two.example', label: 'two.example' }
	];
	check(
		'no override → the FULL canonical list',
		resolveCanaryBtcSources(undefined, canonical).length === 2 &&
			resolveCanaryBtcSources('   ', canonical).length === 2
	);
	{
		const pinned = resolveCanaryBtcSources('https://pinned.example/api', canonical);
		check(
			'an explicit override pins exactly one Esplora source',
			pinned.length === 1 && pinned[0].kind === 'esplora' && pinned[0].url === 'https://pinned.example/api'
		);
	}

	// ─── parseBtcTip shape guard ─────────────────────────────────────
	check('parseBtcTip accepts a well-formed height + hash', parseBtcTip('840123', H) !== null);
	check(
		'parseBtcTip accepts a hash with 16 leading zero hex digits (the proof-of-work floor)',
		parseBtcTip('840123', '0'.repeat(16) + 'a'.repeat(48)) !== null
	);
	check(
		'parseBtcTip lowercases an uppercase hash and still accepts it',
		parseBtcTip('840123', H.toUpperCase())?.hash === H
	);
	check(
		'parseBtcTip rejects junk (empty/non-numeric/zero height, short/non-hex hash)',
		parseBtcTip('', H) === null &&
			parseBtcTip('x', H) === null &&
			parseBtcTip('0', H) === null &&
			parseBtcTip('840123', 'short') === null &&
			parseBtcTip('840123', 'g'.repeat(64)) === null &&
			// v1.21.15: a hash without the proof-of-work zeros is not a block's
			parseBtcTip('840123', '0'.repeat(15) + 'a'.repeat(49)) === null &&
			parseBtcTip('840123', 'a'.repeat(64)) === null
	);

	// ─── parseBtcSourceBody: EVERY provider shape (the core) ────
	check('parseBtcSourceBody(esplora) parses two-body height+hash', parseBtcSourceBody('esplora', '840123', H) !== null);
	check(
		'parseBtcSourceBody(blockchain_info) parses { height, hash }',
		parseBtcSourceBody('blockchain_info', JSON.stringify({ height: 840123, hash: H }))?.height === 840123
	);
	check(
		'parseBtcSourceBody(blockchair) parses { data: { best_block_height, best_block_hash } }',
		parseBtcSourceBody(
			'blockchair',
			JSON.stringify({ data: { best_block_height: 840123, best_block_hash: H } })
		)?.hash === H
	);
	check(
		'parseBtcSourceBody(blockcypher) parses { height, hash }',
		parseBtcSourceBody('blockcypher', JSON.stringify({ height: 840123, hash: H }))?.height === 840123
	);
	check(
		'parseBtcSourceBody rejects malformed bodies for every shape',
		parseBtcSourceBody('blockchain_info', 'not json') === null &&
			parseBtcSourceBody('blockchain_info', JSON.stringify({ height: 840123 })) === null &&
			parseBtcSourceBody('blockchair', JSON.stringify({ data: {} })) === null &&
			parseBtcSourceBody('blockcypher', JSON.stringify({})) === null &&
			parseBtcSourceBody('esplora', 'nope', H) === null
	);

	// ─── A2. hidden explorers: plan, race, phases (v1.21.15) ─────────
	{
		const urls = (xs: readonly CanaryBtcSource[] | undefined): string => (xs ?? []).map((x) => x.url).join();
		const cl = [esplora('https://c1.example/api'), esplora('https://c2.example/api')];
		const hd = [esplora('http://h1.onion/api'), esplora('http://h2.onion/api')];
		const tor = planCanaryBtcPhases({ override: undefined, torOnly: true, clearnet: cl, hidden: hd });
		check(
			'Tor-only node: hidden explorers first, all at once; then clearnet in order',
			tor.length === 2 && tor[0]?.mode === 'race' && urls(tor[0]?.sources) === urls(hd) &&
				tor[1]?.mode === 'walk' && urls(tor[1]?.sources) === urls(cl)
		);
		const clear = planCanaryBtcPhases({ override: undefined, torOnly: false, clearnet: cl, hidden: hd });
		check(
			'clearnet node: clearnet in order first; hidden explorers only after, all at once',
			clear.length === 2 && clear[0]?.mode === 'walk' && urls(clear[0]?.sources) === urls(cl) &&
				clear[1]?.mode === 'race' && urls(clear[1]?.sources) === urls(hd)
		);
		const pin = planCanaryBtcPhases({ override: 'https://own.example/api', torOnly: true, clearnet: cl, hidden: hd });
		check(
			'an operator-pinned explorer is the only source, on either kind of node',
			pin.length === 1 && urls(pin[0]?.sources) === 'https://own.example/api'
		);
		check(
			'an empty hidden list adds no phase',
			planCanaryBtcPhases({ override: undefined, torOnly: false, clearnet: cl, hidden: [] }).length === 1
		);
	}
	{
		const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
		const t0 = Date.now();
		const got = await fetchBtcHeadFastest(
			[esplora('slow'), esplora('dead'), esplora('fast'), esplora('throws')],
			async (s) => {
				if (s.url === 'slow') {
					await delay(400);
					return { height: 1, hash: H };
				}
				if (s.url === 'dead') {
					await delay(5);
					return null;
				}
				if (s.url === 'throws') throw new Error('boom');
				await delay(30);
				return GOOD;
			}
		);
		check(
			'race: the FASTEST valid answer wins, without waiting for the slow one; a throwing source is just a miss',
			got?.source.url === 'fast' && got.head.height === GOOD.height && Date.now() - t0 < 300
		);
		check(
			'race: null when every hidden explorer fails',
			(await fetchBtcHeadFastest([esplora('a'), esplora('b')], async () => null)) === null &&
				(await fetchBtcHeadFastest([], async () => GOOD)) === null
		);
	}
	{
		const asked: string[] = [];
		const phases = planCanaryBtcPhases({
			override: undefined,
			torOnly: false,
			clearnet: [esplora('https://c1.example/api')],
			hidden: [esplora('http://h1.onion/api')]
		});
		const fetchOne =
			(clearOk: boolean) =>
			async (s: CanaryBtcSource): Promise<BtcHead | null> => {
				asked.push(s.url);
				return s.url.includes('.onion') || clearOk ? GOOD : null;
			};
		const a = await fetchBtcHeadPhased(phases, fetchOne(true));
		check(
			'clearnet answers: no hidden explorer is asked',
			a?.source.url === 'https://c1.example/api' && asked.join() === 'https://c1.example/api'
		);
		asked.length = 0;
		const b = await fetchBtcHeadPhased(phases, fetchOne(false));
		check(
			'every clearnet source fails: the hidden explorers are tried and answer',
			b?.source.url === 'http://h1.onion/api' && asked.join() === 'https://c1.example/api,http://h1.onion/api'
		);
	}
	{
		const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
		const got = await fetchBtcHeadPhased(
			[{ mode: 'race', sources: [esplora('http://slow.onion/api'), esplora('http://fast.onion/api')] }],
			async (s) => {
				await delay(s.url.includes('slow') ? 200 : 20);
				return GOOD;
			}
		);
		check('a race phase takes the fastest hidden explorer, not the first listed', got?.source.url === 'http://fast.onion/api');
	}
	{
		// v1.21.15: one lying hidden explorer cannot choose what the canary signs.
		const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
		const LIE: BtcHead = { height: 999_999, hash: '0'.repeat(20) + 'b'.repeat(44) };
		const race = (answers: Record<string, [number, BtcHead | null]>) =>
			fetchBtcHeadPhased(
				[{ mode: 'race', sources: Object.keys(answers).map((u) => esplora(u)) }],
				async (s) => {
					const [ms, head] = answers[s.url]!;
					await delay(ms);
					return head;
				}
			);
		const got = await race({
			'http://liar.onion/api': [5, LIE],
			'http://a.onion/api': [40, GOOD],
			'http://b.onion/api': [80, GOOD]
		});
		check(
			'hidden race: the head two explorers agree on wins, not the fastest single answer (a liar alone is outvoted)',
			got?.head.height === GOOD.height && got.head.hash === GOOD.hash && got.source.url === 'http://a.onion/api'
		);
		const lone = await race({
			'http://liar.onion/api': [5, LIE],
			'http://a.onion/api': [20, GOOD],
			'http://down.onion/api': [10, null]
		});
		check('hidden race: no two agree → no head (the BTC proof is then "unavailable")', lone === null);
		check(
			'hidden race: the same height with a different hash is not agreement',
			(await race({
				'http://x.onion/api': [5, GOOD],
				'http://y.onion/api': [10, { height: GOOD.height, hash: LIE.hash }]
			})) === null
		);
	}
	check(
		"the hidden source list is the fee verifier's onion + I2P Esplora lists (one source of truth), http to .onion / .b32.i2p only",
		(() => {
			const hidden = [...DEFAULT_BTC_ONION_EXPLORERS, ...DEFAULT_BTC_I2P_EXPLORERS];
			return (
				DEFAULT_CANARY_BTC_HIDDEN_SOURCES.length === hidden.length &&
				DEFAULT_BTC_I2P_EXPLORERS.length > 0 &&
				DEFAULT_CANARY_BTC_HIDDEN_SOURCES.every(
					(x, i) =>
						x.kind === 'esplora' &&
						x.url === hidden[i] &&
						/^http:\/\/(?:[a-z2-7]{56}\.onion|[a-z2-7]{52}\.b32\.i2p)\//.test(x.url)
				) &&
				!DEFAULT_CANARY_BTC_SOURCES.some((x) => /\.(onion|i2p)\//.test(x.url))
			);
		})()
	);

	// ─── B. WIRING — canonical list + CLI + generate.sh ──────────────
	check(
		'canonical BTC source list spans ≥5 independent providers',
		DEFAULT_CANARY_BTC_SOURCES.length >= 5
	);
	{
		const kinds = new Set(DEFAULT_CANARY_BTC_SOURCES.map((s) => s.kind));
		check(
			'BTC sources cover heterogeneous shapes (esplora + blockchain_info + blockchair + blockcypher)',
			kinds.has('esplora') &&
				kinds.has('blockchain_info') &&
				kinds.has('blockchair') &&
				kinds.has('blockcypher')
		);
	}

	const cli = readFileSync(join(REPO, 'scripts/canary/fetch-btc-head.ts'), 'utf8');
	const gen = readFileSync(join(REPO, 'scripts/canary/generate.sh'), 'utf8');

	check(
		'CLI imports DEFAULT_CANARY_BTC_SOURCES from @morphit/operator-config (one source of truth)',
		/import\s*\{[^}]*\bDEFAULT_CANARY_BTC_SOURCES\b[^}]*\}\s*from\s*'@morphit\/operator-config'/.test(cli)
	);
	check(
		'CLI hand-copies NO provider URLs of its own (all come from the imported list)',
		!/https?:\/\/[a-z0-9.-]*(blockstream|mempool|blockchair|blockchain\.info|blockcypher)/i.test(cli)
	);
	check(
		'CLI dispatches through the pure parser + the phase plan (clearnet walk / hidden race)',
		cli.includes('parseBtcSourceBody(') &&
			cli.includes('fetchBtcHeadPhased(') &&
			/planCanaryBtcPhases\(\{[^}]*torOnly: canaryIsTorOnly\(\)[^}]*hidden: DEFAULT_CANARY_BTC_HIDDEN_SOURCES/.test(cli)
	);
	{
		// A hidden source is reached ONLY through Tor / i2pd: no proxy -> skipped,
		// and every fetch carries the chosen dispatcher.
		const fetches = cli.match(/\bfetch\(/g)?.length ?? 0;
		const withVia = cli.match(/\bfetch\([^,]+,\s*\{\s*\.\.\.via,/g)?.length ?? 0;
		check(
			'CLI: a hidden source with no proxy is skipped, never fetched directly; every fetch carries the dispatcher',
			/if \(isHidden && dispatcher === null\) return note\(/.test(cli) && fetches === 3 && withVia === 3
		);
	}
	check(
		'generate.sh invokes the BTC failover helper via tsx (real call, not a comment)',
		/"\$RUN_TSX"\s+"\$REPO_ROOT\/scripts\/canary\/fetch-btc-head\.ts"/.test(gen)
	);
	check(
		'generate.sh no longer curls a single pinned blockstream.info endpoint',
		!/curl[^\n]*blockstream\.info/.test(gen)
	);
	check(
		'generate.sh treats total BTC-source failure as NON-fatal (degrades, no exit)',
		/fetch-btc-head\.ts"\s*\|\|\s*true/.test(gen) && /unavailable at signing time/.test(gen)
	);
	{
		const newsFeeds = [
			'feeds.bbci.co.uk',
			'theguardian.com',
			'feeds.npr.org',
			'aljazeera.com',
			'rss.nytimes.com'
		];
		check(
			'news line has ≥5 independent fallback feeds (beyond the operator feed)',
			newsFeeds.every((f) => gen.includes(f))
		);
	}

	// ─── verdict ─────────────────────────────────────────────────────
	const total = pass + fails.length;
	console.log('\n──────────────────────────────────────────────────────');
	if (fails.length > 0) {
		console.log(`✗ ${fails.length} of ${total} canary-btc-failover checks FAILED`);
		process.exit(1);
	}
	console.log(`✓ all ${total} canary-btc-failover scenarios passed`);
}

void run();
