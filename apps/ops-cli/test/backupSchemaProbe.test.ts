/**
 * The backup's "is the schema migrated yet?" check never writes an error line.
 *
 * 2026-10-12, a fresh VPS: every backup logged
 *   morphit-backup.sh: 341: printf: printf: I/O error
 * `grep -q` stops reading at the first "CREATE TABLE" and closes the pipe; the
 * printf feeding it a large schema then writes into a closed pipe. systemd runs
 * services with SIGPIPE ignored, so printf is not killed but fails and says so.
 * The real script runs here the same way (SIGPIPE ignored), against a stand-in
 * pg_dump that prints a real-sized schema.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../../../ops/backup/morphit-backup.sh', import.meta.url).pathname;

describe('the backup on a migrated database', () => {
	it('writes the dump without any I/O error line', () => {
		const dir = mkdtempSync(join(tmpdir(), 'morphit-backup-probe-'));
		const bin = join(dir, 'bin');
		const out = join(dir, 'backups');
		mkdirSync(bin);
		// A schema far larger than a pipe buffer, with a table near the top.
		writeFileSync(
			join(bin, 'pg_dump'),
			'#!/bin/sh\nprintf "CREATE TABLE ops (id int);\\n"\ni=0; while [ $i -lt 20000 ]; do echo "-- column comment line $i padding padding padding"; i=$((i+1)); done\n'
		);
		chmodSync(join(bin, 'pg_dump'), 0o755);
		const env = join(dir, 'backup.env');
		writeFileSync(env, `BACKUP_DIR=${out}\nDB_NAME=morphit_indexer\nDB_USER=morphit_indexer\n`);
		const r = spawnSync('sh', ['-c', `trap '' PIPE; exec sh '${SCRIPT}'`], {
			encoding: 'utf8',
			env: { PATH: `${bin}:/usr/bin:/bin`, BACKUP_ENV: env, HOME: dir }
		});
		expect(r.stderr).not.toMatch(/I\/O error|Broken pipe/i);
		expect(r.status).toBe(0);
		expect(readdirSync(out).some((f) => /^morphit-\d{8}-\d{6}\.sql\.gz$/.test(f))).toBe(true);
	});
});
