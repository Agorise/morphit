/**
 * morphit-ops matrix — manage the operator's Matrix alert destination
 * and the morphit-matrix-bot service lifecycle in one place.
 *
 * The matrix-bot sidecar tails journald for the morphit-* services,
 * classifies alerts by tier (CRITICAL/WARN/INFO), and DMs them to the
 * operator's Matrix account. It is installed by default but only RUNS
 * when a valid alert MXID is configured. This command is the operator's
 * switch for that MXID — and, crucially, it auto-starts the bot the
 * moment a valid username is set and auto-stops it when the username is
 * removed, so the operator never has to remember a separate `systemctl`
 * step:
 *
 *   morphit-ops matrix set @you:matrix.org   set / edit the alert MXID
 *   morphit-ops matrix clear                 remove it (stops the bot)
 *   morphit-ops matrix                        show status + offer to flip
 *
 * Single source of truth: /etc/morphit/matrix-bot.env (the bot's
 * EnvironmentFile). The secret access token lives there too, so `set`
 * edits ONLY the MXID line. Validation rejects a `#room:server` alias
 * (routing private alerts to a public room would leak security
 * telemetry — memory's @user vs #room rule). The bot ALSO needs an
 * access token; if the MXID is valid but no token is present yet, the
 * username is saved but the bot stays stopped with an actionable hint,
 * rather than starting and crash-looping on the missing token.
 *
 * Scope mirrors `morphit-ops mcp`: this drives systemd + the env MXID
 * line. Creating the service user, the /var/lib state dir, and laying
 * down the unit file is the installer's job (Ansible role / documented
 * manual steps); if the unit isn't installed, this command says so and
 * points at the installer.
 *
 * Testability: env read, service-state read, MXID write, the systemd
 * sync, and the yes/no prompt are all injectable so the decision logic
 * is unit-testable without a live systemd, a real sudo, or touching /etc.
 */

import {
	askYesNo,
	ask as realAsk,
	askPassword as realAskPassword,
	askChoice as realAskChoice
} from '../init/prompt.ts';
import { isHiddenOnlyNode } from '../lib/hiddenOnly.ts';
import { torSocksFromEnv } from '../lib/torOnlyOsHeal.ts';
import { torSocksUrl } from '../lib/matrixRoute.ts';
import { checkService, type ServiceState } from './health.ts';
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
	MATRIX_BOT_ENV_PATH,
	matrixBotReadiness,
	readMatrixBotEnv,
	readMatrixBotHealthcheckPort,
	syncMatrixBotServiceAtTerminal,
	writeAlertMxid,
	writeMatrixCreds,
	writeConfigMxid,
	mintMatrixToken,
	homeserverRoute,
	KEY_HOMESERVER,
	KEY_TOR_ONLY,
	KEY_SOCKS,
	type MatrixBotEnv,
	type MatrixBotReadiness,
	type MatrixBotSyncResult
} from '../lib/matrixBot.ts';
import { parseMxid } from '@morphit/operator-config';
import { withSpinner } from '../init/spinner.ts';
import { runAsync } from '../lib/spinRun.ts';

export interface MatrixCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** Injectable dependencies — defaulted to the real implementations so
 *  the smoke can drive every branch deterministically. */
export interface MatrixDeps {
	readonly readEnv?: (path?: string) => MatrixBotEnv;
	readonly readState?: (unit: string) => ServiceState;
	readonly writeMxid?: (value: string, path?: string) => boolean;
	readonly sync?: (
		run: boolean,
		restart: boolean
	) => MatrixBotSyncResult | Promise<MatrixBotSyncResult>;
	readonly confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
	readonly selfTest?: (port: number) => Promise<MatrixSelfTestResult>;
	readonly readHealthcheckPort?: (path?: string) => number;
	/** The guided setup flow (injectable so the lifecycle smoke can stub it). */
	readonly configure?: (colorEnabled: boolean, deps: MatrixDeps) => Promise<number>;
	/** Whether this is a tor-only (hidden-only) node; Tor's SocksPort host:port. */
	readonly torOnly?: () => boolean;
	readonly torSocks?: () => string;
	/** Prompts and token minting (tests). */
	readonly ask?: (q: string) => Promise<string>;
	readonly askChoice?: (q: string, options: readonly string[]) => Promise<number>;
	readonly askPassword?: (q: string) => Promise<string>;
	readonly mint?: typeof mintMatrixToken;
	readonly writeCreds?: typeof writeMatrixCreds;
	readonly writeConfig?: typeof writeConfigMxid;
	readonly isTTY?: boolean;
	/** The bot's last journal lines (null: could not be read). */
	readonly journalTail?: () => string | null;
	/** How long a just-started bot is watched before each look at it. */
	readonly settleMs?: number;
	/** How many times systemd has restarted the unit since it was last
	 *  started (`systemctl show -p NRestarts`); null when it cannot be read. */
	readonly readRestarts?: (unit: string) => Promise<number | null>;
}

/** How long a just-(re)started bot is watched: the unit is Type=simple and
 *  Restart=on-failure, so `systemctl restart` returns 0 even for a bot that
 *  exits a moment later on a bad token or an unreachable homeserver. */
export const MATRIX_SETTLE_MS = 5_000;

function defaultJournalTail(): string | null {
	const r = spawnSync(
		'journalctl',
		['-u', 'morphit-matrix-bot', '-n', '15', '--no-pager', '-o', 'cat'],
		{ encoding: 'utf8', timeout: 10_000 }
	);
	return r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim() !== ''
		? r.stdout.trimEnd()
		: null;
}

/** systemd's restart count for the unit, or null. */
async function defaultReadRestarts(unit: string): Promise<number | null> {
	const r = await runAsync('systemctl', ['show', '-p', 'NRestarts', '--value', `${unit}.service`], {
		timeoutMs: 5_000
	});
	const n = r.status === 0 ? Number(r.stdout.trim()) : NaN;
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/** After a start: wait (spinner) and look at the unit TWICE, a settle apart.
 *  True only when it is SEEN running both times and systemd did not restart
 *  it in between (Restart=on-failure brings a crashing bot back, so one look
 *  can catch it between two crashes and call it up — v1.21.18 review);
 *  otherwise what was seen and its last log lines are printed. */
async function botSeenRunning(deps: MatrixDeps, dim: (s: string) => string): Promise<boolean> {
	const readState = deps.readState ?? checkService;
	const readRestarts = deps.readRestarts ?? defaultReadRestarts;
	const settle = deps.settleMs ?? MATRIX_SETTLE_MS;
	const unit = 'morphit-matrix-bot';
	const started = Date.now();
	const seen = await withSpinner('Checking the Matrix alert bot stays up…', async () => {
		const wait = (): Promise<void> => new Promise((r) => setTimeout(r, settle));
		await wait();
		const first = readState(unit);
		if (first !== 'active') return { state: first, restarted: null as number | null };
		const before = await readRestarts(unit);
		await wait();
		const second = readState(unit);
		const after = second === 'active' ? await readRestarts(unit) : null;
		const restarted = before !== null && after !== null && after > before ? after - before : null;
		return { state: second, restarted };
	});
	if (seen.state === 'active' && seen.restarted === null) return true;
	const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
	console.log(
		seen.state === 'active'
			? `  ✗ The Matrix alert bot stopped and was restarted by systemd ${seen.restarted} time${seen.restarted === 1 ? '' : 's'} in the ${secs} s after it was started: it keeps crashing.`
			: `  ✗ The Matrix alert bot is not running ${secs} s after it was started (${describeState(seen.state)}).`
	);
	const tail = (deps.journalTail ?? defaultJournalTail)();
	if (tail === null) {
		console.log(
			'    To see why, on this server: sudo journalctl -u morphit-matrix-bot -n 50 --no-pager'
		);
	} else {
		console.log('    Its last log lines:');
		for (const l of tail.split('\n')) console.log(dim(`      ${l}`));
	}
	return false;
}

/** Where morphit-ops persists operator config (source of truth that survives an
 *  Ansible re-render). Overridable for tests / non-standard installs. */
const OPERATOR_CONFIG_PATH =
	process.env.MORPHIT_CONFIG_ENV_PATH ?? '/opt/morphit/morphit.config.env';
/** The matrix-bot's E2EE crypto store — cleared when we set a fresh token so a
 *  new device never collides with stale one-time keys (the reinstall bug). */
const MATRIX_CRYPTO_STORE = '/var/lib/morphit-matrix-bot/state.db.matrix-storage';

/**
 * The full, hand-editing-free Matrix alert setup: collect the recipient MXID + the
 * bot's credentials, MINT a fresh token (or accept a pasted one), persist BOTH the
 * MXID and token to the live env AND the operator config, clear the stale E2EE
 * store, enable + start the bot, and send a test. Used by option 16, the install
 * wizard, and harden — so entering a Matrix address wires everything automatically
 * ("NO hand editing of any files or string variables").
 */
export async function configureMatrixAlerts(
	colorEnabled: boolean,
	deps: MatrixDeps = {}
): Promise<number> {
	const c = colorEnabled;
	const green = (s: string): string => (c ? `\u001b[32m${s}\u001b[0m` : s);
	const yellow = (s: string): string => (c ? `\u001b[33m${s}\u001b[0m` : s);
	const dim = (s: string): string => (c ? `\u001b[2m${s}\u001b[0m` : s);
	const sync =
		deps.sync ??
		((run: boolean, restart: boolean) => syncMatrixBotServiceAtTerminal(run, { restart }));

	// Never block on stdin in a non-interactive context (a piped/CI invocation, or
	// a smoke driving the status flow) — this whole flow is interactive by nature.
	const ask = deps.ask ?? realAsk;
	const askChoice = deps.askChoice ?? realAskChoice;
	const askPassword = deps.askPassword ?? realAskPassword;
	const torOnly = (deps.torOnly ?? (() => isHiddenOnlyNode()))();
	if (!(deps.isTTY ?? process.stdin.isTTY)) {
		console.log(
			'  Setting up alerts asks questions: run it in a terminal, on this server: sudo morphit-ops matrix setup'
		);
		return 1;
	}

	console.log('');
	console.log('  Matrix operator alerts — the bot DMs you when something needs attention.');
	console.log(dim('  It logs in as its OWN bot account and DMs alerts to YOUR account.'));
	console.log('');

	// 1. Recipient MXID (yours), validated — never a #room.
	let mxid = '';
	for (;;) {
		const raw = (
			await ask('Your personal Matrix address to receive alerts (e.g. @you:matrix.org)')
		).trim();
		if (raw === '') {
			console.log('  Nothing entered — aborted, no changes made.');
			return 1;
		}
		if (raw.startsWith('#') || parseMxid(raw) === null) {
			console.log(
				yellow('  That is not a personal MXID (want @user:server, not a #room). Try again.')
			);
			continue;
		}
		mxid = raw;
		break;
	}

	// 2. Bot homeserver (where the bot account lives — usually the MXID's server).
	//    On a tor-only node: only one on this machine or a .onion one, reached
	//    through Tor (the bot refuses anything else there, and so does this).
	const defHome = torOnly ? '' : `https://${mxid.slice(mxid.indexOf(':') + 1)}`;
	if (torOnly) {
		console.log(
			dim('  This is a tor-only node: the bot can only use a homeserver on this machine')
		);
		console.log(dim('  or a .onion homeserver (reached through Tor). A clearnet homeserver would'));
		console.log(dim('  end this node’s zero-clearnet setup.'));
	}
	const homeserver = (
		(
			await ask(
				torOnly
					? "Bot account's Matrix homeserver (http://….onion or http://127.0.0.1:…)"
					: `Bot account's Matrix homeserver [${defHome}]`
			)
		).trim() || defHome
	).replace(/\/+$/, '');
	const route = homeserverRoute(homeserver);
	if (torOnly && route !== 'loopback' && route !== 'onion') {
		console.log(
			yellow(
				`  ✗ ${homeserver || '(none)'} is not on this machine or a .onion homeserver — aborted, no changes made.`
			)
		);
		return 1;
	}

	// 3. Credentials — mint from username+password (recommended), or paste a token.
	//    Minting logs in from this machine; over Tor that is not possible here,
	//    so a .onion homeserver takes a pasted token.
	const canMint = !torOnly || route === 'loopback';
	const method = canMint
		? await askChoice('How should the bot sign in?', [
				"Enter the bot account's username + password (I'll mint a fresh token — recommended)",
				'Paste an existing access token'
			])
		: 1;
	let token = '';
	if (method === 0) {
		const user = (await ask('Bot account username (just the local part, no @ or :server)')).trim();
		const password = await askPassword('Bot account password');
		if (user === '' || password === '') {
			console.log('  Username/password empty — aborted, no changes made.');
			return 1;
		}
		// A login over Tor can take a while: the spinner is on the line for it.
		const minted = await withSpinner(
			'Minting a fresh access token (a new device — avoids E2EE key collisions)…',
			() => (deps.mint ?? mintMatrixToken)(homeserver, user, password)
		);
		if (minted === null) {
			console.log(
				yellow('  ✗ Login failed. Check the username, password, and homeserver, then retry.')
			);
			console.log(dim('    (Nothing was changed.)'));
			return 1;
		}
		token = minted;
		console.log(green('  ✓ Fresh token minted.'));
	} else {
		token = (await ask('Paste the bot access token')).trim();
		if (token === '') {
			console.log('  No token entered — aborted, no changes made.');
			return 1;
		}
	}

	// 4. Persist. The SECRET token goes ONLY to the 0600 matrix-bot.env; the config
	//    gets the non-secret MXID (mode preserved) so it survives an Ansible
	//    re-render without ever exposing the token in the group-readable config.
	const extra: Record<string, string> = { [KEY_HOMESERVER]: homeserver };
	if (torOnly) {
		extra[KEY_TOR_ONLY] = '1';
		extra[KEY_SOCKS] = torSocksUrl((deps.torSocks ?? (() => torSocksFromEnv()))());
	}
	const liveOk = (deps.writeCreds ?? writeMatrixCreds)(mxid, token, MATRIX_BOT_ENV_PATH, extra);
	const cfgOk = (deps.writeConfig ?? writeConfigMxid)(mxid, OPERATOR_CONFIG_PATH);
	if (!liveOk) {
		console.log(yellow(`  ✗ Could not write ${MATRIX_BOT_ENV_PATH}. Are you running with sudo?`));
		return 1;
	}
	if (!cfgOk) {
		console.log(
			yellow(`  ⚠ Wrote the live env but not the operator config — alerts work now, but the`)
		);
		console.log(
			yellow('    recipient may not persist across a re-install/harden. Re-run with sudo.')
		);
	} else {
		console.log(green('  ✓ Saved (token 0600 in the bot env; recipient in the operator config).'));
	}

	// 5. Clear the stale E2EE store so the fresh token starts clean.
	try {
		rmSync(MATRIX_CRYPTO_STORE, { recursive: true, force: true });
	} catch {
		/* best effort */
	}

	// 6. Enable + start, then SEE it running (Type=simple: a 0 from systemctl
	//    says nothing about the bot staying up).
	const res = await sync(true, true);
	console.log('');
	if (!res.ok) {
		console.log(yellow('  ✗ Saved, but systemd could not start the bot.'));
		console.log(
			'    To see why, on this server: sudo journalctl -u morphit-matrix-bot -n 30 --no-pager'
		);
		return 1;
	}
	if (!(await botSeenRunning(deps, dim))) {
		console.log('    After fixing it, on this server: sudo systemctl restart morphit-matrix-bot');
		return 1;
	}
	console.log(green('  ✓ Matrix alert bot enabled and running (seen running).'));

	// 7. Test — DM the operator so they SEE it working.
	const port = (deps.readHealthcheckPort ?? readMatrixBotHealthcheckPort)(MATRIX_BOT_ENV_PATH);
	const selfTest = deps.selfTest ?? postSelfTest;
	let why = '';
	try {
		const t = await withSpinner('Sending you a test alert…', () => selfTest(port));
		if (t.ok && t.sent.length > 0) {
			console.log(green(`  ✓ Test alert sent to ${t.sent.join(', ')} — check your Matrix client.`));
			console.log(dim('    The first message arrives as an invite/request — accept it once.'));
			return 0;
		}
		why =
			t.failed?.length > 0
				? t.failed.map((f) => `${f.mxid}: ${f.error}`).join('; ')
				: 'the bot sent it to no one';
	} catch (err) {
		why = `the bot did not answer on 127.0.0.1:${port} (${err instanceof Error ? err.message : String(err)})`;
	}
	console.log(yellow(`  ⚠ The bot is running, but the test alert was not delivered: ${why}.`));
	console.log('    Try again on this server: sudo morphit-ops matrix test');
	return 0;
}

/** Shape returned by the bot's loopback `/self-test` route. */
export interface MatrixSelfTestResult {
	readonly ok: boolean;
	readonly dryRun: boolean;
	readonly recipients: number;
	readonly sent: ReadonlyArray<string>;
	readonly failed: ReadonlyArray<{ readonly mxid: string; readonly error: string }>;
}

/** POST the bot's loopback `/self-test` route and parse its JSON result.
 *  Throws on connection failure / timeout / non-JSON; the caller maps that
 *  to a "couldn't reach the bot" message. Loopback-only by construction. */
async function postSelfTest(port: number): Promise<MatrixSelfTestResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/self-test`, {
			method: 'POST',
			signal: controller.signal
		});
		return (await res.json()) as MatrixSelfTestResult;
	} finally {
		clearTimeout(timer);
	}
}

/** Human-readable one-liner for a service state. */
function describeState(state: ServiceState): string {
	switch (state) {
		case 'active':
			return 'running';
		case 'activating':
			return 'starting';
		case 'inactive':
			return 'stopped';
		case 'failed':
			return 'keeps crashing';
		case 'not-installed':
			return 'not installed on this host';
		case 'unknown':
		default:
			return 'unknown (is systemd present?)';
	}
}

/** A one-line explanation of WHY the bot is not ready to run. */
function describeNotReady(r: Extract<MatrixBotReadiness, { run: false }>): string {
	switch (r.reason) {
		case 'no-env-file':
			return `no ${MATRIX_BOT_ENV_PATH} — the matrix-bot unit/env are not installed on this host yet`;
		case 'no-mxid':
			return 'no alert username set (Matrix alerting is off)';
		case 'mxid-is-room':
			return `the configured value ${JSON.stringify(r.detail ?? '')} is a room alias (#room:server), not an MXID`;
		case 'invalid-mxid':
			return `the configured value ${JSON.stringify(r.detail ?? '')} is not a valid MXID (@user:server)`;
		case 'no-token':
			return 'a username is set but MORPHIT_MATRIX_BOT_ACCESS_TOKEN is missing';
		case 'placeholder-token':
			return 'a username is set but MORPHIT_MATRIX_BOT_ACCESS_TOKEN is still the example placeholder';
		case 'clearnet-on-tor-only':
			return `this is a tor-only node and the homeserver ${JSON.stringify(r.detail ?? '')} is not on this machine or a .onion reached through Tor`;
	}
}

export async function runMatrix(ctx: MatrixCtx, deps: MatrixDeps = {}): Promise<number> {
	const readEnv = deps.readEnv ?? readMatrixBotEnv;
	const readState = deps.readState ?? checkService;
	const writeMxid = deps.writeMxid ?? writeAlertMxid;
	const writeConfig = deps.writeConfig ?? writeConfigMxid;
	const sync =
		deps.sync ??
		((run: boolean, restart: boolean) => syncMatrixBotServiceAtTerminal(run, { restart }));
	const confirm = deps.confirm ?? askYesNo;
	const selfTest = deps.selfTest ?? postSelfTest;
	const readHealthcheckPort = deps.readHealthcheckPort ?? readMatrixBotHealthcheckPort;

	const paint = (open: string, s: string): string =>
		ctx.colorEnabled ? `${open}${s}\u001b[0m` : s;
	const bold = (s: string): string => paint('\u001b[1m', s);
	const dim = (s: string): string => paint('\u001b[2m', s);
	const green = (s: string): string => paint('\u001b[32m', s);
	const yellow = (s: string): string => paint('\u001b[33m', s);

	const action = (ctx.positional[0] ?? 'status').toLowerCase();
	if (
		action !== 'status' &&
		action !== 'set' &&
		action !== 'setup' &&
		action !== 'clear' &&
		action !== 'test'
	) {
		console.log(yellow(`  Unknown action: ${action}`));
		console.log('  Usage, on this server:');
		console.log(
			'    sudo morphit-ops matrix setup                 guided setup — mints the token for you'
		);
		console.log('    sudo morphit-ops matrix set @you:matrix.org   set / change the alert address');
		console.log('    sudo morphit-ops matrix clear                 remove it (stops the bot)');
		console.log('    sudo morphit-ops matrix test                  send yourself a test alert');
		console.log('    sudo morphit-ops matrix                       show status and choices');
		return 1;
	}

	/** Also keep the address in the operator config, so an Ansible re-run
	 *  (which renders matrix-bot.env from it) does not bring the old one back. */
	const persistToConfig = (value: string): void => {
		if (!existsSync(OPERATOR_CONFIG_PATH)) return;
		if (!writeConfig(value, OPERATOR_CONFIG_PATH)) {
			console.log(
				yellow(
					`  ⚠ Saved for the bot, but not in ${OPERATOR_CONFIG_PATH} — a re-install may bring the old address back.`
				)
			);
			console.log('    Run this again with sudo, on this server.');
		}
	};

	// ─── test ────────────────────────────────────────────────────────
	// Ask the RUNNING bot (via its loopback healthcheck server) to DM a
	// labelled self-test alert to the configured recipients. We trigger the
	// bot's OWN client instead of opening a second Matrix client here: a
	// second client sharing the bot's access token would fight over the
	// device's immutable E2E identity (see apps/matrix-bot/src/health.ts).
	const runTest = async (): Promise<number> => {
		const env = readEnv(MATRIX_BOT_ENV_PATH);
		const readiness = matrixBotReadiness(env);
		if (!readiness.run) {
			console.log(yellow(`  Can't send a test — ${describeNotReady(readiness)}.`));
			if (readiness.reason === 'no-mxid' || readiness.reason === 'no-env-file') {
				console.log(
					`  Set your alert address first, on this server:  ${bold('sudo morphit-ops matrix set @you:matrix.org')}`
				);
			} else if (readiness.reason === 'no-token' || readiness.reason === 'placeholder-token') {
				console.log(
					`  Give the bot its sign-in, on this server:  ${bold('sudo morphit-ops matrix setup')}` +
						` (it sets ${bold('MORPHIT_MATRIX_BOT_ACCESS_TOKEN')} in ${MATRIX_BOT_ENV_PATH})`
				);
			}
			return 1;
		}

		const state = readState('morphit-matrix-bot');
		if (state !== 'active') {
			console.log(yellow(`  The matrix-bot isn't running (${describeState(state)}).`));
			console.log('  The test asks the running bot to message you, so it has to be up first.');
			console.log(
				`  On this server, ${bold('sudo morphit-ops matrix')} shows its state and offers to start it.`
			);
			return 1;
		}

		const port = readHealthcheckPort(MATRIX_BOT_ENV_PATH);
		console.log(
			dim(`  Asking the bot to send a self-test alert to ${readiness.mxids.length} recipient(s)…`)
		);

		let result: MatrixSelfTestResult;
		try {
			result = await withSpinner('Waiting for the bot to send it…', () => selfTest(port));
		} catch (err) {
			console.log(yellow(`  Couldn't reach the bot's healthcheck endpoint on 127.0.0.1:${port}.`));
			console.log(
				`  It reports active but isn't answering — on this server: ${bold('sudo journalctl -u morphit-matrix-bot -n 50 --no-pager')}`
			);
			console.log(dim(`  (${err instanceof Error ? err.message : String(err)})`));
			return 1;
		}

		if (result.dryRun) {
			console.log(yellow('  Dry-run mode is ON (MORPHIT_MATRIX_BOT_DRY_RUN=true).'));
			console.log(
				`  The bot logged what it WOULD send to ${result.recipients} recipient(s) but did not deliver.`
			);
			console.log(
				`  Remove MORPHIT_MATRIX_BOT_DRY_RUN from ${MATRIX_BOT_ENV_PATH}, then on this server: sudo systemctl restart morphit-matrix-bot`
			);
			return 0;
		}

		if (result.ok) {
			console.log(
				green(
					`  ✓ Sent a test alert to ${result.sent.length} recipient(s): ${result.sent.join(', ')}`
				)
			);
			console.log(
				'  Check your Matrix client now.  The FIRST message from the bot account arrives'
			);
			console.log('  as an invite / message request — accept it, and future alerts land directly.');
			console.log(
				dim(
					'  Nothing arrived?  The bot logs the reason; on this server: sudo journalctl -u morphit-matrix-bot -n 50 --no-pager'
				)
			);
			return 0;
		}

		// Partial or total delivery failure — surface the per-recipient errors.
		console.log(yellow(`  The bot tried but ${result.failed.length} delivery(ies) failed:`));
		for (const f of result.failed) {
			console.log(`    ${f.mxid} — ${f.error}`);
		}
		if (result.sent.length > 0) {
			console.log(green(`  (${result.sent.length} succeeded: ${result.sent.join(', ')})`));
		}
		console.log(
			dim(
				'  A token error usually means the bot sign-in is wrong or expired — sign it in again, on this server: sudo morphit-ops matrix setup'
			)
		);
		return 1;
	};

	// ─── set ─────────────────────────────────────────────────────────
	const runSet = async (rawIn: string): Promise<number> => {
		const raw = rawIn.trim();
		if (raw === '') {
			console.log(
				yellow('  Missing address.  On this server: sudo morphit-ops matrix set @you:matrix.org')
			);
			return 1;
		}
		// Validate BEFORE writing — never persist a #room alias or junk.
		if (raw.startsWith('#')) {
			console.log(
				yellow(`  ${JSON.stringify(raw)} is a Matrix room alias (#room:server), not an MXID.`)
			);
			console.log(
				'  The bot DMs PRIVATE operator alerts to a personal MXID (@user:server).\n' +
					'  Sending them to a public room would leak security telemetry to everyone\n' +
					'  in that room.  If you meant the PUBLIC user→operator contact room, that\n' +
					'  is a different setting (MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM, on this\n' +
					'  server: sudo morphit-ops edit).  For alerts, give a personal MXID, e.g. @you:matrix.org.'
			);
			return 1;
		}
		if (parseMxid(raw) === null && !raw.includes(',')) {
			console.log(yellow(`  ${JSON.stringify(raw)} is not a valid Matrix MXID.`));
			console.log('  Expected shape: @user:server.example   (e.g. @you:matrix.org)');
			return 1;
		}

		const before = readEnv(MATRIX_BOT_ENV_PATH);
		if (!before.exists) {
			console.log(yellow(`  ${MATRIX_BOT_ENV_PATH} does not exist on this host.`));
			console.log(
				'  The matrix-bot env file (which also holds the bot account access\n' +
					'  token) is laid down by the installer — the Ansible role creates it,\n' +
					'  or copy the template manually, on this server:\n' +
					'      sudo install -m 600 /opt/morphit/ops/env/matrix-bot.env.example \\\n' +
					'        /etc/morphit/matrix-bot.env\n' +
					'  Then: sudo morphit-ops matrix setup\n' +
					'  Reference: docs/RUN-A-MORPHIT-NODE.md §10 (Matrix sidecar).'
			);
			return 2;
		}

		// Comma-separated multi-recipient is allowed; validate each so a
		// later "@you,#room" can't slip a room alias in via the set path.
		for (const part of raw
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean)) {
			if (part.startsWith('#') || parseMxid(part) === null) {
				console.log(yellow(`  ${JSON.stringify(part)} is not a valid MXID.  Nothing written.`));
				return 1;
			}
		}

		if (!writeMxid(raw, MATRIX_BOT_ENV_PATH)) {
			console.log(yellow(`  Could not write ${MATRIX_BOT_ENV_PATH}.  Run this with sudo.`));
			return 1;
		}
		persistToConfig(raw);
		console.log(green(`  ✓ Alert address saved: ${raw}`));

		const readiness = matrixBotReadiness(readEnv(MATRIX_BOT_ENV_PATH));
		if (readiness.run) {
			const res = await sync(true, true);
			console.log('');
			if (res.ok && (await botSeenRunning(deps, dim))) {
				console.log(green('  ✓ Matrix alert bot (re)started and seen running.'));
				console.log(
					dim('    To check alerts reach you, on this server: sudo morphit-ops matrix test')
				);
				return 0;
			}
			console.log(yellow('  ✗ The address is saved, but the bot is not running.'));
			console.log('    After fixing it, on this server: sudo systemctl restart morphit-matrix-bot');
			return 1;
		}

		// Address valid but the bot is not ready to run (almost always: no
		// access token yet). Make sure it is NOT running on a partial config,
		// and tell the operator exactly what is missing.
		await sync(false, false);
		console.log('');
		console.log(yellow(`  ⓘ Bot not started yet — ${describeNotReady(readiness)}.`));
		if (readiness.reason === 'no-token' || readiness.reason === 'placeholder-token') {
			console.log(
				'    Give the bot its own Matrix sign-in (it mints the token for you), on this server:\n' +
					'      sudo morphit-ops matrix setup'
			);
		}
		return 0;
	};

	// ─── clear ───────────────────────────────────────────────────────
	const runClear = async (): Promise<number> => {
		const before = readEnv(MATRIX_BOT_ENV_PATH);
		if (!before.exists) {
			console.log('  Nothing to clear — no matrix-bot env file on this host.');
			return 0;
		}
		if (before.mxidRaw.trim() === '') {
			console.log('  Alert address already empty.  Making sure the bot is stopped…');
		} else {
			if (!writeMxid('', MATRIX_BOT_ENV_PATH)) {
				console.log(yellow(`  Could not write ${MATRIX_BOT_ENV_PATH}.  Run this with sudo.`));
				return 1;
			}
			console.log(green('  ✓ Alert address removed.'));
		}
		persistToConfig('');
		const res = await sync(false, false);
		console.log('');
		const after = readState('morphit-matrix-bot');
		if (res.ok && after !== 'active' && after !== 'activating') {
			console.log(green('  ✓ Matrix alert bot stopped and disabled (Matrix alerts are off).'));
			console.log(
				dim('    Turn them back on, on this server: sudo morphit-ops matrix set @you:matrix.org')
			);
			return 0;
		}
		console.log(yellow('  ✗ Could not stop the bot.'));
		console.log('    On this server:  sudo systemctl disable --now morphit-matrix-bot');
		return 1;
	};

	// ─── setup ───────────────────────────────────────────────────────
	// The full hand-editing-free flow: recipient MXID + bot creds → mint token →
	// persist to live env AND operator config → clear E2EE store → start → test.
	if (action === 'setup') {
		return (deps.configure ?? configureMatrixAlerts)(ctx.colorEnabled, deps);
	}
	if (action === 'test') return runTest();
	if (action === 'set') return runSet(ctx.positional[1] ?? ctx.flags['mxid'] ?? '');
	if (action === 'clear') return runClear();

	// ─── status (default) ────────────────────────────────────────────
	const env = readEnv(MATRIX_BOT_ENV_PATH);
	const readiness = matrixBotReadiness(env);
	const state = readState('morphit-matrix-bot');

	console.log('');
	console.log(bold('Matrix alerting (matrix-bot — DMs operator alerts to your Matrix account)'));
	console.log(`  Unit:     morphit-matrix-bot.service`);
	console.log(
		`  Address:  ${env.mxidRaw.trim() !== '' ? env.mxidRaw.trim() : dim('(not set — alerting off)')}`
	);
	console.log(
		`  Status:   ${state === 'active' ? green(describeState(state)) : describeState(state)}`
	);
	if (!readiness.run) console.log(`  Note:     ${describeNotReady(readiness)}`);
	console.log('');

	if (state === 'not-installed') {
		console.log(
			'  The morphit-matrix-bot unit is not installed on this host, so there is\n' +
				'  nothing to start or stop yet.  Stand it up with the installer (the\n' +
				'  Ansible role deploys the user + state dir + unit + env file), then, on\n' +
				'  this server: sudo morphit-ops matrix setup\n' +
				'  Reference: docs/OPERATIONS.md §16 and docs/RUN-A-MORPHIT-NODE.md §10.'
		);
		return 0;
	}
	if (state === 'unknown') {
		console.log('  Could not read the service state (systemd not reachable?).');
		return 1;
	}

	const running = state === 'active' || state === 'activating';

	// Nothing validly configured yet → offer the guided setup (mints the token,
	// wires it to config + live env, starts + tests) instead of leaving the operator
	// to hand-edit an env file (no hand-editing).
	if (!readiness.run && !running) {
		const ok = await confirm('Set up Matrix alerts now (I mint the bot token for you)?', true);
		if (ok) return (deps.configure ?? configureMatrixAlerts)(ctx.colorEnabled, deps);
		console.log(
			'  No change made.  To set it up later, on this server: sudo morphit-ops matrix setup'
		);
		return 0;
	}

	// Configured but crashing (systemd restarting it after each failure):
	// show WHY rather than offering to start what is already being started.
	if (readiness.run && state === 'failed') {
		console.log(yellow('  The bot is configured but keeps crashing.'));
		const tail = (deps.journalTail ?? defaultJournalTail)();
		if (tail === null) {
			console.log(
				'    To see why, on this server: sudo journalctl -u morphit-matrix-bot -n 50 --no-pager'
			);
		} else {
			console.log('    Its last log lines:');
			for (const l of tail.split('\n')) console.log(dim(`      ${l}`));
		}
		console.log('');
	}

	// Ready + stopped (or crashing) → offer to (re)start it.
	if (readiness.run && !running) {
		const ok = await confirm(
			state === 'failed' ? 'Restart the matrix-bot now?' : 'Start and enable the matrix-bot now?',
			state !== 'failed'
		);
		if (!ok) {
			console.log('  Left as it is.  No change made.');
			return 0;
		}
		const res = await sync(true, true);
		console.log('');
		if (res.ok && (await botSeenRunning(deps, dim))) {
			console.log(green('  ✓ Matrix alert bot enabled and seen running.'));
			return 0;
		}
		console.log(yellow('  ✗ The bot is not running.'));
		console.log('    After fixing it, on this server: sudo systemctl restart morphit-matrix-bot');
		return 1;
	}
	if (!readiness.run && running) {
		const ok = await confirm('The bot is running but not validly configured.  Stop it now?', true);
		if (!ok) {
			console.log('  Left running.  No change made.');
			return 0;
		}
		const res = await sync(false, false);
		console.log('');
		if (res.ok) {
			console.log(green('  ✓ matrix-bot stopped and disabled.'));
			return 0;
		}
		console.log(
			yellow(
				'  ✗ Could not stop the bot.  On this server: sudo systemctl disable --now morphit-matrix-bot'
			)
		);
		return 1;
	}

	// Configured and running: what can be done with it (the menu item
	// promises set and clear; it used to print only "Clear with: …").
	const choose =
		deps.askChoice ??
		((q: string, options: readonly string[]) => realAskChoice(q, options, options.length - 1));
	const ask = deps.ask ?? realAsk;
	const pick = await choose('What would you like to do?', [
		'Change the alert address',
		'Send a test alert',
		'Turn Matrix alerts off',
		'Done'
	]);
	if (pick === 0) {
		const next = (
			await ask('New alert address (e.g. @you:matrix.org; Enter keeps the current one)')
		).trim();
		if (next === '') {
			console.log('  No change made.');
			return 0;
		}
		return runSet(next);
	}
	if (pick === 1) return runTest();
	if (pick === 2) {
		const off = await confirm(
			'Turn Matrix alerts off (remove the address and stop the bot)?',
			false
		);
		if (!off) {
			console.log('  No change made.');
			return 0;
		}
		return runClear();
	}
	return 0;
}
