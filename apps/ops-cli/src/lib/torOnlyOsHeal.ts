/**
 * Post-upgrade self-heal: take a TOR-ONLY node's own operating system off
 * clearnet (v1.20.0, C13) — apt over Tor, no clearnet NTP, no Ubuntu news
 * fetches. Existing tor-only nodes get exactly what a fresh tor-only install
 * now gets from the Ansible tor role (both drive ops/tor-only/morphit-tor-only-os.sh).
 *
 * A node that is not hidden-only (empty clearnet RPC pool in indexer.env) is
 * never touched: its apt and NTP stay exactly as they are.
 *
 * APT — verify, then keep; otherwise put it back:
 *   1. Tor must answer on its SocksPort first; if it does not, nothing changes.
 *   2. apt's Tor transport (apt-transport-tor: the tor+http/tor+https drivers)
 *      is made present, trying in order: already there → the .deb in this
 *      release's offline bundle (vendor/apt) → `apt-get install` fetched over
 *      Tor (a socks5h proxy on the command line, so even that download never
 *      touches clearnet) → the two driver links the package itself consists
 *      of. Each is VERIFIED (the drivers resolve and are executable), and the
 *      one that worked is named.
 *   3. The sources are switched (backed up first) and the switch is PROVEN on
 *      the running system: `apt-get update` must fetch over Tor. If it cannot
 *      (retried once), every file is put back byte for byte and apt stays as
 *      it was — a calm note, never an alarm. The next upgrade tries again.
 *   A marker written BEFORE the switch (and removed after the verdict) makes
 *   this safe to interrupt: an upgrade killed mid-verification leaves the
 *   marker, and the next run finishes verifying — or reverts — instead of
 *   trusting an unverified switch.
 *
 * TIME — the clock only stops using public NTP once Tor time is seen working:
 *   the Tor time check (morphit-tor-timesync) is installed with its 6-hourly
 *   timer and RUN once now; only when enough onion sources agree is chrony
 *   stripped of its network sources, restarted, and then observed to have zero
 *   sources. If chrony still shows sources, chrony is stopped (the time check
 *   keeps the clock); if even that fails, its config is put back. When the
 *   time check cannot reach consensus, chrony keeps its current servers and a
 *   calm note says the next upgrade finishes the switch.
 *
 * NEWS — motd news and Ubuntu Pro apt news off, checked after.
 */
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	appendFileSync,
	statSync
} from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { isHiddenOnlyNode, indexerEnvFiles } from './hiddenOnly.ts';
import { installHelperScript, DEFAULT_HELPER_DIR } from './refreshHelperScripts.ts';
import { installAndEnableUnits } from './installUnits.ts';
import { SELF_HEAL_CHILD_TIMEOUT_MS } from './proxyConfigHeal.ts';

export interface ScriptRun {
	readonly status: number;
	readonly output: string;
}

export interface TransportStrategy {
	readonly name: string;
	/** Try it; the caller then checks the drivers itself. */
	run(): boolean;
}

export interface TorOnlyOsRuntime {
	/** morphit-tor-only-os.sh <mode> [backup-dir]; `limits` bounds a slow mode
	 *  (apt-verify): the process is ended at `timeoutMs`, and `env` is added. */
	script(
		mode: string,
		backupDir?: string,
		limits?: { readonly timeoutMs: number; readonly env?: Readonly<Record<string, string>> }
	): ScriptRun;
	/** Tor's SocksPort completes a SOCKS5 greeting. */
	torAnswers(): Promise<boolean>;
	/** /usr/lib/apt/methods/tor+http and tor+https exist and are executable. */
	aptTransportPresent(): boolean;
	/** Ways to get the drivers, in order; `created` is where a strategy records
	 *  files it created so a revert removes them. */
	aptTransportStrategies(created: string, timeoutMs: number): readonly TransportStrategy[];
	/** A new, empty, root-only backup directory for one part. */
	newBackupDir(part: string): string | null;
	readMarker(name: string): string | null;
	writeMarker(name: string, value: string): boolean;
	clearMarker(name: string): void;
	/** Tor time check script + units in place and its timer running. */
	installTimeCheck(): { ok: boolean; detail?: string };
	/** The unit that verifies-or-reverts a switch left unchecked (after boot,
	 *  then every 6 hours) is in place and its timer running. */
	installRecover(): { ok: boolean; detail?: string };
	/** Run the Tor time check once, measuring only, ended at `timeoutMs`. */
	runTimeCheck(timeoutMs: number): ScriptRun;
	/** Milliseconds since the epoch (tests drive it). */
	now(): number;
	chronyPresent(): boolean;
	chronyActive(): boolean;
	restartChrony(): boolean;
	/** Sources chronyd is using right now; null when chronyc cannot say. */
	chronySourceCount(): number | null;
	stopDisableChrony(): boolean;
	timesyncdActive(): boolean;
	disableTimesyncd(): boolean;
	sleep(ms: number): Promise<void>;
	spinner(label: string): () => void;
}

export type AptOutcome =
	| 'not-tor-only'
	| 'already'
	| 'tor-not-answering'
	| 'no-transport'
	| 'apply-failed'
	| 'switched'
	| 'config-only'
	| 'deferred'
	| 'reverted';
export type TimeOutcome =
	| 'not-tor-only'
	| 'already'
	| 'units-failed'
	| 'no-consensus'
	| 'switched'
	| 'chrony-stopped'
	| 'timesyncd-off'
	| 'no-ntp-client'
	| 'deferred'
	| 'reverted';
export type NewsOutcome = 'not-tor-only' | 'already' | 'switched' | 'reverted';

export interface TorOnlyOsOutcome {
	readonly apt: AptOutcome;
	readonly aptTransport?: string;
	readonly time: TimeOutcome;
	readonly news: NewsOutcome;
}

/** An apt refresh over Tor needs at least this long to be worth starting (the
 *  package lists are cached, so it re-checks a few index files). */
export const APT_VERIFY_MIN_MS = 90_000;
/** Kept in hand after the verify, to put apt back if it did not work. */
export const REVERT_MARGIN_MS = 15_000;
/** The Tor time check (six requests in parallel, 90 s each at most). */
export const TIME_CHECK_MIN_MS = 110_000;
/** Inside the re-exec'd self-heal child this heal stops by this long after it
 *  starts, so the heals after it still have time (the child is killed at
 *  SELF_HEAL_CHILD_TIMEOUT_MS; anything left over is finished by
 *  morphit-tor-only-recover.timer or the next upgrade). */
export const CHILD_HEAL_BUDGET_MS = 180_000;

const lastLine = (s: string, prefix: string): string =>
	s
		.split('\n')
		.filter((l) => l.startsWith(prefix))
		.pop() ?? '';

async function healApt(
	rt: TorOnlyOsRuntime,
	info: (m: string) => void,
	warn: (m: string) => void,
	socks: string,
	hardStopAt: number
): Promise<{ apt: AptOutcome; aptTransport?: string }> {
	const left = (): number => hardStopAt - rt.now();
	const pending = rt.readMarker('apt.pending');
	const unverified = rt.readMarker('apt.unverified');
	if (pending === null && unverified === null && rt.script('apt-check').status === 0) {
		return { apt: 'already' };
	}

	// Put back exactly what was backed up; say so plainly if that did not work.
	const revert = (bk: string): boolean => {
		const ok = rt.script('apt-revert', bk).status === 0;
		rt.clearMarker('apt.pending');
		rt.clearMarker('apt.unverified');
		if (!ok) {
			warn(
				`Could not put every one of apt's previous settings back; the originals are kept in ${bk}.`
			);
		}
		return ok;
	};

	let stop = rt.spinner(`Checking that Tor answers on ${socks}…`);
	const torUp = await rt.torAnswers();
	stop();
	const earlier = pending ?? unverified;
	if (!torUp) {
		if (earlier !== null) {
			// An earlier switch was never verified and cannot be now: put it back.
			revert(earlier);
			info(
				'apt had been switched to Tor by an earlier run that could not finish checking it, and Tor is not ' +
					'answering right now, so apt\u2019s previous settings were put back. The next ' +
					'`sudo morphit-ops upgrade` on this node tries again.'
			);
			return { apt: 'reverted' };
		}
		info(
			`Tor is not answering on ${socks} right now, so apt keeps its current settings. ` +
				'The next `sudo morphit-ops upgrade` on this node switches apt to Tor.'
		);
		return { apt: 'tor-not-answering' };
	}

	// Not enough time left to switch AND prove it (the upgrade's self-heal is
	// stopped at a fixed time): never leave a switch unverified. An earlier,
	// unchecked switch is put back now; a new one waits for the next run.
	if (left() < APT_VERIFY_MIN_MS + REVERT_MARGIN_MS) {
		if (earlier !== null) {
			revert(earlier);
			info(
				'apt had been switched to Tor by an earlier run that could not finish checking it; there is not ' +
					'enough time left in this upgrade to check it now, so apt\u2019s previous settings were put back. ' +
					'The next `sudo morphit-ops upgrade` on this node finishes the switch.'
			);
			return { apt: 'reverted' };
		}
		info(
			'Not enough time left in this upgrade to move apt to Tor and check it, so apt keeps its current ' +
				'settings for now. The next `sudo morphit-ops upgrade` on this node does it.'
		);
		return { apt: 'deferred' };
	}

	// The backup dir and the "not verified yet" marker exist BEFORE anything
	// changes, so an interrupted run is finished (or undone) by the next one
	// or by morphit-tor-only-recover.timer.
	let bk = earlier;
	if (bk === null) {
		bk = rt.newBackupDir('apt');
		if (bk === null) {
			warn(
				'Skipped moving apt to Tor: could not create a place to keep a backup of its settings first.'
			);
			return { apt: 'apply-failed' };
		}
	}
	// The safety net for a switch that this run cannot finish checking (the
	// process is killed, the box loses power): it verifies or reverts it.
	const net = rt.installRecover();
	if (!net.ok) {
		warn(
			`Skipped moving apt to Tor: could not set up the check that finishes an interrupted switch (${net.detail ?? 'unknown reason'}).`
		);
		if (earlier !== null) revert(earlier);
		return { apt: earlier !== null ? 'reverted' : 'apply-failed' };
	}
	if (!rt.writeMarker('apt.pending', bk)) {
		warn('Skipped moving apt to Tor: could not record the switch before making it.');
		return { apt: 'apply-failed' };
	}

	// The Tor transport: the first strategy that is SEEN to work.
	let transport: string | undefined;
	if (rt.aptTransportPresent()) {
		transport = 'already installed';
	} else {
		const tBudget = Math.min(
			600_000,
			Math.max(20_000, left() - APT_VERIFY_MIN_MS - REVERT_MARGIN_MS)
		);
		for (const s of rt.aptTransportStrategies(join(bk, 'created'), tBudget)) {
			stop = rt.spinner(`Installing apt's Tor transport (${s.name})…`);
			let ran = false;
			try {
				ran = s.run();
			} catch {
				ran = false;
			}
			stop();
			if (ran && rt.aptTransportPresent()) {
				transport = s.name;
				break;
			}
		}
		if (transport === undefined) {
			revert(bk);
			warn(
				'apt stays as it is for now: its Tor transport (apt-transport-tor) could not be installed on this node. ' +
					'The next `sudo morphit-ops upgrade` tries again.'
			);
			return { apt: 'no-transport' };
		}
	}
	if (left() < APT_VERIFY_MIN_MS + REVERT_MARGIN_MS) {
		// The transport took the time; it stays installed (harmless), nothing else changed.
		revert(bk);
		info(
			'apt\u2019s Tor transport is installed; not enough time is left in this upgrade to switch apt over ' +
				'and check it, so that is left for the next `sudo morphit-ops upgrade` on this node.'
		);
		return { apt: 'deferred', aptTransport: transport };
	}
	// Idempotent: a finished or half-finished earlier apply is completed, and the
	// backup keeps the ORIGINAL files either way.
	if (rt.script('apt-apply', bk).status !== 0) {
		revert(bk);
		warn(
			'Could not switch apt to Tor; its previous settings were put back and nothing else changed.'
		);
		return { apt: 'apply-failed', aptTransport: transport };
	}

	// VERIFY on the running system: an apt refresh over Tor.
	let v: ScriptRun = { status: 1, output: '' };
	for (let attempt = 1; attempt <= 2; attempt++) {
		// Bounded by the time left (minus what a put-back needs): the script ends
		// apt-get itself at its deadline, and the process is ended a little later.
		const budget = Math.min(900_000, left() - REVERT_MARGIN_MS);
		const secs = Math.max(5, Math.floor(budget / 1000) - 5);
		stop = rt.spinner(
			attempt === 1
				? 'Refreshing the package lists over Tor to prove apt works through it…'
				: 'Trying the package-list refresh over Tor once more…'
		);
		v = rt.script('apt-verify', undefined, {
			timeoutMs: Math.max(10_000, budget),
			env: {
				MORPHIT_APT_VERIFY_TIMEOUT: String(secs),
				MORPHIT_APT_LOCK_WAIT: String(Math.min(300, Math.floor(secs / 2)))
			}
		});
		stop();
		if (v.status === 0 || v.status === 10 || v.status === 3) break;
		if (attempt === 1) {
			if (left() < 20_000 + APT_VERIFY_MIN_MS + REVERT_MARGIN_MS) break;
			stop = rt.spinner('Giving Tor a moment to build fresh circuits…');
			await rt.sleep(20_000);
			stop();
		}
	}
	if (v.status === 0) {
		rt.clearMarker('apt.pending');
		rt.clearMarker('apt.unverified');
		info(
			'apt now fetches updates over Tor (daily security updates included) — Tor transport: ' +
				`${transport}.`
		);
		return { apt: 'switched', aptTransport: transport };
	}
	if (v.status === 10) {
		rt.writeMarker('apt.unverified', bk);
		rt.clearMarker('apt.pending');
		info(
			'apt is set to fetch over Tor. This node is still in its offline-install phase, so its first ' +
				'refresh over Tor is checked on the next `sudo morphit-ops upgrade`.'
		);
		return { apt: 'config-only', aptTransport: transport };
	}
	revert(bk);
	const why =
		v.status === 3
			? 'apt was busy with another run (unattended-upgrades) the whole time'
			: 'no repository answered over Tor just now';
	info(
		`apt keeps its previous settings for now (${why}); they were put back exactly as they were. ` +
			'Nothing else changed. The next `sudo morphit-ops upgrade` on this node tries again.'
	);
	return { apt: 'reverted', aptTransport: transport };
}

async function healTime(
	rt: TorOnlyOsRuntime,
	info: (m: string) => void,
	warn: (m: string) => void,
	hardStopAt: number
): Promise<TimeOutcome> {
	const units = rt.installTimeCheck();
	if (!units.ok) {
		warn(
			`Could not set up the Tor time check (${units.detail ?? 'unknown reason'}); the clock keeps its current time servers.`
		);
		return 'units-failed';
	}
	const pending = rt.readMarker('chrony.pending');
	const chrony = rt.chronyPresent();
	if (pending === null) {
		if (chrony && rt.script('chrony-check').status === 0) return 'already';
		if (!chrony && !rt.timesyncdActive()) return 'no-ntp-client';
	}

	if (pending === null) {
		if (hardStopAt - rt.now() < TIME_CHECK_MIN_MS) {
			info(
				'Not enough time left in this upgrade for the Tor time check, so the clock keeps its current time ' +
					'servers for now. The check runs every 6 hours, and the next `sudo morphit-ops upgrade` on this ' +
					'node finishes the switch.'
			);
			return 'deferred';
		}
		const stop = rt.spinner('Checking the clock against onion time sources over Tor…');
		const t = rt.runTimeCheck(Math.min(300_000, hardStopAt - rt.now() - 10_000));
		stop();
		if (t.status !== 0) {
			const line = lastLine(t.output, 'MORPHIT_TOR_TIME ');
			const answered = /answered=(\d+)/.exec(line)?.[1] ?? '0';
			info(
				`The Tor time check could not get agreeing answers from enough onion time sources right now ` +
					`(${answered} answered), so the clock keeps its current time servers for now. The check runs ` +
					'every 6 hours, and the next `sudo morphit-ops upgrade` on this node finishes the switch.'
			);
			return 'no-consensus';
		}
	}

	if (!chrony) {
		if (rt.disableTimesyncd() && !rt.timesyncdActive()) {
			info(
				'systemd-timesyncd no longer polls public NTP servers; the Tor time check keeps the clock (every 6 hours).'
			);
			return 'timesyncd-off';
		}
		warn('Could not turn off systemd-timesyncd; the clock keeps its current time servers.');
		return 'reverted';
	}

	let bk = pending;
	if (bk === null) {
		bk = rt.newBackupDir('chrony');
		if (bk === null || !rt.writeMarker('chrony.pending', bk)) {
			warn('Skipped the chrony change: could not keep a backup of its settings first.');
			return 'reverted';
		}
		if (rt.script('chrony-apply', bk).status !== 0) {
			rt.script('chrony-revert', bk);
			rt.clearMarker('chrony.pending');
			warn('Could not change chrony\u2019s settings; they were put back and nothing else changed.');
			return 'reverted';
		}
	}
	const stop = rt.spinner('Restarting chrony without public NTP servers…');
	rt.restartChrony();
	let count: number | null = null;
	for (let i = 0; i < 5; i++) {
		count = rt.chronyActive() ? rt.chronySourceCount() : null;
		if (count === 0) break;
		await rt.sleep(2000);
	}
	stop();
	if (count === 0) {
		rt.clearMarker('chrony.pending');
		info(
			'chrony no longer polls public NTP servers; the Tor time check keeps the clock right (every 6 hours).'
		);
		return 'switched';
	}
	// Fallback: chrony still uses a source from somewhere we did not edit (or did
	// not come back). Stop it; the Tor time check keeps the clock.
	if (rt.stopDisableChrony() && !rt.chronyActive()) {
		rt.clearMarker('chrony.pending');
		info(
			'chrony still listed a network time source after its public servers were removed, so chrony was ' +
				'stopped; the Tor time check keeps the clock right (every 6 hours).'
		);
		return 'chrony-stopped';
	}
	rt.script('chrony-revert', bk);
	rt.restartChrony();
	rt.clearMarker('chrony.pending');
	warn('chrony could not be taken off public NTP servers, so its previous settings were put back.');
	return 'reverted';
}

function healNews(
	rt: TorOnlyOsRuntime,
	info: (m: string) => void,
	warn: (m: string) => void
): NewsOutcome {
	if (rt.script('news-check').status === 0) return 'already';
	const bk = rt.newBackupDir('news');
	if (bk === null) {
		warn('Skipped turning off the Ubuntu news fetches: could not keep a backup first.');
		return 'reverted';
	}
	if (rt.script('news-apply', bk).status === 0 && rt.script('news-check').status === 0) {
		info('Ubuntu\u2019s motd news and apt news (clearnet fetches) are off on this tor-only node.');
		return 'switched';
	}
	rt.script('news-revert', bk);
	warn('Could not turn off the Ubuntu news fetches; their settings were put back.');
	return 'reverted';
}

export async function applyAndVerifyTorOnlyOs(opts: {
	readonly hiddenOnly: boolean;
	readonly socks: string;
	readonly runtime: TorOnlyOsRuntime;
	readonly info: (m: string) => void;
	readonly warn: (m: string) => void;
	/** Absolute time (ms) by which this heal must be done; none by default. */
	readonly hardStopAt?: number;
}): Promise<TorOnlyOsOutcome> {
	if (!opts.hiddenOnly) return { apt: 'not-tor-only', time: 'not-tor-only', news: 'not-tor-only' };
	const stopAt = opts.hardStopAt ?? Number.POSITIVE_INFINITY;
	const a = await healApt(opts.runtime, opts.info, opts.warn, opts.socks, stopAt);
	const time = await healTime(opts.runtime, opts.info, opts.warn, stopAt);
	const news = healNews(opts.runtime, opts.info, opts.warn);
	return { apt: a.apt, aptTransport: a.aptTransport, time, news };
}

// ─── The real runtime ────────────────────────────────────────────────────────

/** Tor's SocksPort as the indexer uses it (MORPHIT_INDEXER_TOR_SOCKS), when it
 *  is an IPv4 literal; else Tor's default. Never a name (no system DNS). */
export function torSocksFromEnv(files: readonly string[] = indexerEnvFiles()): string {
	for (const f of files) {
		try {
			const m =
				/^[ \t]*MORPHIT_INDEXER_TOR_SOCKS[ \t]*=[ \t]*["']?([0-9.]+:[0-9]+)["']?[ \t]*$/m.exec(
					readFileSync(f, 'utf8')
				);
			if (m && m[1]) return m[1];
		} catch {
			/* next */
		}
	}
	return '127.0.0.1:9050';
}

/** A SOCKS5 greeting to Tor's SocksPort answered with a SOCKS5 method. */
export function socksGreets(hostPort: string, timeoutMs = 5000): Promise<boolean> {
	const i = hostPort.lastIndexOf(':');
	const host = hostPort.slice(0, i);
	const port = Number(hostPort.slice(i + 1));
	return new Promise((resolve) => {
		const s = connect({ host, port });
		const done = (ok: boolean): void => {
			s.destroy();
			resolve(ok);
		};
		const t = setTimeout(() => done(false), timeoutMs);
		s.on('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])));
		s.on('data', (d: Buffer) => {
			clearTimeout(t);
			done(d.length >= 2 && d[0] === 0x05 && d[1] !== 0xff);
		});
		s.on('error', () => {
			clearTimeout(t);
			done(false);
		});
	});
}

function installRoot(): string {
	const env = (process.env.MORPHIT_INSTALL_DIR ?? '').trim();
	if (env !== '') return env;
	const m = /^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '');
	if (m && m[1] && existsSync(join(m[1], 'ops'))) return m[1];
	return '/opt/morphit';
}

export async function healTorOnlyOs(deps: {
	readonly info: (m: string) => void;
	readonly warn: (m: string) => void;
	readonly spinner: (label: string) => () => void;
}): Promise<TorOnlyOsOutcome> {
	const hiddenOnly = isHiddenOnlyNode();
	const socks = torSocksFromEnv();
	if (!hiddenOnly) return { apt: 'not-tor-only', time: 'not-tor-only', news: 'not-tor-only' };
	// Inside the re-exec'd self-heal child (killed SELF_HEAL_CHILD_TIMEOUT_MS
	// after it starts — the older orchestrator hard-codes that), finish well
	// before the kill and leave time for the heals after this one. Run
	// in-process (no child), there is no kill to beat.
	const started = Date.now();
	const hardStopAt = process.argv.includes('__post-upgrade-selfheal')
		? Math.min(
				started - process.uptime() * 1000 + SELF_HEAL_CHILD_TIMEOUT_MS - 20_000,
				started + CHILD_HEAL_BUDGET_MS
			)
		: Number.POSITIVE_INFINITY;

	// MORPHIT_OS_ROOT / MORPHIT_HELPER_DIR / MORPHIT_SYSTEMD_DIR relocate the
	// paths so a test drives this real entry point against scratch dirs; unset
	// on a real box. MORPHIT_HEAL_NO_SYSTEMD=1: the test has no systemd.
	const osRoot = process.env.MORPHIT_OS_ROOT ?? '';
	const helperDir = process.env.MORPHIT_HELPER_DIR ?? DEFAULT_HELPER_DIR;
	const systemdDir = process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system';
	const noSystemd = process.env.MORPHIT_HEAL_NO_SYSTEMD === '1';
	const stateDir = `${osRoot}/var/lib/morphit-tor-only`;
	const root = installRoot();
	const log = (m: string): void => deps.info(`  ${m}`);

	const osScript = installHelperScript({
		releaseRoot: root,
		name: 'morphit-tor-only-os.sh',
		helperDir,
		log
	});
	if (osScript === null) {
		deps.warn(
			'Skipped the tor-only OS settings: could not install their script from this release.'
		);
		return { apt: 'apply-failed', time: 'units-failed', news: 'reverted' };
	}
	const env = { ...process.env, MORPHIT_TOR_SOCKS: socks, LC_ALL: 'C' };
	const sh = (
		args: readonly string[],
		timeout: number,
		extraEnv: Readonly<Record<string, string>> = {}
	): ScriptRun => {
		const r = spawnSync('sh', args as string[], {
			encoding: 'utf8',
			env: { ...env, ...extraEnv },
			timeout
		});
		return {
			status: typeof r.status === 'number' ? r.status : 1,
			output: `${r.stdout ?? ''}${r.stderr ?? ''}`
		};
	};
	const run = (cmd: string, args: readonly string[], timeout = 60_000): number =>
		noSystemd && cmd === 'systemctl'
			? 1
			: (spawnSync(cmd, args as string[], { stdio: 'ignore', timeout, env }).status ?? 1);
	const methods = `${osRoot}/usr/lib/apt/methods`;
	const exe = (p: string): boolean => {
		try {
			return (statSync(p).mode & 0o111) !== 0;
		} catch {
			return false;
		}
	};

	const stateOk = (): boolean => {
		try {
			mkdirSync(stateDir, { recursive: true, mode: 0o700 });
			const st = lstatSync(stateDir);
			return st.isDirectory() && !st.isSymbolicLink() && (process.getuid?.() !== 0 || st.uid === 0);
		} catch {
			return false;
		}
	};
	const marker = (n: string): string => join(stateDir, n);

	const runtime: TorOnlyOsRuntime = {
		script: (mode, backupDir, limits) =>
			sh(
				[osScript, mode, ...(backupDir ? [backupDir] : [])],
				limits?.timeoutMs ?? (mode === 'apt-verify' ? 900_000 : 120_000),
				limits?.env
			),
		torAnswers: () => socksGreets(socks),
		aptTransportPresent: () => exe(join(methods, 'tor+http')) && exe(join(methods, 'tor+https')),
		aptTransportStrategies: (created, timeoutMs) => [
			{
				name: 'the .deb in this release\u2019s offline bundle',
				run: () => {
					const dir = join(root, 'vendor', 'apt');
					const deb = existsSync(dir)
						? readdirSync(dir).find((f) => /^apt-transport-tor_[^/]*_all\.deb$/.test(f))
						: undefined;
					return deb !== undefined && run('dpkg', ['-i', join(dir, deb)], 120_000) === 0;
				}
			},
			{
				name: 'apt-get install over Tor',
				run: () => {
					const proxy = `socks5h://apt-transport-tor@${socks}`;
					return (
						run(
							'apt-get',
							[
								'-o',
								`Acquire::http::Proxy=${proxy}`,
								'-o',
								`Acquire::https::Proxy=${proxy}`,
								'-o',
								`DPkg::Lock::Timeout=${Math.max(5, Math.min(120, Math.floor(timeoutMs / 2000)))}`,
								'install',
								'-y',
								'--no-install-recommends',
								'apt-transport-tor'
							],
							timeoutMs
						) === 0
					);
				}
			},
			{
				// What the package itself consists of: links to apt's own drivers.
				name: 'links to apt\u2019s own http/https drivers (what apt-transport-tor contains)',
				run: () => {
					for (const [link, to] of [
						['tor+http', 'http'],
						['tor+https', 'https'],
						['tor+mirror+http', 'mirror'],
						['tor+mirror+https', 'mirror']
					] as const) {
						const p = join(methods, link);
						if (existsSync(p) || !existsSync(join(methods, to))) continue;
						symlinkSync(to, p);
						appendFileSync(created, `${p}\n`);
					}
					return true;
				}
			}
		],
		newBackupDir: (part) => {
			if (!stateOk()) return null;
			const d = join(stateDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${part}`);
			try {
				mkdirSync(d, { mode: 0o700 });
				return d;
			} catch {
				return null;
			}
		},
		readMarker: (n) => {
			try {
				const v = readFileSync(marker(n), 'utf8').trim();
				return v.startsWith(`${stateDir}/backup-`) && existsSync(v) ? v : null;
			} catch {
				return null;
			}
		},
		writeMarker: (n, v) => {
			try {
				if (!stateOk()) return false;
				writeFileSync(marker(n), `${v}\n`, { mode: 0o600 });
				return true;
			} catch {
				return false;
			}
		},
		clearMarker: (n) => rmSync(marker(n), { force: true }),
		installTimeCheck: () => {
			if (
				installHelperScript({
					releaseRoot: root,
					name: 'morphit-tor-timesync.sh',
					helperDir,
					log
				}) === null
			) {
				return { ok: false, detail: 'its script could not be installed' };
			}
			const r = installAndEnableUnits({
				templateDir: join(root, 'ops', 'systemd'),
				systemdDir,
				units: ['morphit-tor-timesync.service', 'morphit-tor-timesync.timer'],
				timer: 'morphit-tor-timesync.timer',
				noSystemd
			});
			return r.ok ? { ok: true } : { ok: false, detail: r.detail };
		},
		installRecover: () => {
			const r = installAndEnableUnits({
				templateDir: join(root, 'ops', 'systemd'),
				systemdDir,
				units: ['morphit-tor-only-recover.service', 'morphit-tor-only-recover.timer'],
				timer: 'morphit-tor-only-recover.timer',
				noSystemd
			});
			return r.ok ? { ok: true } : { ok: false, detail: r.detail };
		},
		// --check: measure only. The timer (started just before) steps the clock
		// when it needs to; the upgrade itself never does.
		runTimeCheck: (timeoutMs) =>
			sh([join(helperDir, 'morphit-tor-timesync.sh'), '--check'], Math.max(10_000, timeoutMs), {
				MORPHIT_TOR_TIME_TIMEOUT: String(
					Math.max(10, Math.min(90, Math.floor(timeoutMs / 1000) - 10))
				)
			}),
		now: () => Date.now(),
		chronyPresent: () => existsSync(`${osRoot}/etc/chrony/chrony.conf`),
		chronyActive: () => run('systemctl', ['is-active', '--quiet', 'chrony']) === 0,
		restartChrony: () => run('systemctl', ['restart', 'chrony']) === 0,
		chronySourceCount: () => {
			const r = spawnSync('chronyc', ['-n', '-c', 'sources'], {
				encoding: 'utf8',
				timeout: 10_000
			});
			if (r.status !== 0 || typeof r.stdout !== 'string') return null;
			return r.stdout.split('\n').filter((l) => l.trim() !== '').length;
		},
		stopDisableChrony: () => run('systemctl', ['disable', '--now', 'chrony']) === 0,
		timesyncdActive: () => run('systemctl', ['is-active', '--quiet', 'systemd-timesyncd']) === 0,
		disableTimesyncd: () =>
			run('timedatectl', ['set-ntp', 'false']) === 0 ||
			run('systemctl', ['disable', '--now', 'systemd-timesyncd']) === 0,
		// MORPHIT_HEAL_RETRY_WAIT_MS: tests shorten the pause before the retry.
		sleep: (ms) =>
			new Promise((r) => setTimeout(r, Number(process.env.MORPHIT_HEAL_RETRY_WAIT_MS ?? '') || ms)),
		spinner: deps.spinner
	};
	return applyAndVerifyTorOnlyOs({
		hiddenOnly,
		socks,
		runtime,
		info: deps.info,
		warn: deps.warn,
		hardStopAt
	});
}
