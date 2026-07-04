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

import type {
	AccountFeedbackResponse,
	AccountFeedbackGivenResponse,
	AccountOrdersResponse,
	AttestorEligibilityResponse,
	BlocksResponse,
	ChatAdmissionResponse,
	ChatHistoryResponse,
	ChatIdentityResponse,
	ChatReadStateResponse,
	ConversationsResponse,
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
	ReleaseResponse,
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

const DEFAULT_TIMEOUT_MS = 8_000;

/** Core fetch wrapper. Handles: timeout via AbortController,
 *  JSON parse error → 'network_error', 200 → T, 4xx/5xx → map
 *  error body. */
async function request<T>(
	path: string,
	init: { signal?: AbortSignal; query?: URLSearchParams; origin?: string; cache?: RequestCache } = {}
): Promise<Result<T>> {
	const url = new URL(path, resolveOrigin(init.origin ?? MORPHIT_INDEXER_ORIGIN));
	if (init.query) {
		// URLSearchParams → concrete entries so we don't override
		// any pre-existing path query.
		for (const [k, v] of init.query) url.searchParams.append(k, v);
	}

	// Compose a timeout signal with any caller-supplied signal.
	const internalAbort = new AbortController();
	const timeoutId = setTimeout(() => internalAbort.abort(), DEFAULT_TIMEOUT_MS);
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
	clearTimeout(timeoutId);

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return {
			ok: false,
			code: 'network_error',
			message: `Malformed response from indexer (status ${response.status})`
		};
	}

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
 *  indexer uses (for the Settings RPC card's server-only rows). */
export function getRpcEndpoints(signal?: AbortSignal): Promise<Result<RpcEndpointsResponse>> {
	return request<RpcEndpointsResponse>('/v1/rpc-endpoints', { signal });
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
	signal?: AbortSignal
): Promise<Result<OrderbookResponse>> {
	const params = new URLSearchParams();
	if (query.asset) params.set('asset', query.asset);
	if (query.side) params.set('side', query.side);
	if (query.fiat_currency) params.set('fiat_currency', query.fiat_currency);
	if (query.location_region) params.set('location_region', query.location_region);
	if (query.payment_methods) params.set('payment_methods', query.payment_methods);
	if (query.min_trades !== undefined && query.min_trades > 0)
		params.set('min_trades', String(query.min_trades));
	if (query.sort && query.sort !== 'recent') params.set('sort', query.sort);
	if (query.limit !== undefined) params.set('limit', String(query.limit));
	if (query.cursor) params.set('cursor', query.cursor);
	return request<OrderbookResponse>('/v1/orderbook', { signal, query: params });
}

/** GET /v1/orderbook from an explicit Morphit instance origin —
 *  used by the orderbook comparison view to fetch a second
 *  instance's orderbook for diffing. The `origin` argument is a
 *  parsed URL's origin (scheme + host + optional port); the
 *  caller is responsible for sanitizing user-supplied input. */
export function getOrderbookFromOrigin(
	origin: string,
	query: OrderbookQuery = {},
	signal?: AbortSignal
): Promise<Result<OrderbookResponse>> {
	const params = new URLSearchParams();
	if (query.asset) params.set('asset', query.asset);
	if (query.side) params.set('side', query.side);
	if (query.fiat_currency) params.set('fiat_currency', query.fiat_currency);
	if (query.location_region) params.set('location_region', query.location_region);
	if (query.payment_methods) params.set('payment_methods', query.payment_methods);
	if (query.min_trades !== undefined && query.min_trades > 0)
		params.set('min_trades', String(query.min_trades));
	if (query.sort && query.sort !== 'recent') params.set('sort', query.sort);
	if (query.limit !== undefined) params.set('limit', String(query.limit));
	if (query.cursor) params.set('cursor', query.cursor);
	return request<OrderbookResponse>('/v1/orderbook', {
		signal,
		query: params,
		origin
	});
}

/** GET /v1/orderbook/featured — top 5 featured slots right now. */
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
 *  slot bids placed by an account on their own orders.  Part 122
 *  cp17.  Returns up to 30 bids ordered newest-first; each row
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

/** GET /v1/release — latest verified release. */
export function getRelease(signal?: AbortSignal): Promise<Result<ReleaseResponse>> {
	return request<ReleaseResponse>('/v1/release', { signal });
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
 * GET /v1/attestor-eligibility/:account — Finding I gate
 * pre-check. Returns whether the given account can currently
 * attest to BTC/XMR orders' fees under the active phase rule.
 * Frontend calls this on order-detail pages before showing
 * the attest button so ineligible users see an explanation
 * instead of a broadcast-rejected error.
 */
export function getAttestorEligibility(
	account: string,
	signal?: AbortSignal
): Promise<Result<AttestorEligibilityResponse>> {
	return request<AttestorEligibilityResponse>(
		`/v1/attestor-eligibility/${encodeURIComponent(account)}`,
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
