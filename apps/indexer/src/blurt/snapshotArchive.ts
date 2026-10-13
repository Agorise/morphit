/**
 * Unpack an indexer snapshot tarball (snapshot-export.ts: a gzip'd tar holding
 * exactly `manifest.json` and `indexer.sql.gz`) SAFELY, from a source that may
 * be hostile.
 *
 * Fast-sync downloads the tarball from sources nobody vouches for — federation
 * peers, the hidden Blurt RPC nodes, public IPFS gateways — and the bytes are
 * only proven against the signed sha256 of the DUMP inside. Before v1.21.7 the
 * archive was unpacked with `tar -xzf` as root and the dump read whole into
 * memory, before any check (review, 2026-10-12):
 *   - a 448-byte archive whose `indexer.sql.gz` is a symlink to /dev/zero made
 *     the hash read grow without end (gigabytes, then out of memory);
 *   - a 2 MB archive unpacking to 2 GB aborted the whole fast-sync ("File size
 *     … is greater than 2 GiB") before the next, good source was tried;
 *   - a member that is a directory threw, same result.
 *
 * Here the archive is read as a stream, by this code, not by tar:
 *   - only the two expected names, each a REGULAR file (nothing else: no links,
 *     directories, devices, extra or extended-header entries), each once;
 *   - each written with mode 0600 into `workDir`, never following a link there;
 *   - a hard cap on each member's size AND on the total decompressed bytes, so a
 *     gzip bomb is stopped at the cap, not after filling the disk;
 *   - the dump's sha256 computed while it is written (never read back whole).
 * It never throws: every problem is a `{ ok: false, reason }`, so the caller
 * moves on to its next source.
 */
import {
	createReadStream,
	openSync,
	writeSync,
	closeSync,
	rmSync,
	readdirSync,
	statSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { basename, join } from 'node:path';
import { constants } from 'node:fs';

import { DUMP_FILENAME, MANIFEST_FILENAME } from '../db/snapshotManifest.ts';

/** A manifest is a few hundred bytes. */
export const MANIFEST_MAX_BYTES = 64 * 1024;

export type ArchiveResult =
	| { readonly ok: true; readonly dumpSha256: string; readonly dumpBytes: number }
	| { readonly ok: false; readonly reason: string };

const BLOCK = 512;

/** The member name of a tar header (ustar prefix + name), or null when it is
 *  not plain ASCII. */
function headerName(h: Buffer): string | null {
	const field = (from: number, len: number): string => {
		const raw = h.subarray(from, from + len);
		const nul = raw.indexOf(0);
		return raw.subarray(0, nul < 0 ? len : nul).toString('latin1');
	};
	const name = field(0, 100);
	const magic = field(257, 6);
	const prefix = magic.startsWith('ustar') ? field(345, 155) : '';
	const full = prefix !== '' ? `${prefix}/${name}` : name;
	return /^[\x20-\x7e]*$/.test(full) ? full : null;
}

/** The size field (octal, or GNU base-256 for huge sizes, refused here). */
function headerSize(h: Buffer): number | null {
	const raw = h.subarray(124, 136);
	if ((raw[0]! & 0x80) !== 0) return null; // base-256: far beyond any cap
	const s = raw.toString('latin1').replace(/\0.*$/s, '').trim();
	if (!/^[0-7]{1,11}$/.test(s)) return null;
	return parseInt(s, 8);
}

/** The header's own checksum holds (a corrupt or non-tar stream fails here). */
function checksumOk(h: Buffer): boolean {
	const s = h.subarray(148, 156).toString('latin1').replace(/\0.*$/s, '').trim();
	if (!/^[0-7]{1,8}$/.test(s)) return false;
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
	return sum === parseInt(s, 8);
}

/** `manifest.json` / `./manifest.json` → the bare name; anything else null. */
function wantedName(name: string): string | null {
	const bare = name.startsWith('./') ? name.slice(2) : name;
	return bare === MANIFEST_FILENAME || bare === DUMP_FILENAME ? bare : null;
}

/**
 * Unpack `tarGzPath` into `workDir` (which must exist and be private to this
 * run). `maxDumpBytes` caps the dump (the signed tarball size is a good bound:
 * the dump is already gzip'd, so the archive barely compresses it).
 */
export async function extractSnapshotArchive(
	tarGzPath: string,
	workDir: string,
	opts: { readonly maxDumpBytes: number; readonly maxManifestBytes?: number }
): Promise<ArchiveResult> {
	const maxManifest = opts.maxManifestBytes ?? MANIFEST_MAX_BYTES;
	// Headers + padding of two small members, the end blocks, and tar's record
	// padding (up to 10 KiB) on top of the two caps.
	const maxTotal = opts.maxDumpBytes + maxManifest + 64 * 1024;
	const seen = new Set<string>();
	const hash = createHash('sha256');
	let dumpBytes = 0;

	let buf: Buffer = Buffer.alloc(0);
	let total = 0;
	/** The member being written, or null between members. */
	let cur: { name: string; fd: number; left: number; pad: number } | null = null;
	let skipPad = 0;
	let ended = false;
	let failure: string | null = null;

	const fail = (why: string): void => {
		if (failure === null) failure = why;
	};
	const closeCur = (): void => {
		if (cur !== null) {
			closeSync(cur.fd);
			cur = null;
		}
	};

	/** Consume as much of `buf` as possible. */
	const drain = (): void => {
		while (failure === null && !ended) {
			if (skipPad > 0) {
				const n = Math.min(skipPad, buf.length);
				buf = buf.subarray(n);
				skipPad -= n;
				if (skipPad > 0) return;
			}
			if (cur !== null) {
				const n = Math.min(cur.left, buf.length);
				if (n > 0) {
					const chunk = buf.subarray(0, n);
					// A short write is written on, never skipped: the hash must be of
					// what is on disk. A full disk throws here, caught below.
					for (let off = 0; off < n; ) off += writeSync(cur.fd, chunk, off, n - off);
					if (cur.name === DUMP_FILENAME) {
						hash.update(chunk);
						dumpBytes += n;
					}
					buf = buf.subarray(n);
					cur.left -= n;
				}
				if (cur.left > 0) return;
				skipPad = cur.pad;
				closeCur();
				continue;
			}
			if (buf.length < BLOCK) return;
			const h = buf.subarray(0, BLOCK);
			buf = buf.subarray(BLOCK);
			if (h.every((b) => b === 0)) {
				ended = true; // end of archive (the second zero block is not needed)
				return;
			}
			if (!checksumOk(h)) return fail('the archive is not a valid tar file');
			const type = String.fromCharCode(h[156]!);
			const name = headerName(h);
			const size = headerSize(h);
			if (name === null || size === null) return fail('the archive has an unreadable entry');
			const want = wantedName(name);
			if (want === null)
				return fail(`the archive holds an unexpected entry (${JSON.stringify(name.slice(0, 80))})`);
			if (type !== '0' && type !== '\0')
				return fail(`${want} in the archive is not a regular file`);
			if (seen.has(want)) return fail(`the archive holds ${want} twice`);
			seen.add(want);
			const cap = want === DUMP_FILENAME ? opts.maxDumpBytes : maxManifest;
			if (size > cap)
				return fail(`${want} in the archive is larger than allowed (${size} > ${cap} bytes)`);
			let fd: number;
			try {
				// O_NOFOLLOW + O_EXCL: never through a link, never over something
				// already there (the work directory is emptied before each source).
				fd = openSync(
					join(workDir, want),
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600
				);
			} catch (e) {
				return fail(`could not write ${want}: ${e instanceof Error ? e.message : String(e)}`);
			}
			cur = { name: want, fd, left: size, pad: (BLOCK - (size % BLOCK)) % BLOCK };
		}
	};

	try {
		await new Promise<void>((resolve) => {
			const src = createReadStream(tarGzPath);
			const gz = createGunzip();
			const stop = (): void => {
				src.destroy();
				gz.destroy();
				resolve();
			};
			src.on('error', (e) => {
				fail(`could not read the download: ${e.message}`);
				stop();
			});
			gz.on('error', () => {
				fail('the download is not a valid gzip file');
				stop();
			});
			gz.on('data', (chunk: Buffer) => {
				total += chunk.length;
				if (total > maxTotal) {
					fail(`the archive unpacks to more than ${maxTotal} bytes`);
					return stop();
				}
				buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
				try {
					drain();
				} catch (e) {
					// A full disk or a file-size limit: a refusal like any other, so
					// the next source is tried and this one's files are removed. It
					// used to escape the stream handler and end the whole run with a
					// stack trace, the half-written dump left behind (review, 2026-10-12).
					fail(
						`could not write ${cur?.name ?? 'the archive'}: ${e instanceof Error ? e.message : String(e)}`
					);
				}
				if (failure !== null || ended) stop();
			});
			gz.on('end', () => resolve());
			src.pipe(gz);
		});
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e));
	}
	// A member still open at the end of the stream was cut short.
	const cutShort = cur !== null;
	closeCur();
	if (failure === null && cutShort) fail('the archive is cut short');
	if (failure === null && !seen.has(MANIFEST_FILENAME))
		fail(`the archive has no ${MANIFEST_FILENAME}`);
	if (failure === null && !seen.has(DUMP_FILENAME)) fail(`the archive has no ${DUMP_FILENAME}`);
	if (failure !== null) {
		for (const f of [MANIFEST_FILENAME, DUMP_FILENAME]) rmSync(join(workDir, f), { force: true });
		return { ok: false, reason: failure };
	}
	return { ok: true, dumpSha256: hash.digest('hex'), dumpBytes };
}

/** Empty `dir` except the entry named `keep` (the download itself). */
export function emptyWorkDir(dir: string, keep: string | null = null): void {
	for (const n of readdirSync(dir))
		if (n !== keep) rmSync(join(dir, n), { recursive: true, force: true });
}

/**
 * Accept one downloaded copy of the snapshot, or say why not: its size must be
 * exactly the signed tarball size, it must unpack safely
 * ({@link extractSnapshotArchive}), and the dump inside must match the signed
 * sha256. Leaves `manifest.json` and `indexer.sql.gz` in `workDir` when it
 * accepts; nothing but the download when it refuses. Never throws.
 */
export async function acceptSnapshotDownload(
	tarGzPath: string,
	workDir: string,
	signed: { readonly sizeBytes: number; readonly sha256: string }
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
	try {
		const got = statSync(tarGzPath).size;
		if (got !== signed.sizeBytes)
			return {
				ok: false,
				reason: `the download is ${got} bytes; the signed record says ${signed.sizeBytes}`
			};
		emptyWorkDir(workDir, basename(tarGzPath));
		// The dump is gzip'd already, so the archive hardly shrinks it: the signed
		// tarball size (plus room for tar's headers) bounds it.
		const r = await extractSnapshotArchive(tarGzPath, workDir, {
			maxDumpBytes: signed.sizeBytes + 1024 * 1024
		});
		if (!r.ok) return r;
		if (r.dumpSha256 !== signed.sha256) {
			emptyWorkDir(workDir, basename(tarGzPath));
			return {
				ok: false,
				reason: `sha256 MISMATCH: got ${r.dumpSha256}, the signed record says ${signed.sha256}`
			};
		}
		return { ok: true };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
}
