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
	askYesNo as realAskYesNo,
	isAbortError
} from '../init/prompt.ts';
import { cleanLabel, startDotsSpinner, withSpinner } from '../init/spinner.ts';
import { relayHealthUrl, waitForAnswers } from '../lib/afterRestartHeal.ts';
import { homeserverRoute, matrixAccountCheck, matrixSignIn } from '../lib/matrixBot.ts';
import {
	CHANNEL_KEYS,
	CHANNEL_MAIN_KEY,
	NOTIFY_CHANNELS,
	NOTIFY_ENV_PATH,
	readNotifyEnv,
	relayReadsSame,
	withoutChannel,
	writableValue,
	writeNotifyEnv,
	type NotifyChannel
} from '../lib/offlineNotifyEnv.ts';
import { RELAY_ENV_FILES } from '../lib/relayHiddenHeal.ts';
import { runAsync } from '../lib/spinRun.ts';
import {
	XMPP_PASSWORD_MIN,
	XMPP_SUGGESTED_SERVERS,
	checkXmppPassword,
	checkXmppUsername,
	makeXmppPassword,
	validJid,
	validXmppDomain,
	xmppEndpoint
} from '../lib/xmppAccount.ts';

export interface OfflineNotifyCtx {
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
	/** The Morphit checkout (/opt/morphit). */
	readonly repoRoot: string;
}

/** A question the relay's admin tool asks while it works (a picture check). */
export type AskHandler = (question: AdminAnswer) => Promise<Record<string, string>>;

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
	/** Run the relay's adminCli with these args, settings on stdin. `onAsk`:
	 *  the tool asked a question ({"ask":…}) — its answer goes back on stdin. */
	readonly admin?: (
		args: readonly string[],
		input: Record<string, string>,
		onAsk?: AskHandler
	) => Promise<AdminAnswer>;
	readonly readEnv?: () => Record<string, string>;
	/** Write the file: the `owned` channels' keys exactly as in `values`,
	 *  every other line as it was (lib/offlineNotifyEnv.ts). */
	readonly writeEnv?: (values: Record<string, string>, owned: readonly NotifyChannel[]) => void;
	/** Restart the relay, wait for it, and return the apps it offers (null: no answer). */
	readonly restartRelay?: () => Promise<string[] | null>;
	readonly signInMatrix?: typeof matrixSignIn;
	readonly matrixAccount?: typeof matrixAccountCheck;
	/** DNS SRV lookups (an XMPP domain's server). */
	readonly resolveSrv?: Parameters<typeof xmppEndpoint>[1];
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
	return async (
		args: readonly string[],
		input: Record<string, string>,
		onAsk?: AskHandler
	): Promise<AdminAnswer> => {
		// Asked without blocking: the spinner around this keeps turning.
		const unit = await relayUnitUser();
		const runAs = adminRunAs(unit, unit === '' && (await userExists('morphit-relay')));
		return new Promise((resolve, reject) => {
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
			/** A question still on the operator's screen (its answer pending). */
			let asking: Promise<void> | null = null;
			/** The operator pressed Ctrl+C at a question. */
			let stopped: unknown = undefined;
			const killGroup = (): void => {
				if (child?.pid === undefined) return;
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch {
					/* already gone */
				}
			};
			const settle = (answer: AdminAnswer | null): void => {
				// Ctrl+C reaches the caller as Ctrl+C at any other prompt does.
				if (stopped !== undefined) return reject(stopped);
				if (answer !== null) return resolve(answer);
				const line = out.trim().split('\n').at(-1) ?? '';
				try {
					const j = JSON.parse(line) as AdminAnswer;
					// A question it never got the answer to is not its answer.
					resolve(
						j !== null && typeof j === 'object' && !('ask' in j)
							? j
							: { ok: false, error: 'no_answer' }
					);
				} catch {
					resolve({ ok: false, error: 'no_answer' });
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
				// The tool ended while a question is still open: the caller waits for
				// that answer (thrown away), so no other prompt opens beside it.
				if (asking !== null) void asking.then(() => settle(answer));
				else settle(answer);
			};
			const limit = opts.timeoutMs ?? ADMIN_TIMEOUT_MS;
			const expire = (): void => {
				killGroup();
				finish({ ok: false, error: 'timed_out' });
			};
			let timer = setTimeout(expire, limit);
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
			// A question from the tool: the time limit waits while the operator
			// answers (a picture check takes a browser and some reading).
			let scanned = 0;
			child.stdout?.on('data', (d: Buffer) => {
				out += d.toString('utf8');
				if (onAsk === undefined) return;
				for (let nl = out.indexOf('\n', scanned); nl >= 0; nl = out.indexOf('\n', scanned)) {
					const line = out.slice(scanned, nl);
					scanned = nl + 1;
					let q: AdminAnswer | null = null;
					try {
						const j: unknown = JSON.parse(line);
						if (j !== null && typeof j === 'object' && 'ask' in j) q = j as unknown as AdminAnswer;
					} catch {
						/* not a question */
					}
					if (q === null) continue;
					clearTimeout(timer);
					asking = onAsk(q).then(
						(a) => {
							asking = null;
							if (done) return;
							child.stdin?.write(`${JSON.stringify(a)}\n`);
							timer = setTimeout(expire, limit);
						},
						(err: unknown) => {
							asking = null;
							if (isAbortError(err)) stopped = err;
							killGroup();
							finish({ ok: false, error: 'cancelled' });
						}
					);
				}
			});
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
			// With questions to answer, stdin stays open for the answers (it closes
			// when the tool exits); otherwise the settings are all it reads.
			if (onAsk === undefined) child.stdin?.end(JSON.stringify(input));
			else child.stdin?.write(`${JSON.stringify(input)}\n`);
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
	const signIn = deps.signInMatrix ?? matrixSignIn;
	const accountCheck = deps.matrixAccount ?? matrixAccountCheck;

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
	): Promise<boolean> => {
		try {
			writeEnv(values, owned);
		} catch (err) {
			print(yellow(`  ✗ Not saved: ${clean((err as Error).message)}`));
			return false;
		}
		print(green(`  ✓ Saved to ${NOTIFY_ENV_PATH}.`));
		const offered = await restart('Restarting the relay so it uses the new settings…');
		if (offered === null) return true;
		if (channel === null) {
			print(green('  ✓ The relay is back.'));
		} else if (offered.includes(channel)) {
			print(green(`  ✓ ${LABEL[channel]} is on: users can now choose it in Settings.`));
		} else {
			print(yellow(`  ⚠ The relay is back, but it does not offer ${LABEL[channel]}.`));
		}
		return true;
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
	// A Matrix test note comes in a chat the bot leaves once the operator has
	// joined it (relay adminCli send): it can be read only if they join first.
	const matrixTestHint = (bot: unknown): void => {
		const from = typeof bot === 'string' && bot.startsWith('@') ? ` from ${clean(bot)}` : '';
		print(dim(`  In your Matrix app, accept the invitation${from} that brings the test note,`));
		print(dim('  within about a minute and a half: the bot leaves the test chat once you have'));
		print(
			dim('  joined (or then), and after that it can no longer be joined. Users’ chats stay open.')
		);
	};
	const matrixTestOutcome = (r: AdminAnswer): void => {
		if (r.joined === true)
			print(dim('    You joined; the bot has left the test chat, and the note stays with you.'));
		else if (r.joined === false)
			print(
				yellow(
					'    You did not join in time, so the bot has left the test chat and its invitation can no longer be accepted: decline it.'
				)
			);
	};
	const MATRIX_SENDING = 'Sending a test note — accept the invitation in your Matrix app…';

	const testAndSave = async (
		channel: NotifyChannel,
		candidate: Record<string, string>,
		test: { kind: 'send'; to: string } | { kind: 'check' }
	): Promise<boolean> => {
		// Only what will be saved: the channel's old settings are not mixed in.
		const merged = { ...withoutChannel(readEnv(), channel), ...candidate };
		for (const [k, v] of Object.entries(candidate)) {
			if (!writableValue(v)) {
				print(yellow(`  ✗ ${k} cannot contain a line break. Nothing was changed.`));
				return false;
			}
			if (!relayReadsSame(v)) {
				print(
					yellow(
						`  ✗ ${k} cannot start or end with a space, nor be wrapped in quotes (the relay would use it without them). Nothing was changed.`
					)
				);
				return false;
			}
		}
		if (test.kind === 'send' && channel === 'matrix')
			matrixTestHint(candidate.MORPHIT_NOTIFY_MATRIX_USER_ID);
		const label =
			test.kind === 'send'
				? channel === 'session'
					? 'Sending a test note through Tor (this can take a minute)…'
					: channel === 'matrix'
						? MATRIX_SENDING
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
			if (test.kind === 'send' && channel === 'matrix') matrixTestOutcome(r);
			if (channel === 'telegram' && typeof r.username === 'string') {
				merged.MORPHIT_NOTIFY_TELEGRAM_USERNAME = r.username;
				print(dim(`    Notes will come from @${clean(r.username)}.`));
			}
		} else {
			const why = plainWhy(r, test.kind === 'send' ? { channel, to: test.to } : { channel });
			print(yellow(`  ✗ The test did not work: ${why}`));
			if (!(await askYesNo('  Save these settings anyway?', false))) {
				print('  Nothing was changed.');
				return false;
			}
		}
		return save(merged, channel, [channel]);
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
		print(dim('  Notes are sent through an email account, the way a mail app sends mail —'));
		print(dim('  nothing extra runs on this server. Make a new mailbox just for this site'));
		print(dim('  (not your personal one) at a mail provider that lets programs send mail'));
		print(dim('  (“SMTP”). Its help pages give the four things asked next:'));
		print(dim('    • its outgoing mail server (e.g. smtp.example.com)'));
		print(dim('    • the port: 587 (STARTTLS) or 465 (TLS)'));
		print(dim('    • the login: usually the mailbox’s own address'));
		print(dim('    • the password: often an “app password” made in the mailbox’s settings'));
		print(dim('  Notes go out from the mailbox’s own address, not one at your site’s domain'));
		print(dim('  (docs/RUN-A-MORPHIT-NODE.md §13). If the provider keeps a copy of sent mail,'));
		print(dim('  turn that off for this mailbox: the copies would list your users’ addresses.'));
		const host = await askNonEmpty('Outgoing mail server (e.g. smtp.example.com)');
		if (host === null) return;
		const sec = await askChoice('How does it want the connection secured?', [
			'STARTTLS on port 587 (the usual)',
			'Direct TLS on port 465'
		]);
		const port = await ask('Port', sec === 0 ? '587' : '465');
		const user = await askNonEmpty('Login (usually the mailbox’s address)');
		if (user === null) return;
		const password = await askPassword('Password');
		if (password === '') {
			print('  No password — nothing was changed.');
			return;
		}
		const from = await askNonEmpty(
			'The address notes come from (the mailbox’s own address)',
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
		print(dim('  The account must exist already: this signs in to it, it does not create it.'));
		print(dim('  To make one on matrix.org: open https://app.element.io → Create account. It'));
		print(dim('  asks for an email address and emails a code to type in, and wants a password'));
		print(dim('  of at least 10 characters. Do not use “Continue with Google/Apple/GitHub”:'));
		print(dim('  that account has no password to type here.'));
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
		let savedHomeserver = homeserver;
		if (method === 0) {
			const user = ((await askNonEmpty('Username (just the name, no @ or :server)')) ?? '')
				.replace(/^@/, '')
				.replace(/:.*$/, '');
			if (user === '') return;
			const password = await askPassword('Password');
			// Only a clearnet homeserver may be swapped for the address its
			// /.well-known names (that one is always https://, and clearnet).
			const r = await withSpinner('Signing in…', () =>
				signIn(homeserver, user, password, { discover: route === 'clearnet' })
			);
			if (!r.ok) {
				// A refused sign-in for a name the homeserver calls free: the account
				// was never made (the usual reason). Asked only after a refusal, so a
				// homeserver that answers this question wrongly never blocks a setup.
				const known =
					r.why === 'wrong_password'
						? await withSpinner('Looking for that account…', () => accountCheck(r.homeserver, user))
						: 'unknown';
				if (known === 'missing') {
					print(
						yellow(`  ✗ There is no account called “${clean(user)}” on ${clean(r.homeserver)} yet.`)
					);
					print(yellow('    Make it first (see above), then choose Set up Matrix again.'));
					print('    Nothing was changed.');
					return;
				}
				const where = clean(r.homeserver);
				const said = clean(r.detail);
				const why: Record<typeof r.why, string[]> = {
					wrong_password: [
						`  ✗ ${where} says the username or password is wrong (${said}).`,
						'    An account made with “Continue with Google/Apple/GitHub” has no password:',
						'    set one in its account settings first (matrix.org: https://account.matrix.org).'
					],
					rate_limited: [
						`  ✗ Too many sign-in attempts: ${where} asks to wait (${said}). Try again later.`
					],
					no_password_login: [
						`  ✗ ${where} does not allow signing in with a password (${said}).`,
						'    Choose “Paste an access token” instead.'
					],
					not_homeserver: [
						`  ✗ ${where} does not answer as a Matrix homeserver (${said}). Check the address.`
					],
					unreachable: [`  ✗ Could not reach ${where} from this server (${said}).`],
					other: [`  ✗ Sign-in failed at ${where}: ${said}.`]
				};
				for (const line of why[r.why]) print(yellow(line));
				print('    Nothing was changed.');
				return;
			}
			token = r.token;
			savedHomeserver = r.homeserver;
		} else {
			token = await askPassword('Access token');
			if (token.trim() === '') {
				print('  No token — nothing was changed.');
				return;
			}
		}
		const candidate = {
			MORPHIT_NOTIFY_MATRIX_HOMESERVER: savedHomeserver,
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

	// ─── XMPP ───────────────────────────────────────────────────────────────
	const XMPP_FORM_SAYS: Record<string, string> = {
		open: 'takes new accounts',
		captcha: 'takes new accounts after a picture check (you open a web page)',
		captcha_no_page: 'wants a picture check that only an XMPP app can show',
		web: 'makes new accounts only on its website',
		needs_more: 'asks for more than a name and a password',
		closed: 'takes no new accounts this way'
	};
	type XmppPick = {
		readonly domain: string;
		readonly host: string;
		readonly port: number;
		readonly security: 'starttls' | 'tls';
	};
	const xmppInput = (pick: XmppPick, user: string, password: string): Record<string, string> =>
		adminInput(
			{
				MORPHIT_NOTIFY_XMPP_JID: `${user}@${pick.domain}`,
				MORPHIT_NOTIFY_XMPP_PASSWORD: password,
				MORPHIT_NOTIFY_XMPP_HOST: pick.host,
				MORPHIT_NOTIFY_XMPP_PORT: String(pick.port),
				MORPHIT_NOTIFY_XMPP_SECURITY: pick.security
			},
			'xmpp'
		);
	/** Where the domain's server is: its DNS records, or the domain itself (an
	 *  .onion address: no DNS, and none on a zero-clearnet box). */
	const xmppWhere = async (domain: string): Promise<XmppPick> => {
		const e =
			st.hiddenOnly === true || domain.endsWith('.onion')
				? { host: domain, port: 5222, security: 'starttls' as const }
				: await xmppEndpoint(domain, deps.resolveSrv);
		return { domain, host: e.host, port: e.port, security: e.security };
	};
	/** What the server asks of a new account (one word), asked live. */
	const xmppFormOf = async (pick: XmppPick): Promise<AdminAnswer> =>
		admin(['register-form', 'xmpp'], xmppInput(pick, 'new', 'not-the-password'));
	const xmppSays = (f: AdminAnswer): string => {
		if (!f.ok) return `did not answer (${plainWhy(f, { channel: 'xmpp' })})`;
		const key =
			f.status === 'captcha' && typeof f.url !== 'string' ? 'captcha_no_page' : String(f.status);
		return XMPP_FORM_SAYS[key] ?? 'answered something this cannot use';
	};
	const usable = (f: AdminAnswer): boolean =>
		f.ok === true && (f.status === 'open' || (f.status === 'captcha' && typeof f.url === 'string'));

	/** The server to make the account on: the suggested ones (asked live
	 *  whether they take new accounts), or one the operator names. */
	const chooseXmppServer = async (): Promise<XmppPick | null> => {
		const named = async (q: string): Promise<XmppPick | null> => {
			for (;;) {
				const raw = (await ask(q)).trim().toLowerCase();
				if (raw === '') {
					print('  Nothing entered — nothing was changed.');
					return null;
				}
				if (!validXmppDomain(raw) || (st.hiddenOnly === true && !raw.endsWith('.onion'))) {
					print(
						yellow(
							st.hiddenOnly === true
								? '  ✗ This site uses no clearnet: give the server’s .onion address.'
								: '  ✗ That is not a server name: it looks like example.org (no https://, no @).'
						)
					);
					continue;
				}
				const pick = await withSpinner(`Asking ${raw} whether it takes new accounts…`, async () => {
					const p = await xmppWhere(raw);
					return { p, f: await xmppFormOf(p) };
				});
				if (usable(pick.f)) return pick.p;
				print(yellow(`  ✗ ${raw} ${xmppSays(pick.f)}.`));
				if (pick.f.status === 'web' && typeof pick.f.url === 'string')
					print(
						dim(
							`    Its page: ${clean(pick.f.url)} — then choose “Use an account that already exists”.`
						)
					);
				print(dim('    Try another server (Enter to stop).'));
			}
		};
		if (st.hiddenOnly === true) {
			print(dim('  This site uses no clearnet: the server must have an .onion address.'));
			return named('The XMPP server’s .onion address');
		}
		const checked = await withSpinner(
			`Asking ${XMPP_SUGGESTED_SERVERS.join(', ')} whether they take new accounts…`,
			() =>
				Promise.all(
					XMPP_SUGGESTED_SERVERS.map(async (d) => {
						const p = await xmppWhere(d);
						return { p, f: await xmppFormOf(p) };
					})
				)
		);
		for (const c of checked) print(`    ${c.p.domain.padEnd(12)} ${xmppSays(c.f)}`);
		const offer = checked.filter((c) => usable(c.f));
		const options = [
			...offer.map((c, i) => `${c.p.domain}${i === 0 ? ' (recommended)' : ''}`),
			'Another server…',
			'Cancel'
		];
		const i = await askChoice('Make the account on which server?', options);
		if (i < offer.length) return offer[i]!.p;
		if (i === offer.length)
			return named('The server’s name (e.g. example.org — see providers.xmpp.net)');
		return null;
	};

	const askNewXmppPassword = async (
		user: string
	): Promise<{ pw: string; made: boolean } | null> => {
		for (;;) {
			const pw = await askPassword(
				`Password (at least ${XMPP_PASSWORD_MIN} characters; Enter: make a strong one for you)`
			);
			if (pw === '') return { pw: makeXmppPassword(user), made: true };
			const why = checkXmppPassword(pw, user);
			if (why !== null) {
				print(yellow(`  ✗ ${why}`));
				continue;
			}
			if ((await askPassword('The same password again')) !== pw) {
				print(yellow('  ✗ The two did not match. Once more.'));
				continue;
			}
			return { pw, made: false };
		}
	};

	const askXmppUsername = async (dflt?: string): Promise<string | null> => {
		for (;;) {
			const raw = (await ask('Username for the account (e.g. morphitio)', dflt)).trim();
			if (raw === '') {
				print('  Nothing entered — nothing was changed.');
				return null;
			}
			const u = checkXmppUsername(raw);
			if (u.ok) return u.value;
			print(yellow(`  ✗ ${u.why}`));
		}
	};

	/** Archive off, test note, save — for a new account and an existing one.
	 *  `made`: the account was made just now (its password made for you or not). */
	const finishXmpp = async (
		candidate: Record<string, string>,
		made: { readonly password: 'made' | 'typed' } | null = null
	): Promise<void> => {
		const jid = clean(candidate.MORPHIT_NOTIFY_XMPP_JID);
		/** A new account the operator chose not to save: it stays on its server. */
		const leftOnServer = (): void => {
			if (made === null) return;
			print(
				yellow(
					`  ⚠ The account ${jid} was made and stays on its server, but it is not saved here.`
				)
			);
			print(
				dim(
					made.password === 'made'
						? '    Its password was made for you and is kept nowhere, so the account cannot be used: make another one (with a new name — this one is taken now).'
						: '    To use it later, choose “Use an account that already exists” and type its address and password.'
				)
			);
		};
		const arch = await withSpinner('Turning its message archive off…', () =>
			admin(['archive-off', 'xmpp'], candidate)
		);
		if (arch.ok && arch.archive === 'off')
			print(green('  ✓ Its server keeps no copies of the notes it sends (message archive off).'));
		else if (arch.ok)
			print(dim('  Its server has no message-archive setting to turn off (it may keep none).'));
		else
			print(
				yellow(`  ✗ Could not turn its message archive off: ${plainWhy(arch, { channel: 'xmpp' })}`)
			);
		// Ctrl+C at one of the prompts below comes before anything is saved: a new
		// account still stays on its server, and the operator is told so.
		try {
			let to = '';
			for (;;) {
				to = (
					await ask(
						'Send a test note to which XMPP address? (yours, e.g. you@example.org; not saved)'
					)
				).trim();
				if (to === '') {
					// A new account exists now: save it untested rather than lose it.
					if (made !== null && (await askYesNo(`  Save ${jid} without a test note?`, true))) {
						if (!(await testAndSave('xmpp', candidate, { kind: 'check' }))) leftOnServer();
						return;
					}
					print('  Nothing entered — nothing was changed here.');
					leftOnServer();
					return;
				}
				if (validJid(to)) break;
				print(yellow('  ✗ That is not an XMPP address: it looks like you@example.org.'));
			}
			if (!(await testAndSave('xmpp', candidate, { kind: 'send', to }))) leftOnServer();
		} catch (err) {
			if (isAbortError(err)) leftOnServer();
			throw err;
		}
	};

	const setupNewXmpp = async (): Promise<void> => {
		const pick = await chooseXmppServer();
		if (pick === null) return;
		let user = await askXmppUsername();
		if (user === null) return;
		let pass = await askNewXmppPassword(user);
		if (pass === null) return;
		for (let attempt = 0; attempt < 6; attempt++) {
			const input = xmppInput(pick, user, pass.pw);
			let stopSpin = startDotsSpinner(`Making ${user}@${pick.domain}…`);
			let r: AdminAnswer;
			try {
				r = await admin(['register', 'xmpp'], input, async (q) => {
					stopSpin();
					print(
						dim(
							`  ${pick.domain} wants a picture check — it waits only about half a minute. Open this page in your browser:`
						)
					);
					print(`    ${clean(q.url)}`);
					const answer = (await ask('The letters or numbers you see there')).trim();
					stopSpin = startDotsSpinner(`Making ${user}@${pick.domain}…`);
					return { answer };
				});
			} finally {
				stopSpin();
			}
			if (r.ok) {
				print(green(`  ✓ Account ${clean(user)}@${clean(pick.domain)} made.`));
				if (pass.made)
					print(
						dim(
							`    Its password was made for you and is kept with the site’s settings (${NOTIFY_ENV_PATH}, root only).`
						)
					);
				await finishXmpp(input, { password: pass.made ? 'made' : 'typed' });
				return;
			}
			const said = typeof r.text === 'string' && r.text !== '' ? ` (“${clean(r.text)}”)` : '';
			if (r.error === 'refused' && r.why === 'taken') {
				print(yellow(`  ✗ The name “${clean(user)}” is taken on ${pick.domain}. Pick another.`));
				user = await askXmppUsername();
				if (user === null) return;
				// The password must not contain the new name either.
				const why = checkXmppPassword(pass.pw, user);
				if (why !== null) {
					if (pass.made) pass = { pw: makeXmppPassword(user), made: true };
					else {
						print(yellow(`  ✗ ${why}`));
						pass = await askNewXmppPassword(user);
						if (pass === null) return;
					}
				}
				continue;
			}
			if (r.error === 'refused' && r.why === 'not_acceptable') {
				print(yellow(`  ✗ ${pick.domain} did not accept that name or password${said}.`));
				user = await askXmppUsername(user);
				if (user === null) return;
				pass = await askNewXmppPassword(user);
				if (pass === null) return;
				continue;
			}
			if (r.error === 'refused' && r.why === 'captcha_expired') {
				print(
					yellow(
						`  ✗ ${pick.domain} stopped waiting for the picture answer. A new picture comes with the next try — answer it within half a minute.`
					)
				);
				continue;
			}
			if (r.error === 'refused' && r.why === 'captcha_wrong') {
				print(
					yellow('  ✗ The picture answer was not right. A new picture comes with the next try.')
				);
				continue;
			}
			if (r.error === 'refused' && r.why === 'rate_limited') {
				print(
					yellow(
						`  ✗ ${pick.domain} has had too many new accounts from this server lately${said}. Try again later, or another server.`
					)
				);
				return;
			}
			if (r.error === 'refused' && r.why === 'not_allowed') {
				print(yellow(`  ✗ ${pick.domain} takes no new account now${said}. Try another server.`));
				return;
			}
			if (r.error === 'form') {
				print(
					yellow(`  ✗ ${pick.domain} ${xmppSays({ ok: true, status: r.status, url: r.url })}.`)
				);
				if (r.status === 'captcha' && typeof r.url === 'string')
					print(dim('    Nothing was answered, so nothing was made.'));
				return;
			}
			print(
				yellow(
					`  ✗ The account was not made: ${r.error === 'refused' ? `the server refused it${said}` : plainWhy(r, { channel: 'xmpp' })}`
				)
			);
			return;
		}
		print(yellow('  ✗ Too many tries — nothing was made. Run this again when you are ready.'));
	};

	const setupExistingXmpp = async (): Promise<void> => {
		let jid = '';
		for (;;) {
			jid = (await ask('Its address (e.g. morphitio@og.im)')).trim().toLowerCase();
			if (jid === '') {
				print('  Nothing entered — nothing was changed.');
				return;
			}
			if (validJid(jid) && (st.hiddenOnly !== true || jid.endsWith('.onion'))) break;
			print(
				yellow(
					st.hiddenOnly === true
						? '  ✗ This site uses no clearnet: the account must be on an .onion server.'
						: '  ✗ That is not an XMPP address: it looks like name@example.org.'
				)
			);
		}
		const password = await askPassword('Its password');
		if (password === '') {
			print('  No password — nothing was changed.');
			return;
		}
		if (!relayReadsSame(password)) {
			print(
				yellow(
					'  ✗ The relay cannot use a password that starts or ends with a space, or is wrapped in quotes. Nothing was changed.'
				)
			);
			return;
		}
		const where = await withSpinner('Looking up its server…', () =>
			xmppWhere(jid.slice(jid.indexOf('@') + 1))
		);
		print(
			dim(
				`  Its server: ${clean(where.host)}, port ${where.port}, ${where.security === 'tls' ? 'TLS' : 'STARTTLS'}.`
			)
		);
		let pick: XmppPick = where;
		if (!(await askYesNo('  Use that?', true))) {
			const host = (await ask('Server to connect to', where.host)).trim().toLowerCase();
			if (!validXmppDomain(host)) {
				print(yellow('  ✗ That is not a server name. Nothing was changed.'));
				return;
			}
			if (st.hiddenOnly === true && !host.endsWith('.onion')) {
				print(
					yellow(
						'  ✗ This site uses no clearnet: the server must be an .onion address. Nothing was changed.'
					)
				);
				return;
			}
			const sec = await askChoice('How does it want the connection secured?', [
				'STARTTLS (usually port 5222)',
				'TLS from the start (usually port 5223)'
			]);
			const portRaw = (await ask('Port', sec === 0 ? '5222' : '5223')).trim();
			const port = Number(portRaw);
			if (!/^\d{1,5}$/.test(portRaw) || port < 1 || port > 65535) {
				print(yellow('  ✗ A port is a number from 1 to 65535. Nothing was changed.'));
				return;
			}
			pick = { domain: where.domain, host, port, security: sec === 0 ? 'starttls' : 'tls' };
		}
		await finishXmpp(xmppInput(pick, jid.slice(0, jid.indexOf('@')), password));
	};

	const setupXmpp = async (): Promise<void> => {
		print(dim('  An XMPP (Jabber) account just for this site’s notes — no email address needed.'));
		print(dim('  Nothing extra runs on this server: notes go out through that account.'));
		const how = await askChoice('Which account?', [
			'Make a new one for this site on a free public XMPP server (recommended)',
			'Use an account that already exists'
		]);
		if (how === 0) await setupNewXmpp();
		else await setupExistingXmpp();
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
					if (ch === 'matrix') matrixTestHint(st.matrix);
					const r = await withSpinner(
						ch === 'matrix' ? MATRIX_SENDING : 'Sending a test note…',
						() => admin(['send', ch], { to })
					);
					print(
						r.ok
							? green(`  ✓ Sent to ${clean(to)} — have a look.`)
							: yellow(`  ✗ It did not work: ${plainWhy(r, { channel: ch, to })}`)
					);
					if (r.ok && ch === 'matrix') matrixTestOutcome(r);
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
