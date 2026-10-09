/**
 * The after-restart phase (lib/afterRestartHeal.ts): a background unit that
 * waits until the services have restarted on the new release, then runs the
 * heals that need them. Here: the waiting rule and the unit it starts.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AFTER_RESTART_SUBCOMMAND,
	launchAfterRestartHeals,
	relayHealthUrl,
	serviceAnswers,
	waitForAnswers,
	waitForRestarts,
	waitForUnitIdle
} from '../src/lib/afterRestartHeal.ts';

describe('waiting for the restarts', () => {
	it('waits until every running service became active after the start mark', async () => {
		let t = 0;
		const since: Record<string, number> = { a: 50, b: 50 };
		const r = await waitForRestarts(100, ['a', 'b'], {
			activeSince: (s) => since[s] ?? null,
			isActive: () => true,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
				if (t >= 10_000) since.a = 150;
				if (t >= 20_000) since.b = 160;
			}
		});
		expect(r).toBe('restarted');
		expect(t).toBe(20_000);
	});

	it('does not wait for a service that is not running, and gives up after the limit', async () => {
		let t = 0;
		expect(
			await waitForRestarts(100, ['down'], {
				activeSince: () => 1,
				isActive: () => false,
				now: () => t,
				sleep: async () => {}
			})
		).toBe('restarted');
		expect(
			await waitForRestarts(100, ['stuck'], {
				activeSince: () => 1,
				isActive: () => true,
				now: () => t,
				sleep: async (ms) => void (t += ms),
				maxMs: 60_000
			})
		).toBe('timed-out');
	});
});

describe('the background unit', () => {
	it('is a transient systemd unit running the hidden subcommand with the start mark', () => {
		const calls: string[][] = [];
		const r = launchAfterRestartHeals({
			run: (cmd, args) => (calls.push([cmd, ...args]), { status: cmd === 'systemctl' ? 3 : 0 }),
			cliPath: '/opt/morphit/apps/ops-cli/dist/main.js',
			nodePath: '/usr/bin/node',
			sinceUs: 123456
		});
		expect(r).toBe('launched');
		const sr = calls.find((c) => c[0] === 'systemd-run')!;
		expect(sr.slice(-4)).toEqual([
			'/usr/bin/node',
			'/opt/morphit/apps/ops-cli/dist/main.js',
			AFTER_RESTART_SUBCOMMAND,
			'123456'
		]);
		expect(sr).toContain('--collect');
	});
});

describe('waiting for another background unit', () => {
	it('returns once the unit is no longer active, or after the limit', async () => {
		let t = 0;
		let checks = 0;
		expect(
			await waitForUnitIdle('u', {
				isActive: () => ++checks < 3,
				now: () => t,
				sleep: async (ms) => void (t += ms)
			})
		).toBe('idle');
		expect(checks).toBe(3);
		t = 0;
		expect(
			await waitForUnitIdle('u', {
				isActive: () => true,
				now: () => t,
				sleep: async (ms) => void (t += ms),
				maxMs: 60_000
			})
		).toBe('timed-out');
		expect(t).toBeGreaterThanOrEqual(60_000);
	});
	// v1.21.1 review: the log was emptied before systemd-run, so a launch
	// that failed still looked like this upgrade's run and the last lines said
	// the checks were "still running".
	it('a launch that fails leaves a log that does not look like this run', () => {
		const d = mkdtempSync(join(tmpdir(), 'after-restart-'));
		process.env.MORPHIT_AFTER_RESTART_LOG = join(d, 'log');
		try {
			const r = launchAfterRestartHeals({
				run: (cmd) => ({ status: cmd === 'systemctl' ? 3 : 1 }),
				cliPath: '/x/main.js',
				nodePath: '/usr/bin/node',
				sinceUs: 1
			});
			expect(r).toBe('unavailable');
			expect(statSync(join(d, 'log')).mtimeMs).toBeLessThan(Date.now() - 86_400_000);
			expect(readFileSync(join(d, 'log'), 'utf8')).toMatch(/could not be started/);
		} finally {
			delete process.env.MORPHIT_AFTER_RESTART_LOG;
			rmSync(d, { recursive: true, force: true });
		}
	});
});

// 2026-10-08 (morphit.io, v1.21.2): systemd calls the relay "active" the moment
// its process starts; it listens seconds later. The checks now wait until both
// services answer on their health addresses.
describe('waiting for the services to answer', () => {
	it('waits until every running service answers, then runs nothing more', async () => {
		let t = 0;
		const asked: string[] = [];
		const silent = await waitForAnswers(['idx', 'relay'], {
			isActive: () => true,
			answers: async (s) => (asked.push(s), s === 'idx' || t >= 9_000),
			now: () => t,
			sleep: async (ms) => void (t += ms)
		});
		expect(silent).toEqual([]);
		expect(t).toBe(9_000);
		// A service that answered is not asked again.
		expect(asked.filter((s) => s === 'idx')).toHaveLength(1);
	});

	it('gives up after the limit and names the one that never answered; a stopped one is not waited for', async () => {
		let t = 0;
		const silent = await waitForAnswers(['idx', 'relay', 'stopped'], {
			isActive: (s) => s !== 'stopped',
			answers: async (s) => s === 'idx',
			now: () => t,
			sleep: async (ms) => void (t += ms),
			maxMs: 30_000
		});
		expect(silent).toEqual(['relay']);
		expect(t).toBeGreaterThanOrEqual(30_000);
	});

	it("asks the relay's own health address from its env files", async () => {
		const root = mkdtempSync(join(tmpdir(), 'morphit-answers-'));
		const server = createServer((_q, r) => r.end('{"status":"ok"}'));
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as AddressInfo).port;
		try {
			mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
			writeFileSync(
				join(root, 'etc', 'morphit', 'relay.env'),
				`MORPHIT_RELAY_LISTEN_HOST=0.0.0.0\nMORPHIT_RELAY_LISTEN_PORT=${port}\n`
			);
			expect(relayHealthUrl(root)).toBe(`http://127.0.0.1:${port}/v1/health`);
			process.env.MORPHIT_ENV_ROOT = root;
			expect(await serviceAnswers('morphit-relay.service')).toBe(true);
			await new Promise<void>((r) => server.close(() => r()));
			expect(await serviceAnswers('morphit-relay.service')).toBe(false);
		} finally {
			delete process.env.MORPHIT_ENV_ROOT;
			server.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('an IPv6 relay address is written as a URL can carry it', () => {
		const root = mkdtempSync(join(tmpdir(), 'morphit-answers-'));
		try {
			mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
			writeFileSync(
				join(root, 'etc', 'morphit', 'relay.env'),
				'MORPHIT_RELAY_LISTEN_HOST=::1\nMORPHIT_RELAY_LISTEN_PORT=8080\n'
			);
			expect(relayHealthUrl(root)).toBe('http://[::1]:8080/v1/health');
			writeFileSync(join(root, 'etc', 'morphit', 'relay.env'), 'MORPHIT_RELAY_LISTEN_HOST=::\n');
			expect(relayHealthUrl(root)).toBe('http://127.0.0.1:8080/v1/health');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('asks the indexer where its unit says it listens: a host set without a port, or a setting in morphit.config.env', async () => {
		// Review 2026-10-08: only indexer.env was read and a host needed its port
		// beside it, so such an indexer was asked at 127.0.0.1:8081, never
		// answered, and every upgrade waited 5 minutes and warned.
		const root = mkdtempSync(join(tmpdir(), 'morphit-answers-'));
		const server = createServer((_q, r) => r.end('{"status":"ok"}'));
		await new Promise<void>((r) => server.listen(0, '127.0.0.2', r));
		const port = (server.address() as AddressInfo).port;
		const install = join(root, 'opt', 'morphit');
		try {
			mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
			mkdirSync(install, { recursive: true });
			writeFileSync(
				join(root, 'etc', 'morphit', 'indexer.env'),
				'MORPHIT_INDEXER_LISTEN_HOST=127.0.0.2\n'
			);
			writeFileSync(join(install, 'morphit.config.env'), `MORPHIT_INDEXER_LISTEN_PORT=${port}\n`);
			process.env.MORPHIT_ENV_ROOT = root;
			process.env.MORPHIT_INSTALL_DIR = install;
			expect(await serviceAnswers('morphit-indexer.service')).toBe(true);
		} finally {
			delete process.env.MORPHIT_ENV_ROOT;
			delete process.env.MORPHIT_INSTALL_DIR;
			await new Promise<void>((r) => server.close(() => r()));
			rmSync(root, { recursive: true, force: true });
		}
	});
});
