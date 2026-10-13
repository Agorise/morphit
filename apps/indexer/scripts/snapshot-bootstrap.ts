#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/snapshot-bootstrap.ts
 *
 * Restore an indexer-DB snapshot (from snapshot-export.ts) onto THIS box, so a
 * fresh instance starts near the chain head and only catches up the small gap
 * over its configured (e.g. hidden-only) pool — days → minutes.
 *
 * SAFETY (all gates fail CLOSED — see snapshotManifest.ts):
 *   1. manifest must parse and be compatible (chain id EXACT, schema not newer
 *      than this build, pg not newer than this host);
 *   2. the operator must pass --i-trust-this-source — restoring means trusting
 *      the snapshot's derived state instead of re-deriving from chain; only ever
 *      do this with a snapshot from YOUR OWN synced box;
 *   3. refuses to clobber a DB that already has real data unless --force.
 *
 * Run on the FRESH target (env sourced, indexer STOPPED), repo root:
 *   sudo systemctl stop morphit-indexer
 *   set -a; . /etc/morphit/indexer.env; set +a
 *   node_modules/.bin/tsx --tsconfig tsconfig.smoke.json \
 *     apps/indexer/scripts/snapshot-bootstrap.ts <snapshot.tar.gz> --i-trust-this-source
 *   sudo systemctl start morphit-indexer
 *
 * EXIT CODES (v1.21.7) — the caller decides from them whether the indexer may
 * be started again:
 *   0  restored and checked;
 *   1  failed, and the database is exactly as it was (start it again);
 *   4  the database WAS replaced, but must not be served: the op-log check
 *      quarantined it, the clean-up after the restore failed, or the run was
 *      stopped after the restore (Ctrl+C). Leave the indexer stopped.
 * (Before, all of these were 1, and the callers restarted the indexer on a
 * quarantined database — review, 2026-10-12.)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index.ts';
import { bootChainClient, installChainRouting } from '../src/indexer/bootChainClient.ts';
import { createDatabase } from '../src/db/pool.ts';
import { latestSchemaVersion } from '../src/db/migrations.ts';
import { distrustRestoredPostingKeys } from '../src/indexer/postingKeyBackfill.ts';
import { resolveTrustedSnapshotOp } from '../src/blurt/snapshotOpTrust.ts';
import {
	sanitizeDumpFile,
	newRestrictKey,
	DumpRefusedError
} from '../src/db/snapshotDumpSanitize.ts';
import { scrubRestoredLocalState, dropRoutinesNotInSchema } from '../src/db/snapshotLocalState.ts';
import {
	parseManifest,
	verifyManifestCompatible,
	manifestFederationReadiness,
	MANIFEST_FILENAME,
	DUMP_FILENAME,
	type SnapshotManifest,
	type TargetFacts
} from '../src/db/snapshotManifest.ts';
import {
	INDEXER_SNAPSHOT_SIGNER_DEFAULT,
	type IndexerSnapshotPayload,
	type SelectedSnapshotOp
} from '../src/blurt/indexerSnapshotOp.ts';
import {
	buildSnapshotSources,
	mirrorPeers,
	hasUsableSource,
	type SnapshotSource
} from '../src/blurt/snapshotMirrors.ts';
import { suppressDblurtConsoleNoise } from '@morphit/rpc-pool';
import {
	defaultIpfsGateways,
	fetchViaKubo,
	KUBO_STALL_MS,
	kuboGatewayFrom
} from '../src/blurt/snapshotKuboFetch.ts';
import {
	acceptSnapshotDownload,
	emptyWorkDir,
	extractSnapshotArchive
} from '../src/blurt/snapshotArchive.ts';
import { startPausableSpinner } from '../../ops-cli/src/init/spinner.ts';

const has = (name: string): boolean => process.argv.includes(`--${name}`);

// The RPC library's failover chatter ("Didn't failover for error …") is noise
// here: the pool fails over, and this script reports its own result.
suppressDblurtConsoleNoise();

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Failed, database exactly as it was. */
const EXIT_UNCHANGED = 1;
/** Stopped with Ctrl+C before the restore began: database exactly as it was. */
const EXIT_STOPPED = 130;
/** The database was replaced but must not be served (see the header). */
const EXIT_REPLACED_UNUSABLE = 4;

/** A stop with its exit code. Thrown (never process.exit here), so the work
 *  directory — tarball, dump, the uncompressed restore.sql — is always removed
 *  and the database pool closed (review, 2026-10-12: every failed run left them
 *  in /tmp). */
class Stop extends Error {
	constructor(
		message: string,
		readonly code: number
	) {
		super(message);
	}
}

function die(msg: string, code: number = EXIT_UNCHANGED): never {
	throw new Stop(msg, code);
}

/** Set once the restore has committed: from then on the database is no longer
 *  what it was, and a stop must say so (exit 4), not "nothing changed". */
let replaced = false;
/** Set just before psql starts the restore: from then a Ctrl+C is noted (psql
 *  sees it too and rolls back if it had not committed), never acted on at once. */
let restoreStarted = false;
/** Ctrl+C once the restore had started. */
let interruptedAfterRestore = false;

/** The child running now (curl, kubo, psql, the op-log check), so a Ctrl+C
 *  before the restore stops it with this process. */
let currentChild: ChildProcess | null = null;

interface ChildResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	/** Only when asked for (`captureStderr`). */
	stderr: string;
	error: NodeJS.ErrnoException | null;
}

/**
 * Run a child WITHOUT blocking this process, and wait for it (v1.21.7).
 *
 * fast-sync runs this script under tsx, which relays a Ctrl+C to it and kills
 * it outright unless it answers within about 60 ms. Blocked in spawnSync it
 * could not answer, so on a busy box a Ctrl+C during the minutes-long op-log
 * check ended it with 130 — read by fast-sync as "the database is as it was",
 * and the indexer was started on a replaced, unchecked database (review,
 * 2026-10-12: 6 of 6 runs on one busy CPU). The same Ctrl+C before the restore
 * left the download and the dump in /tmp.
 */
function runChild(
	cmd: string,
	args: readonly string[],
	opts: {
		input?: string;
		stdout?: 'inherit' | 'ignore';
		captureStderr?: boolean;
		timeoutMs?: number;
		cwd?: string;
	} = {}
): Promise<ChildResult> {
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(cmd, [...args], {
				cwd: opts.cwd,
				stdio: [
					opts.input !== undefined ? 'pipe' : 'ignore',
					opts.stdout ?? 'inherit',
					opts.captureStderr === true ? 'pipe' : 'inherit'
				]
			});
		} catch (e) {
			resolve({ status: null, signal: null, stderr: '', error: e as NodeJS.ErrnoException });
			return;
		}
		currentChild = child;
		let stderr = '';
		let error: NodeJS.ErrnoException | null = null;
		child.stderr?.on('data', (b: Buffer) => {
			if (stderr.length < 64 * 1024) stderr += b.toString('utf8');
		});
		if (opts.input !== undefined) {
			child.stdin?.on('error', () => undefined);
			child.stdin?.end(opts.input);
		}
		const timer =
			opts.timeoutMs !== undefined ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : null;
		child.on('error', (e) => {
			error = e as NodeJS.ErrnoException;
		});
		child.on('close', (status, signal) => {
			if (timer !== null) clearTimeout(timer);
			if (currentChild === child) currentChild = null;
			resolve({ status, signal, stderr, error });
		});
	});
}

/** Where the caller (fast-sync) learns that the restore started, even if this
 *  process is then killed outright: written before psql begins, removed when
 *  the database is known to be either untouched or restored and checked. */
const RESTORE_MARKER = process.env.MORPHIT_SNAPSHOT_RESTORE_MARKER ?? '';
function markRestoreStarted(): void {
	if (RESTORE_MARKER !== '')
		writeFileSync(RESTORE_MARKER, `${new Date().toISOString()}\n`, { mode: 0o600 });
}
function clearRestoreMarker(): void {
	if (RESTORE_MARKER !== '') rmSync(RESTORE_MARKER, { force: true });
}
function stopIfInterrupted(): void {
	if (interruptedAfterRestore)
		die(
			'stopped after the database was replaced (Ctrl+C), before its checks were done. ' +
				'Do not start the indexer on it: run fast-sync again.',
			EXIT_REPLACED_UNUSABLE
		);
}

/** Public IPFS gateways to try for the CID, after the (usually faster) forgejo
 *  https mirror. Overridable via MORPHIT_IPFS_GATEWAYS (comma-separated). A local
 *  kubo gateway, if the box runs one, is tried first. */
function ipfsGateways(): string[] {
	const env = process.env.MORPHIT_IPFS_GATEWAYS;
	if (env && env.trim())
		return env
			.split(',')
			.map((s) => s.trim().replace(/\/+$/, ''))
			.filter(Boolean);
	return defaultIpfsGateways();
}

/** This box's own kubo gateway, when it runs one. Read from kubo rather than
 *  assumed, and null when kubo is absent (a fresh node usually has none yet). */
function localKuboGateway(): string | null {
	const env = process.env.MORPHIT_LOCAL_IPFS_GATEWAY;
	if (env && env.trim() !== '') return env.trim();
	// The daemon's own repo config (fast-sync runs as root, which has no repo
	// of its own, so `ipfs config` would not find it).
	try {
		return kuboGatewayFrom(readFileSync(join(KUBO_REPO, 'config'), 'utf8'));
	} catch {
		return null;
	}
}

/** This box's IPFS (kubo) daemon: its user and repo, as the snapshot mirror
 *  and the release seeder use them. */
const KUBO_USER = process.env.MORPHIT_IPFS_USER ?? 'ipfs';
const KUBO_REPO = process.env.IPFS_PATH ?? '/var/lib/ipfs/.ipfs';
const HAS_RUNUSER = spawnSync('sh', ['-c', 'command -v runuser'], { stdio: 'ignore' }).status === 0;

/** True when this box runs a kubo daemon that `ipfs cat` can ask. */
function localKuboNode(): boolean {
	if (process.env.MORPHIT_SNAPSHOT_NO_KUBO === '1') return false;
	if (!existsSync(KUBO_REPO)) return false;
	return spawnSync('systemctl', ['is-active', '--quiet', 'ipfs.service']).status === 0;
}

/** Fetch `cid` through this box's kubo daemon into `dest`, at most `maxBytes`,
 *  under the spinner (it can take minutes, and kubo prints nothing meanwhile);
 *  given up when no byte has arrived for 5 minutes. Never throws. */
async function downloadViaKubo(cid: string, dest: string, maxBytes: number): Promise<boolean> {
	const spin = startPausableSpinner(
		'asking the IPFS network for it (this can take several minutes)',
		process.stderr,
		{ elapsed: true }
	);
	try {
		return await fetchViaKubo(cid, dest, {
			user: KUBO_USER,
			repo: KUBO_REPO,
			runuser: HAS_RUNUSER,
			maxBytes,
			onChild: (c) => {
				currentChild = c;
			},
			onStall: () =>
				spin.say(() =>
					process.stderr.write(
						`  nothing arrived for ${KUBO_STALL_MS / 60_000} minutes \u2014 giving up on this source.\n`
					)
				)
		});
	} catch {
		return false;
	} finally {
		spin.stop();
	}
}

/** Tor SOCKS + I2P HTTP proxy, overridable for non-default installs. */
const TOR_SOCKS = process.env.MORPHIT_TOR_SOCKS ?? '127.0.0.1:9050';
const I2P_HTTP_PROXY = process.env.MORPHIT_I2P_HTTP_PROXY ?? 'http://127.0.0.1:4444';

/**
 * Download `url` → `dest` (resumable), returning true on success. Never throws.
 *
 * Routes by TRANSPORT: a .onion goes through the Tor SOCKS port with
 * --socks5-hostname (so the hostname is resolved INSIDE Tor — a plain --socks5
 * would leak the lookup to the local resolver), and a .b32.i2p through the i2pd
 * HTTP proxy. Hidden transports get a far longer budget: Tor and especially I2P
 * tunnels are slow to warm up, and a too-tight timeout would report a working
 * private mirror as dead and push the node toward clearnet.
 */
async function download(
	url: string,
	dest: string,
	source: SnapshotSource | undefined,
	maxBytes: number
): Promise<boolean> {
	const transport = source?.transport ?? 'clearnet';
	if (transport === 'kubo') return downloadViaKubo(url.replace(/^kubo:/, ''), dest, maxBytes);
	// Redirects only on clearnet (a public gateway sends ipfs.io/ipfs/<cid> on to
	// a subdomain gateway). A hidden or local source must never send this box
	// elsewhere: curl applies the proxy to a followed redirect too, so a hidden
	// source could point a Tor/I2P-only node at a clearnet URL (review,
	// 2026-10-12). And a source that stalls — accepts, then sends next to
	// nothing — is dropped instead of holding the run for its whole time limit
	// (the hidden RPC nodes are asked too, and most do not mirror yet).
	const args = [
		'-fS',
		...(transport === 'clearnet' ? ['-L'] : ['--max-redirs', '0']),
		// Never more than the signed size (a source that streams on forever
		// filled /tmp before, review 2026-10-12).
		'--max-filesize',
		String(maxBytes),
		'--connect-timeout',
		'20',
		'--speed-limit',
		'512',
		'--speed-time',
		// An I2P tunnel can take minutes before the first byte: a mirror is
		// given ten; a long shot (an RPC node) or a clearnet one two.
		source?.longShot === true || transport === 'clearnet' || transport === 'local' ? '120' : '600',
		'-o',
		dest
	];
	if (transport === 'tor') {
		args.push('--socks5-hostname', TOR_SOCKS, '--max-time', '600');
	} else if (transport === 'i2p') {
		args.push('-x', I2P_HTTP_PROXY, '--max-time', '900');
	} else {
		args.push('--max-time', '600');
	}
	args.push(url);
	const r = await runChild('curl', args);
	return r.status === 0;
}

/**
 * FROM-CHAIN acquire: read the newest indexer_snapshot_v1 op signed by the
 * trusted signer, gate on chain_id, download the tarball (forgejo → IPFS
 * gateways), untar into `work`, and PROVE the inner dump's sha256 against the
 * signed op. Returns the selected op. Every failure is fatal + explained; a bad
 * source is retried, never trusted.
 */
async function acquireFromChain(
	config: ReturnType<typeof loadConfig>,
	work: string
): Promise<SelectedSnapshotOp> {
	const signer = (flag('signer') ?? INDEXER_SNAPSHOT_SIGNER_DEFAULT).toLowerCase();
	const limit = Math.max(
		1,
		Math.min(10_000, parseInt(flag('history-limit') ?? '1000', 10) || 1000)
	);
	const pinnedPubkey = snapshotSignerPubkey(config, signer);

	process.stderr.write(
		`\nsnapshot: reading @${signer}'s chain history for the newest indexer_snapshot_v1 …\n`
	);
	const blurt = bootChainClient(config);
	// this used to be ONE callCondenser — the
	// fastest endpoint alone decided which op (and so which dump) this node
	// restored, and nothing checked that @signer really signed it. Now two
	// RPC operators (counted by node name) must agree on the op AND on the block holding
	// it, and its signature must recover to the pinned posting key.
	let resolved: Awaited<ReturnType<typeof resolveTrustedSnapshotOp>>;
	try {
		resolved = await resolveTrustedSnapshotOp(blurt, {
			signer,
			pinnedPubkey,
			chainId: config.chainId,
			historyLimit: limit,
			minAgree: 2
		});
	} catch (e) {
		die(
			`could not read @${signer}'s snapshot op from the chain: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	if (!resolved.ok) {
		die(
			`${resolved.reason} Nothing was downloaded or changed. Full replay is always available: set ` +
				`MORPHIT_INDEXER_START_BLOCK to genesis and start the indexer.`
		);
	}
	const sel = resolved.selected;
	const history = resolved.history;
	const op: IndexerSnapshotPayload = sel.payload;
	process.stderr.write(
		`  found: block ${op.last_applied_block.toLocaleString()} · schema v${op.schema_version} · ` +
			`indexer v${op.indexer_version} · signer @${sel.signer} · seq ${sel.seq}\n`
	);

	// Early chain gate — refuse before spending bandwidth on another chain's state.
	if (op.chain_id !== config.chainId) {
		die(
			`snapshot op is for chain '${op.chain_id}', this node indexes '${config.chainId}'. Refusing.`
		);
	}

	// Sources. Trust comes from op.sha256 (which @morphit signed and we prove every
	// downloaded byte against), so WHICH copy answers is purely a reachability
	// question — which lets us fan out to the whole federation.
	//
	// Before this, the list was `forgejo_url` + public clearnet IPFS gateways, and
	// that quietly made fast-sync clearnet-only: a Tor/I2P-only node could reach
	// none of them, so the nodes we most want to exist were the ones that had to
	// sit through a multi-day replay. Peers re-serve the same CID over their own
	// .onion / .b32.i2p, so we try those FIRST — on the transport this box already
	// speaks — and a hidden-only node never falls through to clearnet at all.
	// The publisher's own .onion/.b32.i2p come first, from the signed record this
	// node just verified (v1.21.5): @morphit's history holds no registration
	// (morphit.io, 2026-10-10: all 169 entries read), so the history alone gave
	// a Tor/I2P-only newcomer no private source and it fell back to a replay.
	const peers = mirrorPeers({ published: op.hidden_mirrors, directory: null, history, signer });
	const hiddenOnly = config.blurtRpcEndpoints.length === 0;
	const built = buildSnapshotSources({
		cid: op.ipfs_cid,
		forgejoUrl: op.forgejo_url ?? null,
		peers,
		publicGateways: ipfsGateways(),
		localGateway: localKuboGateway(),
		hiddenOnly,
		localNode: !hiddenOnly && localKuboNode(),
		rpcMirrors: config.hiddenRpcEndpoints
	});
	if (!hasUsableSource(built)) {
		die(
			hiddenOnly
				? 'this node is hidden-only, and neither the snapshot record nor any registration on chain names a Tor/I2P address yet, ' +
						'so the snapshot cannot be fetched privately. Refusing to reach for a clearnet gateway. ' +
						'Full replay still works: set MORPHIT_INDEXER_START_BLOCK to genesis and start the indexer.'
				: 'no usable snapshot source could be built from the on-chain op.'
		);
	}
	process.stderr.write(
		`  ${built.length} source${built.length === 1 ? '' : 's'} to try` +
			`${peers.length > 0 ? ` (${peers.length} federation peer${peers.length === 1 ? '' : 's'} over Tor/I2P)` : ''}` +
			`${hiddenOnly ? ' — hidden-only: clearnet sources omitted' : ''}\n`
	);
	const sources: string[] = built.map((s) => s.url);
	const sourceByUrl = new Map(built.map((s) => [s.url, s]));

	const tarPath = join(work, 'snapshot.tar.gz');
	for (const url of sources) {
		const src = sourceByUrl.get(url);
		process.stderr.write(`\nsnapshot: fetching from ${src?.label ?? url} …\n`);
		// Each source starts from an empty directory, and nothing one source
		// does — a hostile archive, a crash — stops the next from being tried
		// (review, 2026-10-12: one bad source aborted the whole run).
		try {
			emptyWorkDir(work);
			if (!(await download(url, tarPath, src, op.size_bytes))) {
				process.stderr.write('  ✗ download failed — trying the next source.\n');
				continue;
			}
			const accepted = await acceptSnapshotDownload(tarPath, work, {
				sizeBytes: op.size_bytes,
				sha256: op.sha256
			});
			if (!accepted.ok) {
				process.stderr.write(`  ✗ ${accepted.reason} — discarding this source.\n`);
				continue;
			}
		} catch (e) {
			process.stderr.write(
				`  ✗ this source failed (${e instanceof Error ? e.message : String(e)}) — trying the next one.\n`
			);
			continue;
		}
		process.stderr.write('  ✓ downloaded + sha256 matches the signed on-chain op.\n');
		return sel;
	}
	die(
		'every source failed to yield a snapshot matching the on-chain sha256. Nothing was changed. Try again later' +
			(hiddenOnly
				? ', or do a full replay.'
				: ', point it at an IPFS gateway you trust (MORPHIT_IPFS_GATEWAYS=https://… sudo morphit-ops fast-sync), or do a full replay.')
	);
}

/**
 * The public key a snapshot op from `signer` must be signed with.
 * The official account's is the pinned MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY
 * — the same anchor the release and rpc-directory handlers check. Any other
 * signer needs its key pinned explicitly with --signer-pubkey.
 */
function snapshotSignerPubkey(config: ReturnType<typeof loadConfig>, signer: string): string {
	const explicit = flag('signer-pubkey');
	if (explicit !== undefined && explicit !== '') return explicit;
	if (signer === config.officialAccountName.toLowerCase()) return config.officialPostingPubkey;
	die(
		`--signer @${signer} is not the official account (@${config.officialAccountName}), so its posting key ` +
			`is not pinned. Add --signer-pubkey <BLT…> with the key you trust for @${signer}.`
	);
}

/** Repo root, from this script's own location (apps/indexer/scripts/). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Can this box restore a snapshot safely? The restore depends on psql's
 * `\restrict`: it is what makes psql refuse every meta-command in the dump (see
 * snapshotDumpSanitize). It shipped in PostgreSQL 18 and in the August 2025
 * minor releases of 13–17.
 *
 * Three different answers, because each needs a different fix: psql is not
 * installed at all; psql cannot reach the indexer's database; or psql is there
 * and connected but does not know `\restrict`. The last one used to be the
 * answer for all three, so a missing client or a stopped database read as
 * "your psql is too old".
 */
type PsqlReadiness =
	| { ok: true }
	| { ok: false; why: 'missing' }
	| { ok: false; why: 'unreachable'; detail: string }
	| { ok: false; why: 'too-old' };

async function psqlReadiness(dbUrl: string): Promise<PsqlReadiness> {
	const connect = await runChild(
		'psql',
		['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1', dbUrl],
		{ stdout: 'ignore', captureStderr: true, timeoutMs: 30_000 }
	);
	if (connect.error?.code === 'ENOENT') return { ok: false, why: 'missing' };
	if (connect.status !== 0) {
		// psql's own words, without the connection string (it can carry the password).
		const detail =
			(connect.stderr ?? '')
				.split(dbUrl)
				.join('<database url>')
				.trim()
				.split('\n')[0]
				?.replace(/[\u0000-\u001f\u007f]/g, '') ?? '';
		return { ok: false, why: 'unreachable', detail };
	}
	const probe = await runChild('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', dbUrl], {
		input: '\\restrict k0\n\\unrestrict k0\n',
		stdout: 'ignore',
		captureStderr: true,
		timeoutMs: 30_000
	});
	return probe.status === 0 ? { ok: true } : { ok: false, why: 'too-old' };
}

async function main(): Promise<void> {
	const fromChain = has('from-chain');
	const snapshotPath = process.argv[2];
	if (!fromChain && (!snapshotPath || snapshotPath.startsWith('--') || !existsSync(snapshotPath))) {
		die(
			'usage:\n' +
				'  own-box:     snapshot-bootstrap.ts <snapshot.tar.gz> --i-trust-this-source [--force]\n' +
				'  federation:  snapshot-bootstrap.ts --from-chain --i-trust-signer [--signer morphit] [--force]'
		);
	}

	// A --verify-only run restores nothing and serves nothing, so most of the
	// indexer config is irrelevant to it — yet loadConfig() demands the lot, and an
	// operator rehearsing from a laptop had to invent four environment variables
	// (and know the tsconfig alias incantation) before it would start. Supply
	// placeholders for the ones a dry run provably never touches.
	//
	// CHAIN ID IS DELIBERATELY NOT DEFAULTED. It is the gate that stops a node
	// restoring another chain's state, and guessing mainnet here would silently
	// weaken that check for anyone on a testnet. Ask for it, and say why.
	if (has('verify-only')) {
		process.env.MORPHIT_INDEXER_DATABASE_URL ??= 'postgres://verify-only-unused';
		process.env.MORPHIT_INDEXER_PUBLIC_ORIGIN ??= 'https://verify-only.invalid';
		// The REAL @morphit posting key (the documented default), not a
		// placeholder: since an earlier release the snapshot op's
		// signature is checked against it, so a dry run proves that too.
		process.env.MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY ??=
			'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9';
		if ((process.env.MORPHIT_INDEXER_CHAIN_ID ?? '') === '') {
			die(
				'--verify-only still needs MORPHIT_INDEXER_CHAIN_ID (64-char hex). It is the gate that ' +
					'stops a node accepting another chain\u2019s snapshot, so it is never guessed. Copy it from ' +
					'/etc/morphit/indexer.env on any instance you trust.'
			);
		}
	}
	const config = loadConfig();
	// Route .onion / .b32.i2p through Tor and i2pd, and refuse clearnet on a
	// hidden-only node, before any request (bootChainClient.ts). Throws if the
	// router cannot be installed: never read the chain unrouted.
	installChainRouting(config);
	const db = createDatabase(config);
	// Who is running the restore, for fast-sync: its tsx wrapper can end first
	// (a closed terminal), and fast-sync waits for this process, not the
	// wrapper, before it reads the marker. "<pid> <start time>", removed at exit.
	const pidFile = process.env.MORPHIT_SNAPSHOT_PID_FILE ?? '';
	if (pidFile !== '') {
		let start = '';
		try {
			const stat = readFileSync('/proc/self/stat', 'utf8');
			start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
		} catch {
			/* not Linux: the pid alone */
		}
		writeFileSync(pidFile, `${process.pid} ${start}\n`, { mode: 0o600 });
		process.on('exit', () => rmSync(pidFile, { force: true }));
	}
	const work = mkdtempSync(join(tmpdir(), 'morphit-snap-restore-'));
	// Whatever ends this process, the download, the dump and restore.sql go.
	process.on('exit', () => rmSync(work, { recursive: true, force: true }));
	// Ctrl+C — or the terminal closing (SIGHUP), or a stop (SIGTERM). Before
	// the restore nothing in the database has changed: stop at once, with
	// whatever child is running. From the restore on it is only noted (psql
	// sees it too), so the run can say which of the two happened.
	const stopOn = (sig: 'SIGINT' | 'SIGHUP' | 'SIGTERM', code: number): void => {
		process.on(sig, () => {
			if (restoreStarted) {
				interruptedAfterRestore = true;
				return;
			}
			currentChild?.kill(sig);
			try {
				process.stderr.write('\nsnapshot-bootstrap: stopped. Nothing was changed.\n');
			} catch {
				/* the terminal may be gone */
			}
			process.exit(code);
		});
	};
	stopOn('SIGINT', EXIT_STOPPED);
	stopOn('SIGHUP', 129);
	stopOn('SIGTERM', 143);

	try {
		// ── acquire: from chain (download+verify) or from a local tarball ──
		let chainOp: SelectedSnapshotOp | null = null;
		if (fromChain) {
			chainOp = await acquireFromChain(config, work);
		} else {
			// The same safe reader as a downloaded copy: a file handed over by a
			// peer is no more trusted than a download.
			const x = await extractSnapshotArchive(snapshotPath!, work, {
				maxDumpBytes: statSync(snapshotPath!).size + 1024 * 1024
			});
			if (!x.ok) die(`could not extract the snapshot archive: ${x.reason}.`);
		}
		const manifestPath = join(work, MANIFEST_FILENAME);
		const dumpPath = join(work, DUMP_FILENAME);
		if (!existsSync(manifestPath) || !existsSync(dumpPath)) {
			die(`archive is missing ${MANIFEST_FILENAME} or ${DUMP_FILENAME}.`);
		}

		// ── gate 1: manifest parses ───────────────────────────────
		const manifest: SnapshotManifest | null = parseManifest(readFileSync(manifestPath, 'utf8'));
		if (!manifest) die('manifest.json is malformed — refusing.');

		// ── gate 1b (federation only): manifest is federation-ready AND the
		//    signed op agrees with the manifest on every safety-critical field ──
		if (fromChain && chainOp) {
			const op = chainOp.payload;
			const fr = manifestFederationReadiness(manifest, op.sha256);
			for (const w of fr.warnings) process.stderr.write(`  note: ${w}\n`);
			if (!fr.ok) {
				for (const r of fr.reasons) process.stderr.write(`  ✗ ${r}\n`);
				die('snapshot manifest is not federation-ready — refusing.');
			}
			// Cross-check the SIGNED op against the manifest. Any disagreement means
			// the tarball's metadata was tampered with relative to what @signer signed.
			const mism: string[] = [];
			if (manifest.chainId !== op.chain_id)
				mism.push(`chain_id (manifest ${manifest.chainId} ≠ op ${op.chain_id})`);
			if (manifest.schemaVersion !== op.schema_version)
				mism.push(`schema_version (manifest ${manifest.schemaVersion} ≠ op ${op.schema_version})`);
			if (manifest.lastAppliedBlock !== op.last_applied_block)
				mism.push(
					`last_applied_block (manifest ${manifest.lastAppliedBlock} ≠ op ${op.last_applied_block})`
				);
			if (mism.length > 0) {
				for (const m of mism)
					process.stderr.write(`  ✗ signed op disagrees with the manifest: ${m}\n`);
				die('the tarball was altered relative to the on-chain op — refusing.');
			}
		}

		// ── gate 2: compatible with THIS build/host ───────────────
		// The server-version lookup is the FIRST thing that touches Postgres, and it
		// sits after the download because it needs the manifest's pgMajor to compare
		// against. A --verify-only run is not restoring anything, so the local
		// server's version is irrelevant to it — and demanding a reachable database
		// here defeats the whole point of a dry run that anyone can execute from a
		// laptop. Substitute the snapshot's own pgMajor so the compatibility check
		// still runs (it can then only compare chain and schema, which is exactly
		// what a dry run should be checking).
		let hostPgMajor: number;
		if (has('verify-only')) {
			hostPgMajor = manifest.pgMajor;
		} else {
			const pv = await db.query<{ n: string }>("SELECT current_setting('server_version_num') AS n");
			hostPgMajor = Math.floor(parseInt(pv.rows[0]!.n, 10) / 10000);
		}
		const target: TargetFacts = {
			chainId: config.chainId,
			codeSchemaVersion: latestSchemaVersion(),
			pgMajor: hostPgMajor
		};
		const verdict = verifyManifestCompatible(manifest, target);
		for (const w of verdict.warnings) process.stderr.write(`  note: ${w}\n`);
		if (!verdict.ok) {
			for (const r of verdict.reasons) process.stderr.write(`  ✗ ${r}\n`);
			die('snapshot is not compatible with this node — refusing.');
		}

		// ── gate 3: explicit trust acknowledgement ────────────────
		if (fromChain) {
			if (!has('i-trust-signer')) {
				process.stderr.write(
					`\n  This will REPLACE this node's indexer DB with a snapshot published on-chain by\n` +
						`      @${chainOp!.signer}  ·  chain ${manifest.chainId}  ·  block ${manifest.lastAppliedBlock.toLocaleString()}\n` +
						`  You are trusting @${chainOp!.signer}'s chain-view for the PRE-TAIL state (the tail from\n` +
						`  block ${manifest.lastAppliedBlock.toLocaleString()} → head is re-verified by normal indexing). This is the same\n` +
						`  trust surface as running @${chainOp!.signer}'s software. Re-run with --i-trust-signer to proceed,\n` +
						`  or do a full trustless replay (MORPHIT_INDEXER_START_BLOCK=genesis).\n`
				);
				die('refused: --i-trust-signer not given.');
			}
		} else if (!has('i-trust-this-source')) {
			process.stderr.write(
				`\n  This will REPLACE this node's indexer DB with the snapshot's derived state\n` +
					`  (orderbook, registrations, balances) taken from:\n` +
					`      ${manifest.sourceLabel}  ·  chain ${manifest.chainId}  ·  block ${manifest.lastAppliedBlock.toLocaleString()}\n` +
					`  Restoring TRUSTS that source instead of re-deriving from the chain — only do\n` +
					`  this with a snapshot from YOUR OWN synced box. Re-run with --i-trust-this-source\n` +
					`  to proceed.\n`
			);
			die('refused: --i-trust-this-source not given.');
		}

		// ── --verify-only: stop here, touch no database ────────────
		// A DRY RUN. Everything above is the real consumer path — resolve the
		// signed op from chain, pick a mirror by transport, download, and prove
		// the bytes against the on-chain SHA-256 and the manifest. Everything
		// below writes to Postgres. Splitting there means an operator can test the
		// whole fetch-and-verify pipeline from a laptop with no indexer DB at all,
		// and with no chance of clobbering one — which is exactly the rehearsal
		// you want BEFORE a brand-new instance depends on it working.
		if (has('verify-only')) {
			process.stderr.write(
				`\n✓ DRY RUN PASSED — fetched and verified, nothing was written.\n` +
					`    snapshot block : ${manifest.lastAppliedBlock.toLocaleString()}\n` +
					`    chain          : ${manifest.chainId}\n` +
					`    sha256         : verified against the on-chain op\n` +
					`    indexer        : v${manifest.indexerVersion ?? 'unknown'} · schema v${manifest.schemaVersion}\n` +
					`  A real fast-sync would now restore this into the indexer DB and replay\n` +
					`  the short tail since that block. Re-run without --verify-only to do it.\n`
			);
			return;
		}

		// ── gate 4: don't clobber a DB that already has real data ─
		const st = await db
			.query<{
				last_applied_block: string;
			}>('SELECT last_applied_block::text FROM indexer_state LIMIT 1')
			.catch(() => ({ rows: [] as Array<{ last_applied_block: string }> }));
		const existing = st.rows.length > 0 ? parseInt(st.rows[0]!.last_applied_block, 10) : -1;
		if (existing > config.startBlock && !has('force')) {
			die(
				`this node already has an indexer DB at block ${existing.toLocaleString()} (> start ${config.startBlock.toLocaleString()}). ` +
					`Restoring would DISCARD it. Re-run with --force if that is intended (stop morphit-indexer first).`
			);
		}

		// ── restore ───────────────────────────────────────────────
		// (rv2-1b, rv2-8). The dump used to be piped straight
		// into psql, which runs its own backslash commands from its input — `\!`
		// is a shell command, and this runs as root. And an `OWNER TO` naming the
		// publisher's role failed on any box whose role differs, after `--clean`
		// had already dropped everything. Now: the dump is filtered (no
		// meta-commands, no ownership or privilege statements), psql is put into
		// `\restrict` mode with a key only this run knows, so psql itself refuses
		// any meta-command anywhere in the dump, and the whole restore is ONE
		// transaction — any failure leaves the existing database as it was.
		process.stderr.write(
			`\nsnapshot: restoring into the indexer DB (this replaces existing objects)…\n`
		);
		const psql = await psqlReadiness(config.databaseUrl);
		if (!psql.ok) {
			if (psql.why === 'missing') {
				die(
					'psql is not installed on this box, and the restore needs it. Install the postgresql-client ' +
						'package (a release from August 2025 or later) and re-run. Nothing was changed.'
				);
			}
			if (psql.why === 'unreachable') {
				die(
					`psql could not reach the indexer's database${psql.detail ? ` (${psql.detail})` : ''}. Check that ` +
						'Postgres is running and DATABASE_URL is right, then re-run. Nothing was changed.'
				);
			}
			die(
				"this box's psql is too old to restore a snapshot safely (it needs \\restrict, added in the " +
					'August 2025 PostgreSQL client releases: 13.22, 14.19, 15.14, 16.10, 17.6 or 18). Update the ' +
					'postgresql-client package and re-run. Nothing was changed.'
			);
		}
		const sqlPath = join(work, 'restore.sql');
		try {
			const st = await sanitizeDumpFile(dumpPath, sqlPath, newRestrictKey());
			if (st.droppedOwnership + st.droppedPrivileges > 0) {
				process.stderr.write(
					`  note: left out ${st.droppedOwnership} ownership and ${st.droppedPrivileges} privilege statement(s); ` +
						`everything is owned by this node's own database role.\n`
				);
			}
		} catch (e) {
			if (e instanceof DumpRefusedError) {
				die(`refusing this snapshot: ${e.message}. Nothing was changed.`);
			}
			die(
				`could not read the snapshot dump: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`
			);
		}
		// From here a Ctrl+C reaches psql too (same terminal): before the commit it
		// rolls the transaction back; this process only notes it, so it can say
		// which of the two happened instead of dying without a word.
		restoreStarted = true;
		markRestoreStarted();
		const restore = await runChild(
			'psql',
			[
				'-X',
				'-q',
				'-v',
				'ON_ERROR_STOP=1',
				'--single-transaction',
				'-f',
				sqlPath,
				config.databaseUrl
			],
			{ stdout: 'ignore' }
		);
		if (restore.status !== 0) {
			clearRestoreMarker();
			die(
				`restore failed (psql exit ${restore.status ?? 'signal'}). It ran as one transaction, so the ` +
					`database is exactly as it was before. Nothing to clean up.`
			);
		}
		replaced = true;
		stopIfInterrupted();

		// ── confirm ───────────────────────────────────────────────
		const after = await db.query<{ chain_id: string; last_applied_block: string }>(
			'SELECT chain_id, last_applied_block::text FROM indexer_state LIMIT 1'
		);
		if (after.rows.length === 0)
			die(
				'post-restore indexer_state is empty — restore did not take. Do not start the indexer on this database: run fast-sync again.',
				EXIT_REPLACED_UNUSABLE
			);
		const gotBlock = parseInt(after.rows[0]!.last_applied_block, 10);
		const gotChain = after.rows[0]!.chain_id;
		if (gotChain !== manifest.chainId)
			die(
				`post-restore chain_id '${gotChain}' != manifest '${manifest.chainId}'. Do not start the indexer on this database.`,
				EXIT_REPLACED_UNUSABLE
			);

		process.stderr.write(
			`\n✓ restored to block ${gotBlock.toLocaleString()} (chain ${gotChain}).\n`
		);

		// ── foreign code, then local-only state (rv2-1c / rv2-5) ──
		// FIRST, before this script writes a single row: a snapshot is data, and
		// any function, trigger or rule it created would fire on the writes
		// below (the posting-key reset updates every account) — its effects,
		// a relay payout row say, would outlive the cleanup. The sanitizer
		// already refuses a dump that defines code; this drops anything that got
		// in some other way. Then the publisher's own state goes: an older
		// snapshot still holds its push subscriptions, its relay payout queue
		// and similar (see snapshotLocalState.ts) — this node's relay would
		// otherwise act on them.
		try {
			const schemaSql = readFileSync(
				join(REPO_ROOT, 'apps', 'indexer', 'src', 'db', 'schema.sql'),
				'utf8'
			);
			const dropped = await dropRoutinesNotInSchema(db, schemaSql);
			if (dropped.length > 0) {
				process.stderr.write(
					`  removed ${dropped.length} object(s) the snapshot added that Morphit does not define:\n`
				);
				for (const d of dropped.slice(0, 20)) process.stderr.write(`      ${d}\n`);
			}
			const scrubbed = await scrubRestoredLocalState(db);
			if (scrubbed > 0) {
				process.stderr.write(
					`  publisher-local rows left out or reset (push queues, probe opinions): ${scrubbed.toLocaleString()}.\n`
				);
			}
		} catch (err) {
			die(
				`could not tidy the restored database: ${err instanceof Error ? err.message : String(err)}. ` +
					`Do not start the indexer on this database until this succeeds — re-run the restore.`,
				EXIT_REPLACED_UNUSABLE
			);
		}

		// ── posting keys: this node confirms them itself (v1.18.0, D4) ──
		// A restored row marked confirmed would be trusted by the chat fast path
		// with no chain read, on the publisher's word alone — and the op-log check
		// below does not cover posting keys. Withdraw every confirmation; the
		// indexer's own reconcile asks the chain for each on its next start.
		try {
			const withdrawn = await distrustRestoredPostingKeys(db);
			if (withdrawn > 0) {
				process.stderr.write(
					`  posting keys: ${withdrawn.toLocaleString()} will be re-confirmed against the chain ` +
						`when the indexer starts.\n`
				);
			}
		} catch (err) {
			die(
				`could not reset posting-key confirmations after restore: ` +
					`${err instanceof Error ? err.message : String(err)}. Do not start the indexer on ` +
					`this database until this succeeds — re-run the restore.`,
				EXIT_REPLACED_UNUSABLE
			);
		}
		stopIfInterrupted();

		// ── Tier-2 hardening: op-log spot-check (from-chain only) ──
		// Prove the restored `ops` log matches the chain before we recommend
		// serving. Quarantine on any mismatch. --skip-verify opts out (e.g. a
		// tor-only box that can't cheaply fetch cleartext blocks yet).
		if (fromChain && !has('skip-verify')) {
			process.stderr.write(`\nsnapshot: Tier-2 op-log spot-check against the chain…\n`);
			const samples = flag('verify-samples') ?? '40';
			// this spawned plain `node` on a .ts file
			// with no path aliases, which died with ERR_MODULE_NOT_FOUND ('$config')
			// and exit 1 — read as QUARANTINE, after a restore that was fine. Run it
			// the way fast-sync runs this script: the repo's tsx with the tsconfig.
			// And only its QUARANTINE code (3) means quarantine; a crash is
			// inconclusive, never a verdict.
			const verify = await runChild(
				join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
				[
					'--tsconfig',
					join(REPO_ROOT, 'tsconfig.smoke.json'),
					join(REPO_ROOT, 'apps', 'indexer', 'scripts', 'snapshot-verify-oplog.ts'),
					'--samples',
					samples,
					'--up-to',
					String(gotBlock)
				],
				{ cwd: REPO_ROOT }
			);
			if (verify.signal === 'SIGINT' || verify.status === 130) interruptedAfterRestore = true;
			stopIfInterrupted();
			if (verify.status === 3) {
				die(
					'op-log spot-check QUARANTINED this snapshot (it does not match the chain). ' +
						'Do not start the indexer on this database: run fast-sync again, and if this snapshot is ' +
						'quarantined again, wait for the next one (published daily).',
					EXIT_REPLACED_UNUSABLE
				);
			}
			if (verify.status !== 0 && verify.status !== 3) {
				process.stderr.write(
					`  note: op-log spot-check was INCONCLUSIVE (chain unreachable, or nothing to sample). The snapshot is\n` +
						`  restored but NOT yet chain-verified — re-run snapshot-verify-oplog.ts when the\n` +
						`  pool is reachable, or proceed knowing the tail catch-up will still verify recent ops.\n`
				);
			}
		}

		stopIfInterrupted();
		// The caller (morphit-ops fast-sync, the install wizard) starts the
		// indexer itself: don't tell the operator to as well.
		if (process.env.MORPHIT_SNAPSHOT_CALLER_STARTS_INDEXER !== '1') {
			process.stderr.write(
				`  Start the indexer; it will catch up + re-verify the gap to head over its configured pool.\n` +
					`      sudo systemctl start morphit-indexer\n`
			);
		}
		clearRestoreMarker();
		console.log(String(gotBlock));
	} finally {
		rmSync(work, { recursive: true, force: true });
		await db.close();
	}
}

// Exit as soon as the work is done: quorum
// reads abandon the slower RPC calls once two operators agree, and an abandoned
// call keeps retrying in the background until its own timeout (a minute over
// Tor/I2P), which would otherwise hold the process open for nothing.
main().then(
	() => process.exit(0),
	(err) => {
		if (err instanceof Stop) {
			console.error(`snapshot-bootstrap: ${err.message}`);
			process.exit(err.code);
		}
		console.error('snapshot-bootstrap failed:', err instanceof Error ? err.message : err);
		// After the restore committed, the database is not what it was.
		process.exit(replaced ? EXIT_REPLACED_UNUSABLE : EXIT_UNCHANGED);
	}
);
