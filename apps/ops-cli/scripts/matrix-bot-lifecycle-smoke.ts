#!/usr/bin/env tsx
/**
 * matrix-bot-lifecycle-smoke — locks down `morphit-ops matrix` + the
 * matrix-bot lifecycle. Ken's requirement: the bot is installed by
 * default but only RUNS when a valid alert username is configured; it
 * auto-starts when the username is set, auto-stops when it is cleared,
 * and every upgrade re-checks the field.
 *
 * What this guards (all pure / injected — no real systemd, sudo, stdin,
 * or /etc):
 *   1. matrixBotReadiness() decides run vs the precise not-ready reason
 *      for every env shape (no file / no mxid / #room / junk / no token /
 *      placeholder token / valid+token / multi-recipient).
 *   2. parseMatrixBotEnvText() — comment-skip, quote-strip, last-wins.
 *   3. upsertEnvKey()/clearEnvKey() — replace in place preserving the
 *      secret token + comments; append when absent; clear → empty.
 *   4. systemctlArgv() sudo-awareness.
 *   5. syncMatrixBotService() drives the right verbs: run+restart →
 *      daemon-reload+enable+restart; run → +start; !run → disable --now;
 *      non-zero exit → ok:false.
 *   6. runMatrix() branches: set valid → write + start; set #room/junk →
 *      reject, NO write, NO systemd; set with no env file → exit 2; set
 *      valid but no token → write + STOP (no crash-loop) + hint; clear →
 *      write empty + stop; status ready+stopped → offer start; status
 *      no-mxid → no systemd; status not-installed → no systemd.
 *   7. Wiring: main.ts imports + dispatches `matrix`; the menu exposes it.
 *
 * On success prints exactly one canonical line at column 0:
 *   ✓ all N matrix-bot-lifecycle-smoke scenarios passed
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	matrixBotReadiness,
	parseMatrixBotEnvText,
	upsertEnvKey,
	clearEnvKey,
	systemctlArgv,
	syncMatrixBotService,
	MATRIX_BOT_UNIT,
	type MatrixBotEnv,
	type SystemctlExec
} from '../src/lib/matrixBot.ts';
import { runMatrix, type MatrixDeps } from '../src/commands/matrix.ts';
import type { ServiceState } from '../src/commands/health.ts';
import { MENU_GROUPS } from '../src/commands/mainMenu.ts';

const here = dirname(fileURLToPath(import.meta.url));
const opsCliRoot = join(here, '..');

let checks = 0;
const failures: string[] = [];
function check(label: string, cond: boolean): void {
	checks++;
	if (!cond) failures.push(label);
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
	const orig = console.log;
	console.log = () => {};
	try {
		return await fn();
	} finally {
		console.log = orig;
	}
}

const env = (mxidRaw: string, tokenRaw: string, exists = true): MatrixBotEnv => ({
	exists,
	mxidRaw,
	tokenRaw
});

/** Recording systemctl exec — captures argv, returns a fixed status. */
function recordingExec(status: number | null): {
	exec: SystemctlExec;
	calls: Array<{ cmd: string; args: readonly string[] }>;
} {
	const calls: Array<{ cmd: string; args: readonly string[] }> = [];
	const exec: SystemctlExec = (cmd, args) => {
		calls.push({ cmd, args });
		return { status };
	};
	return { exec, calls };
}

const CTX = (positional: readonly string[]) => ({
	flags: {} as Readonly<Record<string, string>>,
	positional,
	colorEnabled: false
});

async function main(): Promise<void> {
	// ── 1. matrixBotReadiness ─────────────────────────────────────
	check('no env file → run:false no-env-file', (() => {
		const r = matrixBotReadiness(env('', '', false));
		return !r.run && r.reason === 'no-env-file';
	})());
	check('empty mxid → run:false no-mxid', (() => {
		const r = matrixBotReadiness(env('', 'syt_tok'));
		return !r.run && r.reason === 'no-mxid';
	})());
	check('valid mxid + token → run:true (1 recipient)', (() => {
		const r = matrixBotReadiness(env('@agorise:matrix.org', 'syt_realtoken'));
		return r.run && r.mxids.length === 1;
	})());
	check('valid mxid + NO token → run:false no-token', (() => {
		const r = matrixBotReadiness(env('@agorise:matrix.org', ''));
		return !r.run && r.reason === 'no-token';
	})());
	check('valid mxid + placeholder token → run:false placeholder-token', (() => {
		const r = matrixBotReadiness(env('@agorise:matrix.org', 'syt_...'));
		return !r.run && r.reason === 'placeholder-token';
	})());
	check('#room mxid → run:false mxid-is-room', (() => {
		const r = matrixBotReadiness(env('#agorise:matrix.org', 'syt_tok'));
		return !r.run && r.reason === 'mxid-is-room';
	})());
	check('junk mxid → run:false invalid-mxid', (() => {
		const r = matrixBotReadiness(env('not-an-mxid', 'syt_tok'));
		return !r.run && r.reason === 'invalid-mxid';
	})());
	check('multi-recipient valid + token → run:true (2 recipients)', (() => {
		const r = matrixBotReadiness(env('@a:matrix.org, @b:matrix.org', 'syt_tok'));
		return r.run && r.mxids.length === 2;
	})());
	check('multi-recipient with a #room → run:false mxid-is-room', (() => {
		const r = matrixBotReadiness(env('@a:matrix.org,#pub:matrix.org', 'syt_tok'));
		return !r.run && r.reason === 'mxid-is-room';
	})());

	// ── 2. parseMatrixBotEnvText ──────────────────────────────────
	check('parse basic mxid + token', (() => {
		const p = parseMatrixBotEnvText(
			'MORPHIT_MATRIX_BOT_ALERT_MXID=@a:b\nMORPHIT_MATRIX_BOT_ACCESS_TOKEN=tok'
		);
		return p.mxidRaw === '@a:b' && p.tokenRaw === 'tok';
	})());
	check('parse skips commented lines', (() => {
		const p = parseMatrixBotEnvText('# MORPHIT_MATRIX_BOT_ALERT_MXID=@x:y\n');
		return p.mxidRaw === '';
	})());
	check('parse strips matching quotes', (() => {
		const p = parseMatrixBotEnvText('MORPHIT_MATRIX_BOT_ALERT_MXID="@a:b"');
		return p.mxidRaw === '@a:b';
	})());
	check('parse last-wins on duplicate keys', (() => {
		const p = parseMatrixBotEnvText(
			'MORPHIT_MATRIX_BOT_ALERT_MXID=@first:s\nMORPHIT_MATRIX_BOT_ALERT_MXID=@second:s'
		);
		return p.mxidRaw === '@second:s';
	})());

	// ── 3. upsertEnvKey / clearEnvKey ─────────────────────────────
	const sampleEnv =
		'# comment line\nMORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n' +
		'MORPHIT_MATRIX_BOT_ACCESS_TOKEN=syt_secret_keep_me\n' +
		'MORPHIT_MATRIX_BOT_ALERT_MXID=@old:matrix.org\n';
	{
		const next = upsertEnvKey(sampleEnv, 'MORPHIT_MATRIX_BOT_ALERT_MXID', '@new:matrix.org');
		const p = parseMatrixBotEnvText(next);
		check('upsert replaces MXID in place', p.mxidRaw === '@new:matrix.org');
		check('upsert preserves the secret token', p.tokenRaw === 'syt_secret_keep_me');
		check('upsert preserves comments', next.includes('# comment line'));
		check('upsert does not duplicate the key', (next.match(/^MORPHIT_MATRIX_BOT_ALERT_MXID=/gm) ?? []).length === 1);
	}
	{
		const cleared = clearEnvKey(sampleEnv, 'MORPHIT_MATRIX_BOT_ALERT_MXID');
		const p = parseMatrixBotEnvText(cleared);
		check('clear empties the MXID', p.mxidRaw === '');
		check('clear preserves the token', p.tokenRaw === 'syt_secret_keep_me');
	}
	{
		const appended = upsertEnvKey(
			'MORPHIT_MATRIX_BOT_ACCESS_TOKEN=tok\n',
			'MORPHIT_MATRIX_BOT_ALERT_MXID',
			'@a:b'
		);
		const p = parseMatrixBotEnvText(appended);
		check('upsert appends when key absent', p.mxidRaw === '@a:b' && p.tokenRaw === 'tok');
		check('upsert output ends with exactly one newline', /[^\n]\n$/.test(appended));
	}

	// ── 4. systemctlArgv (sudo-awareness) ─────────────────────────
	const asRoot = systemctlArgv(true, 'enable', MATRIX_BOT_UNIT);
	check('root argv cmd = systemctl', asRoot.cmd === 'systemctl');
	check('root argv = enable morphit-matrix-bot.service', asRoot.args.join(' ') === `enable ${MATRIX_BOT_UNIT}`);
	const asUser = systemctlArgv(false, 'disable', '--now', MATRIX_BOT_UNIT);
	check('non-root argv cmd = sudo', asUser.cmd === 'sudo');
	check(
		'non-root argv = systemctl disable --now morphit-matrix-bot.service',
		asUser.args.join(' ') === `systemctl disable --now ${MATRIX_BOT_UNIT}`
	);

	// ── 5. syncMatrixBotService action mapping ────────────────────
	{
		const { exec, calls } = recordingExec(0);
		const res = syncMatrixBotService(true, { restart: true, exec, root: true });
		const verbs = calls.map((c) => c.args[0]);
		check('run+restart → action enable-restart', res.action === 'enable-restart' && res.ok);
		check('run+restart → daemon-reload + enable + restart', verbs.join(',') === 'daemon-reload,enable,restart');
	}
	{
		const { exec, calls } = recordingExec(0);
		const res = syncMatrixBotService(true, { restart: false, exec, root: true });
		const verbs = calls.map((c) => c.args[0]);
		check('run (no restart) → action enable-start', res.action === 'enable-start');
		check('run (no restart) → ends in start', verbs[verbs.length - 1] === 'start');
	}
	{
		const { exec, calls } = recordingExec(0);
		const res = syncMatrixBotService(false, { exec, root: true });
		check('!run → action disable-stop', res.action === 'disable-stop');
		check('!run → single disable --now call', calls.length === 1 && calls[0]!.args.join(' ') === `disable --now ${MATRIX_BOT_UNIT}`);
	}
	{
		const { exec } = recordingExec(1);
		const res = syncMatrixBotService(true, { restart: true, exec, root: true });
		check('non-zero systemctl → ok:false', res.ok === false);
	}

	// ── 6. runMatrix branches ─────────────────────────────────────
	/** Build injected deps with recording writeMxid + sync. */
	function deps(opts: {
		readEnv: MatrixBotEnv;
		state?: ServiceState;
		writeOk?: boolean;
		confirmYes?: boolean;
	}): {
		deps: MatrixDeps;
		writes: Array<string>;
		syncs: Array<{ run: boolean; restart: boolean }>;
	} {
		const writes: string[] = [];
		const syncs: Array<{ run: boolean; restart: boolean }> = [];
		return {
			writes,
			syncs,
			deps: {
				readEnv: () => opts.readEnv,
				readState: (_u) => opts.state ?? 'inactive',
				writeMxid: (v) => {
					writes.push(v);
					return opts.writeOk ?? true;
				},
				sync: (run, restart) => {
					syncs.push({ run, restart });
					return { action: run ? 'enable-restart' : 'disable-stop', ok: true };
				},
				confirm: async () => opts.confirmYes ?? true
			}
		};
	}

	// (a) set valid mxid, env exists, token present → write + sync(run)
	{
		const d = deps({ readEnv: env('@agorise:matrix.org', 'syt_realtoken') });
		const rc = await quiet(() => runMatrix(CTX(['set', '@agorise:matrix.org']), d.deps));
		check('set valid → exit 0', rc === 0);
		check('set valid → wrote the mxid', d.writes.length === 1 && d.writes[0] === '@agorise:matrix.org');
		check('set valid → sync(run=true,restart=true)', d.syncs.length === 1 && d.syncs[0]!.run === true && d.syncs[0]!.restart === true);
	}
	// (b) set #room → reject, NO write, NO sync
	{
		const d = deps({ readEnv: env('', 'syt_tok') });
		const rc = await quiet(() => runMatrix(CTX(['set', '#pub:matrix.org']), d.deps));
		check('set #room → exit 1', rc === 1);
		check('set #room → NO write', d.writes.length === 0);
		check('set #room → NO sync', d.syncs.length === 0);
	}
	// (c) set junk → reject, no write
	{
		const d = deps({ readEnv: env('', 'syt_tok') });
		const rc = await quiet(() => runMatrix(CTX(['set', 'garbage']), d.deps));
		check('set junk → exit 1', rc === 1);
		check('set junk → NO write', d.writes.length === 0);
	}
	// (d) set valid but NO env file → exit 2, no write
	{
		const d = deps({ readEnv: env('', '', false) });
		const rc = await quiet(() => runMatrix(CTX(['set', '@a:matrix.org']), d.deps));
		check('set with no env file → exit 2', rc === 2);
		check('set with no env file → NO write', d.writes.length === 0);
	}
	// (e) set valid but NO token → write + sync(false) (stop, no crash-loop)
	{
		const d = deps({ readEnv: env('@agorise:matrix.org', '') });
		const rc = await quiet(() => runMatrix(CTX(['set', '@agorise:matrix.org']), d.deps));
		check('set valid+no-token → exit 0', rc === 0);
		check('set valid+no-token → still wrote the mxid', d.writes.length === 1);
		check('set valid+no-token → sync(run=false) (kept stopped)', d.syncs.length === 1 && d.syncs[0]!.run === false);
	}
	// (f) clear → write empty + sync(false)
	{
		const d = deps({ readEnv: env('@old:matrix.org', 'syt_tok') });
		const rc = await quiet(() => runMatrix(CTX(['clear']), d.deps));
		check('clear → exit 0', rc === 0);
		check('clear → wrote empty', d.writes.length === 1 && d.writes[0] === '');
		check('clear → sync(run=false)', d.syncs.length === 1 && d.syncs[0]!.run === false);
	}
	// (g) status ready + stopped + confirm yes → sync(run)
	{
		const d = deps({ readEnv: env('@a:matrix.org', 'syt_tok'), state: 'inactive', confirmYes: true });
		const rc = await quiet(() => runMatrix(CTX([]), d.deps));
		check('status ready+stopped+yes → exit 0', rc === 0);
		check('status ready+stopped+yes → sync(run=true)', d.syncs.length === 1 && d.syncs[0]!.run === true);
	}
	// (h) status no-mxid + stopped → no offer, no sync
	{
		const d = deps({ readEnv: env('', ''), state: 'inactive' });
		const rc = await quiet(() => runMatrix(CTX([]), d.deps));
		check('status no-mxid → exit 0', rc === 0);
		check('status no-mxid → NO sync', d.syncs.length === 0);
	}
	// (i) status not-installed → no sync
	{
		const d = deps({ readEnv: env('@a:matrix.org', 'syt_tok'), state: 'not-installed' });
		const rc = await quiet(() => runMatrix(CTX([]), d.deps));
		check('status not-installed → exit 0', rc === 0);
		check('status not-installed → NO sync', d.syncs.length === 0);
	}
	// (j) status running but not-ready → offer stop
	{
		const d = deps({ readEnv: env('@a:matrix.org', ''), state: 'active', confirmYes: true });
		const rc = await quiet(() => runMatrix(CTX([]), d.deps));
		check('status running+not-ready+yes → exit 0', rc === 0);
		check('status running+not-ready+yes → sync(run=false)', d.syncs.length === 1 && d.syncs[0]!.run === false);
	}

	// ── 7. Wiring (static) ────────────────────────────────────────
	const mainSrc = readFileSync(join(opsCliRoot, 'src', 'main.ts'), 'utf8');
	check("main.ts imports runMatrix from './commands/matrix.ts'", /from '\.\/commands\/matrix\.ts'/.test(mainSrc));
	check(
		'main.ts dispatches the matrix subcommand',
		/args\.subcommand === 'matrix'/.test(mainSrc) && /runMatrix\(/.test(mainSrc)
	);
	const upgradeSrc = readFileSync(join(opsCliRoot, 'src', 'commands', 'upgrade.ts'), 'utf8');
	check('upgrade.ts calls syncMatrixBotService (re-checks on upgrade)', /syncMatrixBotService\(/.test(upgradeSrc));
	check('upgrade.ts no longer unconditionally restarts the matrix-bot', !/'morphit-matrix-bot\.service'/.test(upgradeSrc));
	const matrixItems = MENU_GROUPS.flatMap((g) => g.items).filter((i) => i.subcommand === 'matrix');
	check('MENU_GROUPS exposes exactly one matrix item', matrixItems.length === 1);

	// ── Result ────────────────────────────────────────────────────
	if (failures.length > 0) {
		console.error(`matrix-bot-lifecycle-smoke: ${failures.length} FAILED of ${checks}:`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		process.exit(1);
	}
	console.log(`✓ all ${checks} matrix-bot-lifecycle-smoke scenarios passed`);
}

main().catch((err) => {
	console.error('matrix-bot-lifecycle-smoke: threw:', err);
	process.exit(1);
});
