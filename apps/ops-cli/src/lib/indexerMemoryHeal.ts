/**
 * Installed-box heal: the indexer's memory is capped (systemd MemoryMax), so a
 * burst of large requests cannot take the whole box.
 *
 * WHY. Nothing bounded the indexer's memory. Twelve concurrent 10,000-entry
 * history requests took it past 2 GB (the verifier's measurement); on a 2–4 GB
 * VPS or a home mini PC that kills the indexer, or Postgres or Tor next to it
 * through the kernel's OOM killer. The route now caps large reads itself; the
 * unit cap is the outer bound. The relay and the MCP server already had one.
 *
 * SIZE. Measured on the real indexer (tsx, both of its processes) against
 * three local Blurt-shaped nodes: idle after a 30,000-block catch-up 278 MiB;
 * a 150,000-block flow catch-up with a 384 MiB reorder buffer, plus history
 * and API load, 593 MiB; the history route at its own cap (two honest
 * 10,000-entry pages in flight), 667 MiB resident, 735 MiB as the sum of each
 * process's own peak. The cap, 1536 MiB, is about twice that highest figure:
 * room for a fuller database and for the garbage collector's lag, while still
 * well short of the whole of a small box.
 *
 * WHAT, on this server: ops/systemd/morphit-indexer.service carries
 * MemoryMax=1536M, and `morphit-ops upgrade` refreshes that unit. This heal
 * reads what systemd really applies:
 *   - the unit's MemoryMax as systemd resolved it (unit file and drop-ins);
 *     none → a drop-in (morphit-indexer.service.d/morphit-memory-max.conf)
 *     and a daemon-reload, read back; a cap an operator set on purpose (any
 *     other value) is kept. A daemon-reload applies the cap to the running
 *     indexer at once (observed with systemd 255 on a real kernel), so the
 *     drop-in is added only while the indexer uses under 80% of the cap;
 *   - the RUNNING indexer's cgroup (memory.max, or memory.limit_in_bytes on
 *     cgroup v1). When it still differs, the cap is applied to the running
 *     service (`systemctl set-property --runtime`) only while the indexer uses
 *     well under it (a lower cap than its current use would make the kernel
 *     kill it); otherwise it takes effect at its next restart, and the heal
 *     says so with the command.
 * VERIFY: the cgroup file is read back. FALL BACK: a drop-in systemd does not
 * take is removed again.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';

export const INDEXER_UNIT = 'morphit-indexer.service';
/** The highest honest figure measured (see SIZE above), in MiB. */
export const INDEXER_HONEST_PEAK_MIB = 735;
export const INDEXER_MEMORY_MAX = '1536M';
export const INDEXER_MEMORY_MAX_BYTES = 1536 * 1024 * 1024;
export const MEMORY_DROPIN = 'morphit-memory-max.conf';
/** Applied to the running service only while it uses less than this share of
 *  the cap. */
const LIVE_HEADROOM = 0.8;

export interface MemoryRuntime {
	/** `systemctl show -p A -p B … unit` as key → value; null when systemctl
	 *  could not be asked. */
	show(unit: string, props: readonly string[]): Record<string, string> | null;
	readFile(path: string): string | null;
	/** Root-owned, mode 0644, atomically; false on failure. */
	writeFile(path: string, data: string): boolean;
	removeFile(path: string): boolean;
	run(cmd: string, args: readonly string[]): boolean;
}

/** A systemd or cgroup memory value in bytes; "infinity"/"max"/empty → no cap. PURE. */
export function memoryValue(raw: string | null | undefined): number {
	const v = (raw ?? '').trim();
	if (!/^\d+$/.test(v)) return Number.POSITIVE_INFINITY;
	const n = Number(v);
	// cgroup v1's "no limit" is a page-rounded 2^63.
	return n >= 2 ** 62 ? Number.POSITIVE_INFINITY : n;
}

const mib = (b: number): string => `${Math.round(b / 1048576)} MiB`;

export async function healIndexerMemory(
	ctx: HealCtx,
	opts: {
		readonly systemdDir?: string;
		readonly cgroupRoot?: string;
		readonly runtime?: MemoryRuntime;
	} = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime();
	const sysd = opts.systemdDir ?? '/etc/systemd/system';
	const cgRoot = opts.cgroupRoot ?? '/sys/fs/cgroup';
	const dropin = join(sysd, `${INDEXER_UNIT}.d`, MEMORY_DROPIN);
	const props = ['LoadState', 'ActiveState', 'MemoryMax', 'ControlGroup'] as const;
	const look = (): Record<string, string> | null => rt.show(INDEXER_UNIT, props);

	let s = look();
	if (s === null)
		return {
			strategy: 'unchecked',
			verified: false,
			detail:
				'Indexer memory cap: systemd could not be asked on this server, so nothing was changed. Check it on this server with: systemctl show -p MemoryMax morphit-indexer'
		};
	if (s.LoadState !== 'loaded')
		return {
			strategy: 'not-installed',
			verified: true,
			detail: 'Indexer memory cap: no indexer service on this server.'
		};

	// The running indexer's cgroup (v2, or the v1 memory hierarchy).
	const group = s.ControlGroup ?? '';
	const cg = join(cgRoot, group);
	const v1 = join(cgRoot, 'memory', group);
	const liveCap = (): number | null => {
		const v2 = rt.readFile(join(cg, 'memory.max'));
		if (v2 !== null) return v2.trim() === 'max' ? Number.POSITIVE_INFINITY : memoryValue(v2);
		const old = rt.readFile(join(v1, 'memory.limit_in_bytes'));
		return old === null ? null : memoryValue(old);
	};
	const inUse = (): number | null => {
		const v =
			rt.readFile(join(cg, 'memory.current')) ?? rt.readFile(join(v1, 'memory.usage_in_bytes'));
		return v === null || !/^\d+$/.test(v.trim()) ? null : Number(v.trim());
	};

	const running = s.ActiveState === 'active' && group !== '';

	let strategy = 'already';
	let configured = memoryValue(s.MemoryMax);
	if (configured === Number.POSITIVE_INFINITY) {
		// A daemon-reload applies the cap to the RUNNING indexer at once
		// (observed with systemd 255), so it is added only while the indexer
		// uses well under it; otherwise the kernel could stop it mid-upgrade.
		const usedNow = running ? inUse() : 0;
		if (usedNow === null || usedNow >= INDEXER_MEMORY_MAX_BYTES * LIVE_HEADROOM)
			return {
				strategy: 'deferred',
				verified: false,
				detail:
					`Indexer memory cap: not added this time — ${usedNow === null ? 'the running indexer’s memory use could not be read' : `the indexer uses ${mib(usedNow)} now, too close to the ${INDEXER_MEMORY_MAX} cap to add it while it runs`}; nothing was changed. ` +
					`The next \`sudo morphit-ops upgrade --heals\` on this server tries again, or add it now on this server: sudo systemctl edit morphit-indexer, with "[Service]" and "MemoryMax=${INDEXER_MEMORY_MAX}", then sudo systemctl restart morphit-indexer`
			};
		const stop = ctx.spinner('Capping the indexer’s memory (systemd reload)');
		const wrote = rt.writeFile(dropin, `[Service]\nMemoryMax=${INDEXER_MEMORY_MAX}\n`);
		if (wrote) rt.run('systemctl', ['daemon-reload']);
		stop();
		s = look() ?? s;
		configured = memoryValue(s.MemoryMax);
		if (!wrote || configured === Number.POSITIVE_INFINITY) {
			if (wrote && rt.removeFile(dropin)) rt.run('systemctl', ['daemon-reload']);
			return {
				strategy: 'not-applied',
				verified: false,
				detail:
					`Indexer memory cap: systemd did not take the ${INDEXER_MEMORY_MAX} cap, so the indexer runs without one as before (nothing else changed). ` +
					`On this server: sudo systemctl edit morphit-indexer, add "[Service]" and "MemoryMax=${INDEXER_MEMORY_MAX}", then sudo systemctl restart morphit-indexer`
			};
		}
		strategy = 'applied';
	} else if (configured !== INDEXER_MEMORY_MAX_BYTES) {
		strategy = 'operator-cap';
	}
	const capText =
		strategy === 'operator-cap'
			? `${mib(configured)} (the cap set on this server, kept)`
			: mib(configured);

	if (!running)
		return {
			strategy,
			verified: true,
			detail: `Indexer memory cap: ${capText}, read back from systemd; it applies when the indexer starts.`
		};

	let live = liveCap();
	if (live === configured)
		return {
			strategy,
			verified: true,
			detail: `Indexer memory cap: ${capText}, read back from the running indexer.`
		};
	const used = inUse();
	if (live !== null && used !== null && used < configured * LIVE_HEADROOM) {
		rt.run('systemctl', ['set-property', '--runtime', INDEXER_UNIT, `MemoryMax=${configured}`]);
		live = liveCap();
		if (live === configured)
			return {
				strategy: strategy === 'already' ? 'applied-live' : strategy,
				verified: true,
				detail: `Indexer memory cap: ${capText}, read back from the running indexer.`
			};
	}
	const why =
		live === null
			? 'its running limit could not be read'
			: used !== null && used >= configured * LIVE_HEADROOM
				? `it uses ${mib(used)} now, too close to the cap to apply it while it runs`
				: 'the running service did not take it';
	return {
		strategy: 'at-next-restart',
		verified: false,
		detail:
			`Indexer memory cap: ${capText} is set for the indexer, and takes effect when it next restarts (${why}). ` +
			'To apply it now, on this server: sudo systemctl restart morphit-indexer'
	};
}

export function heal(ctx: HealCtx): Promise<HealResult> {
	return healIndexerMemory(ctx);
}

// ─── runtime ────────────────────────────────────────────────────────────

export function realRuntime(): MemoryRuntime {
	return {
		show: (unit, props) => {
			const r = spawnSync('systemctl', ['show', ...props.flatMap((p) => ['-p', p]), unit], {
				encoding: 'utf8',
				timeout: 20_000
			});
			if (r.status !== 0) return null;
			const out: Record<string, string> = {};
			for (const line of `${r.stdout ?? ''}`.split('\n')) {
				const i = line.indexOf('=');
				if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
			}
			return out;
		},
		readFile: (p) => {
			try {
				return readFileSync(p, 'utf8');
			} catch {
				return null;
			}
		},
		writeFile: (p, data) => {
			const tmp = `${p}.tmp-${process.pid}`;
			try {
				if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true, mode: 0o755 });
				writeFileSync(tmp, data, { mode: 0o644 });
				renameSync(tmp, p);
				return true;
			} catch {
				rmSync(tmp, { force: true });
				return false;
			}
		},
		removeFile: (p) => {
			try {
				rmSync(p, { force: true });
				return true;
			} catch {
				return false;
			}
		},
		run: (cmd, args) => spawnSync(cmd, args as string[], { timeout: 60_000 }).status === 0
	};
}
