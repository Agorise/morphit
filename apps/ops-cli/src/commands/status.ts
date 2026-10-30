/**
 * Morphit ops CLI — `status` subcommand (the dashboard).
 *
 * Single-screen overview an operator wants at the start of
 * an ops session.  Every section maps to a question:
 *   - "Is the indexer healthy?"
 *   - "Is the drain queue moving?"
 *   - "Did the relay let in a normal number of signups today?"
 *   - "Are there any moderation flags I should look at?"
 *   - "Are there pending fee-attestations stuck?"
 *
 * The CLI doesn't try to compute "is this number good?" —
 * thresholds in config.ts do that, and the result is mapped
 * to ✓/⚠/✗ glyphs per row.
 *
 * Output modes:
 *   - default:  human-friendly dashboard with sections + glyphs
 *   - --json:   single JSON document for scripting
 */

import { whileReading, type CommandCtx } from '../lib/ctx.ts';
import { applyThreshold } from '../config.ts';
import { ageSeconds, utcMidnightToday, formatDuration } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, row, blank, info, fmt } from '../render/term.ts';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookupBlurtAccount } from '../init/chainCheck.ts';
import { effectiveEnvValue } from '../lib/instanceOrigin.ts';
import { relayEnvFiles } from '../lib/relayHealthEnvHeal.ts';
import { MAYBE_SENT_SQL, WAITING_SQL, relayQueueMaxRetries } from './failedBroadcasts.ts';
import {
	CANONICAL_BLURT_TREASURY,
	configuredAccountOf,
	localFeeView,
	type LocalFeeView
} from '../lib/operatorFeeRecipient.ts';
import { resolveRelayHealthUrl } from './health.ts';
import { relayHealthUrl } from '../lib/afterRestartHeal.ts';
import {
	readRelayActiveKey,
	relayKeyFix,
	relayKeyFoundAs,
	relayKeyMismatch,
	type RelayActiveKeyState,
	type RelayKeyReading
} from '../lib/relayActiveKey.ts';
import {
	describeWebHeal,
	readWebHealState,
	webHealStatusRow,
	type WebHealState
} from '../lib/webHeal.ts';

// ─── Query result types ──────────────────────────────────────────

interface IndexerStateRow {
	last_applied_block: string;
	last_applied_at: Date | null;
}

interface DrainQueueRow {
	pending_count: string;
	oldest_created_at: Date | null;
	liquid_count: string;
	vesting_count: string;
	delegation_count: string;
}

interface SignupsTodayRow {
	count: string;
}

interface BonusesTodayRow {
	count: string;
	total_blurt: string | null;
}

interface AttestationsRow {
	pending: string;
}

interface ReciprocityRow {
	count: string;
}

interface FailedBroadcastsRow {
	count: string;
	maybe_sent: string;
}

interface StatusSnapshot {
	indexer: {
		last_block_num: number;
		last_block_at: string | null;
		seconds_since_block: number | null;
	};
	drain_queue: {
		pending: number;
		liquid_pending: number;
		vesting_pending: number;
		delegation_pending: number;
		oldest_age_sec: number | null;
	};
	/** The relay account's liquid BLURT (it pays every signup's fee), graded
	 *  like the menu's "relay balance low" marker. */
	relay_balance: RelayBalanceStatus;
	/** The relay's own check of its key against the chain (its /v1/health). */
	relay_key: RelayKeyStatus;
	signups_today: {
		count: number;
		ceiling: number;
		/** Where the ceiling came from: the relay's own settings (as its unit
		 *  reads them), or the relay's built-in default when none sets it. */
		ceiling_source: SignupCeiling['source'];
		percent_of_ceiling: number;
	};
	welcome_bonuses_today: {
		count: number;
		total_blurt: number;
	};
	loyalty_today: {
		count: number;
	};
	attestations: {
		/** Orders in 'pending_external' fee_status — awaiting the
		 *  attestor swarm to verify their external-chain fee. */
		pending_external: number;
	};
	flags_24h: {
		suspicious_reciprocity: number;
		related_accounts: number;
	};
	/** Payments that errored in the last 24 hours and need a look: not sent,
	 *  or MAY have been sent (the relay could not tell and stopped). A row that
	 *  went out after all, or that the relay is still sending or settling from
	 *  the chain (outcome_unknown / in_flight), is not counted. */
	failed_broadcasts_24h: {
		count: number;
		/** Of `count`: may be on the chain — look its transaction up before
		 *  sending it again. The rest were not sent. */
		may_have_been_sent: number;
		not_sent: number;
	};
	/** The most recent on-disk DB backups, read from the filesystem
	 *  (not the DB), so the operator can confirm backups are actually
	 *  running and grab the file path to download or hand to a dev. */
	/** v1.20.0 (G1) — this instance's fees account and whether other
	 *  instances accept it (from this node's own /v1/instance). */
	fees_account: FeesAccountStatus;
	backups: {
		/** Directory the backups live in — where to scp/download from. */
		dir: string;
		dir_exists: boolean;
		/** Up to the 3 most recent backup files, newest first. */
		recent: { name: string; modified_at: string; size_bytes: number }[];
		/** Set when there is nothing to list (no dir yet / none found). */
		note: string | null;
	};
}

// ─── Run ─────────────────────────────────────────────────────────

export async function runStatus(ctx: CommandCtx): Promise<number> {
	// The DB reads and this node's fee view (up to 4 s) under the spinner.
	const snap = await whileReading(ctx, () => collectSnapshot(ctx), 'Reading this node’s status…');
	if (ctx.flags.json === 'true') {
		emitJson(snap);
		return 0;
	}
	renderHumanDashboard(ctx, snap);
	return 0;
}

/** v1.20.0 (G1) — what `status` says about the fees account. */
export interface FeesAccountStatus {
	/** The CONFIGURED fees account (the one `registered` is about). */
	readonly account: string | null;
	/** Where this site tells its users to pay BLURT fees right now. From
	 *  1 November 2026 (by block time) that is the Morphit treasury while
	 *  `account` is not registered; otherwise `account`. */
	readonly paid_to: string | null;
	/** null = this node's indexer did not say (not running, or older). */
	readonly registered: boolean | null;
	/** One calm sentence for the operator, or null when nothing to say. */
	readonly note: string | null;
	readonly status: 'ok' | 'warn' | 'info';
}

const REGISTER_FIX = 'To publish it, run on this server:  sudo morphit-ops register';

/** PURE — turn this node's /v1/instance fee view into the dashboard row.
 *  Only a condition the indexer actually REPORTED is stated; "could not read"
 *  says exactly that. Whether the 1-November rule is in force is the
 *  indexer's own answer: it advertises the treasury instead of an
 *  unregistered account only from then (api/instance.ts
 *  advertisedFeeRecipient). */
export function feesAccountStatus(
	view: LocalFeeView | null,
	fromEnv?: () => string
): FeesAccountStatus {
	if (view === null || view.feeRecipient === null) {
		return {
			account: null,
			paid_to: null,
			registered: null,
			note: "Could not read it from this node's indexer (is morphit-indexer running?).",
			status: 'info'
		};
	}
	const paidTo = view.feeRecipient;
	const account = configuredAccountOf(view, fromEnv) ?? paidTo;
	if (!view.reportsRegistration || view.registered === null) {
		return {
			account,
			paid_to: paidTo,
			registered: null,
			note: "This node's indexer did not report whether it is registered on chain.",
			status: 'info'
		};
	}
	if (!view.registered) {
		const toTreasury = paidTo === CANONICAL_BLURT_TREASURY && account !== paidTo;
		return {
			account,
			paid_to: paidTo,
			registered: false,
			note: toTreasury
				? `Your fees account @${account} is not in your on-chain operator registration, so this ` +
					`site tells its users to pay their BLURT fees whole to the Morphit treasury ` +
					`(@${paidTo}) instead, and you earn none of them. ${REGISTER_FIX}`
				: `@${account} is not in your on-chain operator registration, so other Morphit instances hide ` +
					'the orders your users pay to it in BLURT and drop their first messages to strangers there. ' +
					'From 1 November 2026, until it is registered, this site tells its users to pay their ' +
					`BLURT fees whole to the Morphit treasury instead. ${REGISTER_FIX}`,
			status: 'warn'
		};
	}
	return { account, paid_to: paidTo, registered: true, note: null, status: 'ok' };
}

/** v1.21.18 — the relay account's balance on the dashboard. */
export interface RelayBalanceStatus {
	readonly account: string;
	/** e.g. "412.500 BLURT"; null when it could not be read. */
	readonly balance: string | null;
	readonly blurt: number | null;
	readonly status: 'ok' | 'warn' | 'error' | 'info';
	readonly note: string | null;
}

/** The relay account's liquid BLURT, graded against thresholds.relayBalance
 *  (the same lookup and threshold as the menu's "relay balance low" marker).
 *  Never throws: a chain that cannot be reached says exactly that. */
export async function relayBalanceStatus(
	ctx: CommandCtx,
	timeoutMs = 4_000
): Promise<RelayBalanceStatus> {
	const account = ctx.config.relayAccount;
	const unknown = (note: string): RelayBalanceStatus => ({
		account,
		balance: null,
		blurt: null,
		status: 'info',
		note
	});
	// No relay account known on this server: nothing is looked up.
	if (account === '')
		return unknown(
			"This server's relay account is not known: MORPHIT_RELAY_ACCOUNT is not set in its settings (/opt/morphit/morphit.env)."
		);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), timeoutMs);
	});
	try {
		const acct = await Promise.race([lookupBlurtAccount(account), timeout]);
		if (acct === 'timeout') return unknown('The Blurt network did not answer in time.');
		if (acct === null) return unknown(`@${account} was not found on the Blurt chain.`);
		return {
			account,
			balance: acct.balance,
			blurt: acct.balanceBlurt,
			status: applyThreshold(acct.balanceBlurt, ctx.config.thresholds.relayBalance),
			note: null
		};
	} catch {
		return unknown('Could not reach the Blurt network to read it.');
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** What `status` says about the relay's key (its own check against the
 *  chain). Only a reported `mismatch` is a problem. */
export interface RelayKeyStatus {
	/** The relay's state; null when it could not be asked or did not say. */
	readonly state: RelayActiveKeyState | null;
	readonly value: string;
	readonly status: 'ok' | 'error' | 'info';
	readonly note: string;
	/** The exact commands that fix it (only for a mismatch). */
	readonly fix: readonly string[];
}

/** PURE — the dashboard row for what the relay said about its key. */
export function relayKeyStatus(r: RelayKeyReading): RelayKeyStatus {
	const plain = (
		state: RelayActiveKeyState | null,
		value: string,
		status: RelayKeyStatus['status'],
		note: string
	): RelayKeyStatus => ({ state, value, status, note, fix: [] });
	if (!r.reached)
		return plain(
			null,
			'(unknown)',
			'info',
			'Could not ask the relay. Is it running? On this server: sudo systemctl status morphit-relay'
		);
	if (r.key === null)
		return plain(null, '(not reported)', 'info', 'This relay version does not report it.');
	switch (r.key.state) {
		case 'ok':
			return plain('ok', 'matches the chain', 'ok', "it is the account's active key");
		case 'unchecked':
			return plain(
				'unchecked',
				'being checked',
				'info',
				'The relay has not finished its first check yet.'
			);
		case 'unknown':
			return plain(
				'unknown',
				'not checked yet',
				'info',
				'The relay could not ask the Blurt network yet. It goes on signing and asks again shortly.'
			);
		case 'mismatch': {
			const foundAs = relayKeyFoundAs(r.key);
			return {
				state: 'mismatch',
				value: r.key.noAccount
					? 'no such account'
					: r.key.badKey
						? 'not a valid key'
						: r.key.belowThreshold !== null
							? 'cannot sign alone'
							: 'not the active key',
				status: 'error',
				note: relayKeyMismatch(r.key) + (foundAs !== null ? `. ${foundAs}` : ''),
				fix: relayKeyFix(r.key)
			};
		}
	}
}

/** The relay's /v1/health on this box: the address set in this environment
 *  (as `health` reads it), else the one in the env files the relay's unit
 *  reads (its default 127.0.0.1:8080 when none sets it). */
function relayHealthUrls(): string[] {
	const env = process.env;
	const own = (env.MORPHIT_RELAY_LISTEN_HOST ?? '').trim() !== '';
	return [...new Set([...(own ? [resolveRelayHealthUrl(env)] : []), relayHealthUrl()])];
}

/** The relay's daily signup ceiling and where it came from. */
export interface SignupCeiling {
	readonly ceiling: number;
	/** relay: its own env files (relay.env wins, as in its unit); default: none
	 *  sets it, so the relay's built-in default; unreadable: relay.env is
	 *  there but this user cannot read it (run with sudo). */
	readonly source: 'relay' | 'default' | 'unreadable';
}

/** MORPHIT_RELAY_SIGNUP_DAILY_CEILING as the relay's unit reads it: its env
 *  files in its order, the last one wins (/etc/morphit/relay.env on an
 *  Ansible install — the CLI's own environment never had it, so the dashboard
 *  showed "/ 50" against a relay limited to 20). `fallback` is the relay's
 *  default. MORPHIT_ENV_ROOT relocates the files for tests. */
export function relaySignupCeiling(
	fallback: number,
	root = process.env.MORPHIT_ENV_ROOT ?? ''
): SignupCeiling {
	// relay.env is read last by the relay, so a value there wins over the
	// others: when this user cannot read it, no other file's value is known
	// to be the relay's.
	const relayEnv = `${root}/etc/morphit/relay.env`;
	if (existsSync(relayEnv)) {
		try {
			readFileSync(relayEnv);
		} catch {
			return { ceiling: fallback, source: 'unreadable' };
		}
	}
	const v = effectiveEnvValue(relayEnvFiles(root), 'MORPHIT_RELAY_SIGNUP_DAILY_CEILING');
	const n = v !== null && /^\d+$/.test(v) ? parseInt(v, 10) : null;
	if (n !== null && n > 0) return { ceiling: n, source: 'relay' };
	return { ceiling: fallback, source: 'default' };
}

/** The failed-broadcast counts from their query row. PURE. */
function failedBroadcastCounts(
	r: FailedBroadcastsRow | undefined
): StatusSnapshot['failed_broadcasts_24h'] {
	const count = r !== undefined ? parseInt(r.count, 10) || 0 : 0;
	const maybe = r !== undefined ? parseInt(r.maybe_sent, 10) || 0 : 0;
	return { count, may_have_been_sent: maybe, not_sent: Math.max(0, count - maybe) };
}

/** What the "Failed broadcasts" row says after its count. PURE. */
export function failedBroadcastsDetail(
	fb: StatusSnapshot['failed_broadcasts_24h']
): string | undefined {
	if (fb.count === 0) return undefined;
	const see = 'see them, on this server: sudo morphit-ops failed-broadcasts';
	if (fb.may_have_been_sent === 0) return `still not sent — ${see}`;
	const maybe =
		`${fb.may_have_been_sent} may have been sent (look ${fb.may_have_been_sent === 1 ? 'it' : 'them'} ` +
		'up before sending again)';
	return fb.not_sent > 0 ? `${fb.not_sent} not sent, ${maybe} — ${see}` : `${maybe} — ${see}`;
}

async function collectSnapshot(ctx: CommandCtx): Promise<StatusSnapshot> {
	const midnight = utcMidnightToday();
	// Asked in parallel with the DB queries below; never throws.
	const feeViewP = localFeeView({ timeoutMs: 4_000 });
	const relayBalanceP = relayBalanceStatus(ctx);
	const relayKeyP = readRelayActiveKey(relayHealthUrls(), 4_000).then(relayKeyStatus);
	const ceiling = relaySignupCeiling(ctx.config.signupDailyCeiling);
	const last24h = new Date(Date.now() - 24 * 3600 * 1000);

	// Run all queries in parallel.  Each is a tiny indexed lookup;
	// running serially would just add latency without saving load.
	const [
		indexerStateResult,
		drainQueueResult,
		signupsResult,
		bonusesResult,
		loyaltyResult,
		attestationsResult,
		recipResult,
		relatedResult,
		failedResult
	] = await Promise.all([
		ctx.db.query<IndexerStateRow>(
			`SELECT
			   last_applied_block::text,
			   last_applied_at
			 FROM indexer_state
			 WHERE id = 1`
		),
		ctx.db.query<DrainQueueRow>(
			`SELECT
			   COUNT(*)::text AS pending_count,
			   MIN(created_at) AS oldest_created_at,
			   COUNT(*) FILTER (WHERE kind = 'liquid')::text  AS liquid_count,
			   COUNT(*) FILTER (WHERE kind = 'vesting')::text AS vesting_count,
			   COUNT(*) FILTER (WHERE kind = 'delegation')::text AS delegation_count
			 FROM relay_pending_transfers
			 WHERE broadcast_at IS NULL`
		),
		ctx.db.query<SignupsTodayRow>(
			`SELECT COUNT(*)::text AS count
			 FROM accounts
			 WHERE creator = $1 AND created_block_time >= $2`,
			[ctx.config.relayAccount, midnight]
		),
		ctx.db.query<BonusesTodayRow>(
			`SELECT
			   COUNT(*)::text AS count,
			   SUM(amount_blurt)::text AS total_blurt
			 FROM relay_pending_transfers
			 WHERE created_at >= $1
			   AND reason LIKE 'welcome_bonus%'`,
			[midnight]
		),
		ctx.db.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count
			 FROM account_loyalty_milestones
			 WHERE triggered_in_block IS NOT NULL
			   AND EXISTS (
			     SELECT 1 FROM relay_pending_transfers r
			      WHERE r.created_at >= $1
			        AND r.reason LIKE 'loyalty_milestone_%'
			        AND r.recipient = account_loyalty_milestones.account
			   )`,
			[midnight]
		),
		ctx.db.query<AttestationsRow>(
			`SELECT COUNT(*)::text AS pending
			 FROM orders
			 WHERE fee_status = 'pending_external'
			   AND status = 'live'`
		),
		ctx.db.query<ReciprocityRow>(
			`SELECT COUNT(*)::text AS count
			 FROM suspicious_reciprocity
			 WHERE detected_at >= $1`,
			[last24h]
		),
		ctx.db.query<ReciprocityRow>(
			`SELECT COUNT(*)::text AS count
			 FROM related_accounts
			 WHERE detected_at >= $1`,
			[last24h]
		),
		ctx.db.query<FailedBroadcastsRow>(
			`SELECT COUNT(*)::text AS count,
			        COUNT(*) FILTER (WHERE ${MAYBE_SENT_SQL('$2')})::text AS maybe_sent
			 FROM relay_pending_transfers
			 WHERE broadcast_at IS NULL
			   AND error_count > 0
			   AND last_error_at IS NOT NULL
			   AND last_error_at >= $1
			   AND NOT ${WAITING_SQL('$2')}`,
			[last24h, relayQueueMaxRetries()]
		)
	]);

	const indexer = indexerStateResult.rows[0];
	const drain = drainQueueResult.rows[0];
	const signups = signupsResult.rows[0];
	const bonuses = bonusesResult.rows[0];
	const loyalty = loyaltyResult.rows[0];
	const attestations = attestationsResult.rows[0];
	const recip = recipResult.rows[0];
	const related = relatedResult.rows[0];
	const failed = failedResult.rows[0];

	const indexerLastBlockNum = indexer !== undefined ? parseInt(indexer.last_applied_block, 10) : 0;
	const indexerLastBlockAt = indexer?.last_applied_at ?? null;

	return {
		indexer: {
			last_block_num: indexerLastBlockNum,
			last_block_at: indexerLastBlockAt !== null ? indexerLastBlockAt.toISOString() : null,
			seconds_since_block: indexerLastBlockAt !== null ? ageSeconds(indexerLastBlockAt) : null
		},
		drain_queue: {
			pending: drain !== undefined ? parseInt(drain.pending_count, 10) : 0,
			liquid_pending: drain !== undefined ? parseInt(drain.liquid_count, 10) : 0,
			vesting_pending: drain !== undefined ? parseInt(drain.vesting_count, 10) : 0,
			delegation_pending: drain !== undefined ? parseInt(drain.delegation_count ?? '0', 10) : 0,
			oldest_age_sec: drain?.oldest_created_at != null ? ageSeconds(drain.oldest_created_at) : null
		},
		signups_today: {
			count: signups !== undefined ? parseInt(signups.count, 10) : 0,
			ceiling: ceiling.ceiling,
			ceiling_source: ceiling.source,
			percent_of_ceiling:
				ceiling.ceiling > 0
					? Math.round((parseInt(signups?.count ?? '0', 10) / ceiling.ceiling) * 100)
					: 0
		},
		relay_balance: await relayBalanceP,
		relay_key: await relayKeyP,
		welcome_bonuses_today: {
			count: bonuses !== undefined ? parseInt(bonuses.count, 10) : 0,
			total_blurt: parseFloat(bonuses?.total_blurt ?? '0') || 0
		},
		loyalty_today: {
			count: loyalty !== undefined ? parseInt(loyalty.count, 10) : 0
		},
		attestations: {
			pending_external: attestations !== undefined ? parseInt(attestations.pending, 10) : 0
		},
		flags_24h: {
			suspicious_reciprocity: recip !== undefined ? parseInt(recip.count, 10) : 0,
			related_accounts: related !== undefined ? parseInt(related.count, 10) : 0
		},
		failed_broadcasts_24h: failedBroadcastCounts(failed),
		fees_account: feesAccountStatus(await feeViewP),
		backups: collectBackups()
	};
}

// ─── Backups (filesystem, not DB) ────────────────────────────────

/** Backup files are named `morphit-YYYYMMDD-HHMMSS.sql.gz` (or
 *  `.sql.gz.age` when age-encrypted) by ops/backup/morphit-backup.sh. */
const BACKUP_FILE_RE = /^morphit-\d{8}-\d{6}\.sql\.gz(\.age)?$/;

/** Resolve the backup directory the way the operator configured it:
 *  an explicit MORPHIT_BACKUP_DIR override wins, else BACKUP_DIR from
 *  /etc/morphit/backup.env (root-owned — unreadable is fine, we fall
 *  through), else the wizard default. */
export function resolveBackupDir(): string {
	const override = process.env.MORPHIT_BACKUP_DIR;
	if (override !== undefined && override.trim() !== '') return override.trim();
	try {
		const text = readFileSync('/etc/morphit/backup.env', 'utf8');
		for (const line of text.split('\n')) {
			const m = /^\s*BACKUP_DIR\s*=\s*(.+?)\s*$/.exec(line);
			if (m !== null && m[1] !== undefined) {
				let v = m[1].trim();
				if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
					v = v.slice(1, -1);
				}
				if (v !== '') return v;
			}
		}
	} catch {
		// backup.env absent or not readable by this user — use the default.
	}
	return '/home/morphit/backups';
}

/** Read-only: the up-to-3 most recent backup files in the backup dir.
 *  Never throws and never mutates — pure filesystem inspection. */
export function collectBackups(): StatusSnapshot['backups'] {
	const dir = resolveBackupDir();
	let isDir = false;
	try {
		isDir = statSync(dir).isDirectory();
	} catch {
		isDir = false;
	}
	if (!isDir) {
		return { dir, dir_exists: false, recent: [], note: 'backup directory not found' };
	}
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return { dir, dir_exists: true, recent: [], note: 'backup directory not readable' };
	}
	const stamped: { name: string; modified_at: string; size_bytes: number; mtimeMs: number }[] = [];
	for (const name of names) {
		if (!BACKUP_FILE_RE.test(name)) continue;
		try {
			const st = statSync(join(dir, name));
			if (!st.isFile()) continue;
			stamped.push({
				name,
				modified_at: st.mtime.toISOString(),
				size_bytes: st.size,
				mtimeMs: st.mtimeMs
			});
		} catch {
			// entry vanished / unreadable mid-scan — skip it.
		}
	}
	stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const recent = stamped
		.slice(0, 3)
		.map((f) => ({ name: f.name, modified_at: f.modified_at, size_bytes: f.size_bytes }));
	return {
		dir,
		dir_exists: true,
		recent,
		note: recent.length === 0 ? 'no backups found yet' : null
	};
}

/** Compact human size (B/KB/MB/…), for the dashboard only. */
/** The "Web proxy (BunkerWeb)" section: the background web heal's last
 *  result, when there is one. What is in place, in words (lib/webHeal.ts): a
 *  country list left in BunkerWeb is not "not applied", a check that could
 *  not run is not a failure, and settings that were already in place are
 *  never called "applied". Exported for its test. */
export function renderWebHealSection(wh: WebHealState | null, nowMs = Date.now()): void {
	if (wh === null) return;
	section('Web proxy (BunkerWeb)');
	const whRow = webHealStatusRow(wh);
	row({
		label: 'Privacy settings:',
		value: whRow.value,
		status: whRow.status,
		detail: withoutRepeat(whRow.value, describeWebHeal(wh, nowMs))
	});
	blank();
}

/** `detail` without the words it shares at its start with `value`, which the
 *  row already shows ("left as they are   ⚠ left as they are — …"). PURE. */
export function withoutRepeat(value: string, detail: string): string {
	const v = value.toLowerCase().split(/\s+/);
	const d = detail.split(/\s+/);
	let i = 0;
	const bare = (w: string): string => w.toLowerCase().replace(/[,:;—-]+$/, '');
	while (i < v.length && i < d.length && bare(d[i]!) === bare(v[i]!)) i++;
	if (i < 2) return detail;
	const rest = d
		.slice(i)
		.join(' ')
		.replace(/^[\s,:;—-]+/, '');
	return rest === '' ? detail : rest;
}

function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

// ─── Human render ────────────────────────────────────────────────

function renderHumanDashboard(ctx: CommandCtx, snap: StatusSnapshot): void {
	const t = ctx.config.thresholds;

	// ── Indexer ──
	section('Indexer');
	row({
		label: 'Last indexed block:',
		value: snap.indexer.last_block_num.toString()
	});
	if (snap.indexer.seconds_since_block !== null) {
		const lagBlocks = Math.floor(snap.indexer.seconds_since_block / 3);
		const status = applyThreshold(lagBlocks, t.indexerLagBlocks);
		row({
			label: 'Time since last block:',
			value: formatDuration(snap.indexer.seconds_since_block),
			status,
			detail: `~${lagBlocks} blocks`
		});
	} else {
		row({
			label: 'Time since last block:',
			value: '(never indexed)',
			status: 'warn'
		});
	}
	blank();

	// ── Fees account (v1.20.0, G1) ──
	section('Fees account (federation)');
	const fa = snap.fees_account;
	const toTreasury =
		fa.registered === false && fa.paid_to === CANONICAL_BLURT_TREASURY && fa.account !== fa.paid_to;
	row({
		label: 'BLURT fees go to:',
		value: fa.paid_to !== null ? `@${fa.paid_to}` : '(unknown)',
		status: fa.status,
		detail:
			fa.registered === true
				? fa.paid_to === CANONICAL_BLURT_TREASURY
					? 'shared treasury — accepted everywhere'
					: 'registered on chain — accepted by other instances'
				: toTreasury
					? `the Morphit treasury, until your fees account @${fa.account} is registered on chain`
					: fa.registered === false
						? 'not registered on chain'
						: undefined
	});
	if (fa.note !== null) info(`  ${fa.note}`);
	blank();

	// ── Web proxy (v1.20.1): the background BunkerWeb heal's last result ──
	renderWebHealSection(readWebHealState());

	// ── Relay account: its balance pays every signup's fee ──
	section('Relay account');
	{
		const rb = snap.relay_balance;
		row({
			label: 'Relay balance:',
			value: rb.balance ?? '(unknown)',
			status: rb.status,
			detail:
				rb.note ??
				(rb.status === 'ok'
					? `@${rb.account}`
					: `@${rb.account} is running low — it pays every signup's fee; top it up`)
		});
		const rk = snap.relay_key;
		row({ label: 'Relay key:', value: rk.value, status: rk.status, detail: rk.note });
		for (const line of rk.fix) info(`  ${line}`);
	}
	blank();

	// ── Relay drain queue ──
	section('Relay drain queue');
	{
		const dq = snap.drain_queue;
		const parts = [
			[dq.liquid_pending, 'liquid'],
			[dq.vesting_pending, 'vesting'],
			[dq.delegation_pending, dq.delegation_pending === 1 ? 'delegation' : 'delegations']
		]
			.filter(([n]) => (n as number) > 0)
			.map(([n, what]) => `${n} ${what}`);
		row({
			label: 'Pending transfers:',
			value: dq.pending.toString(),
			detail: dq.pending > 0 && parts.length > 0 ? parts.join(', ') : undefined
		});
	}
	if (snap.drain_queue.oldest_age_sec !== null) {
		const status = applyThreshold(snap.drain_queue.oldest_age_sec, t.drainQueueAgeSec);
		row({
			label: 'Oldest pending age:',
			value: formatDuration(snap.drain_queue.oldest_age_sec),
			status
		});
	} else {
		row({
			label: 'Oldest pending age:',
			value: '(none pending)',
			status: 'ok'
		});
	}
	// Any payment that failed and is still not sent needs a look: these are
	// the users' own BLURT, not abuse noise (it was graded on the abuse scale,
	// so nine stuck payments still read ✓).
	const fb = snap.failed_broadcasts_24h;
	row({
		label: 'Failed broadcasts 24h:',
		value: fb.count.toString(),
		status: fb.count > 0 ? 'warn' : 'ok',
		detail: failedBroadcastsDetail(fb)
	});
	blank();

	// ── Signups ──
	section('Signups today');
	{
		const status = applyThreshold(snap.signups_today.percent_of_ceiling, t.signupsPercentOfCeiling);
		const src = snap.signups_today.ceiling_source;
		row({
			label: 'Today:',
			value: `${snap.signups_today.count} / ${snap.signups_today.ceiling}`,
			status,
			detail:
				`${snap.signups_today.percent_of_ceiling}% of the relay's daily limit` +
				(src === 'unreadable'
					? ' (its own limit is in /etc/morphit/relay.env, which only root can read: sudo morphit-ops status)'
					: src === 'default'
						? " (the relay's default; no setting changes it)"
						: '')
		});
	}
	row({
		label: 'Welcome bonuses today:',
		value: snap.welcome_bonuses_today.count.toString(),
		detail:
			snap.welcome_bonuses_today.count > 0
				? `${snap.welcome_bonuses_today.total_blurt.toFixed(2)} BLURT total`
				: undefined
	});
	row({
		label: 'Loyalty milestones:',
		value: snap.loyalty_today.count.toString()
	});
	blank();

	// ── Moderation ──
	section('Moderation (24h)');
	{
		const status = applyThreshold(snap.flags_24h.suspicious_reciprocity, t.abuseAlerts24h);
		row({
			label: 'Reciprocity flags:',
			value: snap.flags_24h.suspicious_reciprocity.toString(),
			status,
			detail:
				snap.flags_24h.suspicious_reciprocity > 0
					? 'on this server: sudo morphit-ops flags --type=reciprocity'
					: undefined
		});
	}
	{
		const status = applyThreshold(snap.flags_24h.related_accounts, t.abuseAlerts24h);
		row({
			label: 'Related-account flags:',
			value: snap.flags_24h.related_accounts.toString(),
			status,
			detail:
				snap.flags_24h.related_accounts > 0
					? 'on this server: sudo morphit-ops flags --type=related'
					: undefined
		});
	}
	row({
		label: 'Pending attestations:',
		value: snap.attestations.pending_external.toString(),
		detail:
			snap.attestations.pending_external > 0
				? 'on this server: sudo morphit-ops attestations'
				: undefined
	});
	blank();

	// ── Backups ──
	section('Backups');
	row({ label: 'Backup directory:', value: snap.backups.dir });
	if (!snap.backups.dir_exists) {
		row({ label: 'Recent backups:', value: '(directory not found)', status: 'warn' });
		info(
			fmt.dim(
				'  No backups yet. Set up daily database backups, on this server: sudo morphit-ops harden'
			)
		);
	} else if (snap.backups.recent.length === 0) {
		row({ label: 'Recent backups:', value: '(none found yet)', status: 'warn' });
		info(
			fmt.dim(
				'  Expecting files like morphit-YYYYMMDD-HHMMSS.sql.gz — see why, on this server: ' +
					'sudo journalctl -u morphit-backup.service -e --no-pager'
			)
		);
	} else {
		let i = 1;
		for (const b of snap.backups.recent) {
			row({
				label: `Backup ${i}:`,
				value: formatDuration(ageSeconds(new Date(b.modified_at))) + ' ago',
				status: 'ok',
				detail: `${humanSize(b.size_bytes)} — ${b.name}`
			});
			i++;
		}
		info(
			fmt.dim('  Download or send a backup: copy <directory>/<filename> off this host (e.g. scp).')
		);
	}
	blank();

	// Footer hint.
	info(
		fmt.dim(
			'Tip: `morphit-ops --help` for the full subcommand list. ' +
				'Add `--json` to this command for jq-friendly output.'
		)
	);
}
