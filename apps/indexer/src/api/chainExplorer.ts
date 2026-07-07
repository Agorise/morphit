/**
 * Morphit indexer — /v1/chain explorer proxies. Anchor cp296.
 *
 *   GET  /v1/chain/block/:num     → { block: <condenser get_block result> }
 *   GET  /v1/chain/tx/:id         → { tx:    <condenser get_transaction result> }
 *   GET  /v1/chain/properties     → { properties: <get_dynamic_global_properties> }
 *   POST /v1/chain/key-references → { accounts: string[] }  (body: { keys: string[] })
 *     400 on a bad block number / trx id / malformed key-reference body.
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

/** A Blurt public key is the `BLT` address prefix followed by base58check
 *  (Bitcoin alphabet — no 0/O/I/l) of the compressed pubkey + checksum,
 *  ~50 chars. The bound is deliberately loose (40..60) so a legitimate key
 *  is never rejected; this is shape-not-checksum (the chain is authoritative
 *  on whether the key actually references an account). */
const BLT_PUBKEY_RE = /^BLT[1-9A-HJ-NP-Za-km-z]{40,60}$/;

/** A seed derives at most owner/active/posting/memo (4) public keys; the
 *  import flow currently sends just the posting key. Cap generously so a
 *  future caller passing the full set still works, but a bogus flood can't
 *  build a giant get_key_references query against the operator's RPC pool. */
const MAX_KEY_REFERENCES_KEYS = 8;

/** The read-only condenser_api methods the browser is allowed to relay through
 *  POST /condenser. Everything the frontend chain client needs, nothing more —
 *  strictly read methods (no broadcast / no write), so this proxy can never be
 *  used to push to the chain or call an arbitrary expensive method. */
const RELAYABLE_READ_METHODS: ReadonlySet<string> = new Set([
	'get_accounts',
	'get_account_history',
	'get_dynamic_global_properties',
	'get_block',
	'get_transaction',
	'get_key_references'
]);

/** Widest relayed call is get_account_history [account, from, limit] = 3; cap at
 *  4 for a little headroom. Plus a serialized-size cap so the param array can't
 *  smuggle a huge upstream query. */
const MAX_CONDENSER_PARAMS = 4;
const MAX_CONDENSER_PARAMS_BYTES = 2048;

interface ChainBlockBody {
	readonly block: unknown;
}
interface ChainTxBody {
	readonly tx: unknown;
}
interface ChainKeyReferencesBody {
	readonly accounts: string[];
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

	// POST /v1/chain/key-references → { accounts: string[] }
	//   body: { keys: string[] }  (BLT-format public keys)
	//
	// PRIVACY (priority #1). A seed phrase derives a user's keypairs but NOT
	// their account NAME (the name lives only on-chain). To spare a returning
	// user from re-typing it after a seed import, the frontend resolves the
	// name by asking the chain which account(s) reference the derived PUBLIC
	// key — condenser_api.get_key_references. Done from the browser that hit a
	// third-party RPC node directly, leaking the importing user's IP + the
	// exact moment they're restoring their account (a high-value
	// deanonymization point: it ties an IP to a specific account at login
	// time). Relayed here it's the read sibling of the cp298 account-keys
	// proxy and the cp344 broadcast proxy: the lookup goes server-side across
	// the rpc-pool, third parties see only the indexer's request, and the
	// browser opens no cross-origin RPC connection. Public keys are already
	// on-chain, so this reveals nothing the chain doesn't already expose — it
	// only moves WHO does the asking from the user to the operator.
	//
	// The body is validated tightly (string keys, BLT shape, small cap) so
	// this can't be turned into an arbitrary get_key_references amplifier; the
	// response is trimmed to the deduped union of account names (the only
	// thing the caller needs to decide unique-vs-ambiguous), never the raw
	// per-key nested arrays.
	app.post('/key-references', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json(errorBody('bad_request', 'invalid JSON body'), 400);
		}
		if (typeof body !== 'object' || body === null || Array.isArray(body)) {
			return c.json(errorBody('bad_request', 'expected an object body'), 400);
		}
		const rawKeys = (body as Record<string, unknown>).keys;
		if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
			return c.json(errorBody('bad_request', 'keys must be a non-empty array'), 400);
		}
		if (rawKeys.length > MAX_KEY_REFERENCES_KEYS) {
			return c.json(errorBody('bad_request', 'too many keys'), 400);
		}
		const keys: string[] = [];
		for (const k of rawKeys) {
			if (typeof k !== 'string' || !BLT_PUBKEY_RE.test(k)) {
				return c.json(errorBody('bad_request', 'malformed public key'), 400);
			}
			keys.push(k);
		}

		let result: unknown;
		try {
			// get_key_references param shape: [[key0, key1, …]] → returns
			// [[accountsForKey0], [accountsForKey1], …] in input order.
			result = await blurt.callCondenser('get_key_references', [keys], {
				userFacing: true
			});
		} catch {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}

		// Flatten to the deduped union of account names. Defense-in-depth:
		// validate every level of the chain's response so a malformed RPC
		// reply can't smuggle a non-string through.
		const accounts = new Set<string>();
		if (Array.isArray(result)) {
			for (const list of result) {
				if (!Array.isArray(list)) continue;
				for (const name of list) {
					if (typeof name === 'string' && name.length > 0) accounts.add(name);
				}
			}
		}
		const out: ChainKeyReferencesBody = { accounts: [...accounts] };
		// A reverse key→name lookup is account state that can change (a key
		// added/removed from an authority), so unlike block/tx this is NOT
		// long-cached; a short private cache only collapses the import flow's
		// own retries.
		c.header('Cache-Control', 'no-store');
		return c.json(out);
	});

	// POST /v1/chain/condenser → { result: <verbatim condenser_api result> }
	//   body: { method: string, params: unknown[] }
	//
	// PRIVACY (priority #1) — the general chain-read relay. cp409/cp410: the
	// browser must NEVER contact a Blurt RPC node directly (it would leak the
	// user's IP + exactly what they're reading to third-party node operators).
	// Every remaining browser chain read — account lookups, account history,
	// the chain head, block/tx verification for chat payment + identity checks —
	// funnels through here, so third parties only ever see the indexer's
	// request and the browser opens no cross-origin RPC connection. This is the
	// generic sibling of the tightly-typed /block, /tx, /properties,
	// /key-references relays above; those keep their per-method validation +
	// caching, this one carries everything else.
	//
	// STRICTLY READ-ONLY + WHITELISTED so it can't be turned into a broadcast
	// path or an arbitrary/expensive-method amplifier against the operator's
	// pool: only the six read methods the frontend actually needs are relayed,
	// the param array is bounded, and the chainApp rate-limit (resource tier)
	// caps the request rate. The result is relayed verbatim (it may legitimately
	// be null, e.g. a not-yet-final get_transaction — the caller handles that),
	// and never cached (account state is volatile and a stale "payment
	// confirmed" must never be served).
	app.post('/condenser', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json(errorBody('bad_request', 'invalid JSON body'), 400);
		}
		if (typeof body !== 'object' || body === null || Array.isArray(body)) {
			return c.json(errorBody('bad_request', 'expected an object body'), 400);
		}
		const method = (body as Record<string, unknown>).method;
		const params = (body as Record<string, unknown>).params ?? [];
		if (typeof method !== 'string' || !RELAYABLE_READ_METHODS.has(method)) {
			return c.json(errorBody('bad_request', 'method not allowed'), 400);
		}
		if (!Array.isArray(params) || params.length > MAX_CONDENSER_PARAMS) {
			return c.json(errorBody('bad_request', 'invalid params'), 400);
		}
		// Bound the serialized payload so a bogus caller can't build a giant
		// upstream query (deep per-arg validation is the chain's job; the
		// whitelist + this cap + the rate-limit are the guardrails).
		if (JSON.stringify(params).length > MAX_CONDENSER_PARAMS_BYTES) {
			return c.json(errorBody('bad_request', 'params too large'), 400);
		}

		let result: unknown;
		try {
			result = await blurt.callCondenser(method, params, { userFacing: true });
		} catch {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
		}
		c.header('Cache-Control', 'no-store');
		return c.json({ result: result ?? null });
	});

	return app;
}
