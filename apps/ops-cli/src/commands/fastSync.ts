/**
 * morphit-ops fast-sync.
 *
 * Bring a node's indexer to a live orderbook in minutes by restoring the newest
 * federation snapshot anchored on-chain (indexer_snapshot_v1), instead of
 * replaying millions of blocks for days. This is the recommended path for a new
 * install; without it an indexer with an empty database replays the chain by
 * itself.
 *
 * This command is a thin, loud wrapper around snapshot-bootstrap.ts --from-chain:
 * it says which snapshot it found and how old it is, what is trusted and what
 * the node loses, asks EVERY question first, and only then stops the indexer
 * and relay, runs the bootstrap (which reads the signed op, downloads, checks the
 * download against the signed fingerprint, restores, and spot-checks the op log
 * against the chain), and starts them again — whatever happens, except when the
 * database was replaced but must not be served (exit 4).
 *
 * Flags: --signer <account> (trusted publisher, default morphit),
 *        --signer-pubkey <BLT…> (the key a non-official --signer must sign with),
 *        --force (restore over an existing DB without the discard question),
 *        --skip-verify (skip the Tier-2 spot-check, e.g. tor-only with no
 *        cleartext block access yet).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { whileReading, type CommandCtx } from '../lib/ctx.ts';
import { runAsync, sleepMs, systemctlSpinning } from '../lib/spinRun.ts';
import { startDotsSpinner } from '../init/spinner.ts';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { indexerLooksRunning } from './fastForward.ts';
import { ask, askYesNo, isAbortError } from '../init/prompt.ts';
import { section, info, blank, sanitizeForTerm } from '../render/term.ts';
import { INDEXER_ENV_FILES, readEffectiveEnv } from '../lib/relayHiddenHeal.ts';
import { describeDbError } from '../lib/commandFailed.ts';
import { readLocalIndexerHealth } from '../init/installSummary.ts';
import { configuredIndexerBase, readIndexerConfig } from '../init/hiddenUpgradeLocalIndexer.ts';

interface StateRow {
	readonly last_applied_at: string | null;
	readonly last_applied_block: string;
}

/** The env files the indexer's unit sources, for the install at `repo` (the
 *  unit's own list, pinned to it by test/serviceEnvFileLists.test.ts). */
function indexerEnvFiles(repo: string): string[] {
	return INDEXER_ENV_FILES.map((f) =>
		f.startsWith('/opt/morphit/') ? join(repo, f.slice('/opt/morphit/'.length)) : f
	);
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** `bash -c` text: source the indexer's env files the way its unit does, then
 *  exec snapshot-bootstrap with `args`. */
function bootstrapCommand(repo: string, args: readonly string[]): string {
	const tsx = join(repo, 'node_modules', '.bin', 'tsx');
	const full = [
		'--tsconfig',
		join(repo, 'tsconfig.smoke.json'),
		join(repo, 'apps', 'indexer', 'scripts', 'snapshot-bootstrap.ts'),
		...args
	];
	return (
		`set -a; for f in ${indexerEnvFiles(repo).map(shellQuote).join(' ')}; do [ -f "$f" ] && . "$f"; done; set +a; ` +
		`exec ${shellQuote(tsx)} ${full.map(shellQuote).join(' ')}`
	);
}

/** Which snapshot a run would restore, as snapshot-bootstrap --peek found it. */
export type SnapshotPeek =
	| {
			readonly ok: true;
			readonly block: number;
			readonly indexerVersion: string | null;
			/** What to tell the operator about it: its block, how old it is. */
			readonly lines: readonly string[];
	  }
	/** No snapshot to restore, in the tool's own words (never a bare "usage:"). */
	| { readonly ok: false; readonly kind: 'none'; readonly why: string }
	/** The indexer's settings did not load, so nothing could be looked up:
	 *  what they said is missing or wrong. */
	| { readonly ok: false; readonly kind: 'settings'; readonly lines: readonly string[] }
	/** Stopped (Ctrl+C, a closed terminal, a stop) while it looked. */
	| { readonly ok: false; readonly kind: 'stopped'; readonly signal: NodeJS.Signals };

export interface PeekOpts {
	/** An ABSOLUTE path (runFastSync resolves what the operator typed). */
	readonly fromFile: string | null;
	readonly signer?: string;
	readonly signerPubkey?: string;
}

/** After the terminal closed, a write to it fails (EIO) and, unheard, ends this
 *  process before it has started again what it stopped (review, 2026-10-29,
 *  Q2: seen with a real pty). From then on such write errors are ignored, as
 *  upgrade.ts's guardInstallWindow does. */
function quietOnHangup(): void {
	for (const s of [process.stdout, process.stderr]) {
		if (!s.listeners('error').includes(ignoreWriteError)) s.on('error', ignoreWriteError);
	}
}
function ignoreWriteError(): void {
	/* no terminal any more */
}

/** The exit code a stop by each signal ends a command with. */
const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 };

/** Why --peek found nothing, from what it printed: its last own line, with the
 *  lines a trailing colon announces, and never a bare "usage:" or "…failed:".
 *  PURE. */
export function peekFailureWhy(output: string): string {
	const said = output
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '' && !l.startsWith('[hidden-dispatcher]'));
	const at = said.findLastIndex((l) => l.startsWith('snapshot-bootstrap'));
	let why =
		at >= 0 ? said[at]!.replace(/^snapshot-bootstrap( failed)?:\s*/, '') : (said.at(-1) ?? '');
	if (at >= 0 && why.endsWith(':')) {
		const more = said.slice(at + 1, at + 7).map((l) => l.replace(/^-\s*/, ''));
		why = more.length > 0 ? `${why} ${more.join('; ')}` : why.replace(/:$/, '');
	}
	if (/^usage:/i.test(why)) return 'the snapshot tool could not open what it was given';
	why = why.replace(/[:\s]+$/, '');
	return why === '' ? 'it stopped without saying why' : why;
}

/** Ask snapshot-bootstrap which snapshot it would restore and how old it is,
 *  under the turning spinner. Nothing is downloaded (from the chain) and
 *  nothing is written (a file's manifest is read into memory only). Ctrl+C
 *  (or a closed terminal, or a stop) is reported as 'stopped', never as "no
 *  snapshot", and the lookup is stopped with it. */
export async function peekSnapshot(repo: string, o: PeekOpts): Promise<SnapshotPeek> {
	const args =
		o.fromFile !== null
			? [o.fromFile, '--peek']
			: [
					'--from-chain',
					'--peek',
					...(o.signer ? ['--signer', o.signer] : []),
					...(o.signerPubkey ? ['--signer-pubkey', o.signerPubkey] : [])
				];
	const stopSpin = startDotsSpinner(
		o.fromFile !== null
			? 'Reading the snapshot file…'
			: 'Finding the newest snapshot on the chain and how old it is…'
	);
	let got: NodeJS.Signals | null = null;
	let child: ChildProcess | null = null;
	const onSignal = (sig: 'SIGINT' | 'SIGHUP' | 'SIGTERM'): void => {
		if (sig === 'SIGHUP') quietOnHangup();
		got ??= sig;
		// The same terminal sends a Ctrl+C to the child too; a stop sent to this
		// process alone is passed on.
		try {
			child?.kill(sig);
		} catch {
			/* already gone */
		}
	};
	const handlers = (['SIGINT', 'SIGHUP', 'SIGTERM'] as const).map(
		(s) => [s, (): void => onSignal(s)] as const
	);
	for (const [s, h] of handlers) process.on(s, h);
	let r: { status: number | null; signal: NodeJS.Signals | null; stdout: string; output: string };
	try {
		r = await new Promise((resolve) => {
			let stdout = '';
			let output = '';
			const keep = (prev: string, d: string): string => (prev + d).slice(-1024 * 1024);
			try {
				child = spawn('bash', ['-c', bootstrapCommand(repo, args)], {
					cwd: repo,
					stdio: ['ignore', 'pipe', 'pipe']
				});
			} catch (e) {
				resolve({
					status: null,
					signal: null,
					stdout: '',
					output: e instanceof Error ? e.message : String(e)
				});
				return;
			}
			const timer = setTimeout(() => child?.kill('SIGKILL'), 10 * 60_000);
			child.stdout?.setEncoding('utf8');
			child.stderr?.setEncoding('utf8');
			child.stdout?.on('data', (d: string) => {
				stdout = keep(stdout, d);
				output = keep(output, d);
			});
			child.stderr?.on('data', (d: string) => (output = keep(output, d)));
			child.on('error', (e) => {
				clearTimeout(timer);
				resolve({ status: null, signal: null, stdout, output: `${output}\n${e.message}` });
			});
			child.on('close', (status, signal) => {
				clearTimeout(timer);
				resolve({ status, signal, stdout, output });
			});
		});
	} finally {
		stopSpin();
		for (const [s, h] of handlers) process.removeListener(s, h);
	}
	// A stop: this process got the signal, or the lookup ended by one (or with
	// its exit code for one — it says "stopped. Nothing was changed.").
	let stopSig: NodeJS.Signals | null = got;
	if (stopSig === null && r.signal !== null && SIGNAL_EXIT[r.signal] !== undefined)
		stopSig = r.signal;
	if (stopSig === null)
		for (const [s, c] of Object.entries(SIGNAL_EXIT))
			if (c === r.status) stopSig = s as NodeJS.Signals;
	if (stopSig !== null) return { ok: false, kind: 'stopped', signal: stopSig };
	const last = r.stdout.trim().split('\n').at(-1) ?? '';
	if (r.status === 0) {
		try {
			const j = JSON.parse(last) as {
				block?: unknown;
				indexerVersion?: unknown;
				lines?: unknown;
			};
			if (typeof j.block === 'number' && Array.isArray(j.lines)) {
				return {
					ok: true,
					block: j.block,
					indexerVersion: typeof j.indexerVersion === 'string' ? j.indexerVersion : null,
					lines: j.lines.filter((l): l is string => typeof l === 'string')
				};
			}
		} catch {
			/* fall through: not what --peek prints */
		}
	}
	// The indexer's settings did not load (loadConfig): that is not "no
	// snapshot", and it has its own next step.
	if (/config validation failed/i.test(r.output)) {
		const lines = r.output
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => /^-\s*\S/.test(l))
			.map((l) => l.replace(/^-\s*/, ''));
		return { ok: false, kind: 'settings', lines };
	}
	return { ok: false, kind: 'none', why: peekFailureWhy(r.output) };
}

/** What this node's indexer database holds now. */
type NodeState =
	| { readonly kind: 'fresh' }
	| { readonly kind: 'data'; readonly block: number; readonly lastAppliedAt: Date | null };

/** Read indexer_state. A database without the table yet is a fresh node; any
 *  other error is thrown (a Ctrl+C, a database that does not answer) — never
 *  taken for "fresh" (review, 2026-10-29). */
async function readNodeState(ctx: CommandCtx): Promise<NodeState> {
	try {
		const res = await whileReading(ctx, () =>
			ctx.db.query<StateRow>(
				'SELECT last_applied_block::text, last_applied_at FROM indexer_state LIMIT 1'
			)
		);
		if (res.rows.length === 0) return { kind: 'fresh' };
		const block = parseInt(res.rows[0]!.last_applied_block, 10);
		return {
			kind: 'data',
			block: Number.isFinite(block) ? block : 0,
			lastAppliedAt: res.rows[0]!.last_applied_at ? new Date(res.rows[0]!.last_applied_at) : null
		};
	} catch (err) {
		const code = (err as { code?: unknown } | null)?.code;
		if (code === '42P01') return { kind: 'fresh' }; // no indexer_state table yet
		throw err;
	}
}

/** What a restore takes away with this node's own database: the rows that never
 *  travel in a snapshot (apps/indexer/src/db/snapshotLocalState.ts,
 *  LOCAL_ONLY_TABLES, and this operator's local blocks). */
export const LOST_IN_A_RESTORE: readonly string[] = [
	'relay payouts this node has queued but not sent yet (welcome bonuses, refills)',
	"its users' push-notification subscriptions, and pushes waiting to go out",
	'the addresses users gave for offline notices, and notices waiting to go out',
	'your moderation clearances and the accounts you blocked on this node',
	'order view counts and this node’s own price observations',
	'operator statistics and other caches (rebuilt by themselves afterwards)'
];

/** Optional stand-ins for what reaches outside this process. */
export interface FastSyncDeps {
	/** Which snapshot a run would restore (default: snapshot-bootstrap --peek). */
	readonly peek?: (o: PeekOpts) => Promise<SnapshotPeek>;
	/** True once the indexer answers after a start (default: its /v1/health,
	 *  up to ~90 s). `stopEarly` turns true on Ctrl+C: stop waiting. */
	readonly indexerAnswers?: (stopEarly: () => boolean) => Promise<boolean>;
}

export async function runFastSync(ctx: CommandCtx, deps: FastSyncDeps = {}): Promise<number> {
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

	const repo = defaultRepoRoot();
	const force = ctx.flags.force === 'true';
	const fromFile =
		ctx.flags['from-file'] !== undefined && ctx.flags['from-file'] !== 'true'
			? snapshotFilePath(ctx.flags['from-file'])
			: null;
	if (fromFile !== null) {
		// Said first, before anything is read or asked: a path that names no file
		// used to come back as "No snapshot to restore: usage:" (review,
		// 2026-10-29).
		let isFile = false;
		try {
			isFile = statSync(fromFile).isFile();
		} catch {
			/* not there */
		}
		if (!isFile) {
			info(
				existsSync(fromFile)
					? `✗ ${fromFile} is a folder, not a snapshot file.`
					: `✗ There is no file at ${fromFile}.`
			);
			info('  Nothing was changed.');
			return 1;
		}
	}

	// ── 1. What this node holds now. Read first: a database that does not
	// answer is said as such, and nothing is stopped or asked.
	let state: NodeState;
	try {
		state = await readNodeState(ctx);
	} catch (err) {
		if (isAbortError(err)) throw err;
		blank();
		info(
			`✗ ${sanitizeForTerm(
				describeDbError(err) ??
					`The indexer's database could not be read (${err instanceof Error ? err.message : String(err)}).`
			)}`
		);
		info('  Nothing was changed. Run fast-sync again once the database answers.');
		return 1;
	}

	if (fromFile !== null) {
		info('Importing an indexer snapshot from a FILE:');
		info(`  ${fromFile}`);
		info('It is verified against its embedded manifest (chain-id + schema) BEFORE it');
		info('touches the database; the short tail is then re-verified by normal indexing.');
		info('Use this when a synced peer handed you a snapshot (`snapshot-export`) and no');
		info('fresh on-chain @morphit snapshot is available (e.g. the publisher was rebuilt).');
	} else {
		info('Restores the newest on-chain-anchored indexer snapshot, then catches up the');
		info('rest from the chain — minutes to a live orderbook instead of days of replay.');
		blank();
		info(
			'You will be trusting the snapshot PUBLISHER (@' +
				(ctx.flags.signer ?? 'morphit') +
				') for the'
		);
		info('state up to the snapshot — the same trust as running their software. Everything');
		info('after it is read from the chain by your own indexer, and a spot-check compares');
		info('a sample of the snapshot against the chain before your node serves it.');
		blank();
		if (state.kind === 'data' && state.block > 0) {
			info('Prefer not to trust anyone’s snapshot? Answer no below: your indexer keeps its');
			info('own data, which it read from the chain itself.');
		} else {
			info('Prefer not to trust anyone’s snapshot? Answer no below and start the indexer: on');
			info('an empty database it replays the whole chain itself (much slower). On this server:');
			info('    sudo systemctl start morphit-indexer');
		}
	}
	blank();

	// ── 2. Which snapshot, and how old (before anything is asked).
	const snap = await (deps.peek ?? ((o: PeekOpts) => peekSnapshot(repo, o)))({
		fromFile,
		signer: ctx.flags.signer,
		signerPubkey: ctx.flags['signer-pubkey']
	});
	if (!snap.ok) {
		if (snap.kind === 'stopped') {
			blank();
			info('Stopped — nothing was changed.');
			return SIGNAL_EXIT[snap.signal] ?? 130;
		}
		if (snap.kind === 'settings') {
			info('✗ The indexer’s settings did not load, so no snapshot could be looked up.');
			for (const l of snap.lines) info(`    ${sanitizeForTerm(l)}`);
			info('  Nothing was downloaded or changed. To see what to fix, on this server:');
			info('    sudo morphit-ops doctor');
			return 1;
		}
		info(
			fromFile !== null
				? `✗ That file cannot be restored: ${sanitizeForTerm(snap.why)}`
				: `✗ No snapshot to restore: ${sanitizeForTerm(snap.why)}`
		);
		info('  Nothing was downloaded or changed.');
		return 1;
	}
	for (const l of snap.lines) info(sanitizeForTerm(l));
	if (snap.indexerVersion !== null)
		info(`It was made by Morphit indexer v${sanitizeForTerm(snap.indexerVersion)}.`);
	blank();

	// ── 3. What runs now (stopped only after every question).
	const indexerSvc = serviceActive('morphit-indexer');
	const indexerRunning =
		indexerSvc === null
			? state.kind === 'data' && indexerLooksRunning(state.lastAppliedAt, new Date())
			: indexerSvc;
	const relayRunning = serviceActive('morphit-relay') === true;

	// ── 4. A node with its own data: say what it loses, next to what it gets.
	let forceEffective = force;
	if (state.kind === 'data' && state.block > 0 && !force) {
		const w = Math.max(state.block, snap.block).toLocaleString('en-US').length;
		info('This node already has its own indexer data:');
		info(`    your node:     block ${state.block.toLocaleString('en-US').padStart(w)}`);
		info(`    the snapshot:  block ${snap.block.toLocaleString('en-US').padStart(w)}`);
		if (snap.block < state.block) {
			info('  The snapshot is OLDER than what your node already has.');
		}
		info('Fast-sync REPLACES this node’s database with the snapshot. Kept only here, and');
		info('lost with it (the chain cannot give these back):');
		for (const l of LOST_IN_A_RESTORE) info(`  • ${l}`);
		blank();
		const discard = await askYesNo('Replace this node’s database with the snapshot?', false);
		if (!discard) {
			info('Nothing was changed.');
			return 1;
		}
		forceEffective = true;
	}

	// ── 5. The last question, saying what will happen.
	const running = [...(indexerRunning ? ['indexer'] : []), ...(relayRunning ? ['relay'] : [])];
	if (running.length > 0) {
		const names = running.join(' and ');
		info(
			`While it restores, the ${names} ${running.length > 1 ? 'are' : 'is'} stopped; ` +
				`${running.length > 1 ? 'they start' : 'it starts'} again afterwards.`
		);
	}
	const proceed = (await ask('Type "fast-sync" to restore this snapshot')).trim();
	if (proceed !== 'fast-sync') {
		info('Nothing was changed.');
		return 1;
	}

	// ── 6. Stop what runs, restore, start it again.
	blank();
	// What comes next (starting the indexer, or how to) is said once, below.
	return withServicesStopped(
		{ indexer: indexerRunning, relay: relayRunning },
		() =>
			fromFile !== null
				? fastSyncFromFile({
						repoRoot: repo,
						filePath: fromFile,
						force: forceEffective,
						callerSaysNext: true,
						expectBlock: snap.block
					})
				: fastSyncFromChain({
						repoRoot: repo,
						signer: ctx.flags.signer,
						signerPubkey: ctx.flags['signer-pubkey'],
						force: forceEffective,
						skipVerify: ctx.flags['skip-verify'] === 'true',
						callerSaysNext: true,
						ageShown: true,
						// The one shown above, and no other (review, 2026-10-29).
						expectBlock: snap.block
					}),
		deps.indexerAnswers ?? ((stopEarly) => indexerAnswersSoon(stopEarly, repo))
	);
}

/** The --from-file path as the operator meant it: relative to the folder they
 *  typed the command in (the installed launcher passes it as
 *  MORPHIT_OPS_CALLER_CWD, then runs the CLI from inside the install), never
 *  relative to /opt/morphit. PURE given its inputs. */
export function snapshotFilePath(
	typed: string,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd()
): string {
	const p = typed.trim().replace(/^(['"])(.*)\1$/, '$2');
	if (isAbsolute(p)) return p;
	const caller = env.MORPHIT_OPS_CALLER_CWD;
	return resolve(caller !== undefined && isAbsolute(caller) ? caller : cwd, p);
}

/** The local address the indexer's health answers on: the one its own settings
 *  name (MORPHIT_INDEXER_LISTEN_HOST / _PORT in the files its unit sources), an
 *  IP literal only — a name would go to the system resolver — else the
 *  default 127.0.0.1:8081. */
export function localIndexerHealthBase(repo: string): string {
	const dflt = 'http://127.0.0.1:8081';
	try {
		const cfg = readIndexerConfig(indexerEnvFiles(repo));
		if (!cfg.readable) return dflt;
		const base = configuredIndexerBase(cfg);
		if (base === null) return dflt;
		const host = new URL(base).hostname.replace(/^\[|\]$/g, '');
		return /^[0-9.]+$/.test(host) || /^[0-9a-f:]+$/i.test(host) ? base : dflt;
	} catch {
		return dflt;
	}
}

/** Up to ~90 s for the indexer to answer on its local health address. */
async function indexerAnswersSoon(stopEarly: () => boolean, repo: string): Promise<boolean> {
	const base = localIndexerHealthBase(repo);
	const stop = startDotsSpinner('Waiting for the indexer to start…');
	try {
		for (let i = 0; i < 45 && !stopEarly(); i++) {
			if ((await readLocalIndexerHealth(base)).reachable) return true;
			await sleepMs(2000);
		}
		return false;
	} finally {
		stop();
	}
}

/**
 * Stop the running indexer and relay, run `restore`, and start what was
 * stopped again — on success, on failure, and on Ctrl+C (which used to leave a
 * live indexer stopped: the process died on the signal). Not after exit 4: the
 * database was replaced but must not be served; fast-sync then says how to go on.
 * The relay starts only once the indexer has started on a restored database
 * (OPERATIONS.md §52: the indexer's first start removes foreign database code
 * and holds unsent payouts).
 *
 * Shared by `fast-sync` and the guided install (which used to stop only the
 * indexer, leaving the relay writing to the database being replaced — review,
 * 2026-10-29). A closed terminal (SIGHUP) does not end it before what it stopped
 * is started again: writes to the dead terminal are ignored from then on, and
 * the wait for the indexer goes on (only Ctrl+C stops that wait, which then
 * says so and returns 130).
 */
export async function withServicesStopped(
	running: { indexer: boolean; relay: boolean },
	restore: () => number | Promise<number>,
	indexerAnswers: (stopEarly: () => boolean) => Promise<boolean>
): Promise<number> {
	/** The first stop signal before the restore ran. */
	let stopSig: 'SIGINT' | 'SIGHUP' | null = null;
	/** Ctrl+C while waiting for the indexer after a restore. */
	let waiting = false;
	let ctrlCWhileWaiting = false;
	const onInt = (): void => {
		if (waiting) ctrlCWhileWaiting = true;
		stopSig ??= 'SIGINT';
	};
	const onHup = (): void => {
		quietOnHangup();
		stopSig ??= 'SIGHUP';
	};
	process.on('SIGINT', onInt);
	process.on('SIGHUP', onHup);
	const stopped: Array<'morphit-indexer' | 'morphit-relay'> = [];
	let code = 1;
	let ran = false;
	let thrown: { err: unknown } | null = null;
	try {
		let proceed = true;
		for (const [unit, isUp] of [
			['morphit-relay', running.relay],
			['morphit-indexer', running.indexer]
		] as const) {
			if (!isUp) continue;
			const ok = await stopServiceAndWait(unit);
			// Stopped or not, it is started again below if it had been running.
			stopped.push(unit);
			if (!ok) {
				info(
					`✗ Could not confirm the ${unit.replace('morphit-', '')} stopped, so nothing was restored.`
				);
				info(`  On this server: sudo systemctl status ${unit}, then run fast-sync again.`);
				code = 1;
				proceed = false;
				break;
			}
			info(`  ${unit === 'morphit-indexer' ? 'Indexer' : 'Relay'} stopped.`);
			if (stopSig !== null) {
				info(
					stopSig === 'SIGINT'
						? 'Stopped — you pressed Ctrl+C. Nothing was restored.'
						: 'Stopped — the terminal was closed. Nothing was restored.'
				);
				code = SIGNAL_EXIT[stopSig] ?? 130;
				proceed = false;
				break;
			}
		}
		if (proceed) {
			code = await restore();
			ran = true;
		}
	} catch (err) {
		thrown = { err };
	}
	// Still listening: a Ctrl+C while they start again must not end this
	// process before the relay is started (or said how to start).
	let waitStopped = false;
	try {
		const replacedUnusable = ran && code === FAST_SYNC_REPLACED_UNUSABLE;
		if (!replacedUnusable) {
			waitStopped = await startAgain(
				stopped,
				ran && code === 0,
				() => {
					waiting = true;
					return indexerAnswers(() => ctrlCWhileWaiting).finally(() => {
						waiting = false;
					});
				},
				running.indexer,
				() => ctrlCWhileWaiting
			);
		} else if (stopped.length > 0) {
			info(
				`  The ${stopped.map((u) => u.replace('morphit-', '')).join(' and ')} ${stopped.length > 1 ? 'are' : 'is'} left stopped (see above).`
			);
		}
	} finally {
		process.removeListener('SIGINT', onInt);
		process.removeListener('SIGHUP', onHup);
	}
	if (thrown !== null) throw thrown.err;
	return waitStopped ? 130 : code;
}

/** Start again what fast-sync stopped. After a restore the relay waits until
 *  the indexer has started once on it. When the indexer was not running before
 *  (a fresh node), say how to start it — once. Returns true when Ctrl+C
 *  stopped the wait for the indexer (the relay is then left stopped, said). */
async function startAgain(
	stopped: ReadonlyArray<'morphit-indexer' | 'morphit-relay'>,
	restored: boolean,
	indexerAnswers: () => Promise<boolean>,
	indexerWasRunning: boolean,
	ctrlCWhileWaiting: () => boolean
): Promise<boolean> {
	if (stopped.includes('morphit-indexer')) {
		blank();
		await startService(
			'morphit-indexer',
			restored
				? 'Starting the indexer again to catch up the rest from the chain…'
				: 'Starting the indexer again (it goes on from its own data)…'
		);
	} else if (restored && !indexerWasRunning) {
		blank();
		info('Start the indexer; it catches up the rest from the chain. On this server:');
		info('    sudo systemctl start morphit-indexer');
	}
	if (!stopped.includes('morphit-relay')) return false;
	if (restored) {
		const up = stopped.includes('morphit-indexer') ? await indexerAnswers() : false;
		if (!up) {
			const stoppedWait = ctrlCWhileWaiting();
			if (stoppedWait) {
				blank();
				info('Stopped — you pressed Ctrl+C while waiting for the indexer. The snapshot was');
				info('restored and the indexer is starting; the relay was left stopped.');
			} else {
				info('  The relay was left stopped: it must start after the indexer has started once on');
				info('  the restored database.');
			}
			info('  When `sudo morphit-ops health` shows the indexer answering, on this server:');
			info('    sudo systemctl start morphit-relay');
			return stoppedWait;
		}
	}
	await startService('morphit-relay', 'Starting the relay again…');
	return false;
}

/** snapshot-bootstrap's exit code when the database was replaced but must not
 *  be served: quarantined by the op-log check, not tidied, or stopped after the
 *  restore. The indexer stays stopped. */
export const FAST_SYNC_REPLACED_UNUSABLE = 4;

/** Where the indexer's database is, when it is on this server and its name and
 *  owner are plain names; null otherwise. `port` and `socketDir` are what
 *  `psql` needs to reach that same server (the URL's port — 5433 on some
 *  nodes — and a `?host=/run/postgresql`-style socket folder), null for the
 *  defaults. PURE. */
export function localDatabaseOf(url: string | null): {
	db: string;
	owner: string;
	port: number | null;
	socketDir: string | null;
} | null {
	if (url === null || url === '') return null;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	const isLocal = (h: string): boolean =>
		/^(localhost|127\.\d+\.\d+\.\d+|::1|)$/.test(h.replace(/^\[|\]$/g, ''));
	if (!isLocal(u.hostname)) return null;
	// libpq's own parameters win over the URL's host and port.
	let socketDir: string | null = null;
	const hostParam = u.searchParams.get('host');
	if (hostParam !== null && hostParam !== '') {
		if (hostParam.startsWith('/')) {
			if (!/^\/[A-Za-z0-9_./-]*$/.test(hostParam)) return null;
			socketDir = hostParam;
		} else if (!isLocal(hostParam)) return null;
	}
	const portText = u.searchParams.get('port') || u.port;
	let port: number | null = null;
	if (portText !== '') {
		const n = Number(portText);
		if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
		port = n === 5432 ? null : n;
	}
	const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
	const owner = decodeURIComponent(u.username);
	const plain = /^[A-Za-z_][A-Za-z0-9_]*$/;
	return plain.test(db) && plain.test(owner) ? { db, owner, port, socketDir } : null;
}

/** The indexer's database URL as its unit sees it, or null. */
function indexerDatabaseUrl(repo: string): string | null {
	try {
		const v = readEffectiveEnv(indexerEnvFiles(repo), ['MORPHIT_INDEXER_DATABASE_URL']).get(
			'MORPHIT_INDEXER_DATABASE_URL'
		);
		if (v !== undefined && v !== '') return v;
	} catch {
		/* fall through */
	}
	return process.env.MORPHIT_INDEXER_DATABASE_URL || null;
}

/** The ways on after a restore that replaced the database but must not be
 *  served: a fresh copy, or — if the snapshot fails its checks again — a
 *  database rebuilt from the chain, with the exact commands for this node.
 *  PURE. */
export function replacedUnusableWayOut(dbUrl: string | null): string[] {
	const lines = [
		'  What to do, on this server:',
		'   1. Restore a fresh copy (its checks run again, on a new sample):',
		'        sudo morphit-ops fast-sync',
		'   2. If the snapshot fails its checks again, rebuild the indexer’s database from',
		'      the chain instead. Nothing permanent is lost (every order and review is on',
		'      the chain), but replaying it is slow:'
	];
	const local = localDatabaseOf(dbUrl);
	if (local === null) {
		lines.push(
			'        sudo systemctl stop morphit-indexer morphit-relay',
			'      then drop and re-create the indexer’s database (the one named in',
			'      MORPHIT_INDEXER_DATABASE_URL, /etc/morphit/indexer.env) on its database',
			'      server — OPERATIONS.md §46, "The reset" — and:'
		);
	} else {
		// The same server the URL names (its port, its socket folder), and the
		// database made the way the installer makes it (ops/ansible/roles/
		// postgres: UTF8, en_US.UTF-8, from template0).
		const psql =
			'sudo -u postgres psql' +
			(local.port !== null ? ` -p ${local.port}` : '') +
			(local.socketDir !== null ? ` -h ${local.socketDir}` : '');
		lines.push(
			'        sudo systemctl stop morphit-indexer morphit-relay',
			`        ${psql} -c 'DROP DATABASE "${local.db}" WITH (FORCE);'`,
			`        ${psql} -c "CREATE DATABASE \\"${local.db}\\" OWNER \\"${local.owner}\\" ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0;"`
		);
	}
	lines.push(
		'        sudo systemctl start morphit-indexer',
		'      and once `sudo morphit-ops health` shows the indexer answering:',
		'        sudo systemctl start morphit-relay'
	);
	return lines;
}

/** What to tell the operator after exit 4 (the bootstrap said why, above), or
 *  when the restore was cut off once it had started writing the database. */
function printReplacedUnusable(repo: string, cutOff = false): void {
	blank();
	if (cutOff) {
		info('✗ The restore was stopped after it had started replacing the indexer’s database,');
		info('  before its checks were done, so the indexer is left STOPPED: it must not serve');
		info('  from this database.');
	} else {
		info('✗ The snapshot was restored, but it did not pass its checks (see above), so the');
		info('  indexer is left STOPPED: it must not serve from this database.');
	}
	for (const l of replacedUnusableWayOut(indexerDatabaseUrl(repo))) info(l);
}

/** `systemctl is-active <unit>` → true (active) / false (stopped) / null
 *  (systemd not queryable — the caller falls back to a heuristic). */
export function serviceActive(unit: string): boolean | null {
	const r = spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8' });
	if (r.error) return null;
	const out = (r.stdout ?? '').trim();
	if (out === 'active' || out === 'activating') return true;
	if (out === 'inactive' || out === 'failed' || out === 'deactivating') return false;
	return null;
}

/** `systemctl is-active <unit>`, without blocking the event loop (so the
 *  spinner keeps turning while it is polled). Same answers as
 *  {@link serviceActive}. */
async function serviceActiveAsync(unit: string): Promise<boolean | null> {
	const r = await runAsync('systemctl', ['is-active', unit], { timeoutMs: 10_000 });
	if (r.error !== null) return null;
	const out = r.stdout.trim(); // stdout only: a warning on stderr is not the state
	if (out === 'active' || out === 'activating') return true;
	if (out === 'inactive' || out === 'failed' || out === 'deactivating') return false;
	return null;
}

/** Stop a unit, then poll systemd until it reports inactive (up to ~20s).
 *  Returns true once stopped (or if systemd can't be queried — assume the stop
 *  command took). Observes the RUNNING state, never trusts the exit code alone.
 *  The braille spinner turns for the whole stop + wait. */
async function stopServiceAndWait(unit: 'morphit-indexer' | 'morphit-relay'): Promise<boolean> {
	const what = unit === 'morphit-indexer' ? 'indexer' : 'relay';
	const stop = await systemctlSpinning(`Stopping the ${what}…`, ['stop', unit]);
	if (stop.error) return false;
	const spin = startDotsSpinner(`Waiting for the ${what} to stop…`);
	try {
		for (let i = 0; i < 20; i++) {
			const a = await serviceActiveAsync(unit);
			if (a === false || a === null) return true;
			await sleepMs(1_000);
		}
		return (await serviceActiveAsync(unit)) === false;
	} finally {
		spin();
	}
}

/** Stop the indexer and wait until it has stopped (see stopServiceAndWait). */
export async function stopIndexerAndWait(): Promise<boolean> {
	return stopServiceAndWait('morphit-indexer');
}

/** Start a unit (under the spinner as root). */
async function startService(unit: string, label: string): Promise<void> {
	await systemctlSpinning(label, ['start', unit]);
}

/**
 * Run the restore child. Ctrl+C reaches the child (same terminal) and stops
 * it; this process ignores it meanwhile, so its caller still starts the
 * indexer it stopped. Without the listener an installed node (the bundle under
 * plain node) dies on the signal and leaves the indexer stopped; under tsx a
 * hidden handler happened to keep it alive, which is why a first check passed
 * (review, 2026-10-12). The child never says "start the indexer": this
 * process says what to do next, once. `o.ageShown`: the snapshot's age was
 * already shown, so the child does not repeat it.
 */
function runRestore(
	sourceCmd: string,
	repo: string,
	o: { readonly ageShown: boolean }
): { status: number | null; cutOff: boolean } {
	const ignore = (): void => undefined;
	// SIGHUP too: a closed terminal must not end this process before it has
	// started the indexer again (the restore child decides for itself), nor
	// the next line written to that terminal (EIO, review 2026-10-29).
	const hangup = (): void => quietOnHangup();
	process.on('SIGINT', ignore);
	process.on('SIGHUP', hangup);
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
				// What to do next is said once, by this process (it used to be said
				// by the restore AND by fast-sync — review, 2026-10-29).
				MORPHIT_SNAPSHOT_CALLER_STARTS_INDEXER: '1',
				...(o.ageShown ? { MORPHIT_SNAPSHOT_AGE_SHOWN: '1' } : {})
			}
		});
		// Its tsx wrapper can end before the restore itself (a closed terminal
		// ends tsx at once): wait for the restore, or its marker is read too
		// early (review, 2026-10-13).
		waitWhileRunning(pidFile);
		return { status: r.status, cutOff: r.status !== 0 && existsSync(marker) };
	} finally {
		process.removeListener('SIGINT', ignore);
		process.removeListener('SIGHUP', hangup);
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
	/** The caller says what to do next itself (fast-sync): say it nowhere here. */
	callerSaysNext?: boolean;
	/** The caller already showed how old the snapshot is: don't say it again. */
	ageShown?: boolean;
	/** The block of the snapshot the operator was shown and said yes to: any
	 *  other is refused before anything is downloaded. */
	expectBlock?: number;
}): number {
	const repo = opts.repoRoot;
	const bootstrapArgs = ['--from-chain', '--i-trust-signer'];
	if (opts.verifyOnly) bootstrapArgs.push('--verify-only');
	if (opts.signer) bootstrapArgs.push('--signer', opts.signer);
	if (opts.signerPubkey) bootstrapArgs.push('--signer-pubkey', opts.signerPubkey);
	if (opts.force) bootstrapArgs.push('--force');
	if (opts.skipVerify) bootstrapArgs.push('--skip-verify');
	if (opts.expectBlock !== undefined)
		bootstrapArgs.push('--expect-block', String(opts.expectBlock));

	// Source the SAME env files the indexer's systemd unit does, so the bootstrap
	// validates against the FULL indexer config. CHAIN_ID / PUBLIC_ORIGIN /
	// OFFICIAL_POSTING_PUBKEY live in /etc/morphit/indexer.env, which morphit-ops's
	// own process env does NOT include — without this, snapshot-bootstrap fails
	// "MORPHIT_INDEXER_*: Required" on a perfectly-configured box (morphit.io).
	const run = runRestore(bootstrapCommand(repo, bootstrapArgs), repo, {
		ageShown: opts.ageShown === true
	});
	if (run.status === FAST_SYNC_REPLACED_UNUSABLE || run.cutOff) {
		printReplacedUnusable(repo, run.status !== FAST_SYNC_REPLACED_UNUSABLE);
		return FAST_SYNC_REPLACED_UNUSABLE;
	}
	if (run.status !== 0) {
		blank();
		info('✗ Fast-sync did not complete; the indexer\u2019s database is as it was.');
		return run.status === null ? 1 : run.status;
	}

	blank();
	section('Fast-sync complete');
	if (opts.indexerStartedByCaller) {
		info('The indexer now catches up and re-checks the short recent part against the chain.');
		return 0;
	}
	if (opts.callerSaysNext || opts.verifyOnly) return 0;
	info('Start the indexer; it catches up the rest from the chain. On this server:');
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
	/** The caller says what to do next itself (fast-sync): say it nowhere here. */
	callerSaysNext?: boolean;
	/** The block the operator was shown for this file (see fastSyncFromChain). */
	expectBlock?: number;
}): number {
	const repo = opts.repoRoot;
	const bootstrapArgs = [opts.filePath, '--i-trust-this-source'];
	if (opts.force) bootstrapArgs.push('--force');
	if (opts.expectBlock !== undefined)
		bootstrapArgs.push('--expect-block', String(opts.expectBlock));

	const run = runRestore(bootstrapCommand(repo, bootstrapArgs), repo, { ageShown: false });
	if (run.status === FAST_SYNC_REPLACED_UNUSABLE || run.cutOff) {
		printReplacedUnusable(repo, run.status !== FAST_SYNC_REPLACED_UNUSABLE);
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
	if (opts.indexerStartedByCaller || opts.callerSaysNext) return 0;
	info('Start the indexer; it catches up the rest from the chain. On this server:');
	info('    sudo systemctl start morphit-indexer');
	return 0;
}
