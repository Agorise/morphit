/**
 * Morphit indexer — entry point.
 *
 * Boot sequence:
 *   1. Load + validate config (fail fast on bad env)
 *   2. Create pg pool
 *   3. Run pending schema migrations
 *   4. Create BlurtClient
 *   5. Construct Poller, start it
 *   6. Mount HTTP routes + middleware
 *   7. Start HTTP server
 *
 * Both the poller and HTTP server run concurrently. Shutdown
 * (SIGTERM/SIGINT) stops the poller first so it can finish its
 * current block transaction, then closes the HTTP server, then
 * closes the DB pool.
 */

import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';

import { loadOperatorConfig } from '@morphit/operator-config';
import { loadConfig } from '$config';
import { createDatabase } from '$db/pool';
import { runMigrations } from '$db/migrations';
import { seedFederationDirectory } from '$indexer/federationSeed';
import { BlurtClient } from '$blurt/client';
import { Poller } from '$indexer/poller';
import { createMultiAssetPriceSources } from '$indexer/price/factory';
import { startPeerPriceMonitor } from '$indexer/price/peerPriceMonitor';
import type { BlurtPriceSource } from '$indexer/price/source';

import { bodyCap } from '$api/middleware/bodyCap';
import { security } from '$api/middleware/security';
import { cors } from '$api/middleware/cors';
import { rateLimit } from '$api/middleware/ratelimit';

import { healthRoute } from '$api/health';
import { instanceRoute } from '$api/instance';
import { chainFeeRoute } from '$api/chainFee';
import { instancesRoute } from '$api/instances';
import { instancesStreamRoute } from '$api/instancesStream';
import { listingFeeRoute } from '$api/listingFee';
import { priceReceiptRoute } from '$api/priceReceipt';
import { orderbookRoute } from '$api/orderbook';
import { orderbookStreamRoute } from '$api/orderbookStream';
import { featuredRoute } from '$api/featuredOrderbook';
import { featuredBidsRoute } from '$api/featuredBids';
import { clearingPriceHistoryRoute } from '$api/clearingPriceHistory';
import { loginPairingRoute, PairingRegistry } from '$api/loginPairing';
import { ordersByAccountRoute } from '$api/orders';
import { orderViewsRoute } from '$api/orderViews';
import { profilesRoute } from '$api/profiles';
import { feedbackByAccountRoute } from '$api/feedback';
import { reputationReceiptRoute } from '$api/reputationReceipt';
import { releaseRoute } from '$api/release';
import { chatRoute } from '$api/chat';
import { chatStreamRoute } from '$api/chatStream';
import { chatIdentityRoute } from '$api/chatIdentity';
import { chatReadStateRoute } from '$api/chatReadState';
import { chatAdmissionRoute } from '$api/chatAdmission';
import { blocksRoute } from '$api/blocks';
import { attestorEligibilityRoute } from '$api/attestorEligibility';
import { strangerFeeQuoteRoute } from '$api/strangerFeeQuote';
import { conversationsRoute } from '$api/conversations';
import { rssOrderbookRoute } from '$api/rssOrderbook';
import { operatorsRoute } from '$api/operators';
import { activityRoute } from '$api/activity';
import { instancePaymentMethodsRoute } from '$api/instancePaymentMethods';
import { operatorBlocksRoute } from '$api/operatorBlocks';
import { logger } from '$log';

const bootLog = logger('boot');
const httpLog = logger('http');
const shutdownLog = logger('shutdown');
const procLog = logger('process');
const pollerLog = logger('poller');

async function main(): Promise<void> {
	// ─── 0. Operator config file (optional) ─────────────────────
	// Reads morphit.config.env (a small operator-friendly key=value
	// file) if present, projecting whitelisted keys into
	// process.env. OS-set env vars always win — this only fills
	// in keys that aren't already set. Operators who use only
	// env vars (SystemD, Docker compose) see no behavior change.
	loadOperatorConfig({
		searchPaths: [process.cwd(), `${import.meta.dirname}/../../..`]
	});

	// ─── 1. Config ──────────────────────────────────────────────
	const config = loadConfig();
	bootLog.info('starting', {
		listen_host: config.listenHost,
		listen_port: config.listenPort,
		rpc_endpoints: config.blurtRpcEndpoints.length
	});

	// ─── 2. Database ────────────────────────────────────────────
	const db = createDatabase(config);

	// ─── 3. Migrations ─────────────────────────────────────────
	const mig = await runMigrations(db);
	if (mig.applied.length > 0) {
		bootLog.info('migrations_applied', { versions: mig.applied });
	}

	// ─── 3a. Federation seed (Phase D.5) ────────────────────────
	// Hardcoded reference instances inserted into known_instances
	// with status='never'.  Idempotent.  Probe scheduler picks them
	// up on its first tick and verifies them like any other peer.
	// Short-circuits chain-replay latency for fresh deploys.
	await seedFederationDirectory(db);

	// ─── 4. Blurt client ───────────────────────────────────────
	const blurt = new BlurtClient(config);

	// ─── 5. Optional price sources (cp130 multi-asset; cp131 consolidated) ──
	//
	// History:
	//   - Pre-cp130: a single `createPriceSource(config, db)` for
	//     BLURT only.  /v1/listing-fee and /v1/health consumed it
	//     directly.
	//   - cp130: added `createMultiAssetPriceSources` for the
	//     BLURT + BTC + XMR set, kept the standalone BLURT
	//     priceSource alive in parallel for hot-path stability.
	//     Both made independent outbound HTTP calls to fetch
	//     BLURT pricing — a needless 2x cost for priority #4
	//     (tiny footprint) and a duplicated failure surface.
	//   - cp131 LOW-005 (this checkpoint): consolidated.  When
	//     priceFeedEnabled, the BLURT-only callers (listing fee,
	//     health, poller) consume `multiAssetSources.get('BLURT')`
	//     instead of a parallel-instantiated standalone source.
	//     Single fetch loop, single cache.  When priceFeedEnabled
	//     is false, no source exists and callers receive null —
	//     same behavior as pre-cp130 disabled mode.
	//
	// `priceSource` is preserved as the named handle the
	// downstream callers still expect (`BlurtPriceSource | null`).
	// It's now ALIASED to the BLURT entry in the multi-asset map.
	// The map ALSO contains it, so the start()/stop() loops below
	// (which iterate multiAssetSources.values()) cover the BLURT
	// source — no separate start()/stop() is needed for the alias.
	const multiAssetSources: Map<string, BlurtPriceSource> = config.priceFeedEnabled
		? createMultiAssetPriceSources(config, db)
		: new Map();
	for (const source of multiAssetSources.values()) {
		source.start();
	}
	const priceSource: BlurtPriceSource | null =
		multiAssetSources.get('BLURT') ?? null;

	// cp129 — Defense F: cross-instance peer price monitor.  Opt-in
	// via MORPHIT_INDEXER_PEER_PRICE_MONITOR_ENABLED.  Requires
	// priceSource to be live (otherwise nothing to compare against),
	// AND at least 3 federation peers reachable for meaningful
	// median computation.  See ADR-0041.
	//
	// cp130 extension: when multi-asset sources are live, spawn one
	// monitor instance per (asset, denomination) pair.  Each monitor
	// independently samples peers for its asset and alerts on
	// per-asset disagreement.  The schema already supports per-asset
	// observations (cp129 schema-v36 indexed on asset+denomination);
	// the wiring change here just calls startPeerPriceMonitor in a
	// loop.
	const stopPeerPriceMonitors: Array<() => void> = [];
	if (config.priceFeedPeerMonitorEnabled && multiAssetSources.size > 0) {
		for (const [asset, source] of multiAssetSources) {
			const stop = startPeerPriceMonitor(
				{
					db,
					priceSource: source,
					asset,
					denominationFiat: config.priceFeedDenominationFiat
				},
				config.priceFeedPeerSampleIntervalMinutes
			);
			stopPeerPriceMonitors.push(stop);
		}
	}

	// ─── 6. Poller ─────────────────────────────────────────────
	const poller = new Poller(config, db, blurt, priceSource);
	// Fire-and-forget; the promise only resolves on shutdown.
	const pollerPromise = poller.run().catch((err) => {
		pollerLog.error('fatal', {}, err);
		// Fatal poller failure — shut down the whole process so the
		// supervisor (systemd) restarts us with a clean state.
		process.exit(1);
	});

	// ─── 7. HTTP app ───────────────────────────────────────────
	const app = new Hono();

	// Middleware chain, applied to every request in order.
	app.use('*', security);
	app.use('*', cors(config.allowedOrigins));
	app.use('*', bodyCap(config.maxRequestBodyBytes));

	// Versioned API routes. Each route gets its own rate-limit tier
	// per ADR-0008: list endpoints (orderbook, per-account order
	// list, feedback list, chat history) at the lower `list` limit;
	// single-resource endpoints (profile, release) at the higher
	// `resource` limit.
	app.route('/v1/health', healthRoute(config, poller, priceSource));
	app.route('/v1/instance', instanceRoute(config));
	app.route('/v1/instances/stream', instancesStreamRoute(db));
	app.route('/v1/instances', instancesRoute(db));

	// /v1/chain-fee — current account_creation_fee from Blurt
	// chain, cached 24h.  Frontend renders the live value in
	// FAQ entries and signup hints instead of hardcoding "100
	// BLURT" everywhere.  See apps/indexer/src/api/chainFee.ts
	// for cache + fallback logic.
	const chainFeeApp = new Hono();
	chainFeeApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	chainFeeApp.route('/', chainFeeRoute(blurt, config));
	app.route('/v1/chain-fee', chainFeeApp);

	const listingFeeApp = new Hono();
	listingFeeApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	listingFeeApp.route('/', listingFeeRoute(config, priceSource));
	app.route('/v1/listing-fee', listingFeeApp);

	// cp127: price-derivation receipt endpoint.  Resource-rate-
	// limited (same as listing-fee — these are forensic-grade
	// reads, not list pagination).  Available whether or not the
	// native fetcher is currently in the composite chain; operators
	// can use the receipt to evaluate what the native fetcher WOULD
	// produce before enabling it.
	const priceReceiptApp = new Hono();
	priceReceiptApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	priceReceiptApp.route('/', priceReceiptRoute(db, config));
	app.route('/v1/price', priceReceiptApp);

	// Phase E — orderbook SSE.  Mounted at /v1/orderbook/stream
	// BEFORE the rate-limited /v1/orderbook so the more-specific
	// path wins (Hono routes by mount order at the parent level).
	// Long-lived SSE connections shouldn't share a per-minute
	// budget with REST GETs.  Per-IP open-connection caps belong
	// at the reverse-proxy layer, not here.
	app.route('/v1/orderbook/stream', orderbookStreamRoute(db, poller));

	const orderbookApp = new Hono();
	orderbookApp.use('*', rateLimit('list', config.listRatePerMin));
	orderbookApp.route('/', orderbookRoute(db, poller));
	orderbookApp.route('/featured', featuredRoute(db));
	// Clearing-price history sits under /featured/clearing-price-history
	// (closely related; lets clients fetch in one base URL).  Same
	// 'list' rate-limit tier inherited from orderbookApp.
	orderbookApp.route('/featured/clearing-price-history', clearingPriceHistoryRoute(db));
	// Bid history per account — cp17 refinement.  Same 'list'
	// tier inheritance.  Account is a query param, not a path
	// segment, because it's optional/filterable rather than
	// addressable.
	orderbookApp.route('/featured/bids', featuredBidsRoute(db));
	app.route('/v1/orderbook', orderbookApp);

	// ADR-0022 — desktop QR pairing.  Mounted at top level
	// because the endpoint isn't an orderbook concern.  POST
	// /:pid/deliver is rate-limited 'resource' tier; GET
	// /:pid/wait is SSE and intentionally NOT rate-limited at
	// the per-minute level (long-lived connections), same
	// posture as /v1/orderbook/stream.  Per-IP open-connection
	// caps belong at the reverse-proxy layer.
	const pairingRegistry = new PairingRegistry();
	const loginPairingApp = new Hono();
	loginPairingApp.use('/:pid/deliver', rateLimit('resource', config.resourceRatePerMin));
	loginPairingApp.route('/', loginPairingRoute(pairingRegistry));
	app.route('/v1/login-pairing', loginPairingApp);

	const ordersApp = new Hono();
	ordersApp.use('*', rateLimit('list', config.listRatePerMin));
	ordersApp.route('/', ordersByAccountRoute(db));
	// Task #14 — private viewcounts.  Same /v1/orders namespace
	// because the routes are :account/:permlink/view{,s}.  Inherits
	// the existing 'list' rate-limit tier; nginx limit_req_zone is
	// the right place for stricter write-side spam protection.
	ordersApp.route('/', orderViewsRoute(db));
	app.route('/v1/orders', ordersApp);

	const profilesApp = new Hono();
	profilesApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	profilesApp.route('/', profilesRoute(db));
	app.route('/v1/profiles', profilesApp);

	const feedbackApp = new Hono();
	feedbackApp.use('*', rateLimit('list', config.listRatePerMin));
	feedbackApp.route('/', feedbackByAccountRoute(db));
	// cp124 H4: verifiable reputation receipt — same /v1/accounts
	// mount point; resource-rate-limited rather than list-rate-
	// limited because the receipt is "one big read" not pagination.
	feedbackApp.route('/', reputationReceiptRoute(db));
	app.route('/v1/accounts', feedbackApp);

	const releaseApp = new Hono();
	releaseApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	releaseApp.route('/', releaseRoute(db));
	app.route('/v1/release', releaseApp);

	// Phase E.5 — chat SSE.  Mounted at /v1/chat/:a/:b/stream
	// BEFORE the rate-limited /v1/chat so the more-specific
	// path wins.  Long-lived SSE connections shouldn't share a
	// per-minute budget with REST GETs.  Per-IP open-connection
	// caps belong at the reverse-proxy layer.
	app.route('/v1/chat', chatStreamRoute(db, poller));

	const chatApp = new Hono();
	chatApp.use('*', rateLimit('list', config.listRatePerMin));
	chatApp.route('/', chatRoute(db));
	app.route('/v1/chat', chatApp);

	// Chat-identity lookups: pubkey publication and retrieval.
	// Separate mount so clients can rate-limit the frequent lookup
	// independently from the transcript transport on /v1/chat.
	const chatIdentityApp = new Hono();
	chatIdentityApp.use('*', rateLimit('list', config.listRatePerMin));
	chatIdentityApp.route('/', chatIdentityRoute(db));
	app.route('/v1/chat-identity', chatIdentityApp);

	// Conversations list for a single account — inbox-like view.
	// Stateless on the server (no unread tracking); clients maintain
	// their own last-seen markers.
	const conversationsApp = new Hono();
	conversationsApp.use('*', rateLimit('list', config.listRatePerMin));
	conversationsApp.route('/', conversationsRoute(db));
	app.route('/v1/conversations', conversationsApp);

	// Chat read-state — per-(reader, peer) last-read timestamps
	// written by morphit_chat_read_v1. Clients use this to show
	// accurate unread counts across devices. See
	// apps/indexer/src/api/chatReadState.ts for the contract.
	const chatReadStateApp = new Hono();
	chatReadStateApp.use('*', rateLimit('list', config.listRatePerMin));
	chatReadStateApp.route('/', chatReadStateRoute(db));
	app.route('/v1/chat-read-state', chatReadStateApp);

	// Finding H layer 1 — block list surface. Returns the
	// accounts currently blocked by :account. Used by the
	// Settings page's "Blocked accounts" section and by the
	// chat UI's block button (which queries to know whether to
	// show "Block" or "Unblock"). See apps/indexer/src/api/
	// blocks.ts for the contract.
	const blocksApp = new Hono();
	blocksApp.use('*', rateLimit('list', config.listRatePerMin));
	blocksApp.route('/', blocksRoute(db));
	app.route('/v1/blocks', blocksApp);

	// Finding H layer 2 — chat admission probe. Given an
	// (me, peer) pair, returns whether the chat handler would
	// admit a message from me to peer right now, and why. The
	// frontend uses this on conversation mount to decide
	// whether to show the composer or the pay-stranger-fee
	// affordance. See apps/indexer/src/api/chatAdmission.ts.
	const chatAdmissionApp = new Hono();
	chatAdmissionApp.use('*', rateLimit('list', config.listRatePerMin));
	chatAdmissionApp.route('/', chatAdmissionRoute(db));
	app.route('/v1/chat-admission', chatAdmissionApp);

	// Finding H escalation — stranger-fee quote probe. Given a
	// sender account, returns the current escalating
	// USD-equivalent price for their next first-contact
	// message. Frontend uses this to display the fee BEFORE
	// the user signs the pay-to-message op, so the
	// "you've messaged N strangers in 5 min, fee is now Nx"
	// warning can fire at compose time. See
	// apps/indexer/src/api/strangerFeeQuote.ts.
	const strangerFeeQuoteApp = new Hono();
	strangerFeeQuoteApp.use('*', rateLimit('list', config.listRatePerMin));
	strangerFeeQuoteApp.route('/', strangerFeeQuoteRoute(db));
	app.route('/v1/stranger-fee-quote', strangerFeeQuoteApp);

	// Finding I mitigation — attestor eligibility probe. Given
	// an account, returns whether that account can currently
	// attest to a BTC/XMR order's fee under the active
	// attestation-phase rules. Frontend uses this to pre-check
	// before showing an attest button. See
	// apps/indexer/src/api/attestorEligibility.ts.
	const attestorEligibilityApp = new Hono();
	attestorEligibilityApp.use('*', rateLimit('list', config.listRatePerMin));
	attestorEligibilityApp.route('/', attestorEligibilityRoute(db, config));
	app.route('/v1/attestor-eligibility', attestorEligibilityApp);

	// Phase 5b scaffolding. Empty until ADR-0013 lands the
	// registration op; exists now so the /operators directory page
	// can be built and tested against real HTTP rather than mocks.
	const operatorsApp = new Hono();
	operatorsApp.use('*', rateLimit('list', config.listRatePerMin));
	operatorsApp.route('/', operatorsRoute(db));
	app.route('/v1/operators', operatorsApp);

	// Aggregated trade-activity stats (Batch K).  Used by the
	// /activity page and by RSS-feed clients reporting volume
	// summaries.  Public, list-tier rate-limited.
	const activityApp = new Hono();
	activityApp.use('*', rateLimit('list', config.listRatePerMin));
	activityApp.route('/', activityRoute(db));
	app.route('/v1/activity', activityApp);

	// Operator-instance payment-method additions (ADR-0021).
	// Frontend reads on app-boot to populate the picker's
	// "Instance additions" section.  Public, list-tier rate-limited.
	const instancePmApp = new Hono();
	instancePmApp.use('*', rateLimit('list', config.listRatePerMin));
	instancePmApp.route('/', instancePaymentMethodsRoute(db, config));
	app.route('/v1/instance/payment-methods', instancePmApp);

	// Operator-block lookup endpoints (ADR-0018).  Frontend uses
	// these to detect whether the signed-in user is operator-blocked
	// on this instance, and to filter operator-blocked accounts out
	// of the orderbook view.  Public, list-tier rate-limited.
	const operatorBlocksApp = new Hono();
	operatorBlocksApp.use('*', rateLimit('list', config.listRatePerMin));
	operatorBlocksApp.route('/', operatorBlocksRoute(db));
	app.route('/v1/operator-blocks', operatorBlocksApp);

	// RSS feeds of recent orderbook entries. Linked from the
	// site footer (global feed) and from trader/asset pages
	// (per-account, per-asset). Readers expect /rss/orderbook.xml
	// and /rss/orderbook/by-{asset,account}/*, not /v1/rss/...,
	// so the path is deliberately outside the versioned API.
	// If we ever need a v2 feed shape we'll add /rss/orderbook-v2.xml
	// rather than move these.
	//
	// Rate-limited like the list endpoints. The handler itself
	// sets Cache-Control max-age=60, so well-behaved feed readers
	// only actually hit the DB once a minute per distinct reader.
	const rssOrderbookApp = new Hono();
	rssOrderbookApp.use('*', rateLimit('list', config.listRatePerMin));
	rssOrderbookApp.route('/', rssOrderbookRoute(db, config));
	app.route('/rss', rssOrderbookApp);

	// Catch-all 404. The shape matches ErrorResponse from
	// @morphit/indexer-client so the frontend's error-handling path
	// works without special-casing 404s.
	app.notFound((c) =>
		c.json(
			{
				status: 'error' as const,
				code: 'not_found' as const,
				message: `No route for ${c.req.method} ${c.req.path}`
			},
			404
		)
	);

	// Unhandled errors — log and return 500 with the same ErrorResponse
	// shape. Individual handlers should catch their own errors, but
	// this guards against anything that slips through.
	app.onError((err, c) => {
		httpLog.error('unhandled', {}, err);
		return c.json(
			{
				status: 'error' as const,
				code: 'internal' as const,
				message: 'Internal error'
			},
			500
		);
	});

	// ─── 7. HTTP server ────────────────────────────────────────
	const server: ServerType = serve({
		fetch: app.fetch,
		hostname: config.listenHost,
		port: config.listenPort
	});
	bootLog.info('http_listening', {
		host: config.listenHost,
		port: config.listenPort
	});

	// ─── Graceful shutdown ─────────────────────────────────────
	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		shutdownLog.info('draining', { signal });

		// Stop poller first so it finishes its current block tx
		// without being killed mid-INSERT.
		poller.stop();
		// Give the poller up to 10 seconds to wrap up. If it's stuck
		// on a slow RPC call, we've told it to abort via AbortSignal
		// but the underlying fetch might not honor that in time.
		const pollerTimeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
		await Promise.race([pollerPromise, pollerTimeout]);

		// Stop all price sources.  cp131 LOW-005 — pre-cp131 had
		// a separate priceSource.stop() for the standalone BLURT
		// fetcher AND this loop for the multi-asset map.  Now
		// that `priceSource` aliases multiAssetSources.get('BLURT'),
		// a single loop covers everything.  No in-flight work to
		// drain — refreshOnce() is best-effort; stop() just clears
		// the interval timer.
		for (const source of multiAssetSources.values()) {
			source.stop();
		}

		// cp129 — Stop the peer-price monitor's recurring tick.
		// Same shape as priceSource.stop(): no in-flight work to
		// drain, just clear the setInterval handle.
		// cp130 extension: stop all per-asset monitors.
		for (const stop of stopPeerPriceMonitors) {
			stop();
		}

		// Close HTTP next. @hono/node-server exposes close via the
		// ServerType returned from serve().
		await new Promise<void>((resolve, reject) => {
			server.close((err?: Error) => (err ? reject(err) : resolve()));
		});

		// Then the DB pool.
		await db.close();

		shutdownLog.info('done');
		process.exit(0);
	};

	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));

	// Unhandled-rejection safety net. Log and keep running — the
	// poller has its own recovery loop, and HTTP errors don't crash
	// Hono, so a rejection here usually means a developer mistake
	// we want visible in logs.
	process.on('unhandledRejection', (reason) => {
		procLog.error('unhandled_rejection', {}, reason);
	});
}

main().catch((err) => {
	bootLog.error('failed', {}, err);
	process.exit(1);
});
