/**
 * The www heal's real runtime (commands/upgrade.ts realWwwRuntime) and the
 * deadline it is given, against real curl and a real HTTP server on
 * 127.0.0.1: a request keeps the name (Host) and goes to this machine, the
 * status and Location are read, no answer is told apart; BunkerWeb that was
 * not started by Compose is never "recreated" by a plain restart; nothing is
 * restarted when the deadline is too near.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { realWwwRuntime, wwwHealDeadline } from '../src/commands/upgrade.ts';

// The server runs in its own process: the runtime calls curl synchronously,
// which holds this process's event loop until curl ends.
const SERVER = `
const http = require('http');
const s = http.createServer((req, res) => {
	process.stderr.write(req.headers.host + ' ' + req.url + '\\n');
	res.writeHead(301, { Location: 'https://vigilante.trading' + req.url });
	res.end();
});
s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'));
`;
let child: ChildProcess;
let port = 0;
let seen = '';
beforeAll(async () => {
	child = spawn(process.execPath, ['-e', SERVER], { stdio: ['ignore', 'pipe', 'pipe'] });
	child.stderr!.on('data', (d: Buffer) => (seen += d.toString()));
	port = await new Promise<number>((res) =>
		child.stdout!.once('data', (d: Buffer) => res(Number(d.toString().trim())))
	);
});
afterAll(async () => {
	const gone = new Promise<void>((r) => child.once('exit', () => r()));
	child.kill();
	await gone;
});

const notCompose = (deadline: number) =>
	realWwwRuntime(
		{ edge: { name: '' }, ref: null, services: [], scheduler: null } as never,
		'/opt/morphit/apps/web/build',
		deadline
	);

describe('the real runtime', () => {
	it('a request goes to this machine with the name kept; status and Location read', () => {
		const rt = notCompose(Date.now() + 30 * 60_000);
		const r = rt.request(`http://www.vigilante.trading:${port}/a/b?c=1`);
		expect(r).toMatchObject({
			code: '301',
			location: 'https://vigilante.trading/a/b?c=1',
			exit: 0
		});
		// the server saw the name (its log arrives on its own stream)
		return new Promise<void>((done) => {
			const look = () =>
				seen.includes(`www.vigilante.trading:${port} /a/b?c=1`)
					? done()
					: child.stderr!.once('data', look);
			look();
		});
	});

	it('no answer is "000" with curl’s own exit status (not a status to act on)', () => {
		const rt = notCompose(Date.now() + 30 * 60_000);
		const r = rt.request('http://www.vigilante.trading:1/');
		expect(r.code).toBe('000');
		expect(r.exit).not.toBe(0);
	});

	it('not started by Compose: a recreate is "not-restarted" (never a plain restart), and it says so', () => {
		const rt = notCompose(Date.now() + 30 * 60_000);
		expect(rt.apply('x', true)).toBe('not-restarted');
		expect(rt.composeManaged()).toBe(false);
		expect(rt.edgeSettingsSource()).toBeNull();
		expect(rt.liveEnv()).toBeNull();
	});

	it('too near the deadline: nothing is started', () => {
		expect(notCompose(Date.now() + 4 * 60_000).apply('x', true)).toBe('no-time');
		expect(notCompose(Date.now() + 4 * 60_000).timeLeftMs()).toBeLessThanOrEqual(4 * 60_000);
	});
});

describe('the deadline the heal is given', () => {
	it('background: the unit’s 45-minute limit after its start, less a minute', () => {
		expect(
			wwwHealDeadline({ background: true, startedAtMs: 1_000_000, nowMs: 9e9, uptimeS: 9 })
		).toBe(1_000_000 + 45 * 60_000 - 60_000);
	});
	it('the self-heal child: its 300 s from the process start, less 25 s', () => {
		expect(
			wwwHealDeadline({ background: false, startedAtMs: 0, nowMs: 2_000_000, uptimeS: 100 })
		).toBe(2_000_000 - 100_000 + 300_000 - 25_000);
	});
});
