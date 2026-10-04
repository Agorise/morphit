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
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
	extractPeerAddressesFromHistory,
	hasUsableSource,
	type SnapshotSource
} from '../src/blurt/snapshotMirrors.ts';

const has = (name: string): boolean => process.argv.includes(`--${name}`);
function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function die(msg: string): never {
	console.error(`snapshot-bootstrap: ${msg}`);
	process.exit(1);
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
	// cloudflare-ipfs.com is not listed: Cloudflare retired its public
	// gateway, so it only ever added a failed request (and a third party).
	return ['http://127.0.0.1:8080', 'https://ipfs.io', 'https://dweb.link'];
}

const sha256File = (path: string): string =>
	createHash('sha256').update(readFileSync(path)).digest('hex');

/** This box's own kubo gateway, when it runs one. Read from kubo rather than
 *  assumed, and null when kubo is absent (a fresh node usually has none yet). */
function localKuboGateway(): string | null {
	const env = process.env.MORPHIT_LOCAL_IPFS_GATEWAY;
	if (env && env.trim() !== '') return env.trim();
	const r = spawnSync('ipfs', ['config', 'Addresses.Gateway'], { encoding: 'utf8', timeout: 8000 });
	if (r.status !== 0 || typeof r.stdout !== 'string') return null;
	const m = /\/ip4\/([0-9.]+)\/tcp\/(\d{1,5})/.exec(r.stdout);
	if (!m) return null;
	// A gateway bound to 0.0.0.0 is still reached over loopback from here.
	const host = m[1] === '0.0.0.0' ? '127.0.0.1' : m[1];
	return `http://${host}:${m[2]}`;
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
function download(url: string, dest: string, source?: SnapshotSource): boolean {
	const transport = source?.transport ?? 'clearnet';
	const args = ['-fSL', '--connect-timeout', '20', '-C', '-', '-o', dest];
	if (transport === 'tor') {
		args.push('--socks5-hostname', TOR_SOCKS, '--max-time', '600');
	} else if (transport === 'i2p') {
		args.push('-x', I2P_HTTP_PROXY, '--max-time', '900');
	} else {
		args.push('--max-time', '600');
	}
	args.push(url);
	const r = spawnSync('curl', args, { stdio: ['ignore', 'inherit', 'inherit'] });
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
	const peers = extractPeerAddressesFromHistory(history);
	const hiddenOnly = config.blurtRpcEndpoints.length === 0;
	const built = buildSnapshotSources({
		cid: op.ipfs_cid,
		forgejoUrl: op.forgejo_url ?? null,
		peers,
		publicGateways: ipfsGateways(),
		localGateway: localKuboGateway(),
		hiddenOnly
	});
	if (!hasUsableSource(built)) {
		die(
			hiddenOnly
				? 'this node is hidden-only and no federation peer advertises a Tor/I2P address on-chain yet, ' +
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
	const manifestPath = join(work, MANIFEST_FILENAME);
	const dumpPath = join(work, DUMP_FILENAME);
	for (const url of sources) {
		const src = sourceByUrl.get(url);
		process.stderr.write(`\nsnapshot: fetching from ${src?.label ?? url} …\n`);
		rmSync(tarPath, { force: true });
		rmSync(manifestPath, { force: true });
		rmSync(dumpPath, { force: true });
		if (!download(url, tarPath, src)) {
			process.stderr.write('  ✗ download failed — trying the next source.\n');
			continue;
		}
		const untar = spawnSync('tar', ['-xzf', tarPath, '-C', work], {
			stdio: ['ignore', 'inherit', 'inherit']
		});
		if (untar.status !== 0 || !existsSync(manifestPath) || !existsSync(dumpPath)) {
			process.stderr.write('  ✗ archive did not unpack cleanly — trying the next source.\n');
			continue;
		}
		const innerSha = sha256File(dumpPath);
		if (innerSha !== op.sha256) {
			process.stderr.write(
				`  ✗ sha256 MISMATCH: got ${innerSha}, on-chain op says ${op.sha256}. Discarding this source.\n`
			);
			continue;
		}
		process.stderr.write('  ✓ downloaded + sha256 matches the signed on-chain op.\n');
		return sel;
	}
	die(
		'every source failed to yield a snapshot matching the on-chain sha256. Try again later, set --gateway, or do a full replay.'
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

function psqlReadiness(dbUrl: string): PsqlReadiness {
	const connect = spawnSync(
		'psql',
		['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1', dbUrl],
		{
			stdio: ['ignore', 'ignore', 'pipe'],
			encoding: 'utf8',
			timeout: 30_000
		}
	);
	if ((connect.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')
		return { ok: false, why: 'missing' };
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
	const probe = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', dbUrl], {
		input: '\\restrict k0\n\\unrestrict k0\n',
		stdio: ['pipe', 'ignore', 'ignore'],
		timeout: 30_000
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
	const work = mkdtempSync(join(tmpdir(), 'morphit-snap-restore-'));

	try {
		// ── acquire: from chain (download+verify) or from a local tarball ──
		let chainOp: SelectedSnapshotOp | null = null;
		if (fromChain) {
			chainOp = await acquireFromChain(config, work);
		} else {
			const untar = spawnSync('tar', ['-xzf', snapshotPath!, '-C', work], {
				stdio: ['ignore', 'inherit', 'inherit']
			});
			if (untar.status !== 0) die('could not extract the snapshot archive.');
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
		const psql = psqlReadiness(config.databaseUrl);
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
		const restore = spawnSync(
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
			{ stdio: ['ignore', 'ignore', 'inherit'] }
		);
		if (restore.status !== 0) {
			die(
				`restore failed (psql exit ${restore.status ?? 'signal'}). It ran as one transaction, so the ` +
					`database is exactly as it was before. Nothing to clean up.`
			);
		}

		// ── confirm ───────────────────────────────────────────────
		const after = await db.query<{ chain_id: string; last_applied_block: string }>(
			'SELECT chain_id, last_applied_block::text FROM indexer_state LIMIT 1'
		);
		if (after.rows.length === 0) die('post-restore indexer_state is empty — restore did not take.');
		const gotBlock = parseInt(after.rows[0]!.last_applied_block, 10);
		const gotChain = after.rows[0]!.chain_id;
		if (gotChain !== manifest.chainId)
			die(`post-restore chain_id '${gotChain}' != manifest '${manifest.chainId}'.`);

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
					`Do not start the indexer on this database until this succeeds — re-run the restore.`
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
					`this database until this succeeds — re-run the restore.`
			);
		}

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
			const verify = spawnSync(
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
				{ cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'] }
			);
			if (verify.status === 3) {
				die(
					'op-log spot-check QUARANTINED this snapshot (it does not match the chain). ' +
						'Wipe the DB and full-replay (MORPHIT_INDEXER_START_BLOCK=genesis).'
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

		process.stderr.write(
			`  Start the indexer; it will catch up + re-verify the gap to head over its configured pool.\n` +
				`      sudo systemctl start morphit-indexer\n`
		);
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
		console.error('snapshot-bootstrap failed:', err instanceof Error ? err.message : err);
		process.exit(1);
	}
);
