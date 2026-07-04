/**
 * broadcast-same-origin-smoke — every chain WRITE goes through the operator's
 * own indexer (same-origin), not a direct browser→third-party-RPC call. cp344.
 *
 * WHY: broadcasting straight to a public RPC node from the browser leaked the
 * user's IP + their exact action to operators Morphit doesn't control (the
 * WRITE twin of the cp298 read leak) and broke whenever a node changed its
 * CORS header / went down. The fix routes the broadcast AND the ref-block read
 * that precedes it through the indexer (POST /v1/broadcast, GET
 * /v1/chain/properties). cp344 shipped this WITH a direct-RPC fallback;
 * cp410 REMOVED that fallback entirely — the browser must never contact a Blurt
 * node directly, so an unreachable proxy now throws BroadcastUnavailableError
 * rather than leaking the write to a third-party node. This smoke pins that
 * wiring so it can't silently revert to direct RPC (which would quietly
 * re-open the privacy hole + the fragility).
 *
 * Static analysis only — the sandbox has no Blurt RPC, so the live broadcast
 * itself is a post-deploy real-browser check, not something this can run.
 *
 * Usage (from apps/web): tsx scripts/broadcast-same-origin-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = join(import.meta.dirname, '..');
const repoRoot = join(webRoot, '..', '..');
const read = (p: string): string => readFileSync(p, 'utf-8');

const sign = read(join(webRoot, 'src/lib/blurt/sign.ts'));
const comment = read(join(webRoot, 'src/lib/blurt/ops/comment.ts'));
const transport = read(join(webRoot, 'src/lib/blurt/broadcastTransport.ts'));
const route = read(join(repoRoot, 'apps/indexer/src/api/broadcast.ts'));
const chainExplorer = read(join(repoRoot, 'apps/indexer/src/api/chainExplorer.ts'));
const main = read(join(repoRoot, 'apps/indexer/src/main.ts'));

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean): void {
	checks++;
	console.log(cond ? `  ✓ ${name}` : `  ✗ ${name}`);
	if (!cond) failures++;
}

console.log('\n── broadcasts route same-origin (cp344) ───────────────');

// ── Web client: sign.ts routes through the transport, not direct RPC ─────────
check(
	'sign.ts imports submitSignedTransaction + fetchDynamicGlobalProperties',
	/import\s*\{[^}]*\bsubmitSignedTransaction\b[^}]*\bfetchDynamicGlobalProperties\b[^}]*\}\s*from\s*'\.\/broadcastTransport'/.test(
		sign
	) ||
		(/\bsubmitSignedTransaction\b/.test(sign) &&
			/\bfetchDynamicGlobalProperties\b/.test(sign) &&
			/from '\.\/broadcastTransport'/.test(sign))
);
check('broadcastCustomJson submits via submitSignedTransaction', /submitSignedTransaction\(signed\)/.test(sign));
check(
	'getRefBlockInfo reads head via fetchDynamicGlobalProperties (not direct RPC)',
	/fetchDynamicGlobalProperties\(\)/.test(sign)
);
// cp410 — there is NO condenser broadcast call left anywhere in the web client
// (the last one, broadcastTransport's fallback, was removed). sign.ts in
// particular must not broadcast directly.
check(
	'sign.ts no longer calls condenser broadcast directly',
	!/condenser_api\.broadcast_transaction_synchronous/.test(sign)
);
check(
	'sign.ts no longer reads getDynamicGlobalProperties directly',
	!/getBlurtClient\(\)\.getDynamicGlobalProperties/.test(sign)
);

// ── comment.ts (blog-post syndication) routes the same way, not direct RPC ───
check(
	'comment.ts submits via submitSignedTransaction + reads head via the transport',
	/submitSignedTransaction\(signed\)/.test(comment) && /fetchDynamicGlobalProperties\(\)/.test(comment)
);
check(
	'comment.ts no longer calls condenser broadcast / reads DGP directly',
	!/condenser_api\.broadcast_transaction_synchronous/.test(comment) &&
		!/getBlurtClient\(\)\.getDynamicGlobalProperties/.test(comment)
);

// ── Transport: same-origin ONLY (cp410 removed the direct-RPC fallback) ──────
check("transport POSTs to /v1/broadcast", /'\/v1\/broadcast'/.test(transport));
check("transport reads /v1/chain/properties for the ref-block", /'\/v1\/chain\/properties'/.test(transport));
check('transport exports ChainRejectedError', /export class ChainRejectedError/.test(transport));
// cp410 — the browser must NEVER contact a Blurt RPC node directly, so the old
// direct-RPC fallback (directRpcBroadcast) was REMOVED. This is the stronger
// invariant: the transport has NO direct broadcast path at all, and when the
// indexer proxy is unreachable it throws BroadcastUnavailableError (never
// leaking the write to a third-party node). A regression that re-introduces a
// direct fallback would re-open the exact privacy hole this closed.
check(
	'transport has NO direct-RPC broadcast fallback (cp410 removed directRpcBroadcast)',
	!/directRpcBroadcast/.test(transport) &&
		!/condenser_api\.broadcast_transaction_synchronous/.test(transport)
);
check(
	'transport throws BroadcastUnavailableError when the indexer proxy is unreachable (no fallback)',
	/export class BroadcastUnavailableError/.test(transport) &&
		/throw new BroadcastUnavailableError/.test(transport)
);
check(
	'transport surfaces chain rejection on 400 (distinct from unavailable)',
	/res\.status === 400/.test(transport) && /throw new ChainRejectedError/.test(transport)
);

// ── Indexer: the broadcast proxy exists, is guarded, and is mounted ──────────
check('indexer POST /broadcast route exists', /app\.post\('\/'/.test(route));
check(
	'indexer broadcast forwards broadcast_transaction_synchronous server-side',
	/callCondenser\(\s*'broadcast_transaction_synchronous'/.test(route)
);
check(
	'indexer broadcast whitelists Morphit op types',
	/ALLOWED_OP_TYPES/.test(route) && /custom_json/.test(route) && /transfer/.test(route)
);
check(
	'indexer broadcast restricts custom_json ids to morphit_*',
	/\^morphit_/.test(route)
);
check(
	'indexer broadcast maps transport error → 502 (client fallback) and chain reject → 400',
	/isTransportError\(err\)/.test(route) && /\), 502\)/.test(route) && /\), 400\)/.test(route)
);
check(
	'indexer exposes get_dynamic_global_properties proxy (ref-block read)',
	/'\/properties'/.test(chainExplorer) && /get_dynamic_global_properties/.test(chainExplorer)
);
check(
	'broadcast route mounted at /v1/broadcast in main.ts (cp347: via a rate-limited sub-app)',
	/broadcastRoute/.test(main) &&
		/broadcastApp\.route\('\/', broadcastRoute\(blurt\)\)/.test(main) &&
		/app\.route\('\/v1\/broadcast', broadcastApp\)/.test(main)
);

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} broadcast-same-origin scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
