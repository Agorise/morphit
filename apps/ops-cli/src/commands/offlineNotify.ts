/**
 * morphit-ops offline-notify — the accounts this site sends Settings → Offline
 * Notifications from.
 *
 * A user of this site can ask for a short note ("Someone just sent you a chat
 * message on <site>", with a link) on Matrix, Session, XMPP, Telegram or email
 * when a chat message arrives while she is away. She can only pick an app this
 * site has an account on; this is where the operator sets those accounts up:
 *
 *   sudo morphit-ops offline-notify          guided setup (a menu)
 *   sudo morphit-ops offline-notify status   what is on, nothing changed
 *
 * Every account is TESTED before it is saved — a real note to an address the
 * operator types (or, for Telegram, the token checked with Telegram) — through
 * the relay's own code, as the relay's own user, with the relay's own network
 * rules (apps/relay/src/notify/adminCli.ts). Saved to
 * /etc/morphit/relay-notify.env (root:morphit-relay 0640, every value
 * single-quoted: the relay unit sources it with bash). Then the relay restarts
 * and the wizard asks the RUNNING relay which apps it now offers.
 *
 * On a zero-clearnet (Tor-only) site only .onion servers can be used, and
 * Telegram and Session cannot be offered at all.
 *
 * Never prints a password, a token or the Session recovery words. Text that
 * comes from a server (a Matrix user ID, a Telegram bot name, an error's
 * reason) is printed as plain text on one line (cleanLabel), never as
 * terminal controls.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
	ask as realAsk,
	askChoice as realAskChoice,
	askPassword as realAskPassword,
	askYesNo as realAskYesNo
} from '../init/prompt.ts';
import { cleanLabel, withSpinner } from '../init/spinner.ts';
import { relayHealthUrl, waitForAnswers } from '../lib/afterRestartHeal.ts';
import { homeserverRoute, mintMatrixToken } from '../lib/matrixBot.ts';
import {
	CHANNEL_KEYS,
	CHANNEL_MAIN_KEY,
	NOTIFY_CHANNELS,
	NOTIFY_ENV_PATH,
	readNotifyEnv,
	withoutChannel,
	writableValue,
	writeNotifyEnv,
	type NotifyChannel
} from '../lib/offlineNotifyEnv.ts';
import { RELAY_ENV_FILES } from '../lib/relayHiddenHeal.ts';
import { runAsync } from '../lib/spinRun.ts';

export interface OfflineNotifyCtx {
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
	/** The Morphit checkout (/opt/morphit). */
	readonly repoRoot: string;
}

/** One JSON line from the relay's adminCli. */
export interface AdminAnswer {
	readonly ok: boolean;
	readonly error?: string;
	readonly reason?: string;
	readonly [k: string]: unknown;
}

export interface OfflineNotifyDeps {
	readonly ask?: (q: string, dflt?: string) => Promise<string>;
	readonly askPassword?: (q: string) => Promise<string>;
	readonly askChoice?: (q: string, options: readonly string[]) => Promise<number>;
	readonly askYesNo?: (q: string, defaultYes: boolean) => Promise<boolean>;
	/** Run the relay's adminCli with these args, settings on stdin. */
	readonly admin?: (args: readonly string[], input: Record<string, string>) => Promise<AdminAnswer>;
	readonly readEnv?: () => Record<string, string>;
	/** Write the file: the `owned` channels' keys exactly as in `values`,
	 *  every other line as it was (lib/offlineNotifyEnv.ts). */
	readonly writeEnv?: (values: Record<string, string>, owned: readonly NotifyChannel[]) => void;
	/** Restart the relay, wait for it, and return the apps it offers (null: no answer). */
	readonly restartRelay?: () => Promise<string[] | null>;
	readonly mintMatrix?: typeof mintMatrixToken;
	readonly isRoot?: () => boolean;
	readonly isTTY?: boolean;
	readonly print?: (line: string) => void;
}

const LABEL: Record<NotifyChannel, string> = {
	matrix: 'Matrix',
	session: 'Session',
	xmpp: 'XMPP (Jabber)',
	telegram: 'Telegram',
	email: 'Email'
};

/** Why the relay keeps a channel with settings off, in plain words. */
const OFF_REASON: Record<string, string> = {
	zero_clearnet: 'off — this site uses no clearnet, and this server is not an .onion address',
	incomplete: 'off — its settings are incomplete',
	no_tor: 'off — Session notes go through Tor, and this relay has no Tor set up'
};

/** Server-supplied (or otherwise outside) text as plain text on one line. */
const clean = (v: unknown): string => cleanLabel(String(v ?? ''));

/** How long the relay's tool may take (a Session note through Tor is slow). */
const ADMIN_TIMEOUT_MS = 180_000;
/** The apps whose "check" signs in for real (the relay asks Telegram and the
 *  homeserver); for the others only a test note tests the account. */
const CHECKED_ONLINE: ReadonlySet<NotifyChannel> = new Set(['telegram', 'matrix']);

/** Where the relay keeps the key its users' saved addresses are sealed with. */
const KEY_FILE = '/var/lib/morphit-relay/offline-notify.key';

/** The relay has no address for the links in its notes. */
export const NO_LINK =
	'this site has no address to link to yet — set MORPHIT_INSTANCE_ORIGIN, or the .onion address (MORPHIT_INSTANCE_TOR_ADDRESS) on a Tor-only site';

// ── what the relay says about the key (adminCli `status` → key) ─────────

/**
 * "Start over" deletes every user's saved addresses: offered ONLY when the
 * relay found the key file really gone ('missing') or another one in its
 * place ('mismatch') — never when it merely could not read the file or reach
 * its database (the addresses may be fine). PURE.
 */
export function startOverOffered(key: unknown): boolean {
	return key === 'missing' || key === 'mismatch';
}

/** Lines explaining a key state other than 'ok' / 'none' (null for those).
 *  `alarm`: the relay verified the addresses cannot be opened. PURE. */
export function keyNotice(
	key: unknown,
	detail: unknown
): { readonly alarm: boolean; readonly lines: readonly string[] } | null {
	if (key === undefined || key === null || key === 'ok' || key === 'none') return null;
	const said =
		typeof detail === 'string' && detail.trim() !== '' ? [`The relay says: ${clean(detail)}`] : [];
	switch (key) {
		case 'missing':
			return {
				alarm: true,
				lines: [
					`Users' saved addresses cannot be opened: the key file ${KEY_FILE} is missing.`,
					...said,
					'Offline notes are off until that file is back (from a backup of this server),',
					'or you start over below (every user sets her addresses up again).'
				]
			};
		case 'mismatch':
			return {
				alarm: true,
				lines: [
					`Users' saved addresses cannot be opened: ${KEY_FILE} is not the key they were saved with.`,
					...said,
					'Offline notes are off until the right file is back (from a backup of this server),',
					'or you start over below (every user sets her addresses up again).'
				]
			};
		case 'unreadable':
			return {
				alarm: false,
				lines: [
					`The relay's user could not read its key file ${KEY_FILE} just now.`,
					...said,
					"Users' saved addresses are kept. Check that the file belongs to the relay's user:",
					'  ls -l /var/lib/morphit-relay/'
				]
			};
		case 'db_error':
			return {
				alarm: false,
				lines: [
					"The relay's database did not answer, so users' saved addresses could not be checked.",
					...said,
					'They are kept. Check:  sudo morphit-ops doctor'
				]
			};
		case 'no_state_dir':
			return {
				alarm: false,
				lines: [
					'The relay has no folder for its own files set up, so its key could not be looked for.',
					...said,
					"Users' saved addresses are kept. Check:  sudo morphit-ops doctor"
				]
			};
		default:
			return {
				alarm: false,
				lines: [
					`Could not tell whether users' saved addresses can be opened (the relay said: ${clean(key)}).`,
					...said,
					'Check:  sudo morphit-ops doctor'
				]
			};
	}
}

/** A failed answer from the relay's tool, in plain words (one line). PURE. */
export function plainWhy(
	r: AdminAnswer,
	ctx: { readonly channel?: NotifyChannel; readonly to?: string } = {}
): string {
	const app = ctx.channel !== undefined ? LABEL[ctx.channel] : 'that app';
	switch (r.error) {
		case 'zero_clearnet':
			return 'this site uses no clearnet, and that server is not an .onion address';
		case 'invalid_address':
			return `${ctx.to !== undefined ? clean(ctx.to) : 'that'} is not a valid address for ${app}`;
		case 'incomplete':
			return 'the settings are incomplete';
		case 'no_tor':
			return 'this relay has no Tor set up (Session notes go through Tor)';
		case 'no_link':
			return NO_LINK;
		case 'not_set':
			return `${app} is not set up on this relay`;
		case 'timed_out':
			return `the relay's setup tool did not finish within ${ADMIN_TIMEOUT_MS / 60_000} minutes and was stopped`;
		case 'no_answer':
			return "the relay's setup tool gave no answer";
		case 'usage':
		case 'bad_input':
			return "the relay's setup tool did not understand the request (is the relay the same version as morphit-ops?)";
		case 'relay_config':
			return `the relay's own settings could not be read${r.reason !== undefined ? ` (${clean(r.reason)})` : ''}`;
		default:
			return clean(r.reason ?? r.error ?? 'no answer');
	}
}

// ── running the relay's adminCli ────────────────────────────────────────

async function userExists(name: string): Promise<boolean> {
	return (await runAsync('id', ['-u', name], { timeoutMs: 10_000 })).status === 0;
}

/** The User= the relay unit runs as ('' when systemd gives none). */
async function relayUnitUser(): Promise<string> {
	const r = await runAsync('systemctl', ['show', '-P', 'User', 'morphit-relay'], {
		timeoutMs: 10_000
	});
	return r.status === 0 ? r.stdout.trim() : '';
}

/**
 * Who runs the relay's tool: the user the relay unit runs as (null = root, as
 * the unit does when it says root). When systemd names none, the relay's usual
 * account where it exists, else root. PURE.
 */
export function adminRunAs(unitUser: string, relayAccountExists: boolean): string | null {
	const u = unitUser.trim();
	if (u === 'root' || u === '0') return null;
	if (u !== '') return u;
	return relayAccountExists ? 'morphit-relay' : null;
}

/** As the relay starts: its user, its env files (same order), its directory.
 *  Settings go on stdin, never the command line. The tool and everything it
 *  starts run in a process group of their own, so the time limit stops all of
 *  them. */
export function realAdmin(repoRoot: string, opts: { readonly timeoutMs?: number } = {}) {
	return async (args: readonly string[], input: Record<string, string>): Promise<AdminAnswer> => {
		// Asked without blocking: the spinner around this keeps turning.
		const unit = await relayUnitUser();
		const runAs = adminRunAs(unit, unit === '' && (await userExists('morphit-relay')));
		return new Promise((resolve) => {
			const tsx = join(repoRoot, 'node_modules/.bin/tsx');
			const script =
				'set -a; for f in "${@:1:' +
				String(RELAY_ENV_FILES.length) +
				'}"; do if [ -r "$f" ]; then . "$f"; fi; done; set +a; ' +
				'shift ' +
				String(RELAY_ENV_FILES.length) +
				'; exec "$0" src/notify/adminCli.ts "$@"';
			const argv = ['-c', script, tsx, ...RELAY_ENV_FILES, ...args];
			const cmd = runAs !== null ? 'runuser' : 'bash';
			const full = runAs !== null ? ['-u', runAs, '--', 'bash', ...argv] : argv;
			let done = false;
			let exited = false;
			let outEnded = false;
			let out = '';
			let grace: NodeJS.Timeout | null = null;
			let child: ReturnType<typeof spawn>;
			const killGroup = (): void => {
				if (child?.pid === undefined) return;
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch {
					/* already gone */
				}
			};
			const finish = (answer: AdminAnswer | null): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				if (grace !== null) clearTimeout(grace);
				process.removeListener('exit', killGroup);
				// Whatever the tool left behind (still holding its output open) goes too.
				if (!outEnded) killGroup();
				if (answer !== null) return resolve(answer);
				const line = out.trim().split('\n').at(-1) ?? '';
				try {
					resolve(JSON.parse(line) as AdminAnswer);
				} catch {
					resolve({ ok: false, error: 'no_answer' });
				}
			};
			const timer = setTimeout(() => {
				killGroup();
				finish({ ok: false, error: 'timed_out' });
			}, opts.timeoutMs ?? ADMIN_TIMEOUT_MS);
			try {
				child = spawn(cmd, full, {
					cwd: join(repoRoot, 'apps/relay'),
					stdio: ['pipe', 'pipe', 'pipe'],
					detached: true
				});
			} catch {
				finish({ ok: false, error: 'no_answer' });
				return;
			}
			// morphit-ops exiting (Ctrl-C under the spinner) takes the tool with it.
			process.on('exit', killGroup);
			child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
			child.stdout?.on('end', () => {
				outEnded = true;
				if (exited) finish(null);
			});
			child.stderr?.on('data', () => undefined);
			child.on('exit', () => {
				exited = true;
				if (outEnded) finish(null);
				// Its answer is written before it exits; a moment for the rest of it.
				else grace = setTimeout(() => finish(null), 2_000);
			});
			child.on('error', () => finish({ ok: false, error: 'no_answer' }));
			child.stdin?.on('error', () => undefined);
			child.stdin?.end(JSON.stringify(input));
		});
	};
}

/** Restart the relay, wait for it to answer, ask it which apps it offers.
 *  The restart runs without blocking, so the spinner around it turns. */
export async function realRestartRelay(): Promise<string[] | null> {
	const r = await runAsync('systemctl', ['restart', 'morphit-relay'], { timeoutMs: 120_000 });
	if (r.status !== 0 && !r.timedOut) return null;
	const left = await waitForAnswers(['morphit-relay.service'], { maxMs: 120_000 });
	if (left.length > 0) return null;
	const url = relayHealthUrl().replace(/\/v1\/health$/, '/v1/notify/channels');
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
		const b = (await res.json()) as { channels?: Array<{ id?: string }> };
		return (b.channels ?? []).map((c) => String(c.id));
	} catch {
		return null;
	}
}

// ── the wizard ──────────────────────────────────────────────────────────

/** All of a channel's keys: its values in `merged`, '' for the unset ones
 *  (so a setting being removed is removed for the test too). PURE. */
export function adminInput(
	merged: Readonly<Record<string, string>>,
	channel: NotifyChannel
): Record<string, string> {
	return Object.fromEntries(CHANNEL_KEYS[channel].map((k) => [k, merged[k] ?? '']));
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export async function runOfflineNotify(
	ctx: OfflineNotifyCtx,
	deps: OfflineNotifyDeps = {}
): Promise<number> {
	const c = ctx.colorEnabled;
	const green = (s: string): string => (c ? `\u001b[32m${s}\u001b[0m` : s);
	const yellow = (s: string): string => (c ? `\u001b[33m${s}\u001b[0m` : s);
	const dim = (s: string): string => (c ? `\u001b[2m${s}\u001b[0m` : s);
	const print = deps.print ?? ((l: string) => console.log(l));
	const ask = deps.ask ?? realAsk;
	const askPassword = deps.askPassword ?? realAskPassword;
	const askChoice = deps.askChoice ?? ((q: string, o: readonly string[]) => realAskChoice(q, o));
	const askYesNo = deps.askYesNo ?? realAskYesNo;
	const admin = deps.admin ?? realAdmin(ctx.repoRoot);
	const readEnv = deps.readEnv ?? (() => readNotifyEnv());
	const writeEnv =
		deps.writeEnv ??
		((v: Record<string, string>, owned: readonly NotifyChannel[]) =>
			writeNotifyEnv(v, undefined, undefined, owned));
	const restartRelay = deps.restartRelay ?? realRestartRelay;
	const mint = deps.mintMatrix ?? mintMatrixToken;

	if (!(deps.isRoot ?? (() => process.getuid?.() === 0))()) {
		print('  Run this with sudo: sudo morphit-ops offline-notify');
		return 1;
	}

	const status = async (): Promise<AdminAnswer> =>
		withSpinner('Asking the relay what is set up…', () => admin(['status'], {}));

	const show = (st: AdminAnswer): void => {
		const offered = (st.offered as string[] | undefined) ?? [];
		const off = (st.off as Record<string, string> | undefined) ?? {};
		const who: Record<NotifyChannel, unknown> = {
			matrix: st.matrix,
			session: st.sessionId,
			xmpp: st.xmpp,
			telegram: st.telegram ? `@${String(st.telegram)}` : null,
			email: st.email
		};
		print('');
		print(`  Offline notifications on ${clean(st.site)}`);
		print(
			dim('  Your users can ask for a short note when a chat message arrives while they are away —')
		);
		print(dim('  only on the apps you set up here. The note never says who wrote or what.'));
		if (st.hiddenOnly === true)
			print(
				dim('  This site uses no clearnet: only .onion servers work; Telegram and Session cannot.')
			);
		if (st.link === null) print(yellow(`  Note: ${NO_LINK}.`));
		print('');
		for (const ch of NOTIFY_CHANNELS) {
			const line = offered.includes(ch)
				? green(`on — notes come from ${clean(who[ch])}`)
				: off[ch]
					? yellow(OFF_REASON[off[ch]!] ?? `off (${clean(off[ch])})`)
					: dim('not set up');
			print(`    ${LABEL[ch].padEnd(14)} ${line}`);
		}
		const notice = keyNotice(st.key, st.keyDetail);
		if (notice !== null) {
			print('');
			const [first, ...rest] = notice.lines;
			print(notice.alarm ? yellow(`  ⚠ ${first}`) : `  ${first}`);
			for (const l of rest) print(dim(`    ${l}`));
		}
		print('');
	};

	let st = await status();
	if (!st.ok) {
		print(yellow(`  ✗ Could not read the relay's settings: ${plainWhy(st)}`));
		print(dim('    Check:  sudo morphit-ops doctor'));
		return 1;
	}
	if (ctx.positional[0] === 'status' || !(deps.isTTY ?? process.stdin.isTTY === true)) {
		show(st);
		return 0;
	}

	/** Restart the relay under the spinner; null when it did not answer (said so). */
	const restart = async (label: string): Promise<string[] | null> => {
		const offered = await withSpinner(label, () => restartRelay());
		if (offered === null) {
			print(yellow('  ⚠ The relay did not answer after the restart.'));
			print(dim('    Check:  journalctl -u morphit-relay -n 50 --no-pager'));
		}
		return offered;
	};

	/** Save (the settings of `owned`), restart, and confirm the running relay
	 *  offers `channel`. */
	const save = async (
		values: Record<string, string>,
		channel: NotifyChannel | null,
		owned: readonly NotifyChannel[]
	): Promise<void> => {
		try {
			writeEnv(values, owned);
		} catch (err) {
			print(yellow(`  ✗ Not saved: ${clean((err as Error).message)}`));
			return;
		}
		print(green(`  ✓ Saved to ${NOTIFY_ENV_PATH}.`));
		const offered = await restart('Restarting the relay so it uses the new settings…');
		if (offered === null) return;
		if (channel === null) {
			print(green('  ✓ The relay is back.'));
		} else if (offered.includes(channel)) {
			print(green(`  ✓ ${LABEL[channel]} is on: users can now choose it in Settings.`));
		} else {
			print(yellow(`  ⚠ The relay is back, but it does not offer ${LABEL[channel]}.`));
		}
	};

	/** Notes carry the site's link: without one nothing can be tested, so no
	 *  server is contacted at all. */
	const linkMissing = (): boolean => {
		if (st.link !== null) return false;
		print(yellow(`  ✗ Nothing can be set up or tested yet: ${NO_LINK}.`));
		print('  Nothing was changed.');
		return true;
	};

	/** Test, then save if it worked (or if the operator insists). */
	const testAndSave = async (
		channel: NotifyChannel,
		candidate: Record<string, string>,
		test: { kind: 'send'; to: string } | { kind: 'check' }
	): Promise<void> => {
		// Only what will be saved: the channel's old settings are not mixed in.
		const merged = { ...withoutChannel(readEnv(), channel), ...candidate };
		for (const [k, v] of Object.entries(candidate)) {
			if (!writableValue(v)) {
				print(yellow(`  ✗ ${k} cannot contain a line break. Nothing was changed.`));
				return;
			}
		}
		const label =
			test.kind === 'send'
				? channel === 'session'
					? 'Sending a test note through Tor (this can take a minute)…'
					: 'Sending a test note…'
				: `Checking the ${LABEL[channel]} account…`;
		const r = await withSpinner(label, () =>
			admin(
				test.kind === 'send' ? ['send', channel] : ['check', channel],
				// The test address goes on stdin, never the command line.
				test.kind === 'send'
					? { ...adminInput(merged, channel), to: test.to }
					: adminInput(merged, channel)
			)
		);
		if (r.ok) {
			print(
				green(
					test.kind === 'send'
						? `  ✓ Test note sent to ${clean(test.to)} — have a look.`
						: CHECKED_ONLINE.has(channel)
							? `  ✓ The ${LABEL[channel]} account works.`
							: `  ✓ The ${LABEL[channel]} settings are complete (not tested: only a test note tests them).`
				)
			);
			if (channel === 'telegram' && typeof r.username === 'string') {
				merged.MORPHIT_NOTIFY_TELEGRAM_USERNAME = r.username;
				print(dim(`    Notes will come from @${clean(r.username)}.`));
			}
		} else {
			const why = plainWhy(r, test.kind === 'send' ? { channel, to: test.to } : { channel });
			print(yellow(`  ✗ The test did not work: ${why}`));
			if (!(await askYesNo('  Save these settings anyway?', false))) {
				print('  Nothing was changed.');
				return;
			}
		}
		await save(merged, channel, [channel]);
	};

	const askNonEmpty = async (q: string, dflt?: string): Promise<string | null> => {
		const v = (await ask(q, dflt)).trim();
		if (v === '') {
			print('  Nothing entered — nothing was changed.');
			return null;
		}
		return v;
	};

	const setupEmail = async (): Promise<void> => {
		print(dim('  Use a mailbox made for this — never your personal one. Your mail provider’s'));
		print(dim('  “SMTP” settings: the server, and a login that is allowed to send.'));
		print(dim('  Send FROM an address at that mail provider. If you published the “this domain'));
		print(dim('  sends no email” DNS records (docs/RUN-A-MORPHIT-NODE.md §13), mail from your'));
		print(dim('  site’s own domain will be refused unless you change those records first.'));
		print(dim('  Many providers keep a copy of every sent mail in “Sent”: turn that off for this'));
		print(dim('  mailbox if you can, or empty it now and then — it lists your users’ addresses.'));
		const host = await askNonEmpty('Mail server (SMTP host, e.g. smtp.example.com)');
		if (host === null) return;
		const sec = await askChoice('How does it want the connection secured?', [
			'STARTTLS on port 587 (the usual)',
			'Direct TLS on port 465'
		]);
		const port = await ask('Port', sec === 0 ? '587' : '465');
		const user = await askNonEmpty('Login (username)');
		if (user === null) return;
		const password = await askPassword('Password');
		if (password === '') {
			print('  No password — nothing was changed.');
			return;
		}
		const from = await askNonEmpty(
			'The address notes come from',
			user.includes('@') ? user : undefined
		);
		if (from === null) return;
		const to = await askNonEmpty('Send a test note to which address? (yours; it is not saved)');
		if (to === null) return;
		await testAndSave(
			'email',
			{
				MORPHIT_NOTIFY_EMAIL_HOST: host,
				MORPHIT_NOTIFY_EMAIL_PORT: port.trim(),
				MORPHIT_NOTIFY_EMAIL_SECURITY: sec === 0 ? 'starttls' : 'tls',
				MORPHIT_NOTIFY_EMAIL_USER: user,
				MORPHIT_NOTIFY_EMAIL_PASSWORD: password,
				MORPHIT_NOTIFY_EMAIL_FROM: from
			},
			{ kind: 'send', to }
		);
	};

	const setupMatrix = async (): Promise<void> => {
		print(dim('  A Matrix account just for this site’s notes (not your own). Users get its'));
		print(dim('  invitation the first time; after that the notes arrive in that chat.'));
		const homeserver = (
			(await askNonEmpty('Its homeserver (e.g. https://matrix.org)')) ?? ''
		).replace(/\/+$/, '');
		if (homeserver === '') return;
		const route = homeserverRoute(homeserver);
		if (route === 'invalid') {
			print(
				yellow(
					'  ✗ That is not a web address: it looks like https://matrix.example.org. Nothing was changed.'
				)
			);
			return;
		}
		if (st.hiddenOnly === true && route !== 'onion' && route !== 'loopback') {
			print(yellow('  ✗ This site uses no clearnet: the homeserver must be an .onion address.'));
			return;
		}
		// The bot's password (and later its token) would cross the internet
		// readable by anyone on the way: http:// only to this machine or an .onion.
		if (new URL(homeserver).protocol === 'http:' && route === 'clearnet') {
			print(
				yellow('  ✗ That address starts with http://, so the bot’s password and token would be')
			);
			print(
				yellow('    sent unencrypted. Use the homeserver’s https:// address (http:// works only')
			);
			print(
				yellow('    for a homeserver on this server or an .onion address). Nothing was changed.')
			);
			return;
		}
		// Signing in from here goes straight out, not through Tor: only where the
		// homeserver is reachable that way.
		const canMint = st.hiddenOnly !== true || route === 'loopback';
		const method = canMint
			? await askChoice('How should it sign in?', [
					'Username + password (I’ll get a fresh access token — recommended)',
					'Paste an access token'
				])
			: 1;
		let token = '';
		if (method === 0) {
			const user = (await askNonEmpty('Username (just the name, no @ or :server)')) ?? '';
			if (user === '') return;
			const password = await askPassword('Password');
			const minted = await withSpinner('Signing in…', () => mint(homeserver, user, password));
			if (minted === null) {
				print(
					yellow(
						'  ✗ Sign-in failed. Check the homeserver, username and password. Nothing was changed.'
					)
				);
				return;
			}
			token = minted;
		} else {
			token = await askPassword('Access token');
			if (token.trim() === '') {
				print('  No token — nothing was changed.');
				return;
			}
		}
		const candidate = {
			MORPHIT_NOTIFY_MATRIX_HOMESERVER: homeserver,
			MORPHIT_NOTIFY_MATRIX_TOKEN: token.trim(),
			MORPHIT_NOTIFY_MATRIX_USER_ID: '@pending:check'
		};
		// Who the token belongs to — the relay asks the homeserver.
		const who = await withSpinner('Checking the account…', () =>
			admin(['check', 'matrix'], adminInput({ ...readEnv(), ...candidate }, 'matrix'))
		);
		if (!who.ok || typeof who.userId !== 'string') {
			print(
				yellow(
					`  ✗ The homeserver did not accept the token: ${who.ok ? 'it did not say whose token it is' : plainWhy(who, { channel: 'matrix' })}`
				)
			);
			print('  Nothing was changed.');
			return;
		}
		candidate.MORPHIT_NOTIFY_MATRIX_USER_ID = who.userId;
		print(green(`  ✓ Signed in as ${clean(who.userId)}.`));
		const to = (
			await ask('Send a test note to your Matrix address? (e.g. @you:matrix.org — Enter to skip)')
		).trim();
		await testAndSave('matrix', candidate, to === '' ? { kind: 'check' } : { kind: 'send', to });
	};

	const setupXmpp = async (): Promise<void> => {
		print(
			dim('  An XMPP (Jabber) account just for this site’s notes. If its server keeps a message')
		);
		print(
			dim('  archive (MAM), turn it off for this account: it would list your users’ addresses.')
		);
		const jid = await askNonEmpty('Its address (e.g. notices@jabber.example)');
		if (jid === null) return;
		const password = await askPassword('Its password');
		if (password === '') {
			print('  No password — nothing was changed.');
			return;
		}
		const host = (await ask('Server to connect to (Enter: the address’s own domain)')).trim();
		const sec = await askChoice('How does it want the connection secured?', [
			'STARTTLS on port 5222 (the usual)',
			'Direct TLS on port 5223'
		]);
		const port = await ask('Port', sec === 0 ? '5222' : '5223');
		const to = await askNonEmpty(
			'Send a test note to which XMPP address? (yours; it is not saved)'
		);
		if (to === null) return;
		await testAndSave(
			'xmpp',
			{
				MORPHIT_NOTIFY_XMPP_JID: jid,
				MORPHIT_NOTIFY_XMPP_PASSWORD: password,
				MORPHIT_NOTIFY_XMPP_HOST: host,
				MORPHIT_NOTIFY_XMPP_PORT: port.trim(),
				MORPHIT_NOTIFY_XMPP_SECURITY: sec === 0 ? 'starttls' : 'tls'
			},
			{ kind: 'send', to }
		);
	};

	const setupTelegram = async (): Promise<void> => {
		print(dim('  A Telegram bot for this site: in Telegram, open @BotFather, send /newbot,'));
		print(
			dim('  give it a name (e.g. “Vigilante Trading notes”), and copy the token it gives you.')
		);
		print(dim('  Telegram sees which users the bot writes to and when — never what about.'));
		const token = (await askPassword('Bot token')).trim();
		if (token === '') {
			print('  No token — nothing was changed.');
			return;
		}
		await testAndSave('telegram', { MORPHIT_NOTIFY_TELEGRAM_TOKEN: token }, { kind: 'check' });
	};

	const setupSession = async (): Promise<void> => {
		print(dim('  A Session account for this site: users get notes from it in their Session app'));
		print(dim('  (the first one under “Message Requests”). Sent through Tor.'));
		const how = await askChoice('Which Session account?', [
			'Make a new one for this site (recommended)',
			'Use an existing one (type its 13 recovery words)'
		]);
		let mnemonic = '';
		let sessionId = '';
		if (how === 0) {
			const r = await withSpinner('Making a Session account…', () => admin(['new-session'], {}));
			if (!r.ok || typeof r.mnemonic !== 'string') {
				print(
					yellow(
						`  ✗ Could not make one: ${r.ok ? 'no answer' : plainWhy(r, { channel: 'session' })}. Nothing was changed.`
					)
				);
				return;
			}
			mnemonic = r.mnemonic;
			sessionId = String(r.sessionId);
		} else {
			mnemonic = (await askPassword('The 13 recovery words')).trim().replace(/\s+/g, ' ');
			if (mnemonic.split(' ').length !== 13) {
				print(yellow('  ✗ That is not 13 words. Nothing was changed.'));
				return;
			}
		}
		if (sessionId !== '') print(green(`  ✓ This site’s Session ID: ${clean(sessionId)}`));
		print(dim(`    Its recovery words are kept only in ${NOTIFY_ENV_PATH}.`));
		const to = (await ask('Send a test note to your Session ID? (05… — Enter to skip)')).trim();
		await testAndSave(
			'session',
			{ MORPHIT_NOTIFY_SESSION_MNEMONIC: mnemonic },
			to === '' ? { kind: 'check' } : { kind: 'send', to }
		);
	};

	const SETUP: Record<NotifyChannel, () => Promise<void>> = {
		matrix: setupMatrix,
		session: setupSession,
		xmpp: setupXmpp,
		telegram: setupTelegram,
		email: setupEmail
	};

	for (;;) {
		show(st);
		const current = readEnv();
		const has = (ch: NotifyChannel): boolean => (current[CHANNEL_MAIN_KEY[ch]] ?? '') !== '';
		const possible = NOTIFY_CHANNELS.filter(
			(ch) => !(st.hiddenOnly === true && (ch === 'telegram' || ch === 'session'))
		);
		const offered = (st.offered as string[] | undefined) ?? [];
		const options: Array<{ label: string; run: () => Promise<void> }> = [
			...possible.map((ch) => ({
				label: `${has(ch) ? 'Change' : 'Set up'} ${LABEL[ch]}`,
				run: async () => {
					if (!linkMissing()) await SETUP[ch]();
				}
			}))
		];
		const testable = offered.filter(
			(ch): ch is NotifyChannel => ch !== 'telegram'
		) as NotifyChannel[];
		if (testable.length > 0)
			options.push({
				label: 'Send a test note',
				run: async () => {
					if (linkMissing()) return;
					const i = await askChoice(
						'From which app?',
						testable.map((ch) => LABEL[ch])
					);
					const ch = testable[i]!;
					const to = await askNonEmpty(`To which ${LABEL[ch]} address? (yours; it is not saved)`);
					if (to === null) return;
					const r = await withSpinner('Sending a test note…', () => admin(['send', ch], { to }));
					print(
						r.ok
							? green(`  ✓ Sent to ${clean(to)} — have a look.`)
							: yellow(`  ✗ It did not work: ${plainWhy(r, { channel: ch, to })}`)
					);
				}
			});
		const set = NOTIFY_CHANNELS.filter(has);
		if (set.length > 0)
			options.push({
				label: 'Turn an app off',
				run: async () => {
					const i = await askChoice(
						'Which one?',
						set.map((ch) => LABEL[ch])
					);
					const ch = set[i]!;
					print(
						dim(
							`  Users who chose ${LABEL[ch]} stop getting notes there; their other apps keep working.`
						)
					);
					print(
						dim(
							`  Every ${LABEL[ch]} address users saved here is deleted too${ch === 'matrix' ? ', and the bot leaves their chats' : ''}.`
						)
					);
					if (
						!(await askYesNo(
							`  Turn ${LABEL[ch]} off and delete its account settings and users' addresses?`,
							false
						))
					)
						return;
					// First, while the bot can still sign in: users' addresses go, and
					// the Matrix bot leaves their rooms.
					const purged = await withSpinner(`Deleting users' ${LABEL[ch]} addresses…`, () =>
						admin(['purge-channel', ch], {})
					);
					if (!purged.ok) {
						print(
							yellow(
								`  ✗ Could not delete them: ${plainWhy(purged, { channel: ch })}. Nothing was changed.`
							)
						);
						return;
					}
					print(green(`  ✓ ${count(purged.removed)} users' ${LABEL[ch]} addresses deleted.`));
					if (ch === 'matrix') {
						const left = count(purged.left);
						const waiting = count(purged.waiting);
						print(dim(`    The bot left ${plural(left, 'chat', 'chats')}.`));
						if (waiting > 0) {
							// Its settings are what lets the relay leave them later.
							print(`  The bot could not leave ${plural(waiting, 'chat', 'chats')} yet.`);
							print(
								dim(
									'    Matrix stays set up, so the relay keeps trying to leave them. Run “Turn an app off”'
								)
							);
							print(dim('    for Matrix again later to finish turning it off.'));
							return;
						}
					}
					await save(withoutChannel(readEnv(), ch), null, [ch]);
				}
			});
		if (startOverOffered(st.key))
			options.push({
				label: 'Start over (forget every user’s saved address)',
				run: async () => {
					print(
						dim(
							'  Every user’s saved addresses, waiting notes and links are deleted; a new key is made.'
						)
					);
					print(dim('  Users who had notes turned on see them off, and set them up again.'));
					if (!(await askYesNo('  Start over?', false))) return;
					const r = await withSpinner('Deleting…', () => admin(['reset'], {}));
					if (!r.ok) {
						print(yellow(`  ✗ It did not work: ${plainWhy(r)}. Nothing was changed.`));
						return;
					}
					print(green('  ✓ Every saved address and the old key file are deleted.'));
					// The relay makes its new key when it starts.
					if ((await restart('Restarting the relay so it makes a new key…')) === null) return;
					const after = await status();
					if (after.ok && (after.key === 'ok' || after.key === 'none')) {
						print(green('  ✓ The relay is back with a new key.'));
						print(dim('    Users can set their addresses up again in Settings.'));
					} else {
						print(
							yellow(
								`  ⚠ The relay is back, but ${after.ok ? 'it still cannot use a new key' : `it did not say how its key is: ${plainWhy(after)}`}.`
							)
						);
						print(dim('    Check:  journalctl -u morphit-relay -n 50 --no-pager'));
					}
				}
			});
		options.push({ label: 'Done', run: async () => undefined });
		const pick = await askChoice(
			'What would you like to do?',
			options.map((o) => o.label)
		);
		if (pick === options.length - 1) return 0;
		await options[pick]!.run();
		st = await status();
		if (!st.ok) {
			print(yellow(`  ✗ Could not read the relay's settings: ${plainWhy(st)}`));
			return 1;
		}
	}
}
