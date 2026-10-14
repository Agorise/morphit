/**
 * (canary) — keep serving the warrant canary across `morphit-ops upgrade`.
 *
 * The upgrade installs a fresh `apps/web/build`, which has no `canary.txt` or
 * `pgp_keys.asc`: both are written in by the operator's refresh (on this box,
 * or uploaded from the computer that holds the key). A canary signed on
 * another computer therefore went MISSING after every upgrade until its
 * operator re-ran the refresh by hand (morphit.io and vigilante.trading,
 * v1.21.7) — and a canary that disappears reads as one that tripped.
 *
 * The signed file does not change with the release: it is the operator's own
 * statement, with its own dates. So the upgrade puts the copy that was served
 * before back, byte for byte (re-encoding a single byte would break its
 * signature). Its "Valid through" date still runs out on its own, so a canary
 * the operator stops signing still goes stale as it always did; a refresh on
 * this box (run after this) replaces it with a new one.
 *
 * Runs as root and reads from the previous install's served folder, which its
 * (non-root) canary uploader can write — and, where the install itself belongs
 * to that user, the folders above it too. So a file is copied only when:
 *   - the file root actually opened is `<the old install, links resolved>/
 *     apps/web/build/<name>` (read back from /proc after opening, so a link
 *     anywhere in the path, swapped in at any moment, is refused), and opening
 *     it did not follow a link;
 *   - it is a regular file with no other names (a hard link to a root-only
 *     file has two), within a canary's or a key's size;
 *   - it is, as a whole, what it claims to be: a clearsigned Morphit canary, or
 *     armored PGP PUBLIC key blocks and nothing else.
 * Call it while the new folder is still root-owned (before its ownership is
 * handed back), so nothing can race the write; a file already in the new
 * folder is left alone. (A separate web root needs nothing: every refresh
 * writes into apps/web/build, and step 9c copies the build over the web root.)
 */

import {
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	lstatSync,
	openSync,
	readlinkSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseCanaryTimestamp } from '../canaryTime.ts';

/** Is `lines` exactly one armored block of `kind`: the BEGIN line, `Key:
 *  value` header lines, a blank line, base64 lines (the `=xxxx` checksum is one
 *  of them), the END line? Line by line, with no pattern that can backtrack on
 *  a crafted file. */
function armoredBlock(lines: readonly string[], kind: string): boolean {
	if (lines.length < 4 || lines[0] !== `-----BEGIN PGP ${kind}-----`) return false;
	if (lines[lines.length - 1] !== `-----END PGP ${kind}-----`) return false;
	let i = 1;
	while (i < lines.length - 1 && /^[A-Za-z][A-Za-z-]*: /.test(lines[i]!)) i++;
	if (lines[i] !== '') return false;
	i++;
	if (i >= lines.length - 1) return false;
	for (; i < lines.length - 1; i++) if (!/^[A-Za-z0-9+/=]+$/.test(lines[i]!)) return false;
	return true;
}

/** The file's lines (LF or CRLF), with trailing blank lines dropped. */
function linesOf(t: string): string[] {
	const lines = t.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
	return lines;
}

export const CANARY_SERVED_FILES: readonly {
	readonly name: string;
	/** Larger than any real one; anything bigger is not one. */
	readonly maxBytes: number;
	readonly what: string;
	/** `text` is the file read byte-for-char (latin1), so no byte is lost. */
	readonly looksRight: (text: string) => boolean;
}[] = [
	{
		name: 'canary.txt',
		maxBytes: 256 * 1024,
		what: 'signed canary',
		looksRight: (t) => {
			if (!t.startsWith('-----BEGIN PGP SIGNED MESSAGE-----')) return false;
			if (!/\n=== MORPHIT CANARY ===\r?\n/.test(t)) return false;
			const sig = t.lastIndexOf('\n-----BEGIN PGP SIGNATURE-----');
			return sig > 0 && armoredBlock(linesOf(t.slice(sig + 1)), 'SIGNATURE');
		}
	},
	{
		name: 'pgp_keys.asc',
		// A public key carrying many signatures can be large.
		maxBytes: 8 * 1024 * 1024,
		what: 'public key',
		looksRight: (t) => {
			// One or more whole blocks (a key and its successor), blank lines
			// between them allowed, nothing else.
			const lines = linesOf(t);
			let start = 0;
			let blocks = 0;
			while (start < lines.length) {
				if (lines[start]!.trim() === '') {
					start++;
					continue;
				}
				const end = lines.indexOf('-----END PGP PUBLIC KEY BLOCK-----', start);
				if (end < 0 || !armoredBlock(lines.slice(start, end + 1), 'PUBLIC KEY BLOCK')) return false;
				blocks++;
				start = end + 1;
			}
			return blocks > 0;
		}
	}
];

export interface CanaryCarry {
	/** The files put back. */
	readonly carried: readonly string[];
	/** Files the old folder had that were not put back, and why. */
	readonly skipped: readonly { readonly name: string; readonly why: string }[];
	/** The carried canary's "Valid through" line, when canary.txt was carried. */
	readonly validThrough: string | null;
	/** When that is (epoch ms; NaN when unreadable). */
	readonly validThroughMs: number;
}

/** Read `path` the way a root process may read a folder someone else can
 *  write: the file opened must be `expected` (no link anywhere on the way),
 *  a regular file with one name, at most `max` bytes. */
function readPlainFile(
	path: string,
	expected: string,
	max: number,
	beforeChecks?: () => void
): { bytes: Buffer } | { why: string } {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		return { why: code === 'ELOOP' ? 'it is a link' : `could not open it (${code ?? 'error'})` };
	}
	try {
		beforeChecks?.();
		const st = fstatSync(fd);
		if (!st.isFile()) return { why: 'not a regular file' };
		if (st.nlink !== 1) return { why: 'it has other names (a hard link)' };
		if (st.size > max) return { why: `larger than ${max} bytes` };
		const buf = Buffer.alloc(st.size);
		let off = 0;
		while (off < st.size) {
			const n = readSync(fd, buf, off, st.size - off, off);
			if (n <= 0) break;
			off += n;
		}
		// The name the open file has NOW, checked last: a second name (hard
		// link) dropped between the open and fstat — so the link count read
		// 1 — shows here as "… (deleted)", and a link swapped in on the way as
		// another path. Checked before the stat, that race copied a root-only
		// file out (reproduced, protected_hardlinks=0).
		let opened: string | null = null;
		try {
			opened = readlinkSync(`/proc/self/fd/${fd}`);
		} catch {
			/* no /proc: the folder check before the open stands */
		}
		if (opened !== null && opened !== expected) return { why: 'it is reached through a link' };
		return { bytes: buf.subarray(0, off) };
	} finally {
		closeSync(fd);
	}
}

function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Put the canary served from `fromBuild` (the previous install's
 *  apps/web/build) back into `toBuild` (the new one). `trustedRoot` is the
 *  folder above it that only root controls (the old install, renamed by root);
 *  nothing below it may be a link. Never throws: a file that cannot be read or
 *  checked is skipped, with why. */
export function carryCanaryForward(
	fromBuild: string,
	toBuild: string,
	opts: {
		readonly trustedRoot: string;
		/** Tests only: runs between opening a file and checking it (the race
		 *  window an attacker would use). */
		readonly _beforeChecks?: () => void;
	}
): CanaryCarry {
	const carried: string[] = [];
	const skipped: { name: string; why: string }[] = [];
	let validThrough: string | null = null;
	let realFrom: string | null = null;
	try {
		realFrom = join(realpathSync(opts.trustedRoot), relative(opts.trustedRoot, resolve(fromBuild)));
		if (realpathSync(fromBuild) !== realFrom) realFrom = null;
	} catch {
		realFrom = null;
	}
	for (const f of CANARY_SERVED_FILES) {
		const src = join(fromBuild, f.name);
		if (!present(src)) continue;
		if (realFrom === null) {
			skipped.push({ name: f.name, why: 'the old served folder is reached through a link' });
			continue;
		}
		const dst = join(toBuild, f.name);
		if (present(dst)) {
			skipped.push({ name: f.name, why: 'the new install already has one' });
			continue;
		}
		let r: { bytes: Buffer } | { why: string };
		let text = '';
		try {
			r = readPlainFile(src, join(realFrom, f.name), f.maxBytes, opts._beforeChecks);
			if ('bytes' in r) {
				text = r.bytes.toString('latin1');
				if (!f.looksRight(text)) r = { why: `it is not a ${f.what}` };
			}
		} catch (e) {
			r = { why: `could not check it (${(e as Error).message})` };
		}
		if ('why' in r) {
			skipped.push({ name: f.name, why: r.why });
			continue;
		}
		const tmp = `${dst}.carry-${process.pid}`;
		// Only a file this run created is removed on failure (a full disk can
		// leave it half-written), so nothing is left in the served folder.
		let created = false;
		try {
			const out = openSync(tmp, 'wx', 0o644);
			created = true;
			try {
				writeFileSync(out, r.bytes);
				fchmodSync(out, 0o644);
			} finally {
				closeSync(out);
			}
			renameSync(tmp, dst);
		} catch (e) {
			if (created) {
				try {
					unlinkSync(tmp);
				} catch {
					/* already gone */
				}
			}
			skipped.push({
				name: f.name,
				why: `could not write it (${(e as NodeJS.ErrnoException).code ?? 'error'})`
			});
			continue;
		}
		carried.push(f.name);
		if (f.name === 'canary.txt')
			validThrough = /^Valid through:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
	}
	return {
		carried,
		skipped,
		validThrough,
		validThroughMs: validThrough === null ? NaN : parseCanaryTimestamp(validThrough)
	};
}
