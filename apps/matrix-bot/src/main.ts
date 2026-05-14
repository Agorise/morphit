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

import { createServer } from 'node:http';
import { parseConfig } from './config.ts';
import { openState } from './state.ts';
import { createRateLimiter } from './rateLimit.ts';
import { classify, renderAlertBody } from './classifier.ts';
import { createDryRunSender, createMatrixSender, type MatrixSender } from './matrix.ts';
import { tailJournalctl } from './journalctl.ts';
import { startDigestScheduler } from './digest.ts';

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
		sender = await createMatrixSender(
			config.homeserver,
			config.accessToken,
			`${config.stateDbPath}.matrix-storage`
		);
	}

	// Healthcheck endpoint — systemd readiness probe.
	const health = createServer((_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
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
