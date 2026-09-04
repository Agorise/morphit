/**
 * memoryBudget — how much RAM this process may safely use, and how much it is
 * using now. Used by the flow-backfill governor to size its reorder buffer so a
 * catch-up on a big VPS buffers aggressively while a low-RAM a mini PC (or a
 * systemd-`MemoryMax`ed / containerised node) stays within its slice.
 *
 * Budget resolution, most-specific first:
 *   1. cgroup v2  /sys/fs/cgroup/memory.max            (Ubuntu 24.04 default)
 *   2. cgroup v1  /sys/fs/cgroup/memory/memory.limit_in_bytes
 *   3. os.totalmem()                                   (no cgroup limit)
 * A cgroup "max" / unset / implausibly-large value (the kernel's ~unlimited
 * sentinel) is treated as "no limit" → falls through to os.totalmem().
 */
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

/** Above this multiple of physical RAM, a cgroup value is the kernel's
 *  effectively-unlimited sentinel, not a real cap. */
const UNLIMITED_FACTOR = 4;

function readCgroupLimit(): number | null {
	const total = totalmem();
	// cgroup v2
	try {
		const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
		if (raw === 'max') return null;
		const n = Number(raw);
		if (Number.isFinite(n) && n > 0 && n < total * UNLIMITED_FACTOR) return n;
	} catch {
		/* not v2 */
	}
	// cgroup v1
	try {
		const raw = readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
		const n = Number(raw);
		if (Number.isFinite(n) && n > 0 && n < total * UNLIMITED_FACTOR) return n;
	} catch {
		/* not v1 */
	}
	return null;
}

/** Total RAM this process may treat as its ceiling (cgroup limit or physical). */
export function memoryBudgetBytes(): number {
	return readCgroupLimit() ?? totalmem();
}

/** Resident set size of this process right now. */
export function processRssBytes(): number {
	return process.memoryUsage().rss;
}
