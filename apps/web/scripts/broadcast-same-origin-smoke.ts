/**
 * broadcast-same-origin-smoke — every chain WRITE goes through the operator's
 * own indexer (same-origin), not a direct browser→third-party-RPC call..
 *
 * WHY: broadcasting straight to a public RPC node from the browser leaked the
 * user's IP + their exact action to operators Morphit doesn't control (the
 * WRITE twin of the read leak) and broke whenever a node changed its
 * CORS header / went down. The fix routes the broadcast AND the ref-block read
 * that precedes it through the indexer (POST /v1/broadcast, GET
 * /v1/chain/properties). A later change shipped this WITH a direct-RPC fallback;
 * REMOVED that fallback entirely — the browser must never contact a Blurt
 * node directly, so an unreachable proxy now throws BroadcastUnavailableError
 * rather than leaking the write to a third-party node. This smoke pins that
 * wiring so it can't silently revert to direct RPC (which would quietly
 * re-open the privacy hole + the fragility).
 *
 * Static analysis only — the live broadcast itself is a post-deploy
 * real-browser check, not something this can run.
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
// there is NO condenser broadcast call left anywhere in the web client
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

// ── Transport: same-origin ONLY (a later change removed the direct-RPC fallback) ──────
check("transport POSTs to /v1/broadcast", /'\/v1\/broadcast'/.test(transport));
check("transport reads /v1/chain/properties for the ref-block", /'\/v1\/chain\/properties'/.test(transport));
check('transport exports ChainRejectedError', /export class ChainRejectedError/.test(transport));
// the browser must NEVER contact a Blurt RPC node directly, so the old
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
	// The point of this check is that the broadcast happens SERVER-SIDE — the
	// browser never opens an RPC connection of its own. The literal method name
	// used to stand in for that, and v1.18.0 split the method by op class (a
	// chat message answers before a block, everything else waits for one), so
	// the name is now chosen at runtime. Both methods must still be the ones
	// this route reaches for, and the call must still go through callCondenser.
	'indexer broadcast forwards to the chain server-side, via callCondenser',
	/callCondenser\(\s*method\b/.test(route) &&
		/'broadcast_transaction_synchronous'/.test(route) &&
		/'broadcast_transaction'/.test(route)
);
check(
	'indexer broadcast keeps block confirmation for everything except a chat message',
	/isChatMessageOnly/.test(route) &&
		/chatAsync\s*\?\s*'broadcast_transaction'\s*:\s*'broadcast_transaction_synchronous'/.test(
			route
		)
);
check(
	// The fast answer is OPT-IN, and that is what makes it safe across versions:
	// a browser tab can be older than the indexer serving it, and a bundle from
	// before v1.18.0 reads a null block_num as a malformed reply — showing a
	// permanent failure for a message that was in fact delivered, beside a retry
	// button that sends a second copy. The indexer must never take the fast path
	// on its own initiative. Behaviour is asserted in
	// apps/indexer/scripts/fastchat-three-leg-smoke.ts; this file pins the shape
	// at the seam, which is its job.
	'the async chat answer requires the CLIENT to ask for it',
	/chat_async/.test(route) &&
		/chatAsync\s*=\s*chatOnly\s*&&\s*chatAsyncRequested\s*===\s*true/.test(route)
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
	// Neither the argument list NOR the call's layout is pinned. What this check
	// is about is the MOUNT: that broadcast is reached at /v1/broadcast through
	// the rate-limited sub-app rather than attached directly. v1.18.0 broke this
	// regex twice — once by adding an argument, once by wrapping the call across
	// lines for a callback — and both times it was the regex guarding incidental
	// detail rather than the structure it exists to protect.
	/broadcastRoute/.test(main) &&
		/broadcastApp\.route\(\s*'\/',\s*broadcastRoute\(\s*blurt/.test(main) &&
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
