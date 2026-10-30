/**
 * `morphit-ops doctor`
 *
 * A READ-ONLY preflight: tells the operator, in plain English,
 * whether the indexer and relay will start with the config that is
 * currently on disk — BEFORE they run `npm start` and watch it crash.
 *
 * It exists because the first real operator hit four consecutive
 * boot failures (operator-allowlist, an ESM/require bug, and two
 * missing required indexer vars), each surfaced only by starting the
 * service and reading a stack trace. doctor turns that loop into a
 * single self-service check.
 *
 * SAFETY (this is the whole point of the command):
 *   - It MUTATES NOTHING. No files written, no services started, and the
 *     database is only ever READ. The ONLY network calls are READ-ONLY,
 *     side-effect-free RPC probes (condenser_api.get_dynamic_global_properties)
 *     to check whether the configured Blurt endpoints are reachable —
 *     each with a hard timeout. Worst case for a probe is that it times
 *     out and doctor reports the endpoint as unreachable. Pass
 *     `--no-rpc` to skip the probes for a purely-local check.
 *   - It also runs the indexer's `--check-schema` (a single READ-ONLY
 *     SELECT against information_schema) to flag a database whose schema
 *     predates an in-place schema.sql change shipped in this version —
 *     the pre-launch upgrade hazard. This reads the DB but never writes
 *     it, and is advisory (it does not change the exit code). Pass
 *     `--no-db` to skip it.
 *   - It validates by running each service's REAL config loader via
 *     `--check-config`, which loads config and exits. That means the
 *     checks can never drift from what the services actually require
 *     (a hand-maintained list would — and that drift is exactly what
 *     caused two of the four bugs). Each check gets exactly the env files
 *     the service's systemd unit sources, in the unit's order and the
 *     unit's way (serviceEnvFiles), and none of the caller's MORPHIT_*
 *     settings.
 *   - The relay's `--check-config` runs BEFORE its passphrase prompt,
 *     so doctor never hangs waiting for input, even with an encrypted
 *     key. (It reports whether the key is encrypted instead.)
 *   - Worst case for a doctor bug is a wrong message, never a broken
 *     box — unlike service-install/start, which is why THAT stays a
 *     VM-validated checkpoint and is deliberately not done here.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { runAsync } from '../lib/spinRun.ts';
import { startDotsSpinner } from '../init/spinner.ts';
import {
	probeRpcEndpoints,
	formatRpcProbeLines,
	type RpcProbeSummary
} from '../init/chainCheck.ts';
import { INDEXER_ENV_FILES, RELAY_ENV_FILES, readEffectiveEnv } from '../lib/relayHiddenHeal.ts';
import {
	DEFAULT_BLURT_RPC_ENDPOINTS,
	DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS
} from '@morphit/operator-config';

export interface DoctorCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** Where doctor looks. Both default to the real machine; tests point them at
 *  a temporary tree. */
export interface DoctorDeps {
	/** The install (repo) root. Default: {@link defaultRepoRoot} — the
	 *  installed launcher runs the CLI from /opt/morphit/apps/ops-cli, so the
	 *  working directory is never the install root. */
	readonly installDir?: string;
	/** Prefix for every system path (/etc/morphit, /etc/systemd, /etc/group). */
	readonly root?: string;
	/** This process runs as root (default: its real uid is 0). */
	readonly isRoot?: () => boolean;
}

interface ServiceResult {
	readonly name: 'indexer' | 'relay';
	readonly ok: boolean;
	/** stdout+stderr from the --check-config run, trimmed. */
	readonly detail: string;
	/** The check stopped at its time limit. */
	readonly timedOut?: boolean;
	/** The service's own user cannot reach the file named in `detail`: this
	 *  folder on its way is closed to it. */
	readonly closedDir?: string;
}

/** The install path every unit names; an install elsewhere maps onto it. */
const UNIT_INSTALL_DIR = '/opt/morphit/';

/**
 * The env files a service's systemd unit sources, in the unit's order (last
 * assignment wins), for an install at `installDir`. The lists are the ones
 * pinned to ops/systemd/morphit-{indexer,relay}.service by
 * test/serviceEnvFileLists.test.ts. On an Ansible node the services' settings
 * live mostly in /etc/morphit/indexer.env and relay.env, so a check that read
 * only morphit.env reported a healthy node as "will NOT start".
 */
export function serviceEnvFiles(svc: 'indexer' | 'relay', installDir: string, root = ''): string[] {
	const unit = svc === 'indexer' ? INDEXER_ENV_FILES : RELAY_ENV_FILES;
	return unit.map((f) =>
		f.startsWith(UNIT_INSTALL_DIR)
			? join(installDir, f.slice(UNIT_INSTALL_DIR.length))
			: `${root}${f}`
	);
}

/** The environment a service starts with: this process's, without any
 *  MORPHIT_* setting (the unit starts with none, so a value only in the
 *  operator's shell — or exported by the launcher — must not make a check pass
 *  that the real start would fail). */
function serviceBaseEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!k.startsWith('MORPHIT_')) env[k] = v;
	}
	return env;
}

/** The unit's own way of reading its env files: each one that exists is
 *  sourced in order; one that exists but cannot be read stops the start
 *  (exit 78). */
function sourceFilesScript(files: readonly string[]): string {
	return (
		`set -a; for f in ${files.map(shq).join(' ')}; do if [ -e "$f" ]; then ` +
		`[ -r "$f" ] || { echo "cannot read $f" >&2; exit 78; }; . "$f"; fi; done; set +a; `
	);
}

/** Run one service's `--check-config` (or the indexer's `--check-schema`)
 *  with exactly the files its unit sources, sourced the way the unit does,
 *  from the service's own folder. Returns ok + the combined output. Never
 *  throws. */
async function checkService(
	name: 'indexer' | 'relay',
	installDir: string,
	files: readonly string[],
	configEnvPath: string | null,
	checkFlag: '--check-config' | '--check-schema' = '--check-config',
	/** The unit's User= (and the system-path prefix), when this server runs
	 *  the services under systemd and this process is root; null skips the
	 *  service-user readability check. */
	serviceUser: { readonly user: string; readonly root: string } | null = null
): Promise<ServiceResult> {
	const appDir = join(installDir, 'apps', name);
	if (!existsSync(appDir)) {
		return {
			name,
			ok: false,
			detail: `apps/${name} was not found under ${installDir}, so this install is incomplete.`
		};
	}
	// The unit sources its files as the SERVICE's user, not as root: a file
	// that user cannot read stops the start ("cannot read …", exit 78). Run as
	// root, the check below always passed (review, 2026-10-29).
	if (serviceUser !== null) {
		const blocked = unreadableByServiceUser(serviceUser.user, files, serviceUser.root);
		if (blocked !== null) {
			return {
				name,
				ok: false,
				detail: `cannot read ${blocked.file}`,
				...(blocked.dir !== undefined ? { closedDir: blocked.dir } : {})
			};
		}
	}
	const childEnv = serviceBaseEnv();
	if (configEnvPath) childEnv.MORPHIT_OPERATOR_CONFIG_FILE = configEnvPath;
	const script = `${sourceFilesScript(files)}cd ${shq(appDir)} && npm start -- ${checkFlag}`;
	// Asynchronous, so the caller's spinner keeps turning for the up-to-20 s run.
	const r = await runAsync('bash', ['-c', script], { env: childEnv, timeoutMs: 20_000 });
	const combined = r.output.trim();
	if (r.error !== null && /ENOENT/.test(r.error)) {
		return {
			name,
			ok: false,
			detail: 'could not run the check: bash was not found on this server.'
		};
	}
	if (r.status === 0) {
		return { name, ok: true, detail: combined };
	}
	if (r.timedOut) {
		return {
			name,
			ok: false,
			timedOut: true,
			detail: 'the check did not finish within 20 seconds, so it was stopped.'
		};
	}
	return { name, ok: false, detail: combined };
}

/** Single-quote a string for safe use in a bash command. */
function shq(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The user a service's installed unit runs as (its `User=`), else the one
 *  ops/systemd/morphit-<svc>.service ships with. */
export function unitUser(svc: 'indexer' | 'relay', root = ''): string {
	for (const d of ['/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system']) {
		try {
			const text = readFileSync(`${root}${d}/morphit-${svc}.service`, 'utf8');
			const m = /^\s*User\s*=\s*(\S+)\s*$/m.exec(text);
			if (m) return m[1]!;
			break;
		} catch {
			/* not installed there */
		}
	}
	return `morphit-${svc}`;
}

/** The pre-start helper (ops/scripts/morphit-service-perms.sh) gives the env
 *  files the service's group at every start — but only a regular file root
 *  owns, in a folder root owns that nobody else may write. Such a file, not
 *  readable now, is readable once the service starts. PURE given the files. */
function helperWillFix(file: string, root: string): boolean {
	if (!existsSync(`${root}/usr/local/lib/morphit/morphit-service-perms.sh`)) return false;
	try {
		const f = lstatSync(file);
		if (!f.isFile() || f.uid !== 0) return false;
		const d = lstatSync(dirname(file));
		return !d.isSymbolicLink() && d.uid === 0 && (d.mode & 0o022) === 0;
	} catch {
		return false;
	}
}

/**
 * The first of `files` (those that exist) the service's own user cannot read,
 * and the folder on its way that is closed to it, if that is why; null when it
 * can read them all, or when that cannot be tried here (not root, no runuser,
 * no such user). Tried AS that user (`runuser -u <user>`), because the unit
 * reads them as that user, not as root.
 */
function unreadableByServiceUser(
	user: string,
	files: readonly string[],
	root = ''
): { file: string; dir?: string } | null {
	if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(user)) return null;
	if (spawnSync('id', ['-u', user], { stdio: 'ignore' }).status !== 0) return null;
	const present = files.filter((f) => existsSync(f));
	if (present.length === 0) return null;
	const script = [
		'for f in "$@"; do',
		'  p=""; bad=""; rest="${f#/}"',
		'  IFS=/; set -f',
		'  for c in $rest; do p="$p/$c"; [ "$p" = "$f" ] && break; [ -x "$p" ] || { bad="$p"; break; }; done',
		'  unset IFS; set +f',
		'  if [ -n "$bad" ]; then printf "dir\\t%s\\t%s\\n" "$f" "$bad"; elif [ ! -r "$f" ]; then printf "file\\t%s\\n" "$f"; fi',
		'done'
	].join('\n');
	const r = spawnSync('runuser', ['-u', user, '--', 'sh', '-c', script, 'sh', ...present], {
		encoding: 'utf8',
		timeout: 10_000
	});
	if (r.error || r.status !== 0) return null;
	for (const line of (r.stdout ?? '').split('\n')) {
		const [kind, file, dir] = line.split('\t');
		if (kind === 'dir' && file !== undefined && dir !== undefined) return { file, dir };
		if (kind === 'file' && file !== undefined && !helperWillFix(file, root)) return { file };
	}
	return null;
}

/** Pull the most useful lines out of a failed --check-config run:
 *  the "config validation failed" block and the bullet lines, or the
 *  operator-allowlist line, or the first Error line. Keeps doctor's
 *  output focused instead of dumping a stack trace. */
function summarizeFailure(detail: string): string[] {
	const lines = detail.split('\n').map((l) => l.trimEnd());
	const picked: string[] = [];
	for (const l of lines) {
		const t = l.trim();
		if (t === '') continue;
		if (
			/config validation failed/i.test(t) ||
			/operator allowlist/i.test(t) ||
			/^cannot read /.test(t) ||
			/^-\s/.test(t) ||
			/Required$/.test(t) ||
			/must (be|start|contain|list)/i.test(t) ||
			/is empty$/.test(t) ||
			/^Error:/.test(t)
		) {
			picked.push(t);
		}
		// Stop once we have the validation block + a few bullets; we
		// don't want the JS stack frames.
		if (picked.length >= 12 || /at <anonymous>|ModuleJob|node:internal/.test(t)) break;
	}
	if (picked.length === 0) {
		// Fall back to the first non-empty line so we never show nothing.
		const first = lines.find((l) => l.trim() !== '');
		if (first) picked.push(first.trim());
	}
	return picked;
}

/** What the indexer's `--check-schema` run found. */
export type SchemaVerdict =
	| { readonly kind: 'matches' }
	| { readonly kind: 'unreachable' }
	| { readonly kind: 'drift'; readonly lines: readonly string[] }
	/** The check itself did not run to a verdict (the indexer's settings did
	 *  not load, it timed out, …) — this says nothing about the schema. */
	| { readonly kind: 'not-run'; readonly lines: readonly string[] };

/** Judge a `--check-schema` run. Only the indexer's own DRIFT line means
 *  drift; any other failure means the check could not run. PURE. */
export function judgeSchemaCheck(r: {
	readonly ok: boolean;
	readonly detail: string;
}): SchemaVerdict {
	const tagged = r.detail
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.includes('[check-schema]'))
		.map((l) => l.replace('[check-schema]', '').trim());
	if (tagged.some((l) => /^DRIFT\b/.test(l))) return { kind: 'drift', lines: tagged };
	if (r.ok) {
		if (tagged.some((l) => /could not reach/i.test(l))) return { kind: 'unreachable' };
		// Only its own "matches" line means it matched: a run that ended well
		// without saying so (another program, an old build) is not a verdict
		// (review, 2026-10-29).
		if (tagged.some((l) => /matches this version/i.test(l))) return { kind: 'matches' };
		return {
			kind: 'not-run',
			lines: ['the check ended without saying whether the schema matches.']
		};
	}
	return { kind: 'not-run', lines: summarizeFailure(r.detail) };
}

/** True when the services run under systemd on this server (their units are
 *  installed), as on every Ansible / `morphit-ops install` node. */
function systemdUnitsInstalled(root: string): boolean {
	return ['/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'].some((d) =>
		existsSync(`${root}${d}/morphit-indexer.service`)
	);
}

/** The setting names a failed config check reported as missing. */
function missingSettings(detail: string): string[] {
	return Array.from(
		new Set(Array.from(detail.matchAll(/\b(MORPHIT_[A-Z0-9_]+):\s*Required\b/g), (m) => m[1]!))
	);
}

/**
 * What to do about each service that will not start — from what it actually
 * said, never a fixed list. `envFileFor(svc)` names the file its settings
 * belong in on this server. PURE.
 */
export function fixesForFailures(
	results: readonly ServiceResult[],
	o: {
		readonly envFileFor: (svc: 'indexer' | 'relay') => string;
		readonly configEnvPath: string;
		readonly systemd: boolean;
		readonly installDir: string;
		/** Prefix for system paths (tests). */
		readonly root?: string;
	}
): string[] {
	const out: string[] = [];
	const logCmd = (svc: string): string =>
		o.systemd
			? `sudo journalctl -u morphit-${svc} -n 50`
			: `cd ${join(o.installDir, 'apps', svc)} && npm start`;
	for (const r of results) {
		if (r.ok) continue;
		const missing = missingSettings(r.detail);
		if (/operator allowlist/i.test(r.detail)) {
			out.push(
				`• ${r.name}: ${o.configEnvPath} holds a setting that does not belong there`,
				`  (named above). Move that line to ${o.envFileFor(r.name)}.`
			);
		} else if (missing.length > 0) {
			out.push(
				`• ${r.name}: add ${missing.length === 1 ? 'this setting' : 'these settings'} to ${o.envFileFor(r.name)}:`,
				...missing.map((k) => `      ${k}=…`),
				`  (${join(o.installDir, 'ops', 'env', `${r.name}.env.example`)} shows each one with an`,
				'  example value.)'
			);
		} else if (/^cannot read /m.test(r.detail)) {
			const file = /^cannot read (.+)$/m.exec(r.detail)?.[1] ?? 'the file named above';
			if (r.closedDir !== undefined) {
				out.push(
					`• ${r.name}: it cannot reach ${file}: the folder ${r.closedDir} is closed to it.`,
					'  On this server:',
					`      sudo chown root:${SERVICE_GROUP} ${r.closedDir} && sudo chmod 0750 ${r.closedDir}`
				);
			} else {
				// The group each file is read through (ops/scripts/morphit-service-perms.sh):
				// relay-notify.env is the relay's alone.
				const group = envFileGroup(file, o.root ?? '');
				out.push(
					`• ${r.name}: ${file} exists but its service cannot read it. On this server:`,
					`      sudo chown root:${group} ${file} && sudo chmod 0640 ${file}`
				);
			}
		} else if (/was not found under/.test(r.detail)) {
			out.push(
				`• ${r.name}: its program folder is missing. Install Morphit on this server:`,
				'      sudo morphit-ops   (then choose "Install / set up a new node")'
			);
		} else if (r.timedOut === true) {
			out.push(
				`• ${r.name}: the check did not finish in time. Run this check again; if it stops`,
				`  again, see what the ${r.name} says when it starts. On this server:`,
				`      ${logCmd(r.name)}`
			);
		} else {
			out.push(
				`• ${r.name}: the lines under it above are what it said. Its full start-up messages,`,
				'  on this server:',
				`      ${logCmd(r.name)}`
			);
		}
	}
	return out;
}

export async function runDoctor(ctx: DoctorCtx, deps: DoctorDeps = {}): Promise<number> {
	const c = makeColor(ctx.colorEnabled);
	const installDir = deps.installDir ?? defaultRepoRoot();
	const root = deps.root ?? '';
	const json = ctx.flags.json === 'true';
	const isRoot =
		deps.isRoot ?? ((): boolean => typeof process.getuid !== 'function' || process.getuid() === 0);
	const systemd = systemdUnitsInstalled(root);
	// On a node whose services run under systemd, their settings are in
	// root-only files: without root, every one of them was silently skipped and
	// the advice that followed was wrong (review, 2026-10-29).
	if (systemd && !isRoot()) {
		const msg = 'This check needs administrator rights on this server: sudo morphit-ops doctor';
		if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
		else console.log(`\n  ${msg}\n`);
		return 1;
	}
	// Every slow check runs under the braille spinner; under --json it goes to
	// stderr so stdout carries only the JSON document.
	const spun = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
		const stop = startDotsSpinner(label, json ? process.stderr : process.stdout);
		try {
			return await fn();
		} finally {
			stop();
		}
	};

	if (!json) {
		console.log('');
		console.log('━'.repeat(60));
		console.log('  Morphit — doctor (read-only config check)');
		console.log('━'.repeat(60));
		console.log('');
		console.log('  Checks whether your indexer and relay will start with');
		console.log('  the config currently on disk. This changes nothing — it');
		console.log('  only reads and reports.');
		console.log('');
		console.log(`  Install directory: ${installDir}`);
		console.log('');
	}

	// ─── Locate the config files ────────────────────────────────
	const envPath = join(installDir, 'morphit.env');
	const configEnvPath = join(installDir, 'morphit.config.env');
	const indexerFiles = serviceEnvFiles('indexer', installDir, root);
	const relayFiles = serviceEnvFiles('relay', installDir, root);

	if (!existsSync(join(installDir, 'apps', 'indexer'))) {
		const msg =
			`Morphit's program files were not found at ${installDir} (there is no apps/indexer). ` +
			'Install Morphit on this server first: sudo morphit-ops, then choose "Install / set up a new node".';
		if (json) {
			console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
		} else {
			console.log(`  ${c.red('✗')} ${msg}`);
			console.log('');
		}
		return 2;
	}

	// ─── Run the two service config checks ──────────────────────
	// Each check sources exactly the files the service's unit sources, in the
	// unit's order, so doctor's environment matches a real start.
	const cfgPath = existsSync(configEnvPath) ? configEnvPath : null;
	// Under systemd each service reads its files as its own user (the unit's
	// User=); that is tried as that user.
	const asUnitUser = (svc: 'indexer' | 'relay'): { user: string; root: string } | null =>
		systemd && isRoot() ? { user: unitUser(svc, root), root } : null;
	const results: ServiceResult[] = [];
	for (const svc of ['indexer', 'relay'] as const) {
		results.push(
			await spun(`Checking the ${svc}'s config (up to 20 s)…`, () =>
				checkService(
					svc,
					installDir,
					svc === 'indexer' ? indexerFiles : relayFiles,
					cfgPath,
					'--check-config',
					asUnitUser(svc)
				)
			)
		);
	}

	const allOk = results.every((r) => r.ok);

	// Security audit (read-only, advisory — does not change the exit
	// code, which reflects boot-readiness).
	const security = await securityAudit(relayFiles, indexerFiles, root);

	// RPC reachability (read-only probes, advisory). Skipped with
	// --no-rpc for a purely-local check. Catches the all-endpoints-dead
	// case that froze a real node's sync before it ever stalls.
	const skipRpc = ctx.flags['no-rpc'] === 'true';

	// Can a peer actually hand us a batch? Advisory like the rest of the audit,
	// and grouped with --no-rpc because it is the one check in that block which
	// leaves the machine. See checkFederationBodyCap for why it must go through
	// the public origin rather than loopback.
	if (!skipRpc)
		security.push(
			await spun('Checking a peer can send this node a chat batch…', () =>
				checkFederationBodyCap(indexerFiles)
			)
		);
	const rpcPlan = skipRpc ? null : configuredEndpoints(indexerFiles, relayFiles);
	const rpc =
		rpcPlan === null || rpcPlan.unknown || rpcPlan.hiddenOnly || rpcPlan.clearnet.length === 0
			? null
			: await spun('Checking the Blurt RPC endpoints answer…', () =>
					probeRpcEndpoints(rpcPlan.clearnet)
				);

	// Database schema drift (read-only, advisory). Skipped with --no-db.
	// Delegates to the indexer's own `--check-schema` (so the expectation
	// can't drift from the code) — catches the pre-launch case where an
	// existing DB didn't pick up an in-place schema.sql change shipped in a
	// newer version. Advisory: never changes the boot-readiness exit code.
	const skipDb = ctx.flags['no-db'] === 'true';
	const schemaRun = skipDb
		? null
		: await spun('Checking the database schema (up to 20 s)…', () =>
				checkService(
					'indexer',
					installDir,
					indexerFiles,
					cfgPath,
					'--check-schema',
					asUnitUser('indexer')
				)
			);
	const schema = schemaRun === null ? null : judgeSchemaCheck(schemaRun);

	if (json) {
		console.log(
			JSON.stringify(
				{
					ok: allOk,
					install_dir: installDir,
					services: results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail })),
					security: security.map((s) => ({ level: s.level, label: s.label, detail: s.detail })),
					rpc:
						rpcPlan === null
							? { checked: false }
							: {
									checked: rpc !== null,
									settings_read: !rpcPlan.unknown,
									hidden_only: rpcPlan.hiddenOnly,
									hidden_total: rpcPlan.hidden.length,
									healthy: rpc?.healthy ?? null,
									total: rpc?.total ?? 0,
									head_block: rpc?.headBlock ?? null,
									endpoints: (rpc?.results ?? []).map((r) => ({
										url: r.url,
										ok: r.ok,
										latency_ms: r.latencyMs,
										head_block: r.headBlock,
										error: r.error
									}))
								},
					schema:
						schema === null
							? { checked: false }
							: {
									checked: true,
									ran: schema.kind !== 'not-run',
									drift: schema.kind === 'drift',
									db_reachable: schema.kind === 'not-run' ? null : schema.kind !== 'unreachable',
									detail:
										schema.kind === 'drift' || schema.kind === 'not-run'
											? schema.lines.join(' ')
											: ''
								}
				},
				null,
				2
			)
		);
		return allOk ? 0 : 1;
	}

	// ─── Human report ───────────────────────────────────────────
	console.log('');
	console.log('━'.repeat(60));
	for (const r of results) {
		if (r.ok) {
			// The service prints a one-line OK (and, for the relay, the
			// key type). Echo that line so the operator sees the detail.
			const note = r.detail
				.split('\n')
				.map((l) => l.trim())
				.find((l) => l.includes('[check-config]'));
			console.log(`  ${c.green('✓')} ${r.name}: will start`);
			if (note) console.log(`      ${c.dim(note.replace('[check-config]', '').trim())}`);
		} else {
			console.log(`  ${c.red('✗')} ${r.name}: will NOT start`);
			for (const line of summarizeFailure(r.detail)) {
				console.log(`      ${line}`);
			}
		}
	}
	console.log('━'.repeat(60));
	console.log('');

	// ─── Security audit (advisory) ──────────────────────────────
	const warns = security.filter((s) => s.level === 'warn');
	console.log(
		`  Security ${warns.length === 0 ? c.green('(all clear)') : c.yellow(`(${warns.length} to review)`)}`
	);
	for (const s of security) {
		if (s.level === 'ok') {
			console.log(`    ${c.green('✓')} ${s.label}: ${c.dim(s.detail)}`);
		} else {
			console.log(`    ${c.yellow('⚠')} ${s.label}: ${s.detail}`);
		}
	}
	console.log('');
	console.log('━'.repeat(60));
	console.log('');

	// ─── RPC reachability (advisory) ────────────────────────────
	const hiddenNote = (n: number): string =>
		`${n} hidden (Tor/I2P) RPC node${n === 1 ? '' : 's'} not contacted from here (that would ask ` +
		"this server's DNS for the hidden names). Whether they answer, on this server: sudo morphit-ops health";
	if (skipRpc || rpcPlan === null) {
		console.log(`  RPC endpoints ${c.dim('(skipped — --no-rpc)')}`);
	} else if (rpcPlan.unknown) {
		// Unknown is not "the defaults": a hidden-only node read as clearnet
		// would have been probed over clearnet (review, 2026-10-29).
		console.log(
			`  RPC endpoints ${c.yellow('(not checked — the services’ settings could not be read)')}`
		);
		console.log(
			`    ${c.dim('Nothing was contacted. The config check above says what is wrong with them.')}`
		);
	} else if (rpcPlan.hiddenOnly) {
		console.log(`  RPC endpoints ${c.dim('(hidden-only node — not probed from here)')}`);
		console.log(
			`    ${c.dim(
				`This node reads the chain only through hidden (Tor/I2P) RPC nodes. ${hiddenNote(rpcPlan.hidden.length)}`
			)}`
		);
	} else if (rpc === null) {
		console.log(`  RPC endpoints ${c.yellow('(no clearnet endpoint to probe)')}`);
		if (rpcPlan.hidden.length > 0) console.log(`    ${c.dim(hiddenNote(rpcPlan.hidden.length))}`);
	} else {
		const verdictColor = rpc.healthy === 0 ? c.red : rpc.healthy < rpc.total ? c.yellow : c.green;
		console.log(`  RPC endpoints ${verdictColor(`(${rpc.healthy} of ${rpc.total} reachable)`)}`);
		const lines = formatRpcProbeLines(rpc);
		// Last line is the verdict; the rest are per-endpoint.
		for (const line of lines.slice(0, -1)) {
			// A reachable endpoint starts "OK"; anything else is down-now (amber, not
			// red — a blip is normal and the pool routes around it) (review D12).
			const tagged = line.trimStart().startsWith('OK') ? c.green(line) : c.yellow(line);
			console.log(`  ${tagged}`);
		}
		console.log(`    ${verdictColor(lines[lines.length - 1]!)}`);
		if (rpcPlan.hidden.length > 0) console.log(`    ${c.dim(hiddenNote(rpcPlan.hidden.length))}`);
	}
	console.log('');
	console.log('━'.repeat(60));
	console.log('');

	// ─── Database schema (advisory) ─────────────────────────────
	if (skipDb || schema === null) {
		console.log(`  Database schema ${c.dim('(skipped — --no-db)')}`);
	} else if (schema.kind === 'matches') {
		console.log(`  Database schema ${c.green('(matches this version)')}`);
	} else if (schema.kind === 'unreachable') {
		console.log(`  Database schema ${c.yellow('(could not check — database not reachable)')}`);
	} else if (schema.kind === 'drift') {
		console.log(`  Database schema ${c.yellow('(drift detected)')}`);
		for (const l of schema.lines) console.log(`    ${c.yellow('⚠')} ${l}`);
	} else {
		// The check did not run to a verdict: nothing is known about the schema.
		console.log(
			`  Database schema ${c.yellow('(the check could not run — nothing is known yet)')}`
		);
		for (const l of schema.lines) console.log(`      ${l}`);
		if (!results.find((r) => r.name === 'indexer')?.ok) {
			console.log(
				`    ${c.dim("It needs the indexer's settings to load; fix those first (above).")}`
			);
		}
	}
	console.log('');
	console.log('━'.repeat(60));
	console.log('');

	if (allOk) {
		console.log(`  ${c.green('Looks good.')} Both services will start with these settings.`);
		console.log('');
		if (systemd) {
			console.log('  If you changed a setting, restart them so they use it. On this server:');
			console.log('');
			console.log('    sudo systemctl restart morphit-indexer morphit-relay');
			console.log('');
			console.log('  To see how they started, on this server:');
			console.log('');
			console.log('    sudo journalctl -u morphit-indexer -n 50');
			console.log('    sudo journalctl -u morphit-relay -n 50');
		} else {
			console.log('  To start them, on this server, each in its own terminal:');
			console.log('');
			console.log(`    cd ${join(installDir, 'apps', 'indexer')} && npm start`);
			console.log(`    cd ${join(installDir, 'apps', 'relay')} && npm start`);
		}
		console.log('');
		console.log('  (A fresh indexer reports "degraded" until it finishes');
		console.log('  catching up to the chain — that is normal.)');
	} else {
		const ansibleLayout = (svc: 'indexer' | 'relay'): string | null => {
			const f = `${root}/etc/morphit/${svc}.env`;
			return existsSync(f) ? f : null;
		};
		console.log(`  ${c.red('Not ready yet.')} What to do:`);
		console.log('');
		for (const line of fixesForFailures(results, {
			envFileFor: (svc) => ansibleLayout(svc) ?? envPath,
			configEnvPath,
			systemd,
			installDir,
			root
		}))
			console.log(`    ${line}`);
		console.log('');
		console.log('  Then run this check again: sudo morphit-ops doctor');
	}
	console.log('');
	return allOk ? 0 : 1;
}

export interface SecurityFinding {
	readonly level: 'ok' | 'warn';
	readonly label: string;
	/** Plain-English detail / remediation. */
	readonly detail: string;
}

/** What each name is set to inside a service that sources `files` (the
 *  unit's list), or undefined when no file sets it. Never throws: a file bash
 *  cannot source reads as "not set". */
function readServiceEnv(
	files: readonly string[],
	names: readonly string[]
): ReadonlyMap<string, string | undefined> {
	try {
		return readEffectiveEnv(files, names);
	} catch {
		return new Map();
	}
}

/** A comma-separated list setting, with the service's built-in default when
 *  it is unset (unset and empty are different: empty means "none"). */
function listSetting(v: string | undefined, dflt: readonly string[]): string[] {
	if (v === undefined) return [...dflt];
	return v
		.split(',')
		.map((u) => u.trim())
		.filter((u) => u !== '');
}

/** The RPC nodes the indexer and relay will use, as their units see them. */
export interface RpcPlan {
	/** Their settings could not be read: nothing is known, and nothing may be
	 *  contacted (the lists below are empty). */
	readonly unknown: boolean;
	/** The indexer's clearnet list is empty: it reads the chain only through
	 *  hidden nodes, and nothing here may open a clearnet connection for it. */
	readonly hiddenOnly: boolean;
	/** Clearnet endpoints (deduplicated) a host-side probe may contact. */
	readonly clearnet: readonly string[];
	/** Hidden (.onion / .i2p) endpoints — never contacted from here. */
	readonly hidden: readonly string[];
}

/** Gather both services' endpoint lists from the files their units source,
 *  including the hidden lists and the built-in defaults. PURE apart from
 *  reading those files. */
export function configuredEndpoints(
	indexerFiles: readonly string[],
	relayFiles: readonly string[]
): RpcPlan {
	// Not readServiceEnv: an error there reads as "nothing set", every list then
	// falls back to the clearnet defaults, and a hidden-only node was probed
	// over clearnet (review, 2026-10-29). Unknown stays unknown.
	let idx: ReadonlyMap<string, string | undefined>;
	let rel: ReadonlyMap<string, string | undefined>;
	try {
		idx = readEffectiveEnv(indexerFiles, [
			'MORPHIT_INDEXER_RPC_ENDPOINTS',
			'MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS'
		]);
		rel = readEffectiveEnv(relayFiles, [
			'MORPHIT_RELAY_BLURT_RPC',
			'MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS'
		]);
	} catch {
		return { unknown: true, hiddenOnly: false, clearnet: [], hidden: [] };
	}
	const idxClear = listSetting(
		idx.get('MORPHIT_INDEXER_RPC_ENDPOINTS'),
		DEFAULT_BLURT_RPC_ENDPOINTS
	);
	const all = [
		...idxClear,
		...listSetting(
			idx.get('MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS'),
			DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS
		),
		...listSetting(rel.get('MORPHIT_RELAY_BLURT_RPC'), DEFAULT_BLURT_RPC_ENDPOINTS),
		...listSetting(
			rel.get('MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS'),
			DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS
		)
	];
	const unique = Array.from(new Set(all));
	return {
		unknown: false,
		hiddenOnly: idxClear.filter((u) => !isHiddenHostOrigin(u)).length === 0,
		clearnet: unique.filter((u) => !isHiddenHostOrigin(u)),
		hidden: unique.filter((u) => isHiddenHostOrigin(u))
	};
}

/**
 * Can a peer instance actually hand us a BATCH of chat messages?
 *
 * WHY THIS IS A CHECK AND NOT A LINE IN A DOCUMENT
 *
 * The fast chat path groups messages when a peer is already busy, because one
 * connection over Tor or I2P completes one round trip at a time and grouping is
 * the only thing that makes a federation affordable. A full group is a couple of
 * hundred kilobytes, and every other endpoint on this service takes a few
 * kilobytes — so a reverse proxy configured for the rest of the API rejects the
 * group before the indexer ever sees it.
 *
 * That failure is invisible in every way that matters. Nothing errors. Single
 * messages keep working, so chat looks fine. It only bites when an instance is
 * BUSY, which is when nobody is reading logs — and the symptom is "chat got slow
 * again", which points at the network rather than at a proxy setting. An
 * operator upgrading from an older release keeps their existing proxy config by
 * definition, so this is the default state of every upgrade rather than an
 * unlucky one.
 *
 * So it is worth actually trying it.
 *
 * THROUGH THE PUBLIC ORIGIN, NEVER LOOPBACK. Testing 127.0.0.1:8081 would skip
 * the proxy entirely and pass on a box that is misconfigured — a check that
 * cannot fail, which is worse than no check. If the public origin cannot be
 * determined or cannot be reached from here, this reports exactly that and
 * prints the command to run by hand, rather than guessing.
 *
 * WHAT IT SENDS: a JSON body of the right shape and the wrong contents, sized
 * above the small read default and far below the federation cap. The indexer
 * refuses it structurally — nothing is delivered, nothing is stored, no
 * signature is checked — so the only thing under test is whether the bytes
 * arrived. A 413 means they did not.
 */
/**
 * POST a batch-shaped body to one origin's federation endpoint.
 *
 * One definition, used for both the public origin and the hidden-service front
 * end, so the two checks cannot drift into asking subtly different questions of
 * subtly different things — which is how a check ends up reporting on a path
 * nobody runs.
 */
/** Does this origin name a hidden service — `.onion`, `.i2p`, `.loki`? Such a
 *  name must never reach the system resolver. */
export function isHiddenHostOrigin(origin: string): boolean {
	let host: string;
	try {
		host = new URL(origin).hostname.toLowerCase();
	} catch {
		return /\.(onion|i2p|loki)(:\d+)?(\/|$)/i.test(origin);
	}
	return host.endsWith('.onion') || host.endsWith('.i2p') || host.endsWith('.loki');
}

async function probeFederationBody(
	origin: string,
	body: string
): Promise<{ status: number; error: string }> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 20_000);
	try {
		const res = await fetch(`${origin}/v1/federation/chat-fast`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			signal: ctrl.signal
		});
		return { status: res.status, error: '' };
	} catch (e) {
		return { status: 0, error: e instanceof Error ? e.message : String(e) };
	} finally {
		clearTimeout(timer);
	}
}

export async function checkFederationBodyCap(
	/** The files the indexer's unit sources (or one env file, plus
	 *  `configEnvPath`), read the way the unit reads them. */
	files: string | readonly string[],
	configEnvPath: string | null = null
): Promise<SecurityFinding> {
	const label = 'federation batch size';
	const list: readonly string[] =
		typeof files === 'string' ? [files, ...(configEnvPath !== null ? [configEnvPath] : [])] : files;
	const env = readServiceEnv(list, [
		'MORPHIT_INSTANCE_ORIGIN',
		'MORPHIT_INDEXER_PUBLIC_ORIGIN',
		'MORPHIT_ONION_FRONTEND_PORT'
	]);

	// The SITE origin, which is what a peer pushes to. Same derivation the
	// indexer itself uses for recognising its own directory row.
	const instanceOrigin = env.get('MORPHIT_INSTANCE_ORIGIN') ?? '';
	const publicOrigin = env.get('MORPHIT_INDEXER_PUBLIC_ORIGIN') ?? '';
	const origin = (instanceOrigin || publicOrigin.replace(/\/\/indexer\./, '//')).replace(
		/\/+$/,
		''
	);

	const manual =
		'Send a large body to /v1/federation/chat-fast through your PUBLIC origin (not ' +
		'127.0.0.1 — that skips the proxy) and check you do not get 413. Anything but 413 ' +
		'means the bytes arrived, which is all this is testing.';

	/**
	 * The port Tor and i2pd forward a hidden-service request to.
	 *
	 * This is NOT loopback-as-a-shortcut. The warning above — that 127.0.0.1
	 * skips the proxy and reports all-clear on exactly the box that has the
	 * problem — is about bypassing the front end. Here the front end IS what
	 * answers on this port: `HiddenServicePort 80 127.0.0.1:8090` and i2pd's
	 * tunnel both point at it, so a request to it traverses the same server
	 * block, the same location matching and the same `client_max_body_size` a
	 * real peer's push does. It is the only honest way to check the path a
	 * privacy-only instance actually uses.
	 */
	const hiddenFrontendPort = env.get('MORPHIT_ONION_FRONTEND_PORT') || '8090';

	if (origin === '') {
		return {
			level: 'warn',
			label,
			detail:
				'Could not determine this instance’s public origin, so the batch size was not ' +
				`verified. ${manual}`
		};
	}

	// ~8 KB: above the 4 KB default that every other read endpoint uses, far
	// below the 256 KB the federation endpoint should allow. Large enough to be
	// refused by a proxy that was not updated, small enough to be harmless.
	const filler = '0'.repeat(8_000);
	const body = JSON.stringify({ trxs: [{ not: 'a transaction', filler }] });

	// A HIDDEN origin is never fetched directly (v1.18.0 review, O1). A plain
	// fetch of `http://<onion>` asks the SYSTEM resolver for the onion name —
	// on a tor-only home server that is its ISP's resolver, tying the home
	// address to the onion, the one link tor-only mode exists to hide. There is
	// nothing to learn from that attempt anyway: it can only fail. Such an
	// instance is checked where Tor and i2pd actually deliver, below.
	const first = isHiddenHostOrigin(origin)
		? { status: 0, error: 'a hidden-service origin, checked through the local front end instead' }
		: await probeFederationBody(origin, body);
	const status = first.status;
	const transportError = first.error;

	if (transportError !== '') {
		// A privacy-only instance cannot resolve its own address from the host,
		// which is normal and used to end the check here — leaving the operators
		// who depend on federated chat MOST with the one configuration nobody
		// verified. Tor and i2pd hand their traffic to a local front end, so
		// that front end can be asked directly.
		const hidden = await probeFederationBody(`http://127.0.0.1:${hiddenFrontendPort}`, body);
		if (hidden.status === 413) {
			return {
				level: 'warn',
				label,
				detail:
					`Your hidden-service front end (127.0.0.1:${hiddenFrontendPort}, where Tor and ` +
					'i2pd deliver) answered 413 to an 8 KB batch, so it is rejecting federated chat ' +
					'batches before the indexer sees them. Chat still works — it falls back to the ' +
					'blockchain — but it gets SLOW under load, which is exactly when you will not ' +
					'notice. Add a /v1/federation location with `client_max_body_size 256k;` ' +
					'(ops/bunkerweb/frontend/nginx.conf ships it), reload the proxy, and re-run.'
			};
		}
		if (hidden.status > 0) {
			return {
				level: 'ok',
				label,
				detail:
					`${origin} is not resolvable from this host, which is normal for a privacy-only ` +
					`instance. Checked the hidden-service front end instead (127.0.0.1:` +
					`${hiddenFrontendPort}, where Tor and i2pd deliver): it accepted an 8 KB batch ` +
					`(answered ${hidden.status}), so federated chat can group messages over your ` +
					'onion and I2P addresses.'
			};
		}
		return {
			level: 'warn',
			label,
			detail:
				`Could not reach ${origin} from this machine (${transportError}), and nothing ` +
				`answered on the hidden-service front end either (127.0.0.1:${hiddenFrontendPort}` +
				`${hidden.error === '' ? '' : `, ${hidden.error}`}), so the batch size was not ` +
				`verified. If your front end listens elsewhere, set MORPHIT_ONION_FRONTEND_PORT. ` +
				`${manual}`
		};
	}

	if (status === 413) {
		return {
			level: 'warn',
			label,
			detail:
				`${origin} answered 413 to an 8 KB batch, so your reverse proxy is rejecting ` +
				'federated chat batches before the indexer sees them. Chat still works — it ' +
				'falls back to the blockchain — but it gets SLOW under load, which is exactly ' +
				'when you will not notice. Add a /v1/federation location with ' +
				'`client_max_body_size 256k;` (ops/nginx/web.conf and indexer.conf ship it), ' +
				'reload the proxy, and re-run this check.'
		};
	}

	if (status === 0) {
		return { level: 'warn', label, detail: `No response from ${origin}. ${manual}` };
	}

	// 400 is the expected answer: the body arrived and was refused on its
	// contents, which is the whole point — the bytes got through.
	return {
		level: 'ok',
		label,
		detail: `${origin} accepted an 8 KB batch (answered ${status}), so federated chat can group messages.`
	};
}

/** Read-only security audit. Inspects the active-key file (encryption
 *  + permissions) and the secret config files' permissions. Reads at
 *  most the first byte of the key file (to detect an envelope) and
 *  NEVER prints key material. Findings are advisory — they do not
 *  change doctor's boot-readiness exit code. */
/** The relay service's group (ops/systemd/morphit-relay.service). */
export const RELAY_GROUP = 'morphit-relay';

/** gid of a group from /etc/group, or null. */
function groupIdOf(name: string, groupFile = '/etc/group'): number | null {
	try {
		const line = readFileSync(groupFile, 'utf8')
			.split('\n')
			.find((l) => l.startsWith(`${name}:`));
		const gid = Number(line?.split(':')[2]);
		return line !== undefined && Number.isInteger(gid) ? gid : null;
	} catch {
		return null;
	}
}

/**
 * The relay keystore's permissions, judged by the rule the relay itself
 * applies at boot (apps/relay/src/config/keystorePerms.ts): owner-only
 * (0400/0600), or root:<the relay's group> 0440/0640 — what the installer and
 * the relay's pre-start helper set so the unprivileged relay reads it through
 * its group. Anything looser is a warning naming the fix. PURE.
 */
export function keyFilePermissionFinding(
	st: { readonly mode: number; readonly uid: number; readonly gid: number },
	relayGid: number | null,
	keyPath: string
): SecurityFinding {
	const mode = st.mode & 0o777;
	const shown = `0${mode.toString(8).padStart(3, '0')}`;
	const fix =
		relayGid !== null
			? `sudo chown root:${RELAY_GROUP} ${keyPath} && sudo chmod 0640 ${keyPath}`
			: `sudo chmod 0600 ${keyPath}`;
	const warn = (why: string): SecurityFinding => ({
		level: 'warn',
		label: 'active key permissions',
		detail: `key file is ${shown}: ${why}. Fix, on this server: ${fix}`
	});
	if ((mode & 0o077) === 0) {
		return {
			level: 'ok',
			label: 'active key permissions',
			detail: `key file is ${shown}, readable by its owner only (good).`
		};
	}
	if ((mode & 0o007) !== 0) return warn('other users can access it');
	if ((mode & 0o030) !== 0) return warn('its group may write or execute it');
	if (st.uid !== 0) return warn(`it is group-readable but owned by uid ${st.uid}, not root`);
	if (relayGid === null || st.gid !== relayGid) {
		return warn(`its group (gid ${st.gid}) is not the relay's group (${RELAY_GROUP})`);
	}
	return {
		level: 'ok',
		label: 'active key permissions',
		detail: `key file is ${shown}, root:${RELAY_GROUP} — only root and the relay's group can read it (good).`
	};
}

/** The services' shared group (ops/systemd/morphit-*.service
 *  SupplementaryGroups=morphit); ops/scripts/morphit-service-perms.sh gives the
 *  env files it at every start. */
export const SERVICE_GROUP = 'morphit';

/** The group an env file is read through (ops/scripts/morphit-service-perms.sh,
 *  and the Ansible role's owner for it): relay-notify.env — the offline-notice
 *  accounts' passwords — the relay's alone; every other one the services'
 *  shared group. */
export function envFileGroup(path: string, root = ''): string {
	return path === `${root}/etc/morphit/relay-notify.env` ? RELAY_GROUP : SERVICE_GROUP;
}

/**
 * An env file's permissions, judged against what the services need: root's,
 * owner-only (0600/0400), or root:<its group> 0640/0440 — exactly what
 * ops/scripts/morphit-service-perms.sh sets before every start so the
 * unprivileged services can read it through their group (the group is
 * `morphit`, and `morphit-relay` for relay-notify.env). That shape used to be
 * reported as a leak ("group/other can read it"). Anything looser is a warning
 * that says who can read it and the exact fix. Owned by any other account, it
 * is a warning even at 0600: that account can change what the services (and
 * root, which sources these files) run with (review, 2026-10-29). PURE.
 */
export function envFilePermissionFinding(
	name: string,
	path: string,
	st: { readonly mode: number; readonly uid: number; readonly gid: number },
	group: { readonly name: string; readonly gid: number | null }
): SecurityFinding {
	const label = `${name} permissions`;
	const mode = st.mode & 0o777;
	const shown = `0${mode.toString(8).padStart(3, '0')}`;
	const fix =
		group.gid !== null
			? `sudo chown root:${group.name} ${path} && sudo chmod 0640 ${path}`
			: `sudo chown root ${path} && sudo chmod 0600 ${path}`;
	const warn = (why: string): SecurityFinding => ({
		level: 'warn',
		label,
		detail: `${name} is ${shown}: ${why}; it holds secrets. Fix, on this server: ${fix}`
	});
	if ((mode & 0o007) !== 0) return warn('every user on this server can read it');
	if ((mode & 0o030) !== 0) return warn('its group may change it');
	if (st.uid !== 0)
		return warn(
			`it is owned by uid ${st.uid}, not root, so that account can change what the services run with`
		);
	if ((mode & 0o077) === 0) {
		return { level: 'ok', label, detail: `${shown}, root's, readable by root only (good).` };
	}
	if (group.gid === null || st.gid !== group.gid) {
		return warn(
			`its group (gid ${st.gid}) can read it, and that is not the group it is meant for (${group.name})`
		);
	}
	return {
		level: 'ok',
		label,
		detail: `${shown}, root:${group.name} — only root and the Morphit services can read it (good; set before every start).`
	};
}

async function securityAudit(
	relayFiles: readonly string[],
	indexerFiles: readonly string[],
	root: string
): Promise<SecurityFinding[]> {
	const { statSync, openSync, readSync, closeSync } = await import('node:fs');
	const findings: SecurityFinding[] = [];
	const onWin = process.platform === 'win32';
	const groupFile = `${root}/etc/group`;

	// ── Active key: encrypted vs plaintext ─────────────────────
	// The path the relay reads: the last of its unit's files that sets it.
	const keyPath = readServiceEnv(relayFiles, ['MORPHIT_RELAY_ACTIVE_KEY_FILE']).get(
		'MORPHIT_RELAY_ACTIVE_KEY_FILE'
	);
	if (keyPath === undefined || keyPath === '') {
		findings.push({
			level: 'warn',
			label: 'active key',
			detail:
				'MORPHIT_RELAY_ACTIVE_KEY_FILE is not set in any file the relay reads ' +
				`(${relayFiles.join(', ')}), so the key could not be inspected.`
		});
	} else if (!existsSync(keyPath)) {
		findings.push({
			level: 'warn',
			label: 'active key',
			detail: `key file ${keyPath} does not exist (the relay will not start without it).`
		});
	} else {
		// Detect envelope (encrypted) the way the relay does: first
		// non-whitespace char is '{'. Read just a small head; never log it.
		let head = '';
		try {
			const fd = openSync(keyPath, 'r');
			const buf = Buffer.alloc(64);
			const n = readSync(fd, buf, 0, 64, 0);
			closeSync(fd);
			head = buf.subarray(0, n).toString('utf8').trimStart();
		} catch {
			/* unreadable — fall through to a generic note below */
		}
		if (head.startsWith('{')) {
			findings.push({
				level: 'ok',
				label: 'active key encryption',
				detail: 'the relay active key is an encrypted envelope (good).'
			});
		} else if (head !== '') {
			findings.push({
				level: 'warn',
				label: 'active key encryption',
				detail:
					'the relay active key is stored in PLAINTEXT. Anyone who can read the file has your relay key. ' +
					'Encrypt it with `morphit-ops edit-active-key` (you will set a passphrase). ' +
					"The relay then unlocks it at every start from the passphrase sealed with this host's systemd " +
					'credential key (/etc/morphit/relay_passphrase.cred, --with-key=host; no TPM): it protects a copied ' +
					'key file, not a full image of this disk — use disk encryption (LUKS) for that.'
			});
		}
		// Key-file permissions: the same shapes the relay accepts at boot
		// (apps/relay/src/config/keystorePerms.ts).
		if (!onWin) {
			try {
				const st = statSync(keyPath);
				findings.push(keyFilePermissionFinding(st, groupIdOf(RELAY_GROUP, groupFile), keyPath));
			} catch {
				/* ignore */
			}
		}
	}

	// ── Secret config files: permissions ───────────────────────
	// Every file the two units source (review, 2026-10-29: only morphit.env and
	// morphit.config.env were looked at, while the Ansible layout keeps the
	// database password in /etc/morphit/indexer.env and relay.env, and the
	// offline-notice accounts in relay-notify.env).
	if (!onWin) {
		for (const p of [...new Set([...indexerFiles, ...relayFiles])]) {
			if (!existsSync(p)) continue;
			const groupName = envFileGroup(p, root);
			try {
				findings.push(
					envFilePermissionFinding(p.slice(p.lastIndexOf('/') + 1), p, statSync(p), {
						name: groupName,
						gid: groupIdOf(groupName, groupFile)
					})
				);
			} catch {
				/* ignore */
			}
		}
	}

	return findings;
}

/** Minimal ANSI helper, matching the rest of the CLI's color gating. */
function makeColor(enabled: boolean) {
	const wrap = (code: string) => (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s);
	return {
		green: wrap('32'),
		red: wrap('31'),
		yellow: wrap('33'),
		dim: wrap('2')
	};
}
