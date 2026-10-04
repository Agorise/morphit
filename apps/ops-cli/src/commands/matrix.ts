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
import { rmSync } from 'node:fs';
import {
	MATRIX_BOT_ENV_PATH,
	matrixBotReadiness,
	readMatrixBotEnv,
	readMatrixBotHealthcheckPort,
	syncMatrixBotService,
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
	readonly sync?: (run: boolean, restart: boolean) => MatrixBotSyncResult;
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
		deps.sync ?? ((run: boolean, restart: boolean) => syncMatrixBotService(run, { restart }));

	// Never block on stdin in a non-interactive context (a piped/CI invocation, or
	// a smoke driving the status flow) — this whole flow is interactive by nature.
	const ask = deps.ask ?? realAsk;
	const askChoice = deps.askChoice ?? realAskChoice;
	const askPassword = deps.askPassword ?? realAskPassword;
	const torOnly = (deps.torOnly ?? (() => isHiddenOnlyNode()))();
	if (!(deps.isTTY ?? process.stdin.isTTY)) {
		console.log('  Run `morphit-ops matrix setup` in an interactive terminal to set up alerts.');
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
		console.log(dim('  Minting a fresh access token (a new device — avoids E2EE key collisions)…'));
		const minted = await (deps.mint ?? mintMatrixToken)(homeserver, user, password);
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

	// 6. Enable + start.
	const res = sync(true, true);
	console.log('');
	if (!res.ok) {
		console.log(yellow('  ✗ Saved, but the bot did not start cleanly.'));
		console.log('    Check:  journalctl -u morphit-matrix-bot -n 30 --no-pager');
		return 1;
	}
	console.log(green('  ✓ matrix-bot enabled + started.'));

	// 7. Test — DM the operator so they SEE it working (best-effort).
	const port = (deps.readHealthcheckPort ?? readMatrixBotHealthcheckPort)(MATRIX_BOT_ENV_PATH);
	const selfTest = deps.selfTest ?? postSelfTest;
	try {
		const t = await selfTest(port);
		if (t.ok && t.sent.length > 0) {
			console.log(green(`  ✓ Test alert sent to ${t.sent.join(', ')} — check your Matrix client.`));
			console.log(dim('    The first message arrives as an invite/request — accept it once.'));
		} else {
			console.log(dim('  Bot is up; run `morphit-ops matrix test` in a moment to send a test DM.'));
		}
	} catch {
		console.log(dim('  Bot is up; run `morphit-ops matrix test` in a moment to send a test DM.'));
	}
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
			return 'failed (crashed — see `journalctl -u morphit-matrix-bot`)';
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
	const sync =
		deps.sync ?? ((run: boolean, restart: boolean) => syncMatrixBotService(run, { restart }));
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
		console.log('  Usage:');
		console.log(
			'    morphit-ops matrix setup                 guided setup — mints the token for you'
		);
		console.log('    morphit-ops matrix set @you:matrix.org   set / edit the alert username');
		console.log('    morphit-ops matrix clear                 remove it (stops the bot)');
		console.log('    morphit-ops matrix test                  send yourself a test alert');
		console.log('    morphit-ops matrix                        show status');
		return 1;
	}

	// ─── setup ───────────────────────────────────────────────────────
	// The full hand-editing-free flow: recipient MXID + bot creds → mint token →
	// persist to live env AND operator config → clear E2EE store → start → test.
	if (action === 'setup') {
		return (deps.configure ?? configureMatrixAlerts)(ctx.colorEnabled, deps);
	}

	// ─── test ────────────────────────────────────────────────────────
	// Ask the RUNNING bot (via its loopback healthcheck server) to DM a
	// labelled self-test alert to the configured recipients. We trigger the
	// bot's OWN client instead of opening a second Matrix client here: a
	// second client sharing the bot's access token would fight over the
	// device's immutable E2E identity (see apps/matrix-bot/src/health.ts).
	if (action === 'test') {
		const env = readEnv(MATRIX_BOT_ENV_PATH);
		const readiness = matrixBotReadiness(env);
		if (!readiness.run) {
			console.log(yellow(`  Can't send a test — ${describeNotReady(readiness)}.`));
			if (readiness.reason === 'no-mxid' || readiness.reason === 'no-env-file') {
				console.log(
					`  Set your alert username first:  ${bold('morphit-ops matrix set @you:matrix.org')}`
				);
			} else if (readiness.reason === 'no-token' || readiness.reason === 'placeholder-token') {
				console.log(
					`  Add ${bold('MORPHIT_MATRIX_BOT_ACCESS_TOKEN')} to ${MATRIX_BOT_ENV_PATH}, then restart the bot.`
				);
			}
			return 1;
		}

		const state = readState('morphit-matrix-bot');
		if (state !== 'active') {
			console.log(yellow(`  The matrix-bot isn't running (${describeState(state)}).`));
			console.log('  The test asks the running bot to message you, so it has to be up first.');
			console.log(
				`  ${bold('morphit-ops matrix')} shows its state; setting a valid username starts it.`
			);
			return 1;
		}

		const port = readHealthcheckPort(MATRIX_BOT_ENV_PATH);
		console.log(
			dim(`  Asking the bot to send a self-test alert to ${readiness.mxids.length} recipient(s)…`)
		);

		let result: MatrixSelfTestResult;
		try {
			result = await selfTest(port);
		} catch (err) {
			console.log(yellow(`  Couldn't reach the bot's healthcheck endpoint on 127.0.0.1:${port}.`));
			console.log(
				`  It reports active but isn't answering — check ${bold('journalctl -u morphit-matrix-bot')}.`
			);
			console.log(dim(`  (${err instanceof Error ? err.message : String(err)})`));
			return 1;
		}

		if (result.dryRun) {
			console.log(yellow('  Dry-run mode is ON (MORPHIT_MATRIX_BOT_DRY_RUN=true).'));
			console.log(
				`  The bot logged what it WOULD send to ${result.recipients} recipient(s) but did not deliver.`
			);
			console.log('  Unset dry-run + restart the bot to run a real delivery test.');
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
					'  Nothing arrived?  The bot logs the reason:  journalctl -u morphit-matrix-bot --since "2 minutes ago"'
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
				'  A token error usually means the access token is wrong or expired — re-mint it (OPERATIONS.md §16).'
			)
		);
		return 1;
	}

	// ─── set ─────────────────────────────────────────────────────────
	if (action === 'set') {
		const raw = (ctx.positional[1] ?? ctx.flags['mxid'] ?? '').trim();
		if (raw === '') {
			console.log(yellow('  Missing MXID.  Usage: morphit-ops matrix set @you:matrix.org'));
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
					'  is a different setting (MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM via\n' +
					'  `morphit-ops edit`).  For alerts, give a personal MXID, e.g. @you:matrix.org.'
			);
			return 1;
		}
		const parsed = parseMxid(raw);
		if (parsed === null) {
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
					'  or copy the template manually:\n' +
					'      sudo install -m 600 ops/env/matrix-bot.env.example \\\n' +
					'        /etc/morphit/matrix-bot.env\n' +
					'  Then set MORPHIT_MATRIX_BOT_ACCESS_TOKEN in it and re-run this command.\n' +
					'  Reference: docs/RUN-A-MORPHIT-NODE.md §10 (Matrix sidecar).'
			);
			return 2;
		}

		// Comma-separated multi-recipient is allowed; validate each so a
		// later "@you,#room" can't slip a room alias in via the set path.
		for (const part of raw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)) {
			if (part.startsWith('#') || parseMxid(part) === null) {
				console.log(yellow(`  ${JSON.stringify(part)} is not a valid MXID.  Nothing written.`));
				return 1;
			}
		}

		if (!writeMxid(raw, MATRIX_BOT_ENV_PATH)) {
			console.log(yellow(`  Could not write ${MATRIX_BOT_ENV_PATH}.`));
			return 1;
		}
		console.log(green(`  ✓ Alert username saved: ${raw}`));

		const readiness = matrixBotReadiness(readEnv(MATRIX_BOT_ENV_PATH));
		if (readiness.run) {
			const res = sync(true, true);
			console.log('');
			if (res.ok) {
				console.log(green('  ✓ matrix-bot enabled and (re)started — alerts will DM to you now.'));
				console.log(dim('    Confirm with: morphit-ops status   (look for morphit-matrix-bot)'));
				return 0;
			}
			console.log(yellow('  ✗ Username saved, but the bot did not start cleanly.'));
			console.log(
				'    Try:  sudo systemctl restart morphit-matrix-bot   then  journalctl -u morphit-matrix-bot'
			);
			return 1;
		}

		// Username valid but the bot is not ready to run (almost always:
		// no access token yet).  Make sure it is NOT running on a partial
		// config, and tell the operator exactly what is missing.
		sync(false, false);
		console.log('');
		console.log(yellow(`  ⓘ Bot not started yet — ${describeNotReady(readiness)}.`));
		if (readiness.reason === 'no-token' || readiness.reason === 'placeholder-token') {
			console.log(
				'    Add the bot account access token to /etc/morphit/matrix-bot.env:\n' +
					'      MORPHIT_MATRIX_BOT_ACCESS_TOKEN=syt_...\n' +
					'    (log in once as a DEDICATED bot account and copy its token — never\n' +
					'    reuse your personal account token), then run `morphit-ops matrix`\n' +
					'    to start it.'
			);
		}
		return 0;
	}

	// ─── clear ───────────────────────────────────────────────────────
	if (action === 'clear') {
		const before = readEnv(MATRIX_BOT_ENV_PATH);
		if (!before.exists) {
			console.log('  Nothing to clear — no matrix-bot env file on this host.');
			return 0;
		}
		if (before.mxidRaw.trim() === '') {
			console.log('  Alert username already empty.  Ensuring the bot is stopped…');
		} else {
			if (!writeMxid('', MATRIX_BOT_ENV_PATH)) {
				console.log(yellow(`  Could not write ${MATRIX_BOT_ENV_PATH}.`));
				return 1;
			}
			console.log(green('  ✓ Alert username removed.'));
		}
		const res = sync(false, false);
		console.log('');
		if (res.ok) {
			console.log(green('  ✓ matrix-bot stopped and disabled (Matrix alerting is off).'));
			console.log(dim('    Re-enable later with: morphit-ops matrix set @you:matrix.org'));
			return 0;
		}
		console.log(yellow('  ✗ Could not stop the unit.'));
		console.log('    Run it manually:  sudo systemctl disable --now morphit-matrix-bot');
		return 1;
	}

	// ─── status (default) ────────────────────────────────────────────
	const env = readEnv(MATRIX_BOT_ENV_PATH);
	const readiness = matrixBotReadiness(env);
	const state = readState('morphit-matrix-bot');

	console.log('');
	console.log(bold('Matrix alerting (matrix-bot — DMs operator alerts to your Matrix account)'));
	console.log(`  Unit:     morphit-matrix-bot.service`);
	console.log(
		`  Username: ${env.mxidRaw.trim() !== '' ? env.mxidRaw.trim() : dim('(not set — alerting off)')}`
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
				'  Ansible role deploys the user + state dir + unit + env file), then\n' +
				'  run `morphit-ops matrix set @you:matrix.org`.\n' +
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
		console.log('  No change made.  Run `morphit-ops matrix setup` any time.');
		return 0;
	}

	// Offer the beneficial action: ready+stopped → start; not-ready+running → stop.
	if (readiness.run && !running) {
		const ok = await confirm('Start and enable the matrix-bot now?', true);
		if (!ok) {
			console.log('  Left stopped.  No change made.');
			return 0;
		}
		const res = sync(true, true);
		console.log('');
		if (res.ok) {
			console.log(green('  ✓ matrix-bot enabled and started.'));
			return 0;
		}
		console.log(
			yellow('  ✗ Could not start the unit.  Try: sudo systemctl restart morphit-matrix-bot')
		);
		return 1;
	}
	if (!readiness.run && running) {
		const ok = await confirm('The bot is running but not validly configured.  Stop it now?', true);
		if (!ok) {
			console.log('  Left running.  No change made.');
			return 0;
		}
		const res = sync(false, false);
		console.log('');
		if (res.ok) {
			console.log(green('  ✓ matrix-bot stopped and disabled.'));
			return 0;
		}
		console.log(
			yellow('  ✗ Could not stop the unit.  Try: sudo systemctl disable --now morphit-matrix-bot')
		);
		return 1;
	}

	// Already in the right state.
	if (readiness.run && running) {
		console.log(dim('  Configured and running.  Verify delivery: morphit-ops matrix test'));
		console.log(dim('  Clear with: morphit-ops matrix clear'));
	} else {
		console.log(dim('  Set a username to enable alerts:  morphit-ops matrix set @you:matrix.org'));
	}
	return 0;
}
