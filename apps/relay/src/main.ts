/**
 * Morphit relay — main entrypoint.
 *
 * Loads config, wires the Hono app with all middleware, starts the
 * HTTP server, and handles graceful shutdown on SIGTERM / SIGINT.
 *
 * Design note: we deliberately don't import anything from blurt-client
 * here. The relay can run `/v1/health` without the Blurt client being
 * fully wired — useful for smoke-testing deployment before loading
 * the active key.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { loadConfig, type Config, type UnlockedConfig } from './config/index.ts';
import { loadOperatorConfig } from '@morphit/operator-config';
import { unlockActiveKey } from './config/unlock.ts';
import { BlurtClient } from './blurt/client.ts';
import { checkClockDrift } from './clock/driftCheck.ts';
import { createDatabase } from './db/pool.ts';
import { RelayQueueDrainer } from './queue/drainer.ts';
import { HealthService } from './api/health.ts';
import { registerAvailabilityRoutes } from './api/availability.ts';
import { CreateEndpoint } from './api/create.ts';
import { InviteEndpoint } from './api/invite.ts';
import { GlobalDailyCeiling } from './policy/globalDailyCeiling.ts';
import { InviteTokenService } from './policy/inviteToken.ts';
import { AltchaService } from './policy/altcha.ts';
import { KillSwitch } from './policy/killSwitch.ts';
import { SequentialDetector } from './policy/sequentialDetector.ts';
import { configureTrustedProxies } from './middleware/ip.ts';
import { Limiter } from './middleware/ratelimit.ts';
import { PushSubscriptionStore } from './policy/pushSubscriptions.ts';
import { PushSender } from './policy/pushSender.ts';
import { PushEndpoints } from './api/push.ts';
import { corsAllowlist } from './middleware/cors.ts';
import { enforceOriginAllowlist } from './middleware/origin_enforcement.ts';
import { requireJsonContentType } from './middleware/content_type.ts';
import { maxBodyBytes, securityHeaders } from './middleware/security.ts';
import { accessLog } from './middleware/access_log.ts';
import { logger } from '$log';

// Scoped loggers per phase so operators can filter journalctl by
// module rather than grepping free-form prefixes.
const bootLog = logger('relay-boot');
const cfgLog = logger('relay-config');
const httpLog = logger('relay-http');
const shutdownLog = logger('relay-shutdown');
const procLog = logger('relay-process');

async function main(): Promise<void> {
	const started = process.hrtime.bigint();
	bootLog.info('starting');

	// Operator config file (optional). Reads morphit.config.env
	// if present, projecting whitelisted keys into process.env.
	// OS-set env vars always win.
	loadOperatorConfig({
		searchPaths: [process.cwd(), `${import.meta.dirname}/../../..`]
	});

	let lockedCfg: Config;
	try {
		lockedCfg = loadConfig();
	} catch (err) {
		// Config failures are fatal — don't keep running with a broken
		// configuration.
		cfgLog.error('load_failed', {}, err);
		process.exit(1);
	}

	// cp194 — `--check-config`: validate operator-config + the full
	// relay config schema (including that the active-key file exists
	// and is shaped correctly), then exit. Runs BEFORE unlockActiveKey
	// so it NEVER prompts for a passphrase — safe for `morphit-ops
	// doctor` to call non-interactively. We report whether the key is
	// an encrypted envelope (so the operator knows the relay will ask
	// for a passphrase at real start) without decrypting it.
	if (process.argv.includes('--check-config')) {
		const encrypted = lockedCfg.relayActiveKeyEnvelope !== undefined;
		// eslint-disable-next-line no-console
		console.log(
			`[check-config] relay config OK (active key: ${
				encrypted ? 'encrypted — will prompt for passphrase at start' : 'plaintext'
			})`
		);
		process.exit(0);
	}

	// ADR-0010 §4: if the key file was an encrypted envelope, prompt
	// for the passphrase on stdin. Plaintext-WIF files (legacy /
	// dev convenience) skip this step. Either way we get a Config
	// with relayActiveKeyWif populated.
	let cfg: UnlockedConfig;
	try {
		cfg = await unlockActiveKey(lockedCfg);
	} catch (err) {
		cfgLog.error('active_key_unlock_failed', {}, err);
		process.exit(1);
	}
	if (cfg.relayActiveKeyWif === undefined) {
		// unlockActiveKey should have thrown rather than reach here,
		// but the type system can't prove that — guard explicitly.
		cfgLog.error('active_key_missing_after_unlock');
		process.exit(1);
	}

	cfgLog.info('loaded', {
		relay_account: cfg.relayAccount,
		listen_host: cfg.listenHost,
		listen_port: cfg.listenPort,
		public_origin: cfg.publicOrigin,
		rpc_endpoints: cfg.blurtRpcEndpoints.length,
		allowed_origins: cfg.allowedOrigins.length,
		verbose_health: cfg.verboseHealth
	});

	// Configure trusted-proxy IPs / CIDRs that may set
	// X-Forwarded-For for this relay.  MUST happen before any
	// request handler runs.  Default (loopback only) is correct
	// for the canonical single-host nginx topology; Docker /
	// BunkerWeb / multi-host nginx operators set
	// MORPHIT_RELAY_TRUSTED_PROXY_IPS.  See OPERATIONS.md §32
	// for guidance.
	if (cfg.trustedProxyIps && cfg.trustedProxyIps.trim().length > 0) {
		const specs = cfg.trustedProxyIps
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const result = configureTrustedProxies(specs);
		cfgLog.info('trusted_proxies_configured', {
			exact_count: result.exactCount,
			cidr_count: result.cidrCount,
			rejected: result.rejected
		});
		if (result.rejected.length > 0) {
			cfgLog.warn('trusted_proxies_some_rejected', {
				rejected: result.rejected,
				note: 'check MORPHIT_RELAY_TRUSTED_PROXY_IPS for typos'
			});
		}
	}

	const blurt = new BlurtClient(cfg.blurtRpcEndpoints, cfg.accountCreationFeeBlurt);

	// Task #7 — local-vs-chain clock drift sanity check.  We
	// don't need atomic-clock precision; the chain provides
	// authoritative time via head_block_time.  But the local
	// clock matters for Postgres timestamps, rate-limit UTC-day
	// bucketing, and ops monitoring.  Fail loud at boot rather
	// than have weird symptoms later.
	try {
		const dgp = await blurt.getDynamicGlobalProperties();
		const localMs = Date.now();
		const chainMs = new Date(dgp.time + 'Z').getTime();
		const drift = checkClockDrift(localMs, chainMs);
		if (drift.severity === 'fatal') {
			cfgLog.error('clock_drift_fatal', {
				drift_ms: drift.driftMs,
				local_ms: drift.localMs,
				chain_ms: drift.chainMs
			});
			console.error(drift.message);
			process.exit(1);
		}
		if (drift.severity === 'warn') {
			cfgLog.warn('clock_drift_warning', {
				drift_ms: drift.driftMs
			});
			console.warn(drift.message);
		} else {
			cfgLog.info('clock_drift_ok', { drift_ms: drift.driftMs });
		}
	} catch (err) {
		// Don't fail boot on RPC-reachability problems — the relay
		// has separate handling for that (rotates endpoints, retries).
		// Just note we couldn't check.
		cfgLog.warn(
			'clock_drift_check_skipped',
			{},
			err instanceof Error ? err : new Error(String(err))
		);
	}

	const db = createDatabase(cfg);
	const availLimiter = new Limiter(cfg.availabilityRatePerMin, 60_000);
	const createLimiter = new Limiter(cfg.createRatePerHour, 60 * 60_000);
	// ADR-0010 §4 long-window companion to createLimiter. 24h bucket.
	const dailyCreateLimiter = new Limiter(cfg.createRatePerDay, 24 * 60 * 60_000);
	// Signup-drain prevention services. Each is constructed
	// once and shared between the invite and create endpoints.
	// Per-IP invite-issuance limiter: tighter than the create
	// limiter because a single completed signup typically
	// consumes one invite (or one + a retry), so "many invites,
	// no creates" is an attacker signature.
	const inviteLimiter = new Limiter(10, 60 * 60_000); // 10/hour
	const globalCeiling = new GlobalDailyCeiling(
		cfg.signupDailyCeiling,
		undefined,
		cfg.signupCeilingPersistPath
	);
	const inviteTokens = new InviteTokenService({
		secret: cfg.inviteHmacSecret ? Buffer.from(cfg.inviteHmacSecret, 'utf8') : null
	});
	const altcha = new AltchaService({
		secret: cfg.altchaHmacSecret ? Buffer.from(cfg.altchaHmacSecret, 'utf8') : null,
		maxnumber: cfg.altchaMaxnumber
	});
	// Kill-switch: file-based runtime override of signupEnabled.
	// When dataDir is null, the switch is permanently inactive
	// (operator disabled the feature).  When set, the switch
	// polls the sentinel file every 1s and the signup endpoints
	// check the cached flag on every request.
	const killSwitch = cfg.dataDir !== null ? new KillSwitch(cfg.dataDir) : null;
	if (killSwitch !== null) {
		bootLog.info('kill_switch_armed', { path: killSwitch.getPath() });
	}
	const healthService = new HealthService(cfg, blurt, started);
	// Wire the signup context into health so /v1/health?verbose=1
	// exposes signup_stats (used by the indexer-side operator-
	// balance scanner to detect anomalous volume when LOW_BALANCE
	// fires).
	healthService.setSignupContext({
		ceiling: globalCeiling,
		signupEnabled: cfg.signupEnabled
	});
	const inviteEndpoint = new InviteEndpoint(
		cfg.signupEnabled,
		globalCeiling,
		inviteLimiter,
		cfg.altchaTriggerCount,
		altcha,
		inviteTokens,
		killSwitch
	);
	// Layer 8 detector — Null when the operator has explicitly
	// disabled it via env var.  See policy/sequentialDetector.ts.
	const sequentialDetector = cfg.sequentialDetectorEnabled
		? new SequentialDetector({
				windowMs: cfg.sequentialWindowMs,
				thresholdCount: cfg.sequentialThreshold,
				minPrefixLen: cfg.sequentialMinPrefix
			})
		: null;
	const createEndpoint = new CreateEndpoint(
		cfg,
		blurt,
		createLimiter,
		dailyCreateLimiter,
		cfg.createSpacingMinutes,
		healthService,
		cfg.signupEnabled,
		globalCeiling,
		inviteTokens,
		killSwitch,
		cfg.highValueNamePolicy,
		cfg.highValueShortNameThreshold,
		sequentialDetector
	);
	const queueDrainer = new RelayQueueDrainer(cfg, db, blurt);

	// ── Web Push (Part 122 cp13) ───────────────────────────────
	// Subscriptions store is always created (used by the endpoints
	// even when push is disabled — the GET key-helper returns a
	// clean 503 push_disabled, but the endpoint code path
	// references the store).  Sender is only constructed when
	// pushEnabled (it calls webpush.setVapidDetails which throws
	// on undefined keys).
	const pushSubscriptionStore = new PushSubscriptionStore(db);
	const pushSubscribeLimiter = new Limiter(20, 60 * 60_000); // 20/hour/IP
	// cp131 MED-009 — per-IP rate limit on unsubscribe.  Same
	// shape as subscribe; legitimate users never hit it
	// (humans unsubscribe one device at a time), but it
	// shuts down the DB-leak-DoS class.
	const pushUnsubscribeLimiter = new Limiter(20, 60 * 60_000); // 20/hour/IP
	const pushEndpoints = new PushEndpoints(
		cfg.pushEnabled,
		cfg.vapidPublicKey,
		pushSubscribeLimiter,
		pushUnsubscribeLimiter,
		pushSubscriptionStore,
		blurt,
		cfg.pushRequireSigned,
		// cp131 MED-009 — unsubscribe signature requirement
		// follows the same toggle as subscribe.  Operators
		// who require signed subscribe also require signed
		// unsubscribe; permissive-mode operators get the
		// signature verified opportunistically.
		cfg.pushRequireSigned
	);
	const pushSender = cfg.pushEnabled
		? new PushSender(cfg, db, pushSubscriptionStore)
		: null;
	if (pushSender) {
		bootLog.info('push_enabled', {
			poll_interval_ms: cfg.pushPollIntervalMs,
			batch_size: cfg.pushBatchSize,
			max_age_seconds: cfg.pushMaxAgeSeconds
		});
	} else {
		bootLog.info('push_disabled_no_vapid_keys', {});
	}

	// Start the background BLURT-balance poll. We don't wait for it
	// to succeed — the relay should come up even if the chain is
	// temporarily unreachable, with `/v1/health` reporting stale=true
	// until the first poll lands.
	healthService.startPolling().catch((err) => {
		bootLog.error('health_poll_init_failed', {}, err);
	});

	// Start the queue drainer — runs continuously in the background,
	// broadcasting queued welcome bonuses / dust refills / loyalty
	// BP grants as they arrive from the indexer.
	queueDrainer.start();

	// Start the push-sender worker — drains push_pending into
	// per-device Web Push deliveries.  Only when VAPID is set.
	if (pushSender) pushSender.start();

	const app = new Hono();

	// Middleware order matches the Go-version rationale:
	//   body-size cap → reject abuse before routing
	//   security headers → defence-in-depth
	//   CORS → only configured origins get headers
	//   content-type → force preflight on POSTs so CORS has a say
	// accessLog runs FIRST so every request — including
	// rejected-by-middleware requests — gets a single
	// grep-friendly log line.  This is the operator's primary
	// triage tool when a beta tester reports "the site doesn't
	// work."
	app.use('*', accessLog());
	app.use('*', maxBodyBytes(cfg.maxRequestBodyBytes));
	app.use('*', securityHeaders());
	app.use('*', corsAllowlist(cfg.allowedOrigins));
	app.use('*', requireJsonContentType());

	// Server-side origin enforcement on signup endpoints.
	// The CORS middleware above is browser-side only — a curl or
	// non-browser client ignores CORS and can POST here. This
	// middleware rejects with 403 server-side if the Origin
	// header is missing or not in the allowlist. Scoped to the
	// two signup endpoints because:
	//   - /v1/account/create spends relay BLURT directly
	//   - /v1/account/invite is the precursor; gating it stops
	//     foreign frontends from even starting the two-step flow
	//   - Availability + health are read-only / non-billing,
	//     and operators may want to call availability from curl
	//     when debugging, so we keep those endpoints permissive
	app.use('/v1/account/create', enforceOriginAllowlist(cfg.allowedOrigins));
	app.use('/v1/account/invite', enforceOriginAllowlist(cfg.allowedOrigins));

	// Mount routes.
	healthService.register(app);
	registerAvailabilityRoutes(app, blurt, availLimiter);
	inviteEndpoint.register(app);
	createEndpoint.register(app);
	pushEndpoints.register(app);

	// Catch-all 404 returning a tight JSON body — never an HTML error page.
	app.notFound((c) => c.json({ status: 'not_found' }, 404));
	app.onError((err, c) => {
		// Never leak stack traces over the wire. Log internally.
		httpLog.error('unhandled', {}, err);
		return c.json({ status: 'error', code: 'internal' }, 500);
	});

	const server = serve(
		{
			fetch: app.fetch,
			hostname: cfg.listenHost,
			port: cfg.listenPort
		},
		(info) => {
			bootLog.info('listening', {
				host: info.address,
				port: info.port
			});
		}
	);

	// Graceful shutdown. systemd sends SIGTERM; Ctrl-C sends SIGINT.
	const shutdown = (sig: NodeJS.Signals): void => {
		shutdownLog.info('draining', { signal: sig });
		availLimiter.close();
		createLimiter.close();
		dailyCreateLimiter.close();
		inviteLimiter.close();
		inviteTokens.close();
		altcha.close();
		healthService.close();
		// Stop the queue drainer (awaits in-flight broadcasts).
		// We don't await here because the callback pattern of
		// server.close expects a sync handler; instead we let the
		// drainer's in-flight work complete during the server's
		// shutdown window.
		queueDrainer.stop().catch((err) => {
			shutdownLog.error('drainer_stop_error', {}, err);
		});
		server.close(() => {
			db.close().catch((err) => {
				shutdownLog.error('db_close_error', {}, err);
			});
			shutdownLog.info('goodbye');
			process.exit(0);
		});
		// Hard timeout: if active requests don't finish in 20s, abort.
		// The process-level timer prevents a hung request from blocking
		// systemd's restart cycle.
		setTimeout(() => {
			shutdownLog.warn('timeout_force_exit');
			process.exit(1);
		}, 20_000).unref();
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);

	// Log uncaught exceptions but don't swallow them — Node's default
	// behaviour is to crash, which is exactly what we want. systemd
	// restarts the service and we get a clean state.
	process.on('uncaughtException', (err) => {
		procLog.error('uncaught_exception', {}, err);
		process.exit(1);
	});
	process.on('unhandledRejection', (reason) => {
		procLog.error('unhandled_rejection', {}, reason);
		process.exit(1);
	});
}

main().catch((err) => {
	bootLog.error('fatal', {}, err);
	process.exit(1);
});
