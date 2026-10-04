/**
 * memoryBudget — how much RAM this process may safely use, and how much it is
 * using now. Used by the flow-backfill governor to size its reorder buffer so a
 * catch-up on a big VPS buffers aggressively while a low-RAM mini PC (or a
 * systemd-`MemoryMax`ed / containerised node) stays within its slice.
 *
 * Budget: the memory limit of THIS PROCESS's cgroup, else os.totalmem().
 *
 * The process's cgroup comes from /proc/self/cgroup — `0::<path>` on cgroup v2,
 * the line naming the `memory` controller on v1 — and the mount points from
 * /proc/self/mountinfo. Every level from the process's cgroup up to the mount's
 * root is read (v2 `memory.max`, v1 `memory.limit_in_bytes`) and the smallest
 * finite value wins: a limit set on a slice binds every service under it.
 * Reading only the mount's root files (as this did before) under systemd reads
 * the ROOT cgroup, which has no limit — inside morphit-indexer.service with
 * MemoryMax=1536M the budget was the whole machine (VT5-2).
 *
 * "max", the v1 ~unlimited sentinel, unreadable files and a path that would
 * leave the mount all count as "no limit". Without /proc (or mountinfo), the
 * default mount points' root files are read, as before.
 */
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { posix } from 'node:path';

/** Above this multiple of physical RAM, a cgroup value is the kernel's
 *  effectively-unlimited sentinel, not a real cap. */
const UNLIMITED_FACTOR = 4;

const V2_DEFAULT_MOUNT = '/sys/fs/cgroup';
const V1_DEFAULT_MOUNT = '/sys/fs/cgroup/memory';

interface CgroupMount {
	/** Where it is mounted. */
	readonly mountpoint: string;
	/** Which cgroup the mount's top directory is (not "/" inside a namespace). */
	readonly root: string;
}

/**
 * The memory limit of this process's cgroup (v2, or v1's memory controller), in
 * bytes, or null when there is none. `root` prefixes every path read (tests use
 * fixture trees); `total` is the machine's RAM for the sentinel check.
 */
export function cgroupMemoryLimitBytes(
	opts: { readonly root?: string; readonly total?: number } = {}
): number | null {
	const prefix = opts.root ?? '';
	const total = opts.total ?? totalmem();
	const read = (p: string): string | null => {
		try {
			return readFileSync(prefix + p, 'utf8');
		} catch {
			return null;
		}
	};
	const limitOf = (raw: string | null): number | null => {
		if (raw === null) return null;
		const t = raw.trim();
		if (t === '' || t === 'max') return null;
		const n = Number(t);
		return Number.isFinite(n) && n > 0 && n < total * UNLIMITED_FACTOR ? n : null;
	};

	const mounts = parseMountinfo(read('/proc/self/mountinfo'));
	const selfCgroup = read('/proc/self/cgroup');
	const limits: number[] = [];
	if (selfCgroup !== null) {
		for (const line of selfCgroup.split('\n')) {
			const m = /^(\d+):([^:]*):(.*)$/.exec(line.trim());
			if (!m) continue;
			const [, id, controllers, path] = m;
			if (id === '0' && controllers === '') {
				const at = smallestUpTheTree(
					mounts.v2 ?? { mountpoint: V2_DEFAULT_MOUNT, root: '/' },
					path!,
					'memory.max',
					read,
					limitOf
				);
				if (at !== null) limits.push(at);
			} else if (controllers!.split(',').includes('memory')) {
				const at = smallestUpTheTree(
					mounts.v1Memory ?? { mountpoint: V1_DEFAULT_MOUNT, root: '/' },
					path!,
					'memory.limit_in_bytes',
					read,
					limitOf
				);
				if (at !== null) limits.push(at);
			}
		}
	} else {
		// No /proc: the mount roots, as before (right inside a cgroup namespace).
		for (const f of [
			`${V2_DEFAULT_MOUNT}/memory.max`,
			`${V1_DEFAULT_MOUNT}/memory.limit_in_bytes`
		]) {
			const n = limitOf(read(f));
			if (n !== null) limits.push(n);
		}
	}
	return limits.length === 0 ? null : Math.min(...limits);
}

/** The smallest limit from the cgroup at `path` up to the mount's top. */
function smallestUpTheTree(
	mount: CgroupMount,
	path: string,
	file: string,
	read: (p: string) => string | null,
	limitOf: (raw: string | null) => number | null
): number | null {
	const cg = posix.normalize(`/${path}`);
	const mountRoot = posix.normalize(`/${mount.root}`);
	// The part of the cgroup path below the mount's own root.
	let rel: string;
	if (mountRoot === '/') rel = cg;
	else if (cg === mountRoot || cg.startsWith(`${mountRoot}/`))
		rel = cg.slice(mountRoot.length) || '/';
	else return null;
	// A path climbing out of the mount is not followed.
	if (path.split('/').includes('..')) return null;
	let best: number | null = null;
	for (let dir = rel; ; dir = posix.dirname(dir)) {
		const n = limitOf(read(posix.join(mount.mountpoint, dir, file)));
		if (n !== null && (best === null || n < best)) best = n;
		if (dir === '/') break;
	}
	return best;
}

/** The cgroup2 mount and the v1 memory-controller mount, from mountinfo. */
function parseMountinfo(raw: string | null): { v2?: CgroupMount; v1Memory?: CgroupMount } {
	const out: { v2?: CgroupMount; v1Memory?: CgroupMount } = {};
	if (raw === null) return out;
	for (const line of raw.split('\n')) {
		const sep = line.indexOf(' - ');
		if (sep < 0) continue;
		const left = line.slice(0, sep).split(' ');
		const right = line.slice(sep + 3).split(' ');
		const root = left[3];
		const mountpoint = left[4];
		const fstype = right[0];
		const superOpts = (right[2] ?? '').split(',');
		if (root === undefined || mountpoint === undefined) continue;
		const m = { mountpoint: unescapeMount(mountpoint), root: unescapeMount(root) };
		if (fstype === 'cgroup2' && out.v2 === undefined) out.v2 = m;
		else if (fstype === 'cgroup' && superOpts.includes('memory') && out.v1Memory === undefined) {
			out.v1Memory = m;
		}
	}
	return out;
}

/** mountinfo escapes space, tab, newline and backslash as octal. */
function unescapeMount(s: string): string {
	return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

/** Total RAM this process may treat as its ceiling (cgroup limit or physical). */
export function memoryBudgetBytes(): number {
	return cgroupMemoryLimitBytes() ?? totalmem();
}

/** Resident set size of this process right now. */
export function processRssBytes(): number {
	return process.memoryUsage().rss;
}
