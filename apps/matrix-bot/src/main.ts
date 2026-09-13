/**
 * morphit-matrix-bot entry point.
 *
 * Wires together:
 *   - config parsing (env vars → BotConfig)
 *   - state persistence (SQLite at MORPHIT_MATRIX_BOT_STATE_DB)
 *   - Matrix client (matrix-bot-sdk, OR dry-run logger in test)
 *   - journalctl tailer (streams structured JSON alerts)
 *   - classifier (alert → tier + category)
 *   - rate limiter (WARN: 1/hour per category)
 *   - digest scheduler (INFO: drained daily at 09:00 UTC)
 *   - healthcheck HTTP endpoint (systemd readiness probe)
 *
 * Memory's @user:server vs #room:server rule is enforced at
 * every boundary: parseConfig() refuses an MXID list containing
 * a #-prefixed value; classifier always sends private DMs to
 * MXIDs (never to room aliases); the indexer's
 * /v1/instance.operator_matrix_room field is the ONLY place
 * room aliases surface and they never end up in this bot's
 * data flow.
 */

import { parseConfig } from './config.ts';
import { openState } from './state.ts';
import { createRateLimiter } from './rateLimit.ts';
import { classify, renderAlertBody, renderTestAlertBody } from './classifier.ts';
import { createDryRunSender, createMatrixSender, type MatrixSender } from './matrix.ts';
import { createHealthServer } from './health.ts';
import { tailJournalctl } from './journalctl.ts';
import { startDigestScheduler } from './digest.ts';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

async function main(): Promise<void> {
	// ─── Opt-in gate ──
	// The bot is installed by default but DOES NOTHING unless the
	// operator has set MORPHIT_MATRIX_BOT_ALERT_MXID.  This is the
	// "matrix-bot is opt-in" promise — if an operator doesn't use
	// Matrix, the systemd unit can be safely enabled (or not) and
	// the bot will exit cleanly without consuming resources.
	//
	// Detected here BEFORE parseConfig() runs its full zod schema,
	// because zod would throw on missing access-token + ACK_MXID
	// even if the operator hadn't configured ANY Matrix surfaces.
	// We want a clean exit, not a crash, in that case.
	const rawMxid = (process.env.MORPHIT_MATRIX_BOT_ALERT_MXID ?? '').trim();
	if (rawMxid === '') {
		console.log(
			'morphit-matrix-bot: MORPHIT_MATRIX_BOT_ALERT_MXID is not set.\n' +
				'The bot exits cleanly because no Matrix surfaces are configured.\n' +
				'To enable Matrix alerts: set MORPHIT_MATRIX_BOT_ALERT_MXID + ' +
				'MORPHIT_MATRIX_BOT_ACCESS_TOKEN in /etc/morphit/matrix-bot.env and ' +
				'restart this unit.  See OPERATIONS.md §16 "Canonical Matrix routing".'
		);
		process.exit(0);
	}

	const config = parseConfig();
	console.log(
		`morphit-matrix-bot starting.  homeserver=${config.homeserver} ` +
			`recipients=${config.alertMxids.length} dryRun=${config.dryRun}`
	);

	const state = openState(config.stateDbPath);
	const rateLimiter = createRateLimiter(state);

	let sender: MatrixSender;
	if (config.dryRun) {
		sender = createDryRunSender();
	} else {
		const cryptoStorePath = `${config.stateDbPath}.matrix-storage`;
		try {
			sender = await createMatrixSender(config.homeserver, config.accessToken, cryptoStorePath);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// E2EE crypto-state conflict: the bot's device already has one-time keys
			// registered on the homeserver, but this box's local crypto store is fresh
			// (common after a reinstall, or reusing the SAME access token on a new box).
			// A stale store can never reconcile with the server's keys, so clear it and
			// tell the operator to mint a fresh token — instead of crash-looping on an
			// opaque stack trace (the maintainer/morphit.io reinstall).
			if (/already exists/i.test(msg) && /one[- ]?time key|signed_curve25519/i.test(msg)) {
				try {
					// Remove ONLY the crypto store. This used to delete the whole storage
					// directory, which also holds state.json (the sync token) and the
					// persisted DM-room map — so recovering from a key conflict would
					// force a full re-sync AND make the bot forget which room it DMs in,
					// spawning yet another room in the operator's inbox. The key conflict
					// lives in the crypto subdirectory; nothing else needs to go.
					rmSync(join(cryptoStorePath, 'crypto'), { recursive: true, force: true });
				} catch {
					/* best-effort */
				}
				console.error(
					'\nmorphit-matrix-bot: Matrix end-to-end-encryption setup failed.\n\n' +
						"  This bot token's device already has encryption keys on the homeserver,\n" +
						'  but the local crypto store here was fresh — which happens after a\n' +
						'  reinstall, or when the same access token is reused on a new box.\n\n' +
						'  FIX: get a NEW access token for the bot account (log it in again so it\n' +
						'  registers a fresh device), set MORPHIT_MATRIX_BOT_ACCESS_TOKEN in\n' +
						'  /etc/morphit/matrix-bot.env, and restart. The stale crypto store was\n' +
						'  cleared for you, so the fresh token will start clean.\n\n' +
						'  Alerts are OFF until then; the rest of your node is unaffected.\n'
				);
				// Clean exit (not a failure) so systemd does not crash-loop — this needs
				// an operator action, not a restart.
				process.exit(0);
			}
			throw err;
		}
	}

	// Healthcheck endpoint — systemd readiness probe + the `/self-test`
	// route that `morphit-ops matrix test` POSTs to (DMs a labelled test
	// alert to the configured recipients via this same client).
	const health = createHealthServer({
		alertMxids: config.alertMxids,
		dryRun: config.dryRun,
		sender,
		renderTestBody: renderTestAlertBody
	});
	health.listen(config.healthcheckPort, '127.0.0.1');

	// Digest scheduler — fires once per day at config.digestSendTimeUtc.
	const digestStop = startDigestScheduler({
		sendTimeUtc: config.digestSendTimeUtc,
		state,
		rateLimiter,
		onDigest: async (body) => {
			for (const mxid of config.alertMxids) {
				try {
					await sender.sendDm(mxid, body);
				} catch (err) {
					console.error(`failed to deliver digest to ${mxid}:`, err);
				}
			}
		}
	});

	// Journalctl tail — main event loop.
	const tailer = tailJournalctl(config.journalctlUnits, async (alert) => {
		const classified = classify(alert);

		if (classified.tier === 'CRITICAL') {
			// Bypass rate limiter entirely.  Every recipient gets it.
			const body = renderAlertBody(classified);
			for (const mxid of config.alertMxids) {
				try {
					await sender.sendDm(mxid, body);
				} catch (err) {
					console.error(`failed to deliver CRITICAL to ${mxid}:`, err);
				}
			}
			return;
		}

		if (classified.tier === 'WARN') {
			const now = Date.now();
			if (rateLimiter.isLimited(classified.category, now)) {
				rateLimiter.recordSuppression(classified.category, now);
				return;
			}
			rateLimiter.recordDelivery(classified.category, now);
			const body = renderAlertBody(classified);
			for (const mxid of config.alertMxids) {
				try {
					await sender.sendDm(mxid, body);
				} catch (err) {
					console.error(`failed to deliver WARN to ${mxid}:`, err);
				}
			}
			return;
		}

		// INFO — accumulate for the daily digest.
		state.pushInfoEvent(classified.alert);
	});

	// Graceful shutdown.
	function shutdown(signal: string): void {
		console.log(`received ${signal}; shutting down`);
		tailer.stop();
		digestStop();
		health.close();
		void sender.stop().finally(() => {
			state.close();
			process.exit(0);
		});
	}
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));

	console.log('morphit-matrix-bot ready.');
}

main().catch((err) => {
	console.error('morphit-matrix-bot fatal:', err);
	process.exit(1);
});
