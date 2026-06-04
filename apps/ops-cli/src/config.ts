/**
 * Morphit ops CLI — configuration.
 *
 * Reads required + optional env vars that drive the CLI's
 * behavior.  The CLI is a read-mostly view into the indexer
 * + relay shared database, so the only required input is the
 * database connection string.
 *
 * Threshold values follow the audit-recommended defaults.
 * Operators who want different thresholds can override via
 * env vars without rebuilding the CLI.
 *
 * Why no operator-config dependency: the CLI runs on the same
 * VPS as the indexer/relay, but it's a standalone tool that
 * shouldn't load the project's morphit.config.env at import
 * time (which would force an env file to exist for unrelated
 * subcommands like `--help`).  The env vars the CLI needs are
 * a small subset of what the indexer and relay use.
 */

/** Direction-of-goodness for a metric.  When the value crosses
 *  a threshold IN THIS DIRECTION, it triggers a warning/error. */
export type Direction = 'higher_worse' | 'lower_worse';

export interface Threshold {
	readonly warn: number;
	readonly error: number;
	readonly direction: Direction;
}

export interface Config {
	/** PostgreSQL connection string.  Same DB used by indexer
	 *  and relay; either's URL works. */
	readonly databaseUrl: string;

	/** This operator's relay-account name on Blurt.  Used to
	 *  filter `accounts.creator = <relayAccount>` to count
	 *  signups this operator's relay actually performed (vs.
	 *  any other relay's signups also visible in the shared
	 *  indexer DB). */
	readonly relayAccount: string;

	/** This operator's fees-account name on Blurt.  Used as
	 *  the default for balance/earnings drill-downs.  Optional
	 *  — falls back to `morphit-fees` if unset. */
	readonly feesAccount: string;

	/** This operator's official chain account — the `operator` key
	 *  in `operator_blocks`. Instance-local blocks written by
	 *  `morphit-ops block` are keyed on this, matching the on-chain
	 *  block handler. Default `morphit`. */
	readonly officialAccount: string;

	/** This operator's daily signup ceiling.  Snapshot of the
	 *  relay's MORPHIT_RELAY_SIGNUP_DAILY_CEILING.  CLI uses
	 *  this to compute "X / Y today" on the dashboard.  Default
	 *  matches the relay's default. */
	readonly signupDailyCeiling: number;

	/** Threshold tunables.  All operator-overridable. */
	readonly thresholds: {
		readonly relayBalance: Threshold;
		readonly drainQueueAgeSec: Threshold;
		readonly indexerLagBlocks: Threshold;
		readonly signupsPercentOfCeiling: Threshold;
		readonly abuseAlerts24h: Threshold;
	};

	/** Color output mode.  'auto' = TTY-aware, 'always' =
	 *  force ANSI even when piped, 'never' = strip. */
	readonly color: 'auto' | 'always' | 'never';
}

/** Read an integer env var with a default. */
function envInt(key: string, fallback: number): number {
	const v = process.env[key];
	if (v === undefined || v === '') return fallback;
	const n = parseInt(v, 10);
	if (isNaN(n)) {
		throw new Error(`Environment variable ${key} must be a number, got: ${v}`);
	}
	return n;
}

/** Read a string env var with a default. */
function envStr(key: string, fallback: string): string {
	const v = process.env[key];
	return v === undefined || v === '' ? fallback : v;
}

/** Read DATABASE_URL with a clear error if missing.  This is
 *  the only required env var; everything else has a default. */
function readDatabaseUrl(): string {
	const candidates = ['MORPHIT_OPS_DATABASE_URL', 'MORPHIT_INDEXER_DATABASE_URL', 'DATABASE_URL'];
	for (const key of candidates) {
		const v = process.env[key];
		if (v !== undefined && v !== '') return v;
	}
	throw new Error(
		'No database URL configured.  Set one of:\n' +
			'  MORPHIT_OPS_DATABASE_URL   (CLI-specific)\n' +
			'  MORPHIT_INDEXER_DATABASE_URL\n' +
			'  DATABASE_URL\n' +
			'\n' +
			'Example: postgres://morphit:secret@localhost:5432/morphit'
	);
}

export function loadConfig(): Config {
	return {
		databaseUrl: readDatabaseUrl(),
		relayAccount: envStr('MORPHIT_OPS_RELAY_ACCOUNT', 'morphit-relay'),
		feesAccount: envStr('MORPHIT_OPS_FEES_ACCOUNT', 'morphit-fees'),
		// The operator's official chain account — the `operator` key in
		// operator_blocks (and what the on-chain block handler gates on).
		// Same env var the indexer reads, so they agree.
		officialAccount: envStr('MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME', 'morphit'),
		signupDailyCeiling: envInt('MORPHIT_RELAY_SIGNUP_DAILY_CEILING', 50),
		thresholds: {
			relayBalance: {
				warn: envInt('MORPHIT_OPS_THRESHOLD_RELAY_BALANCE_WARN', 100),
				error: envInt('MORPHIT_OPS_THRESHOLD_RELAY_BALANCE_ERROR', 30),
				direction: 'lower_worse'
			},
			drainQueueAgeSec: {
				warn: envInt('MORPHIT_OPS_THRESHOLD_DRAIN_AGE_WARN_SEC', 5 * 60),
				error: envInt('MORPHIT_OPS_THRESHOLD_DRAIN_AGE_ERROR_SEC', 60 * 60),
				direction: 'higher_worse'
			},
			indexerLagBlocks: {
				warn: envInt('MORPHIT_OPS_THRESHOLD_INDEXER_LAG_WARN_BLOCKS', 5),
				error: envInt('MORPHIT_OPS_THRESHOLD_INDEXER_LAG_ERROR_BLOCKS', 30),
				direction: 'higher_worse'
			},
			signupsPercentOfCeiling: {
				warn: envInt('MORPHIT_OPS_THRESHOLD_SIGNUPS_PCT_WARN', 80),
				error: envInt('MORPHIT_OPS_THRESHOLD_SIGNUPS_PCT_ERROR', 100),
				direction: 'higher_worse'
			},
			abuseAlerts24h: {
				warn: envInt('MORPHIT_OPS_THRESHOLD_ABUSE_WARN', 10),
				error: envInt('MORPHIT_OPS_THRESHOLD_ABUSE_ERROR', 50),
				direction: 'higher_worse'
			}
		},
		color: readColorMode()
	};
}

function readColorMode(): Config['color'] {
	const v = process.env.MORPHIT_OPS_COLOR;
	if (v === 'always' || v === 'never' || v === 'auto') return v;
	if (process.env.NO_COLOR !== undefined) return 'never';
	return 'auto';
}

/** Apply a threshold to a numeric value.  Returns the appropriate
 *  glyph status: 'ok' | 'warn' | 'error'. */
export function applyThreshold(value: number, threshold: Threshold): 'ok' | 'warn' | 'error' {
	if (threshold.direction === 'lower_worse') {
		// Smaller value is worse.
		if (value <= threshold.error) return 'error';
		if (value <= threshold.warn) return 'warn';
		return 'ok';
	} else {
		// Larger value is worse.
		if (value >= threshold.error) return 'error';
		if (value >= threshold.warn) return 'warn';
		return 'ok';
	}
}
