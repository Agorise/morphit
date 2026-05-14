/**
 * matrix-bot configuration — env var parsing with strict
 * validation.  Refuses to start on any invariant violation.
 *
 * The most important invariant: MORPHIT_MATRIX_BOT_ALERT_MXID,
 * if set, MUST be a well-formed `@user:server` MXID.  Refusing
 * an accidentally-pasted `#room:server` value here is one of
 * the defenses against the security-alert-leaks-to-public-room
 * footgun.
 */

import { z } from 'zod';
import { parseMxid, type MatrixMxid } from '@morphit/operator-config';

/** Parsed configuration.  Branded MatrixMxid type prevents
 *  passing an MXID through any code path that expects a room
 *  alias (or vice versa). */
export interface BotConfig {
	readonly homeserver: string;
	readonly accessToken: string;
	/** Comma-separated MXIDs the operator wants alerts DM'd to.
	 *  Multi-recipient supports vacation coverage: operator's
	 *  backup operator goes in the list too. */
	readonly alertMxids: ReadonlyArray<MatrixMxid>;
	/** Path to the journalctl tail unit filter list, or null
	 *  to default to "morphit-*.service". */
	readonly journalctlUnits: ReadonlyArray<string>;
	/** State DB path — SQLite for rate-limit windows + digest
	 *  accumulation surviving restarts. */
	readonly stateDbPath: string;
	/** TCP port the bot binds for systemd healthcheck.  Loopback
	 *  only — nothing user-facing. */
	readonly healthcheckPort: number;
	/** Daily digest send time in UTC (24h "HH:MM" format). */
	readonly digestSendTimeUtc: string;
	/** Dry-run mode for staging — bot reads journalctl and
	 *  classifies but doesn't actually post to Matrix.  Logs
	 *  what it WOULD have sent. */
	readonly dryRun: boolean;
}

const SCHEMA = z.object({
	MORPHIT_MATRIX_BOT_HOMESERVER: z
		.string()
		.url('homeserver must be a full URL, e.g. https://matrix.org')
		.default('https://matrix.org'),

	MORPHIT_MATRIX_BOT_ACCESS_TOKEN: z
		.string()
		.min(1, 'access token required — generate from your Matrix client'),

	/** Comma-separated MXIDs. */
	MORPHIT_MATRIX_BOT_ALERT_MXID: z
		.string()
		.min(1, 'at least one alert MXID required — the bot has nowhere to send alerts otherwise'),

	MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS: z
		.string()
		.default(
			'morphit-indexer.service,morphit-relay.service,morphit-host-monitor.service,morphit-smartctl-monitor.service,morphit-fail2ban-monitor.service,morphit-mdadm-monitor.service,morphit-dmesg-monitor.service,morphit-trivy-monitor.service,morphit-postfix-monitor.service,morphit-certbot-monitor.service,morphit-apt-monitor.service,morphit-compose-monitor.service'
		),

	MORPHIT_MATRIX_BOT_STATE_DB: z
		.string()
		.default('/var/lib/morphit-matrix-bot/state.db'),

	MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT: z.coerce
		.number()
		.int()
		.min(1024)
		.max(65535)
		.default(9876),

	MORPHIT_MATRIX_BOT_DIGEST_SEND_TIME_UTC: z
		.string()
		.regex(/^[0-2]\d:[0-5]\d$/, 'digest time must be "HH:MM" 24-hour UTC')
		.default('09:00'),

	MORPHIT_MATRIX_BOT_DRY_RUN: z
		.string()
		.transform((s) => s === 'true' || s === '1' || s === 'yes')
		.default('false')
});

/** Parse the bot's env vars.  Returns a strongly-typed
 *  BotConfig, or throws ZodError with all violations on
 *  failure (so the operator sees every problem at once,
 *  not one-by-one). */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
	const e = SCHEMA.parse(env);

	// Parse + brand each MXID.  Each one MUST start with @ —
	// reject an accidentally-pasted #room:server outright.
	const rawMxids = e.MORPHIT_MATRIX_BOT_ALERT_MXID.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (rawMxids.length === 0) {
		throw new Error(
			'MORPHIT_MATRIX_BOT_ALERT_MXID parsed to zero recipients.  ' +
				'Provide at least one MXID.'
		);
	}
	const alertMxids: MatrixMxid[] = [];
	for (const raw of rawMxids) {
		// Defense in depth: reject # prefix BEFORE parseMxid, with
		// a more helpful error message than "not a valid MXID".
		// The @↔# replacement footgun deserves an explicit guard
		// here even though parseMxid would also reject it.
		if (raw.startsWith('#')) {
			throw new Error(
				`MORPHIT_MATRIX_BOT_ALERT_MXID contains ${JSON.stringify(raw)} — ` +
					`that's a Matrix room alias (#room:server), not an MXID (@user:server).  ` +
					`The bot DMs operator alerts to private MXIDs only.  Routing alerts ` +
					`to a public room would be a privacy violation.  If you meant the ` +
					`PUBLIC user→operator contact room, set MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM ` +
					`on the indexer instead; the bot's MXID variable is for the operator's ` +
					`PRIVATE alert destination only.`
			);
		}
		const parsed = parseMxid(raw);
		if (parsed === null) {
			throw new Error(
				`MORPHIT_MATRIX_BOT_ALERT_MXID contains ${JSON.stringify(raw)} — ` +
					`not a valid Matrix MXID.  Expected shape: @user:server.example`
			);
		}
		alertMxids.push(parsed);
	}

	const journalctlUnits = e.MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	return {
		homeserver: e.MORPHIT_MATRIX_BOT_HOMESERVER,
		accessToken: e.MORPHIT_MATRIX_BOT_ACCESS_TOKEN,
		alertMxids,
		journalctlUnits,
		stateDbPath: e.MORPHIT_MATRIX_BOT_STATE_DB,
		healthcheckPort: e.MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT,
		digestSendTimeUtc: e.MORPHIT_MATRIX_BOT_DIGEST_SEND_TIME_UTC,
		dryRun: e.MORPHIT_MATRIX_BOT_DRY_RUN
	};
}
