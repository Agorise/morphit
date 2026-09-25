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

import { loadOperatorConfig, DEFAULT_BLURT_RPC_ENDPOINTS } from '@morphit/operator-config';
import { loadConfig, resolveFeeRecipient } from '$config';
import { createDatabase } from '$db/pool';
import { checkSchemaDrift, formatDriftReport } from '$db/schemaDrift';
import { runMigrations } from '$db/migrations';
import {
	backfillPostingKeys,
	ensurePostingPubkeyColumn,
	keepReconcilingPostingKeys
} from '$indexer/postingKeyBackfill';
import { keepReloadingRpcDirectory } from '$indexer/rpcDirectoryReload';
import { seedFederationDirectory } from '$indexer/federationSeed';
import { installHiddenServiceDispatcher, indexerRouterPolicy } from '$indexer/hiddenServiceDispatcher';
import { hiddenServiceProxyConfigFromEnv } from '$indexer/hiddenServiceFetch';
import { BlurtClient } from '$blurt/client';
import { Poller } from '$indexer/poller';
import { HeadTailer } from '$indexer/headTailer';
import { createMultiAssetPriceSources, createDisagreementMonitor } from '$indexer/price/factory';
import { createFxRateSource } from '$indexer/fx/factory';
import type { FxRateSource } from '$indexer/fx/source';
import { startPeerPriceMonitor, type PeerSampleCycleResult } from '$indexer/price/peerPriceMonitor';
import {
	startDisagreementMonitor,
	type DisagreementMonitor
} from '$indexer/price/disagreementMonitor';
import type { BlurtPriceSource } from '$indexer/price/source';

import { bodyCap } from '$api/middleware/bodyCap';
import { security } from '$api/middleware/security';
import { cors } from '$api/middleware/cors';
import { rateLimit } from '$api/middleware/ratelimit';

import { healthRoute, INDEXER_VERSION } from '$api/health';
import { morphitUserAgent } from '$blurt/userAgent';
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
import { orderCounterpartiesRoute } from '$api/orderCounterparties';
import { profilesRoute } from '$api/profiles';
import { accountBalanceRoute } from '$api/accountBalance';
import { accountHistoryRoute } from '$api/accountHistory';
import { accountKeysRoute } from '$api/accountKeys';
import { chainExplorerRoute } from '$api/chainExplorer';
import { broadcastRoute } from '$api/broadcast';
import { federationChatFastRoute, gatesFromDb } from '$api/federationChatFast';
import {
	deliverVerifiedPush,
	durableIsCurrentFor,
	chainPostingKeyRefresher
} from '$indexer/chatFastFederation';
import { ChatFastDispatcher } from '$indexer/chatFastDispatcher';
import { closePool, readCappedText } from '$indexer/hiddenServicePool';
import { feedbackByAccountRoute } from '$api/feedback';
import { reputationReceiptRoute } from '$api/reputationReceipt';
import { releaseRoute } from '$api/release';
import { fxRoute } from '$api/fx';
import { chatRoute } from '$api/chat';
import { chatStreamRoute } from '$api/chatStream';
import { chatActivityStreamRoute } from '$api/chatActivityStream';
import { chatIdentityRoute } from '$api/chatIdentity';
import { chatReadStateRoute } from '$api/chatReadState';
import { chatFoldersRoute } from '$api/chatFolders';
import { settingsRoute } from '$api/settings';
import { chatAdmissionRoute } from '$api/chatAdmission';
import { blocksRoute } from '$api/blocks';
import { attestorEligibilityRoute } from '$api/attestorEligibility';
import { strangerFeeQuoteRoute } from '$api/strangerFeeQuote';
import { conversationsRoute } from '$api/conversations';
import { rssOrderbookRoute } from '$api/rssOrderbook';
import { operatorsRoute } from '$api/operators';
import { activityRoute } from '$api/activity';
import { statsRoute } from '$api/stats';
import {
	rpcEndpointsRoute,
	canonicalProbeUrls,
	directoryHiddenEndpoints,
	directoryNodeNames,
	unionHidden
} from '$api/rpcHealth';
import { instancePaymentMethodsRoute } from '$api/instancePaymentMethods';
import { operatorBlocksRoute } from '$api/operatorBlocks';
import { logger } from '$log';
import { suppressDblurtConsoleNoise } from '@morphit/rpc-pool';

const bootLog = logger('boot');
const httpLog = logger('http');
const shutdownLog = logger('shutdown');
const procLog = logger('process');
const pollerLog = logger('poller');

async function main(): Promise<void> {
	// Identify ourselves to RPC nodes. Every outbound path now names itself:
	// the dblurt Client via its native `userAgent` option (dblurt 0.17.0), the
	// direct batch fetch + the rpcHealth probe via explicit `user-agent`
	// headers, and the price/fx feeds via `priceUpstreamHeaders()`. The old
	// global-fetch wrapper (installMorphitUserAgent) that this replaced is
	// retired — `rpc-user-agent-smoke` now guards that no raw fetch is anonymous.

	// Drop @beblurt/dblurt's redundant internal failover chatter
	// ("Didn't failover for error code: [...]") — our EndpointPool does
	// the real failover and /v1/health -> rpc_endpoints is the real
	// signal. Installed first so even boot-time RPC noise is filtered.
	suppressDblurtConsoleNoise();

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

	// cp407 — a federated operator earns 90% of BLURT listing fees and sets the
	// account they land in (MORPHIT_INDEXER_FEE_RECIPIENT). If they left it empty
	// or entered a malformed account name, the config resolver silently fell back
	// to the treasury (@morphit-fees). Warn at boot so they don't unknowingly
	// route their earnings there.
	{
		const raw = (process.env.MORPHIT_INDEXER_FEE_RECIPIENT ?? '').trim();
		if (raw.length > 0 && resolveFeeRecipient(raw).fellBack) {
			bootLog.warn('fee_recipient_invalid', {
				configured: raw,
				using: config.feeRecipient,
				hint: 'MORPHIT_INDEXER_FEE_RECIPIENT is not a valid Blurt account name (3–16 chars, lowercase, leading letter, [a-z0-9.-] interior, ending alphanumeric). BLURT listing fees are going to the fallback treasury account until this is corrected.'
			});
		}
	}

	// cp194 — `--check-config`: validate operator-config + the full
	// indexer config schema, then exit WITHOUT touching the database,
	// running migrations, or opening a port. Used by `morphit-ops
	// doctor` to tell an operator whether the indexer will start,
	// before they run it. If we reached here, loadOperatorConfig +
	// loadConfig both succeeded, so the config is bootable.
	if (process.argv.includes('--check-config')) {
		// eslint-disable-next-line no-console
		console.log('[check-config] indexer config OK');
		process.exit(0);
	}

	// cp217 — `--check-schema`: connect READ-ONLY, compare the live DB's
	// structure against what this version's schema.sql expects, and report
	// anything missing. Catches the pre-launch hazard where an existing DB
	// (v1 already applied) doesn't pick up in-place schema.sql edits shipped
	// in a later version. Used by `morphit-ops doctor`. Only a SELECT against
	// information_schema — changes nothing.
	if (process.argv.includes('--check-schema')) {
		const db = createDatabase(config);
		let code = 0;
		try {
			const res = await checkSchemaDrift(db);
			if (!res.dbReachable) {
				// eslint-disable-next-line no-console
				console.log('[check-schema] could not reach the database (skipped)');
			} else if (res.ok) {
				// eslint-disable-next-line no-console
				console.log('[check-schema] database schema matches this version');
			} else {
				// eslint-disable-next-line no-console
				console.log(
					`[check-schema] DRIFT — your database is missing structures this version expects: ${formatDriftReport(
						res.diff
					)}`
				);
				// eslint-disable-next-line no-console
				console.log(
					'[check-schema] This usually means you upgraded across a schema change. The indexer DB is rebuilt from the chain, so the fix is to reset + re-sync it (see OPERATIONS.md §46).'
				);
				code = 1;
			}
		} finally {
			await db.close();
		}
		process.exit(code);
	}

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

	// ─── 3-bis. Additive columns not carried by the collapsed v1 baseline ──
	// The orderbook query selects accounts.posting_pubkey. On an already-migrated
	// beta DB, schema.sql does NOT re-run, so this additive column is delivered by
	// an idempotent ADD COLUMN — and it MUST exist before the server binds, or the
	// orderbook 500s on every request. It is therefore AWAITED here on the boot
	// path (right after migrations, which already proved DB write access), NOT left
	// to the fire-and-forget backfill below. This closes the beta.44 "Can't reach
	// the indexer" regression, where the ensure raced the first request / could
	// fail silently. Cheap and idempotent (metadata-only ADD COLUMN IF NOT EXISTS).
	await ensurePostingPubkeyColumn(db);

	// ─── 3a. Federation seed (Phase D.5) ────────────────────────
	// Hardcoded reference instances inserted into known_instances
	// with status='never'.  Idempotent.  Probe scheduler picks them
	// up on its first tick and verifies them like any other peer.
	// Short-circuits chain-replay latency for fresh deploys.
	await seedFederationDirectory(db);

	// ─── 4. Blurt client ───────────────────────────────────────
	// Before constructing the client: install the global routing dispatcher so
	// dblurt's fetch reaches .onion (via Tor SOCKS) and .b32.i2p (via i2pd).
	// ALWAYS installed (v1.18.0 deep-deep, L3) — it used to be gated on hidden
	// endpoints being configured, but the on-chain RPC directory merges hidden
	// nodes into EVERY node's pool, and without the router their names went to
	// the system resolver. Clearnet goes to a plain Agent, exactly as before.
	// Hidden endpoints that can't be reached (proxy down) just fail and the pool
	// uses clearnet; the node never blocks on them.
	//
	// Hidden-only ⇔ the clearnet RPC pool has been deliberately emptied (cp755):
	// the node reaches the chain over .onion/.i2p or a co-located blurtd only.
	// In that mode the dispatcher runs FAIL-CLOSED — a public clearnet origin is
	// refused, never leaked — so the node can't deanonymise itself even via an
	// errant fetch. (Local/loopback/.loki stay allowed; see isClearnetOrigin.) A
	// node that still keeps clearnet RPC endpoints keeps the classic 'allow'
	// behaviour. See indexerRouterPolicy.
	installHiddenServiceDispatcher(
		hiddenServiceProxyConfigFromEnv(process.env),
		indexerRouterPolicy(config)
	);
	if (config.blurtRpcEndpoints.length === 0 && config.hiddenRpcEndpoints.length === 0) {
		// L3: say so, rather than leave an operator to infer it from a quiet
		// probe and a federated price.
		bootLog.info('local_chain_only', {
			note: 'no clearnet or hidden RPC endpoints set: the chain is read from this box only, and the node is treated as hidden-only (it contacts no clearnet host)'
		});
	}
	const blurt = new BlurtClient(config);

	// ─── 4-bis. Reload the persisted on-chain RPC directory (v1.12.0) ──
	// The morphit_rpc_v1 handler merges directory nodes into the live pool, but a
	// restart re-indexes FORWARD past an older op — so re-hydrate the last trusted
	// directory from the DB and merge it back into the pool now. Best-effort: a
	// missing table (pre-migration) or empty row just leaves the baked
	// DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS in place.
	//
	// v1.18.0 deep-deep (rv2-4): the row's endpoints used to be merged as-is —
	// and a snapshot restore brings the row over from someone else's database,
	// so its URLs became permanent members of this pool unchecked. Now the row is
	// only a pointer (its block): the op there must be agreed by independent RPC
	// operators and signed by the pinned official key, and the endpoints merged
	// are the signed op's. In the background, retried while the chain is out of
	// reach, so boot never waits on it.
	keepReloadingRpcDirectory(db, blurt, config, (o) => {
		if (o.kind === 'merged' && o.added > 0) bootLog.info('rpc_directory_reloaded', { added: o.added });
		else if (o.kind === 'rejected') bootLog.warn('rpc_directory_row_unverified_dropped', {});
		else if (o.kind === 'unreachable') bootLog.info('rpc_directory_reload_deferred', {});
		else if (o.kind === 'error') bootLog.warn('rpc_directory_reload_skipped', { err: o.error });
	});

	// ─── 4-ter. Auto-detect a CO-LOCATED Blurt RPC node (v1.12.1) ──
	// If a blurtd (e.g. the hidden-rpc package) is running on the standard
	// loopback RPC port on THIS box, read the chain from it directly — instant,
	// private, and the read never leaves the machine — with ZERO config, on any
	// install (manual or Ansible). Opt out with
	// MORPHIT_INDEXER_LOCAL_RPC_AUTODETECT=false.
	const autoLocalEndpoints: string[] = [];
	if (config.localRpcAutodetect) {
		const candidate = 'http://127.0.0.1:8091';
		if (!config.localRpcEndpoints.includes(candidate)) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 2500);
			let looksLikeBlurtd = false;
			try {
				const res = await fetch(candidate, {
					method: 'POST',
					signal: ac.signal,
					headers: {
						'content-type': 'application/json',
						'user-agent': morphitUserAgent(INDEXER_VERSION)
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method: 'condenser_api.get_dynamic_global_properties',
						params: []
					})
				});
				if (res.ok) {
					const j = (await res.json()) as { result?: { head_block_number?: number } };
					looksLikeBlurtd = typeof j?.result?.head_block_number === 'number';
				}
			} catch {
				// nothing (valid) on 8091 — no co-located node, leave it be.
			} finally {
				clearTimeout(t);
			}
			if (looksLikeBlurtd) {
				autoLocalEndpoints.push(candidate);
				blurt.mergeRpcEndpoints([candidate]);
				bootLog.info('local_blurtd_autodetected', { url: candidate });
			}
		}
	}

	// ─── 4a. Posting-key backfill (cp404, option A) ────────────
	// The column itself is already guaranteed (awaited ensurePostingPubkeyColumn
	// in step 3-bis). This step only POPULATES it: fills posting_pubkey for
	// accounts created before the column existed, from the chain, in the
	// background so the poller isn't blocked. New accounts already get their key
	// at ingest from the account_create op. Fire-and-forget: a failure here only
	// leaves some rows' key NULL or unconfirmed, and never blocks indexing or the
	// orderbook.
	//
	// v1.18.0 (F37) — it also confirms, once, every key recorded before this
	// release against the chain. The column is NOT display-only any more: the
	// fast path verifies pushed chat against it, so a key the owner rotated away
	// from before upgrading would otherwise go on verifying. Until a row is
	// confirmed, the fast path re-reads the chain for it rather than trusting it.
	let stopPostingKeyRetry: (() => void) | undefined;
	void backfillPostingKeys(db, blurt).then(
		(r) => {
			const rc = r.reconciled;
			if (r.updated > 0 || r.remaining > 0 || (rc && (rc.checked > 0 || rc.remaining > 0))) {
				bootLog.info('posting_key_backfill_done', { ...r, reconciled: rc ? { ...rc } : undefined });
			}
			// v1.18.0 review (D5): rows the boot pass could not confirm — RPC not
			// ready yet, no two endpoints agreeing — are retried with backoff
			// rather than left until the next restart.
			if (rc !== undefined && rc.remaining > 0) {
				stopPostingKeyRetry = keepReconcilingPostingKeys(db, blurt, {
					onPass: (p) =>
						bootLog.info('posting_key_reconcile_retry', {
							checked: p.checked,
							corrected: p.corrected,
							remaining: p.remaining
						})
				});
			}
		},
		(e) => bootLog.warn('posting_key_backfill_failed', { error: String(e) })
	);

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

	// ─── USD→fiat FX source (FX-aware first-order floor) ────────
	// Powers the "$1 USD-equivalent" first-buy minimum for users
	// posting in a non-USD fiat, and the Min-value field default in
	// the user's currency.  ON by default (config.fxFeedEnabled);
	// null when the operator disables it (floor then degrades to
	// USD-only — see the poller's fiatToUsd converter).  A single
	// generic table fetch (base=USD) — no per-user query, privacy
	// preserved.  Started here; stopped in the shutdown block below.
	const fxSource: FxRateSource | null = createFxRateSource(config);
	if (fxSource) fxSource.start();

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
	// cp233 — latest peer-monitor cycle result per asset, captured so
	// /v1/health can surface F's peer comparison alongside B and C
	// (the cp129 schema comment always promised F would surface here).
	const peerMonitorResults = new Map<string, PeerSampleCycleResult>();
	// ALWAYS on a hidden-only node, whatever the switch says. There the PRIMARY
	// price is the federated median of the observations this monitor collects
	// (price/factory.ts, federatedPriceFetcher.ts); with the monitor off that
	// median has one sample — our own — and never reaches its minimum, so every
	// asset prices from our own trades or the static floor while /v1/instance
	// reports the price leg as federated. The switch exists for the ALERT side,
	// on a clearnet node with other upstreams; a hidden-only node has no other.
	const peerMonitorRuns =
		config.priceFeedPeerMonitorEnabled || config.blurtRpcEndpoints.length === 0;
	if (peerMonitorRuns && multiAssetSources.size > 0) {
		for (const [asset, source] of multiAssetSources) {
			const stop = startPeerPriceMonitor(
				{
					db,
					priceSource: source,
					asset,
					denominationFiat: config.priceFeedDenominationFiat,
					// Hidden-only node → sample peers over every hidden address
					// they published (I2P, Tor, Lokinet), never their clearnet origin.
					hiddenOnly: config.blurtRpcEndpoints.length === 0
				},
				config.priceFeedPeerSampleIntervalMinutes,
				(result) => peerMonitorResults.set(asset, result)
			);
			stopPeerPriceMonitors.push(stop);
		}
	}

	// cp233 — Defense C: single-instance native-vs-external price
	// disagreement monitor.  Where F needs ≥3 federation peers to say
	// anything, C protects a LONE instance with no peers — it
	// cross-checks the published external price (coingecko)
	// against the self-sovereign morphit_native price every refresh
	// cycle and alerts on sustained (>4h) >25% divergence.  On by
	// default whenever native pricing is enabled (createDisagreement-
	// Monitor returns null for assets with no native price, skipping
	// them).  Each monitor instance is also handed to /v1/health so
	// operators see the live deviation.  See ADR-0041 (defense C —
	// cp127's other deferred item).
	const disagreementMonitors = new Map<string, DisagreementMonitor>();
	const stopDisagreementMonitors: Array<() => void> = [];
	if (multiAssetSources.size > 0) {
		for (const [asset, source] of multiAssetSources) {
			const built = createDisagreementMonitor(config, asset, db);
			if (!built) continue;
			disagreementMonitors.set(asset, built.monitor);
			const stop = startDisagreementMonitor(
				{
					monitor: built.monitor,
					nativeFetch: built.nativeFetch,
					priceSource: source
				},
				config.priceRefreshIntervalMs
			);
			stopDisagreementMonitors.push(stop);
		}
	}

	// ─── 6. Poller ─────────────────────────────────────────────
	const poller = new Poller(config, db, blurt, priceSource, fxSource);
	// Fire-and-forget; the promise only resolves on shutdown.
	const pollerPromise = poller.run().catch((err) => {
		pollerLog.error('fatal', {}, err);
		// Fatal poller failure — shut down the whole process so the
		// supervisor (systemd) restarts us with a clean state.
		process.exit(1);
	});

	// ─── 6b. Chat head-block fast-path tailer (cp403 [1], ADR-0048) ──
	// Tails the chain HEAD (not the irreversible point) to emit chat SSE
	// within a few seconds instead of ~45-60s. NEVER writes the DB — the
	// poller above stays the sole source of truth. Always on — the
	// MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED flag was removed in v1.7.0
	// (ADR-0051); the tailer runs unconditionally.
	// Fire-and-forget; a crash here must NOT take down the process (unlike
	// the poller), so its errors are contained inside run() — the catch is
	// a belt-and-suspenders that just logs, never exits.
	// The federation chat fast path's sender side. Constructed here so it shares
	// the head tailer's lifetime: between them they are the two producers of
	// fast chat events — one from blocks, one from peers.
	const chatFastDispatcher = new ChatFastDispatcher({
		db,
		// The SITE origin, not the indexer's. `known_instances.origin` is written
		// from the on-chain registration, which registers the site; an indexer
		// served from `indexer.<domain>` would otherwise never recognise its own
		// row and would push every message to itself over Tor. Same derivation
		// the durable poller uses.
		selfOrigin: config.instanceOrigin ?? config.publicOrigin.replace(/\/\/indexer\./, '//'),
		proxies: hiddenServiceProxyConfigFromEnv(process.env),
		// Clearnet peers go through the ordinary fetch; hidden peers go through
		// the pooled, kept-warm dispatcher inside the federation module.
		// The same two defences the hidden-service path already has, because the
		// clearnet path faces the same peer:
		//
		//   redirect: 'manual' — a peer that answers 307 with a Location of
		//     http://127.0.0.1:6379/ would otherwise have us re-POST the whole
		//     signed body to a service on our own loopback. The peer list is
		//     on-chain and validated, but "registered" is not "trustworthy", and
		//     following a redirect is a decision, not a default worth inheriting.
		//
		//   a bounded read — the abort above bounds this call in TIME, not in
		//     bytes. A peer that answers 202 and then streams indefinitely costs
		//     us whatever fits in the timeout, per push, per peer, resident in
		//     memory. We never read anything but the status here anyway.
		postClearnet: async (url, body, timeoutMs) => {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), timeoutMs);
			try {
				const res = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify(body),
					redirect: 'manual',
					signal: ctrl.signal
				});
				return { status: res.status, body: await readCappedText(res) };
			} finally {
				clearTimeout(timer);
			}
		}
	});
	chatFastDispatcher.start();

	// The RECEIVING half of the federation fast path. Constructed here rather
	// than at its mount point so /v1/health, which is mounted earlier, can report
	// its intake queue — an operator cannot otherwise tell a working fast path
	// from one that has started shedding.
	// Re-read one account's posting key from the chain — for an unconfirmed row,
	// while the poller lags, and after a signature that did not verify, under
	// the cooldown and ceilings in chatFastFederation. Through a QUORUM of
	// endpoints (v1.18.0 deep-deep, rv2-3): it used to be `blurt.getAccounts`,
	// one endpoint, so any single node in the pool could vouch for its own key
	// as anyone's. No agreement means no fast verdict, and chain delivery.
	const chatFastIntake = federationChatFastRoute(db, chainPostingKeyRefresher(blurt), {
		// v1.18.0 review (D6): while the durable poller is far behind the chain
		// head — after downtime, while it catches up — a key rotated inside the
		// gap is not in `accounts.posting_pubkey` yet, so no stored key is
		// trusted on its own and the chain is asked instead. An UNKNOWN head is
		// no longer "current" (v1.18.0 deep-deep, rv2-7): with the RPC down at
		// boot it stayed unknown for the whole outage and confirmed rows were
		// trusted blindly. See durableIsCurrentFor.
		durableIsCurrent: () => durableIsCurrentFor(poller.getStatus())
	});

	// The gates a LOCAL delivery runs, built once. Identical to the ones the
	// federation endpoint applies to a peer's push — a message from our own user
	// gets no easier ride than one from a peer.
	const localChatGates = gatesFromDb(db);

	const headTailer = new HeadTailer(config, db, blurt);
	const headTailerPromise = headTailer.run().catch((err) => {
		pollerLog.error('chat_fastpath_fatal', {}, err);
	});

	// ─── 7. HTTP app ───────────────────────────────────────────
	const app = new Hono();

	// Middleware chain, applied to every request in order.
	app.use('*', security);
	app.use('*', cors(config.allowedOrigins));
	app.use(
		'*',
		bodyCap(
			config.maxRequestBodyBytes,
			config.maxBroadcastBodyBytes,
			config.maxFederationBodyBytes
		)
	);

	// Versioned API routes. Each route gets its own rate-limit tier
	// per ADR-0008: list endpoints (orderbook, per-account order
	// list, feedback list, chat history) at the lower `list` limit;
	// single-resource endpoints (profile, release) at the higher
	// `resource` limit.
	app.route('/v1/health', healthRoute(config, poller, priceSource, disagreementMonitors, peerMonitorResults, fxSource, multiAssetSources, headTailer, chatFastDispatcher, chatFastIntake));
	app.route('/v1/instance', instanceRoute(config, () => poller.currentTreasuryAddresses()));
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
	listingFeeApp.route('/', listingFeeRoute(config, priceSource, multiAssetSources.get('BTC') ?? null, multiAssetSources.get('XMR') ?? null));
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
	// Operator-instance block filtering: the account these read routes
	// filter `operator_blocks` by MUST match the account operatorBlock.ts
	// writes blocks under — `ctx.signer === operatorAccountName` (the
	// per-instance operator, NOT officialAccountName, the federation-wide
	// release-signer). They default to the same value, but when an operator
	// sets MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME separately, filtering by
	// officialAccountName would silently ignore every block (the rows are
	// keyed by operatorAccountName). cp257 fix.
	app.route('/v1/orderbook/stream', orderbookStreamRoute(db, poller, config.operatorAccountName));

	const orderbookApp = new Hono();
	orderbookApp.use('*', rateLimit('list', config.listRatePerMin));
	orderbookApp.route('/', orderbookRoute(db, poller, config.operatorAccountName));
	orderbookApp.route('/featured', featuredRoute(db, config.operatorAccountName));
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
	ordersApp.route('/', ordersByAccountRoute(db, config.operatorAccountName));
	// Task #14 — private viewcounts.  Same /v1/orders namespace
	// because the routes are :account/:permlink/view{,s}.  Inherits
	// the existing 'list' rate-limit tier; nginx limit_req_zone is
	// the right place for stricter write-side spam protection.
	ordersApp.route('/', orderViewsRoute(db));
	// cp421 — reviewable counterparties for an order, so /my/orders can
	// gate the "Mark complete / review" button + prefill the trade
	// partner. Same :account/:permlink/... shape, same 'list' tier.
	ordersApp.route('/', orderCounterpartiesRoute(db));
	app.route('/v1/orders', ordersApp);

	const profilesApp = new Hono();
	profilesApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	profilesApp.route('/', profilesRoute(db));
	app.route('/v1/profiles', profilesApp);

	// cp295 — privacy balance/account proxy. Browser reads an account's
	// balance via the indexer (same-origin) instead of hitting third-party
	// Blurt RPC nodes directly, so those nodes never see the user's IP or
	// which account they're viewing. Server-side fetch uses the full
	// canonical RPC pool with automatic best-node selection (no browser
	// CORS constraint). Resource-rate-limited: it's one live upstream read
	// per cache-miss, short-cached and public (balances are public chain
	// data).
	const accountApp = new Hono();
	accountApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	accountApp.route('/', accountBalanceRoute(blurt));
	accountApp.route('/', accountHistoryRoute(blurt));
	accountApp.route('/', accountKeysRoute(blurt));
	app.route('/v1/account', accountApp);

	// cp347 — /v1/chain (block explorer + the cp344 ref-block properties proxy)
	// and /v1/broadcast (the cp344 write proxy) each forward ONE upstream Blurt
	// RPC call per request, so they get the same per-IP 'resource' rate-limit
	// tier as every other upstream-touching proxy (e.g. /v1/account). Without it
	// an unauthenticated flood of well-formed-but-bogus requests could amplify
	// load onto the operator's RPC pool. 600/min (the resource default) is far
	// above any legitimate broadcast or explorer rate, so real writes never trip
	// it. A throttled op surfaces "try again" in the browser; there is no
	// direct-RPC fallback anywhere in the client, so nothing leaks to a
	// third-party node when this fires.
	const chainApp = new Hono();
	chainApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	chainApp.route('/', chainExplorerRoute(blurt, db));
	app.route('/v1/chain', chainApp);

	const broadcastApp = new Hono();
	broadcastApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	broadcastApp.route(
		'/',
		broadcastRoute(blurt, chatFastDispatcher, (located, trxId) => {
			// Both parties on THIS instance: deliver straight to our own listeners
			// rather than waiting for the head tailer to read the message back off
			// the chain. Same gates as every other fast delivery — the block list
			// and the safe-subset notification gate — through the same function.
			void deliverVerifiedPush(located, trxId, localChatGates).catch(() => undefined);
		})
	);
	app.route('/v1/broadcast', broadcastApp);

	// The federation chat fast path's receiving side. Peer instances POST a
	// signed chat op here so the recipient sees it without waiting for a block.
	// Its own rate limit lives in the route; see the file header for why an
	// unauthenticated endpoint is the right shape here.
	app.route('/v1/federation/chat-fast', chatFastIntake.app);

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

	// cp372 — public USD→fiat table for the client's "$1-equivalent"
	// first-order floor + fiat echoes.  Resource-tier (one cached
	// read).  Serves the WHOLE table so the client picks its currency
	// locally — the indexer never learns which fiat a user chose.
	const fxApp = new Hono();
	fxApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	fxApp.route('/', fxRoute(fxSource));
	app.route('/v1/fx', fxApp);

	// Phase E.5 — chat SSE.  Mounted at /v1/chat/:a/:b/stream
	// BEFORE the rate-limited /v1/chat so the more-specific
	// path wins.  Long-lived SSE connections shouldn't share a
	// per-minute budget with REST GETs.  Per-IP open-connection
	// caps belong at the reverse-proxy layer.
	app.route('/v1/chat', chatStreamRoute(db, poller));

	// Global (all-conversations) chat-activity SSE for one account. Its own
	// /v1/chat-activity prefix so it can't collide with /v1/chat/:a/:b (an
	// account could be named "stream"/"events"). Not rate-limited — long-lived
	// SSE; per-IP connection caps belong at the reverse proxy. Pushes only a
	// peer-account ping (on-chain-public), never ciphertext — see the file
	// header for the full privacy rationale.
	app.route('/v1/chat-activity', chatActivityStreamRoute());

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

	// Encrypted chat folder organization (t.txt v1.4.9 #5). Read-only GET; the
	// blob is opaque ciphertext. Rate-limited like the other list reads.
	const chatFoldersApp = new Hono();
	chatFoldersApp.use('*', rateLimit('list', config.listRatePerMin));
	chatFoldersApp.route('/', chatFoldersRoute(db));
	app.route('/v1/chat-folders', chatFoldersApp);

	const settingsApp = new Hono();
	settingsApp.use('*', rateLimit('list', config.listRatePerMin));
	settingsApp.route('/', settingsRoute(db));
	app.route('/v1/settings', settingsApp);

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

	// cp406 — aggregate-only network summary for third-party P2P aggregators
	// (RoboSats, Bisq, Hodl Hodl, AgoraDesk, …). Privacy-first: coarse counts +
	// config lists only, nothing per-account. Public, list-tier rate-limited.
	const statsApp = new Hono();
	statsApp.use('*', rateLimit('list', config.listRatePerMin));
	statsApp.route('/', statsRoute(db, config));
	app.route('/v1/stats', statsApp);

	// cp407 — per-node health for the canonical Blurt RPC pool, so the browser
	// Settings card can show why a server-only (CORS-blocked) node is/isn't
	// used. Canonical-only (operator-custom upstreams filtered out); reads the
	// poller's live in-memory pool snapshot. Public, resource-tier rate-limited.
	const rpcEndpointsApp = new Hono();
	rpcEndpointsApp.use('*', rateLimit('resource', config.resourceRatePerMin));
	rpcEndpointsApp.route(
		'/',
		// Allow-list = the clearnet canon PLUS this instance's configured
		// hidden-service endpoints (operator-set + published, so legitimately
		// canonical here). This is what lets the Settings card show the Tor/I2P
		// nodes with their transport badges; without it the privacy filter would
		// drop them.
		// cp767 — but the clearnet canon is included ONLY if this instance
		// actually uses clearnet. On a tor-only node (cp755: clearnet pool
		// emptied) it's excluded, so the active ?probe=1 never fetches a clearnet
		// RPC (which would leak the box's IP) and the widget matches the real
		// hidden-only pool instead of listing 10 phantom endpoints.
		rpcEndpointsRoute(
			() => poller.rpcEndpointSnapshot,
			// Live getter (re-derived per request, ~60s dir cache): the canonical
			// hidden list is the operator's configured seed UNION the on-chain
			// rpc_directory. So a newly-pinned hidden node shows on the stats card
			// network-wide without an indexer restart or a Morphit release; a
			// removed one drops off (rpc_directory is latest-wins). Clearnet stays
			// hardcoded + excluded on tor-only boxes exactly as before.
			async () =>
				canonicalProbeUrls({
					usesClearnet: config.blurtRpcEndpoints.length > 0,
					clearnetCanon: DEFAULT_BLURT_RPC_ENDPOINTS,
					hidden: unionHidden(
						config.hiddenRpcEndpoints,
						await directoryHiddenEndpoints(db)
					),
					local: config.localRpcEndpoints,
					autoLocal: autoLocalEndpoints
				}),
			// Optional per-node operator handles from the on-chain directory.
			async () => directoryNodeNames(db)
		)
	);
	app.route('/v1/rpc-endpoints', rpcEndpointsApp);

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
		// cp403 [1] — stop the chat fast-path tailer too. It holds no DB
		// transaction (read-only + in-process emits), so it stops cleanly
		// at its next loop boundary; no timeout race needed.
		headTailer.stop();
		stopPostingKeyRetry?.();
		// The federation fast path's sender side: stop the warm-up interval and
		// close the pooled hidden-service connections. Both are deliberately
		// long-lived — a warm circuit is the whole point — so neither goes away
		// on its own, and a shutdown that skipped this would leave a repeating
		// timer and a handful of open circuits behind it.
		chatFastDispatcher.stop();
		// Hand over what is already queued for peers before the connections go.
		// Bounded: a peer that cannot take a message in two seconds is not going
		// to, and shutdown must not wait on the slowest instance in the
		// federation. Anything still unsent arrives by the chain, as always.
		// The deadline is given to drain() rather than only raced against it:
		// the losing side of a bare race keeps polling for as long as the
		// process lives, and the process can live a while yet (see the HTTP
		// close below).
		await Promise.race([
			chatFastDispatcher.drain(2_000),
			new Promise<void>((r) => setTimeout(r, 2_000))
		]).catch(() => undefined);
		// Bounded as well (v1.18.0 review, S6): `close()` waits for in-flight
		// requests, and a warm-up already under way can run for a minute.
		await closePool(2_000).catch(() => undefined);
		// Give the poller up to 10 seconds to wrap up. If it's stuck
		// on a slow RPC call, we've told it to abort via AbortSignal
		// but the underlying fetch might not honor that in time.
		const pollerTimeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
		await Promise.race([pollerPromise, pollerTimeout]);
		// The tailer resolves promptly on abort (its only in-flight work
		// is a block fetch); await it briefly so the promise isn't left
		// dangling, but never block shutdown on it.
		await Promise.race([headTailerPromise, new Promise<void>((r) => setTimeout(r, 2_000))]);

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
		// Stop the FX source's background refresh (same shape: no
		// in-flight work to drain, just clear the interval timer).
		if (fxSource) fxSource.stop();

		// cp129 — Stop the peer-price monitor's recurring tick.
		// Same shape as priceSource.stop(): no in-flight work to
		// drain, just clear the setInterval handle.
		// cp130 extension: stop all per-asset monitors.
		for (const stop of stopPeerPriceMonitors) {
			stop();
		}

		// cp233 — stop the per-asset disagreement monitors (defense C).
		// Same shape: clear the setInterval handle, no in-flight drain.
		for (const stop of stopDisagreementMonitors) {
			stop();
		}

		// Close HTTP next. @hono/node-server exposes close via the
		// ServerType returned from serve().
		//
		// `server.close()` stops ACCEPTING connections and then fires its
		// callback only once every existing one has ended — and this process
		// deliberately holds connections open forever: an SSE chat stream is
		// kept alive by its own `:keepalive` interval and ends when the browser
		// goes away, not when we ask. So with a single chat tab open anywhere,
		// waiting on that callback never returns, the lines below are never
		// reached, and the process is eventually SIGKILLed by the supervisor
		// instead of shutting down. Close the idle sockets, then bound the wait:
		// a client that will not let go must not stop us from closing the
		// database cleanly.
		const httpClose = new Promise<void>((resolve, reject) => {
			server.close((err?: Error) => (err ? reject(err) : resolve()));
		});
		const closeIdle = (server as unknown as { closeIdleConnections?: () => void })
			.closeIdleConnections;
		if (typeof closeIdle === 'function') closeIdle.call(server);
		await Promise.race([
			httpClose,
			new Promise<void>((r) => setTimeout(r, 5_000))
		]).catch(() => undefined);

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
