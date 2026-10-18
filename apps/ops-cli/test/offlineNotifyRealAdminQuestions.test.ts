/**
 * realAdmin's handling of the relay tool's questions (stand-in tsx, as in
 * offlineNotifyRealAdmin.test.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realAdmin } from '../src/commands/offlineNotify.ts';
import { abortError, isAbortError } from '../src/init/prompt.ts';

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
	writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
const read = (name: string): string =>
	existsSync(join(log, name)) ? readFileSync(join(log, name), 'utf8') : '';
const alive = (pid: number): boolean => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
	} catch {
		return false;
	}
};
const Q = `'{"ask":"captcha","url":"https://xmpp.example/captcha/1"}'`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'realadmin-questions-'));
	log = join(dir, 'log');
	const bin = join(dir, 'bin');
	for (const d of [log, bin, join(dir, 'repo/node_modules/.bin'), join(dir, 'repo/apps/relay')])
		mkdirSync(d, { recursive: true });
	sh(join(bin, 'systemctl'), 'exit 0');
	sh(join(bin, 'id'), 'exit 1');
	sh(
		join(dir, 'repo/node_modules/.bin/tsx'),
		[
			'IFS= read -r first',
			'case "$FAKE_MODE" in',
			// the question, then the tool dies without an answer
			`  ask-exit) echo $$ > "$NOTIFY_LOG/pid"; echo ${Q}; exit 1 ;;`,
			// the question split in two writes
			`  split) printf '%s' '{"ask":"capt'; sleep 0.3; printf '%s\\n' 'cha","url":"https://x.example/c"}'; IFS= read -r a; printf '%s' "$a" > "$NOTIFY_LOG/answer"; echo '{"ok":true}' ;;`,
			// a non-question JSON line first
			`  noise) echo '{"progress":1}'; echo ${Q}; IFS= read -r a; printf '%s' "$a" > "$NOTIFY_LOG/answer"; echo '{"ok":true,"n":1}' ;;`,
			// two questions
			`  two) echo ${Q}; IFS= read -r a; printf '%s\\n' "$a" >> "$NOTIFY_LOG/answer"; echo ${Q}; IFS= read -r b; printf '%s\\n' "$b" >> "$NOTIFY_LOG/answer"; echo '{"ok":true,"n":2}' ;;`,
			// closes stdin, asks, exits before the answer can be written (EPIPE)
			`  epipe) exec 0<&-; echo ${Q}; sleep 0.2; echo '{"ok":false,"error":"refused","why":"captcha_wrong"}'; exit 1 ;;`,
			// hangs after the answer: the time limit must run again
			`  hang-after) echo ${Q}; IFS= read -r a; sleep 300 & echo $! > "$NOTIFY_LOG/grandchild"; sleep 300 ;;`,
			// asks, with a grandchild that would outlive it
			`  ask-gc) sleep 300 & echo $! > "$NOTIFY_LOG/grandchild"; echo ${Q}; IFS= read -r a; sleep 300 ;;`,
			// stays a moment so its process list can be read
			`  slow) sleep 1; echo '{"ok":true}' ;;`,
			'esac'
		].join('\n')
	);
	setEnv('PATH', `${bin}:${PATH}`);
	setEnv('NOTIFY_LOG', log);
	setEnv('FAKE_MODE', undefined);
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

describe('realAdmin questions', () => {
	it('no secret in any process command line while the tool runs (whole /proc scanned)', async () => {
		setEnv('FAKE_MODE', 'slow');
		const secret = `pw-${Math.random().toString(36).slice(2)}`;
		const addr = `op-${Math.random().toString(36).slice(2)}@example.net`;
		const p = realAdmin(join(dir, 'repo'), { timeoutMs: 5_000 })(['send', 'email'], {
			MORPHIT_NOTIFY_EMAIL_PASSWORD: secret,
			to: addr
		});
		const { readdirSync } = await import('node:fs');
		let lines: string[] = [];
		// Scanned once the tool is running (its command line names the stand-in).
		await vi.waitFor(
			() => {
				lines = [];
				for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
					try {
						lines.push(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '));
					} catch {
						/* gone */
					}
				}
				expect(lines.filter((l) => l.includes(dir)).length).toBeGreaterThan(0);
			},
			{ timeout: 5_000, interval: 10 }
		);
		expect(lines.join('\n')).not.toContain(secret);
		expect(lines.join('\n')).not.toContain(addr);
		expect(await p).toEqual({ ok: true });
	});

	it('the tool dying while the question is open: an error answer, not the question itself', async () => {
		setEnv('FAKE_MODE', 'ask-exit');
		// The operator answers after the tool has died.
		const r = await realAdmin(join(dir, 'repo'), { timeoutMs: 5_000 })(
			['register', 'xmpp'],
			{},
			async () => {
				await vi.waitFor(() => expect(alive(Number(read('pid').trim()))).toBe(false), {
					timeout: 5_000,
					interval: 10
				});
				return { answer: 'late' };
			}
		);
		expect(r.ok).toBe(false);
		expect(r).not.toHaveProperty('ask');
	});

	it('a question split across two chunks is still asked once', async () => {
		setEnv('FAKE_MODE', 'split');
		const asked: unknown[] = [];
		const r = await realAdmin(join(dir, 'repo'), { timeoutMs: 5_000 })(
			['register', 'xmpp'],
			{},
			async (q) => {
				asked.push(q);
				return { answer: 'A1' };
			}
		);
		expect(r).toEqual({ ok: true });
		expect(asked).toEqual([{ ask: 'captcha', url: 'https://x.example/c' }]);
		expect(JSON.parse(read('answer'))).toEqual({ answer: 'A1' });
	});

	it('a non-question JSON line before the question is skipped', async () => {
		setEnv('FAKE_MODE', 'noise');
		const asked: unknown[] = [];
		const r = await realAdmin(join(dir, 'repo'), { timeoutMs: 5_000 })(
			['register', 'xmpp'],
			{},
			async (q) => {
				asked.push(q);
				return { answer: 'B2' };
			}
		);
		expect(r).toEqual({ ok: true, n: 1 });
		expect(asked).toHaveLength(1);
	});

	it('two questions in one run, each answered in turn', async () => {
		setEnv('FAKE_MODE', 'two');
		let n = 0;
		const r = await realAdmin(join(dir, 'repo'), { timeoutMs: 5_000 })(
			['register', 'xmpp'],
			{},
			async () => ({ answer: `ans${++n}` })
		);
		expect(r).toEqual({ ok: true, n: 2 });
		expect(read('answer')).toBe('{"answer":"ans1"}\n{"answer":"ans2"}\n');
	});

	it('stdin closed by the tool (EPIPE on the answer): no crash, its answer taken', async () => {
		setEnv('FAKE_MODE', 'epipe');
		const r = await realAdmin(join(dir, 'repo'), { timeoutMs: 5_000 })(
			['register', 'xmpp'],
			{},
			// stdin is closed before the question: the answer meets EPIPE at once.
			async () => ({ answer: 'C3' })
		);
		expect(r).toEqual({ ok: false, error: 'refused', why: 'captcha_wrong' });
	});

	it('the time limit runs again after the answer', async () => {
		setEnv('FAKE_MODE', 'hang-after');
		const t = Date.now();
		const r = await realAdmin(join(dir, 'repo'), { timeoutMs: 800 })(
			['register', 'xmpp'],
			{},
			async () => {
				await new Promise((res) => setTimeout(res, 1_200));
				return { answer: 'D4' };
			}
		);
		expect(r).toEqual({ ok: false, error: 'timed_out' });
		expect(Date.now() - t).toBeGreaterThan(1_900);
		expect(Date.now() - t).toBeLessThan(6_000);
		const gc = Number(read('grandchild').trim());
		await vi.waitFor(() => expect(alive(gc)).toBe(false), { timeout: 5_000, interval: 50 });
	}, 15_000);

	it('Ctrl+C at the question: the tool and its grandchildren are stopped, and the Ctrl+C reaches the caller', async () => {
		setEnv('FAKE_MODE', 'ask-gc');
		let outcome: unknown;
		try {
			outcome = await realAdmin(join(dir, 'repo'), { timeoutMs: 5_000 })(
				['register', 'xmpp'],
				{},
				async () => {
					throw abortError();
				}
			);
		} catch (e) {
			outcome = e;
		}
		const gc = Number(read('grandchild').trim());
		await vi.waitFor(() => expect(alive(gc)).toBe(false), { timeout: 5_000, interval: 50 });
		expect(isAbortError(outcome)).toBe(true);
	}, 15_000);
});
