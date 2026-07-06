/**
 * Morphit indexer — POST /v1/broadcast. Anchor cp344.
 *
 *   POST /v1/broadcast   body: { "trx": <signed Blurt transaction> }
 *     200 → { block_num, trx_id }
 *     400 → bad body / disallowed op / the CHAIN rejected the tx (message
 *           relays the chain's reason, e.g. "missing required posting
 *           authority", so the user sees what actually went wrong)
 *     502 (code "internal") → could not reach any Blurt node (the client
 *           treats this as "proxy unreachable" and falls back to direct RPC)
 *
 * WHY THIS EXISTS — PRIVACY (priority #1) + RELIABILITY. Until now the
 * browser broadcast EVERY Morphit op (orders, chat, profile, feedback,
 * blocks, listing-fee transfers) by calling a third-party Blurt RPC node
 * DIRECTLY. That (a) leaked the user's IP + their exact on-chain action to
 * RPC operators Morphit does not control — the same deanonymizing leak the
 * cp298 account-keys proxy closed for READS, but on WRITES, which are even
 * more sensitive — and (b) depended on whichever node the browser reached
 * returning a browser-valid CORS header and staying up, so one node changing
 * its CORS config or going down silently broke every broadcast. This is the
 * WRITE sibling of the cp295/296/298 read proxies: the signed transaction is
 * relayed across the full server-side rpc-pool (latency-aware best node +
 * cooldown failover), so third parties only ever see the indexer's request
 * and the browser opens no cross-origin RPC connection.
 *
 * NON-CUSTODIAL IS UNTOUCHED. The transaction arrives ALREADY SIGNED by the
 * user's key — signing is pure client-side crypto. The indexer never sees a
 * private key; it only forwards bytes the user already authorized.
 *
 * NOT AN OPEN RELAY. Each operation must be one Morphit actually broadcasts
 * (custom_json with a `morphit_*` id, transfer, comment, comment_options, or
 * vote); anything else (account_update, witness ops, …) is refused up front.
 * The chain itself charges the SIGNER's resource credits, so even within the
 * whitelist this can't be used to spam the chain — the cost lands on whoever
 * signed, not the operator.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { BlurtClient } from '$blurt/client';
import { isTransportError } from '$blurt/client';
import { errorBody } from '$api/shared';

/** Every custom_json id Morphit broadcasts is versioned `morphit_<name>_vN`. */
const MORPHIT_CUSTOM_JSON_ID_RE = /^morphit_[a-z0-9_]+$/;

/** Operation types Morphit ever broadcasts from the browser. */
const ALLOWED_OP_TYPES = new Set([
	'custom_json',
	'transfer',
	'comment',
	'comment_options',
	'vote',
	// cp396 — claim unclaimed author/curation rewards into usable balances.
	// Posting-authority op; the signer can only claim their OWN rewards, so
	// whitelisting it can't be abused to move anyone else's funds.
	'claim_reward_balance',
	// cp428 — wallet Power Up / Power Down. `transfer_to_vesting` stakes the
	// signer's own liquid BLURT into BP; `withdraw_vesting` unstakes it back.
	// Both are self-only (the op moves the SIGNER's own balance between liquid
	// and staked — it cannot move anyone else's funds, same safety class as
	// claim_reward_balance), so whitelisting them can't turn this into an open
	// relay. Without these the indexer rejected every Power Up/Down with
	// "operation type not permitted", surfacing to the user as a generic
	// on-chain error even though the signed op was perfectly valid.
	'transfer_to_vesting',
	'withdraw_vesting'
]);

/** A signed transaction, validated STRUCTURALLY only — the chain is the
 *  authority on semantic validity. operations: [ [type, payload], … ]. */
const txSchema = z.object({
	ref_block_num: z.number().int().nonnegative(),
	ref_block_prefix: z.number().int().nonnegative(),
	expiration: z.string().min(1).max(40),
	operations: z
		.array(z.tuple([z.string(), z.record(z.string(), z.unknown())]))
		.min(1)
		.max(10),
	extensions: z.array(z.unknown()).optional(),
	signatures: z
		.array(z.string().regex(/^[0-9a-f]+$/i).max(200))
		.min(1)
		.max(8)
});
const bodySchema = z.object({ trx: txSchema });

interface BroadcastOkBody {
	readonly block_num: number;
	readonly trx_id: string;
}

export function broadcastRoute(blurt: BlurtClient): Hono {
	const app = new Hono();

	app.post('/', async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json(errorBody('bad_request', 'invalid JSON body'), 400);
		}

		const parsed = bodySchema.safeParse(json);
		if (!parsed.success) {
			return c.json(errorBody('bad_request', 'malformed transaction'), 400);
		}
		const { trx } = parsed.data;

		// Op whitelist — bound what this relay can push to the chain.
		for (const [type, payload] of trx.operations) {
			if (!ALLOWED_OP_TYPES.has(type)) {
				return c.json(errorBody('bad_request', `operation type not permitted: ${type}`), 400);
			}
			if (type === 'custom_json') {
				const id = (payload as { id?: unknown }).id;
				if (typeof id !== 'string' || !MORPHIT_CUSTOM_JSON_ID_RE.test(id)) {
					return c.json(errorBody('bad_request', 'custom_json id not permitted'), 400);
				}
			}
		}

		let result: { block_num?: number; id?: string; trx_id?: string } | null;
		try {
			result = await blurt.callCondenser('broadcast_transaction_synchronous', [trx], {
				userFacing: true
			});
		} catch (err) {
			// Transport error = couldn't reach any node → 502 so the client can
			// fall back to direct RPC. A NON-transport error is a chain rejection
			// → surface its message (400) so the user sees the real reason.
			if (isTransportError(err)) {
				return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
			}
			const msg = err instanceof Error ? err.message : 'the chain rejected the transaction';
			return c.json(errorBody('bad_request', msg), 400);
		}

		// condenser_api.broadcast_transaction_synchronous returns
		// { id, block_num, trx_num, expired } — `id` is the trx hash. Normalize
		// to { block_num, trx_id } so the browser gets a populated trx_id (the
		// old direct-RPC path mistyped this and left trx_id undefined).
		const trx_id = (result?.trx_id ?? result?.id) as string | undefined;
		const block_num = result?.block_num;
		if (typeof trx_id !== 'string' || typeof block_num !== 'number') {
			return c.json(errorBody('internal', 'unexpected broadcast result'), 502);
		}

		const body: BroadcastOkBody = { block_num, trx_id };
		return c.json(body);
	});

	return app;
}
