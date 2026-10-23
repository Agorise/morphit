/**
 * Morphit indexer — /v1/chain explorer proxies. Anchor.
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
 * block/tx siblings of the balance proxy and the account
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

import { createHash } from 'node:crypto';
import { Hono } from 'hono';

import type { BlurtClient } from '$blurt/client';
import { isTransportError } from '$blurt/client';
import type { Database } from '$db/pool';
import { errorBody } from '$api/shared';
import { blockAgreementKey, findTransaction } from '$blurt/snapshotOpTrust';
import { logger } from '$log';

const log = logger('chain-agreed');

/** The account whose releases the browser's release check follows
 *  (RELEASE_SIGNER_ACCOUNT in apps/web/src/lib/net/releaseCache.ts). */
export const AGREED_HISTORY_ACCOUNT = 'morphit';
/** The op it follows (RELEASE_OP_ID in apps/web/src/lib/net/releaseFetch.ts). */
export const AGREED_RELEASE_OP_ID = 'morphit_release_v1';
/** The history windows that check asks for (RELEASE_HISTORY_WINDOWS there). */
export const AGREED_HISTORY_WINDOWS: ReadonlySet<number> = new Set([100, 10_000]);
/** Operators that must give the same answer. */
export const AGREED_MIN_OPERATORS = 2;
/** An agreed answer is reused this long, counted from when it SETTLED: one
 *  quorum read serves every visitor's check. */
export const AGREED_HISTORY_CACHE_MS = 60_000;
export const AGREED_BLOCK_CACHE_MS = 10 * 60_000;
/** A read that found no agreement is remembered this long: asking again at
 *  once would only ask every operator again. */
export const AGREED_FAIL_CACHE_MS = 30_000;
/** A block may be asked for only while an agreed history named it, and this
 *  long after. */
export const AGREED_NAMED_BLOCK_MS = 10 * 60_000;
/** A visitor waits at most this long; the read goes on and fills the cache
 *  (shorter than a proxy's default 60 s read timeout and the browser's own). */
export const AGREED_ANSWER_DEADLINE_MS = 45_000;
const AGREED_CACHE_MAX = 64;
/** The 502 is logged at most this often. */
const AGREED_LOG_EVERY_MS = 10 * 60_000;

type AgreedMethod = 'get_account_history' | 'get_block';

/** The params the release check sends, and nothing else; null otherwise. PURE. */
export function agreedRequestOf(
	method: unknown,
	params: unknown
): { method: AgreedMethod; params: unknown[] } | null {
	if (!Array.isArray(params)) return null;
	if (method === 'get_account_history') {
		const [account, from, limit] = params as unknown[];
		if (
			params.length === 3 &&
			account === AGREED_HISTORY_ACCOUNT &&
			from === -1 &&
			typeof limit === 'number' &&
			AGREED_HISTORY_WINDOWS.has(limit)
		)
			return { method, params: [account, from, limit] };
		return null;
	}
	if (method === 'get_block') {
		const [num] = params as unknown[];
		if (params.length === 1 && Number.isSafeInteger(num) && (num as number) >= 1)
			return { method, params: [num] };
		return null;
	}
	return null;
}

/** One history entry naming a release op. */
export interface NamedRelease {
	readonly entry: unknown;
	readonly blockNum: number;
	readonly trxId: string;
}

/**
 * The newest @morphit `morphit_release_v1` op in a get_account_history answer
 * — chosen exactly as the browser chooses it (releaseVerifyCore
 * newestCandidate: a custom_json of that id, @morphit a posting auth, JSON
 * that parses, a block number and a 40-hex trx id) — or null when there is
 * none; undefined when the answer is not a history. PURE.
 */
export function newestReleaseEntry(history: unknown): NamedRelease | null | undefined {
	if (!Array.isArray(history)) return undefined;
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (!Array.isArray(entry)) continue;
		const h = entry[1] as { block?: unknown; trx_id?: unknown; op?: unknown } | undefined;
		if (!h || !Array.isArray(h.op) || h.op[0] !== 'custom_json') continue;
		const c = h.op[1] as Record<string, unknown> | undefined;
		if (!c || c.id !== AGREED_RELEASE_OP_ID || typeof c.json !== 'string') continue;
		const auths = Array.isArray(c.required_posting_auths) ? c.required_posting_auths : [];
		if (!auths.some((a) => typeof a === 'string' && a.toLowerCase() === AGREED_HISTORY_ACCOUNT))
			continue;
		try {
			JSON.parse(c.json);
		} catch {
			continue;
		}
		if (
			typeof h.block !== 'number' ||
			!Number.isSafeInteger(h.block) ||
			h.block <= 0 ||
			typeof h.trx_id !== 'string' ||
			!TRX_ID_RE.test(h.trx_id)
		)
			continue;
		return { entry, blockNum: h.block, trxId: h.trx_id.toLowerCase() };
	}
	return null;
}

/** Two operators agree on a history when they name the same newest release
 *  op (not the same bytes: anything else in @morphit's history — a transfer,
 *  a mention — is not what the check reads, and nodes a few seconds apart
 *  would never agree on all of it). */
const historyKey = (answer: unknown): string | null => {
	const sel = newestReleaseEntry(answer);
	if (sel === undefined) return null;
	return sel === null ? 'none' : `${sel.blockNum}|${sel.trxId}`;
};
/** How new a history answer is: the block of the release it names (a node
 *  that is behind names an older one, or none). */
const historyFreshness = (answer: unknown): number | null => {
	const sel = newestReleaseEntry(answer);
	if (sel === undefined) return null;
	return sel === null ? 0 : sel.blockNum;
};

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

export function chainExplorerRoute(blurt: BlurtClient, db: Database): Hono {
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
		} catch (err) {
			// A node that ANSWERED "Unknown Transaction" has told us something:
			// the chain does not have it. That is a 404, not an outage. The
			// browser's chat sweep asks exactly this before it calls a send
			// failed (v1.18.0 review, W3), and needs "no" and "could not ask"
			// kept apart. A transport failure is still a 502.
			if (!isTransportError(err) && isUnknownTransactionError(err)) {
				return c.json(errorBody('not_found', 'no such transaction on chain'), 404);
			}
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
	// The WRITE side of the privacy/reliability story: building any
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
	// time). Relayed here it's the read sibling of the account-keys
	// proxy and the broadcast proxy: the lookup goes server-side across
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

		// Two independent reverse-lookup sources, unioned:
		//
		//   (1) The chain's condenser_api.get_key_references — authoritative for
		//       any key the node's account_by_key plugin has indexed.
		//   (2) The indexer's own accounts.posting_pubkey — catches
		//       accounts whose key the chain plugin DOESN'T index. In practice
		//       that's PRE-FORK / genesis accounts: account_by_key only indexes
		//       keys set by a post-fork operation, so a Steem-era account that
		//       never re-set its posting key on Blurt returns [] from the chain
		//       even though the key is a perfectly valid current authority. Any
		//       such account that has touched Morphit is in our accounts table,
		//       so we can still resolve it and spare the user the manual-name
		//       fallback. Stored posting_pubkey is the same BLT-formatted string
		//       the browser sends, so it's a direct equality match.
		//
		// Best-effort on BOTH: a hit from either is a valid answer, and we only
		// fail the request if BOTH sources error (previously an unreachable RPC
		// pool 502'd even when the indexer could have answered from its own DB).
		const accounts = new Set<string>();
		let chainErrored = false;
		let dbErrored = false;

		try {
			// get_key_references param shape: [[key0, key1, …]] → returns
			// [[accountsForKey0], [accountsForKey1], …] in input order.
			const result = await blurt.callCondenser('get_key_references', [keys], {
				userFacing: true
			});
			// Defense-in-depth: validate every level of the chain's response so a
			// malformed RPC reply can't smuggle a non-string through.
			if (Array.isArray(result)) {
				for (const list of result) {
					if (!Array.isArray(list)) continue;
					for (const name of list) {
						if (typeof name === 'string' && name.length > 0) accounts.add(name);
					}
				}
			}
		} catch {
			chainErrored = true;
		}

		try {
			const rows = await db.query<{ name: string }>(
				`SELECT name FROM accounts WHERE posting_pubkey = ANY($1::text[])`,
				[keys]
			);
			for (const r of rows.rows) {
				if (typeof r.name === 'string' && r.name.length > 0) accounts.add(r.name);
			}
		} catch {
			dbErrored = true;
		}

		// Only surface an error if NEITHER source could answer. If the DB
		// answered (or legitimately returned no rows), a chain outage is not
		// fatal — and vice versa.
		if (chainErrored && dbErrored) {
			return c.json(errorBody('internal', 'could not reach the Blurt network'), 502);
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
	// PRIVACY (priority #1) — the general chain-read relay. the
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

	// POST /v1/chain/agreed → { result }
	//   body: { method: 'get_account_history' | 'get_block', params }
	//
	// The browser's release check (v1.21.14 final review: the browser contacts
	// nothing but its own instance). It used to read @morphit's history and the
	// release's block from two public RPC nodes of different operators itself,
	// at the price of every visitor's address reaching those nodes once a day.
	// Here the instance asks, and relays only what AGREED_MIN_OPERATORS
	// operators of its pool agree on; the browser still checks the signature
	// against the pinned key, so no node can forge a release either way.
	//
	// What is relayed is only what the check reads, and only what was agreed:
	//   history → [the newest release op's entry] (or []), agreed on that op;
	//   block   → { block_id, transactions: [that release's transaction] },
	//             agreed on the transaction, and only for a block an agreed
	//             history named (AGREED_NAMED_BLOCK_MS) — any other number is
	//             refused, so nobody can make the instance ask the whole pool
	//             for blocks that do not exist.
	// Each read is shared: one in flight per question, its answer kept from
	// when it settles (a minute for history, ten for a block; a failure 30 s).
	// So whatever the request rate, the pool sees a handful of reads a minute,
	// and no per-visitor limit is needed beyond the resource tier this app
	// already sits behind (a lower one let one Tor client lock every hidden
	// visitor out of the check). A visitor waits at most
	// AGREED_ANSWER_DEADLINE_MS; the read goes on.
	type AgreedEntry = { settledAt: number | null; ttl: number; value: Promise<unknown> };
	const agreedCache = new Map<string, AgreedEntry>();
	/** Block number → the release trx id an agreed history named, and when. */
	const namedBlocks = new Map<number, { trxId: string; at: number }>();
	let lastFailLog = 0;
	const noteNamed = (history: unknown): void => {
		const sel = newestReleaseEntry(history);
		if (sel) namedBlocks.set(sel.blockNum, { trxId: sel.trxId, at: Date.now() });
		while (namedBlocks.size > AGREED_CACHE_MAX) {
			const oldest = namedBlocks.keys().next().value;
			if (oldest === undefined) break;
			namedBlocks.delete(oldest);
		}
	};
	const startRead = (
		key: string,
		req: { method: AgreedMethod; params: unknown[] },
		trxId: string | null
	): AgreedEntry => {
		const history = req.method === 'get_account_history';
		const value = blurt
			.condenserAgreed<unknown>(
				req.method,
				req.params,
				history ? historyKey : (b) => blockAgreementKey(b, trxId!),
				AGREED_MIN_OPERATORS,
				history ? { mutable: true, freshOf: historyFreshness } : {}
			)
			.then((r) => {
				if (r === null) throw new Error('no agreement');
				if (history) {
					noteNamed(r.value);
					const sel = newestReleaseEntry(r.value);
					return sel ? [sel.entry] : [];
				}
				const tx = findTransaction(r.value, trxId!);
				if (tx === null) throw new Error('no agreement');
				const id = (r.value as { block_id?: unknown }).block_id;
				return { ...(typeof id === 'string' ? { block_id: id } : {}), transactions: [tx] };
			});
		const entry: AgreedEntry = {
			settledAt: null,
			ttl: history ? AGREED_HISTORY_CACHE_MS : AGREED_BLOCK_CACHE_MS,
			value
		};
		value.then(
			() => {
				entry.settledAt = Date.now();
			},
			(err: unknown) => {
				entry.settledAt = Date.now();
				entry.ttl = AGREED_FAIL_CACHE_MS;
				if (entry.settledAt - lastFailLog >= AGREED_LOG_EVERY_MS) {
					lastFailLog = entry.settledAt;
					log.warn(
						'chain_agreed_no_quorum',
						{
							method: req.method,
							minOperators: AGREED_MIN_OPERATORS,
							hint: "the browser's release check needs two RPC operators of this pool that agree"
						},
						err
					);
				}
			}
		);
		agreedCache.set(key, entry);
		while (agreedCache.size > AGREED_CACHE_MAX) {
			const oldest = agreedCache.keys().next().value;
			if (oldest === undefined) break;
			agreedCache.delete(oldest);
		}
		return entry;
	};

	app.post('/agreed', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json(errorBody('bad_request', 'invalid JSON body'), 400);
		}
		if (typeof body !== 'object' || body === null || Array.isArray(body)) {
			return c.json(errorBody('bad_request', 'expected an object body'), 400);
		}
		const req = agreedRequestOf(
			(body as Record<string, unknown>).method,
			(body as Record<string, unknown>).params
		);
		if (req === null) return c.json(errorBody('bad_request', 'read not allowed'), 400);

		const now = Date.now();
		let trxId: string | null = null;
		if (req.method === 'get_block') {
			const named = namedBlocks.get(req.params[0] as number);
			if (named === undefined || now - named.at > AGREED_NAMED_BLOCK_MS)
				return c.json(
					errorBody('bad_request', 'only the block of the release an agreed history names'),
					400
				);
			trxId = named.trxId;
		}
		const key = `${req.method}:${JSON.stringify(req.params)}:${trxId ?? ''}`;
		let hit = agreedCache.get(key);
		// Kept from when it settled; one still in flight is never replaced.
		if (hit !== undefined && hit.settledAt !== null && now - hit.settledAt >= hit.ttl) {
			agreedCache.delete(key);
			hit = undefined;
		}
		if (hit === undefined) hit = startRead(key, req, trxId);

		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<'late'>((resolve) => {
			timer = setTimeout(() => resolve('late'), AGREED_ANSWER_DEADLINE_MS);
		});
		let result: unknown;
		try {
			result = await Promise.race([hit.value, late]);
		} catch {
			return c.json(
				errorBody('internal', 'the Blurt network could not be read from two operators that agree'),
				502
			);
		} finally {
			clearTimeout(timer);
		}
		if (result === 'late') {
			c.header('Retry-After', '30');
			return c.json(errorBody('internal', 'the Blurt network is slow to answer; try again'), 503);
		}
		c.header('Cache-Control', 'no-store');
		return c.json({ result });
	});

	return app;
}

/** Did the node answer that it has no such transaction? */
function isUnknownTransactionError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /unknown transaction/i.test(msg);
}
