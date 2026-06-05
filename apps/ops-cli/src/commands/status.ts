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

import type { CommandCtx } from '../lib/ctx.ts';
import { applyThreshold } from '../config.ts';
import { ageSeconds, utcMidnightToday, formatDuration } from '../lib/time.ts';
import { emitJson } from '../render/json.ts';
import { section, row, blank, info, fmt } from '../render/term.ts';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
		oldest_age_sec: number | null;
	};
	signups_today: {
		count: number;
		ceiling: number;
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
	failed_broadcasts_24h: {
		count: number;
	};
	/** The most recent on-disk DB backups, read from the filesystem
	 *  (not the DB), so the operator can confirm backups are actually
	 *  running and grab the file path to download or hand to a dev. */
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
	const snap = await collectSnapshot(ctx);
	if (ctx.flags.json === 'true') {
		emitJson(snap);
		return 0;
	}
	renderHumanDashboard(ctx, snap);
	return 0;
}

async function collectSnapshot(ctx: CommandCtx): Promise<StatusSnapshot> {
	const midnight = utcMidnightToday();
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
			   COUNT(*) FILTER (WHERE kind = 'vesting')::text AS vesting_count
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
			`SELECT COUNT(*)::text AS count
			 FROM relay_pending_transfers
			 WHERE last_error_at IS NOT NULL
			   AND last_error_at >= $1`,
			[last24h]
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
			oldest_age_sec: drain?.oldest_created_at != null ? ageSeconds(drain.oldest_created_at) : null
		},
		signups_today: {
			count: signups !== undefined ? parseInt(signups.count, 10) : 0,
			ceiling: ctx.config.signupDailyCeiling,
			percent_of_ceiling:
				ctx.config.signupDailyCeiling > 0
					? Math.round((parseInt(signups?.count ?? '0', 10) / ctx.config.signupDailyCeiling) * 100)
					: 0
		},
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
		failed_broadcasts_24h: {
			count: failed !== undefined ? parseInt(failed.count, 10) : 0
		},
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

	// ── Relay drain queue ──
	section('Relay drain queue');
	row({
		label: 'Pending transfers:',
		value: snap.drain_queue.pending.toString(),
		detail:
			snap.drain_queue.pending > 0
				? `${snap.drain_queue.liquid_pending} liquid, ${snap.drain_queue.vesting_pending} vesting`
				: undefined
	});
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
	const failedStatus = applyThreshold(
		snap.failed_broadcasts_24h.count,
		// Use same threshold scale as abuse — ad-hoc but reasonable.
		ctx.config.thresholds.abuseAlerts24h
	);
	row({
		label: 'Failed broadcasts 24h:',
		value: snap.failed_broadcasts_24h.count.toString(),
		status: failedStatus,
		detail:
			snap.failed_broadcasts_24h.count > 0
				? '`morphit-ops failed-broadcasts` for detail'
				: undefined
	});
	blank();

	// ── Signups ──
	section('Signups today');
	{
		const status = applyThreshold(snap.signups_today.percent_of_ceiling, t.signupsPercentOfCeiling);
		row({
			label: 'Today:',
			value: `${snap.signups_today.count} / ${snap.signups_today.ceiling}`,
			status,
			detail: `${snap.signups_today.percent_of_ceiling}% of ceiling`
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
					? '`morphit-ops flags --type=reciprocity`'
					: undefined
		});
	}
	{
		const status = applyThreshold(snap.flags_24h.related_accounts, t.abuseAlerts24h);
		row({
			label: 'Related-account flags:',
			value: snap.flags_24h.related_accounts.toString(),
			status,
			detail: snap.flags_24h.related_accounts > 0 ? '`morphit-ops flags --type=related`' : undefined
		});
	}
	row({
		label: 'Pending attestations:',
		value: snap.attestations.pending_external.toString(),
		detail: snap.attestations.pending_external > 0 ? '`morphit-ops attestations`' : undefined
	});
	blank();

	// ── Backups ──
	section('Backups');
	row({ label: 'Backup directory:', value: snap.backups.dir });
	if (!snap.backups.dir_exists) {
		row({ label: 'Recent backups:', value: '(directory not found)', status: 'warn' });
		info(fmt.dim('  No backups yet — set up daily DB backups via `morphit-ops harden`.'));
	} else if (snap.backups.recent.length === 0) {
		row({ label: 'Recent backups:', value: '(none found yet)', status: 'warn' });
		info(
			fmt.dim(
				'  Expecting files like morphit-YYYYMMDD-HHMMSS.sql.gz — ' +
					'check `journalctl -u morphit-backup.service`.'
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
		info(fmt.dim('  Download or send a backup: copy <directory>/<filename> off this host (e.g. scp).'));
	}
	blank();

	// Footer hint.
	info(
		fmt.dim(
			'Tip: `morphit-ops --help` for the full subcommand list. ' +
				'Add `--json` to any command for jq-friendly output.'
		)
	);
}
