/**
 * A write that takes only part of a chunk (writeSync may return fewer bytes
 * than asked) is written on until the chunk is all on disk: the dump's sha256
 * is computed from what was handed over, so a skipped tail would make a file
 * that is not what the hash says (review, 2026-10-12).
 */
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

vi.mock('node:fs', async (orig) => {
	const fs = (await orig()) as typeof import('node:fs');
	// At most 7 bytes per call.
	const writeSync = ((fd: number, buf: Buffer, off?: number, len?: number) => {
		const from = off ?? 0;
		return fs.writeSync(fd, buf, from, Math.min(len ?? buf.length - from, 7));
	}) as typeof fs.writeSync;
	const out = { ...fs, writeSync };
	return { ...out, default: out };
});

const { extractSnapshotArchive } = await import('$blurt/snapshotArchive');

describe('short writes', () => {
	it('every byte reaches the file, and the hash is of what is on disk', async () => {
		const src = mkdtempSync(join(tmpdir(), 'snap-short-'));
		try {
			const dump = gzipSync(randomBytes(50_000));
			writeFileSync(join(src, 'manifest.json'), '{"v":2}\n');
			writeFileSync(join(src, 'indexer.sql.gz'), dump);
			const tar = join(src, 'snap.tar.gz');
			spawnSync('tar', ['-czf', tar, '-C', src, 'manifest.json', 'indexer.sql.gz']);
			const work = mkdtempSync(join(src, 'w-'));
			const r = await extractSnapshotArchive(tar, work, { maxDumpBytes: 1e6 });
			const sha = createHash('sha256').update(dump).digest('hex');
			expect(r).toEqual({ ok: true, dumpSha256: sha, dumpBytes: dump.length });
			expect(readFileSync(join(work, 'indexer.sql.gz')).equals(dump)).toBe(true);
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
	});
});
