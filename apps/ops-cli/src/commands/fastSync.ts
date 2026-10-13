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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
			? fastSyncFromFile({
					repoRoot: defaultRepoRoot(),
					filePath: fromFile,
					force: forceEffective,
					indexerStartedByCaller: wasRunning
				})
			: fastSyncFromChain({
					repoRoot: defaultRepoRoot(),
					signer: ctx.flags.signer,
					signerPubkey: ctx.flags['signer-pubkey'],
					force: forceEffective,
					skipVerify: ctx.flags['skip-verify'] === 'true',
					indexerStartedByCaller: wasRunning
				});
	// If WE stopped the indexer, start it again, so the operator doesn't have
	// to — after a restore it catches up + re-verifies the short tail; after a
	// failed one it simply goes on from its own data (a failed restore leaves
	// that untouched). It used to be restarted only after a success, so a failed
	// download left a node's indexer stopped (2026-10-12). NEVER on a database
	// that was replaced but did not pass its checks (exit 4): serving from it is
	// exactly what the checks are there to prevent (review, 2026-10-12).
	if (wasRunning && code !== FAST_SYNC_REPLACED_UNUSABLE) {
		blank();
		await startIndexer(
			code === 0
				? 'Restarting the indexer to catch up the short tail…'
				: 'Starting the indexer again (it goes on from its own data)…'
		);
	}
	return code;
}

/** snapshot-bootstrap's exit code when the database was replaced but must not
 *  be served: quarantined by the op-log check, not tidied, or stopped after the
 *  restore. The indexer stays stopped. */
export const FAST_SYNC_REPLACED_UNUSABLE = 4;

/** What to tell the operator after exit 4 (the bootstrap said why, above), or
 *  when the restore was cut off once it had started writing the database. */
function printReplacedUnusable(cutOff = false): void {
	blank();
	if (cutOff) {
		info('✗ The restore was stopped after it had started replacing the indexer\u2019s database,');
		info('  before its checks were done, so the indexer is left STOPPED: it must not serve');
		info('  from this database.');
	} else {
		info('✗ The snapshot was restored, but it did not pass its checks (see above), so the');
		info('  indexer is left STOPPED: it must not serve from this database.');
	}
	info('  Run fast-sync again (it restores a fresh copy over this one):');
	info('      sudo morphit-ops fast-sync');
	info('  If it says again that the snapshot does not match the chain, wait for the next');
	info('  snapshot (one is published daily) and tell the Morphit maintainers.');
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
 * Run the restore child. Ctrl+C reaches the child (same terminal) and stops
 * it; this process ignores it meanwhile, so its caller still starts the
 * indexer it stopped. Without the listener an installed node (the bundle under
 * plain node) dies on the signal and leaves the indexer stopped; under tsx a
 * hidden handler happened to keep it alive, which is why a first check passed
 * (review, 2026-10-12). `callerStartsIndexer` tells the child not to say
 * "start the indexer" when its caller is about to.
 */
function runRestore(
	sourceCmd: string,
	repo: string,
	callerStartsIndexer: boolean
): { status: number | null; cutOff: boolean } {
	const ignore = (): void => undefined;
	// SIGHUP too: a closed terminal must not end this process before it has
	// started the indexer again (the restore child decides for itself).
	process.on('SIGINT', ignore);
	process.on('SIGHUP', ignore);
	// The child writes this file just before the restore begins and removes it
	// once the database is known to be untouched or restored and checked. Still
	// there after the child is gone, it means the database may be replaced and
	// unchecked, whatever exit code the child managed (it can be killed outright).
	const markerDir = mkdtempSync(join(tmpdir(), 'morphit-fast-sync-'));
	const marker = join(markerDir, 'restore-started');
	const pidFile = join(markerDir, 'restore-pid');
	try {
		const r = spawnSync('bash', ['-c', sourceCmd], {
			cwd: repo,
			stdio: 'inherit',
			env: {
				...process.env,
				MORPHIT_SNAPSHOT_RESTORE_MARKER: marker,
				MORPHIT_SNAPSHOT_PID_FILE: pidFile,
				...(callerStartsIndexer ? { MORPHIT_SNAPSHOT_CALLER_STARTS_INDEXER: '1' } : {})
			}
		});
		// Its tsx wrapper can end before the restore itself (a closed terminal
		// ends tsx at once): wait for the restore, or its marker is read too
		// early (review, 2026-10-13).
		waitWhileRunning(pidFile);
		return { status: r.status, cutOff: r.status !== 0 && existsSync(marker) };
	} finally {
		process.removeListener('SIGINT', ignore);
		process.removeListener('SIGHUP', ignore);
		rmSync(markerDir, { recursive: true, force: true });
	}
}

/** The process named in `pidFile` ("<pid> <start time>", written by
 *  snapshot-bootstrap) is still that process and still running. */
function stillRunning(pidFile: string): boolean {
	let pid = 0;
	let start = '';
	try {
		[pid, start] = ((): [number, string] => {
			const [p, s] = readFileSync(pidFile, 'utf8').trim().split(/\s+/);
			return [Number(p), s ?? ''];
		})();
	} catch {
		return false; // gone: it removes the file as it exits
	}
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	// The same process, not a later one given the same number.
	return start === '' || processStartTime(pid) === start;
}

/** A process's start time (/proc/<pid>/stat, field 22), or '' when unknown. */
export function processStartTime(pid: number): string {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
	} catch {
		return '';
	}
}

/** Wait (at most 6 hours) until the restore named in `pidFile` has ended. */
function waitWhileRunning(pidFile: string): void {
	if (!stillRunning(pidFile)) return;
	try {
		info('  Waiting for the restore to finish\u2026');
	} catch {
		/* the terminal may be gone */
	}
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	for (const end = Date.now() + 6 * 3600_000; Date.now() < end && stillRunning(pidFile); )
		Atomics.wait(sleeper, 0, 0, 500);
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
	/** The caller starts the indexer itself (the install wizard): don't tell the
	 *  operator to. */
	indexerStartedByCaller?: boolean;
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

	const run = runRestore(sourceCmd, repo, opts.indexerStartedByCaller === true);
	if (run.status === FAST_SYNC_REPLACED_UNUSABLE || run.cutOff) {
		printReplacedUnusable(run.status !== FAST_SYNC_REPLACED_UNUSABLE);
		return FAST_SYNC_REPLACED_UNUSABLE;
	}
	if (run.status !== 0) {
		blank();
		info('✗ Fast-sync did not complete; the indexer\u2019s database is as it was.');
		info('  You can retry, or do a full replay instead.');
		return run.status === null ? 1 : run.status;
	}

	blank();
	section('Fast-sync complete');
	if (opts.indexerStartedByCaller) {
		info('The indexer now catches up and re-checks the short recent part against the chain.');
		return 0;
	}
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
	/** The caller starts the indexer itself: don't tell the operator to. */
	indexerStartedByCaller?: boolean;
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

	const run = runRestore(sourceCmd, repo, opts.indexerStartedByCaller === true);
	if (run.status === FAST_SYNC_REPLACED_UNUSABLE || run.cutOff) {
		printReplacedUnusable(run.status !== FAST_SYNC_REPLACED_UNUSABLE);
		return FAST_SYNC_REPLACED_UNUSABLE;
	}
	if (run.status !== 0) {
		blank();
		info(
			'✗ Snapshot import did not complete. Check the path + that it is a snapshot-export .tar.gz.'
		);
		return run.status === null ? 1 : run.status;
	}
	blank();
	section('Snapshot import complete');
	if (opts.indexerStartedByCaller) return 0;
	info('Start the indexer; it will catch up + re-verify the short tail to chain head:');
	info('    sudo systemctl start morphit-indexer');
	return 0;
}
