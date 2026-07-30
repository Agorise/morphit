#!/usr/bin/env tsx
/**
 * scripts/canary-rpc-failover-smoke.ts
 *
 * cp451 — the warrant canary used to POST its chain-head request to a
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
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	type BlurtHead,
	fetchBlurtHeadWithFailover,
	parseHead,
	resolveCanaryNodes
} from './canary/blurtHeadFailover.js';

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
	check(
		'an explicit override pins exactly that one node',
		resolveCanaryNodes('https://pinned.example', canonical).join(',') === 'https://pinned.example'
	);

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
		'CLI runs the fetch through the failover walk',
		cli.includes('fetchBlurtHeadWithFailover(')
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
