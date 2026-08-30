#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/snapshot-bootstrap.ts  (cp764)
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
import { join } from 'node:path';
import { loadConfig } from '../src/config/index.ts';
import { createDatabase } from '../src/db/pool.ts';
import { latestSchemaVersion } from '../src/db/migrations.ts';
import { BlurtClient } from '../src/blurt/client.ts';
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
	selectNewestSnapshotOp,
	INDEXER_SNAPSHOT_SIGNER_DEFAULT,
	type IndexerSnapshotPayload,
	type SelectedSnapshotOp
} from '../src/blurt/indexerSnapshotOp.ts';

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
	if (env && env.trim()) return env.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
	return ['http://127.0.0.1:8080', 'https://ipfs.io', 'https://dweb.link', 'https://cloudflare-ipfs.com'];
}

const sha256File = (path: string): string =>
	createHash('sha256').update(readFileSync(path)).digest('hex');

/** Download `url` → `dest` (resumable), returning true on success. Never throws. */
function download(url: string, dest: string): boolean {
	const r = spawnSync('curl', ['-fSL', '--connect-timeout', '20', '-C', '-', '-o', dest, url], {
		stdio: ['ignore', 'inherit', 'inherit']
	});
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
	const trusted = new Set([signer]);
	const limit = Math.max(1, Math.min(10_000, parseInt(flag('history-limit') ?? '1000', 10) || 1000));

	process.stderr.write(`\nsnapshot: reading @${signer}'s chain history for the newest indexer_snapshot_v1 …\n`);
	const blurt = new BlurtClient(config);
	let history: unknown;
	try {
		history = await blurt.callCondenser('get_account_history', [signer, -1, limit]);
	} catch (e) {
		die(`could not read @${signer}'s account history from any RPC: ${e instanceof Error ? e.message : String(e)}`);
	}
	const sel = selectNewestSnapshotOp(history, trusted);
	if (!sel) {
		die(
			`no valid indexer_snapshot_v1 op signed by a trusted signer (@${signer}) in the last ${limit} history entries. ` +
				`Either none has been published yet, or raise --history-limit. Full replay is always available: set ` +
				`MORPHIT_INDEXER_START_BLOCK to genesis and start the indexer.`
		);
	}
	const op: IndexerSnapshotPayload = sel.payload;
	process.stderr.write(
		`  found: block ${op.last_applied_block.toLocaleString()} · schema v${op.schema_version} · ` +
			`indexer v${op.indexer_version} · signer @${sel.signer} · seq ${sel.seq}\n`
	);

	// Early chain gate — refuse before spending bandwidth on another chain's state.
	if (op.chain_id !== config.chainId) {
		die(`snapshot op is for chain '${op.chain_id}', this node indexes '${config.chainId}'. Refusing.`);
	}

	// Sources: the signed https mirror first (fast, reliable for a big file), then
	// the CID via public IPFS gateways. Every source is proven against op.sha256,
	// so trust does not depend on WHICH source answered.
	const sources: string[] = [];
	if (op.forgejo_url) sources.push(op.forgejo_url);
	for (const g of ipfsGateways()) sources.push(`${g}/ipfs/${op.ipfs_cid}`);

	const tarPath = join(work, 'snapshot.tar.gz');
	const manifestPath = join(work, MANIFEST_FILENAME);
	const dumpPath = join(work, DUMP_FILENAME);
	for (const url of sources) {
		process.stderr.write(`\nsnapshot: fetching ${url} …\n`);
		rmSync(tarPath, { force: true });
		rmSync(manifestPath, { force: true });
		rmSync(dumpPath, { force: true });
		if (!download(url, tarPath)) {
			process.stderr.write('  ✗ download failed — trying the next source.\n');
			continue;
		}
		const untar = spawnSync('tar', ['-xzf', tarPath, '-C', work], { stdio: ['ignore', 'inherit', 'inherit'] });
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
		process.stderr.write('  ✓ downloaded + sha256 matches the on-chain op.\n');
		return sel;
	}
	die('every source failed to yield a snapshot matching the on-chain sha256. Try again later, set --gateway, or do a full replay.');
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

	const config = loadConfig();
	const db = createDatabase(config);
	const work = mkdtempSync(join(tmpdir(), 'morphit-snap-restore-'));

	try {
		// ── acquire: from chain (download+verify) or from a local tarball ──
		let chainOp: SelectedSnapshotOp | null = null;
		if (fromChain) {
			chainOp = await acquireFromChain(config, work);
		} else {
			const untar = spawnSync('tar', ['-xzf', snapshotPath!, '-C', work], { stdio: ['ignore', 'inherit', 'inherit'] });
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
			if (manifest.chainId !== op.chain_id) mism.push(`chain_id (manifest ${manifest.chainId} ≠ op ${op.chain_id})`);
			if (manifest.schemaVersion !== op.schema_version) mism.push(`schema_version (manifest ${manifest.schemaVersion} ≠ op ${op.schema_version})`);
			if (manifest.lastAppliedBlock !== op.last_applied_block) mism.push(`last_applied_block (manifest ${manifest.lastAppliedBlock} ≠ op ${op.last_applied_block})`);
			if (mism.length > 0) {
				for (const m of mism) process.stderr.write(`  ✗ signed op disagrees with the manifest: ${m}\n`);
				die('the tarball was altered relative to the on-chain op — refusing.');
			}
		}

		// ── gate 2: compatible with THIS build/host ───────────────
		const pv = await db.query<{ n: string }>("SELECT current_setting('server_version_num') AS n");
		const target: TargetFacts = {
			chainId: config.chainId,
			codeSchemaVersion: latestSchemaVersion(),
			pgMajor: Math.floor(parseInt(pv.rows[0]!.n, 10) / 10000)
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

		// ── gate 4: don't clobber a DB that already has real data ─
		const st = await db
			.query<{ last_applied_block: string }>('SELECT last_applied_block::text FROM indexer_state LIMIT 1')
			.catch(() => ({ rows: [] as Array<{ last_applied_block: string }> }));
		const existing = st.rows.length > 0 ? parseInt(st.rows[0]!.last_applied_block, 10) : -1;
		if (existing > config.startBlock && !has('force')) {
			die(
				`this node already has an indexer DB at block ${existing.toLocaleString()} (> start ${config.startBlock.toLocaleString()}). ` +
					`Restoring would DISCARD it. Re-run with --force if that is intended (stop morphit-indexer first).`
			);
		}

		// ── restore ───────────────────────────────────────────────
		process.stderr.write(`\nsnapshot: restoring into the indexer DB (this replaces existing objects)…\n`);
		const restore = spawnSync(
			'bash',
			['-c', `set -o pipefail; gunzip -c "${dumpPath}" | psql -v ON_ERROR_STOP=1 "$DBURL" >/dev/null`],
			{ env: { ...process.env, DBURL: config.databaseUrl }, stdio: ['ignore', 'inherit', 'inherit'] }
		);
		if (restore.status !== 0) die(`restore failed (psql exit ${restore.status ?? 'signal'}). The DB may be partially restored — investigate before starting the indexer.`);

		// ── confirm ───────────────────────────────────────────────
		const after = await db.query<{ chain_id: string; last_applied_block: string }>(
			'SELECT chain_id, last_applied_block::text FROM indexer_state LIMIT 1'
		);
		if (after.rows.length === 0) die('post-restore indexer_state is empty — restore did not take.');
		const gotBlock = parseInt(after.rows[0]!.last_applied_block, 10);
		const gotChain = after.rows[0]!.chain_id;
		if (gotChain !== manifest.chainId) die(`post-restore chain_id '${gotChain}' != manifest '${manifest.chainId}'.`);

		process.stderr.write(
			`\n✓ restored to block ${gotBlock.toLocaleString()} (chain ${gotChain}).\n`
		);

		// ── Tier-2 hardening: op-log spot-check (from-chain only) ──
		// Prove the restored `ops` log matches the chain before we recommend
		// serving. Quarantine on any mismatch. --skip-verify opts out (e.g. a
		// tor-only box that can't cheaply fetch cleartext blocks yet).
		if (fromChain && !has('skip-verify')) {
			process.stderr.write(`\nsnapshot: Tier-2 op-log spot-check against the chain…\n`);
			const samples = flag('verify-samples') ?? '40';
			const verify = spawnSync(
				process.execPath,
				[
					process.argv[1]!.replace(/snapshot-bootstrap\.ts$/, 'snapshot-verify-oplog.ts'),
					'--samples',
					samples,
					'--up-to',
					String(gotBlock)
				],
				{ stdio: ['ignore', 'inherit', 'inherit'] }
			);
			if (verify.status === 1) {
				die(
					'op-log spot-check QUARANTINED this snapshot (it does not match the chain). ' +
						'Wipe the DB and full-replay (MORPHIT_INDEXER_START_BLOCK=genesis).'
				);
			}
			if (verify.status === 2) {
				process.stderr.write(
					`  note: op-log spot-check was INCONCLUSIVE (chain unreachable). The snapshot is\n` +
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

main().catch((err) => {
	console.error('snapshot-bootstrap failed:', err instanceof Error ? err.message : err);
	process.exit(1);
});
