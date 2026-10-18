/**
 * Offline notices — the operator's setup checks, run by `sudo morphit-ops
 * offline-notify` as the relay's own user with the relay's env files (the
 * same code, settings and network rules the relay uses; nothing else to keep
 * in step).
 *
 *   tsx src/notify/adminCli.ts status
 *   tsx src/notify/adminCli.ts check <channel>        (Telegram: getMe; Matrix: whoami)
 *   tsx src/notify/adminCli.ts send <channel>         (a test note; the address on stdin as "to")
 *   tsx src/notify/adminCli.ts new-session            (a new Session identity)
 *   tsx src/notify/adminCli.ts purge-channel <channel> (the operator turned it off:
 *                                                     every user's address for it goes;
 *                                                     the Matrix bot leaves their rooms)
 *   tsx src/notify/adminCli.ts reset                  (start over: forget every address,
 *                                                     and which key sealed them)
 *   tsx src/notify/adminCli.ts register-form xmpp     (what a server asks of a new account)
 *   tsx src/notify/adminCli.ts register xmpp          (make the account: XEP-0077; a picture
 *                                                     check is asked on stdout as
 *                                                     {"ask":"captcha",…} and answered on
 *                                                     the next stdin line {"answer":"…"})
 *   tsx src/notify/adminCli.ts archive-off xmpp       (the account's server keeps no copies)
 *
 * Settings being tried out, not saved yet, come in on stdin as one JSON
 * object of MORPHIT_NOTIFY_* values (and "to", the test address) — never on
 * the command line, where every user on the box could read a password or an
 * address in the process list. The answer is one JSON line on stdout:
 * {"ok":true,…} or {"ok":false,"error":"…"}. It never contains a password or
 * a token; `new-session` returns the new recovery words to morphit-ops, which
 * writes them to the root-only file.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from '../config/index.ts';
import { createDatabase } from '../db/pool.ts';
import { normalizeAddress, type AddressChannel, type Channel } from './addresses.ts';
import { notifyConfigFromEnv, offeredChannels, type NotifyConfig } from './config.ts';
import { dispatch } from './dispatch.ts';
import {
	leaveRoom,
	leaveTestRoom,
	MatrixRoomLeftOpen,
	testNoteBudgetMs,
	whoAmI
} from './channels/matrix.ts';
import { drainLeavesWithin } from './leaves.ts';
import { newSessionIdentity } from './channels/session.ts';
import { telegramBotName } from './channels/telegram.ts';
import { registerXmpp, xmppArchiveOff, xmppRegistrationForm } from './channels/xmpp.ts';
import type { NetPolicy } from './net.ts';
import { openSealedStore, resetOfflineNotify } from './store.ts';
import { VAULT_KEY_FILE, VaultUnavailableError } from './vault.ts';

const CHANNELS: readonly Channel[] = ['matrix', 'session', 'xmpp', 'telegram', 'email'];
/** purge-channel stops starting to leave rooms after this (morphit-ops stops
 *  waiting for this tool after 180 s; one leave may take about 30 s). */
export const LEAVE_BUDGET_MS = 100_000;
/** When this tool started: `send matrix` is done by then + testNoteBudgetMs(). */
const STARTED = Date.now();

function out(o: Record<string, unknown>): never {
	process.stdout.write(`${JSON.stringify(o)}\n`);
	process.exit(o.ok === true ? 0 : 1);
}

// stdin, one line at a time: the settings (one JSON object, with or without a
// line break after it), then — for `register` only — the answer to a question
// this tool asked on stdout.
const stdinLines: string[] = [];
let stdinPending = '';
let stdinEnded = false;
let stdinWake: (() => void) | null = null;
function listenStdin(): void {
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (c: string) => {
		stdinPending += c;
		for (let i = stdinPending.indexOf('\n'); i >= 0; i = stdinPending.indexOf('\n')) {
			stdinLines.push(stdinPending.slice(0, i));
			stdinPending = stdinPending.slice(i + 1);
		}
		stdinWake?.();
	});
	process.stdin.on('end', () => {
		if (stdinPending.trim() !== '') stdinLines.push(stdinPending);
		stdinPending = '';
		stdinEnded = true;
		stdinWake?.();
	});
}
async function nextLine(): Promise<string | null> {
	for (;;) {
		const l = stdinLines.shift();
		if (l !== undefined) return l;
		if (stdinEnded) return null;
		await new Promise<void>((r) => {
			stdinWake = () => {
				stdinWake = null;
				r();
			};
		});
	}
}

/** MORPHIT_NOTIFY_* string values, and "to", from stdin. */
async function input(): Promise<{ env: Record<string, string>; to: string }> {
	if (process.stdin.isTTY) return { env: {}, to: '' };
	listenStdin();
	const raw = ((await nextLine()) ?? '').trim();
	if (raw === '') return { env: {}, to: '' };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return out({ ok: false, error: 'bad_input' });
	}
	const env: Record<string, string> = {};
	let to = '';
	if (parsed && typeof parsed === 'object') {
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v !== 'string') continue;
			if (/^MORPHIT_NOTIFY_[A-Z_]+$/.test(k)) env[k] = v;
			else if (k === 'to') to = v;
		}
	}
	return { env, to };
}

/** Errors whose message this code wrote itself (a stage, a status, a code)
 *  or Node wrote about the connection to the OPERATOR's server. Anything else
 *  — a Session library message, a JSON parse error quoting a server's body —
 *  can carry a server's free text, which might repeat the test address: only
 *  its name is shown. */
const OWN_MESSAGES = new Set([
	'NetRefusedError',
	'SmtpError',
	'MatrixError',
	'XmppError',
	'TelegramError',
	'TimeoutError',
	'VaultUnavailableError'
]);

/** A short reason, never a secret and never a server's free text. */
function reason(err: unknown): string {
	if (!(err instanceof Error)) return 'Error';
	const code = (err as unknown as { code?: unknown }).code;
	const own =
		OWN_MESSAGES.has(err.name) || (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(code));
	return (own ? `${err.name}: ${err.message}` : err.name).slice(0, 200);
}

function relayConfig(): Config {
	try {
		return loadConfig();
	} catch (err) {
		// Without the relay's own settings we cannot tell whether clearnet is
		// allowed here — so nothing is tried. The relay's own message says which
		// setting is wrong and why (a path at most, never a secret).
		const own = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		return out({ ok: false, error: 'relay_config', reason: own.slice(0, 300) });
	}
}

/** Whether the saved addresses can be opened, as a code morphit-ops acts on:
 *  'ok', 'none' (nothing saved, no key yet), 'missing' or 'mismatch' (the key
 *  file is gone, or is another key: only then may the operator start over),
 *  'unreadable' (this process may not read it — not a lost key), 'db_error',
 *  'no_state_dir'. `detail` is the relay's own sentence (a path at most). */
async function keyState(rc: Config): Promise<{ key: string; detail?: string }> {
	const db = createDatabase(rc);
	try {
		let r;
		try {
			r = await db.query<{ key: boolean; rows: boolean }>(
				`SELECT EXISTS (SELECT 1 FROM offline_notify_key) AS key,
				        EXISTS (SELECT 1 FROM offline_notify_channels) AS rows`
			);
		} catch (err) {
			return { key: 'db_error', detail: reason(err) };
		}
		if (r.rows[0]?.key !== true && r.rows[0]?.rows !== true) return { key: 'none' };
		if (rc.dataDir === null) return { key: 'no_state_dir' };
		try {
			await openSealedStore(db, rc.dataDir);
			return { key: 'ok' };
		} catch (err) {
			if (err instanceof VaultUnavailableError)
				return {
					key: err.kind === 'unwritable' ? 'unreadable' : err.kind,
					detail: err.message
				};
			return { key: 'db_error', detail: reason(err) };
		}
	} finally {
		await db.close().catch(() => undefined);
	}
}

async function main(): Promise<void> {
	const [cmd, a1] = process.argv.slice(2);
	if (cmd === 'new-session') {
		const id = await newSessionIdentity();
		out({ ok: true, mnemonic: id.mnemonic, sessionId: id.sessionId });
	}
	const { env: extra, to } = await input();
	const rc = relayConfig();
	const net: NetPolicy = { torSocks: rc.hiddenServiceProxies.torSocks, hiddenOnly: rc.hiddenOnly };
	const env: Record<string, string | undefined> = { ...process.env, ...extra };
	// Telegram's check is how its username is learned: before it, only the
	// token is known, so the settings would read as incomplete without one.
	if (cmd === 'check' && a1 === 'telegram' && (env.MORPHIT_NOTIFY_TELEGRAM_USERNAME ?? '') === '')
		env.MORPHIT_NOTIFY_TELEGRAM_USERNAME = 'not_known_yet';
	const cfg: NotifyConfig = await notifyConfigFromEnv(env, net);
	const site = {
		site: cfg.siteName,
		link: cfg.linkOrigin,
		hiddenOnly: net.hiddenOnly,
		tor: net.torSocks !== ''
	};

	if (cmd === 'status') {
		out({
			ok: true,
			...site,
			offered: offeredChannels(cfg),
			off: cfg.off,
			...(await keyState(rc).then((k) => ({ key: k.key, keyDetail: k.detail }))),
			sessionId: cfg.session?.sessionId ?? null,
			telegram: cfg.telegram?.username ?? null,
			matrix: cfg.matrix?.userId ?? null,
			xmpp: cfg.xmpp?.jid ?? null,
			email: cfg.email?.from ?? null
		});
	}

	if (cmd === 'reset') {
		const db = createDatabase(rc);
		try {
			await resetOfflineNotify(db);
			// …and the key file, so the next start really makes a new key.
			if (rc.dataDir !== null) rmSync(join(rc.dataDir, VAULT_KEY_FILE), { force: true });
			out({ ok: true });
		} catch (err) {
			out({ ok: false, error: 'failed', reason: reason(err) });
		} finally {
			await db.close().catch(() => undefined);
		}
	}

	const channel = CHANNELS.find((c) => c === a1);
	if (!channel) out({ ok: false, error: 'usage' });

	if (cmd === 'purge-channel') {
		if (rc.dataDir === null) out({ ok: false, error: 'failed', reason: 'no state directory' });
		const db = createDatabase(rc);
		try {
			const { store } = await openSealedStore(db, rc.dataDir);
			const { removed } = await store.purgeChannel(channel);
			// Matrix: the bot leaves every room now, while it can still sign in
			// (after this the settings are gone). What does not answer now stays
			// queued, and is left if Matrix is ever set up again.
			// One room at a time, and none started after LEAVE_BUDGET_MS: the
			// answer must reach morphit-ops before it gives up on this tool
			// (the rows are deleted already; a late answer would read as
			// "nothing was changed").
			const left =
				channel === 'matrix' && cfg.matrix !== null
					? (await drainLeavesWithin(store, cfg.matrix, net, LEAVE_BUDGET_MS)).left
					: 0;
			// Rooms the bot could not leave yet: they stay queued (morphit-ops keeps
			// Matrix set up so the relay goes on trying).
			const waiting =
				channel === 'matrix'
					? Number(
							(
								await db.query<{ n: string }>(
									`SELECT count(*)::text AS n FROM offline_notify_leave`
								)
							).rows[0]?.n ?? 0
						)
					: 0;
			out({ ok: true, removed, left, waiting });
		} catch (err) {
			out({ ok: false, error: 'failed', reason: reason(err) });
		} finally {
			await db.close().catch(() => undefined);
		}
	}

	if (cfg.linkOrigin === null) out({ ok: false, error: 'no_link', ...site });
	const off = cfg.off[channel];
	if (off) out({ ok: false, error: off, ...site });
	if (cfg[channel] === null) out({ ok: false, error: 'not_set', ...site });

	if (
		channel === 'xmpp' &&
		(cmd === 'register-form' || cmd === 'register' || cmd === 'archive-off')
	) {
		const x = cfg.xmpp!;
		const at = x.jid.indexOf('@');
		const server = {
			domain: x.jid.slice(at + 1),
			host: x.host,
			port: x.port,
			security: x.security
		};
		try {
			if (cmd === 'register-form') {
				const f = await xmppRegistrationForm(server, net);
				out({
					ok: true,
					status: f.status,
					...(f.url !== undefined ? { url: f.url } : {}),
					...(f.fields !== undefined ? { fields: f.fields } : {})
				});
			}
			if (cmd === 'archive-off') out({ ok: true, archive: await xmppArchiveOff(x, net) });
			const r = await registerXmpp(server, net, x.jid.slice(0, at), x.password, async (f) => {
				process.stdout.write(`${JSON.stringify({ ask: 'captcha', url: f.url ?? null })}\n`);
				const line = await nextLine();
				try {
					const a = (JSON.parse(line ?? '') as { answer?: unknown }).answer;
					return typeof a === 'string' ? a : null;
				} catch {
					return null;
				}
			});
			if (r.ok) out({ ok: true });
			if ('form' in r)
				out({
					ok: false,
					error: 'form',
					status: r.form.status,
					...(r.form.url !== undefined ? { url: r.form.url } : {}),
					...(r.form.fields !== undefined ? { fields: r.form.fields } : {})
				});
			out({ ok: false, error: 'refused', why: r.why, text: r.text });
		} catch (err) {
			out({ ok: false, error: 'failed', reason: reason(err) });
		}
	}

	if (cmd === 'check') {
		try {
			if (channel === 'telegram')
				out({ ok: true, username: await telegramBotName(cfg.telegram!.token, net) });
			if (channel === 'matrix') out({ ok: true, userId: await whoAmI(cfg.matrix!, net) });
			if (channel === 'session') out({ ok: true, sessionId: cfg.session!.sessionId });
			out({ ok: true });
		} catch (err) {
			out({ ok: false, error: 'failed', reason: reason(err) });
		}
	}

	if (cmd === 'send') {
		if (channel === 'telegram') out({ ok: false, error: 'usage' });
		const address = normalizeAddress(channel as AddressChannel, to);
		if (address === null) out({ ok: false, error: 'invalid_address' });
		const text =
			`This is a test from ${cfg.siteName}. Offline notifications are set up: ` +
			`when someone writes to a user who chose this app, a short note like this one tells them, ` +
			`with a link to ${cfg.linkOrigin}.`;
		try {
			const route = await dispatch(cfg, channel, address, null, {
				subject: `Test from ${cfg.siteName}`,
				text
			});
			// The test's Matrix room is not kept: the bot leaves and forgets it —
			// once the operator has joined it (or after a while), so the note can
			// still be read (an invitation from a room everyone left cannot be accepted).
			if (route !== null && channel === 'matrix' && cfg.matrix !== null) {
				out({
					ok: true,
					joined: await leaveTestRoom(cfg.matrix, net, route, address, {
						deadline: STARTED + testNoteBudgetMs()
					})
				});
			}
			out({ ok: true });
		} catch (err) {
			// A room opened for the test whose message failed: not kept either.
			if (err instanceof MatrixRoomLeftOpen && cfg.matrix !== null)
				await leaveRoom(cfg.matrix, net, err.room).catch(() => undefined);
			out({ ok: false, error: 'failed', reason: reason(err) });
		}
	}
	out({ ok: false, error: 'usage' });
}

main().catch((err) => out({ ok: false, error: 'failed', reason: reason(err) }));
