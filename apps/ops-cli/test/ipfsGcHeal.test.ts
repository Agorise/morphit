/**
 * The IPFS clean-up self-heal (v1.20.0, C16): what it does with the clean-up
 * script's report, and the installers it relies on (a NEW helper script and
 * NEW systemd units on nodes installed before they existed). The script itself
 * is executed against a stub Kubo by scripts/ipfs-gc-smoke.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	lstatSync,
	symlinkSync,
	chmodSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseGcSummary, runIpfsGcHeal, type IpfsGcRuntime } from '../src/lib/ipfsGcHeal.ts';
import { installAndEnableUnits } from '../src/lib/installUnits.ts';
import { installHelperScript } from '../src/lib/refreshHelperScripts.ts';

let root = '';
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-ipfsgc-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const LINE =
	'MORPHIT_IPFS_GC result=done pins_before=13 pins_after=11 unpinned=2 staged_removed=2 kept_releases=v1.18.0,v1.19.0 kept_snapshots=200,300,400 repo_bytes_before=2097152 repo_bytes_after=1048576';

describe('parseGcSummary', () => {
	it('reads the last machine line, numbers as numbers', () => {
		const s = parseGcSummary(
			`morphit-ipfs-gc: unpinned …\nMORPHIT_IPFS_GC result=dry-run\n${LINE}\n`
		)!;
		expect(s).toEqual({
			result: 'done',
			unpinned: 2,
			stagedRemoved: 2,
			keptReleases: 'v1.18.0,v1.19.0',
			keptSnapshots: '200,300,400',
			bytesBefore: 2097152,
			bytesAfter: 1048576
		});
		expect(parseGcSummary('no summary here')).toBeNull();
		expect(parseGcSummary('MORPHIT_IPFS_GC result=no-daemon')!.bytesBefore).toBeNull();
	});
});

describe('runIpfsGcHeal', () => {
	const rt = (o: Partial<IpfsGcRuntime> & { calls?: string[] } = {}): IpfsGcRuntime => ({
		kuboPresent: () => true,
		install: () => {
			o.calls?.push('install');
			return { ok: true };
		},
		run: async () => {
			o.calls?.push('run');
			return { status: 0, output: LINE };
		},
		spinner: () => () => {},
		...o
	});
	it('does nothing at all on a node without Kubo', async () => {
		const calls: string[] = [];
		const out = await runIpfsGcHeal({
			runtime: rt({ calls, kuboPresent: () => false }),
			info: () => {},
			warn: () => {}
		});
		expect(out).toEqual({ kind: 'no-kubo' });
		expect(calls).toEqual([]);
	});
	it('installs first, then runs, and returns what the clean-up reported', async () => {
		const calls: string[] = [];
		const out = await runIpfsGcHeal({ runtime: rt({ calls }), info: () => {}, warn: () => {} });
		expect(calls).toEqual(['install', 'run']);
		expect(out.kind).toBe('ran');
		if (out.kind === 'ran') expect(out.summary.unpinned).toBe(2);
	});
	it('does not run the clean-up when it could not be installed', async () => {
		const calls: string[] = [];
		const out = await runIpfsGcHeal({
			runtime: rt({ calls, install: () => ({ ok: false, detail: 'x' }) }),
			info: () => {},
			warn: () => {}
		});
		expect(out.kind).toBe('install-failed');
		expect(calls).not.toContain('run');
	});
	it('a partial clean-up is a warning, a finished one is not', async () => {
		const warns: string[] = [];
		await runIpfsGcHeal({ runtime: rt(), info: () => {}, warn: (m) => warns.push(m) });
		expect(warns).toEqual([]);
		await runIpfsGcHeal({
			runtime: rt({
				run: async () => ({ status: 1, output: LINE.replace('result=done', 'result=partial') })
			}),
			info: () => {},
			warn: (m) => warns.push(m)
		});
		expect(warns).toHaveLength(1);
	});
});

describe('installHelperScript (a NEW helper on a node that never had it)', () => {
	const release = (): string => {
		const r = join(root, 'release');
		mkdirSync(join(r, 'ops', 'ipfs'), { recursive: true });
		writeFileSync(join(r, 'ops', 'ipfs', 'morphit-ipfs-gc.sh'), '#!/bin/sh\necho gc\n');
		return r;
	};
	it('installs it 0755 when absent, and is a no-op when identical', () => {
		const dir = join(root, 'lib');
		mkdirSync(dir);
		const p = installHelperScript({
			releaseRoot: release(),
			name: 'morphit-ipfs-gc.sh',
			helperDir: dir
		});
		expect(p).toBe(join(dir, 'morphit-ipfs-gc.sh'));
		expect(readFileSync(p!, 'utf8')).toBe('#!/bin/sh\necho gc\n');
		expect(lstatSync(p!).mode & 0o777).toBe(0o755);
		expect(
			installHelperScript({ releaseRoot: release(), name: 'morphit-ipfs-gc.sh', helperDir: dir })
		).toBe(p);
		expect(existsSync(`${p}.bak`)).toBe(false);
	});
	it('replaces an outdated copy (keeping .bak) and never writes through a link', () => {
		const dir = join(root, 'lib');
		mkdirSync(dir);
		writeFileSync(join(dir, 'morphit-ipfs-gc.sh'), 'old\n');
		chmodSync(join(dir, 'morphit-ipfs-gc.sh'), 0o700);
		installHelperScript({ releaseRoot: release(), name: 'morphit-ipfs-gc.sh', helperDir: dir });
		expect(readFileSync(join(dir, 'morphit-ipfs-gc.sh.bak'), 'utf8')).toBe('old\n');
		const dir2 = join(root, 'lib2');
		mkdirSync(dir2);
		writeFileSync(join(root, 'victim'), 'keep\n');
		symlinkSync(join(root, 'victim'), join(dir2, 'morphit-ipfs-gc.sh'));
		expect(
			installHelperScript({ releaseRoot: release(), name: 'morphit-ipfs-gc.sh', helperDir: dir2 })
		).toBeNull();
		expect(readFileSync(join(root, 'victim'), 'utf8')).toBe('keep\n');
	});
	it('refuses a name that is not a Morphit helper', () => {
		expect(
			installHelperScript({ releaseRoot: release(), name: 'evil.sh', helperDir: root })
		).toBeNull();
	});
});

describe('installAndEnableUnits', () => {
	const setup = () => {
		const tpl = join(root, 'tpl');
		const sd = join(root, 'sd');
		mkdirSync(tpl);
		mkdirSync(sd);
		writeFileSync(join(tpl, 'x.service'), '[Service]\nExecStart=/bin/true\n');
		writeFileSync(join(tpl, 'x.timer'), '[Timer]\nOnBootSec=1h\n');
		return { tpl, sd };
	};
	it('writes the units, reloads, enables --now, and requires the timer to be seen enabled + active', () => {
		const { tpl, sd } = setup();
		const calls: string[] = [];
		const exec = (cmd: string, args: readonly string[]) => {
			calls.push(`${cmd} ${args.join(' ')}`);
			if (args[0] === 'is-enabled') return { status: 0, stdout: 'enabled\n' };
			if (args[0] === 'is-active') return { status: 0, stdout: 'active\n' };
			return { status: 0, stdout: '' };
		};
		const r = installAndEnableUnits({
			templateDir: tpl,
			systemdDir: sd,
			units: ['x.service', 'x.timer'],
			timer: 'x.timer',
			exec
		});
		expect(r).toEqual({ ok: true, written: ['x.service', 'x.timer'], timerRunning: true });
		expect(readFileSync(join(sd, 'x.timer'), 'utf8')).toBe('[Timer]\nOnBootSec=1h\n');
		expect(calls).toEqual([
			'systemctl daemon-reload',
			'systemctl enable --now x.timer',
			'systemctl is-enabled x.timer',
			'systemctl is-active x.timer'
		]);
		// Identical files: nothing written, no reload.
		calls.length = 0;
		expect(
			installAndEnableUnits({
				templateDir: tpl,
				systemdDir: sd,
				units: ['x.service', 'x.timer'],
				timer: 'x.timer',
				exec
			}).written
		).toEqual([]);
		expect(calls).not.toContain('systemctl daemon-reload');
	});
	it('is not ok when systemd does not show the timer running', () => {
		const { tpl, sd } = setup();
		const r = installAndEnableUnits({
			templateDir: tpl,
			systemdDir: sd,
			units: ['x.service', 'x.timer'],
			timer: 'x.timer',
			exec: (_c, a) => ({ status: 0, stdout: a[0] === 'is-active' ? 'inactive\n' : 'enabled\n' })
		});
		expect(r.ok).toBe(false);
		expect(r.timerRunning).toBe(false);
	});
	it('never writes through a link at the destination', () => {
		const { tpl, sd } = setup();
		writeFileSync(join(root, 'victim'), 'keep\n');
		symlinkSync(join(root, 'victim'), join(sd, 'x.service'));
		const r = installAndEnableUnits({
			templateDir: tpl,
			systemdDir: sd,
			units: ['x.service'],
			timer: 'x.timer',
			noSystemd: true
		});
		expect(r.ok).toBe(false);
		expect(readFileSync(join(root, 'victim'), 'utf8')).toBe('keep\n');
	});
});
