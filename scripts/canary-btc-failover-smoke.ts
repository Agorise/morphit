#!/usr/bin/env tsx
/**
 * scripts/canary-btc-failover-smoke.ts
 *
 * cp613 — the canary hit blockstream.info alone for its Bitcoin freshness
 * proof, no fallback + fatal abort; a single timeout killed the whole refresh.
 * cp614 — widened to FIVE independent providers (Blockstream, mempool.space,
 * Blockchain.com, Blockchair, BlockCypher), each with its own HTTP shape, plus
 * six independent news feeds. This smoke locks that in:
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

import { DEFAULT_CANARY_BTC_SOURCES, type CanaryBtcSource } from '@morphit/operator-config';
import {
	type BtcHead,
	fetchBtcHeadWithFailover,
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
		'parseBtcTip lowercases an uppercase hash and still accepts it',
		parseBtcTip('840123', H.toUpperCase())?.hash === H
	);
	check(
		'parseBtcTip rejects junk (empty/non-numeric/zero height, short/non-hex hash)',
		parseBtcTip('', H) === null &&
			parseBtcTip('x', H) === null &&
			parseBtcTip('0', H) === null &&
			parseBtcTip('840123', 'short') === null &&
			parseBtcTip('840123', 'g'.repeat(64)) === null
	);

	// ─── parseBtcSourceBody: EVERY provider shape (the cp614 core) ────
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
		'CLI dispatches through the pure parser + failover walk',
		cli.includes('parseBtcSourceBody(') && cli.includes('fetchBtcHeadWithFailover(')
	);
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
