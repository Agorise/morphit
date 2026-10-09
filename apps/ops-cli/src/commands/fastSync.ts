/**
 * morphit-ops fast-sync.
 *
 * Bring a FRESH node's indexer to a live orderbook in minutes by restoring the
 * newest federation snapshot published on-chain (indexer_snapshot_v1), instead
 * of replaying ~3.75M blocks for days. This is the recommended path for a new
 * install; the trustless full replay is always available (just start the indexer
 * with MORPHIT_INDEXER_START_BLOCK at genesis).
 *
 * This command is a thin, loud wrapper around snapshot-bootstrap.ts --from-chain:
 * it explains exactly what is being trusted, guards against a live indexer,
 * confirms, then runs the bootstrap (which reads the signed op, downloads,
 * verifies sha256 three ways, restores, and Tier-2 spot-checks the op log). On
 * success the operator starts the indexer, which catches up + re-verifies the
 * short tail.
 *
 * Flags: --signer <account> (trusted publisher, default morphit),
 *        --signer-pubkey <BLT…> (the key a non-official --signer must sign with),
 *        --force (restore over an existing DB — destructive),
 *        --skip-verify (skip the Tier-2 spot-check, e.g. tor-only with no
 *        cleartext block access yet).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { whileReading, type CommandCtx } from '../lib/ctx.ts';
import { runAsync, sleepMs, systemctlSpinning } from '../lib/spinRun.ts';
import { startDotsSpinner } from '../init/spinner.ts';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { indexerLooksRunning } from './fastForward.ts';
import { ask, askYesNo } from '../init/prompt.ts';
import { section, info, blank } from '../render/term.ts';

interface StateRow {
	readonly last_applied_at: string | null;
	readonly last_applied_block: string;
}

export async function runFastSync(ctx: CommandCtx): Promise<number> {
	section('Fast-sync from a federation snapshot');

	// --rehearse / --verify-only: prove the whole consumer path works WITHOUT
	// touching the database. Runs before every guard below, because none of them
	// apply: nothing is restored, so a live indexer and existing data are both
	// irrelevant. Safe on a production box.
	if (ctx.flags.rehearse === 'true' || ctx.flags['verify-only'] === 'true') {
		info('REHEARSAL — this finds, downloads and verifies the newest snapshot, then stops.');
		info('Nothing is written. Your database and your running indexer are untouched.');
		info('Use it to prove a new node COULD fast-sync from the federation right now.');
		blank();
		return fastSyncFromChain({
			repoRoot: defaultRepoRoot(),
			signer: ctx.flags.signer,
			signerPubkey: ctx.flags['signer-pubkey'],
			verifyOnly: true
		});
	}

	const force = ctx.flags.force === 'true';
	const fromFile =
		ctx.flags['from-file'] !== undefined && ctx.flags['from-file'] !== 'true'
			? ctx.flags['from-file']
			: null;

	if (fromFile !== null) {
		info('Importing an indexer snapshot from a FILE:');
		info(`  ${fromFile}`);
		info('It is verified against its embedded manifest (chain-id + schema) BEFORE it');
		info('touches the database; the short tail is then re-verified by normal indexing.');
		info('Use this when a synced peer handed you a snapshot (`snapshot-export`) and no');
		info('fresh on-chain @morphit snapshot is available (e.g. the publisher was rebuilt).');
		blank();
	} else {
		info('Restores the newest on-chain-anchored indexer snapshot, then catches up the');
		info('short tail — minutes to a live orderbook instead of days of full replay.');
		blank();
		info(
			'You will be trusting the snapshot PUBLISHER (@' +
				(ctx.flags.signer ?? 'morphit') +
				') for the'
		);
		info('pre-tail state — the same trust as running their software. The tail from the');
		info('snapshot block to chain head is re-verified by normal indexing, and a Tier-2');
		info('spot-check proves the snapshot op log against the chain before you serve.');
		blank();
		info('Prefer zero trust? Skip this and start the indexer with MORPHIT_INDEXER_START_BLOCK');
		info('at genesis for a full trustless replay.');
		blank();
	}

	// Guard: never restore under a LIVE indexer (it fights the poller + the restore
	// truncates its tables). Check the ACTUAL systemd state first (authoritative +
	// instant); fall back to the cursor-recency heuristic only when systemd can't be
	// queried. If it IS running, OFFER to stop it (and wait for it to actually stop)
	// rather than refusing with a "stop it first" wall + a 90s cursor lag, and OFFER
	// to discard existing data rather than demanding --force (morphit.io).
	let forceEffective = force;
	let wasRunning = false;
	try {
		const res = await whileReading(ctx, () =>
			ctx.db.query<StateRow>(
				'SELECT last_applied_block::text, last_applied_at FROM indexer_state LIMIT 1'
			)
		);
		if (res.rows.length > 0) {
			const lastAppliedAt = res.rows[0]!.last_applied_at
				? new Date(res.rows[0]!.last_applied_at)
				: null;
			const svc = indexerServiceActive();
			const running = svc === null ? indexerLooksRunning(lastAppliedAt, new Date()) : svc;
			if (running) {
				const stop = await askYesNo(
					'The indexer is running — stop it now so the snapshot can be restored?',
					true
				);
				if (!stop) {
					info('Aborted — the indexer must be stopped to fast-sync. Nothing changed.');
					return 1;
				}
				if (!(await stopIndexerAndWait())) {
					info('✗ Could not confirm the indexer stopped. Stop it manually and retry:');
					info('    sudo systemctl stop morphit-indexer');
					return 1;
				}
				wasRunning = true;
				info('  Indexer stopped.');
			}
			const existing = parseInt(res.rows[0]!.last_applied_block, 10);
			if (Number.isFinite(existing) && existing > 0 && !forceEffective) {
				const discard = await askYesNo(
					`This node already has indexer data (block ${existing.toLocaleString()}). Fast-sync will DISCARD it and restore the snapshot — continue?`,
					false
				);
				if (!discard) {
					info('Aborted — nothing changed.');
					if (wasRunning) await startIndexer();
					return 1;
				}
				forceEffective = true;
			}
		}
	} catch {
		// No indexer_state yet = truly fresh box = the ideal fast-sync case.
	}

	const proceed = (await ask('Type "fast-sync" to restore the newest federation snapshot')).trim();
	if (proceed !== 'fast-sync') {
		info('Aborted — nothing changed.');
		if (wasRunning) await startIndexer();
		return 1;
	}

	// Run the bootstrap from the deployed repo. Inherit stdio so its progress,
	// verification output, and any prompts reach the operator directly.
	blank();
	const code =
		fromFile !== null
			? fastSyncFromFile({ repoRoot: defaultRepoRoot(), filePath: fromFile, force: forceEffective })
			: fastSyncFromChain({
					repoRoot: defaultRepoRoot(),
					signer: ctx.flags.signer,
					signerPubkey: ctx.flags['signer-pubkey'],
					force: forceEffective,
					skipVerify: ctx.flags['skip-verify'] === 'true'
				});
	// If WE stopped the indexer, restart it so the operator doesn't have to — the
	// tail catch-up + re-verify happens automatically on start (Requirement: finish and check
	// things automatically).
	if (code === 0 && wasRunning) {
		blank();
		await startIndexer('Restarting the indexer to catch up the short tail…');
	}
	return code;
}

/** `systemctl is-active morphit-indexer` → true (active) / false (stopped) / null
 *  (systemd not queryable — caller falls back to the cursor-recency heuristic). */
function indexerServiceActive(): boolean | null {
	const r = spawnSync('systemctl', ['is-active', 'morphit-indexer'], { encoding: 'utf8' });
	if (r.error) return null;
	const out = (r.stdout ?? '').trim();
	if (out === 'active' || out === 'activating') return true;
	if (out === 'inactive' || out === 'failed' || out === 'deactivating') return false;
	return null;
}

/** `systemctl is-active morphit-indexer`, without blocking the event loop (so
 *  the spinner keeps turning while it is polled). Same answers as
 *  {@link indexerServiceActive}. */
async function indexerServiceActiveAsync(): Promise<boolean | null> {
	const r = await runAsync('systemctl', ['is-active', 'morphit-indexer'], { timeoutMs: 10_000 });
	if (r.error !== null) return null;
	const out = r.stdout.trim(); // stdout only: a warning on stderr is not the state
	if (out === 'active' || out === 'activating') return true;
	if (out === 'inactive' || out === 'failed' || out === 'deactivating') return false;
	return null;
}

/** Stop the indexer, then poll systemd until it reports inactive (up to ~20s).
 *  Returns true once stopped (or if systemd can't be queried — assume the stop
 *  command took). Observes the RUNNING state, never trusts the exit code alone.
 *  The braille spinner turns for the whole stop + wait. */
export async function stopIndexerAndWait(): Promise<boolean> {
	const stop = await systemctlSpinning('Stopping the indexer…', ['stop', 'morphit-indexer']);
	if (stop.error) return false;
	const spin = startDotsSpinner('Waiting for the indexer to stop…');
	try {
		for (let i = 0; i < 20; i++) {
			const a = await indexerServiceActiveAsync();
			if (a === false || a === null) return true;
			await sleepMs(1_000);
		}
		return (await indexerServiceActiveAsync()) === false;
	} finally {
		spin();
	}
}

/** Start the indexer again (under the spinner as root). */
async function startIndexer(label = 'Starting the indexer again…'): Promise<void> {
	await systemctlSpinning(label, ['start', 'morphit-indexer']);
}

/**
 * Shared bootstrap driver: spawn snapshot-bootstrap.ts --from-chain and report.
 * Used by both the standalone `fast-sync` command (after its guards) and the
 * install wizard (fresh box, no guards needed). Returns the child's exit code.
 */
export function fastSyncFromChain(opts: {
	repoRoot: string;
	signer?: string;
	/** the posting key a non-official --signer must
	 *  have signed with. The official account's key is pinned in indexer.env. */
	signerPubkey?: string;
	force?: boolean;
	skipVerify?: boolean;
	/** Rehearse only: find, fetch and VERIFY the snapshot, then stop before the
	 *  database is touched. Rehearsing used to mean a raw tsx command line, a
	 *  --tsconfig flag and inventing MORPHIT_INDEXER_CHAIN_ID by hand — which no
	 *  operator was ever going to do, so the one claim that most needed testing
	 *  went untested until it failed on a live box. */
	verifyOnly?: boolean;
}): number {
	const repo = opts.repoRoot;
	const tsx = join(repo, 'node_modules', '.bin', 'tsx');
	const bootstrapArgs = [
		'--tsconfig',
		join(repo, 'tsconfig.smoke.json'),
		join(repo, 'apps', 'indexer', 'scripts', 'snapshot-bootstrap.ts'),
		'--from-chain',
		'--i-trust-signer'
	];
	if (opts.verifyOnly) bootstrapArgs.push('--verify-only');
	if (opts.signer) bootstrapArgs.push('--signer', opts.signer);
	if (opts.signerPubkey) bootstrapArgs.push('--signer-pubkey', opts.signerPubkey);
	if (opts.force) bootstrapArgs.push('--force');
	if (opts.skipVerify) bootstrapArgs.push('--skip-verify');

	// Source the SAME env files the indexer's systemd unit does, so the bootstrap
	// validates against the FULL indexer config. CHAIN_ID / PUBLIC_ORIGIN /
	// OFFICIAL_POSTING_PUBKEY live in /etc/morphit/indexer.env, which morphit-ops's
	// own process env does NOT include — without this, snapshot-bootstrap fails
	// "MORPHIT_INDEXER_*: Required" on a perfectly-configured box (morphit.io).
	// Mirror the unit's `set -a; . each; set +a` (morphit.config.env before
	// indexer.env, last-wins) then exec tsx.
	const envFiles = [
		join(repo, 'morphit.env'),
		join(repo, 'morphit.config.env'),
		'/etc/morphit/indexer.env'
	];
	const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
	const sourceCmd = `set -a; for f in ${envFiles.map(shellQuote).join(' ')}; do [ -f "$f" ] && . "$f"; done; set +a; exec ${shellQuote(tsx)} ${bootstrapArgs.map(shellQuote).join(' ')}`;

	const run = spawnSync('bash', ['-c', sourceCmd], { cwd: repo, stdio: 'inherit' });
	if (run.status !== 0) {
		blank();
		info('✗ Fast-sync did not complete. You can retry, or do a full replay instead.');
		return run.status ?? 1;
	}

	blank();
	section('Fast-sync complete');
	info('Start the indexer; it will catch up + re-verify the short tail to chain head:');
	info('    sudo systemctl start morphit-indexer');
	return 0;
}

/**
 * Peer/file import: restore an indexer snapshot .tar.gz produced by `snapshot-export`
 * on a synced node — the built-in positional-file + `--i-trust-this-source` path.
 * Sources the same env files as fastSyncFromChain so the config validates. Used when
 * no fresh on-chain @morphit snapshot exists (e.g. the publisher box was rebuilt).
 */
export function fastSyncFromFile(opts: {
	repoRoot: string;
	filePath: string;
	force?: boolean;
}): number {
	const repo = opts.repoRoot;
	const tsx = join(repo, 'node_modules', '.bin', 'tsx');
	const bootstrapArgs = [
		'--tsconfig',
		join(repo, 'tsconfig.smoke.json'),
		join(repo, 'apps', 'indexer', 'scripts', 'snapshot-bootstrap.ts'),
		opts.filePath,
		'--i-trust-this-source'
	];
	if (opts.force) bootstrapArgs.push('--force');

	const envFiles = [
		join(repo, 'morphit.env'),
		join(repo, 'morphit.config.env'),
		'/etc/morphit/indexer.env'
	];
	const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
	const sourceCmd = `set -a; for f in ${envFiles.map(shellQuote).join(' ')}; do [ -f "$f" ] && . "$f"; done; set +a; exec ${shellQuote(tsx)} ${bootstrapArgs.map(shellQuote).join(' ')}`;

	const run = spawnSync('bash', ['-c', sourceCmd], { cwd: repo, stdio: 'inherit' });
	if (run.status !== 0) {
		blank();
		info(
			'✗ Snapshot import did not complete. Check the path + that it is a snapshot-export .tar.gz.'
		);
		return run.status ?? 1;
	}
	blank();
	section('Snapshot import complete');
	info('Start the indexer; it will catch up + re-verify the short tail to chain head:');
	info('    sudo systemctl start morphit-indexer');
	return 0;
}
