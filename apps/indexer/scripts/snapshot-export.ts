#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/snapshot-export.ts  (cp764)
 *
 * Export a portable snapshot of THIS indexer's Postgres DB, so an operator can
 * bootstrap a fresh instance in minutes instead of replaying ~3.5M blocks over
 * hidden RPC (see snapshotManifest.ts for the why + the trust model).
 *
 * Produces  morphit-indexer-snapshot-<block>-<date>.tar.gz  containing:
 *   - indexer.sql.gz   (pg_dump --clean --if-exists, gzipped)
 *   - manifest.json    (chain id, schema version, last block, pg major — the
 *                       facts the bootstrap uses to REFUSE an incompatible restore)
 *
 * Run on the SYNCED source box (env sourced from its indexer.env), repo root:
 *   set -a; . /etc/morphit/indexer.env; set +a
 *   node_modules/.bin/tsx --tsconfig tsconfig.smoke.json \
 *     apps/indexer/scripts/snapshot-export.ts --out ~/snapshots
 *
 * NOTE: uses the indexer's DATABASE_URL with a host pg_dump. For a Dockerized
 * Postgres reachable only in-container, dump it your usual way and drop the
 * result in as indexer.sql.gz next to a manifest.json — the format is stable.
 */
import { spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	renameSync,
	readFileSync,
	copyFileSync,
	unlinkSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/index.ts';
import { createDatabase } from '../src/db/pool.ts';
import { buildManifest, MANIFEST_FILENAME, DUMP_FILENAME } from '../src/db/snapshotManifest.ts';
import { INDEXER_VERSION } from '../src/api/health.ts';
import { exportExclusionArgs } from '../src/db/snapshotLocalState.ts';

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
	const config = loadConfig();
	const db = createDatabase(config);
	const outDir = flag('out') ?? process.cwd();

	try {
		// Source facts, read live from the DB being dumped.
		const st = await db.query<{ chain_id: string; last_applied_block: string }>(
			'SELECT chain_id, last_applied_block::text FROM indexer_state LIMIT 1'
		);
		if (st.rows.length === 0) throw new Error('indexer_state is empty — is this a synced indexer DB?');
		const chainId = st.rows[0]!.chain_id;
		const lastAppliedBlock = parseInt(st.rows[0]!.last_applied_block, 10);

		const sv = await db.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
		const schemaVersion = sv.rows[0]?.v ?? 0;

		const pv = await db.query<{ n: string }>("SELECT current_setting('server_version_num') AS n");
		const pgMajor = Math.floor(parseInt(pv.rows[0]!.n, 10) / 10000);

		if (chainId !== config.chainId) {
			process.stderr.write(
				`warning: DB chain_id '${chainId}' != configured '${config.chainId}' — exporting the DB's value.\n`
			);
		}

		// Stage in a temp dir, then atomically move the finished tarball into place.
		const work = mkdtempSync(join(tmpdir(), 'morphit-snap-'));
		try {
			process.stderr.write(`snapshot: pg_dump (--clean --if-exists) → ${DUMP_FILENAME} …\n`);
			// v1.18.0 deep-deep (rv2-5, rv2-8). This dumped the WHOLE database,
			// and the relay shares it: every push subscription (device endpoint
			// token, keys, user agent) and the push queue went out on public
			// IPFS, as did this box's relay payout queue. Only chain-derived rows
			// leave now (snapshotLocalState.ts lists what stays home), and
			// `operator_blocks` goes without this operator's own local blocks.
			// --no-owner --no-privileges: a snapshot must restore under any role
			// name, not only the one this box happens to use.
			const obCols = await db.query<{ column_name: string }>(
				`SELECT column_name FROM information_schema.columns
				  WHERE table_schema = 'public' AND table_name = 'operator_blocks'
				  ORDER BY ordinal_position`
			);
			// Plain identifiers only — they go into a shell command line below.
			for (const r of obCols.rows) {
				if (!/^[a-z_][a-z0-9_]*$/.test(r.column_name)) {
					throw new Error(`unexpected operator_blocks column name: ${r.column_name}`);
				}
			}
			const cols = obCols.rows.map((r) => r.column_name).join(', ');
			const hasOrigin = obCols.rows.some((r) => r.column_name === 'origin');
			const chainRows =
				obCols.rows.length === 0
					? ''
					: `printf '%s\\n' "COPY public.operator_blocks (${cols}) FROM stdin;"; ` +
						`psql -X -q -v ON_ERROR_STOP=1 "$DBURL" -c "\\copy (SELECT ${cols} FROM public.operator_blocks` +
						`${hasOrigin ? " WHERE origin <> 'local'" : ''}) TO STDOUT"; printf '%s\\n' '\\.'; `;
			const dump = spawnSync(
				'bash',
				[
					'-c',
					`set -o pipefail; { pg_dump --clean --if-exists --no-owner --no-privileges ` +
						`${exportExclusionArgs().join(' ')} "$DBURL"; ${chainRows}} | gzip -c > "${join(work, DUMP_FILENAME)}"`
				],
				{ env: { ...process.env, DBURL: config.databaseUrl }, stdio: ['ignore', 'inherit', 'inherit'] }
			);
			if (dump.status !== 0) throw new Error(`pg_dump failed (exit ${dump.status ?? 'signal'})`);

			// Hash the finished dump: the manifest becomes self-describing, and the
			// importer can later prove file == manifest == on-chain sha256 (all three)
			// before trusting a federated snapshot.
			const dumpSha256 = createHash('sha256')
				.update(readFileSync(join(work, DUMP_FILENAME)))
				.digest('hex');

			// Build the manifest AFTER the dump exists (v2 embeds the dump's sha256).
			const manifest = buildManifest({
				chainId,
				schemaVersion,
				lastAppliedBlock,
				pgMajor,
				sourceLabel: config.publicOrigin ?? 'unknown',
				indexerVersion: INDEXER_VERSION,
				dumpSha256
			});
			writeFileSync(join(work, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2) + '\n');

			mkdirSync(outDir, { recursive: true });
			const short = String(lastAppliedBlock);
			const date = manifest.createdAt.slice(0, 10);
			const finalName = `morphit-indexer-snapshot-${short}-${date}.tar.gz`;
			const tmpTar = join(work, finalName);
			const tar = spawnSync('tar', ['-czf', tmpTar, '-C', work, MANIFEST_FILENAME, DUMP_FILENAME], {
				stdio: ['ignore', 'inherit', 'inherit']
			});
			if (tar.status !== 0) throw new Error(`tar failed (exit ${tar.status ?? 'signal'})`);

			const finalPath = join(outDir, finalName);
			// rename() cannot cross filesystems. Under systemd this job runs with
			// PrivateTmp=true, which mounts a private tmpfs at /tmp — a DIFFERENT
			// device from /opt/morphit — so the move fails with EXDEV even though the
			// identical command works in an interactive shell, where /tmp is just part
			// of the root filesystem. That is why the publish timer failed on a box
			// where a hand-run publish had always succeeded. Fall back to copy+unlink,
			// which works across devices and leaves the same result.
			try {
				renameSync(tmpTar, finalPath);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
				copyFileSync(tmpTar, finalPath);
				unlinkSync(tmpTar);
			}
			process.stderr.write(
				`\n✓ snapshot written: ${finalPath}\n` +
					`  chain ${chainId} · schema v${schemaVersion} · block ${lastAppliedBlock.toLocaleString()} · pg ${pgMajor}\n` +
					`  bootstrap a fresh box:  tsx apps/indexer/scripts/snapshot-bootstrap.ts ${finalName} --i-trust-this-source\n`
			);
			// Machine-readable last line.
			console.log(finalPath);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	} finally {
		await db.close();
	}
}

main().catch((err) => {
	console.error('snapshot-export failed:', err instanceof Error ? err.message : err);
	process.exit(1);
});
