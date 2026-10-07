/**
 * The upgrade's last word ("Left for you: …" or "Nothing else to do.") is
 * built from what each part of the upgrade LEFT: the heal phase (a child
 * process) leaves its warning count and open questions in files, the
 * background web heal its state file, the after-restart checks their log;
 * this process has its own warnings and to-do items. Each test below runs the
 * code that leaves its part (a real child process where the upgrade has one, a
 * stand-in `systemctl` on PATH) and then the code that gathers and words the
 * summary — never the summary function on hand-made inputs alone.
 *
 * v1.21.1 review A: "Nothing else to do." followed a background web heal that
 * rolled back after the heal phase stopped watching, a seed that said this box
 * is NOT a usable seeder, a fees account the operator must register, a heal
 * phase run by an older release, a helper directory that is a link, and a
 * crash of the after-restart checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPS, REPO, TSX, stub } from './helpers/pty.ts';

const UPGRADE = join(OPS, 'src', 'commands', 'upgrade.ts');
const TERM = join(OPS, 'src', 'render', 'term.ts');
const SEED = join(REPO, 'ops', 'ipfs', 'morphit-ipfs-seed.sh');

type Up = typeof import('../src/commands/upgrade.ts');
type Term = typeof import('../src/render/term.ts');
type WebHeal = typeof import('../src/lib/webHeal.ts');

let d = '';
let bin = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
	'PATH',
	'MORPHIT_UPGRADE_WARNINGS_FILE',
	'MORPHIT_UPGRADE_QUESTIONS_FILE',
	'MORPHIT_WEB_HEAL_STATE',
	'MORPHIT_WEB_HEAL_LOG',
	'MORPHIT_AFTER_RESTART_LOG',
	'MORPHIT_UPGRADE_SUMMARIZES',
	'MORPHIT_HELPER_DIR',
	'MORPHIT_INSTALL_DIR',
	'MORPHIT_STEP_LOG_DIR',
	'FAKE_ACTIVE_UNITS',
	'FAKE_UNITS',
	'NO_COLOR'
];

/** Fresh modules: this process's warning count, to-do list and routine count
 *  start at zero, as in a real upgrade. */
async function fresh(): Promise<{ up: Up; term: Term; web: WebHeal }> {
	vi.resetModules();
	return {
		up: await import('../src/commands/upgrade.ts'),
		term: await import('../src/render/term.ts'),
		web: await import('../src/lib/webHeal.ts')
	};
}

/** Everything written to stdout and stderr while `fn` runs. */
async function captured(fn: () => unknown): Promise<string> {
	let out = '';
	const grab = (chunk: unknown): boolean => {
		out += String(chunk);
		return true;
	};
	const o = vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
	const e = vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
	try {
		await fn();
	} finally {
		o.mockRestore();
		e.mockRestore();
	}
	return out;
}

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	d = mkdtempSync(join(tmpdir(), 'upgrade-last-word-'));
	bin = join(d, 'bin');
	mkdirSync(bin);
	// systemctl: is-active answers from FAKE_ACTIVE_UNITS, cat from FAKE_UNITS.
	stub(
		bin,
		'systemctl',
		[
			'case "$1" in',
			'  is-active) for u in $FAKE_ACTIVE_UNITS; do [ "$u" = "$3" ] && exit 0; done; exit 3 ;;',
			'  cat) for u in $FAKE_UNITS; do [ "$u" = "$2" ] && exit 0; done; exit 1 ;;',
			'esac',
			'exit 0'
		].join('\n')
	);
	process.env.PATH = `${bin}:${saved.PATH ?? ''}`;
	process.env.MORPHIT_UPGRADE_WARNINGS_FILE = join(d, 'upgrade-warnings');
	process.env.MORPHIT_UPGRADE_QUESTIONS_FILE = join(d, 'upgrade-questions');
	process.env.MORPHIT_WEB_HEAL_STATE = join(d, 'web-heal.json');
	process.env.MORPHIT_WEB_HEAL_LOG = join(d, 'web-heal.log');
	process.env.MORPHIT_AFTER_RESTART_LOG = join(d, 'after-upgrade-heal.log');
	process.env.MORPHIT_STEP_LOG_DIR = join(d, 'step-logs');
	process.env.FAKE_ACTIVE_UNITS = '';
	process.env.FAKE_UNITS = '';
	delete process.env.MORPHIT_UPGRADE_SUMMARIZES;
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(d, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const base = (startedMs: number, healChildRan = true) => ({
	from: 'v1.21.1',
	to: 'v1.21.2',
	backupDir: '/opt/morphit.bak-1',
	schemaChanged: false,
	canaryCleared: false,
	frontendVerified: true,
	startedMs,
	healChildRan
});

/** The heal-phase child's hand-over, as the real child leaves it. */
function childLeftCount(up: Up): void {
	process.env.MORPHIT_UPGRADE_SUMMARIZES = '1';
	up.recordChildWarnings();
	delete process.env.MORPHIT_UPGRADE_SUMMARIZES;
}

const lastWord = (up: Up, startedMs: number, healChildRan = true): string =>
	up.upgradeSummaryLines(up.gatherUpgradeSummary(base(startedMs, healChildRan))).join('\n');

describe('the background web heal in the last word (A-F1)', () => {
	it('a heal that rolled back AFTER the heal phase stopped watching is named, never "Nothing else to do."', async () => {
		const { up, web } = await fresh();
		const startedMs = Date.now();
		const startedAt = new Date(startedMs).toISOString();
		// The heal phase: the heal is still running at its deadline.
		web.writeWebHealState({ state: 'running', startedAt });
		const seen: string[] = [];
		const atDeadline = await web.followWebHeal(Date.now(), startedMs, {
			info: (m) => seen.push(m),
			warn: (m) => seen.push(m),
			spinner: () => () => {}
		});
		expect(atDeadline).toBeNull();
		childLeftCount(up);
		// While the upgrade restarts the services and seeds, the unit rolls back.
		web.writeWebHealState({
			state: 'done',
			startedAt,
			finishedAt: new Date().toISOString(),
			result: 'rolled-back',
			detail: 'the site did not answer after the change',
			warnings: 2
		});
		const t = lastWord(up, startedMs);
		expect(t).not.toMatch(/Nothing else to do/);
		expect(t).toMatch(/Left for you:/);
		expect(t).toMatch(
			/not applied — the site did not answer after the change; the previous settings were put back/
		);
		expect(t).toMatch(/2 warnings, see on this server: sudo cat .*web-heal\.log/);
		expect(t).toMatch(/On this server: sudo morphit-ops status/);
	});

	it('while the heal still runs (systemctl says the unit is active) it says so', async () => {
		const { up, web } = await fresh();
		const startedMs = Date.now();
		web.writeWebHealState({ state: 'running', startedAt: new Date(startedMs).toISOString() });
		process.env.FAKE_ACTIVE_UNITS = 'morphit-web-heal';
		childLeftCount(up);
		const t = lastWord(up, startedMs);
		expect(t).not.toMatch(/Nothing else to do/);
		// True whether the unit runs the web-proxy settings or the frontend
		// rebuild the after-restart checks started (A-F7c).
		expect(t).toMatch(
			/The web-proxy settings \(BunkerWeb and the frontend container\) are still being applied in the background/
		);
		expect(t).not.toMatch(/BunkerWeb is still at work on the web settings/);
	});

	it('a heal that ended before this upgrade began is not this upgrade’s', async () => {
		const { up, web } = await fresh();
		const startedMs = Date.now();
		const hourAgo = new Date(startedMs - 3_600_000).toISOString();
		web.writeWebHealState({
			state: 'done',
			startedAt: hourAgo,
			finishedAt: hourAgo,
			result: 'rolled-back'
		});
		childLeftCount(up);
		expect(lastWord(up, startedMs)).toMatch(/Nothing else to do\./);
	});

	it('a heal that stopped without writing how it ended is named, with its log', async () => {
		const { up, web } = await fresh();
		const startedMs = Date.now();
		web.writeWebHealState({ state: 'running', startedAt: new Date(startedMs).toISOString() });
		childLeftCount(up);
		const t = lastWord(up, startedMs);
		expect(t).toMatch(/stopped before it finished.*sudo cat .*web-heal\.log/);
		expect(t).not.toMatch(/Nothing else to do/);
	});

	it('"already in place" with warnings is named; without, it is not', async () => {
		const { up, web } = await fresh();
		const startedMs = Date.now();
		const now = new Date(startedMs).toISOString();
		web.writeWebHealState({
			state: 'done',
			startedAt: now,
			finishedAt: now,
			result: 'already',
			warnings: 1
		});
		childLeftCount(up);
		expect(lastWord(up, startedMs)).toMatch(/already in place .*one warning, see on this server/);
		web.writeWebHealState({ state: 'done', startedAt: now, finishedAt: now, result: 'already' });
		childLeftCount(up);
		expect(lastWord(up, startedMs)).toMatch(/Nothing else to do\./);
	});
});

describe('the heal phase reports a web-heal outcome as what it is', () => {
	it('rolled back: a warning, never one of the checks that "found nothing to change"', async () => {
		const { up, term } = await fresh();
		const t = '2026-10-06T12:00:00.000Z';
		const out = await captured(() => {
			up.reportWebProxyOutcome({
				state: 'done',
				startedAt: t,
				finishedAt: t,
				result: 'rolled-back',
				detail: 'a check did not pass'
			});
			up.printRoutineSummary();
		});
		expect(term.warningCount()).toBe(1);
		expect(out).toMatch(/\[WARN\] Web-proxy settings: not applied — a check did not pass/);
		expect(out).not.toMatch(/other check/);
	});
	it('already in place, with warnings: shown and counted, not folded away', async () => {
		const { up, term } = await fresh();
		const t = '2026-10-06T12:00:00.000Z';
		const out = await captured(() => {
			up.reportWebProxyOutcome({
				state: 'done',
				startedAt: t,
				finishedAt: t,
				result: 'already',
				warnings: 2
			});
			up.printRoutineSummary();
		});
		expect(term.warningCount()).toBe(1);
		expect(out).toMatch(/already in place .*2 warnings/);
		expect(out).not.toMatch(/other check/);
	});
	it('a heal already running from an earlier run is followed to ITS end', async () => {
		const { up, web, term } = await fresh();
		const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
		web.writeWebHealState({ state: 'running', startedAt });
		writeFileSync(join(d, 'web-heal.log'), '');
		const startOut = await captured(() =>
			up.startWebProxyHeals({ isBunkerWeb: () => true, launch: () => 'already-running' })
		);
		expect(startOut).toMatch(/already being checked in the background/);
		// It ends (rolled back) while the heal phase runs its other heals.
		web.writeWebHealState({
			state: 'done',
			startedAt,
			finishedAt: new Date().toISOString(),
			result: 'rolled-back',
			detail: 'the site did not answer after the change'
		});
		const t0 = Date.now();
		const out = await captured(() => up.showWebProxyResult());
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(out).toMatch(/\[WARN\] Web-proxy settings: not applied — the site did not answer/);
		expect(term.warningCount()).toBe(1);
	}, 30_000);
});

/** Run `steps` (a JS array expression over `up` and `term`) as the heal-phase
 *  child the upgrade starts, in its own process; `untilSlow` stops it with
 *  SIGTERM (the upgrader's time limit) once it prints SLOW STARTED. */
async function runChild(
	steps: string,
	opts: { untilSlow?: boolean; env?: Record<string, string> } = {}
): Promise<{ out: string; code: number | null }> {
	const runner = join(d, `child-${Math.random()}.mts`);
	writeFileSync(
		runner,
		[
			`const up = await import(${JSON.stringify(UPGRADE)});`,
			`const term = await import(${JSON.stringify(TERM)});`,
			`await up.runPostUpgradeSelfHealChild(() => ${steps});`,
			`console.log('CHILD DONE');`
		].join('\n')
	);
	const child = spawn(TSX, [runner], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, MORPHIT_UPGRADE_SUMMARIZES: '1', ...(opts.env ?? {}) }
	});
	let out = '';
	let slow = (): void => undefined;
	const seenSlow = new Promise<void>((r) => (slow = r));
	const onData = (b: Buffer): void => {
		out += b;
		if (/SLOW STARTED/.test(out)) slow();
	};
	child.stdout.on('data', onData);
	child.stderr.on('data', onData);
	const closed = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
	if (opts.untilSlow) {
		await Promise.race([seenSlow, closed]);
		child.kill('SIGTERM');
	}
	const code = await closed;
	return { out, code };
}

describe('the heal phase (a child process) hands its warnings and questions over', () => {
	it('its warning count and its open questions reach the last word', async () => {
		stub(
			bin,
			'journalctl',
			`printf '%s\\n' '{"event":"sequential_pattern_rejected","bucketKey":"203.0.113.0/24"}'`
		);
		const r = await runChild(
			`[
				['a heal that warns', () => term.warn('the relay could not be restarted')],
				['the relay log notice', () => up.healRelayJournalNotice()],
				['the questions left for later', () => up.printDeferredQuestions()]
			]`,
			{ env: { MORPHIT_JOURNAL_NOTICE_MARKER: join(d, 'marker') } }
		);
		expect(r.out).toMatch(/CHILD DONE/);
		// No colour in the child: its warnings are marked [WARN] …
		expect(r.out).toMatch(/\[WARN\] the relay could not be restarted/);
		const { up } = await fresh();
		const t = lastWord(up, Date.now());
		expect(t).toMatch(/One warning above/);
		// … and the last word names that marker (A-F7b).
		expect(t).toMatch(/the lines marked ⚠ or \[WARN\]/);
		expect(t).toMatch(
			/Questions the upgrade did not wait for: whether to drop the journal history that holds old relay log lines\. On this server: sudo morphit-ops upgrade --questions/
		);
		expect(t).not.toMatch(/Nothing else to do/);
	}, 60_000);

	it('stopped at its time limit, it still hands over its count and questions (and says what did not run)', async () => {
		stub(
			bin,
			'journalctl',
			`printf '%s\\n' '{"event":"sequential_pattern_rejected","bucketKey":"203.0.113.0/24"}'`
		);
		const r = await runChild(
			`[
				['the relay log notice', () => up.healRelayJournalNotice()],
				['the slow heal', () => (console.log('SLOW STARTED'), new Promise(() => setInterval(() => {}, 1000)))],
				['the last heal', () => console.log('LAST DONE')]
			]`,
			{ untilSlow: true, env: { MORPHIT_JOURNAL_NOTICE_MARKER: join(d, 'marker') } }
		);
		expect(r.code).toBe(143);
		expect(r.out).toMatch(/stopped its heal step at the time limit, during the slow heal/);
		expect(r.out).toMatch(/Not done this time: the slow heal, the last heal/);
		expect(r.out).not.toMatch(/LAST DONE/);
		const { up } = await fresh();
		const t = lastWord(up, Date.now());
		// The time-limit line is itself a warning: counted.
		expect(t).toMatch(/One warning above/);
		expect(t).toMatch(
			/Questions the upgrade did not wait for: whether to drop the journal history/
		);
	}, 60_000);

	it('a heal phase that left no count (an older release’s child, on a downgrade) is never "Nothing else to do."', async () => {
		const { up } = await fresh();
		const t = lastWord(up, Date.now(), true);
		expect(existsSync(join(d, 'upgrade-warnings'))).toBe(false);
		expect(t).not.toMatch(/Nothing else to do/);
		expect(t).toMatch(
			/left no count of their warnings: read their lines above for any marked ⚠ or \[WARN\]/
		);
		expect(t).not.toMatch(/Every service restarted/);
		// The heals ran in this process instead: its own count is complete.
		expect(lastWord((await fresh()).up, Date.now(), false)).toMatch(/Nothing else to do\./);
	});
});

describe('lines that ask the operator to act are counted (A-F2)', () => {
	/** The seed's stand-ins: Kubo answers, the self-checks get `probe`. */
	function seedSandbox(probe: string): Record<string, string> {
		const sb = join(d, 'seed');
		mkdirSync(join(sb, 'bin'), { recursive: true });
		mkdirSync(join(sb, 'src'), { recursive: true });
		writeFileSync(join(sb, 'src', 'RELEASE-NOTES-v9.9.9.md'), '# notes\n');
		const tb = join(sb, 'morphit-v9.9.9.tar.gz');
		spawnSync('tar', ['-czf', tb, '-C', join(sb, 'src'), '.']);
		stub(
			join(sb, 'bin'),
			'ipfs',
			[
				'case "$*" in',
				'  *"config Routing.Type"*) echo none ;;',
				'  *"config Addresses.Gateway"*) echo /ip4/127.0.0.1/tcp/8082 ;;',
				'  *" add "*) echo "$STUB_CID" ;;',
				'esac',
				'exit 0'
			].join('\n')
		);
		stub(
			join(sb, 'bin'),
			'curl',
			'for a in "$@"; do case "$a" in *"/metadata.json") printf %s "$STUB_PROBE"; exit 0 ;; esac; done; exit 7'
		);
		return {
			PATH: `${join(sb, 'bin')}:${process.env.PATH ?? ''}`,
			HOME: sb,
			TMPDIR: sb,
			IPFS_PATH: sb,
			STUB_CID: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
			STUB_PROBE: probe,
			MORPHIT_STAGE_TARBALL: tb,
			MORPHIT_SEED_HIDDEN_ONLY: '1',
			MORPHIT_SEED_ONION: `${'a'.repeat(56)}.onion`
		};
	}
	const seed = async (up: Up, probe: string): Promise<{ out: string; code: number }> => {
		let code = -1;
		const out = await captured(async () => {
			code = await up.runStepWithSpinner('Seeding v9.9.9 to IPFS…', 'sh', [SEED, 'v9.9.9'], {
				env: { ...process.env, ...seedSandbox(probe) },
				timeoutMs: 120_000,
				name: 'The IPFS seed',
				alsoFine: [3]
			});
			up.reportSeedResult('v9.9.9', code);
		});
		return { out, code };
	};

	it('the IPFS seed found this box NOT a usable seeder: a warning, no "✓ Seeded", counted in the last word', async () => {
		const { up, term } = await fresh();
		childLeftCount(up);
		const r = await seed(up, '404');
		expect(r.code).toBe(3);
		expect(r.out).toMatch(/⚠ WARNING: the local IPFS gateway is NOT serving/);
		expect(r.out).not.toMatch(/✓ Seeded/);
		expect(r.out).toMatch(/\[WARN\] Seeded v9\.9\.9 to IPFS, but its checks above/);
		expect(r.out).not.toMatch(/failed \(exit code 3\)/);
		expect(term.warningCount()).toBe(1);
		expect(lastWord(up, Date.now())).toMatch(/One warning above/);
	}, 60_000);

	it('a seed whose checks pass: "✓ Seeded", nothing left', async () => {
		const { up } = await fresh();
		const r = await seed(up, '200');
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/✓ Seeded v9\.9\.9 to IPFS\./);
		childLeftCount(up);
		expect(lastWord(up, Date.now())).toMatch(/Nothing else to do\./);
	}, 60_000);

	it('the fees account the operator must register: a counted warning', async () => {
		const { up, term } = await fresh();
		childLeftCount(up);
		let outcome = '';
		const out = await captured(async () => {
			outcome = await up.healFeesAccountRegistrationNow({
				env: () => ({
					account: 'op',
					keyFile: '/x',
					instanceName: 'n',
					origin: 'https://x.example',
					contactUrl: null,
					operatorTag: 'mine',
					altAddresses: { tor: null, i2p_b32: null, i2p_name: null, lokinet: null, ens: null },
					feeRecipient: 'myfees'
				}),
				localRegistration: async () => ({ state: 'registered', tag: 'other' }) as never,
				localFeeView: async () =>
					({ reportsRegistration: true, registered: false, feeRecipient: 'myfees' }) as never,
				hiddenOnly: () => false
			} as never);
		});
		expect(outcome).toBe('needs_operator');
		expect(out).toMatch(
			/\[WARN\] Your fees account @myfees is not in your on-chain operator registration yet.*sudo morphit-ops register/
		);
		expect(term.warningCount()).toBe(1);
		expect(lastWord(up, Date.now())).toMatch(/One warning above/);
	});

	it('a fees account already registered stays a calm line, not a warning', async () => {
		const { up, term } = await fresh();
		const out = await captured(() =>
			up.healFeesAccountRegistrationNow({
				env: () => ({
					account: 'op',
					keyFile: '/x',
					instanceName: 'n',
					origin: 'https://x.example',
					contactUrl: null,
					operatorTag: 'mine',
					altAddresses: { tor: null, i2p_b32: null, i2p_name: null, lokinet: null, ens: null },
					feeRecipient: 'myfees'
				}),
				localRegistration: async () => ({ state: 'registered', tag: 'mine' }) as never,
				localFeeView: async () =>
					({ reportsRegistration: true, registered: true, feeRecipient: 'myfees' }) as never,
				hiddenOnly: () => false
			} as never)
		);
		expect(out).toMatch(/✓ Your fees account @myfees is in your on-chain registration/);
		expect(term.warningCount()).toBe(0);
	});
});

describe('other parts of the last word, from where they are left', () => {
	it('a helper directory that is a link: said, counted, never "found nothing to change" (A-F9)', async () => {
		const { up, term } = await fresh();
		childLeftCount(up);
		const real = join(d, 'real-helpers');
		mkdirSync(real);
		writeFileSync(join(real, 'morphit-ipfs-pin.sh'), '#!/bin/sh\necho old\n');
		symlinkSync(real, join(d, 'helpers'));
		process.env.MORPHIT_HELPER_DIR = join(d, 'helpers');
		process.env.MORPHIT_INSTALL_DIR = REPO;
		const out = await captured(() => {
			up.healHelperScripts();
			up.printRoutineSummary();
		});
		expect(out).toMatch(/Left the helper scripts in .*helpers as they are: it is a link/);
		expect(out).not.toMatch(/other check/);
		expect(term.warningCount()).toBe(1);
		expect(readFileSync(join(real, 'morphit-ipfs-pin.sh'), 'utf8')).toBe('#!/bin/sh\necho old\n');
		expect(lastWord(up, Date.now())).toMatch(/One warning above/);
	});

	it('the after-restart checks stopping on an error is an [ERR] line in their log, counted (A-F7d)', async () => {
		const { up } = await fresh();
		const startedMs = Date.now() - 1_000;
		const log = await captured(() =>
			up.runAfterRestartUnit('0', async () => {
				throw new Error('cannot read /proc/uptime');
			})
		);
		expect(log).toMatch(/^\[ERR\] The checks after the restart stopped early: cannot read/m);
		writeFileSync(join(d, 'after-upgrade-heal.log'), `Waiting for …\n${log}`);
		childLeftCount(up);
		const t = lastWord(up, startedMs);
		expect(t).toMatch(/The background checks finished with a warning; read it on this server/);
		expect(t).not.toMatch(/Nothing else to do/);
	});

	it('still running background checks are named with their log', async () => {
		const { up } = await fresh();
		const startedMs = Date.now() - 1_000;
		writeFileSync(join(d, 'after-upgrade-heal.log'), 'Waiting for …\n');
		process.env.FAKE_ACTIVE_UNITS = 'morphit-after-upgrade-heal';
		childLeftCount(up);
		expect(lastWord(up, startedMs)).toMatch(
			/Checks that need the restarted services are still running.*sudo cat .*after-upgrade-heal\.log/
		);
	});

	it('the checks that could not start in the background: a warning, counted', async () => {
		const { up, term } = await fresh();
		childLeftCount(up);
		stub(bin, 'systemd-run', 'exit 1');
		const out = await captured(() => up.startAfterRestartHeals());
		expect(out).toMatch(/\[WARN\] Could not start the checks that run after the services restart/);
		expect(term.warningCount()).toBe(1);
		expect(lastWord(up, Date.now())).toMatch(/One warning above/);
	});

	it('the onion just put into the config: the last word says to re-publish, with a command that exists (A-F5)', async () => {
		const { up } = await fresh();
		const { MENU_GROUPS } = await import('../src/commands/mainMenu.ts');
		const cfg = join(d, 'morphit.config.env');
		writeFileSync(cfg, 'MORPHIT_INSTANCE_TOR_ADDRESS=\n');
		writeFileSync(join(d, 'hostname'), `${'b'.repeat(56)}.onion\n`);
		await captured(() => up.captureTorOnion(cfg, join(d, 'hostname')));
		expect(readFileSync(cfg, 'utf8')).toMatch(/MORPHIT_INSTANCE_TOR_ADDRESS=b{56}\.onion/);
		childLeftCount(up);
		const t = lastWord(up, Date.now());
		const item = /• (Tell the federation about this node's Tor address.*)$/m.exec(t)?.[1] ?? '';
		expect(item).toMatch(/sudo morphit-ops register/);
		// The menu item it names is the one that runs `register`.
		const label = /in the menu: ([^)]+)\)/.exec(item)?.[1];
		const menuItem = MENU_GROUPS.flatMap((g) => g.items).find((i) => i.label === label);
		expect(menuItem?.subcommand).toBe('register');
		expect(t).not.toMatch(/Alt addresses/);
	});
});
