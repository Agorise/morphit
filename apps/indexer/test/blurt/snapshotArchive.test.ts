/**
 * A downloaded snapshot is unpacked by our own reader, never by `tar -xzf` as
 * root, and accepted only when it is exactly what the signed record describes
 * (v1.21.7, review 2026-10-12). Real archives, made with the system's tar.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { acceptSnapshotDownload, extractSnapshotArchive } from '$blurt/snapshotArchive';

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function dir(): string {
	const d = mkdtempSync(join(tmpdir(), 'snap-archive-'));
	roots.push(d);
	return d;
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** tar -czf of the entries already in `src` (names as given). */
function tarOf(src: string, names: string[], extra: string[] = []): string {
	const out = join(dir(), 'snap.tar.gz');
	const r = spawnSync('tar', ['-czf', out, ...extra, '-C', src, ...names], { encoding: 'utf8' });
	expect(r.status, r.stderr).toBe(0);
	return out;
}
function goodSource(dump = gzipSync(Buffer.from('CREATE TABLE x();\n'))): {
	src: string;
	dump: Buffer;
} {
	const src = dir();
	writeFileSync(join(src, 'manifest.json'), '{"v":2}\n');
	writeFileSync(join(src, 'indexer.sql.gz'), dump);
	return { src, dump };
}

describe('extractSnapshotArchive', () => {
	it('unpacks the two files, 0600, with the dump’s sha256 computed on the way', async () => {
		const { src, dump } = goodSource();
		const work = dir();
		const r = await extractSnapshotArchive(tarOf(src, ['manifest.json', 'indexer.sql.gz']), work, {
			maxDumpBytes: 1e6
		});
		expect(r).toEqual({ ok: true, dumpSha256: sha(dump), dumpBytes: dump.length });
		expect(readdirSync(work).sort()).toEqual(['indexer.sql.gz', 'manifest.json']);
		expect(statSync(join(work, 'indexer.sql.gz')).mode & 0o777).toBe(0o600);
	});

	it('accepts ./-prefixed names (tar -C dir .)', async () => {
		const { src } = goodSource();
		const r = await extractSnapshotArchive(
			tarOf(src, ['./manifest.json', './indexer.sql.gz']),
			dir(),
			{ maxDumpBytes: 1e6 }
		);
		expect(r.ok).toBe(true);
	});

	it('refuses a dump that is a symlink (to /dev/zero: the read never ended)', async () => {
		const src = dir();
		writeFileSync(join(src, 'manifest.json'), '{}');
		symlinkSync('/dev/zero', join(src, 'indexer.sql.gz'));
		const work = dir();
		const t0 = Date.now();
		const r = await extractSnapshotArchive(tarOf(src, ['manifest.json', 'indexer.sql.gz']), work, {
			maxDumpBytes: 1e6
		});
		expect(r.ok).toBe(false);
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(existsSync(join(work, 'indexer.sql.gz'))).toBe(false);
	});

	it('refuses a member that is a directory, an extra member, a hard link, a path outside', async () => {
		const a = dir();
		writeFileSync(join(a, 'manifest.json'), '{}');
		mkdirSync(join(a, 'indexer.sql.gz'));
		expect(
			await extractSnapshotArchive(tarOf(a, ['manifest.json', 'indexer.sql.gz']), dir(), {
				maxDumpBytes: 1e6
			})
		).toMatchObject({ ok: false, reason: expect.stringMatching(/unexpected entry/) });

		const { src } = goodSource();
		writeFileSync(join(src, 'evil.sh'), 'x');
		const work = dir();
		const r = await extractSnapshotArchive(
			tarOf(src, ['manifest.json', 'indexer.sql.gz', 'evil.sh']),
			work,
			{ maxDumpBytes: 1e6 }
		);
		expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/unexpected entry/) });
		// Nothing of a refused archive stays (the two good members came first).
		expect(readdirSync(work)).toEqual([]);

		// The dump stored as a hard link (to the manifest): no data of its own.
		const h = dir();
		writeFileSync(join(h, 'manifest.json'), '{}');
		spawnSync('ln', [join(h, 'manifest.json'), join(h, 'indexer.sql.gz')]);
		expect(
			await extractSnapshotArchive(tarOf(h, ['manifest.json', 'indexer.sql.gz']), dir(), {
				maxDumpBytes: 1e6
			})
		).toMatchObject({ ok: false, reason: expect.stringMatching(/not a regular file/) });

		const t = goodSource();
		const outside = await extractSnapshotArchive(
			tarOf(t.src, ['manifest.json', 'indexer.sql.gz'], ['--transform', 's,^indexer,../indexer,']),
			dir(),
			{ maxDumpBytes: 1e6 }
		);
		expect(outside).toMatchObject({ ok: false, reason: expect.stringMatching(/unexpected entry/) });
	});

	it('stops a gzip bomb at the cap, without writing past it', async () => {
		const src = dir();
		writeFileSync(join(src, 'manifest.json'), '{}');
		writeFileSync(join(src, 'indexer.sql.gz'), Buffer.alloc(64 * 1024 * 1024)); // compresses to ~64 kB
		const tar = tarOf(src, ['manifest.json', 'indexer.sql.gz']);
		expect(statSync(tar).size).toBeLessThan(200_000);
		const work = dir();
		const r = await extractSnapshotArchive(tar, work, { maxDumpBytes: 1024 * 1024 });
		// Refused on its declared size, before a byte of it is written.
		expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/larger than allowed/) });
		expect(readdirSync(work)).toEqual([]);
	});

	it('refuses an archive cut short inside a gzip stream that is itself whole', async () => {
		const { src } = goodSource(require('node:crypto').randomBytes(200_000));
		const full = tarOf(src, ['manifest.json', 'indexer.sql.gz']);
		const tarBytes = require('node:zlib').gunzipSync(
			require('node:fs').readFileSync(full)
		) as Buffer;
		const cut = join(dir(), 'cut.tar.gz');
		writeFileSync(cut, gzipSync(tarBytes.subarray(0, 100_000)));
		const work = dir();
		expect(await extractSnapshotArchive(cut, work, { maxDumpBytes: 1e6 })).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/cut short/)
		});
		expect(readdirSync(work)).toEqual([]);
	});

	it('a disk that fills up (or a file-size limit) is a refusal, never a crash', () => {
		// In a process of its own with a 1 MB file-size limit: the 2 MB dump
		// cannot be written. Before, the write error was thrown inside the
		// stream's handler: the whole fast-sync died with a stack trace, the
		// next source was never tried, and the half-written dump stayed.
		const big = gzipSync(require('node:crypto').randomBytes(2 * 1024 * 1024));
		const { src } = goodSource(big);
		const tar = tarOf(src, ['manifest.json', 'indexer.sql.gz']);
		const work = dir();
		const entry = join(dir(), 'efbig.mts');
		writeFileSync(
			entry,
			`import { extractSnapshotArchive } from ${JSON.stringify(
				require('node:path').resolve(__dirname, '../../src/blurt/snapshotArchive.ts')
			)};\n` +
				`const r = await extractSnapshotArchive(${JSON.stringify(tar)}, ${JSON.stringify(work)}, { maxDumpBytes: 1e8 });\n` +
				`console.log('RESULT ' + JSON.stringify(r));\n`
		);
		const tsx = require('node:path').resolve(__dirname, '../../../../node_modules/.bin/tsx');
		const r = spawnSync(
			'bash',
			['-c', `trap '' XFSZ; ulimit -f 1024; exec ${JSON.stringify(tsx)} ${JSON.stringify(entry)}`],
			{ encoding: 'utf8' }
		);
		expect(r.stdout + r.stderr).toMatch(
			/RESULT \{"ok":false,"reason":"could not write indexer\.sql\.gz/
		);
		expect(readdirSync(work)).toEqual([]);
	});

	it('refuses a cut-short archive, a non-gzip file, a missing member, a duplicate', async () => {
		const { src } = goodSource(gzipSync(Buffer.alloc(200_000, 7)));
		const full = tarOf(src, ['manifest.json', 'indexer.sql.gz']);
		const cut = join(dir(), 'cut.tar.gz');
		const bytes = require('node:fs').readFileSync(full) as Buffer;
		writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
		expect((await extractSnapshotArchive(cut, dir(), { maxDumpBytes: 1e6 })).ok).toBe(false);

		const notGz = join(dir(), 'x.tar.gz');
		writeFileSync(notGz, '<html>404</html>');
		expect((await extractSnapshotArchive(notGz, dir(), { maxDumpBytes: 1e6 })).ok).toBe(false);

		const m = goodSource();
		expect(
			(await extractSnapshotArchive(tarOf(m.src, ['manifest.json']), dir(), { maxDumpBytes: 1e6 }))
				.ok
		).toBe(false);

		const d = goodSource();
		const dupWork = dir();
		const dup = await extractSnapshotArchive(
			tarOf(d.src, ['manifest.json', 'indexer.sql.gz', 'indexer.sql.gz'], ['--hard-dereference']),
			dupWork,
			{ maxDumpBytes: 1e6 }
		);
		expect(dup).toMatchObject({ ok: false, reason: expect.stringMatching(/twice/) });
		expect(readdirSync(dupWork)).toEqual([]);
	});

	it('never writes through a link already in the work directory', async () => {
		const { src } = goodSource();
		const work = dir();
		const victim = join(dir(), 'victim');
		writeFileSync(victim, 'keep');
		symlinkSync(victim, join(work, 'indexer.sql.gz'));
		const r = await extractSnapshotArchive(tarOf(src, ['manifest.json', 'indexer.sql.gz']), work, {
			maxDumpBytes: 1e6
		});
		expect(r.ok).toBe(false);
		expect(require('node:fs').readFileSync(victim, 'utf8')).toBe('keep');
	});
});

describe('acceptSnapshotDownload', () => {
	it('accepts exactly the signed copy', async () => {
		const { src, dump } = goodSource();
		const tar = tarOf(src, ['manifest.json', 'indexer.sql.gz']);
		const work = dir();
		const tarIn = join(work, 'snapshot.tar.gz');
		require('node:fs').copyFileSync(tar, tarIn);
		expect(
			await acceptSnapshotDownload(tarIn, work, {
				sizeBytes: statSync(tar).size,
				sha256: sha(dump)
			})
		).toEqual({ ok: true });
		expect(lstatSync(join(work, 'indexer.sql.gz')).isFile()).toBe(true);
	});

	it('refuses a copy of another size before unpacking anything', async () => {
		const { src, dump } = goodSource();
		const work = dir();
		const tarIn = join(work, 'snapshot.tar.gz');
		require('node:fs').copyFileSync(tarOf(src, ['manifest.json', 'indexer.sql.gz']), tarIn);
		const r = await acceptSnapshotDownload(tarIn, work, { sizeBytes: 999_999, sha256: sha(dump) });
		expect(r).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/signed record says 999999/)
		});
		expect(readdirSync(work)).toEqual(['snapshot.tar.gz']);
	});

	it('a bomb of exactly the signed size is stopped at about that size, not after unpacking', async () => {
		const src = dir();
		writeFileSync(join(src, 'manifest.json'), '{}');
		writeFileSync(join(src, 'indexer.sql.gz'), Buffer.alloc(64 * 1024 * 1024));
		const tar = tarOf(src, ['manifest.json', 'indexer.sql.gz']);
		const work = dir();
		const tarIn = join(work, 'snapshot.tar.gz');
		require('node:fs').copyFileSync(tar, tarIn);
		// A signed record can only be for what was published: a hostile source
		// sending a bomb of the same size gets no further than the size bound.
		const r = await acceptSnapshotDownload(tarIn, work, {
			sizeBytes: statSync(tar).size,
			sha256: 'a'.repeat(64)
		});
		expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/larger than allowed/) });
		expect(readdirSync(work)).toEqual(['snapshot.tar.gz']);
	});

	it('refuses a dump with another sha256, and leaves only the download behind', async () => {
		const { src } = goodSource();
		const work = dir();
		const tarIn = join(work, 'snapshot.tar.gz');
		const tar = tarOf(src, ['manifest.json', 'indexer.sql.gz']);
		require('node:fs').copyFileSync(tar, tarIn);
		writeFileSync(join(work, 'leftover-from-the-last-source'), 'x');
		const r = await acceptSnapshotDownload(tarIn, work, {
			sizeBytes: statSync(tar).size,
			sha256: 'a'.repeat(64)
		});
		expect(r.ok).toBe(false);
		expect(readdirSync(work)).toEqual(['snapshot.tar.gz']);
	});
});
