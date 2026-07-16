#!/usr/bin/env tsx
/**
 * matrix-test-command-smoke — `morphit-ops matrix test` decision logic.
 *
 * The command asks the RUNNING bot (via its loopback /self-test route) to DM
 * a labelled test alert to the configured recipients. This smoke drives every
 * branch with injected deps (env read, service state, the self-test POST) so
 * the logic is verified without a live systemd, a running bot, or Matrix:
 *   - refuses (exit 1) with an actionable hint when no MXID / no env / no token
 *   - refuses (exit 1, no POST) when the bot isn't running
 *   - happy path: POSTs the self-test, confirms delivery + the invite hint
 *   - surfaces dry-run mode without claiming a real send
 *   - surfaces per-recipient delivery failures (exit 1)
 *   - maps a connection failure to a "couldn't reach the bot" message (exit 1)
 * Plus the healthcheck-port parser (default / set / last-wins / quotes /
 * garbage / out-of-range).
 */

import { runMatrix, type MatrixDeps, type MatrixSelfTestResult } from '../src/commands/matrix.ts';
import {
	parseMatrixBotHealthcheckPort,
	readMatrixBotHealthcheckPort,
	MATRIX_BOT_DEFAULT_HEALTHCHECK_PORT,
	type MatrixBotEnv
} from '../src/lib/matrixBot.ts';
import type { ServiceState } from '../src/commands/health.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
let n = 0;
function check(name: string, cond: boolean, detail = ''): void {
	n++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		failures++;
		console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
	}
}

/** A ready env by default; override fields to exercise the not-ready branches. */
function env(over: Partial<MatrixBotEnv> = {}): MatrixBotEnv {
	return { exists: true, mxidRaw: '@alice:matrix.org', tokenRaw: 'mat_realtoken', ...over };
}

async function run(deps: MatrixDeps): Promise<{ code: number; out: string }> {
	const lines: string[] = [];
	const origLog = console.log;
	const origErr = console.error;
	console.log = (...a: unknown[]): void => {
		lines.push(a.map((x) => String(x)).join(' '));
	};
	console.error = (...a: unknown[]): void => {
		lines.push(a.map((x) => String(x)).join(' '));
	};
	let code: number;
	try {
		code = await runMatrix({ flags: {}, positional: ['test'], colorEnabled: false }, deps);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { code, out: lines.join('\n') };
}

const okResult: MatrixSelfTestResult = {
	ok: true,
	dryRun: false,
	recipients: 1,
	sent: ['@alice:matrix.org'],
	failed: []
};
const active = (): ServiceState => 'active';

// A deliberately non-default port: the ready-path scenarios inject the port
// reader so the smoke NEVER reads the real /etc/morphit/matrix-bot.env (which,
// on a host that has the bot installed, is root-owned 0600 and unreadable by a
// non-root CI runner — that EACCES crash is exactly what this guards against).
// Using a non-default value also proves the injected reader's port is what
// actually reaches the self-test POST, rather than a coincidental 9876.
const TEST_PORT = 12345;

async function main(): Promise<void> {
	console.log('matrix-test-command-smoke');

	// 1. no MXID configured
	{
		const { code, out } = await run({
			readEnv: () => env({ mxidRaw: '' }),
			readState: active,
			selfTest: async () => okResult
		});
		check('no-mxid: exit 1', code === 1, `code=${code}`);
		check('no-mxid: points at `matrix set`', /matrix set/.test(out));
		check('no-mxid: does not attempt a send', !/Asking the bot/.test(out));
	}

	// 2. no env file at all
	{
		const { code, out } = await run({
			readEnv: () => ({ exists: false, mxidRaw: '', tokenRaw: '' }),
			readState: active,
			selfTest: async () => okResult
		});
		check('no-env: exit 1', code === 1);
		check('no-env: points at `matrix set`', /matrix set/.test(out));
	}

	// 3. MXID set but no token
	{
		const { code, out } = await run({
			readEnv: () => env({ tokenRaw: '' }),
			readState: active,
			selfTest: async () => okResult
		});
		check('no-token: exit 1', code === 1);
		check('no-token: mentions ACCESS_TOKEN', /ACCESS_TOKEN/.test(out));
	}

	// 4. ready, but bot not running — must NOT POST
	{
		let posted = false;
		const { code, out } = await run({
			readEnv: () => env(),
			readState: () => 'inactive',
			selfTest: async () => {
				posted = true;
				return okResult;
			}
		});
		check('not-running: exit 1', code === 1);
		check('not-running: says it is not running', /isn.t running/.test(out));
		check('not-running: did NOT POST the self-test', posted === false);
	}

	// 5. happy path
	{
		let posted = false;
		let portUsed = -1;
		const { code, out } = await run({
			readEnv: () => env(),
			readState: active,
			readHealthcheckPort: () => TEST_PORT,
			selfTest: async (p) => {
				posted = true;
				portUsed = p;
				return okResult;
			}
		});
		check('happy: exit 0', code === 0, `code=${code}`);
		// cp474 — `posted` is set inside the selfTest callback, which TS's flow
		// analysis can't see, so it stayed narrowed to the literal `false` and
		// `=== true` looked impossible. Pass the boolean straight through.
		check('happy: POSTed the self-test', posted);
		check('happy: threaded the configured healthcheck port to the POST', portUsed === TEST_PORT, `port=${portUsed}`);
		check(
			'happy: confirms delivery + invite-acceptance hint',
			/Sent a test alert/.test(out) && /invite/.test(out)
		);
	}

	// 6. dry-run mode
	{
		const { code, out } = await run({
			readEnv: () => env(),
			readState: active,
			readHealthcheckPort: () => TEST_PORT,
			selfTest: async () => ({ ok: true, dryRun: true, recipients: 1, sent: [], failed: [] })
		});
		check('dry-run: exit 0', code === 0);
		check('dry-run: warns dry-run is ON', /Dry-run mode is ON/.test(out));
		check('dry-run: does not claim a real send', !/Sent a test alert/.test(out));
	}

	// 7. delivery failure
	{
		const { code, out } = await run({
			readEnv: () => env(),
			readState: active,
			readHealthcheckPort: () => TEST_PORT,
			selfTest: async () => ({
				ok: false,
				dryRun: false,
				recipients: 1,
				sent: [],
				failed: [{ mxid: '@alice:matrix.org', error: 'M_FORBIDDEN bad token' }]
			})
		});
		check('fail: exit 1', code === 1);
		check('fail: shows the per-recipient error', /M_FORBIDDEN bad token/.test(out));
		check('fail: hints at the token', /token/.test(out));
	}

	// 8. connection failure (bot active but endpoint not answering)
	{
		const { code, out } = await run({
			readEnv: () => env(),
			readState: active,
			readHealthcheckPort: () => TEST_PORT,
			selfTest: async () => {
				throw new Error(`connect ECONNREFUSED 127.0.0.1:${TEST_PORT}`);
			}
		});
		check('conn-err: exit 1', code === 1);
		check('conn-err: says it could not reach the bot', /Couldn.t reach/.test(out));
		check('conn-err: surfaces the underlying error', /ECONNREFUSED/.test(out));
	}

	// ─── healthcheck-port parser ────────────────────────────────────────
	check(
		'port: default when key absent',
		parseMatrixBotHealthcheckPort('FOO=bar\n') === MATRIX_BOT_DEFAULT_HEALTHCHECK_PORT
	);
	check(
		'port: parses a set value',
		parseMatrixBotHealthcheckPort('MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT=9999\n') === 9999
	);
	check(
		'port: last-wins on duplicate keys',
		parseMatrixBotHealthcheckPort(
			'MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT=1111\nMORPHIT_MATRIX_BOT_HEALTHCHECK_PORT=2222\n'
		) === 2222
	);
	check(
		'port: strips surrounding quotes',
		parseMatrixBotHealthcheckPort('MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT="8765"\n') === 8765
	);
	check(
		'port: falls back on garbage',
		parseMatrixBotHealthcheckPort('MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT=notaport\n') ===
			MATRIX_BOT_DEFAULT_HEALTHCHECK_PORT
	);
	check(
		'port: falls back on out-of-range',
		parseMatrixBotHealthcheckPort('MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT=99999\n') ===
			MATRIX_BOT_DEFAULT_HEALTHCHECK_PORT
	);

	// ─── healthcheck-port READER: never throws on a file it can't read ──
	// Regression for the cp277 CI failure: readMatrixBotHealthcheckPort used an
	// existsSync pre-check, which a present-but-unreadable file passes — so the
	// subsequent readFileSync threw EACCES (matrix-bot.env is root-owned 0600 and
	// the forgejo runner is non-root), crashing the whole smoke. Both a missing
	// file (ENOENT) and an unreadable one must fall back to the default port.
	// We can't portably force EACCES while running as root, so we read a
	// directory path (readFileSync → EISDIR), which throws for every uid and
	// exercises the same catch.
	check(
		'port-read: missing file falls back to the default (no throw)',
		readMatrixBotHealthcheckPort(
			join(tmpdir(), `morphit-no-such-${process.pid}-${Date.now()}.env`)
		) === MATRIX_BOT_DEFAULT_HEALTHCHECK_PORT
	);
	check(
		'port-read: unreadable file (read throws) falls back to the default (no throw)',
		readMatrixBotHealthcheckPort(tmpdir()) === MATRIX_BOT_DEFAULT_HEALTHCHECK_PORT
	);

	if (failures > 0) {
		console.error(`\nmatrix-test-command-smoke: ${failures} failure(s) across ${n} checks`);
		process.exit(1);
	}
	console.log(`\n\u2713 all ${n} matrix-test-command-smoke checks passed`);
}

main().catch((e: unknown) => {
	console.error('matrix-test-command-smoke crashed:', e);
	process.exit(1);
});
