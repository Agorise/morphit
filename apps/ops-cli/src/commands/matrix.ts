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

import { askYesNo } from '../init/prompt.ts';
import { checkService, type ServiceState } from './health.ts';
import {
	MATRIX_BOT_ENV_PATH,
	matrixBotReadiness,
	readMatrixBotEnv,
	readMatrixBotHealthcheckPort,
	syncMatrixBotService,
	writeAlertMxid,
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
	}
}

export async function runMatrix(ctx: MatrixCtx, deps: MatrixDeps = {}): Promise<number> {
	const readEnv = deps.readEnv ?? readMatrixBotEnv;
	const readState = deps.readState ?? checkService;
	const writeMxid = deps.writeMxid ?? writeAlertMxid;
	const sync = deps.sync ?? ((run: boolean, restart: boolean) => syncMatrixBotService(run, { restart }));
	const confirm = deps.confirm ?? askYesNo;
	const selfTest = deps.selfTest ?? postSelfTest;

	const paint = (open: string, s: string): string => (ctx.colorEnabled ? `${open}${s}\u001b[0m` : s);
	const bold = (s: string): string => paint('\u001b[1m', s);
	const dim = (s: string): string => paint('\u001b[2m', s);
	const green = (s: string): string => paint('\u001b[32m', s);
	const yellow = (s: string): string => paint('\u001b[33m', s);

	const action = (ctx.positional[0] ?? 'status').toLowerCase();
	if (action !== 'status' && action !== 'set' && action !== 'clear' && action !== 'test') {
		console.log(yellow(`  Unknown action: ${action}`));
		console.log('  Usage:');
		console.log('    morphit-ops matrix set @you:matrix.org   set / edit the alert username');
		console.log('    morphit-ops matrix clear                 remove it (stops the bot)');
		console.log('    morphit-ops matrix test                  send yourself a test alert');
		console.log('    morphit-ops matrix                        show status');
		return 1;
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
				console.log(`  Set your alert username first:  ${bold('morphit-ops matrix set @you:matrix.org')}`);
			} else if (readiness.reason === 'no-token' || readiness.reason === 'placeholder-token') {
				console.log(`  Add ${bold('MORPHIT_MATRIX_BOT_ACCESS_TOKEN')} to ${MATRIX_BOT_ENV_PATH}, then restart the bot.`);
			}
			return 1;
		}

		const state = readState('morphit-matrix-bot');
		if (state !== 'active') {
			console.log(yellow(`  The matrix-bot isn't running (${describeState(state)}).`));
			console.log('  The test asks the running bot to message you, so it has to be up first.');
			console.log(`  ${bold('morphit-ops matrix')} shows its state; setting a valid username starts it.`);
			return 1;
		}

		const port = readMatrixBotHealthcheckPort(MATRIX_BOT_ENV_PATH);
		console.log(dim(`  Asking the bot to send a self-test alert to ${readiness.mxids.length} recipient(s)…`));

		let result: MatrixSelfTestResult;
		try {
			result = await selfTest(port);
		} catch (err) {
			console.log(yellow(`  Couldn't reach the bot's healthcheck endpoint on 127.0.0.1:${port}.`));
			console.log(`  It reports active but isn't answering — check ${bold('journalctl -u morphit-matrix-bot')}.`);
			console.log(dim(`  (${err instanceof Error ? err.message : String(err)})`));
			return 1;
		}

		if (result.dryRun) {
			console.log(yellow('  Dry-run mode is ON (MORPHIT_MATRIX_BOT_DRY_RUN=true).'));
			console.log(`  The bot logged what it WOULD send to ${result.recipients} recipient(s) but did not deliver.`);
			console.log('  Unset dry-run + restart the bot to run a real delivery test.');
			return 0;
		}

		if (result.ok) {
			console.log(green(`  ✓ Sent a test alert to ${result.sent.length} recipient(s): ${result.sent.join(', ')}`));
			console.log('  Check your Matrix client now.  The FIRST message from the bot account arrives');
			console.log('  as an invite / message request — accept it, and future alerts land directly.');
			console.log(dim('  Nothing arrived?  The bot logs the reason:  journalctl -u morphit-matrix-bot --since "2 minutes ago"'));
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
		console.log(dim('  A token error usually means the access token is wrong or expired — re-mint it (OPERATIONS.md §16).'));
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
			console.log(yellow(`  ${JSON.stringify(raw)} is a Matrix room alias (#room:server), not an MXID.`));
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
					'  Reference: docs/RUN-A-MORPHIT-NODE.md §11 (Matrix sidecar).'
			);
			return 2;
		}

		// Comma-separated multi-recipient is allowed; validate each so a
		// later "@you,#room" can't slip a room alias in via the set path.
		for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
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
			console.log('    Try:  sudo systemctl restart morphit-matrix-bot   then  journalctl -u morphit-matrix-bot');
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
	console.log(`  Status:   ${state === 'active' ? green(describeState(state)) : describeState(state)}`);
	if (!readiness.run) console.log(`  Note:     ${describeNotReady(readiness)}`);
	console.log('');

	if (state === 'not-installed') {
		console.log(
			'  The morphit-matrix-bot unit is not installed on this host, so there is\n' +
				'  nothing to start or stop yet.  Stand it up with the installer (the\n' +
				'  Ansible role deploys the user + state dir + unit + env file), then\n' +
				'  run `morphit-ops matrix set @you:matrix.org`.\n' +
				'  Reference: docs/OPERATIONS.md §16 and docs/RUN-A-MORPHIT-NODE.md §11.'
		);
		return 0;
	}
	if (state === 'unknown') {
		console.log('  Could not read the service state (systemd not reachable?).');
		return 1;
	}

	const running = state === 'active' || state === 'activating';

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
		console.log(yellow('  ✗ Could not start the unit.  Try: sudo systemctl restart morphit-matrix-bot'));
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
		console.log(yellow('  ✗ Could not stop the unit.  Try: sudo systemctl disable --now morphit-matrix-bot'));
		return 1;
	}

	// Already in the right state.
	if (readiness.run && running) {
		console.log(dim('  Configured and running.  Verify delivery: morphit-ops matrix test'));
		console.log(dim('  Clear with: morphit-ops matrix clear'));
	} else {
		console.log(
			dim('  Set a username to enable alerts:  morphit-ops matrix set @you:matrix.org')
		);
	}
	return 0;
}
