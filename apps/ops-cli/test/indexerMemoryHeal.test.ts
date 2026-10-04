import { describe, expect, it } from 'vitest';
import {
	INDEXER_MEMORY_MAX_BYTES,
	MEMORY_DROPIN,
	healIndexerMemory,
	memoryValue,
	type MemoryRuntime
} from '../src/lib/indexerMemoryHeal.ts';

const SYSD = '/etc/systemd/system';
const CG = '/sys/fs/cgroup';
const CGROUP = '/system.slice/morphit-indexer.service';
const DROPIN = `${SYSD}/morphit-indexer.service.d/${MEMORY_DROPIN}`;
const MiB = 1024 * 1024;

/** systemd and the kernel as far as this heal sees them. */
class Box {
	installed = true;
	active = true;
	/** MemoryMax in the unit file itself (bytes), or none. */
	unitMax: number | null = null;
	/** Another drop-in an operator wrote (bytes), or none. */
	operatorMax: number | null = null;
	/** Does a daemon-reload re-apply cgroup limits to the running service? */
	reloadRealizes = false;
	/** Does systemd take our drop-in at all? */
	takesDropin = true;
	setPropertyWorks = true;
	used = 300 * MiB;
	cgroupMax = 'max';
	files = new Map<string, string>();
	calls: string[][] = [];
	effective(): number | null {
		const ours = this.files.get(DROPIN);
		const fromOurs =
			ours && this.takesDropin ? Number(/MemoryMax=(\d+)M/.exec(ours)![1]) * MiB : null;
		// drop-ins sort by name; an operator's override.conf comes after ours
		return this.operatorMax ?? fromOurs ?? this.unitMax;
	}
	rt: MemoryRuntime = {
		show: (_u, props) => {
			const all: Record<string, string> = {
				LoadState: this.installed ? 'loaded' : 'not-found',
				ActiveState: this.active ? 'active' : 'inactive',
				MemoryMax: String(this.effective() ?? 'infinity'),
				ControlGroup: this.active ? CGROUP : ''
			};
			return Object.fromEntries(props.map((p) => [p, all[p] ?? '']));
		},
		readFile: (p) => {
			if (p === `${CG}${CGROUP}/memory.max`) return this.active ? `${this.cgroupMax}\n` : null;
			if (p === `${CG}${CGROUP}/memory.current`) return this.active ? `${this.used}\n` : null;
			return this.files.get(p) ?? null;
		},
		writeFile: (p, d) => {
			this.files.set(p, d);
			return true;
		},
		removeFile: (p) => {
			this.files.delete(p);
			return true;
		},
		run: (cmd, args) => {
			this.calls.push([cmd, ...args]);
			if (args[0] === 'daemon-reload' && this.reloadRealizes && this.active) {
				const e = this.effective();
				this.cgroupMax = e === null ? 'max' : String(e);
			}
			if (args[0] === 'set-property' && this.setPropertyWorks) {
				const v = /MemoryMax=(\d+)/.exec(args[3] ?? '')![1]!;
				if (this.used >= Number(v)) throw new Error('the kernel would kill it');
				this.cgroupMax = v;
			}
			return true;
		}
	};
	run() {
		return healIndexerMemory(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ systemdDir: SYSD, cgroupRoot: CG, runtime: this.rt }
		);
	}
	setProps() {
		return this.calls.filter((c) => c[1] === 'set-property');
	}
}

describe('the indexer gets a memory cap on an installed box, read back from its running cgroup', () => {
	it('no cap anywhere: a drop-in, then the running indexer is capped too (its use is well under)', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.files.has(DROPIN)).toBe(true);
		expect(b.cgroupMax).toBe(String(INDEXER_MEMORY_MAX_BYTES));
	});

	it('when the reload already applies it, nothing else is done to the running service', async () => {
		const b = new Box();
		b.reloadRealizes = true;
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.cgroupMax).toBe(String(INDEXER_MEMORY_MAX_BYTES));
		expect(b.setProps()).toEqual([]);
	});

	it('the refreshed unit already carries the cap but the running indexer does not: applied live, no drop-in', async () => {
		const b = new Box();
		b.unitMax = INDEXER_MEMORY_MAX_BYTES;
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.files.has(DROPIN)).toBe(false);
		expect(b.cgroupMax).toBe(String(INDEXER_MEMORY_MAX_BYTES));
	});

	it('an indexer already close to the cap is never capped while it runs (a reload would apply it at once): nothing is written or reloaded', async () => {
		const b = new Box();
		b.reloadRealizes = true;
		b.used = 1400 * MiB;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(b.files.has(DROPIN)).toBe(false);
		expect(b.calls).toEqual([]);
		expect(b.cgroupMax).toBe('max');
	});

	it('the shipped cap is set but the running indexer is close to it: not applied live; it applies at its restart', async () => {
		const b = new Box();
		b.unitMax = INDEXER_MEMORY_MAX_BYTES;
		b.used = 1400 * MiB;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(b.setProps()).toEqual([]);
		expect(b.cgroupMax).toBe('max');
	});

	it("an operator's own cap is kept, and checked", async () => {
		const b = new Box();
		b.operatorMax = 3072 * MiB;
		b.cgroupMax = String(3072 * MiB);
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.files.has(DROPIN)).toBe(false);
		expect(b.cgroupMax).toBe(String(3072 * MiB));
	});

	it('systemd does not take the drop-in: it is removed again and nothing is claimed', async () => {
		const b = new Box();
		b.takesDropin = false;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(b.files.has(DROPIN)).toBe(false);
		expect(b.cgroupMax).toBe('max');
	});

	it('a stopped indexer: the cap is set and read back from systemd, nothing is started', async () => {
		const b = new Box();
		b.active = false;
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.files.has(DROPIN)).toBe(true);
		expect(b.calls.filter((c) => c[1] === 'start' || c[1] === 'restart')).toEqual([]);
	});

	it('no indexer on this server: nothing is written', async () => {
		const b = new Box();
		b.installed = false;
		await b.run();
		expect(b.files.size).toBe(0);
		expect(b.calls).toEqual([]);
	});

	it('a second run changes nothing', async () => {
		const b = new Box();
		await b.run();
		const calls = b.calls.length;
		const again = await b.run();
		expect(again.verified).toBe(true);
		expect(b.calls.length).toBe(calls);
	});

	it('reads systemd and cgroup values: bytes, "infinity", "max", cgroup v1 no-limit', () => {
		expect(memoryValue('1610612736')).toBe(1536 * MiB);
		expect(memoryValue('infinity')).toBe(Number.POSITIVE_INFINITY);
		expect(memoryValue('max')).toBe(Number.POSITIVE_INFINITY);
		expect(memoryValue('9223372036854771712')).toBe(Number.POSITIVE_INFINITY);
	});
});
