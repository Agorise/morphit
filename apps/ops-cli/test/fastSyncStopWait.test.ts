/**
 * fast-sync waits for the indexer to stop before it touches the database.
 * Review 2026-10-08: the state was read from systemctl's stdout and stderr
 * together, so any line on stderr made it "unknown", which the wait took as
 * "stopped" and went ahead with the indexer still running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stopIndexerAndWait } from '../src/commands/fastSync.ts';

let dir = '';
const PATH = process.env.PATH;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'fastsync-stop-'));
	writeFileSync(join(dir, 'n'), '0');
	// is-active says "active" (with a warning on stderr) twice, then "inactive".
	writeFileSync(
		join(dir, 'systemctl'),
		[
			'#!/bin/sh',
			'if [ "$1" = is-active ]; then',
			`  n=$(cat '${join(dir, 'n')}'); n=$((n+1)); echo $n > '${join(dir, 'n')}'`,
			'  echo "Warning: The unit file changed on disk." >&2',
			'  if [ $n -le 2 ]; then echo active; exit 0; fi',
			'  echo inactive; exit 3',
			'fi',
			'exit 0',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${dir}:${PATH}`;
	vi.spyOn(process as unknown as { getuid: () => number }, 'getuid').mockReturnValue(0);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
	process.env.PATH = PATH;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe('waiting for the indexer to stop', () => {
	it('a warning on stderr does not count as "stopped"', async () => {
		expect(await stopIndexerAndWait()).toBe(true);
		expect(
			Number(readFileSync(join(dir, 'n'), 'utf8')),
			'stopped waiting while it was active'
		).toBe(3);
	}, 30_000);
});
