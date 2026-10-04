/**
 * Morphit frontend — indexer client.
 *
 * Typed wrappers around the read-only HTTP API in `apps/indexer/`.
 * Every function returns a `Result<T>` so call sites handle
 * `ok`/`not_found`/`error` uniformly without try/catch ceremony.
 *
 * Types are imported from `@morphit/indexer-client` (the shared
 * workspace package) so a schema drift between indexer and
 * frontend fails type-check rather than at runtime.
 */

import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
import { indexerTimeoutMs } from '$net/transportBudget';

import type {
	AccountFeedbackResponse,
	AccountFeedbackGivenResponse,
	AccountOrdersResponse,
	BlocksResponse,
	ChatAdmissionResponse,
	ChatHistoryResponse,
	ChatIdentityResponse,
	ChatReadStateResponse,
	ChatFoldersResponse,
	UserSettingsResponse,
	ConversationsResponse,
	OrderCounterpartiesResponse,
	OrderCounterpartyListsResponse,
	OrderRecord,
	OrderResponse,
	SybilTierResponse,
	FeaturedOrderbookResponse,
	ClearingPriceHistoryResponse,
	FeaturedBidHistoryResponse,
	HealthResponse,
	InstanceResponse,
	InstanceDirectoryResponse,
	OperatorsResponse,
	OrderbookQuery,
	OrderbookResponse,
	ProfileResponse,
	ReputationReceiptResponse,
	StatsResponse,
	RpcEndpointsResponse,
	StrangerFeeQuoteResponse,
	ErrorResponse,
	ErrorCode
} from '@morphit/indexer-client';

/**
 * A discriminated-union result. Call sites destructure on `.ok`:
 *
 *   const r = await indexer.getProfile('alice');
 *   if (r.ok) { use(r.data); }
 *   else if (r.code === 'not_found') { showEmptyState(); }
 *   else { showError(r.message); }
 *
 * The `code` on error values matches the indexer's ErrorCode
 * enum, plus a frontend-only `network_error` for fetch failures
 * that never reached the server.
 */
export type Result<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly code: ErrorCode | 'network_error' | 'timeout';
			readonly message: string;
	  };

// The per-call budget now depends on what the request has to cross, so there is
// no single default here any more — see `indexerTimeoutMs` in
// `$net/transportBudget`. A flat 8s meant that on a Tor/I2P instance essentially
// every frontend request aborted during tunnel setup, and each caller reported
// that as its own kind of failure: an unverifiable chat key, an unreachable peer
// instance, an empty orderbook.

/** Core fetch wrapper. Handles: timeout via AbortController,
 *  JSON parse error → 'network_error', 200 → T, 4xx/5xx → map
 *  error body. */
async function request<T>(
	path: string,
	init: {
		signal?: AbortSignal;
		query?: URLSearchParams;
		cache?: RequestCache;
		/** (v1.20.2) A longer budget for a call that waits on more than this
		 *  indexer (the /compare peer fetch). Never shorter than the default. */
		minTimeoutMs?: number;
	} = {}
): Promise<Result<T>> {
	const url = new URL(path, resolveOrigin(MORPHIT_INDEXER_ORIGIN));
	if (init.query) {
		// URLSearchParams → concrete entries so we don't override
		// any pre-existing path query.
		for (const [k, v] of init.query) url.searchParams.append(k, v);
	}

	// Compose a timeout signal with any caller-supplied signal. Every request
	// goes to this instance's own indexer; the budget depends on whether the
	// page itself is on a hidden origin (every call from a Tor/I2P visitor).
	// A call that waits on more than this indexer (the compare page: the
	// indexer fetches the peer's page) passes a longer minTimeoutMs.
	const internalAbort = new AbortController();
	const timeoutId = setTimeout(
		() => internalAbort.abort(),
		Math.max(indexerTimeoutMs(MORPHIT_INDEXER_ORIGIN), init.minTimeoutMs ?? 0)
	);
	const combined = init.signal
		? anySignal([init.signal, internalAbort.signal])
		: internalAbort.signal;

	let response: Response;
	try {
		response = await fetch(url.toString(), {
			method: 'GET',
			headers: { accept: 'application/json' },
			// Per-call cache mode. Defaults to the browser's heuristic
			// (honours the server's Cache-Control) when omitted; callers
			// fetching operator-mutable config (e.g. branding) pass
			// 'no-cache' to force revalidation so an operator's change
			// shows on the next normal refresh, not only a cold one.
			...(init.cache ? { cache: init.cache } : {}),
			signal: combined
		});
	} catch (err) {
		clearTimeout(timeoutId);
		// AbortError from our internal timeout vs. a caller abort.
		if (internalAbort.signal.aborted) {
			return {
				ok: false,
				code: 'timeout',
				message: 'Request timed out. Try again.'
			};
		}
		return {
			ok: false,
			code: 'network_error',
			message: err instanceof Error ? err.message : 'Network error'
		};
	}
	// NOT cleared yet. `fetch()` resolves on headers; the body is still
	// streaming, and a connection that dies or stalls mid-body — routine over
	// Tor/I2P — would leave the read below with no timeout at all and hang the
	// caller forever. Keeping the abort armed across the body read means a
	// stalled body fails cleanly as a timeout instead of never settling.
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		clearTimeout(timeoutId);
		// Distinguish "the connection died while we were reading" from "the
		// server sent us something that is not JSON". Only the latter is the
		// indexer misbehaving; reporting a truncated hidden-transport read as a
		// malformed response sends the operator looking in the wrong place.
		if (internalAbort.signal.aborted) {
			return { ok: false, code: 'timeout', message: 'Request timed out. Try again.' };
		}
		return {
			ok: false,
			code: 'network_error',
			message: `Malformed response from indexer (status ${response.status})`
		};
	}
	clearTimeout(timeoutId);

	if (response.ok) {
		return { ok: true, data: body as T };
	}

	// Error body — validate minimal shape.
	const err = body as Partial<ErrorResponse>;
	return {
		ok: false,
		code: typeof err.code === 'string' ? (err.code as ErrorCode) : 'internal',
		message:
			typeof err.message === 'string' ? err.message : `Indexer returned status ${response.status}`
	};
}

/** Compose multiple AbortSignals into one — aborts when any input
 *  aborts. The browser's native AbortSignal.any is still not in
 *  all target browsers, so we polyfill. */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
	const ctrl = new AbortController();
	for (const s of signals) {
		if (s.aborted) {
			ctrl.abort();
			break;
		}
		s.addEventListener('abort', () => ctrl.abort(), { once: true });
	}
	return ctrl.signal;
}

// ─── Endpoint wrappers ─────────────────────────────────────────────

/** GET /v1/health — indexer's own self-report. */
export function getHealth(signal?: AbortSignal): Promise<Result<HealthResponse>> {
	return request<HealthResponse>('/v1/health', { signal });
}

/** GET /v1/instance — per-operator branding (instance name,
 *  tagline, contact URL, alt-network reachability).  Cached
 *  client-side via the instance store; this raw fetcher is
 *  exported for the rare case a component needs to bypass the
 *  store (e.g., a comparison view fetching another instance's
 *  branding). */
export function getInstance(signal?: AbortSignal): Promise<Result<InstanceResponse>> {
	// Branding is operator-mutable (name/tagline/contact set via
	// morphit-ops). The indexer still allows caching, but we force a
	// revalidation here so a just-changed operator name appears on a
	// normal refresh instead of waiting out the HTTP cache (the footer
	// used to keep the stale name until a ctrl+shift+r cold reload).
	return request<InstanceResponse>('/v1/instance', { signal, cache: 'no-cache' });
}

/** GET /v1/stats — aggregate-only network summary (for the /stats page and
 *  third-party aggregators). */
export function getStats(signal?: AbortSignal): Promise<Result<StatsResponse>> {
	return request<StatsResponse>('/v1/stats', { signal });
}

/** GET /v1/rpc-endpoints — per-node health of the canonical Blurt RPC pool the
 *  indexer uses (for the Settings RPC card's server-only rows). `probe: true`
 *  asks the indexer to ACTIVELY ping every node right now (fresh latency);
 *  server-side it's rate-limited to once per 5s. Omitted → the cheap
 *  passive pool snapshot. */
export function getRpcEndpoints(opts?: {
	probe?: boolean;
	signal?: AbortSignal;
}): Promise<Result<RpcEndpointsResponse>> {
	const path = opts?.probe === true ? '/v1/rpc-endpoints?probe=1' : '/v1/rpc-endpoints';
	return request<RpcEndpointsResponse>(path, { signal: opts?.signal });
}

/** GET /v1/instances — federation directory (all known peer
 *  Morphit instances with their current probe status).  Phase D.5
 *  replaced the static known-instances.json with this dynamic
 *  endpoint backed by chain-replay + a probe scheduler. */
export function getInstances(
	options: { status?: 'good' | 'quiet' | 'stale' | 'unreachable' | 'mismatch' | 'never' } = {},
	signal?: AbortSignal
): Promise<Result<InstanceDirectoryResponse>> {
	const params = new URLSearchParams();
	if (options.status !== undefined) params.set('status', options.status);
	return request<InstanceDirectoryResponse>('/v1/instances', { signal, query: params });
}

/** GET /v1/orderbook — filtered, paginated live orders. */
export function getOrderbook(
	query: OrderbookQuery = {},
	signal?: AbortSignal,
	/** (v1.20.2) e.g. the compare page's full 100-row page on a busy node. */
	minTimeoutMs?: number
): Promise<Result<OrderbookResponse>> {
	const params = new URLSearchParams();
	if (query.asset) params.set('asset', query.asset);
	if (query.side) params.set('side', query.side);
	if (query.fiat_currency) params.set('fiat_currency', query.fiat_currency);
	if (query.location_region) params.set('location_region', query.location_region);
	if (query.payment_methods) params.set('payment_methods', query.payment_methods);
	if (query.langs) params.set('langs', query.langs);
	if (query.min_trades !== undefined && query.min_trades > 0)
		params.set('min_trades', String(query.min_trades));
	if (query.sort && query.sort !== 'recent') params.set('sort', query.sort);
	if (query.limit !== undefined) params.set('limit', String(query.limit));
	if (query.cursor) params.set('cursor', query.cursor);
	return request<OrderbookResponse>('/v1/orderbook', {
		signal,
		query: params,
		...(minTimeoutMs !== undefined ? { minTimeoutMs } : {})
	});
}

/** How long the compare page waits for its OWN indexer to fetch a peer's
 *  page: the indexer's overall deadline (50 s, api/compareOrderbook.ts) plus
 *  the trip to it. */
export const PEER_ORDERBOOK_TIMEOUT_MS = 65_000;

/** /v1/compare/orderbook's answer: the peer's first page reduced to each
 *  order's identity and sort key (the indexer relays nothing else). */
export interface PeerOrderbookResponse {
	readonly items: readonly Pick<OrderRecord, 'account' | 'permlink' | 'updated_at'>[];
	readonly next_cursor: string | null;
	readonly indexed_block: number;
	readonly origin: string;
}

/** (v1.20.2) Another instance's first orderbook page, fetched BY THIS
 *  INSTANCE (`GET /v1/compare/orderbook?origin=…`, same origin). The page's
 *  CSP `connect-src` allows only 'self' and the RPC nodes, so the browser
 *  cannot ask the peer itself; the indexer asks it over the peer's registered
 *  (hidden or pinned clearnet) address. Errors carry the indexer's `reason`:
 *  `unknown_instance`, `same_instance`, `target_unreachable`,
 *  `target_bad_answer`, `compare_rate_limited`, `bad_target`. */
export function getPeerOrderbook(
	origin: string,
	signal?: AbortSignal
): Promise<Result<PeerOrderbookResponse>> {
	const params = new URLSearchParams();
	params.set('origin', origin);
	return request<PeerOrderbookResponse>('/v1/compare/orderbook', {
		signal,
		query: params,
		minTimeoutMs: PEER_ORDERBOOK_TIMEOUT_MS
	});
}

/** GET /v1/orderbook/featured — the live featured slots right now (up to
 *  the response's `max_slots`, currently 3). */
export function getFeaturedOrderbook(
	signal?: AbortSignal
): Promise<Result<FeaturedOrderbookResponse>> {
	return request<FeaturedOrderbookResponse>('/v1/orderbook/featured', { signal });
}

/** GET /v1/orderbook/featured/clearing-price-history — daily
 *  clearing-price series over the last 7 / 30 / 90 days.
 *  Returned points are sorted oldest-first. */
export function getClearingPriceHistory(
	opts: { window?: 7 | 30 | 90; signal?: AbortSignal } = {}
): Promise<Result<ClearingPriceHistoryResponse>> {
	const params = new URLSearchParams();
	if (opts.window !== undefined) params.set('window', String(opts.window));
	return request<ClearingPriceHistoryResponse>('/v1/orderbook/featured/clearing-price-history', {
		signal: opts.signal,
		query: params
	});
}

/** GET /v1/orderbook/featured/bids?account=X — recent featured-
 *  slot bids placed by an account on their own orders.
 *  Returns up to 30 bids ordered newest-first; each row
 *  carries `is_visible` so the UI can mark currently-visible
 *  bids vs paid-but-outranked vs expired. */
export function getFeaturedBidHistory(
	account: string,
	signal?: AbortSignal
): Promise<Result<FeaturedBidHistoryResponse>> {
	const params = new URLSearchParams({ account });
	return request<FeaturedBidHistoryResponse>('/v1/orderbook/featured/bids', {
		signal,
		query: params
	});
}

/** GET /v1/orders/:account — all orders for one account. */
export function getOrdersByAccount(
	account: string,
	opts: { limit?: number; cursor?: string; signal?: AbortSignal } = {}
): Promise<Result<AccountOrdersResponse>> {
	const params = new URLSearchParams();
	if (opts.limit !== undefined) params.set('limit', String(opts.limit));
	if (opts.cursor) params.set('cursor', opts.cursor);
	return request<AccountOrdersResponse>(`/v1/orders/${encodeURIComponent(account)}`, {
		signal: opts.signal,
		query: params
	});
}

/** An account's orders, newest-updated first, following the cursor for up to
 *  `maxPages` pages of 100, one request at a time. Null when the first page
 *  fails; a later page's failure keeps what was read. `complete` is false when
 *  more orders exist than were read. */
export async function getAccountOrderPages(
	account: string,
	opts: { maxPages?: number; signal?: AbortSignal } = {}
): Promise<{ readonly items: OrderRecord[]; readonly complete: boolean } | null> {
	const items: OrderRecord[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < (opts.maxPages ?? 5); i++) {
		const r = await getOrdersByAccount(account, { limit: 100, cursor, signal: opts.signal });
		if (!r.ok) {
			if (i === 0) return null;
			return { items, complete: false };
		}
		items.push(...r.data.items);
		if (!r.data.next_cursor) return { items, complete: true };
		cursor = r.data.next_cursor;
	}
	return { items, complete: false };
}

/** GET /v1/orders/:account/:permlink — one order, whatever its age (404
 *  `not_found` when this instance has none, or hides its owner). Use this,
 *  not a search of getOrdersByAccount, which returns only the newest page. */
export function getOrder(
	account: string,
	permlink: string,
	signal?: AbortSignal
): Promise<Result<OrderResponse>> {
	return request<OrderResponse>(
		`/v1/orders/${encodeURIComponent(account)}/${encodeURIComponent(permlink)}`,
		{ signal }
	);
}

/** GET /v1/orders/:account/sybil_tier[?at=ISO] — how many of the account's
 *  orders count toward its Sybil fee tier, counted by the indexer with the same
 *  query its order handler charges by. The next order is the (count + 1)-th. */
export function getSybilTier(
	account: string,
	opts: { at?: Date; signal?: AbortSignal } = {}
): Promise<Result<SybilTierResponse>> {
	const params = new URLSearchParams();
	if (opts.at) params.set('at', opts.at.toISOString());
	return request<SybilTierResponse>(`/v1/orders/${encodeURIComponent(account)}/sybil_tier`, {
		signal: opts.signal,
		query: params,
		cache: 'no-store'
	});
}

/** Most orders one counterparty_lists request may name (the indexer's cap). */
export const COUNTERPARTY_LISTS_BATCH = 50;

/** GET /v1/orders/:owner/counterparty_lists?permlinks=a,b,… — the
 *  counterparty list of up to COUNTERPARTY_LISTS_BATCH of the owner's orders
 *  in one request; each list is what getOrderCounterparties returns for it. */
export function getOrderCounterpartyLists(
	owner: string,
	permlinks: readonly string[],
	signal?: AbortSignal
): Promise<Result<OrderCounterpartyListsResponse>> {
	const params = new URLSearchParams();
	params.set('permlinks', permlinks.join(','));
	return request<OrderCounterpartyListsResponse>(
		`/v1/orders/${encodeURIComponent(owner)}/counterparty_lists`,
		{ signal, query: params }
	);
}

/** One order looked up by account + permlink: the direct read, so an order
 *  older than the newest page is still found. `null` = this instance has no
 *  such order; `undefined` = the read failed (network, timeout, server). */
export async function findOrder(
	account: string,
	permlink: string,
	signal?: AbortSignal
): Promise<OrderRecord | null | undefined> {
	const r = await getOrder(account, permlink, signal);
	if (r.ok) return r.data.item;
	if (r.code === 'not_found') return null;
	return undefined;
}

/** GET /v1/profiles/:account — single profile. */
export function getProfile(
	account: string,
	signal?: AbortSignal
): Promise<Result<ProfileResponse>> {
	return request<ProfileResponse>(`/v1/profiles/${encodeURIComponent(account)}`, {
		signal
	});
}

/** GET /v1/accounts/:account/feedback — summary + page. */
export function getFeedback(
	account: string,
	opts: { limit?: number; cursor?: string; signal?: AbortSignal } = {}
): Promise<Result<AccountFeedbackResponse>> {
	const params = new URLSearchParams();
	if (opts.limit !== undefined) params.set('limit', String(opts.limit));
	if (opts.cursor) params.set('cursor', opts.cursor);
	return request<AccountFeedbackResponse>(`/v1/accounts/${encodeURIComponent(account)}/feedback`, {
		signal: opts.signal,
		query: params
	});
}

/** GET /v1/accounts/:account/reputation-receipt — the "show your
 *  work" endpoint.  Returns every feedback row about the account
 *  (including excluded ones with reasons) so a reader can re-derive
 *  the weighted_rating locally and verify it matches.
 *
 *  Optional `asOf` argument pins the wall-clock used for decay-
 *  weight computation.  Defaults to NOW() server-side. */
export function getReputationReceipt(
	account: string,
	opts: { asOf?: Date; signal?: AbortSignal } = {}
): Promise<Result<ReputationReceiptResponse>> {
	const params = new URLSearchParams();
	if (opts.asOf) params.set('as_of', opts.asOf.toISOString());
	return request<ReputationReceiptResponse>(
		`/v1/accounts/${encodeURIComponent(account)}/reputation-receipt`,
		{
			signal: opts.signal,
			query: params
		}
	);
}

/** GET /v1/accounts/:account/feedback-given — feedback the account
 *  has LEFT for other accounts. Used by the profile page's
 *  "Given" section. No summary: reviewer's own rating-distribution
 *  across targets isn't meaningful reputation data. */
export function getFeedbackGiven(
	account: string,
	opts: { limit?: number; cursor?: string; signal?: AbortSignal } = {}
): Promise<Result<AccountFeedbackGivenResponse>> {
	const params = new URLSearchParams();
	if (opts.limit !== undefined) params.set('limit', String(opts.limit));
	if (opts.cursor) params.set('cursor', opts.cursor);
	return request<AccountFeedbackGivenResponse>(
		`/v1/accounts/${encodeURIComponent(account)}/feedback-given`,
		{ signal: opts.signal, query: params }
	);
}

/** GET /v1/chat/:a/:b — ciphertext between two accounts. */
export function getChatHistory(
	a: string,
	b: string,
	opts: { limit?: number; cursor?: string; signal?: AbortSignal } = {}
): Promise<Result<ChatHistoryResponse>> {
	const params = new URLSearchParams();
	if (opts.limit !== undefined) params.set('limit', String(opts.limit));
	if (opts.cursor) params.set('cursor', opts.cursor);
	return request<ChatHistoryResponse>(
		`/v1/chat/${encodeURIComponent(a)}/${encodeURIComponent(b)}`,
		{ signal: opts.signal, query: params }
	);
}

/**
 * GET /v1/chat-identity/:account — the account's published X25519
 * chat public key. ADR-0015. Returns `not_found` if the account
 * has never published (they must open chat once to auto-publish).
 * Callers should treat `not_found` as "peer not ready yet" rather
 * than as an error.
 */
export function getChatIdentity(
	account: string,
	signal?: AbortSignal
): Promise<Result<ChatIdentityResponse>> {
	return request<ChatIdentityResponse>(`/v1/chat-identity/${encodeURIComponent(account)}`, {
		signal
	});
}

/**
 * GET /v1/conversations/:account — list the account's active
 * conversations (peer + last-message-at + message-count), most
 * recent first. Unread tracking is client-side; the server does
 * not track per-user read state.
 */
export function getConversations(
	account: string,
	signal?: AbortSignal
): Promise<Result<ConversationsResponse>> {
	return request<ConversationsResponse>(`/v1/conversations/${encodeURIComponent(account)}`, {
		signal
	});
}

/**
 * GET /v1/orders/:owner/:permlink/counterparties — the accounts who
 * messaged the owner about a specific order, each with an OPAQUE
 * `reviewable` flag (true iff a feedback op from owner→peer for this
 * order would pass the indexer's provable-counterparty gate). Used by
 * /my/orders to gate the "Mark complete / review" button + prefill the
 * trade partner, so a user never submits a review the indexer drops.
 */
export function getOrderCounterparties(
	owner: string,
	permlink: string,
	opts: { limit?: number; signal?: AbortSignal } = {}
): Promise<Result<OrderCounterpartiesResponse>> {
	const qs = opts.limit !== undefined ? `?limit=${opts.limit}` : '';
	return request<OrderCounterpartiesResponse>(
		`/v1/orders/${encodeURIComponent(owner)}/${encodeURIComponent(permlink)}/counterparties${qs}`,
		{ signal: opts.signal }
	);
}

/**
 * GET /v1/chat-read-state/:account — the set of (peer,
 * last_read_at) entries the account has written via
 * morphit_chat_read_v1. Used by the inbox to compute unread
 * status server-authoritatively; clients merge this with local
 * `readState` for offline-first UX.
 */
export function getChatReadState(
	account: string,
	signal?: AbortSignal
): Promise<Result<ChatReadStateResponse>> {
	return request<ChatReadStateResponse>(`/v1/chat-read-state/${encodeURIComponent(account)}`, {
		signal
	});
}

/**
 * GET /v1/chat-folders/:account — the account's ENCRYPTED chat folder
 * organization blob, or `enc: null` if never saved. The blob
 * is opaque ciphertext; the caller decrypts it with a posting-key-derived key.
 */
export function getChatFolders(
	account: string,
	signal?: AbortSignal
): Promise<Result<ChatFoldersResponse>> {
	return request<ChatFoldersResponse>(`/v1/chat-folders/${encodeURIComponent(account)}`, {
		signal
	});
}

/**
 * GET /v1/settings/:account — the account's ENCRYPTED settings blob (v1.5.0
 * settings-to-chain mirroring), or `enc: null` if never saved. The caller
 * decrypts it with a posting-key-derived key.
 */
export function getUserSettings(
	account: string,
	signal?: AbortSignal
): Promise<Result<UserSettingsResponse>> {
	return request<UserSettingsResponse>(`/v1/settings/${encodeURIComponent(account)}`, {
		signal
	});
}

/**
 * GET /v1/blocks/:account — list of accounts the given account
 * has currently blocked. Used by the Settings "Blocked accounts"
 * page and the chat UI's block-state indicator. Rows with
 * state='unblocked' are filtered out server-side; this returns
 * CURRENT block relationships only.
 */
export function getBlocks(account: string, signal?: AbortSignal): Promise<Result<BlocksResponse>> {
	return request<BlocksResponse>(`/v1/blocks/${encodeURIComponent(account)}`, { signal });
}

/**
 * GET /v1/chat-admission/:me/:peer — whether messaging :peer
 * from :me would pass the chat handler's Finding H layer-2
 * gate right now. Frontend calls this on conversation mount
 * to decide whether to show the composer normally or to gate
 * behind a pay-stranger-fee affordance.
 */
export function getChatAdmission(
	me: string,
	peer: string,
	signal?: AbortSignal
): Promise<Result<ChatAdmissionResponse>> {
	return request<ChatAdmissionResponse>(
		`/v1/chat-admission/${encodeURIComponent(me)}/${encodeURIComponent(peer)}`,
		{ signal }
	);
}

/**
 * GET /v1/stranger-fee-quote/:sender — Finding H escalation
 * pre-quote. Returns the current USD-equivalent price for the
 * sender's next first-contact message, including the multiplier
 * and recent-payment count. Frontend calls this when opening
 * the pay-to-message modal so the user sees the actual price
 * (which may be 2×, 4×, ..., 128× the base if they've been
 * sending fast) BEFORE they sign.
 */
export function getStrangerFeeQuote(
	sender: string,
	signal?: AbortSignal
): Promise<Result<StrangerFeeQuoteResponse>> {
	return request<StrangerFeeQuoteResponse>(`/v1/stranger-fee-quote/${encodeURIComponent(sender)}`, {
		signal
	});
}

/**
 * GET /v1/operators — public directory of registered operators.
 *
 * Phase 5b scaffolding. The endpoint exists but always returns
 * `{operators: []}` until ADR-0013 is accepted and the
 * registration op lands. Frontend callers should render an
 * empty-state cleanly; don't treat an empty array as an error.
 */
export function getOperators(signal?: AbortSignal): Promise<Result<OperatorsResponse>> {
	return request<OperatorsResponse>('/v1/operators', { signal });
}

// ─── Activity stats (Batch K) ───────────────────────────────────────

export interface ActivityVolumeWindow {
	readonly asset: string;
	readonly trade_count: number;
	readonly estimated_volume: number;
}

export interface ActivityVolumeResponse {
	readonly window_7d: readonly ActivityVolumeWindow[];
	readonly window_30d: readonly ActivityVolumeWindow[];
	readonly window_90d: readonly ActivityVolumeWindow[];
	readonly generated_at: string;
}

/** GET /v1/activity/volume — completed-trade counts and estimated
 *  volume by asset, over 7d/30d/90d windows.  See indexer-side
 *  apps/indexer/src/api/activity.ts for the volume-estimation
 *  caveat (mid-point of order's amount range, since the chain
 *  doesn't carry exact fill amounts on feedback). */
export function getActivityVolume(signal?: AbortSignal): Promise<Result<ActivityVolumeResponse>> {
	return request<ActivityVolumeResponse>('/v1/activity/volume', { signal });
}

// ─── Instance payment-method additions (Batch L) ────────────────────

export interface InstancePaymentMethodEntry {
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly category: 'crypto' | 'in_person' | 'online';
	readonly url: string | null;
}

export interface InstancePaymentMethodsResponse {
	readonly additions: readonly InstancePaymentMethodEntry[];
	readonly generated_at: string;
}

/** GET /v1/instance/payment-methods — operator-defined additions
 *  for this Morphit instance.  ADR-0021 — extends the canonical
 *  registry with region-specific methods.  Each key already
 *  carries the `@instance:` prefix. */
export function getInstancePaymentMethods(
	signal?: AbortSignal
): Promise<Result<InstancePaymentMethodsResponse>> {
	return request<InstancePaymentMethodsResponse>('/v1/instance/payment-methods', { signal });
}

// ─── Operator-instance block status (ADR-0018) ──────────────────────

/** A blocked-status response from /v1/operator-blocks/by-blocked.
 *  When `blocked: false`, the other fields are absent.  When
 *  `blocked: true`, the full audit trail (operator, reason, since
 *  block num + trx id, timestamps) is included. */
export type OperatorBlockStatus =
	| { readonly account: string; readonly blocked: false }
	| {
			readonly account: string;
			readonly blocked: true;
			readonly operator: string;
			readonly reason: string;
			readonly since_block_num: number;
			readonly since_trx_id: string;
			readonly created_at: string;
			readonly updated_at: string;
	  };

/** GET /v1/operator-blocks/by-blocked/:account — does this Morphit
 *  instance currently have an operator-block against `account`?
 *  ADR-0018.  The signed-in user's account is queried on app boot;
 *  if `blocked: true` comes back, the OperatorBlockBanner component
 *  surfaces the operator's reason + audit trail in a non-dismissible
 *  banner.
 *
 *  Failure mode: any network / shape error returns `Result<...>`
 *  with `ok: false`.  Caller should treat that as
 *  "block-status unknown" and not render the banner — better to
 *  show no banner on a transient indexer hiccup than to render a
 *  false alarm. */
export function getOperatorBlockStatus(
	account: string,
	signal?: AbortSignal
): Promise<Result<OperatorBlockStatus>> {
	return request<OperatorBlockStatus>(
		`/v1/operator-blocks/by-blocked/${encodeURIComponent(account)}`,
		{ signal }
	);
}
