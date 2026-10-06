/**
 * Post-upgrade self-heal + upgrade step: the IPFS clean-up (v1.20.0, C16).
 *
 * Every node that hosts IPFS gets ops/ipfs/morphit-ipfs-gc.sh (as a root-owned
 * copy in /usr/local/lib/morphit) and its weekly timer — the Ansible ipfs role
 * does the same for new installs — and the clean-up runs once now. The script
 * decides from this node's own state what is superseded (see its header: the
 * anchored release + the previous one + anything newer + the one running; the
 * anchored snapshot + anything newer + two older), verifies each unpin on the
 * daemon itself, and reports one machine-readable line, which this reads back
 * and turns into one calm sentence. No network beyond the local indexer, so it
 * is the same on a tor-only node.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installHelperScript, DEFAULT_HELPER_DIR } from './refreshHelperScripts.ts';
import { installAndEnableUnits } from './installUnits.ts';

export interface IpfsGcRuntime {
	kuboPresent(): boolean;
	/** Script installed, units installed, timer running (verified). */
	install(): { ok: boolean; detail?: string };
	/** Run the clean-up once; its combined output. */
	run(): { status: number; output: string };
	spinner(label: string): () => void;
}

export interface IpfsGcSummary {
	readonly result: string;
	readonly unpinned: number;
	readonly stagedRemoved: number;
	readonly keptReleases: string;
	readonly keptSnapshots: string;
	readonly bytesBefore: number | null;
	readonly bytesAfter: number | null;
}

export type IpfsGcOutcome =
	| { kind: 'no-kubo' }
	| { kind: 'install-failed'; detail?: string }
	| { kind: 'ran'; summary: IpfsGcSummary }
	| { kind: 'no-summary' };

/** The script's last `MORPHIT_IPFS_GC …` line, parsed; null when absent. */
export function parseGcSummary(output: string): IpfsGcSummary | null {
	const line = output
		.split('\n')
		.filter((l) => l.startsWith('MORPHIT_IPFS_GC '))
		.pop();
	if (!line) return null;
	const kv = new Map<string, string>();
	for (const m of line.matchAll(/(\w+)=(\S*)/g)) kv.set(m[1]!, m[2]!);
	const num = (k: string): number | null => {
		const v = Number(kv.get(k));
		return kv.has(k) && Number.isFinite(v) ? v : null;
	};
	return {
		result: kv.get('result') ?? 'unknown',
		unpinned: num('unpinned') ?? 0,
		stagedRemoved: num('staged_removed') ?? 0,
		keptReleases: kv.get('kept_releases') ?? '-',
		keptSnapshots: kv.get('kept_snapshots') ?? '-',
		bytesBefore: num('repo_bytes_before'),
		bytesAfter: num('repo_bytes_after')
	};
}

const size = (n: number | null): string =>
	n === null
		? '?'
		: n >= 1024 * 1024
			? `${(n / 1024 / 1024).toFixed(1)} MB`
			: `${Math.round(n / 1024)} kB`;

export function runIpfsGcHeal(opts: {
	readonly runtime: IpfsGcRuntime;
	readonly info: (m: string) => void;
	readonly warn: (m: string) => void;
}): IpfsGcOutcome {
	const rt = opts.runtime;
	if (!rt.kuboPresent()) return { kind: 'no-kubo' };
	const inst = rt.install();
	if (!inst.ok) {
		opts.warn(
			`Could not set up the weekly IPFS clean-up (${inst.detail ?? 'unknown reason'}); IPFS keeps everything it holds, as before.`
		);
		return { kind: 'install-failed', detail: inst.detail };
	}
	const stop = rt.spinner('Letting go of superseded releases and snapshots on this node’s IPFS…');
	const r = rt.run();
	stop();
	const s = parseGcSummary(r.output);
	if (s === null) {
		opts.warn(
			'The IPFS clean-up did not report back this time; it runs again next week (weekly timer).'
		);
		return { kind: 'no-summary' };
	}
	const releases = s.keptReleases.split(',').filter((x) => x !== '' && x !== '-');
	const snapshots = s.keptSnapshots.split(',').filter((x) => x !== '' && x !== '-');
	const kept =
		`kept ${releases.length === 0 ? 'no release' : `release${releases.length === 1 ? '' : 's'} ${releases.join(', ')}`}` +
		` and ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}`;
	switch (s.result) {
		case 'done':
			opts.info(
				`IPFS clean-up: unpinned ${s.unpinned} superseded item(s)` +
					(s.stagedRemoved > 0 ? ` and removed ${s.stagedRemoved} staged snapshot file(s)` : '') +
					`; ${kept}; repo ${size(s.bytesBefore)} → ${size(s.bytesAfter)}.`
			);
			break;
		case 'nothing-to-do':
			// Nothing superseded: no line (the weekly timer keeps doing this).
			break;
		case 'no-daemon':
			opts.info(
				'IPFS clean-up: IPFS is not running right now, so nothing was changed; the weekly timer runs it later.'
			);
			break;
		default:
			opts.warn(
				`IPFS clean-up finished only in part (${s.unpinned} unpinned, ${s.stagedRemoved} staged file(s) removed); ` +
					'what could not be removed stays pinned. Details: `sudo journalctl -u morphit-ipfs-gc` on this node after its next weekly run.'
			);
	}
	return { kind: 'ran', summary: s };
}

function installRoot(): string {
	const env = (process.env.MORPHIT_INSTALL_DIR ?? '').trim();
	if (env !== '') return env;
	const m = /^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '');
	if (m && m[1] && existsSync(join(m[1], 'ops'))) return m[1];
	return '/opt/morphit';
}

/** The real entry point, run from runSelfHeals. */
export function healIpfsGc(deps: {
	readonly info: (m: string) => void;
	readonly warn: (m: string) => void;
	readonly spinner: (label: string) => () => void;
}): IpfsGcOutcome {
	const root = installRoot();
	const helperDir = process.env.MORPHIT_HELPER_DIR ?? DEFAULT_HELPER_DIR;
	const systemdDir = process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system';
	const noSystemd = process.env.MORPHIT_HEAL_NO_SYSTEMD === '1';
	const repo = process.env.IPFS_PATH ?? '/var/lib/ipfs/.ipfs';
	return runIpfsGcHeal({
		info: deps.info,
		warn: deps.warn,
		runtime: {
			kuboPresent: () =>
				existsSync(join(repo, 'config')) &&
				spawnSync('sh', ['-c', 'command -v ipfs'], { stdio: 'ignore' }).status === 0,
			install: () => {
				const s = installHelperScript({
					releaseRoot: root,
					name: 'morphit-ipfs-gc.sh',
					helperDir,
					log: deps.info
				});
				if (s === null) return { ok: false, detail: 'its script could not be installed' };
				const u = installAndEnableUnits({
					templateDir: join(root, 'ops', 'systemd'),
					systemdDir,
					units: ['morphit-ipfs-gc.service', 'morphit-ipfs-gc.timer'],
					timer: 'morphit-ipfs-gc.timer',
					noSystemd
				});
				return u.ok ? { ok: true } : { ok: false, detail: u.detail };
			},
			// A bounded run during the upgrade (repo gc gets 120 s here; the weekly
			// timer gives it longer). Same env the unit gives it.
			run: () => {
				const r = spawnSync('sh', [join(helperDir, 'morphit-ipfs-gc.sh')], {
					encoding: 'utf8',
					timeout: 240_000,
					env: { ...process.env, IPFS_PATH: repo, MORPHIT_IPFS_GC_TIMEOUT: '120' }
				});
				return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
			},
			spinner: deps.spinner
		}
	});
}
