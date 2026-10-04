/**
 * `npm run migrate:rebuild` (`--rebuild-materialized`) no longer reports a
 * rebuild that did not happen: the real CLI, against a real database.
 *
 * The mode was a placeholder — `SELECT 1` — that logged rebuild_started and
 * rebuild_complete and exited 0, so an operator following a runbook believed
 * the derived tables had been rebuilt.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { INTEGRATION_ENABLED, TEST_DATABASE_URL } from './harness';

const ROOT = join(import.meta.dirname, '..', '..');

describe.skipIf(!INTEGRATION_ENABLED)('migrate --rebuild-materialized', () => {
	it('refuses: non-zero exit, and never claims a rebuild', () => {
		const r = spawnSync(
			process.execPath,
			['--import', 'tsx', join(ROOT, 'src/db/migrations.ts'), '--rebuild-materialized'],
			{
				cwd: ROOT,
				encoding: 'utf8',
				timeout: 60_000,
				env: {
					...process.env,
					MORPHIT_LOG_FORMAT: 'json',
					MORPHIT_INDEXER_DATABASE_URL: TEST_DATABASE_URL!,
					MORPHIT_INDEXER_RELAY_ACCOUNT: 'tester',
					MORPHIT_INDEXER_FEE_RECIPIENT: 'tester',
					MORPHIT_INDEXER_CHAIN_ID:
						'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
					MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example',
					MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
						'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9'
				}
			}
		);
		const out = `${r.stdout}\n${r.stderr}`;
		expect(out).not.toContain('rebuild_complete');
		expect(r.status, out.slice(0, 400)).not.toBe(0);
	}, 90_000);
});
