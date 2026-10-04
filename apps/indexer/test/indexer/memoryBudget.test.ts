/**
 * VT5-2 (with E) — the memory budget is this PROCESS's cgroup limit.
 *
 * Under systemd the service runs in /system.slice/morphit-indexer.service with
 * MemoryMax=1536M; /sys/fs/cgroup/memory.max is the ROOT cgroup's file, which
 * the kernel does not create, so the budget fell through to the whole machine's
 * RAM and the flow-backfill buffer could grow past the service's cap. The
 * process's own cgroup comes from /proc/self/cgroup (mount points from
 * /proc/self/mountinfo); every level from it up to the root is read, and the
 * smallest finite limit wins (a slice can carry the limit).
 *
 * Fixture trees under a temporary root stand in for /proc and /sys.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cgroupMemoryLimitBytes } from '$indexer/memoryBudget';

const GiB = 1024 ** 3;
const TOTAL = 8 * GiB;
const CAP = 1536 * 1024 * 1024;

/** A fake filesystem: path → content, under a fresh temporary root. */
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'cg-'));
	for (const [p, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, p)), { recursive: true });
		writeFileSync(join(root, p), content);
	}
	return root;
}

const V2_MOUNTINFO =
	'30 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:4 - cgroup2 cgroup2 rw,nsdelegate\n';
const V1_MOUNTINFO =
	'25 23 0:22 / /sys/fs/cgroup/memory rw,nosuid,nodev,noexec,relatime shared:9 - cgroup cgroup rw,memory\n' +
	'26 23 0:23 / /sys/fs/cgroup/cpu,cpuacct rw,nosuid,nodev,noexec,relatime shared:10 - cgroup cgroup rw,cpu,cpuacct\n';

describe('memory budget from the process cgroup (VT5-2)', () => {
	it('cgroup v2 under systemd: the service cgroup limit, not the machine', () => {
		const root = tree({
			'proc/self/cgroup': '0::/system.slice/morphit-indexer.service\n',
			'proc/self/mountinfo': V2_MOUNTINFO,
			'sys/fs/cgroup/system.slice/memory.max': 'max\n',
			'sys/fs/cgroup/system.slice/morphit-indexer.service/memory.max': `${CAP}\n`
		});
		expect(cgroupMemoryLimitBytes({ root, total: TOTAL })).toBe(CAP);
	});

	it('cgroup v2: a limit on the slice applies to the service under it', () => {
		const root = tree({
			'proc/self/cgroup': '0::/morphit.slice/morphit-indexer.service\n',
			'proc/self/mountinfo': V2_MOUNTINFO,
			'sys/fs/cgroup/morphit.slice/memory.max': `${GiB}\n`,
			'sys/fs/cgroup/morphit.slice/morphit-indexer.service/memory.max': `${CAP}\n`
		});
		expect(cgroupMemoryLimitBytes({ root, total: TOTAL })).toBe(GiB);
	});

	it('cgroup v1: the memory controller line and memory.limit_in_bytes', () => {
		const root = tree({
			'proc/self/cgroup':
				'12:cpu,cpuacct:/system.slice/morphit-indexer.service\n' +
				'9:memory:/system.slice/morphit-indexer.service\n' +
				'1:name=systemd:/system.slice/morphit-indexer.service\n',
			'proc/self/mountinfo': V1_MOUNTINFO,
			'sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n',
			'sys/fs/cgroup/memory/system.slice/memory.limit_in_bytes': '9223372036854771712\n',
			'sys/fs/cgroup/memory/system.slice/morphit-indexer.service/memory.limit_in_bytes': `${CAP}\n`
		});
		expect(cgroupMemoryLimitBytes({ root, total: TOTAL })).toBe(CAP);
	});

	it('a container with its own cgroup namespace: path "/" is the container cgroup', () => {
		const root = tree({
			'proc/self/cgroup': '0::/\n',
			'proc/self/mountinfo': V2_MOUNTINFO,
			'sys/fs/cgroup/memory.max': `${CAP}\n`
		});
		expect(cgroupMemoryLimitBytes({ root, total: TOTAL })).toBe(CAP);
	});

	it('no limit anywhere ("max", the v1 sentinel, missing files): none', () => {
		const v2 = tree({
			'proc/self/cgroup': '0::/user.slice/session-1.scope\n',
			'proc/self/mountinfo': V2_MOUNTINFO,
			'sys/fs/cgroup/user.slice/memory.max': 'max\n'
		});
		expect(cgroupMemoryLimitBytes({ root: v2, total: TOTAL })).toBeNull();
	});

	it('falls back safely: no /proc/self/cgroup → the mount root files, as before', () => {
		const root = tree({ 'sys/fs/cgroup/memory.max': `${CAP}\n` });
		expect(cgroupMemoryLimitBytes({ root, total: TOTAL })).toBe(CAP);
		expect(cgroupMemoryLimitBytes({ root: tree({}), total: TOTAL })).toBeNull();
	});

	it('a path that tries to climb out of the mount is not followed', () => {
		const root = tree({
			'proc/self/cgroup': '0::/../../etc\n',
			'proc/self/mountinfo': V2_MOUNTINFO,
			'etc/memory.max': '1024\n'
		});
		expect(cgroupMemoryLimitBytes({ root, total: TOTAL })).toBeNull();
	});
});
