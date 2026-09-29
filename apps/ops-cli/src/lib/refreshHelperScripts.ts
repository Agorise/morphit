/**
 * Refresh the helper scripts Ansible copied ONCE into /usr/local/lib/morphit/
 * during `morphit-ops upgrade` (v1.20.0 fix wave, C3 / C17).
 *
 * WHY. The morphit + ipfs roles copy these scripts at install time and nothing
 * ever refreshed them: `upgrade` extracts a new tree but the timers/units keep
 * running the OLD copies in /usr/local/lib/morphit/. So a fix shipped in a
 * release (morphit-first-online.sh no longer running a user's update-canary.sh
 * as root; morphit-ipfs-pin.sh no longer stalling 900 s per hour on a hidden-only
 * node) reached only NEW installs — a template fix is not a fix for installed
 * nodes.
 *
 * RULE (same as refreshUnits.ts for systemd units):
 *   - Only a script that is ALREADY INSTALLED and DIFFERS from the release copy
 *     is touched — we never install a helper the box does not run.
 *   - The previous file is saved to `<name>.bak` first.
 *   - The replacement is written to an O_EXCL temp file in the same directory,
 *     fchmod 0755 + fchown root:root on the descriptor, fsync'd, then renamed
 *     over the target — rename replaces a link itself, never its target, and a
 *     half-written script is never visible to a timer.
 *   - A link or non-regular file at the target, or a helper dir that is itself a
 *     link, is left alone and reported — nothing is written through a link.
 *   - VERIFY: the installed bytes are read back (no-follow) and must equal the
 *     release copy, mode 0755; otherwise the .bak is put back.
 */
import {
	closeSync,
	constants as fsc,
	fchmodSync,
	fchownSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeSync
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Release path (relative to the install root) → installed file name. Mirrors
 *  the copy tasks in ops/ansible/roles/{morphit,ipfs,tor}/tasks/*.yml. */
export const HELPER_SCRIPTS: ReadonlyArray<{ readonly release: string; readonly name: string }> = [
	{ release: 'ops/first-online/morphit-first-online.sh', name: 'morphit-first-online.sh' },
	{ release: 'ops/ipfs/morphit-ipfs-pin.sh', name: 'morphit-ipfs-pin.sh' },
	{ release: 'ops/ipfs/morphit-ipns-rebroadcast.sh', name: 'morphit-ipns-rebroadcast.sh' },
	{ release: 'ops/ipfs/morphit-ipfs-privacy.sh', name: 'morphit-ipfs-privacy.sh' },
	{ release: 'ops/backup/morphit-backup.sh', name: 'morphit-backup.sh' },
	// v1.20.0 (C16): every IPFS node (ipfs role + lib/ipfsGcHeal.ts install it).
	{ release: 'ops/ipfs/morphit-ipfs-gc.sh', name: 'morphit-ipfs-gc.sh' },
	// v1.20.0 (C13): tor-only nodes only (tor role + lib/torOnlyOsHeal.ts).
	{ release: 'ops/tor-only/morphit-tor-only-os.sh', name: 'morphit-tor-only-os.sh' },
	{ release: 'ops/tor-only/morphit-tor-timesync.sh', name: 'morphit-tor-timesync.sh' }
];

export const DEFAULT_HELPER_DIR = '/usr/local/lib/morphit';

export type HelperAction =
	| 'refreshed'
	| 'unchanged'
	| 'not-installed'
	| 'no-release-copy'
	| 'skipped-not-regular'
	| 'verify-failed'
	| 'error';

export interface HelperResult {
	readonly name: string;
	readonly action: HelperAction;
	readonly backupPath?: string;
	readonly detail?: string;
}

/** Read a regular file without following a link; null if absent/link/other. */
function readNoFollow(path: string): Buffer | null {
	let fd: number;
	try {
		fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
	} catch {
		return null;
	}
	try {
		if (!fstatSync(fd).isFile()) return null;
		const parts: Buffer[] = [];
		const b = Buffer.alloc(65536);
		for (;;) {
			const n = readSync(fd, b, 0, b.length, null);
			if (n === 0) break;
			parts.push(Buffer.from(b.subarray(0, n)));
		}
		return Buffer.concat(parts);
	} finally {
		closeSync(fd);
	}
}

/** Write `data` to `dest` atomically: O_EXCL temp in the same dir, fchmod/fchown
 *  on the descriptor, fsync, rename (replaces a link, never follows it). */
function atomicInstall(dest: string, dir: string, data: Buffer, mode: number): void {
	const tmp = join(dir, `.${randomBytes(6).toString('hex')}.helper-tmp`);
	const fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
	try {
		let off = 0;
		while (off < data.length) off += writeSync(fd, data, off, data.length - off);
		fchmodSync(fd, mode);
		if (typeof process.getuid === 'function' && process.getuid() === 0) fchownSync(fd, 0, 0);
		fsyncSync(fd);
	} catch (err) {
		closeSync(fd);
		rmSync(tmp, { force: true });
		throw err;
	}
	closeSync(fd);
	renameSync(tmp, dest);
}

export interface RefreshHelperOptions {
	/** The freshly-extracted install root (holds ops/…). */
	readonly releaseRoot: string;
	/** Where Ansible installed the helpers (default /usr/local/lib/morphit). */
	readonly helperDir?: string;
	readonly log?: (msg: string) => void;
}

/**
 * INSTALL one helper from the release — also when the box does not have it yet
 * (refreshHelperScripts only ever touches helpers that are already installed).
 * For a self-heal that introduces a NEW helper on the nodes that need it
 * (v1.20.0: the IPFS clean-up, the tor-only OS scripts). Same rules as a
 * refresh: the helper dir must be a real directory, a link or special file at
 * the target is left alone, the write is atomic (0755 root:root), a previous
 * copy is kept as `<name>.bak`, and the result is read back. Returns the
 * installed path, or null (with the reason logged). Never throws.
 */
export function installHelperScript(opts: {
	readonly releaseRoot: string;
	readonly name: string;
	readonly helperDir?: string;
	readonly log?: (msg: string) => void;
}): string | null {
	const dir = opts.helperDir ?? DEFAULT_HELPER_DIR;
	const log = opts.log ?? (() => {});
	const entry = HELPER_SCRIPTS.find((h) => h.name === opts.name);
	if (!entry) {
		log(`${opts.name} is not a Morphit helper script.`);
		return null;
	}
	const target = join(dir, entry.name);
	try {
		try {
			const st = lstatSync(dir);
			if (!st.isDirectory() || st.isSymbolicLink()) {
				log(`${dir} is not a real directory — not installing ${entry.name}.`);
				return null;
			}
		} catch {
			mkdirSync(dir, { recursive: true, mode: 0o755 });
		}
		const fresh = readNoFollow(join(opts.releaseRoot, entry.release));
		if (fresh === null) {
			log(`This release has no ${entry.release}.`);
			return null;
		}
		let st;
		try {
			st = lstatSync(target);
		} catch {
			st = null;
		}
		if (st && (st.isSymbolicLink() || !st.isFile())) {
			log(`Left ${target} alone: it is not a regular file — refusing to write through it.`);
			return null;
		}
		const current = st ? readNoFollow(target) : null;
		if (current !== null && current.equals(fresh) && st && (st.mode & 0o777) === 0o755)
			return target;
		if (current !== null && st) atomicInstall(`${target}.bak`, dir, current, st.mode & 0o777);
		atomicInstall(target, dir, fresh, 0o755);
		const after = readNoFollow(target);
		if (after !== null && after.equals(fresh) && (lstatSync(target).mode & 0o777) === 0o755)
			return target;
		log(`Could not verify the installed ${target}.`);
		return null;
	} catch (err) {
		log(`Could not install ${target}: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/** Refresh installed helper scripts from the release. Never throws. */
export function refreshHelperScripts(opts: RefreshHelperOptions): HelperResult[] {
	const dir = opts.helperDir ?? DEFAULT_HELPER_DIR;
	const log = opts.log ?? (() => {});
	const out: HelperResult[] = [];

	// The helper dir itself must be a real directory, not a link to elsewhere.
	let dirOk = false;
	try {
		const st = lstatSync(dir);
		dirOk = st.isDirectory() && !st.isSymbolicLink();
	} catch {
		dirOk = false;
	}

	for (const h of HELPER_SCRIPTS) {
		const target = join(dir, h.name);
		try {
			if (!dirOk) {
				out.push({
					name: h.name,
					action: 'not-installed',
					detail: `${dir} is not a real directory`
				});
				continue;
			}
			let st;
			try {
				st = lstatSync(target);
			} catch {
				out.push({ name: h.name, action: 'not-installed' });
				continue;
			}
			if (st.isSymbolicLink() || !st.isFile()) {
				out.push({ name: h.name, action: 'skipped-not-regular' });
				log(
					`Left ${target} alone: it is not a regular file (a link or special file) — refusing to write through it.`
				);
				continue;
			}
			const fresh = readNoFollow(join(opts.releaseRoot, h.release));
			if (fresh === null) {
				out.push({ name: h.name, action: 'no-release-copy' });
				continue;
			}
			const current = readNoFollow(target);
			if (current !== null && current.equals(fresh) && (st.mode & 0o777) === 0o755) {
				out.push({ name: h.name, action: 'unchanged' });
				continue;
			}
			// Back up the installed copy (atomic, no-follow), then replace.
			const backupPath = `${target}.bak`;
			if (current !== null) atomicInstall(backupPath, dir, current, st.mode & 0o777);
			atomicInstall(target, dir, fresh, 0o755);
			// VERIFY by reading back what is actually installed.
			const after = readNoFollow(target);
			const afterSt = lstatSync(target);
			if (after !== null && after.equals(fresh) && (afterSt.mode & 0o777) === 0o755) {
				out.push({ name: h.name, action: 'refreshed', backupPath });
				log(`Refreshed ${target} from this release (previous saved to ${backupPath}).`);
			} else {
				if (current !== null) atomicInstall(target, dir, current, st.mode & 0o777);
				out.push({ name: h.name, action: 'verify-failed', backupPath });
				log(`Could not verify the refreshed ${target}; put the previous copy back.`);
			}
		} catch (err) {
			out.push({
				name: h.name,
				action: 'error',
				detail: err instanceof Error ? err.message : String(err)
			});
			log(`Could not refresh ${target}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return out;
}
