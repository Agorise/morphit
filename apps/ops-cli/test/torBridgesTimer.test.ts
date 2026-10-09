/**
 * The Tor bridges check between upgrades (2026-10-09): `morphit-ops upgrade
 * --tor-bridges` runs the repair alone, morphit-tor-bridges.timer runs that
 * after boot and every 6 hours, one run at a time, and the upgrade installs the
 * timer after its own run of the repair.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const calls: string[] = [];
vi.mock('../src/lib/torBridgesHeal.ts', async (orig) => {
	const real = (await orig()) as typeof import('../src/lib/torBridgesHeal.ts');
	return {
		...real,
		heal: async () => (
			calls.push('heal'),
			{ strategy: 'already', verified: true, detail: 'TORBRIDGES-DETAIL' }
		)
	};
});

const { runUpgrade } = await import('../src/commands/upgrade.ts');
const real = (await vi.importActual(
	'../src/lib/torBridgesHeal.ts'
)) as typeof import('../src/lib/torBridgesHeal.ts');
const REPO = join(__dirname, '..', '..', '..');

let dir = '';
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'torbridges-timer-'));
	calls.length = 0;
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

const ctx = { info: () => undefined, warn: () => undefined, spinner: () => () => undefined };
const works = {
	readTorrc: () => 'HiddenServiceDir /x\n',
	writeTorrc: () => true,
	verifies: () => ({ ok: true, out: '' }),
	torActive: () => true,
	onion: () => null,
	status: async () => 200,
	installed: () => true,
	install: async () => true,
	restartTor: async () => true,
	connectedSince: () => true,
	bridgeList: () => null,
	hiddenOnly: () => false,
	plainTorWorks: async () => false,
	readState: () => ({}),
	writeState: () => undefined,
	sleep: async () => undefined,
	now: () => 0
};

describe('`morphit-ops upgrade --tor-bridges`', () => {
	it.skipIf(process.getuid?.() !== 0)(
		'runs the Tor bridges repair alone (nothing downloaded)',
		async () => {
			const rc = await runUpgrade({ flags: { 'tor-bridges': 'true' }, positional: [] });
			expect(calls).toEqual(['heal']);
			expect(rc).toBe(0);
		}
	);

	it.skipIf(process.getuid?.() !== 0)(
		"a run during a real upgrade leaves that upgrade's open questions alone",
		async () => {
			const q = join(dir, 'questions');
			writeFileSync(q, 'whether to keep the old journal\n');
			const prev = process.env.MORPHIT_UPGRADE_QUESTIONS_FILE;
			process.env.MORPHIT_UPGRADE_QUESTIONS_FILE = q;
			try {
				await runUpgrade({ flags: { 'tor-bridges': 'true' }, positional: [] });
			} finally {
				if (prev === undefined) delete process.env.MORPHIT_UPGRADE_QUESTIONS_FILE;
				else process.env.MORPHIT_UPGRADE_QUESTIONS_FILE = prev;
			}
			expect(existsSync(q), 'the upgrade lost its questions to the timer').toBe(true);
		}
	);

	it('the timer runs exactly that, as root, with time for the longest repair', () => {
		const svc = readFileSync(join(REPO, 'ops/systemd/morphit-tor-bridges.service'), 'utf8');
		const tmr = readFileSync(join(REPO, 'ops/systemd/morphit-tor-bridges.timer'), 'utf8');
		expect(svc).toMatch(
			/^ExecStart=\S+tsx --tsconfig \S+ \S+\/apps\/ops-cli\/src\/main\.ts upgrade --tor-bridges$/m
		);
		// ProtectHome hides /root; a working dir there stops the unit before it runs.
		expect(svc).toMatch(/^WorkingDirectory=\/$/m);
		expect(svc).toMatch(/^User=root$/m);
		const t = Number(/^TimeoutStartSec=(\d+)min$/m.exec(svc)?.[1]);
		expect(t * 60_000).toBeGreaterThan(real.TOR_BRIDGES_HEAL_MAX_MS);
		expect(tmr).toMatch(/^Unit=morphit-tor-bridges\.service$/m);
		expect(tmr).toMatch(/^OnUnitActiveSec=6h$/m);
		// Never a boot-relative first run: long past on a running server, it fires at once.
		expect(tmr).not.toMatch(/^OnBootSec=/m);
		expect(tmr).toMatch(/^OnActiveSec=\d+min$/m);
	});
});

// v1.21.4 review: a server moved back to an older release keeps the timer,
// and an older morphit-ops ignores `--tor-bridges` and runs a whole upgrade
// every 6 hours. The unit runs only when the installed morphit-ops has the flag.
describe('the timer after a move back to an older release', () => {
	const svc = (): string =>
		readFileSync(join(REPO, 'ops/systemd/morphit-tor-bridges.service'), 'utf8');
	const conditionFor = (root: string): number => {
		const m = /^ExecCondition=(.+)$/m.exec(svc());
		expect(m, 'no ExecCondition').not.toBeNull();
		const cmd = m![1]!.replaceAll('/opt/morphit', root);
		return spawnSync('sh', ['-c', cmd]).status ?? -1;
	};
	it('runs with this release, and is skipped with one whose morphit-ops lacks --tor-bridges', () => {
		expect(conditionFor(REPO)).toBe(0);
		const old = join(dir, 'old');
		mkdirSync(join(old, 'apps/ops-cli/src/commands'), { recursive: true });
		writeFileSync(
			join(old, 'apps/ops-cli/src/commands/upgrade.ts'),
			"if (opts.flags['heals'] === 'true') return runHealsAgain();\n"
		);
		const rc = conditionFor(old);
		// systemd: 1-254 skips the run (not a failure).
		expect(rc).toBeGreaterThanOrEqual(1);
		expect(rc).toBeLessThanOrEqual(254);
	});
	it('the help names the flag', () => {
		const r = spawnSync(
			join(REPO, 'node_modules/.bin/tsx'),
			[
				'--tsconfig',
				join(REPO, 'apps/ops-cli/tsconfig.json'),
				join(REPO, 'apps/ops-cli/src/main.ts'),
				'--help'
			],
			{ encoding: 'utf8', timeout: 60_000 }
		);
		expect(r.stdout).toMatch(/--tor-bridges/);
	}, 90_000);
});

describe('one run at a time, and the timer turned on after the repair', () => {
	it('a run already going: this one does nothing', async () => {
		const lock = join(dir, 'lock');
		mkdirSync(lock);
		writeFileSync(join(lock, 'pid'), String(process.pid)); // alive
		let checked = false;
		const r = await real.heal(ctx, REPO, {
			runtime: { ...works, readTorrc: () => ((checked = true), 'x') },
			lockPath: lock,
			torPresent: () => false
		});
		expect(r.strategy).toBe('busy');
		expect(checked).toBe(false);
		expect(existsSync(lock), "the other run's lock was taken away").toBe(true);
	});

	it('a lock left by a run that is gone is taken over, and released after', async () => {
		const lock = join(dir, 'lock');
		mkdirSync(lock);
		writeFileSync(join(lock, 'pid'), '2147483646'); // no such process
		const r = await real.heal(ctx, REPO, {
			runtime: works,
			lockPath: lock,
			torPresent: () => false
		});
		expect(r.strategy).toBe('already');
		expect(existsSync(lock)).toBe(false);
	});

	it('the timer is installed AFTER the repair ran, and the operator is told once', async () => {
		const order: string[] = [];
		const r = await real.heal(ctx, REPO, {
			runtime: { ...works, torActive: () => (order.push('check'), true) },
			lockPath: join(dir, 'lock'),
			torPresent: () => true,
			installTimer: () => (order.push('timer'), { ok: true, written: ['x'], timerRunning: true })
		});
		expect(order).toEqual(['check', 'timer']);
		expect(r.routine).toBe(false);
		expect(r.detail).toMatch(/every 6 hours/);
	});

	it('a timer that cannot be turned on is named, with the command', async () => {
		const r = await real.heal(ctx, REPO, {
			runtime: works,
			lockPath: join(dir, 'lock'),
			torPresent: () => true,
			installTimer: () => ({ ok: false, written: [], timerRunning: false, detail: 'no systemd' })
		});
		expect(r.detail).toMatch(/sudo systemctl enable --now morphit-tor-bridges\.timer/);
	});
});
