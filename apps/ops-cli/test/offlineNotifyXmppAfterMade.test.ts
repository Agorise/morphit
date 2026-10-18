/**
 * The offline-notify wizard's XMPP steps after the
 * round-1 fixes — paths those fixes missed, and guards for fixes no test held.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	runOfflineNotify,
	type AdminAnswer,
	type AskHandler,
	type OfflineNotifyDeps
} from '../src/commands/offlineNotify.ts';
import { abortError, isAbortError } from '../src/init/prompt.ts';
import { checkXmppPassword, makeXmppPassword } from '../src/lib/xmppAccount.ts';

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
		// Ctrl+C at this prompt.
		if (a === '#ctrl-c') throw abortError();
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
const EXISTING = ['#label Set up XMPP (Jabber)', '#1'];
const openRelay =
	(over: (a: readonly string[]) => AdminAnswer | undefined = () => undefined) =>
	(args: readonly string[]): AdminAnswer =>
		over(args) ??
		(args[0] === 'register-form'
			? { ok: true, status: 'open' }
			: args[0] === 'archive-off'
				? { ok: true, archive: 'off' }
				: { ok: true });

describe('a new XMPP account that ends up not saved', () => {
	it('saved untested, but the save fails: the operator is told the account exists on its server', async () => {
		const r = await wizard([...NEW, '#0', 'morphitio', '', '', 'y', '#last'], {
			admin: openRelay(),
			deps: {
				writeEnv: () => {
					throw new Error('No space left on device');
				}
			}
		});
		expect(r.printed).toMatch(/Not saved/);
		expect(r.printed).toMatch(/morphitio@og\.im was made and stays on its server/);
		expect(r.printed).toMatch(/kept nowhere/);
	});
});

describe('Ctrl+C after a new XMPP account was made', () => {
	for (const [where, answers] of [
		['at the test address', ['#ctrl-c']],
		['at “Save without a test note?”', ['', '#ctrl-c']],
		['at “Save these settings anyway?” after a failed test', ['me@example.org', '#ctrl-c']]
	] as const)
		it(`${where}: stops as Ctrl+C does, and says the account stays on its server`, async () => {
			const r = await wizard([...NEW, '#0', 'morphitio', '', ...answers], {
				admin: openRelay((a) =>
					a[0] === 'send' ? { ok: false, error: 'failed', reason: 'XmppError: x' } : undefined
				)
			});
			expect(r.code).toBe('threw');
			expect(isAbortError(r.error)).toBe(true);
			expect(r.saved).toHaveLength(0);
			expect(r.printed).toMatch(/morphitio@og\.im was made and stays on its server/);
		});
});

describe('a typed password the servers refuse under SASLprep', () => {
	// Each is refused by real Prosody 0.12 ("password fails SASLprep", not-allowed)
	// and real ejabberd 23.10 ("The password contains unacceptable characters").
	const PROHIBITED: Array<[string, string]> = [
		['U+0085 next line (control)', 'Pass\u0085Word-2026x'],
		['U+E000 private use', 'PassWord-2026x'],
		['U+200E left-to-right mark', 'Pass‎Word-2026x'],
		['U+2062 invisible times', 'Pass⁢Word-2026x'],
		['U+FFFC object replacement', 'Pass￼Word-2026x'],
		['U+180E Mongolian vowel separator', 'Pass᠎Word-2026x'],
		['Hebrew mixed with Latin (bidi rule)', 'שלום-Pass-2026x']
	];
	for (const [name, pw] of PROHIBITED)
		it(`refused by the check before anything is sent: ${name}`, () => {
			expect(checkXmppPassword(pw, 'morphitio')).not.toBeNull();
		});

	it('still fine: precomposed accents, German, CJK, symbols', () => {
		for (const pw of ['Café-Pass-2026', 'Pässwörd-2026x', '密码-Pass-2026x', 'A$b"c\'d\\e#f g-1'])
			expect(checkXmppPassword(pw, 'morphitio')).toBeNull();
	});

	it('the wizard asks for another password instead of sending one Prosody refuses', async () => {
		const LRM = 'Pass\u200eWord-2026x';
		const r = await wizard(
			[
				...NEW,
				'#0',
				'morphitio',
				LRM,
				'Good-Pass-2026x',
				'Good-Pass-2026x',
				'me@example.org',
				'#last'
			],
			{
				// What real Prosody 0.12 answers for it (measured against it).
				admin: (a, input) =>
					a[0] === 'register' && /\u200e/.test(input.MORPHIT_NOTIFY_XMPP_PASSWORD ?? '')
						? { ok: false, error: 'refused', why: 'not_allowed', text: 'password fails SASLprep' }
						: openRelay()(a)
			}
		);
		const sent = r.calls
			.filter((c) => c.args[0] === 'register')
			.map((c) => c.input.MORPHIT_NOTIFY_XMPP_PASSWORD);
		expect(sent).toEqual(['Good-Pass-2026x']);
	});
});

describe('guards for round-1 fixes no test held', () => {
	it('R2-6: an existing account’s password wrapped in quotes is refused before its archive is touched', async () => {
		// 'y': "Use that server?" if the password got through (it must not: the
		// run then ends at the menu, out of answers).
		const r = await wizard([...EXISTING, 'bot@example.org', '"Quoted-Pass-123"', 'y'], {
			admin: openRelay()
		});
		expect(r.calls.filter((c) => c.args[1] === 'xmpp')).toEqual([]);
		expect(r.saved).toHaveLength(0);
	});

	it('R2-7: a made password never contains a short username (sampled)', () => {
		for (let i = 0; i < 400; i++) expect(makeXmppPassword('ab').toLowerCase()).not.toContain('ab');
	});
});

describe('docs say what the wizard does', () => {
	it('RUN-A §12 does not send the operator off to make a Session account first: the wizard makes it', async () => {
		const r = await wizard(['#label Set up Session', '#0', '', '#last'], {
			admin: (a) =>
				a[0] === 'new-session'
					? { ok: true, mnemonic: Array(13).fill('word').join(' '), sessionId: '05ab' }
					: { ok: true }
		});
		expect(r.calls.some((c) => c.args[0] === 'new-session')).toBe(true);
		const doc = readFileSync(
			join(import.meta.dirname, '../../../docs/RUN-A-MORPHIT-NODE.md'),
			'utf8'
		);
		const line = doc
			.split('\n')
			.find(
				(l) =>
					l.startsWith('Make each app’s account first') ||
					l.startsWith("Make each app's account first")
			);
		expect(line).toBeDefined();
		// Every app the wizard makes the account for is named among the exceptions.
		expect(line).toMatch(/except[^.]*Session/);
	});
});

describe('relayReadsSame does not refuse values that worked before', () => {
	it('every channel’s usual values pass', async () => {
		const { relayReadsSame } = await import('../src/lib/offlineNotifyEnv.ts');
		for (const v of [
			'smtp.example.com',
			'587',
			'tls',
			'ops@example.org',
			'p@ss "word" it\'s $x #1',
			'123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123',
			Array(13).fill('abbey').join(' '),
			'syt_Ym90_AbCdEfGhIjKlMnOp_1a2b3c',
			'@bot:matrix.org',
			'https://matrix-client.matrix.org',
			'morphitio@og.im',
			'CtkHp-2jAyX%hYWi2-KcmPE='
		])
			expect(relayReadsSame(v)).toBe(true);
	});
});
