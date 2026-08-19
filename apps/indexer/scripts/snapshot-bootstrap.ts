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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/index.ts';
import { createDatabase } from '../src/db/pool.ts';
import { latestSchemaVersion } from '../src/db/migrations.ts';
import {
	parseManifest,
	verifyManifestCompatible,
	MANIFEST_FILENAME,
	DUMP_FILENAME,
	type TargetFacts
} from '../src/db/snapshotManifest.ts';

const has = (name: string): boolean => process.argv.includes(`--${name}`);

function die(msg: string): never {
	console.error(`snapshot-bootstrap: ${msg}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const snapshotPath = process.argv[2];
	if (!snapshotPath || snapshotPath.startsWith('--') || !existsSync(snapshotPath)) {
		die('usage: snapshot-bootstrap.ts <snapshot.tar.gz> --i-trust-this-source [--force]');
	}

	const config = loadConfig();
	const db = createDatabase(config);
	const work = mkdtempSync(join(tmpdir(), 'morphit-snap-restore-'));

	try {
		// ── unpack ────────────────────────────────────────────────
		const untar = spawnSync('tar', ['-xzf', snapshotPath, '-C', work], { stdio: ['ignore', 'inherit', 'inherit'] });
		if (untar.status !== 0) die('could not extract the snapshot archive.');
		const manifestPath = join(work, MANIFEST_FILENAME);
		const dumpPath = join(work, DUMP_FILENAME);
		if (!existsSync(manifestPath) || !existsSync(dumpPath)) {
			die(`archive is missing ${MANIFEST_FILENAME} or ${DUMP_FILENAME}.`);
		}

		// ── gate 1: manifest parses + is compatible ───────────────
		const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
		if (!manifest) die('manifest.json is malformed — refusing.');

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

		// ── gate 2: explicit trust acknowledgement ────────────────
		if (!has('i-trust-this-source')) {
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

		// ── gate 3: don't clobber a DB that already has real data ─
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
			`\n✓ restored to block ${gotBlock.toLocaleString()} (chain ${gotChain}).\n` +
				`  Start the indexer; it will catch up the gap to head over its configured pool.\n` +
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
