/**
 * The offline-notify wizard's XMPP steps and its question handling
 * end to end (realAdmin with a stand-in tsx).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	realAdmin,
	runOfflineNotify,
	type AdminAnswer,
	type AskHandler,
	type OfflineNotifyDeps
} from '../src/commands/offlineNotify.ts';
import { abortError, isAbortError } from '../src/init/prompt.ts';
import { fakeTerminal } from './helpers/screen.ts';

const STATUS: AdminAnswer = {
	ok: true,
	site: 'Vigilante Trading',
	link: 'https://vigilante.trading',
	hiddenOnly: false,
	tor: true,
	offered: [],
	off: {}
};

interface Run {
	code: number | 'threw';
	error?: unknown;
	printed: string;
	saved: Array<Record<string, string>>;
	calls: Array<{ args: readonly string[]; input: Record<string, string> }>;
}

async function wizard(
	answers: string[],
	o: {
		status?: Partial<AdminAnswer>;
		admin?: (
			a: readonly string[],
			i: Record<string, string>,
			onAsk?: AskHandler
		) => Promise<AdminAnswer> | AdminAnswer;
		deps?: Partial<OfflineNotifyDeps>;
	} = {}
): Promise<Run> {
	const printed: string[] = [];
	const saved: Array<Record<string, string>> = [];
	const calls: Run['calls'] = [];
	let file: Record<string, string> = {};
	const next = (): string => {
		const a = answers.shift();
		if (a === undefined) throw new Error('the wizard asked more than the test answers');
		return a;
	};
	const run: Run = { code: 0, printed: '', saved, calls };
	try {
		run.code = await runOfflineNotify(
			{ positional: [], colorEnabled: false, repoRoot: '/opt/morphit' },
			{
				isRoot: () => true,
				isTTY: true,
				print: (l) => printed.push(l),
				ask: async (_q, d) => {
					const a = next();
					return a === '' ? (d ?? '') : a;
				},
				askPassword: async () => next(),
				askYesNo: async () => next() === 'y',
				askChoice: async (_q, opts) => {
					const a = next();
					if (a === '#last') return opts.length - 1;
					if (a.startsWith('#label ')) {
						const i = opts.findIndex((x) => x === a.slice(7));
						if (i < 0) throw new Error(`no "${a.slice(7)}" in [${opts.join(' | ')}]`);
						return i;
					}
					return Number(a.slice(1));
				},
				admin: async (args, input, onAsk) => {
					calls.push({ args, input });
					if (args[0] === 'status') return { ...STATUS, ...o.status };
					return (await o.admin?.(args, input, onAsk)) ?? { ok: true };
				},
				readEnv: () => ({ ...file }),
				writeEnv: (v) => {
					saved.push({ ...v });
					file = { ...v };
				},
				restartRelay: async () => ['xmpp'],
				resolveSrv: async () => {
					throw new Error('no DNS in tests');
				},
				...o.deps
			}
		);
	} catch (e) {
		run.code = 'threw';
		run.error = e;
	}
	run.printed = printed.join('\n');
	return run;
}

const NEW = ['#label Set up XMPP (Jabber)', '#0'];
const openRelay =
	(over: (a: readonly string[]) => AdminAnswer | undefined = () => undefined) =>
	(args: readonly string[]): AdminAnswer =>
		over(args) ??
		(args[0] === 'register-form'
			? { ok: true, status: 'open' }
			: args[0] === 'archive-off'
				? { ok: true, archive: 'off' }
				: { ok: true });

describe('XMPP: an account made but not saved', () => {
	it('Enter at the test address after the account was made: offered to save it untested; yes saves it', async () => {
		const r = await wizard([...NEW, '#0', 'morphitio', '', '', 'y', '#last'], {
			admin: openRelay()
		});
		expect(r.saved).toHaveLength(1);
		expect(r.saved[0]).toMatchObject({ MORPHIT_NOTIFY_XMPP_JID: 'morphitio@og.im' });
	});

	it('…and no: nothing saved, and the operator is told the account exists on its server', async () => {
		const r = await wizard([...NEW, '#0', 'morphitio', '', '', 'n', '#last'], {
			admin: openRelay()
		});
		expect(r.saved).toHaveLength(0);
		expect(r.printed).toMatch(/morphitio@og\.im was made and stays on its server/);
		expect(r.printed).toMatch(/kept nowhere/);
	});

	it('a failed test note after the account was made, operator declines saving: told the account exists', async () => {
		const r = await wizard([...NEW, '#0', 'morphitio', '', 'me@example.org', 'n', '#last'], {
			admin: openRelay((a) =>
				a[0] === 'send' ? { ok: false, error: 'failed', reason: 'XmppError: x' } : undefined
			)
		});
		expect(r.saved).toHaveLength(0);
		expect(r.printed.slice(r.printed.indexOf('The test did not work'))).toMatch(/morphitio@og\.im/);
	});
});

describe('XMPP: retries keep the right state', () => {
	it('a taken name, then a new name the typed password contains: the password is checked again', async () => {
		const reg: Array<Record<string, string>> = [];
		let n = 0;
		const r = await wizard(
			[
				...NEW,
				'#0',
				'lamp1',
				'Tr4in-Stone-Morphit',
				'Tr4in-Stone-Morphit',
				'morphit',
				'Other-Pass-2026x',
				'Other-Pass-2026x',
				'me@example.org',
				'#last'
			],
			{
				admin: openRelay((a) => {
					if (a[0] !== 'register') return undefined;
					return n++ === 0 ? { ok: false, error: 'refused', why: 'taken', text: '' } : { ok: true };
				})
			}
		).catch((e) => ({ code: 'threw', error: e, printed: '', saved: [], calls: [] }) as Run);
		void reg;
		const registered = r.calls.filter((c) => c.args[0] === 'register').map((c) => c.input);
		const last = registered.at(-1)!;
		expect(last.MORPHIT_NOTIFY_XMPP_PASSWORD!.toLowerCase()).not.toContain('morphit');
	});
});

describe('XMPP: a zero-clearnet site', () => {
	it('an existing .onion account: the server the operator types instead must be an .onion too', async () => {
		const onion = `${'c'.repeat(56)}.onion`;
		const r = await wizard(
			[
				'#label Set up XMPP (Jabber)',
				'#1',
				`bot@${onion}`,
				'pw-pw-pw-pw',
				'n',
				'xmpp.example.org',
				'#0',
				'',
				'me@' + onion,
				'n',
				'#last'
			],
			{ status: { hiddenOnly: true, link: 'http://x.onion' }, admin: openRelay() }
		);
		const hosts = r.calls
			.filter((c) => c.args[1] === 'xmpp')
			.map((c) => c.input.MORPHIT_NOTIFY_XMPP_HOST);
		expect(hosts.every((h) => h === undefined || h.endsWith('.onion'))).toBe(true);
	});
});

// ── end to end with realAdmin and a stand-in tsx ────────────────────────
let dir = '';
const PATH = process.env.PATH;
afterEach(() => {
	process.env.PATH = PATH;
	delete process.env.FAKE_MODE;
	if (dir !== '') rmSync(dir, { recursive: true, force: true });
	dir = '';
});
/** Timers set in this process (a turning spinner is one). */
const activeTimers = (): number =>
	process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
/** Child processes and pipes open in this process. */
const childHandles = (): number =>
	process.getActiveResourcesInfo().filter((r) => r === 'ProcessWrap' || r === 'PipeWrap').length;
function standIn(): string {
	dir = mkdtempSync(join(tmpdir(), 'xmpp-wizard-edges-'));
	const bin = join(dir, 'bin');
	for (const d of [bin, join(dir, 'repo/node_modules/.bin'), join(dir, 'repo/apps/relay')])
		mkdirSync(d, { recursive: true });
	writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	writeFileSync(join(bin, 'id'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
	writeFileSync(
		join(dir, 'repo/node_modules/.bin/tsx'),
		[
			'#!/bin/bash',
			'IFS= read -r first',
			'case "$FAKE_MODE" in',
			`  ask-exit) echo '{"ask":"captcha","url":"https://x.example/c"}'; exit 1 ;;`,
			`  ask-wait) echo '{"ask":"captcha","url":"https://x.example/c"}'; IFS= read -r a; echo '{"ok":true}' ;;`,
			'esac'
		].join('\n'),
		{ mode: 0o755 }
	);
	process.env.PATH = `${bin}:${PATH}`;
	return join(dir, 'repo');
}

describe('realAdmin in the wizard', () => {
	it('the relay tool dies while the picture question is open: no second prompt opens while it is, no spinner left turning', async () => {
		const repo = standIn();
		const real = realAdmin(repo, { timeoutMs: 5_000 });
		process.env.FAKE_MODE = 'ask-exit';
		let open = 0;
		let maxOpen = 0;
		const answers = [...NEW, '#0', 'morphitio', '', 'PICTURE', '#last'];
		const timersBefore = activeTimers();
		const handlesBefore = childHandles();
		let leftTimers = 0;
		const term = fakeTerminal();
		let returnedAt = 0;
		let r: Run;
		try {
			r = await wizard([], {
				admin: (a, i, onAsk) => (a[0] === 'register' ? real(a, i, onAsk) : openRelay()(a)),
				deps: {
					ask: async (q, d) => {
						open++;
						maxOpen = Math.max(maxOpen, open);
						// The operator answers the picture only after the tool has died and
						// morphit-ops has dealt with its end (no child process or pipe of it
						// left) — or once the wizard has opened another prompt meanwhile.
						if (/letters or numbers/.test(q)) {
							await vi.waitFor(
								() => expect(open >= 2 || childHandles() <= handlesBefore).toBe(true),
								{
									timeout: 5_000,
									interval: 10
								}
							);
							for (let k = 0; k < 20 && open < 2; k++)
								await new Promise((res) => setImmediate(res));
						}
						open--;
						const a = answers.shift() ?? '#last';
						return a === '' ? (d ?? '') : a;
					},
					askPassword: async () => answers.shift() ?? '',
					askChoice: async (_q, opts) => {
						open++;
						maxOpen = Math.max(maxOpen, open);
						open--;
						const a = answers.shift() ?? '#last';
						if (a.startsWith('#label ')) return opts.findIndex((x) => x === a.slice(7));
						if (a === '#last') return opts.length - 1;
						return Number(a.slice(1));
					}
				}
			});
			returnedAt = term.out().length;
			// A spinner left turning is a timer still set once the wizard is back.
			leftTimers = activeTimers() - timersBefore;
		} finally {
			term.restore();
		}
		const after = term.out().slice(returnedAt);
		expect(maxOpen).toBe(1);
		expect(after).not.toMatch(/[⠀-⣿]/);
		expect(leftTimers).toBeLessThanOrEqual(0);
	}, 20_000);

	it('Ctrl+C at the picture question stops the wizard (as Ctrl+C at any other prompt does)', async () => {
		const repo = standIn();
		const real = realAdmin(repo, { timeoutMs: 5_000 });
		process.env.FAKE_MODE = 'ask-wait';
		const answers = [...NEW, '#0', 'morphitio', ''];
		const r = await wizard([], {
			admin: (a, i, onAsk) => (a[0] === 'register' ? real(a, i, onAsk) : openRelay()(a)),
			deps: {
				ask: async (q) => {
					if (/letters or numbers/.test(q)) throw abortError();
					return answers.shift() ?? '';
				},
				askPassword: async () => answers.shift() ?? '',
				askChoice: async (_q, opts) => {
					const a = answers.shift() ?? '#last';
					if (a.startsWith('#label ')) return opts.findIndex((x) => x === a.slice(7));
					if (a === '#last') return opts.length - 1;
					return Number(a.slice(1));
				}
			}
		});
		expect(r.code).toBe('threw');
		expect(isAbortError(r.error)).toBe(true);
	}, 20_000);
});
void existsSync;
void readFileSync;

describe('a value the relay would read differently', () => {
	it('an email password wrapped in quotes, or with a space at an end: refused before it is tested or saved', async () => {
		for (const pw of [
			'"Quoted-Pass-123"',
			"'Quoted-Pass-123'",
			' lead-space-pw',
			'trail-space-pw '
		]) {
			const r = await wizard(
				[
					'#label Set up Email',
					'smtp.example.org',
					'#0',
					'',
					'ops@example.org',
					pw,
					'',
					'me@example.net',
					'#last'
				],
				{}
			);
			expect(r.calls.filter((c) => c.args[0] === 'send')).toHaveLength(0);
			expect(r.saved).toHaveLength(0);
		}
	});

	it('a new XMPP account: a typed password wrapped in quotes is refused by the check (the relay would register it without them)', async () => {
		const r = await wizard(
			[
				...NEW,
				'#0',
				'morphitio',
				'"Abcdef-12345"',
				'Good-Pass-2026x',
				'Good-Pass-2026x',
				'me@example.org',
				'#last'
			],
			{ admin: openRelay() }
		);
		const reg = r.calls.filter((c) => c.args[0] === 'register');
		expect(reg).toHaveLength(1);
		expect(reg[0]!.input.MORPHIT_NOTIFY_XMPP_PASSWORD).toBe('Good-Pass-2026x');
	});
});
