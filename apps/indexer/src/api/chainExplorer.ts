/**
 * Morphit indexer — /v1/chain explorer proxies. Anchor cp296.
 *
 *   GET /v1/chain/block/:num   → { block: <condenser get_block result> }
 *   GET /v1/chain/tx/:id       → { tx:    <condenser get_transaction result> }
 *     400 on a bad block number / trx id.
 *     404 when the chain has no such block / transaction.
 *     502 (code "internal") if the chain RPC could not be reached.
 *
 * WHY THESE EXIST — PRIVACY (priority #1). The block-explorer's block and
 * transaction pages used to call Blurt `get_block` / `get_transaction`
 * DIRECTLY from the browser, leaking the user's IP and exactly which
 * block/tx they inspected to third-party RPC operators. These are the
 * block/tx siblings of the cp295 balance proxy and the cp296 account
 * history/account proxies: the read is relayed SERVER-side across the
 * full canonical pool (rpc-pool latency-aware best-node + cooldown
 * failover), so third parties only ever see the indexer's request and the
 * browser opens no cross-origin RPC connection. As a bonus, the tx lookup
 * gets MORE reliable — not every public node exposes `get_transaction`,
 * and the pool finds one that does (a single browser was stuck with
 * whichever node it had reached).
 *
 * THIN: both relay the chain result verbatim (after a null guard); the
 * explorer pages keep their own rendering. Blocks and confirmed
 * transactions are immutable, so the responses cache for longer than the
 * balance/history reads.
 */

import { Hono } from 'hono';

import type { BlurtClient } from '$blurt/client';
import { errorBody } from '$api/shared';

/** Blocks and confirmed transactions are immutable once produced, so a
 *  long public cache is safe and collapses repeat explorer lookups. */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=600';

/** A Blurt trx id is a 40-hex-char sha1. */
const TRX_ID_RE = /^[0-9a-f]{40}$/i;

interface ChainBlockBody {
	readonly block: unknown;
}
interface ChainTxBody {
	readonly tx: unknown;
}

export function chainExplorerRoute(blurt: BlurtClient): Hono {
	const app = new Hono();

	app.get('/block/:num', async (c) => {
		const numRaw = c.req.param('num');
		const num = Number(numRaw);
		if (!Number.isInteger(num) || num < 1) {
			return c.json(errorBody('bad_request', 'invalid block number'), 400);
		}

		let result: unknown;
		try {
			result = await blurt.callCondenser('get_block', [num], { userFacing: true });
		} catch {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}
		if (result === null || result === undefined) {
			return c.json(errorBody('not_found', 'no such block on chain'), 404);
		}

		const body: ChainBlockBody = { block: result };
		c.header('Cache-Control', IMMUTABLE_CACHE_CONTROL);
		return c.json(body);
	});

	app.get('/tx/:id', async (c) => {
		const id = c.req.param('id');
		if (!TRX_ID_RE.test(id)) {
			return c.json(errorBody('bad_request', 'invalid transaction id'), 400);
		}

		let result: unknown;
		try {
			result = await blurt.callCondenser('get_transaction', [id], { userFacing: true });
		} catch {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}
		if (result === null || result === undefined) {
			return c.json(errorBody('not_found', 'no such transaction on chain'), 404);
		}

		const body: ChainTxBody = { tx: result };
		c.header('Cache-Control', IMMUTABLE_CACHE_CONTROL);
		return c.json(body);
	});

	// GET /v1/chain/properties → { properties: <get_dynamic_global_properties> }
	// cp344. The WRITE side of the privacy/reliability story: building any
	// broadcast needs the chain head (ref_block_num / ref_block_prefix /
	// expiration), which the browser used to read by calling
	// get_dynamic_global_properties on a third-party RPC node directly — the
	// same node a broadcast would hit, so the same CORS/uptime fragility broke
	// the broadcast before it even signed. Relayed server-side here, the
	// browser's ref-block read goes same-origin like the broadcast itself.
	// Head moves every 3s; a 2s cache collapses the burst when a page
	// broadcasts several ops back to back without ever yielding a stale-enough
	// head to build an expired ref_block (Blurt's TaPoS window is days).
	app.get('/properties', async (c) => {
		let result: unknown;
		try {
			result = await blurt.callCondenser('get_dynamic_global_properties', [], {
				userFacing: true
			});
		} catch {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}
		if (result === null || result === undefined) {
			return c.json(errorBody('internal', 'no chain properties returned'), 502);
		}
		c.header('Cache-Control', 'public, max-age=2');
		return c.json({ properties: result });
	});

	return app;
}
