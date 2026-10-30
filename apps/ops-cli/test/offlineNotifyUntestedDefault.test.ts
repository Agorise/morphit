/**
 * offline-notify → XMPP: a new account whose test note is skipped. "Save …
 * without a test note?" defaults to the SAFE answer, which depends on the
 * password:
 *  - typed by the operator: No — nothing untested is saved (they know the
 *    password and can add the account later);
 *  - made for the operator: Yes — that password is kept nowhere else, so not
 *    saving abandons the account for good (review v1.21.18: Enter did that).
 *    It is then saved UNTESTED: the relay's `check` for XMPP contacts nothing
 *    (it only reads the settings), and the wizard says so.
 * (The harness here answers '' with each question's own default.)
 */
import { describe, expect, it } from 'vitest';
import {
	runOfflineNotify,
	type AdminAnswer,
	type AskHandler,
	type OfflineNotifyDeps
} from '../src/commands/offlineNotify.ts';
import { abortError } from '../src/init/prompt.ts';

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
				askYesNo: async (_q, d) => {
					const a = next();
					return a === '' ? d : a === 'y';
				},
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
const openRelay = (args: readonly string[]): AdminAnswer =>
	args[0] === 'register-form'
		? { ok: true, status: 'open' }
		: args[0] === 'archive-off'
			? { ok: true, archive: 'off' }
			: { ok: true };

describe('a new XMPP account, test note skipped', () => {
	it('its password was typed: Enter at "Save … without a test note?" saves nothing', async () => {
		const pw = 'Typed-Pass-2026x';
		const r = await wizard([...NEW, '#0', 'morphitio', pw, pw, '', '', '#last'], {
			admin: openRelay
		});
		expect(r.saved).toHaveLength(0);
		expect(r.printed).toMatch(/morphitio@og\.im was made and stays on its server/);
		expect(r.printed).toMatch(/choose “Use an account that already exists”/);
	});

	it('its password was made for the operator (kept nowhere else): Enter saves it, and says it is not tested', async () => {
		const r = await wizard([...NEW, '#0', 'morphitio', '', '', '', '#last'], { admin: openRelay });
		expect(r.printed).toMatch(
			/kept nowhere else: saving it here is the only way to keep this account usable/
		);
		expect(r.calls.some((c) => c.args[0] === 'check' && c.args[1] === 'xmpp')).toBe(true);
		// The settings check contacts nothing: never "the account works".
		expect(r.printed).toMatch(/settings are complete \(not tested: only a test note tests them\)/);
		expect(r.printed).not.toMatch(/account works/);
		expect(r.saved).toHaveLength(1);
		expect(r.saved[0]!.MORPHIT_NOTIFY_XMPP_JID).toBe('morphitio@og.im');
		expect(r.printed).not.toMatch(/was made and stays on its server, but it is not saved/);
	});

	it('…and a "no" there still saves nothing, and says the account cannot be used', async () => {
		const r = await wizard([...NEW, '#0', 'morphitio', '', '', 'n', '#last'], { admin: openRelay });
		expect(r.saved).toHaveLength(0);
		expect(r.printed).toMatch(/kept nowhere, so the account cannot be used/);
	});

	it('an explicit yes still saves it (and says it is not tested)', async () => {
		const r = await wizard([...NEW, '#0', 'morphitio', '', '', 'y', '#last'], { admin: openRelay });
		expect(r.saved).toHaveLength(1);
		expect(r.printed).toMatch(/not tested/);
	});
});
