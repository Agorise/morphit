/**
 * release-monitor-exec-smoke (v1.18.0 review, O10).
 *
 * The release monitor is how an operator learns a new Morphit release is out.
 * The review found it had never been able to say so, three ways at once:
 *
 *   1. its unit set MemoryDenyWriteExecute=true, and Node's JIT cannot run
 *      under W^X — node aborts the first time it compiles anything;
 *   2. it ran `npx tsx` from systemd's default working directory, `/`, where
 *      npx cannot see the install's node_modules and goes to the npm registry
 *      for tsx instead — never reachable from a tor-only box, so the check
 *      hit its 30-second limit every time;
 *   3. even with both fixed, the version fields in the alert came out empty:
 *      the ops-cli pretty-prints its JSON (`"current": "v1.17.15"`) and the
 *      extraction demanded no space after the colon.
 *
 * This EXECUTES the real monitor script against a fake install whose tsx
 * records how it was called, and reads every systemd unit for a Node-running
 * service with W^X switched on.
 *
 * To watch it fail on the old script:
 *   MORPHIT_RELEASE_MONITOR_SCRIPT=<old>/ops/scripts/morphit-release-monitor.sh \
 *   MORPHIT_SYSTEMD_UNIT_DIR=<old>/ops/systemd  npx tsx scripts/release-monitor-exec-smoke.ts
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT =
	process.env.MORPHIT_RELEASE_MONITOR_SCRIPT ??
	join(REPO, 'ops/scripts/morphit-release-monitor.sh');
const UNIT_DIR = process.env.MORPHIT_SYSTEMD_UNIT_DIR ?? join(REPO, 'ops/systemd');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const work = mkdtempSync(join(tmpdir(), 'morphit-release-monitor-'));
try {
	// ── A fake install: the ops-cli entry point and the install's own tsx ──
	const root = join(work, 'opt-morphit');
	const cliDir = join(root, 'apps/ops-cli/src');
	mkdirSync(cliDir, { recursive: true });
	mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
	writeFileSync(join(cliDir, 'main.ts'), '// stand-in\n');
	const calls = join(work, 'tsx-calls.log');
	const tsx = join(root, 'node_modules/.bin/tsx');
	// Answers exactly what `morphit-ops upgrade --check-only --json` prints:
	// pretty JSON, exit 1 for "a newer release exists".
	writeFileSync(
		tsx,
		`#!/bin/sh
printf 'cwd=%s args=%s\\n' "$(pwd)" "$*" >> "${calls}"
cat <<'JSON'
{
  "current": "v1.17.15",
  "latest": "v1.18.0",
  "up_to_date": false,
  "release_url": "https://git.agorise.net/agorise/morphit/releases/tag/v1.18.0",
  "published_at": "2026-09-24T00:00:00Z"
}
JSON
exit "\${FAKE_TSX_EXIT:-1}"
`
	);
	chmodSync(tsx, 0o755);

	// A PATH with node, and an npx that only records being called — the old
	// script's npx would otherwise go to the registry.
	const bin = join(work, 'bin');
	mkdirSync(bin);
	const npxLog = join(work, 'npx-calls.log');
	writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "npx $*" >> "${npxLog}"\nexit 124\n`);
	chmodSync(join(bin, 'npx'), 0o755);
	writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 0\n');
	chmodSync(join(bin, 'node'), 0o755);

	const run = (extra: Record<string, string> = {}): string => {
		const state = mkdtempSync(join(work, 'emit-'));
		const r = spawnSync('sh', [SCRIPT], {
			cwd: '/', // systemd's default working directory for a system unit
			encoding: 'utf8',
			timeout: 20_000,
			env: {
				PATH: `${bin}:/usr/bin:/bin`,
				HOME: work,
				JOURNAL_STREAM: '1:1', // emit to stdout, as under the real unit
				MORPHIT_EMIT_STATE_DIR: state,
				MORPHIT_OPS_CLI_PATH: join(cliDir, 'main.ts'),
				...extra
			}
		});
		return `${r.stdout ?? ''}${r.stderr ?? ''}`;
	};

	// ── 1. a newer release: the alert, with both versions in it ──
	const out = run();
	const line = out.split('\n').find((l) => l.includes('"event":"release_available"')) ?? '';
	let ctx: Record<string, unknown> = {};
	try {
		ctx = (JSON.parse(line) as { context: Record<string, unknown> }).context;
	} catch {
		/* no event — reported below */
	}
	check('a newer release raises release_available', line !== '', out.trim().split('\n').pop());
	check(
		'the alert names the installed and the new version',
		ctx.current === 'v1.17.15' && ctx.latest === 'v1.18.0',
		`current=${JSON.stringify(ctx.current)} latest=${JSON.stringify(ctx.latest)}`
	);
	const tsxCalls = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
	check(
		"the check runs the install's own tsx, never npx (no registry lookup)",
		tsxCalls !== '' && !existsSync(npxLog),
		existsSync(npxLog) ? readFileSync(npxLog, 'utf8').trim() : 'tsx was not called'
	);
	check(
		"it runs from the ops-cli's own directory, not systemd's `/`",
		tsxCalls.startsWith(`cwd=${join(root, 'apps/ops-cli')} `),
		tsxCalls.trim()
	);

	// ── 2. up to date: silent by default ──
	const quiet = run({ FAKE_TSX_EXIT: '0' });
	check('up to date emits nothing by default', !quiet.includes('"event"'), quiet.trim());

	// ── 3. no tsx in the install: a clear hint, no registry lookup ──
	rmSync(tsx);
	rmSync(npxLog, { force: true });
	const missing = run();
	check(
		'a missing tsx is reported as a failed check with a repair hint, and npx is not tried',
		missing.includes('"event":"release_check_failed"') &&
			missing.includes('tsx not at') &&
			!existsSync(npxLog),
		missing.trim()
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}

// ── 4. no Node-running unit switches W^X on ──
/** A shell line that RUNS node / npx / tsx (or the script's "$TSX") as a
 *  command — at the start of a line, after a separator, `then`/`do`, `exec`,
 *  `timeout N` or `$(` — as opposed to a script that merely mentions the word
 *  (the dmesg monitor greps kernel lines for "node"). */
const INVOKES_NODE =
	/^[ \t]*(?:[^#\n]*?(?:[;&|(]|\bthen\b|\bdo\b|\bexec\b|\btimeout\s+\d+))?\s*(?:"?\$\{?TSX\}?"?|node|npx|tsx)\s/m;
const runsNode = (unitText: string): boolean => {
	const execs = [...unitText.matchAll(/^ExecStart=(.*)$/gm)].map((m) => m[1] ?? '');
	for (const e of execs) {
		if (/\b(node|tsx|npx)\b/.test(e)) return true;
		const script = e.trim().split(/\s+/)[0] ?? '';
		const local = script.startsWith('/opt/morphit/')
			? join(REPO, script.slice('/opt/morphit/'.length))
			: '';
		if (local !== '' && existsSync(local) && INVOKES_NODE.test(readFileSync(local, 'utf8')))
			return true;
	}
	return false;
};
const offenders = readdirSync(UNIT_DIR)
	.filter((f) => f.endsWith('.service'))
	.filter((f) => {
		const text = readFileSync(join(UNIT_DIR, f), 'utf8');
		return runsNode(text) && /^MemoryDenyWriteExecute=(true|yes|1|on)\s*$/m.test(text);
	});
check(
	'no unit that runs Node sets MemoryDenyWriteExecute (the JIT aborts under it)',
	offenders.length === 0,
	offenders.join(', ')
);
check(
	'the release monitor is recognised as a Node-running unit (the check above is not vacuous)',
	runsNode(readFileSync(join(UNIT_DIR, 'morphit-release-monitor.service'), 'utf8'))
);

console.log(
	fail === 0
		? `\n✓ all ${pass} release-monitor-exec checks passed`
		: `\n✗ release-monitor-exec: ${pass} passed, ${fail} failed`
);
process.exit(fail === 0 ? 0 : 1);
