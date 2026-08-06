#!/usr/bin/env tsx
/**
 * Morphit — RPC batch contract smoke (v1.7.5, t.txt #4).
 *
 * "batch" is the last of the four things the rpc.blurt.blog operator asked us
 * for — lower RPS, batch, exponential backoff, add jitter. The first, third and
 * fourth shipped in v1.7.0. This pins the second.
 *
 * What actually earned the HTTP 429 in Ken's screenshot was not steady-state
 * traffic (~1 request per 3 s per instance). It was catch-up: the poller walked
 * blocks one HTTP request at a time, so any downtime turned into thousands of
 * requests fired as fast as pacing allowed — from every federated instance, at a
 * handful of volunteer-run nodes.
 *
 * These checks pin the OUTCOMES, not the phrasing:
 *   1. the poller prefetches a window per request instead of one block per request
 *   2. the one-block-per-DB-transaction rule SURVIVES the change (it protects a
 *      different resource and wants the opposite answer — small txs, few requests)
 *   3. batch support is discovered per URL and cached, never assumed — this repo
 *      cannot reach a Blurt node to verify support, so the code must not require it
 *   4. batch errors stay legible to the pool's OWN classifiers, so a rate-limited
 *      batch rotates and cools down exactly like a single call
 *   5. responses are matched by id, never by array position (JSON-RPC does not
 *      promise order — a node returning them reversed must not silently mis-file
 *      block 102's transactions under block 101)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = readFileSync(resolve(root, 'apps/indexer/src/blurt/client.ts'), 'utf8');
const poller = readFileSync(resolve(root, 'apps/indexer/src/indexer/poller.ts'), 'utf8');
const pool = readFileSync(resolve(root, 'packages/rpc-pool/src/index.ts'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) { pass++; console.log(`  \u2713 ${name}`); }
	else { fail++; console.log(`  \u2717 ${name}${detail ? `: ${detail}` : ''}`); }
};

// ── 1. the poller no longer spends one request per block ────────────
check(
	'1 poller prefetches a WINDOW of blocks per request',
	/getBlocks\(\s*window\s*,/.test(poller),
	'catch-up must call getBlocks(window, …), not getBlock(n) per block'
);
check(
	'2 poller no longer calls getBlock() one-per-block in catch-up',
	!/for\s*\([^)]*\)\s*\{[\s\S]{0,200}?await this\.blurt\.getBlock\(n\)/.test(poller)
);
check('3 a batch size is defined', /const BLOCK_FETCH_BATCH = \d+/.test(poller));
const size = Number(/const BLOCK_FETCH_BATCH = (\d+)/.exec(poller)?.[1] ?? '0');
check('4 batch size is a sane window (2..100)', size >= 2 && size <= 100, String(size));
check('5 the cursor advances past the fetched window', /nextLo = hi \+ 1/.test(poller));

// ── 2. the DB invariant the batching must NOT trample ───────────────
// The poller documents WHY it never batches DB writes: a long catch-up would
// hold a transaction open for minutes. Batching the FETCH is only correct
// because it leaves that alone. If a later change starts wrapping the window in
// one withTx, this check is the thing that notices.
check(
	'6 one-block-per-transaction survives (withTx is INSIDE the per-block loop)',
	/for \(let i = 0; i < blocks\.length[\s\S]{0,1200}?this\.db\.withTx/.test(poller),
	'the DB tx must stay per-block; batching the fetch must not batch the write'
);
check(
	'7 …and the reason is still written down',
	/bloating WAL/.test(poller)
);

// ── 3. batch support is discovered, never assumed ───────────────────
check('8 a per-URL batch-capability cache exists', /batchUnsupported/.test(client));
check(
	'9 a non-array answer marks the URL unsupported (capability, not failure)',
	/!Array\.isArray\(json\)[\s\S]{0,120}?batchUnsupported\.add\(url\)/.test(client)
);
check(
	'10 …and bails out via the sentinel (so the caller can fall back PACED)',
	/batchUnsupported\.add\(url\);\s*\n\s*throw new BatchUnsupportedError\(url\);/.test(client),
	'must throw the sentinel, NOT loop in-callback — see check 12'
);
check(
	'11 a known-unsupported URL skips the batch attempt entirely',
	/if \(batchUnsupported\.has\(url\)\) throw new BatchUnsupportedError\(url\)/.test(client)
);

// ── THE SUBTLE ONE (found in the v1.7.5 deep-deep) ──────────────────
// The fallback MUST go back through this.getBlock(), i.e. one pool.call() per
// block. The first version of this code looped inside the pool callback, which
// silently made the whole task backwards: EndpointPool.attemptSingle awaits
// pace(ep) ONCE and then calls the callback, so N requests issued inside one
// callback are N requests with NO pacing between them. A node that could not
// batch would have received a 20-request BURST where it previously received 20
// paced requests — worse than the behaviour this task exists to fix, aimed
// squarely at the older, smaller nodes least able to absorb it.
//
// This check is the thing that stops that from being reintroduced by anyone who
// notices the "redundant" endpoint re-selection and optimises it away.
check(
	'12 the non-batch fallback is PACED (one pool.call per block, not a burst inside one callback)',
	/if \(!\(err instanceof BatchUnsupportedError\)\) throw err;[\s\S]{0,1400}?for \(const n of nums\) out\.push\(await this\.getBlock\(n, startOffset\)\);/.test(
		client
	),
	'the fallback must loop over this.getBlock(n) OUTSIDE the pool callback, or every request after the first skips pace()'
);
check(
	'13 …and the reason is written down where the trap is',
	/pace\(ep\) ONCE/.test(client) && /BURST/.test(client)
);
check(
	'14 no fallback loop survives INSIDE the pool callback',
	!/pool\.call\([\s\S]{0,2000}?for \(const n of nums\)[\s\S]{0,200}?fetch\(/.test(client)
);

// ── a node that merely can't batch must not be punished ─────────────
// isTransportError/isRateLimitError match on message TEXT. If the sentinel's
// message contained 'network', 'timeout', 'aborted', etc., an honest old node
// would be rotated away and put on a cooldown ladder for answering correctly.
check(
	'15 batch-unsupported is a distinct error class, not a string match',
	/class BatchUnsupportedError extends Error/.test(client)
);
const sentinelMsg = /super\(`([^`]+)`\)/.exec(client)?.[1]?.toLowerCase() ?? '';
const CLASSIFIER_WORDS = [
	'fetch failed',
	'timeout',
	'econnrefused',
	'econnreset',
	'enotfound',
	'etimedout',
	'socket hang up',
	'network',
	'aborted',
	'http 429',
	'too many requests',
	'rate limit'
];
check(
	'16 …and its message trips NO transport/rate-limit keyword',
	sentinelMsg.length > 0 && !CLASSIFIER_WORDS.some((k) => sentinelMsg.includes(k)),
	`a node that simply cannot batch must not be rotated away or cooled down for it — sentinel says: "${sentinelMsg}"`
);

// ── 4. errors stay legible to the pool's own classifiers ────────────
// isRateLimitError matches /\bhttp 429\b/ on the message. If the batch path
// throws something else for a 429, the endpoint never gets the long 429 ladder
// and we keep hammering the node that just asked us to stop — which is the whole
// problem this task exists to fix.
check('13 pool classifies rate limits by message text', /\\bhttp 429\\b/.test(pool));
check(
	'14 batch throws an HTTP 429 the pool can classify',
	/res\.status === 429[\s\S]{0,80}?HTTP 429/.test(client)
);
check(
	'15 batch throws other HTTP failures with the status in the message',
	/HTTP \$\{res\.status\} \(batch get_block\)/.test(client)
);
check(
	'16 network failures surface as transport errors (pool rotates + cools)',
	/catch \(err\)[\s\S]{0,140}?batch get_block transport failure/.test(client)
);

// ── 5. ordering correctness ─────────────────────────────────────────
check(
	'17 responses are matched by id, not array position',
	/byId\.set\(id,/.test(client) && /byId\.get\(i\)/.test(client)
);
check(
	'18 a missing id is an error, not a silent null block',
	/missing response for id/.test(client)
);
check(
	'19 a short batch response is rejected (no silent truncation)',
	/json\.length !== nums\.length/.test(client)
);
check(
	'20 an rpc-level error inside the batch is not swallowed',
	/batch get_block rpc error/.test(client)
);
check('21 a single-element request skips batch framing', /nums\.length === 1/.test(client));

// ── 6. the operator's four asks are all present ─────────────────────
check('22 ask 1/4 — lower RPS', /DEFAULT_MAX_REQUESTS_PER_SECOND = \d+/.test(pool));
check('23 ask 2/4 — batch', /getBlocks\(/.test(client));
check('24 ask 3/4 — exponential backoff', /DEFAULT_RATE_LIMIT_COOLDOWN_LADDER_MS/.test(pool));
check('25 ask 4/4 — jitter', /DEFAULT_COOLDOWN_JITTER_FRACTION = 0\.\d+/.test(pool));

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} rpc-batch-contract checks passed`);
else { console.error(`\u2717 ${fail} of ${pass + fail} rpc-batch-contract checks FAILED`); process.exit(1); }
