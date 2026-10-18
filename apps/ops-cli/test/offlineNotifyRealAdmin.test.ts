/**
 * `sudo morphit-ops offline-notify` — the two pieces that touch the real
 * system: running the relay's admin tool (realAdmin) and restarting the relay
 * (realRestartRelay). `systemctl`, `runuser`, `id` and the relay's `tsx` are
 * stand-ins that record what they were given; the rest is the real code.
 *
 *  - The tool runs as the user the relay UNIT runs as (`systemctl show -P User
 *    morphit-relay`), not as root (review W8).
 *  - Settings and the test address reach it on stdin, never the command line,
 *    which every user on the box can read in the process list (review W7).
 *  - Its time limit stops everything it started, grandchildren too, and an
 *    answer is taken when it exits even if something it started still holds
 *    its output open (review R5 #3).
 *  - The relay is really restarted, without blocking: the spinner turns for
 *    the whole restart (review W9, R5 #8).
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realAdmin, realRestartRelay } from '../src/commands/offlineNotify.ts';
import { withSpinner } from '../src/init/spinner.ts';
import { currentLine, fakeTerminal, frameRe, type FakeTerminal } from './helpers/screen.ts';
import { spinnerFrames } from './helpers/pty.ts';

let dir = '';
let log = '';
const PATH = process.env.PATH;
const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined): void => {
	if (!(k in saved)) saved[k] = process.env[k];
	if (v === undefined) delete process.env[k];
	else process.env[k] = v;
};
const sh = (p: string, body: string): void =>
	writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const read = (name: string): string =>
	existsSync(join(log, name)) ? readFileSync(join(log, name), 'utf8') : '';
/** Running (a zombie — killed, waiting to be reaped — is not). */
const alive = (pid: number): boolean => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
	} catch {
		return false;
	}
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'notify-admin-'));
	log = join(dir, 'log');
	const bin = join(dir, 'bin');
	for (const d of [log, bin, join(dir, 'repo/node_modules/.bin'), join(dir, 'repo/apps/relay')])
		mkdirSync(d, { recursive: true });
	sh(
		join(bin, 'systemctl'),
		[
			'echo "$*" >> "$NOTIFY_LOG/systemctl"',
			'case "$*" in',
			'  "show -P User morphit-relay") printf "%s\\n" "$FAKE_UNIT_USER" ;;',
			'  "restart morphit-relay") cp "$NOTIFY_LOG/screen" "$NOTIFY_LOG/at-restart" 2>/dev/null; sleep 0.6; exit "${FAKE_RESTART_STATUS:-0}" ;;',
			'esac',
			'exit 0'
		].join('\n')
	);
	sh(
		join(bin, 'runuser'),
		[
			'printf "%s\\n" "$@" > "$NOTIFY_LOG/runuser"',
			'user="$2"; shift 3',
			'FAKE_RUNAS="$user" exec "$@"'
		].join('\n')
	);
	sh(join(bin, 'id'), '[ "$2" = morphit-relay ] && [ -n "$FAKE_RELAY_ACCOUNT" ] && exit 0\nexit 1');
	// The relay's tsx: records its arguments, its user and its stdin.
	sh(
		join(dir, 'repo/node_modules/.bin/tsx'),
		[
			'printf "%s\\n" "$@" > "$NOTIFY_LOG/argv"',
			'echo "${FAKE_RUNAS:-root}" > "$NOTIFY_LOG/user"',
			'pwd > "$NOTIFY_LOG/cwd"',
			// Asks one question (a picture check) and waits for its answer on stdin.
			'if [ "$FAKE_MODE" = ask ]; then',
			'  IFS= read -r first; printf "%s" "$first" > "$NOTIFY_LOG/stdin"',
			'  echo \'{"ask":"captcha","url":"https://xmpp.example/captcha/1"}\'',
			'  IFS= read -r second; printf "%s" "$second" > "$NOTIFY_LOG/answer"',
			'  echo \'{"ok":true,"registered":1}\'; exit 0',
			'fi',
			'cat > "$NOTIFY_LOG/stdin"',
			'case "$FAKE_MODE" in',
			'  hang) sleep 300 & echo $! > "$NOTIFY_LOG/grandchild"; sleep 300 ;;',
			'  linger) sleep 300 & echo $! > "$NOTIFY_LOG/grandchild"; echo \'{"ok":true,"lingered":1}\'; exit 0 ;;',
			'esac',
			'echo \'{"ok":true,"key":"ok"}\''
		].join('\n')
	);
	setEnv('PATH', `${bin}:${PATH}`);
	setEnv('NOTIFY_LOG', log);
	for (const k of ['FAKE_UNIT_USER', 'FAKE_RELAY_ACCOUNT', 'FAKE_MODE', 'FAKE_RESTART_STATUS'])
		setEnv(k, undefined);
});
afterEach(() => {
	const gc = Number(read('grandchild').trim());
	if (gc > 0 && alive(gc)) process.kill(gc, 'SIGKILL');
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
		delete saved[k];
	}
	process.env.PATH = PATH;
	rmSync(dir, { recursive: true, force: true });
});

describe('realAdmin: the relay’s admin tool, as the relay', () => {
	it('a question from the tool is answered on its stdin; the time limit waits while the operator answers', async () => {
		setEnv('FAKE_MODE', 'ask');
		const asked: unknown[] = [];
		const r = await realAdmin(join(dir, 'repo'), { timeoutMs: 1_500 })(
			['register', 'xmpp'],
			{ MORPHIT_NOTIFY_XMPP_PASSWORD: 'pa$$ s3cret' },
			async (q) => {
				asked.push(q);
				// Longer than the time limit: answering is not counted.
				await new Promise((res) => setTimeout(res, 2_500));
				return { answer: 'K7Q2X' };
			}
		);
		expect(r).toEqual({ ok: true, registered: 1 });
		expect(asked).toEqual([{ ask: 'captcha', url: 'https://xmpp.example/captcha/1' }]);
		expect(JSON.parse(read('stdin'))).toEqual({ MORPHIT_NOTIFY_XMPP_PASSWORD: 'pa$$ s3cret' });
		expect(JSON.parse(read('answer'))).toEqual({ answer: 'K7Q2X' });
		// Still nothing on a command line.
		expect(read('argv')).not.toMatch(/s3cret|K7Q2X/);
	});

	it('an operator who gives up on the question: the tool is stopped, nothing is answered', async () => {
		setEnv('FAKE_MODE', 'ask');
		const r = await realAdmin(join(dir, 'repo'), { timeoutMs: 5_000 })(
			['register', 'xmpp'],
			{},
			async () => {
				throw new Error('aborted');
			}
		);
		expect(r).toEqual({ ok: false, error: 'cancelled' });
		expect(read('answer')).toBe('');
	});

	it('runs as the user the relay unit runs as, in apps/relay', async () => {
		setEnv('FAKE_UNIT_USER', 'svc-relay');
		const r = await realAdmin(join(dir, 'repo'))(['status'], {});
		expect(r).toEqual({ ok: true, key: 'ok' });
		expect(read('user').trim()).toBe('svc-relay');
		expect(read('runuser').split('\n').slice(0, 4)).toEqual(['-u', 'svc-relay', '--', 'bash']);
		expect(read('cwd').trim()).toBe(join(dir, 'repo/apps/relay'));
		expect(read('argv').split('\n').slice(0, 2)).toEqual(['src/notify/adminCli.ts', 'status']);
	});

	it('a unit that runs as root: root; no User= from systemd: the relay account where it exists', async () => {
		setEnv('FAKE_UNIT_USER', 'root');
		setEnv('FAKE_RELAY_ACCOUNT', '1');
		await realAdmin(join(dir, 'repo'))(['status'], {});
		expect(read('user').trim()).toBe('root');
		expect(read('runuser')).toBe('');

		setEnv('FAKE_UNIT_USER', '');
		await realAdmin(join(dir, 'repo'))(['status'], {});
		expect(read('user').trim()).toBe('morphit-relay');

		setEnv('FAKE_RELAY_ACCOUNT', undefined);
		rmSync(join(log, 'runuser'));
		await realAdmin(join(dir, 'repo'))(['status'], {});
		expect(read('user').trim()).toBe('root');
		expect(read('runuser')).toBe('');
	});

	it('passwords and the test address go on stdin, never on any command line', async () => {
		setEnv('FAKE_UNIT_USER', 'svc-relay');
		const input = { MORPHIT_NOTIFY_EMAIL_PASSWORD: 'pa$$ s3cret', to: 'me@example.net' };
		await realAdmin(join(dir, 'repo'))(['send', 'email'], input);
		expect(JSON.parse(read('stdin'))).toEqual(input);
		for (const argv of [read('argv'), read('runuser')]) {
			expect(argv).not.toContain('s3cret');
			expect(argv).not.toContain('me@example.net');
		}
		expect(read('argv').split('\n').slice(0, 3)).toEqual([
			'src/notify/adminCli.ts',
			'send',
			'email'
		]);
	});

	it('the time limit stops the tool and everything it started', async () => {
		setEnv('FAKE_MODE', 'hang');
		const t = Date.now();
		const r = await realAdmin(join(dir, 'repo'), { timeoutMs: 800 })(['status'], {});
		expect(r).toEqual({ ok: false, error: 'timed_out' });
		expect(Date.now() - t).toBeLessThan(5_000);
		const gc = Number(read('grandchild').trim());
		expect(gc).toBeGreaterThan(0);
		// It was sent SIGKILL before the answer came; the kernel ends it a moment later.
		await vi.waitFor(() => expect(alive(gc)).toBe(false), { timeout: 5_000, interval: 50 });
	}, 15_000);

	it('an answer counts when the tool exits, even if something it started holds its output open', async () => {
		setEnv('FAKE_MODE', 'linger');
		const t = Date.now();
		const r = await realAdmin(join(dir, 'repo'), { timeoutMs: 60_000 })(['status'], {});
		expect(r).toEqual({ ok: true, lingered: 1 });
		expect(Date.now() - t).toBeLessThan(10_000);
		const gc = Number(read('grandchild').trim());
		expect(gc).toBeGreaterThan(0);
		await vi.waitFor(() => expect(alive(gc)).toBe(false), { timeout: 5_000, interval: 50 });
	}, 20_000);
});

describe('realRestartRelay', () => {
	let server: Server | null = null;
	let term: FakeTerminal | null = null;
	beforeEach(async () => {
		server = createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				req.url === '/v1/notify/channels'
					? JSON.stringify({ channels: [{ id: 'email' }, { id: 'matrix' }] })
					: '{"ok":true}'
			);
		});
		await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as { port: number }).port;
		mkdirSync(join(dir, 'root/etc/morphit'), { recursive: true });
		writeFileSync(join(dir, 'root/etc/morphit/relay.env'), `MORPHIT_RELAY_LISTEN_PORT=${port}\n`);
		setEnv('MORPHIT_ENV_ROOT', join(dir, 'root'));
		writeFileSync(join(log, 'screen'), '');
		term = fakeTerminal({ mirror: join(log, 'screen') });
	});
	afterEach(async () => {
		term?.restore();
		term = null;
		vi.restoreAllMocks();
		await new Promise<void>((r) => server!.close(() => r()));
		server = null;
	});

	const LABEL = 'Restarting the relay so it uses the new settings…';

	it('restarts the relay, with the spinner turning the whole time, and asks it what it offers', async () => {
		const offered = await withSpinner(LABEL, () => realRestartRelay());
		expect(offered).toEqual(['email', 'matrix']);
		expect(read('systemctl')).toMatch(/^restart morphit-relay$/m);
		expect(currentLine(read('at-restart'))).toMatch(frameRe(LABEL));
		expect(spinnerFrames(term!.out(), LABEL)).toBeGreaterThanOrEqual(3);
	}, 30_000);

	it('a restart systemd refused: no answer claimed', async () => {
		setEnv('FAKE_RESTART_STATUS', '1');
		const offered = await withSpinner(LABEL, () => realRestartRelay());
		expect(offered).toBeNull();
		expect(read('systemctl')).toMatch(/^restart morphit-relay$/m);
	}, 30_000);
});
