/**
 * Files root writes or reads in directories another account can write to.
 *
 * `morphit-ops` runs as root, and some of its state and logs live in
 * directories the unprivileged `morphit` service account owns (its home,
 * /var/lib/morphit) or used to own (/var/log/morphit). A plain writeFileSync or
 * a shell `>` there follows a symbolic link that account planted, and root then
 * overwrites whatever the link names (/etc/shadow …). A plain readFileSync
 * follows one too, and a JSON parse error then quotes the first bytes of the
 * file it was pointed at into a log.
 *
 *  - writeNoFollow: the kernel refuses a link at the final component
 *    (O_NOFOLLOW → ELOOP), a FIFO cannot stall the upgrade (O_NONBLOCK), and
 *    only a regular file is written.
 *  - readNoFollow: the same for reading; null for anything but a regular file.
 *  - freshFileNoFollow: a NEW root-owned file in place of whatever was at the
 *    path, for a file another root writer (systemd's StandardOutput=append:)
 *    opens by name afterwards.
 *
 * Every parent directory component must be one only root can change (they
 * are: /var/lib, /var/log); only the last component is the other account's.
 */
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	unlinkSync,
	writeSync
} from 'node:fs';

/** Root's own state directory: what morphit-ops keeps between runs that no
 *  other account may write (it used to live in the morphit account's home). */
export const ROOT_STATE_DIR = '/var/lib/morphit-ops';

/** Create `dir` (mode 0700 by default) and check it is a real directory owned
 *  by the caller; throws otherwise (a link, another owner). */
export function ensureOwnDir(dir: string, mode = 0o700): void {
	mkdirSync(dir, { recursive: true, mode });
	const st = lstatSync(dir);
	if (!st.isDirectory() || st.uid !== (process.getuid?.() ?? 0)) {
		throw new Error(`${dir} is not a directory this account owns`);
	}
	if ((st.mode & 0o7777) !== mode) chmodSync(dir, mode);
}

const { O_WRONLY, O_RDONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fsConstants;

function writeAll(fd: number, data: string): void {
	const buf = Buffer.from(data, 'utf8');
	let off = 0;
	while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/** Create-or-replace the regular file at `path`, never through a link. Throws
 *  on a link, a non-regular file, or any open failure. */
export function writeNoFollow(path: string, data: string, mode = 0o640): void {
	const fd = openSync(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_NONBLOCK, mode);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
		writeAll(fd, data);
	} finally {
		closeSync(fd);
	}
}

/** The regular file at `path`, never read through a link; null if it is a
 *  link, absent, or not a regular file. */
export function readNoFollow(path: string): string | null {
	let fd: number;
	try {
		fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch {
		return null;
	}
	try {
		if (!fstatSync(fd).isFile()) return null;
		const chunks: Buffer[] = [];
		const b = Buffer.alloc(65536);
		for (;;) {
			const n = readSync(fd, b, 0, b.length, null);
			if (n === 0) break;
			chunks.push(Buffer.from(b.subarray(0, n)));
		}
		return Buffer.concat(chunks).toString('utf8');
	} finally {
		closeSync(fd);
	}
}

/** Does a regular file exist at `path` (a link is not one)? */
export function regularFileExists(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

/** Replace whatever is at `path` with a NEW regular file owned by the caller
 *  (root), holding `data`. Anything already there that is not a regular file
 *  owned by root — a link, a FIFO, a file the other account made — is removed
 *  first; O_EXCL then refuses anything that appears in between. Throws when
 *  it cannot. */
export function freshFileNoFollow(path: string, data: string, mode = 0o640): void {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const st = lstatSync(path);
			if (!st.isFile() || st.uid !== (process.getuid?.() ?? 0) || st.nlink !== 1) unlinkSync(path);
			else {
				writeNoFollow(path, data, mode);
				return;
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
		}
		let fd: number;
		try {
			fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK, mode);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
			throw e;
		}
		try {
			writeAll(fd, data);
		} finally {
			closeSync(fd);
		}
		return;
	}
	throw new Error(`${path}: something keeps re-creating it`);
}
